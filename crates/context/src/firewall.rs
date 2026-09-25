//! The Context Firewall: one evaluation for everything KalCode sends to a provider.
//!
//! Every rule that applies to an item fires and is reported; the verdict is the strongest
//! effect among them (**deny wins**):
//!
//! | Rule | Effect |
//! | --- | --- |
//! | workspace sharing not permitted | BLOCK |
//! | path outside the workspace / unsafe path | BLOCK |
//! | built-in never-share name, *secret* class (`.env*`, keys, credential files) | BLOCK |
//! | built-in never-share name, *confidential* class (data exports, `.git/`) | BLOCK, overridable per item |
//! | user never-share pattern | BLOCK (*secret*) or overridable (*confidential*) |
//! | user exclusion | BLOCK |
//! | outside the mission scope | BLOCK |
//! | ignored by `.gitignore` / `.ignore` / `.kalcodeignore` | BLOCK, overridable per item |
//! | binary content, or larger than the item cap | BLOCK |
//! | image / PDF / office document (cannot be inspected) | BLOCK, overridable per item |
//! | secret detected in content | ALLOW_REDACTED (BLOCK under [`SecretAction::Block`], or when an item is mostly secrets) |
//! | never-share file inside a diff | that section withheld: ALLOW_REDACTED |
//! | provider-produced text | label only |
//!
//! Overrides can lift only an overridable block, and only when **every** blocking rule is
//! overridable. No override removes a redaction.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::content::{ContentClass, decode_text, sniff};
use crate::diff::{split_sections, withhold};
use crate::error::Result;
use crate::ignore_rules::IgnoreOracle;
use crate::model::{
    FirewallReason, FirewallRule, FirewallVerdict, IgnoreSource, ItemKind, ItemOrigin, RuleEffect,
    Sensitivity,
};
use crate::never_share::{GlobList, NeverShareHit, NeverShareRules};
use crate::paths::{PathCheck, WorkspaceRoot, check_relative_text, resolve};
use crate::redact::{PlaceholderStyle, Redacted, apply};
use crate::secrets::{Confidence, Finding, ScanContext, scan_with};

/// Default cap for a single item's content (larger items are refused, not trimmed).
pub const DEFAULT_MAX_ITEM_BYTES: u64 = 8 * 1024 * 1024;
/// Above this many redactions an item is treated as a secrets file and blocked.
pub const DEFAULT_MAX_REDACTIONS_PER_ITEM: usize = 256;

/// Whether sharing workspace content with providers is permitted at all. Supplied by the caller
/// (workspace setting, and for non-user origins the Trust Kernel's `context.share` decision).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum WorkspacePermission {
    #[default]
    Granted,
    Denied {
        reason: String,
    },
}

/// What to do with content that contains secrets.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SecretAction {
    /// Send with the secret values replaced (default).
    #[default]
    Redact,
    /// Refuse the whole item when a high-confidence secret is found.
    Block,
}

/// The mission's file scope: items must come from paths matching one of `allowed`, and mission
/// artifacts must belong to `mission_id`.
#[derive(Debug, Clone)]
pub struct MissionScope {
    pub mission_id: String,
    allowed: GlobList,
}

impl MissionScope {
    pub fn new<S: AsRef<str>>(mission_id: impl Into<String>, allowed: &[S]) -> Result<Self> {
        Ok(Self {
            mission_id: mission_id.into(),
            allowed: GlobList::new(allowed)?,
        })
    }

    pub fn allows(&self, relative: &str) -> bool {
        // An empty scope allows nothing: a mission without declared files shares no files.
        self.allowed.first_match(relative).is_some()
    }
}

/// Everything the firewall needs besides the workspace.
#[derive(Debug, Clone)]
pub struct FirewallPolicy {
    pub permission: WorkspacePermission,
    pub never_share: NeverShareRules,
    pub exclusions: GlobList,
    pub mission_scope: Option<MissionScope>,
    pub respect_ignore_files: bool,
    pub max_item_bytes: u64,
    pub on_secret: SecretAction,
    pub max_redactions_per_item: usize,
}

impl Default for FirewallPolicy {
    fn default() -> Self {
        Self {
            permission: WorkspacePermission::Granted,
            never_share: NeverShareRules::builtin(),
            exclusions: GlobList::default(),
            mission_scope: None,
            respect_ignore_files: true,
            max_item_bytes: DEFAULT_MAX_ITEM_BYTES,
            on_secret: SecretAction::Redact,
            max_redactions_per_item: DEFAULT_MAX_REDACTIONS_PER_ITEM,
        }
    }
}

