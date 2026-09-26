//! The current project (the active workspace): repository state, `.env` files Git would commit,
//! files over 50 MiB, and lockfiles. Git facts come from the Z6a Git core; the file list is its
//! ignore-aware index (Git's ignore rules, `.git` never entered, links never followed).

use std::io::Read;
use std::path::Path;

use kalcode_contracts::permissions::PermissionScope;
use kalcode_git::RelPath;

use super::{CheckDef, CheckOutput, FindingExt, bytes, count, def, finding};
use crate::context::RunContext;
use crate::fixes::GITIGNORE_ENV;
use crate::types::{DoctorArea, FindingSeverity, FixOption, Reversibility};

/// Files at or above this size are "large" (DOC-01).
pub const LARGE_FILE: u64 = 50 * 1024 * 1024;
/// Most large files listed.
const MAX_LARGE: usize = 20;
/// Most `.env` files handled by one finding (and one fix).
pub const MAX_ENV_FILES: usize = 20;

pub fn checks() -> Vec<CheckDef> {
    vec![
        def(
            "project.repository",
            DoctorArea::Project,
            "Repository",
            repository,
        ),
        def(
            "project.env_files",
            DoctorArea::Project,
            "Environment files",
            env_files,
        ),
        def(
            "project.large_files",
            DoctorArea::Project,
            "Large files",
            large_files,
        ),
        def(
            "project.lockfiles",
            DoctorArea::Project,
            "Lockfiles",
            lockfiles,
        ),
    ]
}

fn no_project() -> CheckOutput {
    CheckOutput::skipped("No project is open. Open a folder to check it.")
}

fn repository(ctx: &RunContext) -> CheckOutput {
    let Some(project) = &ctx.project else {
        return no_project();
    };
    let Some(git) = &ctx.git else {
        return CheckOutput::could_not_check("KalCode's Git core isn't running.");
    };
    let root = match kalcode_git::WorkspaceRoot::new(&project.workspace_id, &project.root) {
        Ok(root) => root,
        Err(e) => return CheckOutput::could_not_check(e.message.clone()),
    };
    let repo = match git.repo(&root) {
        Ok(Some(repo)) => repo,
        Ok(None) => return CheckOutput::passed("Not a Git repository"),
        Err(e) => return CheckOutput::could_not_check(e.message.clone()),
    };
    let status = match git.status(&root) {
        Ok(Some(status)) => status,
        Ok(None) => return CheckOutput::passed("Not a Git repository"),
        Err(e) => return CheckOutput::could_not_check(e.message.clone()),
    };
    let ws = project.workspace_id.as_str();
    let mut findings = Vec::new();
    let git_dir = repo.git_dir();
    let operations: Vec<&str> = [
        ("MERGE_HEAD", "a merge"),
        ("rebase-merge", "a rebase"),
        ("rebase-apply", "a rebase or patch series"),
        ("CHERRY_PICK_HEAD", "a cherry-pick"),
        ("REVERT_HEAD", "a revert"),
        ("BISECT_LOG", "a bisect"),
    ]
    .into_iter()
    .filter(|(name, _)| git_dir.join(name).exists())
    .map(|(_, what)| what)
    .collect();
    if let Some(what) = operations.first() {
        findings.push(
            finding(
                "project.repository.operation_in_progress",
                FindingSeverity::Warning,
                format!("The repository is in the middle of {what}"),
                "Git is waiting for you to finish or abort it. Until then, commits and branch switches may not do what you expect, and agents working here see a half-finished state.",
            )
            .detail("Branch", status.branch.branch.clone().unwrap_or_else(|| "detached".into()))
            .in_workspace(ws),
        );
    }
    let conflicts: Vec<String> = status
        .files
        .iter()
        .filter(|f| f.conflict.is_some())
        .map(|f| f.path.clone())
        .collect();
    if !conflicts.is_empty() {
        findings.push(
            finding(
                "project.repository.conflicts",
                FindingSeverity::Warning,
                format!("{} with merge conflicts", count(conflicts.len(), "file", "files")),
                "These files still contain conflict markers from a merge or rebase. Resolve them before committing.",
            )
            .subjects(conflicts)
            .in_workspace(ws),
        );
    }
    if status.branch.branch.is_none() && operations.is_empty() {
        findings.push(
            finding(
                "project.repository.detached",
                FindingSeverity::Info,
                "No branch is checked out (detached HEAD)",
                "New commits made here aren't on any branch and are easy to lose when you switch away. Create a branch first if you plan to commit.",
            )
            .in_workspace(ws),
        );
    }
    let branch = status
        .branch
        .branch
        .clone()
        .unwrap_or_else(|| "detached HEAD".into());
    let changed = status.files.len();
    CheckOutput::with(
        format!(
            "On {branch}, {}",
            if changed == 0 {
                "no changes".to_owned()
            } else {
                count(changed, "changed file", "changed files")
            }
        ),
        findings,
    )
}

