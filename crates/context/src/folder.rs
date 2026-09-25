//! Folder analysis: what sharing a folder would actually send.
//!
//! A folder is never inlined wholesale. The walk honours `.gitignore`, `.ignore`,
//! `.kalcodeignore`, `.git/info/exclude` and the global Git excludes file; skips `.git/` and
//! never-share directories without descending into them; never follows links or junctions;
//! and stops after [`FolderBudget::max_entries_scanned`] entries. Candidates are ranked by a
//! [`RelevanceScorer`] and admitted greedily within the file-count and byte budgets. Binary
//! detection uses the extension first and then the first 8 KiB of admitted candidates only, so
//! the cost is bounded by the budget, not by the size of the tree.
//!
//! The result is a [`FolderPreview`]: the exact list of files that would be shared, and why
//! everything else was left out. The user can prune it before the files become package items;
//! each file is then evaluated by the firewall on its own (content scanning happens there).

use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use ignore::WalkBuilder;
use serde::{Deserialize, Serialize};

use crate::content::{ContentClass, SNIFF_BYTES, is_known_binary_extension, sniff};
use crate::error::{ContextError, Result};
use crate::firewall::Firewall;
use crate::model::{FirewallRule, IgnoreSource, RuleEffect, Sensitivity};
use crate::never_share::{GlobList, NeverShareHit, NeverShareRules};
use crate::paths::{PathCheck, check_relative_text};

/// Budgets for one folder analysis.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderBudget {
    pub max_files: usize,
    pub max_total_bytes: u64,
    pub max_file_bytes: u64,
    pub max_depth: usize,
    pub max_entries_scanned: usize,
    /// Excluded entries listed individually; the rest are counted by reason.
    pub max_listed_exclusions: usize,
}

impl Default for FolderBudget {
    fn default() -> Self {
        Self {
            max_files: 200,
            max_total_bytes: 2 * 1024 * 1024,
            max_file_bytes: 256 * 1024,
            max_depth: 32,
            max_entries_scanned: 50_000,
            max_listed_exclusions: 500,
        }
    }
}

/// Facts a scorer may use. Content is not read before ranking.
#[derive(Debug, Clone, Copy)]
pub struct FileFacts<'a> {
    pub relative: &'a str,
    pub bytes: u64,
    pub depth: usize,
}

/// Relevance ordering hook: higher scores are admitted first. Implementations must be cheap and
/// must not read file contents (they run for every candidate in the tree).
pub trait RelevanceScorer: Send + Sync {
    fn score(&self, file: &FileFacts<'_>) -> i64;
}

/// Default ordering: project descriptions and manifests first, then source, then docs and
/// config, then tests; lockfiles, generated and minified files last; shallower and smaller
/// files first within a class.
#[derive(Debug, Clone, Copy, Default)]
pub struct DefaultRelevance;

impl RelevanceScorer for DefaultRelevance {
    fn score(&self, file: &FileFacts<'_>) -> i64 {
        let lower = file.relative.to_ascii_lowercase();
        let name = lower.rsplit('/').next().unwrap_or(&lower);
        let ext = name.rsplit_once('.').map(|(_, e)| e).unwrap_or("");
        let mut score: i64 = match ext {
            "rs" | "ts" | "tsx" | "js" | "jsx" | "py" | "go" | "java" | "kt" | "cs" | "rb"
            | "php" | "swift" | "c" | "h" | "cpp" | "hpp" | "vue" | "svelte" | "astro" | "sql"
            | "sh" | "ps1" => 600,
            "md" | "txt" | "rst" | "adoc" => 450,
            "toml" | "yaml" | "yml" | "json" | "xml" | "ini" | "cfg" | "css" | "scss" | "html" => {
                400
            }
            _ => 300,
        };
        if name.starts_with("readme") {
            score = 1000;
        }
        if matches!(
            name,
            "cargo.toml"
                | "package.json"
                | "pyproject.toml"
                | "go.mod"
                | "pom.xml"
                | "build.gradle"
                | "build.gradle.kts"
                | "tsconfig.json"
                | "makefile"
                | "dockerfile"
        ) {
            score = 900;
        }
        if lower.contains("/test")
            || lower.starts_with("test")
            || name.contains(".test.")
            || name.contains("_test.")
            || name.contains(".spec.")
        {
            score -= 150;
        }
        if crate::secrets::is_hash_manifest(name)
            || name.ends_with(".min.js")
            || name.ends_with(".min.css")
            || name.ends_with(".map")
            || lower.contains("/generated/")
            || lower.contains("/vendor/")
        {
            score = 10;
        }
        score -= (file.depth as i64) * 20;
        score -= (file.bytes / 16_384) as i64;
        score
    }
}

/// Why an entry was left out.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ExclusionReason {
    NeverShare {
        source: IgnoreSource,
        rule: String,
        sensitivity: Sensitivity,
    },
    UserExcluded {
        pattern: String,
    },
    OutsideMissionScope,
    Binary,
    TooLarge {
        bytes: u64,
        max_bytes: u64,
    },
    OverFileBudget,
    OverByteBudget,
    /// Links and junctions are never followed.
    Link,
    Unreadable,
    UnsafeName,
    UserPruned,
}