/// Content handed to the firewall.
#[derive(Debug, Clone, Copy)]
pub enum Content<'a> {
    /// No content (a folder listing, a URL whose address is checked separately).
    None,
    Text(&'a str),
    Bytes(&'a [u8]),
}

/// One item to evaluate.
#[derive(Debug, Clone, Copy)]
pub struct Candidate<'a> {
    pub kind: ItemKind,
    pub origin: ItemOrigin,
    /// The workspace path the item comes from (workspace-relative or absolute, native-resolved).
    pub path: Option<&'a str>,
    /// For mission artifacts: the mission they belong to.
    pub mission_id: Option<&'a str>,
    /// A file name hint for content without a path (a dropped screenshot, a pasted file).
    pub file_name: Option<&'a str>,
    pub content: Content<'a>,
}

impl<'a> Candidate<'a> {
    pub fn text(kind: ItemKind, origin: ItemOrigin, text: &'a str) -> Self {
        Self {
            kind,
            origin,
            path: None,
            mission_id: None,
            file_name: None,
            content: Content::Text(text),
        }
    }
}

/// The firewall's decision for one item.
#[derive(Debug, Clone, PartialEq)]
pub struct FirewallDecision {
    pub verdict: FirewallVerdict,
    pub sensitivity: Sensitivity,
    pub reasons: Vec<FirewallReason>,
    /// Canonical workspace-relative path, when the item named a path inside the workspace.
    pub relative_path: Option<String>,
    pub content_class: Option<ContentClass>,
    /// Text content after section withholding and redaction (present for text content that was
    /// evaluated, even when nothing was redacted). Never present for blocked items.
    pub text: Option<Redacted>,
}

impl FirewallDecision {
    /// Whether a per-item confirmation can lift this block.
    pub fn overridable(&self) -> bool {
        matches!(self.verdict, FirewallVerdict::Block { overridable: true })
    }

    pub fn redaction_count(&self) -> u32 {
        self.reasons
            .iter()
            .filter(|r| r.effect == RuleEffect::Redact)
            .map(|r| match &r.rule {
                FirewallRule::SecretDetected { count, .. } => *count,
                _ => 1,
            })
            .sum()
    }
}

/// Result of checking a user-typed prompt: warn-and-confirm, never block (FW-01).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptCheck {
    pub warn: bool,
    /// Detector ids with counts; offsets let the UI highlight without copying the values.
    pub detectors: BTreeMap<String, u32>,
    pub findings: Vec<Finding>,
}

impl PromptCheck {
    /// The decision-log entry for a warning (`None` when the prompt was clean). `request_id`
    /// identifies the send the prompt belongs to (stored in the log's `package_id` column).
    pub fn log_entry(&self, request_id: &str) -> Option<crate::log::FirewallLogEntry> {
        self.warn.then(|| crate::log::FirewallLogEntry {
            id: uuid::Uuid::now_v7().to_string(),
            occurred_at: kalcode_core::time::now_rfc3339(),
            package_id: request_id.to_owned(),
            position: None,
            rule: "secret_detected".to_owned(),
            action: crate::log::LogAction::Warned,
            detail: serde_json::json!({ "detectors": self.detectors, "origin": "user_prompt" }),
        })
    }
}

/// The Context Firewall for one workspace.
#[derive(Debug)]
pub struct Firewall {
    workspace: WorkspaceRoot,
    policy: FirewallPolicy,
    ignore: Option<IgnoreOracle>,
}

impl Firewall {
    pub fn new(workspace: WorkspaceRoot, policy: FirewallPolicy) -> Self {
        let ignore = if policy.respect_ignore_files {
            workspace.path().map(IgnoreOracle::new)
        } else {
            None
        };
        Self {
            workspace,
            policy,
            ignore,
        }
    }

    /// A firewall for `root` with default policy (built-in rules, ignore files honoured).
    pub fn for_root(root: &Path) -> Self {
        Self::new(WorkspaceRoot::new(root), FirewallPolicy::default())
    }

    pub fn workspace(&self) -> &WorkspaceRoot {
        &self.workspace
    }

    pub fn policy(&self) -> &FirewallPolicy {
        &self.policy
    }

    /// Resolves and checks a path (containment, never-share, exclusions, ignore files, mission
    /// scope). Filesystem access: canonicalization and ignore files only; content is not read.
    pub fn check_path(&self, raw: &str, is_dir: bool) -> (PathCheck, Vec<FirewallReason>) {
        let check = resolve(&self.workspace, raw);
        let reasons = match &check {
            PathCheck::Inside { relative, .. } => self.relative_rules(relative, is_dir),
            PathCheck::Outside { reason } => vec![reason_block(
                FirewallRule::OutsideWorkspace,
                RuleEffect::Block,
                reason,
            )],
            PathCheck::Unsafe { reason } => vec![reason_block(
                FirewallRule::UnsafePath,
                RuleEffect::Block,
                reason,
            )],
        };
        (check, reasons)
    }