/// `.env`, `.env.local`, `.env.production`… but not the templates people commit on purpose.
pub fn is_env_file(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    if lower != ".env" && !lower.starts_with(".env.") {
        return false;
    }
    !matches!(
        lower.rsplit('.').next(),
        Some("example" | "sample" | "template" | "dist" | "defaults" | "schema" | "tpl")
    )
}

fn env_files(ctx: &RunContext) -> CheckOutput {
    let Some(project) = &ctx.project else {
        return no_project();
    };
    let Some(git) = &ctx.git else {
        return CheckOutput::could_not_check("KalCode's Git core isn't running.");
    };
    let root = match kalcode_git::WorkspaceRoot::new(&project.workspace_id, &project.root) {
        Ok(root) => root,
        Err(e) => return CheckOutput::could_not_check(e.message.clone()),
    };
    match git.repo(&root) {
        Ok(Some(_)) => {}
        Ok(None) => return CheckOutput::passed("Not a Git repository, so nothing is committed"),
        Err(e) => return CheckOutput::could_not_check(e.message.clone()),
    }
    let index = match ctx.project_index() {
        Ok(index) => index,
        Err(why) => return CheckOutput::could_not_check(why),
    };
    // The index holds only files Git would not ignore.
    let exposed: Vec<String> = index
        .find(".env", PROJECT_FIND_LIMIT)
        .into_iter()
        .filter(|rel| is_env_file(rel.file_name()))
        .map(|rel| rel.as_str().to_owned())
        .take(MAX_ENV_FILES)
        .collect();
    if exposed.is_empty() {
        return CheckOutput::passed("Ignored by Git (or none)");
    }
    CheckOutput::with(
        format!("{} not ignored", count(exposed.len(), "file", "files")),
        vec![
            finding(
                "project.env.not_ignored",
                FindingSeverity::Warning,
                format!(
                    "{} Git would commit",
                    if exposed.len() == 1 {
                        format!("{} is an environment file", exposed[0])
                    } else {
                        format!("{} environment files are", exposed.len())
                    }
                ),
                "Environment files usually hold passwords, API keys and tokens. Nothing ignores them in this repository, so the next \"git add .\" would commit them and anyone with the repository could read them. Adding them to .gitignore keeps them on this computer only. (If one was committed before, it stays in the history; remove it there too.)",
            )
            .detail("Project", &project.name)
            .subjects(exposed.clone())
            .fix(FixOption {
                fix_code: GITIGNORE_ENV.into(),
                label: "Add to .gitignore".into(),
                description: format!(
                    "Adds {} to the project's .gitignore (it's created if missing).",
                    if exposed.len() == 1 {
                        format!("the line /{}", exposed[0])
                    } else {
                        format!("{} lines, one per file", exposed.len())
                    }
                ),
                scopes: vec![PermissionScope::FilesystemWrite],
                reversible: Reversibility::Reversible {
                    how: "Undo removes exactly the lines the fix added (or the file, if the fix created it).".into(),
                },
                show_command_only: false,
                command: None,
                command_shell: None,
            })
            .in_workspace(&project.workspace_id),
        ],
    )
}

/// Most index entries scanned by one lookup.
const PROJECT_FIND_LIMIT: usize = crate::context::PROJECT_INDEX_LIMIT;

fn large_files(ctx: &RunContext) -> CheckOutput {
    let Some(project) = &ctx.project else {
        return no_project();
    };
    let index = match ctx.project_index() {
        Ok(index) => index,
        Err(why) => return CheckOutput::could_not_check(why),
    };
    let mut large: Vec<(RelPath, u64)> = Vec::new();
    for rel in index.find("", PROJECT_FIND_LIMIT) {
        if ctx.budget.should_stop() {
            return CheckOutput::could_not_check("The check was stopped before it finished.");
        }
        if let Some(meta) = index.get(&rel)
            && !meta.is_dir
            && meta.bytes >= LARGE_FILE
        {
            large.push((rel, meta.bytes));
        }
    }
    let truncated = index.truncated();
    if large.is_empty() {
        return CheckOutput::passed(if truncated {
            format!("None in the first {} files", PROJECT_FIND_LIMIT)
        } else {
            format!("None over {}", bytes(LARGE_FILE))
        });
    }
    large.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.as_str().cmp(b.0.as_str())));
    let total = large.len();
    CheckOutput::with(
        format!("{} over {}", count(total, "file", "files"), bytes(LARGE_FILE)),
        vec![
            finding(
                "project.large_files.found",
                FindingSeverity::Warning,
                format!(
                    "{} over {} that Git doesn't ignore",
                    count(total, "file", "files"),
                    bytes(LARGE_FILE)
                ),
                "Committing large files makes every clone and fetch slower, and most Git hosts refuse files over 100 MB. Keep build output, downloads and datasets out of Git (add them to .gitignore), or store them with Git LFS.",
            )
            .detail("Project", &project.name)
            .subjects(
                large
                    .iter()
                    .take(MAX_LARGE)
                    .map(|(rel, size)| format!("{} ({})", rel.as_str(), bytes(*size))),
            )
            .in_workspace(&project.workspace_id),
        ],
    )
}