impl ExclusionReason {
    pub fn code(&self) -> &'static str {
        match self {
            Self::NeverShare { .. } => "never_share",
            Self::UserExcluded { .. } => "user_excluded",
            Self::OutsideMissionScope => "outside_mission_scope",
            Self::Binary => "binary",
            Self::TooLarge { .. } => "too_large",
            Self::OverFileBudget => "over_file_budget",
            Self::OverByteBudget => "over_byte_budget",
            Self::Link => "link",
            Self::Unreadable => "unreadable",
            Self::UnsafeName => "unsafe_name",
            Self::UserPruned => "user_pruned",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderEntry {
    /// Canonical workspace-relative path.
    pub relative: String,
    pub bytes: u64,
    pub score: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExcludedEntry {
    pub relative: String,
    pub is_dir: bool,
    pub reason: ExclusionReason,
}

/// The exact list of files a folder share would include, and what was left out.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderPreview {
    /// Workspace-relative folder (`""` = the workspace root).
    pub folder: String,
    pub included: Vec<FolderEntry>,
    pub total_bytes: u64,
    /// Up to `max_listed_exclusions` entries, in walk order.
    pub excluded: Vec<ExcludedEntry>,
    /// Every exclusion, counted by reason code.
    pub excluded_counts: BTreeMap<String, u64>,
    pub entries_scanned: u64,
    /// The walk stopped at `max_entries_scanned`; the preview covers the part that was seen.
    pub walk_truncated: bool,
    pub budget: FolderBudget,
    /// Wall time of the analysis, for diagnostics and performance budgets.
    pub elapsed_ms: u64,
}

impl FolderPreview {
    /// Removes one included file (the user pruned it). Returns false if it was not included.
    pub fn prune(&mut self, relative: &str) -> bool {
        let Some(index) = self.included.iter().position(|e| e.relative == relative) else {
            return false;
        };
        let entry = self.included.remove(index);
        self.total_bytes -= entry.bytes;
        self.record(ExcludedEntry {
            relative: entry.relative,
            is_dir: false,
            reason: ExclusionReason::UserPruned,
        });
        true
    }

    /// Removes every included file under `pattern` (gitignore-like glob, or a folder path).
    pub fn prune_matching(&mut self, pattern: &str) -> Result<usize> {
        let globs = GlobList::new(&[pattern])?;
        let doomed: Vec<String> = self
            .included
            .iter()
            .filter(|e| globs.first_match(&e.relative).is_some())
            .map(|e| e.relative.clone())
            .collect();
        for relative in &doomed {
            self.prune(relative);
        }
        Ok(doomed.len())
    }

    pub fn included_paths(&self) -> impl Iterator<Item = &str> {
        self.included.iter().map(|e| e.relative.as_str())
    }

    /// A plain-text listing for the provider (the folder item's summary).
    pub fn listing(&self) -> String {
        let mut out = format!(
            "Folder {} — {} file(s), {} bytes shared",
            if self.folder.is_empty() {
                "."
            } else {
                &self.folder
            },
            self.included.len(),
            self.total_bytes
        );
        let left_out: u64 = self.excluded_counts.values().sum();
        if left_out > 0 {
            out.push_str(&format!("; {left_out} entr(ies) left out"));
        }
        out.push('\n');
        for entry in &self.included {
            out.push_str(&format!("  {} ({} bytes)\n", entry.relative, entry.bytes));
        }
        out
    }

    fn record(&mut self, entry: ExcludedEntry) {
        *self
            .excluded_counts
            .entry(entry.reason.code().to_owned())
            .or_insert(0) += 1;
        if self.excluded.len() < self.budget.max_listed_exclusions {
            self.excluded.push(entry);
        }
    }
}

struct Candidate {
    relative: String,
    absolute: PathBuf,
    bytes: u64,
    score: i64,
}

/// Directory pruning state shared with the walker's filter.
struct DirFilter {
    walk_root: PathBuf,
    folder_rel: String,
    never_share: NeverShareRules,
    exclusions: GlobList,
    pruned: Mutex<Vec<ExcludedEntry>>,
}

impl DirFilter {
    fn relative(&self, path: &Path) -> Option<String> {
        let sub = path.strip_prefix(&self.walk_root).ok()?;
        let sub = sub
            .components()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join("/");
        Some(join_rel(&self.folder_rel, &sub))
    }

    /// Returns false (do not descend) for `.git` and never-share or excluded directories.
    fn keep_dir(&self, path: &Path) -> bool {
        let Some(relative) = self.relative(path) else {
            return true;
        };
        let reason = self
            .never_share
            .check(&relative)
            .into_iter()
            .max_by_key(NeverShareHit::sensitivity)
            .map(|hit| match hit {
                NeverShareHit::Builtin(b) => ExclusionReason::NeverShare {
                    source: IgnoreSource::BuiltinSensitive,
                    rule: b.rule.to_owned(),
                    sensitivity: b.sensitivity,
                },
                NeverShareHit::Pattern(p) => ExclusionReason::NeverShare {
                    source: IgnoreSource::WorkspaceNeverShare,
                    rule: p.pattern,
                    sensitivity: p.sensitivity,
                },
            })
            .or_else(|| {
                self.exclusions.first_match(&relative).map(|pattern| {
                    ExclusionReason::UserExcluded {
                        pattern: pattern.to_owned(),
                    }
                })
            });
        match reason {
            Some(reason) => {
                if let Ok(mut pruned) = self.pruned.lock() {
                    pruned.push(ExcludedEntry {
                        relative,
                        is_dir: true,
                        reason,
                    });
                }
                false
            }
            None => true,
        }
    }
}

fn join_rel(folder: &str, sub: &str) -> String {
    match (folder.is_empty(), sub.is_empty()) {
        (true, _) => sub.to_owned(),
        (false, true) => folder.to_owned(),
        (false, false) => format!("{folder}/{sub}"),
    }
}

/// Analyses `folder` (workspace-relative or absolute) under `firewall`'s workspace.
pub fn analyze_folder(
    firewall: &Firewall,
    folder: &str,
    budget: &FolderBudget,
    scorer: &dyn RelevanceScorer,
) -> Result<FolderPreview> {
    let started = Instant::now();
    let (check, reasons) = firewall.check_path(folder, true);
    let (real, folder_rel) = match check {
        PathCheck::Inside { real, relative } => (real, relative),
        PathCheck::Outside { reason } | PathCheck::Unsafe { reason } => {
            return Err(ContextError::PathRejected {
                reason: reason.to_owned(),
            });
        }
    };
    if let Some(block) = reasons
        .iter()
        .find(|r| r.effect >= RuleEffect::BlockOverridable)
    {
        return Err(ContextError::PathRejected {
            reason: block.message.clone(),
        });
    }
    if !real.is_dir() {
        return Err(ContextError::NotFound);
    }

    let policy = firewall.policy();
    let filter = Arc::new(DirFilter {
        walk_root: real.clone(),
        folder_rel: folder_rel.clone(),
        never_share: policy.never_share.clone(),
        exclusions: policy.exclusions.clone(),
        pruned: Mutex::new(Vec::new()),
    });
    let walk_filter = Arc::clone(&filter);
    let mut builder = WalkBuilder::new(&real);
    builder
        .hidden(false)
        .parents(true)
        .ignore(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .require_git(false)
        .follow_links(false)
        .max_depth(Some(budget.max_depth))
        .add_custom_ignore_filename(".kalcodeignore")
        .filter_entry(move |entry| {
            let is_dir = entry.file_type().is_some_and(|t| t.is_dir());
            if !is_dir || entry.depth() == 0 {
                return true;
            }
            walk_filter.keep_dir(entry.path())
        });

    let mut preview = FolderPreview {
        folder: folder_rel.clone(),
        included: Vec::new(),
        total_bytes: 0,
        excluded: Vec::new(),
        excluded_counts: BTreeMap::new(),
        entries_scanned: 0,
        walk_truncated: false,
        budget: *budget,
        elapsed_ms: 0,
    };
    let mut candidates: Vec<Candidate> = Vec::new();

    for result in builder.build() {
        let Ok(entry) = result else {
            continue;
        };
        if entry.depth() == 0 {
            continue;
        }
        preview.entries_scanned += 1;
        if preview.entries_scanned as usize > budget.max_entries_scanned {
            preview.walk_truncated = true;
            break;
        }
        let Some(file_type) = entry.file_type() else {
            continue;
        };
        let Some(relative) = filter.relative(entry.path()) else {
            continue;
        };
        if file_type.is_dir() {
            continue;
        }
        if file_type.is_symlink() {
            preview.record(excluded(relative, ExclusionReason::Link));
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        if check_relative_text(&relative).is_err() {
            preview.record(excluded(relative, ExclusionReason::UnsafeName));
            continue;
        }
        if let Some(reason) = path_exclusion(firewall, &relative) {
            preview.record(excluded(relative, reason));
            continue;
        }
        let bytes = entry.metadata().map(|m| m.len()).unwrap_or(0);
        if bytes > budget.max_file_bytes {
            preview.record(excluded(
                relative,
                ExclusionReason::TooLarge {
                    bytes,
                    max_bytes: budget.max_file_bytes,
                },
            ));
            continue;
        }
        if is_known_binary_extension(&relative) {
            preview.record(excluded(relative, ExclusionReason::Binary));
            continue;
        }
        let depth = relative.matches('/').count();
        let score = scorer.score(&FileFacts {
            relative: &relative,
            bytes,
            depth,
        });
        candidates.push(Candidate {
            relative,
            absolute: entry.into_path(),
            bytes,
            score,
        });
    }
    if let Ok(mut pruned) = filter.pruned.lock() {
        for entry in pruned.drain(..) {
            preview.record(entry);
        }
    }

    candidates.sort_by(|a, b| b.score.cmp(&a.score).then(a.relative.cmp(&b.relative)));
    for candidate in candidates {
        if preview.included.len() >= budget.max_files {
            preview.record(excluded(
                candidate.relative,
                ExclusionReason::OverFileBudget,
            ));
            continue;
        }
        if preview.total_bytes + candidate.bytes > budget.max_total_bytes {
            preview.record(excluded(
                candidate.relative,
                ExclusionReason::OverByteBudget,
            ));
            continue;
        }
        match sniff_file(&candidate.absolute) {
            Some(ContentClass::Text) => {}
            Some(_) => {
                preview.record(excluded(candidate.relative, ExclusionReason::Binary));
                continue;
            }
            None => {
                preview.record(excluded(candidate.relative, ExclusionReason::Unreadable));
                continue;
            }
        }
        // Containment again on the canonical path (defence in depth; links were not followed).
        if !canonical_matches(firewall, &candidate.absolute, &candidate.relative) {
            preview.record(excluded(candidate.relative, ExclusionReason::Link));
            continue;
        }
        preview.total_bytes += candidate.bytes;
        preview.included.push(FolderEntry {
            relative: candidate.relative,
            bytes: candidate.bytes,
            score: candidate.score,
        });
    }
    preview.elapsed_ms = started.elapsed().as_millis() as u64;
    Ok(preview)
}

fn excluded(relative: String, reason: ExclusionReason) -> ExcludedEntry {
    ExcludedEntry {
        relative,
        is_dir: false,
        reason,
    }
}

/// Path rules without ignore files (the walker already applied them).
fn path_exclusion(firewall: &Firewall, relative: &str) -> Option<ExclusionReason> {
    firewall
        .path_rules(relative, false, false)
        .into_iter()
        .filter(|r| r.effect >= RuleEffect::BlockOverridable)
        .max_by_key(|r| r.effect)
        .map(|r| match r.rule {
            FirewallRule::IgnoredPath { source, rule } => ExclusionReason::NeverShare {
                source,
                sensitivity: if r.effect == RuleEffect::Block {
                    Sensitivity::Secret
                } else {
                    Sensitivity::Confidential
                },
                rule,
            },
            FirewallRule::UserExclusion { pattern } => ExclusionReason::UserExcluded { pattern },
            FirewallRule::OutsideMissionScope { .. } => ExclusionReason::OutsideMissionScope,
            _ => ExclusionReason::UnsafeName,
        })
}

/// The file's canonical path is inside the workspace root and names the same relative path the
/// walk saw (no link, junction or rename in between).
fn canonical_matches(firewall: &Firewall, absolute: &Path, relative: &str) -> bool {
    let Some(root) = firewall.workspace().path() else {
        return false;
    };
    let Ok(real) = std::fs::canonicalize(absolute) else {
        return false;
    };
    let Ok(rest) = real.strip_prefix(root) else {
        return false;
    };
    let canonical = rest
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/");
    canonical == relative
}

fn sniff_file(path: &Path) -> Option<ContentClass> {
    let mut file = std::fs::File::open(path).ok()?;
    let mut buf = vec![0u8; SNIFF_BYTES];
    let mut filled = 0;
    while filled < buf.len() {
        match file.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(_) => return None,
        }
    }
    buf.truncate(filled);
    Some(sniff(&buf))
}