    /// Rules that depend only on a (canonical or textual) workspace-relative path.
    pub fn relative_rules(&self, relative: &str, is_dir: bool) -> Vec<FirewallReason> {
        self.path_rules(relative, is_dir, true)
    }

    /// [`Self::relative_rules`], optionally without ignore files (folder walks apply those
    /// themselves).
    pub fn path_rules(
        &self,
        relative: &str,
        is_dir: bool,
        ignore_files: bool,
    ) -> Vec<FirewallReason> {
        let mut reasons = Vec::new();
        for hit in self.policy.never_share.check(relative) {
            let effect = if hit.sensitivity() >= Sensitivity::Secret {
                RuleEffect::Block
            } else {
                RuleEffect::BlockOverridable
            };
            let (source, rule, message) = match &hit {
                NeverShareHit::Builtin(b) => (
                    IgnoreSource::BuiltinSensitive,
                    b.rule.to_owned(),
                    format!("KalCode never shares {}.", b.description),
                ),
                NeverShareHit::Pattern(p) => (
                    IgnoreSource::WorkspaceNeverShare,
                    p.pattern.clone(),
                    format!("Matches your never-share pattern {:?}.", p.pattern),
                ),
            };
            reasons.push(FirewallReason {
                rule: FirewallRule::IgnoredPath { source, rule },
                effect,
                message,
            });
            reasons.push(FirewallReason {
                rule: FirewallRule::SensitivityLabel {
                    level: hit.sensitivity(),
                },
                effect: RuleEffect::Label,
                message: format!("Classified {}.", hit.sensitivity().as_str()),
            });
        }
        if let Some(pattern) = self.policy.exclusions.first_match(relative) {
            reasons.push(FirewallReason {
                rule: FirewallRule::UserExclusion {
                    pattern: pattern.to_owned(),
                },
                effect: RuleEffect::Block,
                message: format!("You excluded paths matching {pattern:?}."),
            });
        }
        if let Some(scope) = &self.policy.mission_scope
            && !scope.allows(relative)
        {
            reasons.push(FirewallReason {
                rule: FirewallRule::OutsideMissionScope {
                    mission_id: scope.mission_id.clone(),
                },
                effect: RuleEffect::Block,
                message: "The path is outside the mission's scope; change the mission scope to include it.".to_owned(),
            });
        }
        if ignore_files
            && let Some(oracle) = &self.ignore
            && let Some(hit) = oracle.check(relative, is_dir)
        {
            reasons.push(FirewallReason {
                rule: FirewallRule::IgnoredPath {
                    source: IgnoreSource::GitIgnore,
                    rule: hit.file.clone(),
                },
                effect: RuleEffect::BlockOverridable,
                message: format!(
                    "Ignored by the {}; confirm this item to share it anyway.",
                    hit.file
                ),
            });
        }
        reasons
    }

    /// Evaluates one item. Pure apart from path resolution and ignore-file reads.
    pub fn evaluate(&self, candidate: &Candidate<'_>) -> FirewallDecision {
        let checked = candidate
            .path
            .map(|path| self.check_path(path, matches!(candidate.kind, ItemKind::Folder)));
        self.evaluate_checked(candidate, checked)
    }