/// Reads a small text file (package.json) with a size cap.
fn read_small(path: &Path, max: u64) -> Option<String> {
    let file = std::fs::File::open(path).ok()?;
    let mut text = String::new();
    file.take(max).read_to_string(&mut text).ok()?;
    Some(text)
}

/// JavaScript lockfiles and the package manager each one belongs to.
const JS_LOCKFILES: &[(&str, &str)] = &[
    ("pnpm-lock.yaml", "pnpm"),
    ("package-lock.json", "npm"),
    ("npm-shrinkwrap.json", "npm"),
    ("yarn.lock", "yarn"),
    ("bun.lock", "bun"),
    ("bun.lockb", "bun"),
];

fn lockfiles(ctx: &RunContext) -> CheckOutput {
    let Some(project) = &ctx.project else {
        return no_project();
    };
    let root = &project.root;
    let ws = project.workspace_id.as_str();
    let mut findings = Vec::new();
    let mut parts = Vec::new();

    if root.join("package.json").is_file() {
        let present: Vec<(&str, &str)> = JS_LOCKFILES
            .iter()
            .copied()
            .filter(|(file, _)| root.join(file).is_file())
            .collect();
        let mut managers: Vec<&str> = present.iter().map(|(_, m)| *m).collect();
        managers.dedup();
        let declared = read_small(&root.join("package.json"), 1024 * 1024)
            .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
            .and_then(|json| {
                json.get("packageManager")
                    .and_then(|v| v.as_str())
                    .map(|s| s.split('@').next().unwrap_or("").to_owned())
            })
            .filter(|m| !m.is_empty());
        if present.is_empty() {
            findings.push(
                finding(
                    "project.lockfiles.missing",
                    FindingSeverity::Info,
                    "package.json has no lockfile",
                    "Without a lockfile, every install can pick different dependency versions, so a build that works today may break tomorrow or on another computer. Running your package manager's install once creates one; commit it.",
                )
                .in_workspace(ws),
            );
            parts.push("JavaScript: no lockfile".to_owned());
        } else {
            parts.push(format!(
                "JavaScript: {}",
                present
                    .iter()
                    .map(|(f, _)| *f)
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        if managers.len() > 1 {
            findings.push(
                finding(
                    "project.lockfiles.mixed",
                    FindingSeverity::Warning,
                    "Lockfiles from more than one package manager",
                    "Each package manager reads only its own lockfile, so people (and agents) using different ones install different versions. Keep the one your project uses and delete the others.",
                )
                .subjects(present.iter().map(|(f, _)| (*f).to_owned()))
                .in_workspace(ws),
            );
        }
        if let Some(declared) = declared
            && !present.is_empty()
            && !managers.iter().any(|m| *m == declared)
        {
            findings.push(
                finding(
                    "project.lockfiles.mismatch",
                    FindingSeverity::Warning,
                    format!("package.json asks for {declared}, but the lockfile is from another package manager"),
                    "The packageManager field and the lockfile disagree, so installs may not match what the project expects. Reinstall with the declared package manager and commit its lockfile.",
                )
                .detail("packageManager", &declared)
                .subjects(present.iter().map(|(f, _)| (*f).to_owned()))
                .in_workspace(ws),
            );
        }
    }
    if root.join("Cargo.toml").is_file() {
        if root.join("Cargo.lock").is_file() {
            parts.push("Rust: Cargo.lock".to_owned());
        } else {
            parts.push("Rust: no Cargo.lock".to_owned());
            findings.push(
                finding(
                    "project.lockfiles.cargo_missing",
                    FindingSeverity::Info,
                    "Cargo.toml has no Cargo.lock",
                    "Applications should commit Cargo.lock so every build uses the same dependency versions. (Libraries may leave it out on purpose.) Running cargo build creates it.",
                )
                .in_workspace(ws),
            );
        }
    }
    if parts.is_empty() {
        return CheckOutput::passed("No package manifests at the project root");
    }
    CheckOutput::with(parts.join(" · "), findings)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_files_exclude_committed_templates() {
        for name in [
            ".env",
            ".env.local",
            ".ENV.production",
            ".env.development.local",
        ] {
            assert!(is_env_file(name), "{name}");
        }
        for name in [
            ".env.example",
            ".env.sample",
            ".env.template",
            ".envrc",
            "env",
            "x.env",
        ] {
            assert!(!is_env_file(name), "{name}");
        }
    }
}
