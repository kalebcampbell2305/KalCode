//! Turns a provider's normalized action into the facts the policy judges: the authority scopes
//! it needs, whether KalCode could see all of it (`opaque`), a fingerprint identifying "the
//! same action" for standing grants, and the subjects (command, hosts, paths) rules match on.

use kalcode_contracts::permissions::{ActionKind, GitOperation, PermissionScope as S};

use crate::command::{self, CommandFacts};
use crate::network;
use crate::paths::{self, PathInfo, Workspace};
use crate::scopes;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Classification {
    /// Scopes in canonical order. Never empty.
    pub scopes: Vec<S>,
    /// KalCode could not see everything the action will do. Opaque actions always need an
    /// explicit approval and can only be approved once.
    pub opaque: bool,
    /// The action touches something that can run code or hold secrets in a way a standing
    /// grant must not cover (e.g. writing inside `.git/`).
    pub sensitive: bool,
    /// Human-readable facts behind the scopes.
    pub notes: Vec<String>,
    /// Identifies "the same action" for standing grants (thread / workspace approvals).
    pub fingerprint: String,
    /// Command-like subject for prefix rules ("npm test", "git push origin", "deploy prod").
    pub subject: Option<String>,
    pub hosts: Vec<String>,
    pub paths: Vec<PathInfo>,
    /// What a standing grant made from this action would cover, for the approval prompt.
    pub grant_coverage: String,
}

impl Classification {
    fn new(fingerprint: impl Into<String>) -> Self {
        Self {
            scopes: Vec::new(),
            opaque: false,
            sensitive: false,
            notes: Vec::new(),
            fingerprint: fingerprint.into(),
            subject: None,
            hosts: Vec::new(),
            paths: Vec::new(),
            grant_coverage: String::new(),
        }
    }

    fn add(&mut self, scope: S) {
        if !self.scopes.contains(&scope) {
            self.scopes.push(scope);
        }
    }

    fn note(&mut self, note: impl Into<String>) {
        let note = note.into();
        if !self.notes.contains(&note) {
            self.notes.push(note);
        }
    }

    fn path(&mut self, info: PathInfo, write: bool) {
        if info.outside {
            self.add(S::FilesystemOutsideWorkspace);
            if let Some(note) = &info.note {
                self.note(note.clone());
            }
        }
        if info.opaque {
            self.opaque = true;
        }
        if info.network {
            self.add(S::NetworkOther);
        }
        if info.credentials {
            self.add(S::CredentialsAccess);
            self.note(format!("{} may contain credentials.", info.display));
        }
        if write && info.git_internal {
            self.add(S::TerminalExecute);
            self.sensitive = true;
            self.note("Changing files inside .git can make Git run code.");
        }
        self.paths.push(info);
    }

    fn finish(mut self) -> Self {
        if self.scopes.is_empty() {
            // Nothing recognizable: fail closed.
            self.scopes.push(S::TerminalExecute);
            self.opaque = true;
        }
        scopes::normalize(&mut self.scopes);
        if self.opaque {
            self.sensitive = true;
        }
        self
    }
}

/// Longest provider-supplied string that is used verbatim in fingerprints and subjects.
const MAX_FIELD: usize = 4096;

fn clip(text: &str) -> String {
    text.chars().take(MAX_FIELD).collect()
}