    /// [`Self::evaluate`] with the candidate's path already checked by [`Self::check_path`]
    /// (package building resolves each path once and re-checks it after reading).
    pub fn evaluate_checked(
        &self,
        candidate: &Candidate<'_>,
        checked: Option<(PathCheck, Vec<FirewallReason>)>,
    ) -> FirewallDecision {
        let mut reasons: Vec<FirewallReason> = Vec::new();
        let mut relative_path = None;

        if let WorkspacePermission::Denied { reason } = &self.policy.permission {
            reasons.push(FirewallReason {
                rule: FirewallRule::WorkspacePermissionDenied,
                effect: RuleEffect::Block,
                message: format!("Sharing from this workspace isn't permitted: {reason}"),
            });
        }

        if let Some((check, path_reasons)) = checked {
            relative_path = check.relative().map(str::to_owned);
            reasons.extend(path_reasons);
        }

        if candidate.kind == ItemKind::MissionArtifact
            && let Some(scope) = &self.policy.mission_scope
            && candidate.mission_id != Some(scope.mission_id.as_str())
        {
            reasons.push(FirewallReason {
                rule: FirewallRule::OutsideMissionScope {
                    mission_id: scope.mission_id.clone(),
                },
                effect: RuleEffect::Block,
                message: "This artifact belongs to a different mission.".to_owned(),
            });
        }

        if candidate.origin == ItemOrigin::Provider {
            reasons.push(FirewallReason {
                rule: FirewallRule::UntrustedProviderText,
                effect: RuleEffect::Label,
                message: "Provider output: passed on as quoted data, never as instructions."
                    .to_owned(),
            });
        }

        let file_name = candidate
            .file_name
            .or(relative_path.as_deref())
            .or(candidate.path);
        // Content of an item that is already finally blocked is never inspected or kept.
        let (content_class, text) =
            if verdict_of(&reasons) == (FirewallVerdict::Block { overridable: false }) {
                (None, None)
            } else {
                self.evaluate_content(candidate, file_name, &mut reasons)
            };

        let verdict = verdict_of(&reasons);
        let sensitivity = sensitivity_of(candidate, &reasons);
        FirewallDecision {
            verdict,
            sensitivity,
            reasons,
            relative_path,
            content_class,
            text: if verdict == (FirewallVerdict::Block { overridable: false }) {
                None
            } else {
                text
            },
        }
    }

    fn evaluate_content(
        &self,
        candidate: &Candidate<'_>,
        file_name: Option<&str>,
        reasons: &mut Vec<FirewallReason>,
    ) -> (Option<ContentClass>, Option<Redacted>) {
        let decoded: String;
        let text: &str = match candidate.content {
            Content::None => return (None, None),
            Content::Text(text) => text,
            Content::Bytes(bytes) => {
                if bytes.len() as u64 > self.policy.max_item_bytes {
                    reasons.push(size_reason(self.policy.max_item_bytes));
                    return (None, None);
                }
                match sniff(bytes) {
                    ContentClass::Text => match decode_text(bytes) {
                        Some(t) => {
                            decoded = t;
                            &decoded
                        }
                        None => {
                            reasons.push(binary_reason());
                            return (Some(ContentClass::Binary), None);
                        }
                    },
                    class @ (ContentClass::Image { .. } | ContentClass::Document { .. }) => {
                        reasons.push(FirewallReason {
                            rule: FirewallRule::UnscannableContent,
                            effect: RuleEffect::BlockOverridable,
                            message: "KalCode can't check images or documents for secrets; confirm this item to share it.".to_owned(),
                        });
                        return (Some(class), None);
                    }
                    ContentClass::Binary => {
                        reasons.push(binary_reason());
                        return (Some(ContentClass::Binary), None);
                    }
                }
            }
        };
        if text.len() as u64 > self.policy.max_item_bytes {
            reasons.push(size_reason(self.policy.max_item_bytes));
            return (Some(ContentClass::Text), None);
        }

        // Diffs: withhold whole sections for files that must never be shared.
        let withheld_text;
        let text = if matches!(candidate.kind, ItemKind::Diff | ItemKind::GitCommit) {
            withheld_text = self.withhold_diff_sections(text, reasons);
            withheld_text.as_deref().unwrap_or(text)
        } else {
            text
        };

        let context = ScanContext {
            file_name,
            no_entropy: false,
        };
        let findings = scan_with(text, context);
        let redacted = apply(text, &findings, PlaceholderStyle::Labelled);
        let high = findings.iter().any(|f| f.confidence == Confidence::High);
        let mut per_detector: BTreeMap<&str, (u32, Confidence)> = BTreeMap::new();
        for f in &findings {
            let entry = per_detector
                .entry(f.detector)
                .or_insert((0, Confidence::Medium));
            entry.0 += 1;
            entry.1 = entry.1.max(f.confidence);
        }
        let too_many = findings.len() > self.policy.max_redactions_per_item;
        for (detector, (count, confidence)) in &per_detector {
            let effect = if too_many
                || (self.policy.on_secret == SecretAction::Block && *confidence == Confidence::High)
            {
                RuleEffect::Block
            } else {
                RuleEffect::Redact
            };
            reasons.push(FirewallReason {
                rule: FirewallRule::SecretDetected {
                    detector: (*detector).to_owned(),
                    count: *count,
                },
                effect,
                message: if too_many {
                    format!(
                        "{} secrets found; KalCode won't send content that is mostly secrets.",
                        findings.len()
                    )
                } else if effect == RuleEffect::Block {
                    "A secret was found and this workspace blocks items with secrets.".to_owned()
                } else {
                    format!("{count} value(s) that look like {detector} will be replaced.")
                },
            });
        }
        if !findings.is_empty() {
            let level = if high {
                Sensitivity::Secret
            } else {
                Sensitivity::Confidential
            };
            reasons.push(FirewallReason {
                rule: FirewallRule::SensitivityLabel { level },
                effect: RuleEffect::Label,
                message: format!("Classified {}: it contains secret values.", level.as_str()),
            });
        }
        (Some(ContentClass::Text), Some(redacted))
    }