fn collapse_whitespace(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Classifies an action in the context of its workspace.
pub fn classify(kind: &ActionKind, workspace: &Workspace) -> Classification {
    match kind {
        ActionKind::FileRead { path } => file(path, workspace, FileOp::Read),
        ActionKind::FileWrite { path } => file(path, workspace, FileOp::Write),
        ActionKind::FileDelete { path } => file(path, workspace, FileOp::Delete),
        ActionKind::Command { command, argv, cwd } => shell(command, argv, cwd, workspace),
        ActionKind::PackageInstall { manager, packages } => package(manager, packages, workspace),
        ActionKind::Git { operation, remote } => git(*operation, remote.as_deref()),
        ActionKind::Network { host, url } => network_request(host, url.as_deref()),
        ActionKind::Browser { action, url } => browser(action, url.as_deref()),
        ActionKind::Deploy { target } => deploy(target),
        ActionKind::Tool {
            tool,
            input_summary,
        } => unknown_tool(tool, input_summary),
        ActionKind::ProcessSignal {
            pid, process_name, ..
        } => pending_kernel_kind(
            S::ProcessControl,
            format!("process:{pid}:{}", clip(process_name)),
            "Stopping a process",
        ),
        ActionKind::RemoteConnect { host_id, .. } => pending_kernel_kind(
            S::RemoteConnect,
            format!("remote:{}", clip(host_id)),
            "Connecting to a remote machine",
        ),
        ActionKind::ContextShare { package_id, .. } => pending_kernel_kind(
            S::ContextShare,
            format!("context:{}", clip(package_id)),
            "Sharing context with a provider",
        ),
        ActionKind::MemoryWrite { memory_id, .. } => pending_kernel_kind(
            S::MemoryWrite,
            format!("memory:{}", clip(memory_id.as_deref().unwrap_or("new"))),
            "Saving to memory",
        ),
        ActionKind::Delegate { contract_id, .. } => pending_kernel_kind(
            S::AgentDelegate,
            format!("delegate:{}", clip(contract_id)),
            "Delegating work to another agent",
        ),
        ActionKind::Restore { checkpoint_id, .. } => {
            let mut c = pending_kernel_kind(
                S::FilesystemWrite,
                format!("restore:{}", clip(checkpoint_id)),
                "Restoring files from a checkpoint",
            );
            c.add(S::Destructive);
            c.finish()
        }
        ActionKind::AutomationChange { automation_id, .. } => pending_kernel_kind(
            S::AutomationManage,
            format!("automation:{}", clip(automation_id)),
            "Changing an automation",
        ),
        ActionKind::DoctorFix { fix_code, .. } => pending_kernel_kind(
            S::TerminalExecute,
            format!("doctor:{}", clip(fix_code)),
            "Applying an Environment Doctor fix",
        ),
        ActionKind::CreateThreads {
            provider_id, count, ..
        } => thread_start(
            format!("threads.create:{}:{count}", clip(provider_id.as_str())),
            format!("Opens {count} new agent thread(s) that will start working."),
        ),
        ActionKind::ResumeThreads { scope } => thread_start(
            format!("threads.resume:{}", clip(&format!("{scope:?}"))),
            "Resumes agent threads so they continue working.".to_owned(),
        ),
    }
}

/// Starting or resuming agent threads on the user's behalf: fully visible (not opaque), but
/// never covered by a standing approval (`sensitive`), so each request is approved once.
fn thread_start(fingerprint: String, note: String) -> Classification {
    let mut c = Classification::new(fingerprint);
    c.add(S::ThreadStart);
    c.sensitive = true;
    c.note(note);
    c.grant_coverage = "only this request".into();
    c.finish()
}

/// Action kinds adopted for the Trust Kernel in CA-1 that the engine does not classify precisely
/// until TK-1: evaluated as opaque (always an explicit, one-time approval), with their scope.
fn pending_kernel_kind(scope: S, fingerprint: String, what: &str) -> Classification {
    let mut c = Classification::new(fingerprint);
    c.add(scope);
    c.opaque = true;
    c.note(format!(
        "{what} is always confirmed by you until KalCode can check it in detail."
    ));
    c.grant_coverage = "only this request".into();
    c.finish()
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum FileOp {
    Read,
    Write,
    Delete,
}

fn file(path: &str, workspace: &Workspace, op: FileOp) -> Classification {
    let info = paths::resolve(workspace, None, path);
    let exact = info.outside || info.credentials || info.git_internal || info.opaque;
    let key = info.relative.clone().unwrap_or_else(|| clip(path.trim()));
    let (verb, scope) = match op {
        FileOp::Read => ("read", S::FilesystemRead),
        FileOp::Write => ("write", S::FilesystemWrite),
        FileOp::Delete => ("delete", S::FilesystemWrite),
    };
    // Reads and writes inside the workspace share one fingerprint, so "Allow for thread"
    // means "this kind of file access anywhere in the workspace". Deletions, secrets, .git
    // and anything outside the workspace are always per-path.
    let fingerprint = if exact || op == FileOp::Delete {
        format!("file.{verb}:{key}")
    } else {
        format!("file.{verb}")
    };
    let mut c = Classification::new(fingerprint);
    c.add(scope);
    if op == FileOp::Read {
        c.subject = Some(format!("read {key}"));
    } else {
        c.subject = Some(format!("{verb} {key}"));
    }
    let root_or_dir = info.relative.as_deref() == Some("")
        || workspace
            .root()
            .zip(info.relative.as_deref())
            .is_some_and(|(root, rel)| root.join(rel).is_dir());
    let git_internal = info.git_internal;
    c.path(info, op != FileOp::Read);
    if op == FileOp::Delete && (root_or_dir || git_internal) {
        c.add(S::Destructive);
        c.note("Deleting a folder or Git data removes everything inside it.");
    }
    c.grant_coverage = if exact || op == FileOp::Delete {
        format!("only {verb}s of {key}")
    } else if op == FileOp::Read {
        "reading any file in this workspace".into()
    } else {
        "changing any file in this workspace".into()
    };
    c.finish()
}

fn shell(command: &str, argv: &[String], cwd: &str, workspace: &Workspace) -> Classification {
    let display = if command.trim().is_empty() {
        argv.join(" ")
    } else {
        command.to_owned()
    };
    let facts: CommandFacts = command::classify_command(command, argv, cwd, workspace);
    let mut c = Classification::new(format!(
        "command:{}@{}",
        clip(&collapse_whitespace(&display)),
        clip(cwd.trim())
    ));
    c.scopes = facts.scopes;
    c.opaque = facts.opaque;
    c.notes = facts.notes;
    c.hosts = facts.hosts;
    c.sensitive = facts.paths.iter().any(|p| p.git_internal || p.credentials);
    c.paths = facts.paths;
    c.subject = facts.simple;
    c.grant_coverage = "only this exact command, in this folder".into();
    c.finish()
}

/// Package managers that install for the whole computer rather than the project.
const SYSTEM_MANAGERS: &[&str] = &[
    "brew",
    "apt",
    "apt-get",
    "yum",
    "dnf",
    "pacman",
    "apk",
    "zypper",
    "choco",
    "winget",
    "scoop",
    "snap",
    "flatpak",
    "port",
    "gem",
    "pipx",
    "cargo-install",
    "go-install",
    "npm-global",
];

fn package(manager: &str, packages: &[String], workspace: &Workspace) -> Classification {
    let manager_clean = manager.trim().to_ascii_lowercase();
    let mut sorted: Vec<String> = packages.iter().map(|p| clip(p.trim())).collect();
    sorted.sort();
    sorted.dedup();
    let mut c = Classification::new(format!("package:{manager_clean}:{}", sorted.join(",")));
    c.add(S::PackageInstall);
    if manager_clean.is_empty()
        || !manager_clean
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.')
    {
        c.opaque = true;
        c.note("The package manager name is not recognizable.");
    }
    if SYSTEM_MANAGERS.contains(&manager_clean.as_str()) {
        c.add(S::FilesystemOutsideWorkspace);
        c.note("The package manager installs for the whole computer.");
    }
    for package in &sorted {
        let lower = package.to_ascii_lowercase();
        if lower.contains("://") || lower.starts_with("git+") || lower.starts_with("github:") {
            c.note(format!(
                "{package} is installed from a URL, not the registry."
            ));
            if let Some(host) = network::url_host(package.trim_start_matches("git+")) {
                c.hosts.push(host);
            }
            c.add(S::NetworkOther);
        } else if let Some(local) = lower.strip_prefix("file:").or_else(|| {
            (lower.starts_with('.') || lower.starts_with('/') || lower.contains('\\'))
                .then_some(lower.as_str())
        }) {
            let info = paths::resolve(workspace, None, local);
            c.path(info, false);
        }
        if package.starts_with('-') {
            c.opaque = true;
            c.note(format!("“{package}” looks like an option, not a package."));
        }
    }
    c.subject = Some(collapse_whitespace(&format!(
        "{manager_clean} install {}",
        sorted.join(" ")
    )));
    c.grant_coverage = format!(
        "only installing {} with {manager_clean}",
        if sorted.is_empty() {
            "the project's dependencies".to_owned()
        } else {
            sorted.join(", ")
        }
    );
    c.finish()
}

fn git(operation: GitOperation, remote: Option<&str>) -> Classification {
    let op = match operation {
        GitOperation::Status => "status",
        GitOperation::Diff => "diff",
        GitOperation::Log => "log",
        GitOperation::Commit => "commit",
        GitOperation::Branch => "branch",
        GitOperation::Checkout => "checkout",
        GitOperation::Push => "push",
        GitOperation::Pull => "pull",
        GitOperation::Reset => "reset",
        GitOperation::Other => "other",
    };
    let remote = remote.map(|r| clip(r.trim()));
    let mut c = Classification::new(format!("git:{op}:{}", remote.clone().unwrap_or_default()));
    match operation {
        GitOperation::Status | GitOperation::Diff | GitOperation::Log => c.add(S::GitRead),
        GitOperation::Branch => c.add(S::GitCommit),
        GitOperation::Commit | GitOperation::Checkout => {
            c.add(S::GitCommit);
            c.add(S::TerminalExecute);
            c.note("Git may run repository hooks for this operation.");
        }
        GitOperation::Push => {
            c.add(S::GitPush);
            c.add(S::TerminalExecute);
            c.note("Git may run repository hooks for this operation.");
        }
        GitOperation::Pull => {
            c.add(S::GitCommit);
            c.add(S::NetworkOther);
            c.add(S::TerminalExecute);
        }
        GitOperation::Reset => {
            c.add(S::GitCommit);
            c.add(S::Destructive);
            c.note("A reset can discard uncommitted work.");
        }
        GitOperation::Other => {
            c.add(S::GitCommit);
            c.add(S::TerminalExecute);
            c.opaque = true;
            c.note("KalCode doesn't know exactly which Git operation this is.");
        }
    }
    if let Some(remote) = &remote {
        if let Some(host) = network::url_host(remote) {
            c.hosts.push(host);
        }
        c.subject = Some(format!("git {op} {remote}"));
    } else {
        c.subject = Some(format!("git {op}"));
    }
    c.grant_coverage = match &remote {
        Some(remote) => format!("only git {op} to {remote}"),
        None => format!("only git {op}"),
    };
    c.finish()
}

fn network_request(host: &str, url: Option<&str>) -> Classification {
    let normalized = network::normalize_host(host);
    let url_host = url.map(network::url_host);
    let mut c = Classification::new(format!(
        "network:{}",
        normalized.clone().unwrap_or_else(|| clip(host.trim()))
    ));
    match (&normalized, &url_host) {
        (None, _) => {
            c.add(S::NetworkOther);
            c.opaque = true;
            c.note(format!("“{}” is not a plain host name.", clip(host)));
        }
        (Some(_), Some(None)) => {
            c.add(S::NetworkOther);
            c.opaque = true;
            c.note("KalCode couldn't read the host of the URL.");
        }
        (Some(h), Some(Some(from_url))) if h != from_url => {
            c.add(S::NetworkOther);
            c.opaque = true;
            c.note(format!("The URL goes to {from_url}, not {h}."));
        }
        (Some(h), _) => {
            if network::is_docs_host(h) {
                c.add(S::NetworkDocs);
            } else {
                c.add(S::NetworkOther);
            }
        }
    }
    if let Some(h) = &normalized {
        c.hosts.push(h.clone());
        c.subject = Some(h.clone());
        c.grant_coverage = format!("requests to {h}");
    } else {
        c.grant_coverage = "only this request".into();
    }
    if let Some(Some(from_url)) = &url_host
        && Some(from_url) != normalized.as_ref()
    {
        c.hosts.push(from_url.clone());
    }
    c.finish()
}

fn browser(action: &str, url: Option<&str>) -> Classification {
    let verb = action.trim().to_ascii_lowercase();
    let host = url.and_then(network::url_host);
    let mut c = Classification::new(format!(
        "browser:{verb}:{}",
        host.clone().unwrap_or_default()
    ));
    const NAVIGATE: &[&str] = &[
        "navigate",
        "goto",
        "go_to",
        "open",
        "visit",
        "load",
        "reload",
        "back",
        "forward",
        "screenshot",
        "snapshot",
        "read",
        "get_text",
        "text",
        "console",
        "wait",
        "scroll",
    ];
    if NAVIGATE.contains(&verb.as_str()) {
        c.add(S::BrowserNavigate);
    } else {
        c.add(S::BrowserInteract);
    }
    match verb.as_str() {
        "upload" | "file_upload" | "set_input_files" => {
            c.opaque = true;
            c.note("Uploading sends a file from this computer to the page.");
        }
        "download" => c.add(S::FilesystemWrite),
        "evaluate" | "eval" | "execute" | "run_script" => {
            c.note("The agent wants to run JavaScript inside the page.");
        }
        _ => {}
    }
    match (url, &host) {
        (Some(u), None) if !u.trim().is_empty() && !u.trim_start().starts_with("about:") => {
            c.add(S::NetworkOther);
            c.opaque = true;
            c.note("KalCode couldn't read the page's address.");
        }
        (_, Some(h)) if network::is_local_host(h) => {}
        (_, Some(h)) if network::is_docs_host(h) => c.add(S::NetworkDocs),
        (_, Some(_)) => c.add(S::NetworkOther),
        _ => {}
    }
    if let Some(h) = &host {
        c.hosts.push(h.clone());
    }
    c.subject = Some(
        format!("{verb} {}", host.clone().unwrap_or_default())
            .trim()
            .to_owned(),
    );
    c.grant_coverage = match &host {
        Some(h) => format!("only “{verb}” on {h}"),
        None => format!("only “{verb}”"),
    };
    c.finish()
}

fn deploy(target: &str) -> Classification {
    let target = clip(target.trim());
    let mut c = Classification::new(format!("deploy:{target}"));
    c.add(S::DeployProduction);
    c.note(format!("Deploys to {target}."));
    c.subject = Some(format!("deploy {target}"));
    c.grant_coverage = format!("only deploying to {target}");
    c.finish()
}

fn unknown_tool(tool: &str, summary: &str) -> Classification {
    let tool = clip(tool.trim());
    let mut c = Classification::new(format!(
        "tool:{tool}:{}",
        clip(&collapse_whitespace(summary))
    ));
    c.add(S::TerminalExecute);
    c.opaque = true;
    c.note(format!(
        "KalCode doesn't recognize the tool “{tool}”, so it treats it as able to run code."
    ));
    c.subject = Some(tool.clone());
    c.grant_coverage = "only this request".into();
    c.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ws() -> (tempfile::TempDir, Workspace) {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir_all(dir.path().join("src")).expect("mkdir");
        let ws = Workspace::new(Some(dir.path()));
        (dir, ws)
    }

    #[test]
    fn file_writes_inside_share_a_fingerprint_and_outside_is_exact() {
        let (_dir, ws) = ws();
        let a = classify(
            &ActionKind::FileWrite {
                path: "src/a.rs".into(),
            },
            &ws,
        );
        let b = classify(
            &ActionKind::FileWrite {
                path: "src/b.rs".into(),
            },
            &ws,
        );
        assert_eq!(a.fingerprint, b.fingerprint);
        assert_eq!(a.scopes, vec![S::FilesystemWrite]);
        let out = classify(
            &ActionKind::FileWrite {
                path: "../x".into(),
            },
            &ws,
        );
        assert_ne!(out.fingerprint, a.fingerprint);
        assert!(out.scopes.contains(&S::FilesystemOutsideWorkspace));
    }

    #[test]
    fn deleting_a_folder_is_destructive() {
        let (_dir, ws) = ws();
        let c = classify(&ActionKind::FileDelete { path: "src".into() }, &ws);
        assert!(c.scopes.contains(&S::Destructive));
        let root = classify(&ActionKind::FileDelete { path: ".".into() }, &ws);
        assert!(root.scopes.contains(&S::Destructive));
    }

    #[test]
    fn git_operations_map_to_scopes() {
        let push = classify(
            &ActionKind::Git {
                operation: GitOperation::Push,
                remote: Some("origin".into()),
            },
            &Workspace::none(),
        );
        assert!(push.scopes.contains(&S::GitPush));
        let reset = classify(
            &ActionKind::Git {
                operation: GitOperation::Reset,
                remote: None,
            },
            &Workspace::none(),
        );
        assert!(reset.scopes.contains(&S::Destructive));
        let other = classify(
            &ActionKind::Git {
                operation: GitOperation::Other,
                remote: None,
            },
            &Workspace::none(),
        );
        assert!(other.opaque);
    }

    #[test]
    fn network_requests_check_url_consistency() {
        let docs = classify(
            &ActionKind::Network {
                host: "docs.rs".into(),
                url: Some("https://docs.rs/x".into()),
            },
            &Workspace::none(),
        );
        assert_eq!(docs.scopes, vec![S::NetworkDocs]);
        let lie = classify(
            &ActionKind::Network {
                host: "docs.rs".into(),
                url: Some("https://docs.rs@evil.example/".into()),
            },
            &Workspace::none(),
        );
        assert!(lie.opaque);
        assert!(lie.scopes.contains(&S::NetworkOther));
        let bad = classify(
            &ActionKind::Network {
                host: "docs.rs/../evil".into(),
                url: None,
            },
            &Workspace::none(),
        );
        assert!(bad.opaque);
    }

    #[test]
    fn unknown_tools_are_opaque() {
        let c = classify(
            &ActionKind::Tool {
                tool: "mcp__x__y".into(),
                input_summary: "z".into(),
            },
            &Workspace::none(),
        );
        assert!(c.opaque && c.sensitive);
        assert_eq!(c.scopes, vec![S::TerminalExecute]);
    }

    #[test]
    fn deploy_is_production() {
        let c = classify(
            &ActionKind::Deploy {
                target: "staging".into(),
            },
            &Workspace::none(),
        );
        assert_eq!(c.scopes, vec![S::DeployProduction]);
    }
}