    /// Returns the diff with never-share sections withheld (or `None` if nothing changed).
    fn withhold_diff_sections(
        &self,
        text: &str,
        reasons: &mut Vec<FirewallReason>,
    ) -> Option<String> {
        let sections = split_sections(text);
        let mut withheld = Vec::new();
        for section in &sections {
            let mut blocking: Option<FirewallReason> = None;
            for path in &section.paths {
                let path_reasons = match check_relative_text(path) {
                    Ok(relative) => self.relative_rules(&relative, false),
                    Err(reason) => vec![reason_block(
                        FirewallRule::UnsafePath,
                        RuleEffect::Block,
                        reason,
                    )],
                };
                if let Some(r) = path_reasons
                    .into_iter()
                    .filter(|r| r.effect >= RuleEffect::BlockOverridable)
                    .max_by_key(|r| r.effect)
                {
                    blocking = Some(r);
                    break;
                }
            }
            if let Some(reason) = blocking {
                let label = section.paths.first().cloned().unwrap_or_default();
                withheld.push((
                    section,
                    format!(
                        "[KalCode withheld the changes to this file: {}]",
                        reason.rule.code()
                    ),
                ));
                reasons.push(FirewallReason {
                    rule: reason.rule,
                    effect: RuleEffect::Redact,
                    message: format!("Changes to {label} were withheld: {}", reason.message),
                });
            }
        }
        if withheld.is_empty() {
            None
        } else {
            Some(withhold(text, &withheld))
        }
    }

    /// Checks a user-typed prompt for secrets. User authority: this warns, it never blocks.
    pub fn check_user_prompt(&self, text: &str) -> PromptCheck {
        let findings = scan_with(
            text,
            ScanContext {
                file_name: None,
                no_entropy: false,
            },
        );
        let mut detectors = BTreeMap::new();
        for f in &findings {
            *detectors.entry(f.detector.to_owned()).or_insert(0) += 1;
        }
        PromptCheck {
            warn: !findings.is_empty(),
            detectors,
            findings,
        }
    }
}

/// Deny wins: the strongest effect decides.
pub fn verdict_of(reasons: &[FirewallReason]) -> FirewallVerdict {
    let strongest = reasons
        .iter()
        .map(|r| r.effect)
        .max()
        .unwrap_or(RuleEffect::Label);
    match strongest {
        RuleEffect::Block => FirewallVerdict::Block { overridable: false },
        RuleEffect::BlockOverridable => FirewallVerdict::Block { overridable: true },
        RuleEffect::Redact => FirewallVerdict::AllowRedacted {
            spans: reasons
                .iter()
                .filter(|r| r.effect == RuleEffect::Redact)
                .map(|r| match &r.rule {
                    FirewallRule::SecretDetected { count, .. } => *count,
                    _ => 1,
                })
                .sum(),
        },
        RuleEffect::Label => FirewallVerdict::Allow,
    }
}

fn sensitivity_of(candidate: &Candidate<'_>, reasons: &[FirewallReason]) -> Sensitivity {
    // Nothing is classified public automatically: everything starts as internal.
    let _ = candidate;
    reasons
        .iter()
        .filter_map(|r| match &r.rule {
            FirewallRule::SensitivityLabel { level } => Some(*level),
            FirewallRule::IgnoredPath {
                source: IgnoreSource::GitIgnore,
                ..
            }
            | FirewallRule::UnscannableContent => Some(Sensitivity::Confidential),
            _ => None,
        })
        .fold(Sensitivity::Internal, Sensitivity::max)
}

fn reason_block(rule: FirewallRule, effect: RuleEffect, message: &str) -> FirewallReason {
    FirewallReason {
        rule,
        effect,
        message: message.to_owned(),
    }
}

fn binary_reason() -> FirewallReason {
    FirewallReason {
        rule: FirewallRule::BinaryContent,
        effect: RuleEffect::Block,
        message: "Binary files are never sent.".to_owned(),
    }
}

fn size_reason(max: u64) -> FirewallReason {
    FirewallReason {
        rule: FirewallRule::SizeLimit { max_bytes: max },
        effect: RuleEffect::Block,
        message: format!("The item is larger than the {max}-byte limit for one item."),
    }
}
