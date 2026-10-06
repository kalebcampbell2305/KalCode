//! Workspaces (project folders) and their terminal tabs.
//!
//! A workspace is a folder the user chose through the native folder picker; the WebView never
//! supplies paths. Terminals run detected shells, by id, in the workspace folder. Tab metadata is
//! persisted so tabs survive a restart; processes cannot, so restored tabs come back as ended
//! with a Restart action. Terminal output is never stored in the database or the event log — it
//! lives in each session's bounded scrollback and streams to attached views.
//!
//! Consistency rules:
//! - Every mutation and its lifecycle event commit in one transaction, and the event is published
//!   while the connection lock is still held, so subscribers observe events in `seq` order.
//! - Starting a shell happens under the connection lock: the tab row, the process and the
//!   `shell.started` event appear together, and an exit racing the start is recorded after it.
//! - Lock order is always connection → terminal registry maps, never the reverse.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};
use std::time::{Duration, Instant};

use kalcode_contracts::ids::{is_valid_id, new_id};
use kalcode_pty::{AttachId, ExitInfo, PtySession, ShellInfo, SpawnSpec};
pub use kalcode_pty::{PtyGuardian, TerminalSize};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::error::{ErrorCategory, KalError, Result};
use crate::events::{Correlation, EventEnvelope, EventPayload, EventSource, EventStore, NewEvent};
use crate::plans::Limited;
use crate::runtime::{Core, display_path};
use crate::time::now_rfc3339;

/// A plan's cap on open terminals across all of KalCode, or on workspaces. Callers derive it
/// from the signed-in account's verified plan (`plans::PlanTier::limit`); `None` means KalCode
/// imposes no numeric cap.
pub use crate::plans::PlanLimit;
/// Upper bound on a single input write from the WebView.
pub const MAX_WRITE_BYTES: usize = 64 * 1024;
/// Longest shell id accepted over IPC (real ids are short words like `pwsh`).
const MAX_SHELL_ID_LEN: usize = 32;
/// Marker persisted in `terminals.shell_id` for terminals whose lifecycle belongs to Operations.
/// It deliberately is not a valid ordinary shell id, so the generic terminal restart path cannot
/// turn an operation command into an unrelated interactive shell.
const OPERATION_SHELL_PREFIX: &str = "operation:";
/// Owner-authored commands are bounded before they reach a shell argv.
const MAX_OPERATION_COMMAND_BYTES: usize = 64 * 1024;
const TERMINAL_OUTPUT_TRUNCATED: &str = "[earlier terminal output truncated]\n";
/// How long closing a tab waits for its shell to end before forgetting the tab anyway.
const CLOSE_TIMEOUT: Duration = Duration::from_secs(5);
const META_ACTIVE_WORKSPACE: &str = "active_workspace_id";

/// Variable-name prefixes never passed to a user's shell (matched case-insensitively): KalCode's
/// own settings and every browser-runtime override (`WEBVIEW2_*`, `COREWEBVIEW2_*`,
/// `WEBKIT_INSPECTOR*`) that test builds may keep in KalCode's own environment.
const SHELL_ENV_REMOVE_PREFIXES: &[&str] =
    &["KALCODE_", "WEBVIEW2_", "COREWEBVIEW2_", "WEBKIT_INSPECTOR"];

/// Names from `names` that must not reach a user's shell.
fn shell_env_removals(names: impl IntoIterator<Item = String>) -> Vec<String> {
    names
        .into_iter()
        .filter(|key| {
            let upper = key.to_ascii_uppercase();
            SHELL_ENV_REMOVE_PREFIXES
                .iter()
                .any(|prefix| upper.starts_with(prefix))
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Workspace {
    pub id: String,
    /// The folder's name.
    pub name: String,
    /// Canonical absolute path, as chosen by the user.
    pub root_path: String,
    /// The path with the home folder shown as `~`.
    pub display_path: String,
    pub created_at: String,
    pub last_opened_at: String,
    /// The terminal tab in front when the workspace opens.
    pub active_terminal_id: Option<String>,
    /// False when the folder no longer exists (moved or deleted outside KalCode).
    pub available: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum TerminalStatus {
    Running,
    /// The shell exited on its own.
    Exited,
    /// KalCode closed (or crashed) while the shell was running.
    EndedByApp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TerminalInfo {
    pub id: String,
    pub workspace_id: String,
    /// Detected shell id this tab runs (see `ShellOption`).
    pub shell_id: String,
    /// The tab's name, initially the shell's display name.
    pub title: String,
    pub position: i64,
    pub status: TerminalStatus,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    pub exit_code: Option<i64>,
}

/// A shell the user can start. Its executable path never leaves native code.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ShellOption {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

/// Identifies one view's attachment to one terminal session. Unique for the life of the core,
/// so a stale id can never detach another view (or a restarted session's view).
pub type AttachmentId = u64;

/// PID and generation captured together from one live session registry entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TerminalSessionIdentity {
    pub generation: u64,
    pub pid: u32,
}

struct Attachment {
    session: PtySession,
    attach: AttachId,
    terminal_id: String,
}

/// Live terminal sessions and the views attached to them.
#[derive(Default)]
pub struct TerminalRegistry {
    /// Terminal id → its current session (running, or exited and kept for its scrollback) and
    /// the session's generation. A restarted tab gets a new generation, so a late exit report
    /// from the session it replaced is recognised and ignored.
    sessions: Mutex<HashMap<String, (u64, PtySession)>>,
    next_generation: AtomicU64,
    /// Tabs being closed by the user: terminal id → workspace id.
    closing: Mutex<HashMap<String, String>>,
    /// Operations sessions deliberately stopped while their tab and scrollback are retained.
    /// The generation prevents a late exit from changing the meaning of a replacement session.
    operation_stopping: Mutex<HashMap<String, u64>>,
    /// User-stopped ordinary shells retain their tabs and emit completion, not failure.
    user_stopping: Mutex<HashMap<String, u64>>,
    attachments: Mutex<HashMap<AttachmentId, Attachment>>,
    next_attachment: AtomicU64,
    shutting_down: AtomicBool,
    guardian_required: AtomicBool,
    guardian: Mutex<Option<Arc<dyn PtyGuardian>>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl TerminalRegistry {
    fn session(&self, id: &str) -> Option<PtySession> {
        lock(&self.sessions).get(id).map(|(_, s)| s.clone())
    }

    fn generation(&self, id: &str) -> Option<u64> {
        lock(&self.sessions).get(id).map(|(g, _)| *g)
    }

    fn register(&self, id: &str, generation: u64, session: PtySession) {
        lock(&self.sessions).insert(id.to_owned(), (generation, session));
    }

    /// Stops streaming a terminal to every view attached to it.
    fn detach_views(&self, terminal_id: &str) {
        let mut attachments = lock(&self.attachments);
        attachments.retain(|_, a| {
            let keep = a.terminal_id != terminal_id;
            if !keep {
                a.session.detach(a.attach);
            }
            keep
        });
    }

    fn status_of_open_tab(&self, id: &str) -> TerminalStatus {
        self.open_tab_state(id).0
    }

    /// Status and exit code of a tab whose row has no recorded end yet.
    ///
    /// A session that has exited while `on_terminal_exit` is still waiting to record it reports
    /// the status and exit code that record will hold, so no reader ever sees an exited terminal
    /// without its code.
    fn open_tab_state(&self, id: &str) -> (TerminalStatus, Option<i64>) {
        let Some((generation, session)) = lock(&self.sessions)
            .get(id)
            .map(|(generation, session)| (*generation, session.clone()))
        else {
            return (TerminalStatus::EndedByApp, None);
        };
        let Some(exit) = session.exit_info() else {
            return (TerminalStatus::Running, None);
        };
        // Mirrors `on_terminal_exit`: a deliberately stopped operation is recorded as ended by
        // the app, a user Stop as exited without a code (the kill's code is not the shell's
        // failure), any other exit as exited with its code.
        if lock(&self.user_stopping).get(id) == Some(&generation) {
            return (TerminalStatus::Exited, None);
        }
        let stopped = lock(&self.operation_stopping).get(id) == Some(&generation);
        let status = if stopped {
            TerminalStatus::EndedByApp
        } else {
            TerminalStatus::Exited
        };
        (status, Some(i64::from(exit.code)))
    }

    /// Forgets a terminal's session and every view attached to it.
    fn forget(&self, terminal_id: &str) -> Option<PtySession> {
        self.detach_views(terminal_id);
        lock(&self.sessions).remove(terminal_id).map(|(_, s)| s)
    }
}

impl Drop for TerminalRegistry {
    /// Shells never outlive the core, even when it is dropped without a clean shutdown.
    fn drop(&mut self) {
        self.shutting_down.store(true, Ordering::SeqCst);
        let sessions = self
            .sessions
            .get_mut()
            .unwrap_or_else(PoisonError::into_inner);
        for (_, (_, session)) in sessions.drain() {
            let _ = session.kill();
        }
    }
}

fn not_found(what: &'static str) -> KalError {
    KalError::validation("not_found", format!("That {what} no longer exists."))
}

fn terminal_guardian_unavailable() -> KalError {
    KalError::validation(
        "terminal_guardian_unavailable",
        "The terminal guardian is not ready. Wait for KalCode to finish recovering.",
    )
}

/// Ids crossing IPC must be canonical hyphenated UUIDs (`kalcode_contracts::ids`); anything
/// else is rejected before it reaches storage.
pub fn validate_id(id: &str) -> Result<()> {
    if is_valid_id(id) {
        Ok(())
    } else {
        Err(KalError::validation("invalid_id", "Invalid identifier."))
    }
}

fn validate_shell_id(id: &str) -> Result<()> {
    let ok = !id.is_empty()
        && id.len() <= MAX_SHELL_ID_LEN
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-');
    if ok {
        Ok(())
    } else {
        Err(KalError::validation("invalid_shell", "Invalid shell."))
    }
}

fn operation_shell(mut shell: ShellInfo, command: &str) -> Result<ShellInfo> {
    if command.trim().is_empty()
        || command.len() > MAX_OPERATION_COMMAND_BYTES
        || command.as_bytes().contains(&0)
    {
        return Err(KalError::validation(
            "invalid_operation_command",
            "The operation command must be non-empty and no larger than 64 KB.",
        ));
    }
    shell.args = match shell.id.as_str() {
        // Operations exit when their command finishes; interactive prompt integration and
        // -NoExit belong only to user shells.
        "pwsh" | "powershell" => vec![
            "-NoLogo".to_owned(),
            "-NoProfile".to_owned(),
            "-Command".to_owned(),
            command.to_owned(),
        ],
        "cmd" => vec![
            "/D".to_owned(),
            "/S".to_owned(),
            "/C".to_owned(),
            command.to_owned(),
        ],
        "git-bash" | "zsh" | "bash" | "fish" | "sh" => {
            vec!["-lc".to_owned(), command.to_owned()]
        }
        _ => {
            return Err(KalError::new(
                ErrorCategory::Terminal,
                "operation_shell_unavailable",
                "KalCode couldn't find a supported shell for that operation.",
            ));
        }
    };
    shell.id = format!("{OPERATION_SHELL_PREFIX}{}", shell.id);
    shell.name = format!("Operation · {}", shell.name);
    Ok(shell)
}

fn redacted_terminal_output(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    let redacted = crate::redact::redact_text(
        &text,
        crate::redact::secrets::ScanContext::default(),
        crate::redact::PlaceholderStyle::Labelled,
    )
    .text;
    if redacted.len() <= kalcode_pty::SCROLLBACK_BYTES {
        return redacted;
    }
    let tail_bytes = kalcode_pty::SCROLLBACK_BYTES - TERMINAL_OUTPUT_TRUNCATED.len();
    let mut start = redacted.len() - tail_bytes;
    while !redacted.is_char_boundary(start) {
        start += 1;
    }
    format!("{TERMINAL_OUTPUT_TRUNCATED}{}", &redacted[start..])
}

fn folder_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| path.display().to_string())
}

/// Canonicalizes and validates a chosen folder: it must exist and be a directory. Symlinks and
/// `..` are resolved, so one folder always maps to one workspace.
pub fn canonical_folder(path: &Path) -> Result<PathBuf> {
    let canonical = std::fs::canonicalize(path).map_err(|e| {
        KalError::new(
            ErrorCategory::Filesystem,
            "folder_not_found",
            "That folder doesn't exist or can't be opened.",
        )
        .with_source(e)
    })?;
    if !canonical.is_dir() {
        return Err(KalError::new(
            ErrorCategory::Filesystem,
            "not_a_folder",
            "Choose a folder, not a file.",
        ));
    }
    let root = strip_verbatim(canonical);
    refuse_broad_root(&root, home_folder().as_deref())?;
    Ok(root)
}

/// The user's home folder, canonicalized (plain form) when possible.
fn home_folder() -> Option<PathBuf> {
    let name = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    let home = std::env::var_os(name)
        .or_else(|| std::env::var_os("HOME"))
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())?;
    Some(std::fs::canonicalize(&home).map_or(home, strip_verbatim))
}

/// A workspace root gives agents and tools their working area, so it must be a project folder:
/// never a whole drive (or network share root) and never the home folder itself, which holds
/// credentials and every other project. Subfolders of either are fine.
fn refuse_broad_root(root: &Path, home: Option<&Path>) -> Result<()> {
    let root = strip_verbatim(root.to_path_buf());
    let is_drive_root = root.parent().is_none();
    let is_home = home.is_some_and(|home| same_path(&root, &strip_verbatim(home.to_path_buf())));
    if is_drive_root || is_home {
        return Err(KalError::validation(
            "folder_too_broad",
            "Choose a project folder, not a whole drive or your home folder.",
        ));
    }
    Ok(())
}

/// Component-wise path equality; case-insensitive on Windows, ignoring trailing separators.
fn same_path(a: &Path, b: &Path) -> bool {
    let key = |p: &Path| -> Vec<String> {
        p.components()
            .map(|c| {
                let text = c.as_os_str().to_string_lossy().into_owned();
                if cfg!(windows) {
                    text.to_lowercase()
                } else {
                    text
                }
            })
            .collect()
    };
    key(a) == key(b)
}

/// `std::fs::canonicalize` returns `\\?\C:\...` (or `\\?\UNC\server\share`) on Windows; shells
/// and people expect `C:\...` and `\\server\share`.
fn strip_verbatim(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    match text.strip_prefix(r"\\?\") {
        Some(rest) => PathBuf::from(rest),
        None => path,
    }
}

const WORKSPACE_COLUMNS: &str =
    "id, name, root_path, created_at, last_opened_at, active_terminal_id";

fn row_to_workspace(row: &rusqlite::Row<'_>) -> rusqlite::Result<Workspace> {
    let root: String = row.get(2)?;
    let path = PathBuf::from(&root);
    Ok(Workspace {
        id: row.get(0)?,
        name: row.get(1)?,
        display_path: display_path(&path),
        available: path.is_dir(),
        root_path: root,
        created_at: row.get(3)?,
        last_opened_at: row.get(4)?,
        active_terminal_id: row.get(5)?,
    })
}

fn load_workspace(conn: &Connection, id: &str) -> Result<Option<Workspace>> {
    Ok(conn
        .query_row(
            &format!("SELECT {WORKSPACE_COLUMNS} FROM workspaces WHERE id = ?1"),
            [id],
            row_to_workspace,
        )
        .optional()?)
}

const TERMINAL_COLUMNS: &str =
    "id, workspace_id, shell_id, title, position, started_at, ended_at, exit_code, end_reason";

fn row_to_terminal(
    row: &rusqlite::Row<'_>,
    registry: &TerminalRegistry,
) -> rusqlite::Result<TerminalInfo> {
    let id: String = row.get(0)?;
    let ended_at: Option<String> = row.get(6)?;
    let end_reason: Option<String> = row.get(8)?;
    let recorded_code: Option<i64> = row.get(7)?;
    let (status, exit_code) = match (&ended_at, end_reason.as_deref()) {
        (None, _) => registry.open_tab_state(&id),
        (Some(_), Some("exited")) => (TerminalStatus::Exited, recorded_code),
        (Some(_), _) => (TerminalStatus::EndedByApp, recorded_code),
    };
    Ok(TerminalInfo {
        id,
        workspace_id: row.get(1)?,
        shell_id: row.get(2)?,
        title: row.get(3)?,
        position: row.get(4)?,
        status,
        started_at: row.get(5)?,
        ended_at,
        exit_code,
    })
}

fn append(conn: &Connection, workspace_id: &str, event: EventPayload) -> Result<EventEnvelope> {
    EventStore::append(
        conn,
        NewEvent {
            source: EventSource::Core,
            correlation: Correlation {
                workspace_id: Some(workspace_id.to_owned()),
                ..Correlation::default()
            },
            event,
        },
    )
}

/// Deletes a tab row and clears it as its workspace's active tab.
fn delete_terminal_row(conn: &Connection, terminal_id: &str) -> Result<()> {
    conn.execute(
        "UPDATE workspaces SET active_terminal_id = NULL WHERE active_terminal_id = ?1",
        [terminal_id],
    )?;
    conn.execute("DELETE FROM terminals WHERE id = ?1", [terminal_id])?;
    Ok(())
}

fn terminal_error(
    code: &'static str,
    message: &'static str,
) -> impl FnOnce(kalcode_pty::PtyError) -> KalError {
    move |e| KalError::new(ErrorCategory::Terminal, code, message).with_source(e)
}

impl Core {
    // ---------- Workspaces ----------

    /// Workspaces, most recently opened first.
    pub fn workspaces(&self) -> Result<Vec<Workspace>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!(
            "SELECT {WORKSPACE_COLUMNS} FROM workspaces ORDER BY last_opened_at DESC, created_at DESC"
        ))?;
        let rows = stmt.query_map([], row_to_workspace)?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    pub fn active_workspace(&self) -> Result<Option<Workspace>> {
        let conn = self.conn();
        match crate::db::meta_get(&conn, META_ACTIVE_WORKSPACE)? {
            Some(id) => load_workspace(&conn, &id),
            None => Ok(None),
        }
    }

    /// Opens `folder` (chosen natively), creating its workspace on first use, and makes it the
    /// active workspace. Emits `workspace.created` or `workspace.opened`.
    pub fn open_workspace(&self, folder: &Path) -> Result<Workspace> {
        self.open_workspace_limited(folder, None)
    }

    /// Refuses adding a workspace when `limit` workspaces already exist. Reopening one never is.
    pub fn check_workspace_capacity(&self, limit: Option<PlanLimit>) -> Result<()> {
        let Some(limit) = limit else { return Ok(()) };
        admit_workspace(&self.conn(), limit)
    }

    /// [`Self::open_workspace`] under the plan's workspace cap: reopening an existing root is
    /// never refused; adding a new one is refused once `limit` workspaces exist.
    pub fn open_workspace_limited(
        &self,
        folder: &Path,
        limit: Option<PlanLimit>,
    ) -> Result<Workspace> {
        let root = canonical_folder(folder)?;
        let root_text = root.to_string_lossy().into_owned();
        let now = now_rfc3339();
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let existing: Option<String> = tx
            .query_row(
                "SELECT id FROM workspaces WHERE root_path = ?1",
                [&root_text],
                |r| r.get(0),
            )
            .optional()?;
        let (id, created) = match existing {
            Some(id) => {
                tx.execute(
                    "UPDATE workspaces SET last_opened_at = ?1 WHERE id = ?2",
                    params![now, id],
                )?;
                (id, false)
            }
            None => {
                if let Some(limit) = limit {
                    admit_workspace(&tx, limit)?;
                }
                let id = new_id();
                tx.execute(
                    "INSERT INTO workspaces (id, name, root_path, created_at, last_opened_at)
                     VALUES (?1, ?2, ?3, ?4, ?4)",
                    params![id, folder_name(&root), root_text, now],
                )?;
                (id, true)
            }
        };
        crate::db::meta_set(&tx, META_ACTIVE_WORKSPACE, &id)?;
        let workspace = load_workspace(&tx, &id)?.ok_or_else(|| not_found("workspace"))?;
        let name = workspace.name.clone();
        let event = if created {
            EventPayload::WorkspaceCreated {
                workspace_id: id.clone(),
                name,
            }
        } else {
            EventPayload::WorkspaceOpened {
                workspace_id: id.clone(),
                name,
            }
        };
        let envelope = append(&tx, &id, event)?;
        tx.commit()?;
        self.publish(&envelope);
        drop(conn);
        tracing::info!(event = "workspace.opened", workspace_id = %id, created);
        Ok(workspace)
    }

    /// Makes an existing workspace active. Emits `workspace.opened` unless it already was.
    pub fn activate_workspace(&self, id: &str) -> Result<Workspace> {
        validate_id(id)?;
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let already_active =
            crate::db::meta_get(&tx, META_ACTIVE_WORKSPACE)?.as_deref() == Some(id);
        let changed = tx.execute(
            "UPDATE workspaces SET last_opened_at = ?1 WHERE id = ?2",
            params![now_rfc3339(), id],
        )?;
        if changed == 0 {
            return Err(not_found("workspace"));
        }
        crate::db::meta_set(&tx, META_ACTIVE_WORKSPACE, id)?;
        let workspace = load_workspace(&tx, id)?.ok_or_else(|| not_found("workspace"))?;
        let envelope = if already_active {
            None
        } else {
            Some(append(
                &tx,
                id,
                EventPayload::WorkspaceOpened {
                    workspace_id: id.to_owned(),
                    name: workspace.name.clone(),
                },
            )?)
        };
        tx.commit()?;
        if let Some(envelope) = envelope {
            self.publish(&envelope);
        }
        Ok(workspace)
    }

    /// Removes a workspace from KalCode's list. The folder and its files are never touched.
    /// Refused while any of its terminals is running.
    pub fn remove_workspace(&self, id: &str) -> Result<()> {
        validate_id(id)?;
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let workspace = load_workspace(&tx, id)?.ok_or_else(|| not_found("workspace"))?;
        let terminal_ids: Vec<String> = {
            let mut stmt = tx.prepare("SELECT id FROM terminals WHERE workspace_id = ?1")?;
            let rows = stmt.query_map([id], |r| r.get(0))?;
            rows.collect::<std::result::Result<_, _>>()?
        };
        // Checked under the connection lock: a terminal cannot start while this runs.
        let running = terminal_ids
            .iter()
            .any(|t| self.terminal_registry().status_of_open_tab(t) == TerminalStatus::Running);
        if running {
            return Err(KalError::validation(
                "terminals_running",
                "Close this workspace's running terminals before removing it.",
            ));
        }
        tx.execute("DELETE FROM workspaces WHERE id = ?1", [id])?;
        // Per-workspace provider-account defaults belong to the workspace: remove them with it
        // so no binding dangles for an id that no longer exists (switch accounts).
        tx.execute(
            "DELETE FROM provider_account_bindings WHERE kind = 'workspace' AND scope_id = ?1",
            [id],
        )?;
        if crate::db::meta_get(&tx, META_ACTIVE_WORKSPACE)?.as_deref() == Some(id) {
            tx.execute(
                "DELETE FROM app_meta WHERE key = ?1",
                [META_ACTIVE_WORKSPACE],
            )?;
        }
        let envelope = append(
            &tx,
            id,
            EventPayload::WorkspaceRemoved {
                workspace_id: id.to_owned(),
                name: workspace.name,
            },
        )?;
        tx.commit()?;
        for terminal in &terminal_ids {
            self.terminal_registry().forget(terminal);
        }
        self.publish(&envelope);
        Ok(())
    }

    // ---------- Shells ----------

    /// Shells detected on this machine at startup, default first.
    pub fn shells(&self) -> Vec<ShellOption> {
        self.detected_shells()
            .iter()
            .map(|s| ShellOption {
                id: s.id.clone(),
                name: s.name.clone(),
                is_default: s.default,
            })
            .collect()
    }

    fn shell(&self, shell_id: Option<&str>) -> Result<ShellInfo> {
        let shells = self.detected_shells();
        let found = match shell_id {
            Some(id) => shells.iter().find(|s| s.id == id),
            None => shells.iter().find(|s| s.default).or(shells.first()),
        };
        found.cloned().ok_or_else(|| {
            KalError::new(
                ErrorCategory::Terminal,
                "shell_unavailable",
                "That shell isn't available on this computer.",
            )
        })
    }

    // ---------- Terminals ----------

    /// Terminal tabs of a workspace, in tab order.
    pub fn terminals(&self, workspace_id: &str) -> Result<Vec<TerminalInfo>> {
        validate_id(workspace_id)?;
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!(
            "SELECT {TERMINAL_COLUMNS} FROM terminals WHERE workspace_id = ?1 ORDER BY position, created_at"
        ))?;
        let registry = self.terminal_registry();
        let rows = stmt.query_map([workspace_id], |row| row_to_terminal(row, registry))?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    /// Running terminals across all workspaces, oldest first (Dashboard).
    pub fn running_terminals(&self) -> Result<Vec<TerminalInfo>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!(
            "SELECT {TERMINAL_COLUMNS} FROM terminals
             WHERE started_at IS NOT NULL AND ended_at IS NULL ORDER BY started_at"
        ))?;
        let registry = self.terminal_registry();
        let rows = stmt.query_map([], |row| row_to_terminal(row, registry))?;
        let all: Vec<TerminalInfo> = rows.collect::<std::result::Result<_, _>>()?;
        Ok(all
            .into_iter()
            .filter(|t| t.status == TerminalStatus::Running)
            .collect())
    }

    fn terminal_in(&self, conn: &Connection, id: &str) -> Result<TerminalInfo> {
        let registry = self.terminal_registry();
        conn.query_row(
            &format!("SELECT {TERMINAL_COLUMNS} FROM terminals WHERE id = ?1"),
            [id],
            |row| row_to_terminal(row, registry),
        )
        .optional()?
        .ok_or_else(|| not_found("terminal"))
    }

    /// Returns only a current running generation; malformed ids and exited sessions have no identity.
    pub fn terminal_session_identity(&self, id: &str) -> Option<TerminalSessionIdentity> {
        validate_id(id).ok()?;
        let sessions = lock(&self.terminal_registry().sessions);
        let (generation, session) = sessions.get(id)?;
        if session.exit_info().is_some() {
            return None;
        }
        Some(TerminalSessionIdentity {
            generation: *generation,
            pid: session.pid()?,
        })
    }

    pub fn terminal(&self, id: &str) -> Result<TerminalInfo> {
        validate_id(id)?;
        self.terminal_in(&self.conn(), id)
    }

    /// Renames one tab without replacing its running process or scrollback.
    pub fn rename_terminal(&self, id: &str, title: &str) -> Result<TerminalInfo> {
        validate_id(id)?;
        let title = title.trim();
        if title.is_empty() || title.chars().count() > 256 || title.chars().any(char::is_control) {
            return Err(KalError::validation(
                "invalid_terminal_title",
                "Use a terminal name of 1 to 256 characters without control characters.",
            ));
        }
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let mut terminal = self.terminal_in(&tx, id)?;
        if terminal.title == title {
            return Ok(terminal);
        }
        tx.execute(
            "UPDATE terminals SET title = ?1 WHERE id = ?2",
            params![title, id],
        )?;
        let envelope = append(
            &tx,
            &terminal.workspace_id,
            EventPayload::ShellRenamed {
                terminal_id: id.to_owned(),
                title: title.to_owned(),
            },
        )?;
        tx.commit()?;
        self.publish(&envelope);
        terminal.title = title.to_owned();
        Ok(terminal)
    }

    /// Stops the selected shell while retaining its tab, attachments and scrollback.
    pub fn stop_terminal(&self, id: &str) -> Result<TerminalInfo> {
        validate_id(id)?;
        let registry = self.terminal_registry();
        let conn = self.conn();
        let terminal = self.terminal_in(&conn, id)?;
        if terminal.shell_id.starts_with(OPERATION_SHELL_PREFIX) {
            return Err(KalError::validation(
                "terminal_operation_owned",
                "Stop this operation from Operations.",
            ));
        }
        let session = {
            let sessions = lock(&registry.sessions);
            let Some((generation, session)) = sessions.get(id) else {
                return Ok(terminal);
            };
            if session.exit_info().is_some() {
                return Ok(terminal);
            }
            lock(&registry.user_stopping).insert(id.to_owned(), *generation);
            session.clone()
        };
        // The connection lock fences restart until kill targets this exact retained session.
        if let Err(error) = session.kill() {
            lock(&registry.user_stopping).remove(id);
            return Err(terminal_error(
                "terminal_stop_failed",
                "KalCode couldn't stop that terminal.",
            )(error));
        }
        drop(conn);
        let deadline = Instant::now() + CLOSE_TIMEOUT;
        while session.exit_info().is_none() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(15));
        }
        if session.exit_info().is_none() {
            return Err(KalError::new(
                ErrorCategory::Terminal,
                "terminal_stop_unproven",
                "KalCode could not verify that the terminal stopped.",
            ));
        }
        self.terminal(id)
    }

    /// Opens a new terminal tab in `workspace_id` running `shell_id` (or the default shell) in
    /// the workspace folder, refusing it when `limit.max` terminals are already open across all
    /// workspaces. Existing tabs are never closed. Emits `shell.started`.
    pub fn create_terminal(
        self: &Arc<Self>,
        workspace_id: &str,
        shell_id: Option<&str>,
        size: TerminalSize,
        limit: Option<PlanLimit>,
    ) -> Result<TerminalInfo> {
        self.create_terminal_from(workspace_id, shell_id, size, limit, None)
    }

    /// Starts a fresh shell using only the source's launch context. No input, environment,
    /// scrollback, attachments or process handles are copied.
    pub fn duplicate_terminal(
        self: &Arc<Self>,
        source_id: &str,
        size: TerminalSize,
        limit: Option<PlanLimit>,
    ) -> Result<TerminalInfo> {
        let source = self.terminal(source_id)?;
        self.create_terminal_from(
            &source.workspace_id,
            Some(&source.shell_id),
            size,
            limit,
            Some(source_id),
        )
    }

    fn create_terminal_from(
        self: &Arc<Self>,
        workspace_id: &str,
        shell_id: Option<&str>,
        size: TerminalSize,
        limit: Option<PlanLimit>,
        source_id: Option<&str>,
    ) -> Result<TerminalInfo> {
        validate_id(workspace_id)?;
        if let Some(shell_id) = shell_id {
            validate_shell_id(shell_id)?;
        }
        let shell = self.shell(shell_id)?;
        let id = new_id();

        let mut conn = self.conn();
        let mut workspace =
            load_workspace(&conn, workspace_id)?.ok_or_else(|| not_found("workspace"))?;
        if !workspace.available {
            return Err(folder_missing());
        }
        if let Some(limit) = limit {
            admit_terminal(&conn, limit)?;
        }
        let title = if let Some(source_id) = source_id {
            let source = self.terminal_in(&conn, source_id)?;
            let session = self.terminal_registry().session(source_id);
            let cwd = if let Some(session) = session.filter(|s| s.exit_info().is_none()) {
                // Read only this shell's directory. Never inspect its environment or argv.
                let pid = session.pid().ok_or_else(duplicate_directory_unavailable)?;
                let mut system = sysinfo::System::new();
                let pid = sysinfo::Pid::from_u32(pid);
                system.refresh_processes_specifics(
                    sysinfo::ProcessesToUpdate::Some(&[pid]),
                    true,
                    sysinfo::ProcessRefreshKind::nothing().with_cwd(sysinfo::UpdateKind::Always),
                );
                let cwd = system
                    .process(pid)
                    .and_then(|p| p.cwd())
                    .map(PathBuf::from)
                    .ok_or_else(duplicate_directory_unavailable)?;
                if session.exit_info().is_some() {
                    return Err(duplicate_directory_unavailable());
                }
                cwd
            } else {
                let saved: Option<String> = conn.query_row(
                    "SELECT launch_cwd FROM terminals WHERE id = ?1",
                    [source_id],
                    |row| row.get(0),
                )?;
                PathBuf::from(saved.unwrap_or_else(|| workspace.root_path.clone()))
            };
            if !cwd.is_absolute() || !cwd.is_dir() {
                return Err(duplicate_directory_unavailable());
            }
            workspace.root_path = cwd.to_string_lossy().into_owned();
            format!(
                "{} (copy)",
                source.title.chars().take(249).collect::<String>()
            )
        } else {
            shell.name.clone()
        };
        let tx = conn.transaction()?;
        let position: i64 = tx.query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM terminals WHERE workspace_id = ?1",
            [workspace_id],
            |r| r.get(0),
        )?;
        tx.execute(
            "INSERT INTO terminals (id, workspace_id, shell_id, title, position, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, workspace_id, shell.id, title, position, now_rfc3339()],
        )?;
        tx.execute(
            "UPDATE workspaces SET active_terminal_id = ?1 WHERE id = ?2",
            params![id, workspace_id],
        )?;
        let (session, generation, envelope) =
            self.start_shell(&tx, &id, &workspace, &shell, None, size)?;
        if let Err(error) = tx.commit() {
            let _ = session.kill();
            return Err(error.into());
        }
        self.terminal_registry().register(&id, generation, session);
        self.publish(&envelope);
        let info = self.terminal_in(&conn, &id)?;
        drop(conn);
        tracing::info!(event = "terminal.created", terminal_id = %id, shell = %shell.id);
        Ok(info)
    }

    /// Starts an owner-authored Operations command in the workspace's detected default shell.
    ///
    /// `operation_id` is also the terminal id. That deterministic binding makes a launch retry
    /// idempotent and lets recovery find a process that started before its run row was linked. The
    /// command is passed as one native argv item to the detected shell; it is never concatenated
    /// into a host-side command line and is never persisted by the terminal subsystem. A new
    /// operation terminal counts toward the plan's `limit`, like any other tab.
    pub fn create_operation_terminal(
        self: &Arc<Self>,
        workspace_id: &str,
        operation_id: &str,
        command: &str,
        size: TerminalSize,
        limit: Option<PlanLimit>,
    ) -> Result<TerminalInfo> {
        self.create_operation_terminal_inner(workspace_id, operation_id, command, None, size, limit)
    }

    /// Starts an Operations command with one native-owned artifact-report handoff path.
    /// Arbitrary environment pairs are deliberately not accepted by this API.
    pub fn create_operation_terminal_with_artifact_report(
        self: &Arc<Self>,
        workspace_id: &str,
        operation_id: &str,
        command: &str,
        artifact_report: &Path,
        size: TerminalSize,
        limit: Option<PlanLimit>,
    ) -> Result<TerminalInfo> {
        let expected_name = format!("{operation_id}.json");
        let expected_directory = self
            .paths()
            .data_dir
            .join("operations")
            .join("artifact-reports");
        let report_directory = artifact_report.parent();
        let valid_directory = report_directory
            .and_then(|path| std::fs::canonicalize(path).ok())
            .zip(std::fs::canonicalize(expected_directory).ok())
            .is_some_and(|(actual, expected)| actual == expected);
        if !artifact_report.is_absolute()
            || artifact_report.file_name().and_then(|name| name.to_str())
                != Some(expected_name.as_str())
            || !valid_directory
        {
            return Err(KalError::validation(
                "invalid_operation_artifact_report",
                "The artifact report handoff path is invalid.",
            ));
        }
        self.create_operation_terminal_inner(
            workspace_id,
            operation_id,
            command,
            Some(artifact_report),
            size,
            limit,
        )
    }

    fn create_operation_terminal_inner(
        self: &Arc<Self>,
        workspace_id: &str,
        operation_id: &str,
        command: &str,
        artifact_report: Option<&Path>,
        size: TerminalSize,
        limit: Option<PlanLimit>,
    ) -> Result<TerminalInfo> {
        validate_id(workspace_id)?;
        validate_id(operation_id)?;
        let shell = operation_shell(self.shell(None)?, command)?;

        let mut conn = self.conn();
        let workspace =
            load_workspace(&conn, workspace_id)?.ok_or_else(|| not_found("workspace"))?;
        if !workspace.available {
            return Err(folder_missing());
        }

        let existing = conn
            .query_row(
                &format!("SELECT {TERMINAL_COLUMNS} FROM terminals WHERE id = ?1"),
                [operation_id],
                |row| row_to_terminal(row, self.terminal_registry()),
            )
            .optional()?;
        if let Some(existing) = &existing {
            if existing.workspace_id != workspace_id
                || !existing.shell_id.starts_with(OPERATION_SHELL_PREFIX)
            {
                return Err(KalError::validation(
                    "terminal_id_conflict",
                    "That operation identity already belongs to another terminal.",
                ));
            }
            if existing.status == TerminalStatus::Running {
                return Ok(existing.clone());
            }
        }
        // A finished operation terminal doesn't count as open (`admit_terminal`), so running it
        // again is admitted like a new one.
        if let Some(limit) = limit
            && existing
                .as_ref()
                .is_none_or(|existing| existing.ended_at.is_some())
        {
            admit_terminal(&conn, limit)?;
        }

        let tx = conn.transaction()?;
        if existing.is_some() {
            tx.execute(
                "UPDATE terminals SET shell_id = ?1, title = ?2 WHERE id = ?3",
                params![shell.id, shell.name, operation_id],
            )?;
        } else {
            let position: i64 = tx.query_row(
                "SELECT COALESCE(MAX(position), -1) + 1 FROM terminals WHERE workspace_id = ?1",
                [workspace_id],
                |row| row.get(0),
            )?;
            tx.execute(
                "INSERT INTO terminals (id, workspace_id, shell_id, title, position, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    operation_id,
                    workspace_id,
                    shell.id,
                    shell.name,
                    position,
                    now_rfc3339()
                ],
            )?;
        }
        let (session, generation, envelope) =
            self.start_shell(&tx, operation_id, &workspace, &shell, artifact_report, size)?;
        if let Err(error) = tx.commit() {
            let _ = session.kill();
            return Err(error.into());
        }

        // An exited session may still retain scrollback. Replace it only after the new process and
        // database start state committed, so a failed restart leaves the old evidence available.
        if let Some(previous) = self.terminal_registry().forget(operation_id) {
            let _ = previous.kill();
        }
        self.terminal_registry()
            .register(operation_id, generation, session);
        self.publish(&envelope);
        let info = self.terminal_in(&conn, operation_id)?;
        drop(conn);
        tracing::info!(
            event = "operation_terminal.started",
            terminal_id = %operation_id,
            workspace_id = %workspace_id
        );
        Ok(info)
    }

    /// Starts a fresh shell in an ended tab (same tab, same shell when still available).
    /// A running tab is returned unchanged.
    pub fn restart_terminal(
        self: &Arc<Self>,
        id: &str,
        size: TerminalSize,
    ) -> Result<TerminalInfo> {
        validate_id(id)?;
        let mut conn = self.conn();
        let terminal = self.terminal_in(&conn, id)?;
        if terminal.status == TerminalStatus::Running {
            return Ok(terminal);
        }
        let mut workspace =
            load_workspace(&conn, &terminal.workspace_id)?.ok_or_else(|| not_found("workspace"))?;
        let launch_cwd: Option<String> = conn.query_row(
            "SELECT launch_cwd FROM terminals WHERE id = ?1",
            [id],
            |row| row.get(0),
        )?;
        if let Some(cwd) = launch_cwd {
            workspace.root_path = cwd;
        }
        if !workspace.available {
            return Err(folder_missing());
        }
        // The PTY silently falls back to the home folder for a missing start folder; a command
        // meant for the saved folder must never run there instead.
        let start = Path::new(&workspace.root_path);
        if !start.is_absolute() || !start.is_dir() {
            return Err(duplicate_directory_unavailable());
        }
        let shell = self.shell(Some(&terminal.shell_id))?;
        let tx = conn.transaction()?;
        let (session, generation, envelope) =
            self.start_shell(&tx, id, &workspace, &shell, None, size)?;
        if let Err(error) = tx.commit() {
            let _ = session.kill();
            return Err(error.into());
        }
        // The previous session (kept for its scrollback) and its views are replaced. It has
        // exited, but its exit may not be recorded yet; ending it here is a no-op otherwise.
        if let Some(previous) = self.terminal_registry().forget(id) {
            let _ = previous.kill();
        }
        self.terminal_registry().register(id, generation, session);
        self.publish(&envelope);
        let info = self.terminal_in(&conn, id)?;
        drop(conn);
        tracing::info!(event = "terminal.restarted", terminal_id = %id);
        Ok(info)
    }

    /// Spawns the shell and records the start inside `tx`. The caller commits, registers the
    /// session and publishes the event while still holding the connection lock.
    fn start_shell(
        self: &Arc<Self>,
        tx: &Connection,
        id: &str,
        workspace: &Workspace,
        shell: &ShellInfo,
        artifact_report: Option<&Path>,
        size: TerminalSize,
    ) -> Result<(PtySession, u64, EventEnvelope)> {
        if self
            .terminal_registry()
            .shutting_down
            .load(Ordering::SeqCst)
        {
            return Err(KalError::validation(
                "runtime_draining",
                "KalCode is signing out or recovering. Wait before starting a terminal.",
            ));
        }
        let registry = self.terminal_registry();
        let guardian = registry
            .guardian
            .lock()
            .map_err(|_| terminal_guardian_unavailable())?
            .clone();
        if registry.guardian_required.load(Ordering::SeqCst) && guardian.is_none() {
            return Err(terminal_guardian_unavailable());
        }
        let env_remove =
            shell_env_removals(std::env::vars_os().filter_map(|(key, _)| key.into_string().ok()));
        let mut env = vec![
            ("TERM".into(), "xterm-256color".into()),
            ("COLORTERM".into(), "truecolor".into()),
            ("TERM_PROGRAM".into(), "KalCode".into()),
            ("TERM_PROGRAM_VERSION".into(), self.app_info().version),
        ];
        if let Some(path) = artifact_report {
            let value = path.to_str().ok_or_else(|| {
                KalError::validation(
                    "invalid_operation_artifact_report",
                    "The artifact report handoff path is invalid.",
                )
            })?;
            env.push((
                kalcode_contracts::operations::OPERATION_ARTIFACT_REPORT_ENV.into(),
                value.to_owned(),
            ));
        }
        let spec = SpawnSpec {
            program: shell.program.clone(),
            args: shell.args.clone(),
            cwd: PathBuf::from(&workspace.root_path),
            env,
            env_remove,
            size,
        };
        let weak: Weak<Core> = Arc::downgrade(self);
        let terminal_id = id.to_owned();
        let generation = self
            .terminal_registry()
            .next_generation
            .fetch_add(1, Ordering::Relaxed)
            + 1;
        let on_exit = move |exit| {
            if let Some(core) = weak.upgrade() {
                core.on_terminal_exit(&terminal_id, generation, exit);
            }
        };
        let session = match guardian {
            Some(guardian) => guardian
                .prepare("workspace-terminal")
                .and_then(|admission| PtySession::spawn_guarded(spec, admission, on_exit)),
            None => PtySession::spawn(spec, on_exit),
        }
        .map_err(terminal_error(
            "terminal_start_failed",
            "KalCode couldn't start that shell.",
        ))?;
        let recorded = (|| {
            tx.execute(
                "UPDATE terminals SET launch_cwd = ?1 WHERE id = ?2",
                params![workspace.root_path, id],
            )?;
            tx.execute(
                "UPDATE terminals SET started_at = ?1, ended_at = NULL, exit_code = NULL, end_reason = NULL
                 WHERE id = ?2",
                params![now_rfc3339(), id],
            )?;
            append(
                tx,
                &workspace.id,
                EventPayload::ShellStarted {
                    terminal_id: id.to_owned(),
                    shell_id: shell.id.clone(),
                    shell_name: shell.name.clone(),
                },
            )
        })();
        match recorded {
            Ok(envelope) => Ok((session, generation, envelope)),
            Err(error) => {
                let _ = session.kill();
                Err(error)
            }
        }
    }

    /// Records a shell's exit: `shell.completed` for exit code 0 or a user stop/close,
    /// `shell.failed` otherwise. Runs on the session's exit-watcher thread.
    pub(crate) fn on_terminal_exit(&self, id: &str, generation: u64, exit: ExitInfo) {
        let registry = self.terminal_registry();
        if registry.shutting_down.load(Ordering::SeqCst) {
            return; // shutdown already recorded running tabs as ended by the app
        }
        let mut conn = self.conn();
        // Checked under the connection lock, which restart holds while it replaces a session:
        // an exit from a session that was replaced must not end the tab's new shell.
        if registry
            .generation(id)
            .is_some_and(|current| current != generation)
        {
            tracing::debug!(event = "terminal.stale_exit_ignored", terminal_id = %id);
            return;
        }
        // Taken after the connection lock, so a close in progress has registered itself.
        let closing = lock(&registry.closing).remove(id);
        let operation_stopped = lock(&registry.operation_stopping)
            .remove(id)
            .is_some_and(|stopped_generation| stopped_generation == generation);
        let user_stopped = lock(&registry.user_stopping)
            .remove(id)
            .is_some_and(|stopped_generation| stopped_generation == generation);
        if closing.is_some() {
            // A tab closed by the user: its session is no longer needed.
            let mut sessions = lock(&registry.sessions);
            if sessions.get(id).is_some_and(|(g, _)| *g == generation) {
                sessions.remove(id);
            }
        }
        let result = (|| -> Result<Option<EventEnvelope>> {
            let tx = conn.transaction()?;
            let exit_code = i64::from(exit.code);
            let envelope = if let Some(workspace_id) = closing {
                delete_terminal_row(&tx, id)?;
                Some(append(
                    &tx,
                    &workspace_id,
                    EventPayload::ShellCompleted {
                        terminal_id: id.to_owned(),
                        exit_code,
                        closed_by_user: true,
                    },
                )?)
            } else {
                let workspace_id: Option<String> = tx
                    .query_row(
                        "SELECT workspace_id FROM terminals WHERE id = ?1 AND ended_at IS NULL",
                        [id],
                        |r| r.get(0),
                    )
                    .optional()?;
                match workspace_id {
                    // The tab was already forgotten (workspace removed); nothing to record.
                    None => None,
                    Some(workspace_id) => {
                        let end_reason = if operation_stopped {
                            "app_closed"
                        } else {
                            "exited"
                        };
                        // A user Stop ends the shell with the kill's code (1 on Windows, a
                        // signal code on Unix), which is not the shell's own failure.
                        let recorded_code = (!user_stopped).then_some(exit_code);
                        tx.execute(
                            "UPDATE terminals SET ended_at = ?1, exit_code = ?2, end_reason = ?3
                             WHERE id = ?4",
                            params![now_rfc3339(), recorded_code, end_reason, id],
                        )?;
                        let event = if exit.success || operation_stopped || user_stopped {
                            EventPayload::ShellCompleted {
                                terminal_id: id.to_owned(),
                                exit_code,
                                // A deliberate Stop retains the terminal for its scrollback;
                                // it is distinct from closing and removing the tab.
                                closed_by_user: false,
                            }
                        } else {
                            EventPayload::ShellFailed {
                                terminal_id: id.to_owned(),
                                exit_code,
                            }
                        };
                        Some(append(&tx, &workspace_id, event)?)
                    }
                }
            };
            tx.commit()?;
            Ok(envelope)
        })();
        match result {
            Ok(Some(envelope)) => self.publish(&envelope),
            Ok(None) => {}
            Err(error) => {
                tracing::error!(event = "terminal.exit_record_failed", error = %error.diagnostic());
            }
        }
        drop(conn);
        tracing::info!(event = "terminal.exited", terminal_id = %id, code = exit.code, killed = exit.killed);
    }

    /// Stops one Operations-owned session while retaining its tab and bounded scrollback.
    ///
    /// Holding the connection lock across generation validation and the kill prevents a restart
    /// from replacing the registry entry between those steps. The PTY killer owns the original
    /// child/job identity, so this never reopens a process by a reusable pid.
    pub fn stop_operation_terminal(
        &self,
        id: &str,
        expected_generation: Option<u64>,
    ) -> Result<()> {
        validate_id(id)?;
        let conn = self.conn();
        let terminal = self.terminal_in(&conn, id)?;
        if !terminal.shell_id.starts_with(OPERATION_SHELL_PREFIX) {
            return Err(KalError::validation(
                "terminal_not_operation_owned",
                "That terminal is not owned by an Operations run.",
            ));
        }
        let (generation, session) = {
            let sessions = lock(&self.terminal_registry().sessions);
            let Some((generation, session)) = sessions.get(id) else {
                return Ok(());
            };
            if expected_generation.is_some_and(|expected| expected != *generation) {
                return Err(KalError::validation(
                    "terminal_replaced",
                    "That operation terminal has restarted. Refresh Operations before stopping it.",
                ));
            }
            (*generation, session.clone())
        };
        if session.exit_info().is_some() {
            return Ok(());
        }
        lock(&self.terminal_registry().operation_stopping).insert(id.to_owned(), generation);
        if let Err(error) = session.kill() {
            lock(&self.terminal_registry().operation_stopping).remove(id);
            return Err(terminal_error(
                "operation_stop_failed",
                "KalCode couldn't stop that operation.",
            )(error));
        }
        let deadline = Instant::now() + CLOSE_TIMEOUT;
        while session.exit_info().is_none() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(15));
        }
        if session.exit_info().is_none() {
            return Err(KalError::new(
                ErrorCategory::Terminal,
                "operation_stop_unproven",
                "KalCode could not verify that the operation stopped.",
            ));
        }
        drop(conn);
        Ok(())
    }

    /// Sends Ctrl-C to the exact live generation of a terminal.
    ///
    /// The generation check prevents a stale caller from interrupting a replacement session, but
    /// Ctrl-C still targets that terminal's current foreground job rather than one observed
    /// descendant pid. Callers must therefore own or otherwise verify the foreground command.
    pub fn interrupt_terminal(&self, id: &str, expected_generation: u64) -> Result<()> {
        validate_id(id)?;
        let _conn = self.conn();
        let session = {
            let sessions = lock(&self.terminal_registry().sessions);
            let Some((generation, session)) = sessions.get(id) else {
                return Err(not_running());
            };
            if *generation != expected_generation {
                return Err(KalError::validation(
                    "terminal_replaced",
                    "That terminal has restarted. Refresh Operations before stopping its service.",
                ));
            }
            session.clone()
        };
        session.write(&[3]).map_err(|error| match error {
            kalcode_pty::PtyError::Exited => not_running(),
            kalcode_pty::PtyError::Busy => KalError::new(
                ErrorCategory::Terminal,
                "terminal_busy",
                "The terminal is busy. Try stopping the service again.",
            ),
            other => terminal_error(
                "terminal_interrupt_failed",
                "KalCode couldn't interrupt that terminal.",
            )(other),
        })
    }

    /// Returns one terminal's bounded in-memory scrollback with secret-shaped values redacted.
    /// Output is never persisted by this method and `None` means this app process has no retained
    /// session (for example, the terminal was restored after a restart).
    pub fn terminal_output(&self, id: &str) -> Result<Option<String>> {
        validate_id(id)?;
        let bytes = {
            // Serialize the replay snapshot with terminal replacement through the narrow session
            // registry lock. No database state is read and redaction runs after this lock drops.
            let sessions = lock(&self.terminal_registry().sessions);
            let Some((_, session)) = sessions.get(id) else {
                return Ok(None);
            };
            let output = Arc::new(Mutex::new(Vec::new()));
            let sink = Arc::clone(&output);
            let attachment = session.attach(move |bytes| {
                lock(&sink).extend_from_slice(bytes);
                false
            });
            session.detach(attachment);
            lock(&output).clone()
        };
        Ok(Some(redacted_terminal_output(&bytes)))
    }

    /// Closes a tab: ends its shell — and, because the pseudo-terminal closes, programs started
    /// in it — then forgets the tab. A running shell's end is recorded as `shell.completed`
    /// with `closedByUser`.
    pub fn close_terminal(&self, id: &str) -> Result<()> {
        self.close_terminal_checked(id, true)
    }

    /// Automatic Smart Close must not kill a shell restarted after the UI checked its state.
    pub fn close_terminal_if_ended(&self, id: &str) -> Result<()> {
        self.close_terminal_checked(id, false)
    }

    fn close_terminal_checked(&self, id: &str, allow_running: bool) -> Result<()> {
        validate_id(id)?;
        let registry = self.terminal_registry();
        let conn = self.conn();
        let terminal = self.terminal_in(&conn, id)?;
        let session = registry.session(id);
        // Restart also holds the connection lock: checking and deleting an ended tab is atomic
        // with respect to replacement. Only an explicit Stop and Close may terminate live work.
        if !allow_running && session.as_ref().is_some_and(|s| s.exit_info().is_none()) {
            return Err(KalError::validation(
                "terminal_still_running",
                "This terminal is running. Choose Keep Running or Stop and Close.",
            ));
        }
        let running = session.as_ref().is_some_and(|s| {
            let mut closing = lock(&registry.closing);
            // Checked under the `closing` lock that the exit recorder also takes, so either
            // the recorder sees this close or the exit happened first.
            let running = s.exit_info().is_none();
            if running {
                closing.insert(id.to_owned(), terminal.workspace_id.clone());
            }
            running
        });
        if !running {
            // Already ended (its exit is recorded, or it ended before this launch): no event.
            let mut conn = conn;
            let tx = conn.transaction()?;
            delete_terminal_row(&tx, id)?;
            tx.commit()?;
            drop(conn);
            registry.forget(id);
            return Ok(());
        }
        drop(conn);

        if let Some(session) = &session
            && let Err(error) = session.kill()
        {
            lock(&registry.closing).remove(id);
            return Err(KalError::new(
                ErrorCategory::Terminal,
                "terminal_close_failed",
                "KalCode couldn't stop that terminal.",
            )
            .with_source(error));
        }
        // The exit recorder deletes the row and records the event; wait for it.
        let deadline = Instant::now() + CLOSE_TIMEOUT;
        while lock(&registry.closing).contains_key(id) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(15));
        }
        if lock(&registry.closing).contains_key(id) {
            // Retain its visible record and attachment until termination is proved. The exit
            // recorder may still finish later; reporting success now would hide live work.
            tracing::warn!(event = "terminal.close_timeout", terminal_id = %id);
            return Err(KalError::new(
                ErrorCategory::Terminal,
                "terminal_close_unproven",
                "KalCode couldn't confirm that this terminal stopped. Try again.",
            )
            .retryable());
        }
        registry.forget(id);
        Ok(())
    }

    /// Sends input to a running shell.
    pub fn write_terminal(&self, id: &str, data: &[u8]) -> Result<()> {
        self.write_terminal_for_generation(id, data, None)
    }

    /// A delayed paste is bound to the session that accepted its attachment. Looking up and
    /// cloning the exact session under the registry lock prevents a restart from redirecting it.
    pub fn write_terminal_for_generation(
        &self,
        id: &str,
        data: &[u8],
        expected_generation: Option<u64>,
    ) -> Result<()> {
        validate_id(id)?;
        if data.len() > MAX_WRITE_BYTES {
            return Err(KalError::validation(
                "input_too_large",
                "That input is too large to send to the terminal.",
            ));
        }
        let session = {
            let sessions = lock(&self.terminal_registry().sessions);
            let (generation, session) = sessions.get(id).ok_or_else(not_running)?;
            if expected_generation.is_some_and(|expected| expected != *generation) {
                return Err(KalError::validation(
                    "terminal_image_target_changed",
                    "This terminal restarted. Choose the image again.",
                ));
            }
            session.clone()
        };
        session.write(data).map_err(|e| match e {
            kalcode_pty::PtyError::Exited => not_running(),
            kalcode_pty::PtyError::Busy => KalError::new(
                ErrorCategory::Terminal,
                "terminal_busy",
                "The terminal isn't reading input right now. Try again in a moment.",
            )
            .retryable(),
            other => KalError::new(
                ErrorCategory::Terminal,
                "terminal_write_failed",
                "The terminal isn't accepting input.",
            )
            .with_source(other),
        })
    }

    /// Resizes a running shell's pseudo-terminal. Ended tabs have nothing to resize.
    pub fn resize_terminal(&self, id: &str, size: TerminalSize) -> Result<()> {
        validate_id(id)?;
        let Some(session) = self.terminal_registry().session(id) else {
            return Ok(());
        };
        match session.resize(size) {
            Ok(()) | Err(kalcode_pty::PtyError::Exited) => Ok(()),
            Err(error) => Err(KalError::new(
                ErrorCategory::Terminal,
                "terminal_resize_failed",
                "The terminal couldn't be resized.",
            )
            .with_source(error)),
        }
    }

    /// Streams a terminal's output to `listener`: first its scrollback (possibly empty), then
    /// live output. Returns `None` when the terminal has no session — the tab ended before
    /// KalCode last started, or does not exist — so there is nothing to show. Touches no
    /// storage, so the shell can serve it synchronously, in order with detaches.
    pub fn attach_terminal(
        &self,
        id: &str,
        listener: impl Fn(&[u8]) -> bool + Send + Sync + 'static,
    ) -> Result<Option<AttachmentId>> {
        validate_id(id)?;
        let registry = self.terminal_registry();
        let Some(session) = registry.session(id) else {
            return Ok(None);
        };
        let attachment = registry.next_attachment.fetch_add(1, Ordering::Relaxed) + 1;
        let attach = session.attach(listener);
        lock(&registry.attachments).insert(
            attachment,
            Attachment {
                session,
                attach,
                terminal_id: id.to_owned(),
            },
        );
        Ok(Some(attachment))
    }

    /// Stops streaming to an attachment. Returns false if it no longer exists.
    pub fn detach_terminal(&self, attachment: AttachmentId) -> bool {
        let removed = lock(&self.terminal_registry().attachments).remove(&attachment);
        removed.is_some_and(|a| {
            a.session.detach(a.attach);
            true
        })
    }

    /// Remembers which tab is in front for a workspace.
    pub fn set_active_terminal(&self, workspace_id: &str, terminal_id: &str) -> Result<()> {
        validate_id(workspace_id)?;
        validate_id(terminal_id)?;
        let changed = self.conn().execute(
            "UPDATE workspaces SET active_terminal_id = ?1 WHERE id = ?2
             AND EXISTS (SELECT 1 FROM terminals WHERE id = ?1 AND workspace_id = ?2)",
            params![terminal_id, workspace_id],
        )?;
        if changed == 0 {
            Err(not_found("terminal"))
        } else {
            Ok(())
        }
    }

    /// Seal terminal admission and stop sessions without deleting tabs or closing the core.
    /// Callers must revoke runtime command admission first. Failed sessions remain owned so
    /// retry can prove cleanup; a failed drain never enables a replacement session.
    pub fn drain_terminals_for_logout(&self) -> Result<()> {
        let registry = self.terminal_registry();
        let sessions: Vec<PtySession> = {
            let _conn = self.conn();
            registry.shutting_down.store(true, Ordering::SeqCst);
            lock(&registry.sessions)
                .values()
                .map(|(_, session)| session.clone())
                .collect()
        };
        let mut failed = false;
        for session in &sessions {
            failed |= session.kill().is_err();
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while sessions.iter().any(|session| session.exit_info().is_none()) {
            if std::time::Instant::now() >= deadline {
                failed = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        if failed {
            return Err(KalError::validation(
                "terminal_cleanup_unproven",
                "A terminal has not finished stopping. KalCode will keep new sessions blocked.",
            ));
        }
        mark_running_terminals_ended(&self.conn())?;
        lock(&registry.attachments).clear();
        // The sealed runtime bundle retains custody until its own guardian drain succeeds.
        // Core must release this epoch's owner after terminal exit so the next runtime can
        // acquire its recovery lock. Admission stays sealed and guardian-required.
        registry
            .guardian
            .lock()
            .map_err(|_| terminal_guardian_unavailable())?
            .take();
        Ok(())
    }

    /// Reopen admission only after the prior sessions have reported their verified exit.
    pub fn resume_terminals_after_logout(&self) -> Result<()> {
        let _conn = self.conn();
        let registry = self.terminal_registry();
        if registry.guardian_required.load(Ordering::SeqCst)
            && registry
                .guardian
                .lock()
                .map_err(|_| terminal_guardian_unavailable())?
                .is_none()
        {
            return Err(terminal_guardian_unavailable());
        }
        if registry.shutting_down.load(Ordering::SeqCst)
            && lock(&registry.sessions)
                .values()
                .any(|(_, session)| session.exit_info().is_none())
        {
            return Err(KalError::validation(
                "terminal_cleanup_unproven",
                "Previous terminals are still stopping.",
            ));
        }
        registry.shutting_down.store(false, Ordering::SeqCst);
        Ok(())
    }

    /// Desktop-only admission requirement is sticky for the lifetime of this Core.
    pub fn require_terminal_guardian(&self) -> Result<()> {
        let _conn = self.conn();
        let registry = self.terminal_registry();
        registry.guardian_required.store(true, Ordering::SeqCst);
        if lock(&registry.sessions)
            .values()
            .any(|(_, session)| session.exit_info().is_none())
        {
            registry.shutting_down.store(true, Ordering::SeqCst);
            return Err(KalError::validation(
                "terminal_cleanup_unproven",
                "Existing terminals must stop before guardian admission changes.",
            ));
        }
        Ok(())
    }

    /// Replaces the account epoch's terminal owner only after every previous root has exited.
    pub fn install_terminal_guardian(&self, guardian: Arc<dyn PtyGuardian>) -> Result<()> {
        let _conn = self.conn();
        let registry = self.terminal_registry();
        if lock(&registry.sessions)
            .values()
            .any(|(_, session)| session.exit_info().is_none())
        {
            return Err(KalError::validation(
                "terminal_cleanup_unproven",
                "Previous terminals are still stopping.",
            ));
        }
        registry.guardian_required.store(true, Ordering::SeqCst);
        *registry
            .guardian
            .lock()
            .map_err(|_| terminal_guardian_unavailable())? = Some(guardian);
        Ok(())
    }

    /// Ends every shell and records their tabs as ended by the app. Called from `shutdown`.
    pub(crate) fn stop_all_terminals(&self) {
        let registry = self.terminal_registry();
        registry.shutting_down.store(true, Ordering::SeqCst);
        match mark_running_terminals_ended(&self.conn()) {
            Ok(0) => {}
            Ok(count) => tracing::info!(event = "terminal.stopped_on_exit", count),
            Err(error) => {
                tracing::error!(event = "terminal.shutdown_record_failed", error = %error.diagnostic());
            }
        }
        lock(&registry.attachments).clear();
        let sessions: Vec<PtySession> = lock(&registry.sessions)
            .drain()
            .map(|(_, (_, s))| s)
            .collect();
        for session in sessions {
            let _ = session.kill();
        }
    }
}

/// Refuses one more terminal once `limit` are open across all workspaces. Closing a tab deletes
/// its row, so every row (shells, agents and Operations) is an open terminal, except a finished
/// Operations terminal: Operations keeps it only as the run's log, and it can't be restarted.
fn admit_terminal(conn: &Connection, limit: PlanLimit) -> Result<()> {
    debug_assert_eq!(limit.kind, Limited::OpenTerminals);
    let open: i64 = conn.query_row(
        "SELECT COUNT(*) FROM terminals
         WHERE NOT (substr(shell_id, 1, ?1) = ?2 AND ended_at IS NOT NULL)",
        params![OPERATION_SHELL_PREFIX.len() as i64, OPERATION_SHELL_PREFIX],
        |r| r.get(0),
    )?;
    limit.admit(open)
}

/// Refuses one more workspace once `limit` exist. Removing a workspace deletes its row.
fn admit_workspace(conn: &Connection, limit: PlanLimit) -> Result<()> {
    debug_assert_eq!(limit.kind, Limited::Workspaces);
    let added: i64 = conn.query_row("SELECT COUNT(*) FROM workspaces", [], |r| r.get(0))?;
    limit.admit(added)
}

fn folder_missing() -> KalError {
    KalError::new(
        ErrorCategory::Filesystem,
        "folder_not_found",
        "This workspace's folder no longer exists. It may have been moved or deleted.",
    )
}

fn not_running() -> KalError {
    KalError::new(
        ErrorCategory::Terminal,
        "terminal_not_running",
        "This terminal has ended. Restart it to continue.",
    )
}

/// Marks tabs whose shell was running as ended by the app: on clean shutdown, and at startup
/// for tabs left running by a crash. Returns how many tabs were marked.
pub(crate) fn mark_running_terminals_ended(conn: &Connection) -> Result<usize> {
    // Databases opened with an older migration set (upgrade tests) have no terminals yet.
    let has_terminals: bool = conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'terminals')",
        [],
        |r| r.get(0),
    )?;
    if !has_terminals {
        return Ok(0);
    }
    Ok(conn.execute(
        "UPDATE terminals SET ended_at = ?1, end_reason = 'app_closed'
         WHERE started_at IS NOT NULL AND ended_at IS NULL",
        [now_rfc3339()],
    )?)
}

fn duplicate_directory_unavailable() -> KalError {
    KalError::validation(
        "terminal_directory_unavailable",
        "KalCode couldn't read this terminal's working directory. Open a new terminal from the workspace instead.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flags::BuildChannel;
    use crate::runtime::{CoreConfig, Paths};

    #[test]
    fn terminal_output_bound_applies_after_lossy_utf8_and_redaction() {
        let invalid = vec![0xff; kalcode_pty::SCROLLBACK_BYTES];
        let output = redacted_terminal_output(&invalid);
        assert!(output.starts_with(TERMINAL_OUTPUT_TRUNCATED));
        assert!(output.len() <= kalcode_pty::SCROLLBACK_BYTES);
    }

    /// Switch accounts: a removed workspace takes its per-workspace account defaults with it,
    /// so no binding dangles for a workspace id that no longer exists.
    #[test]
    fn removing_a_workspace_deletes_only_its_account_bindings() {
        let data = tempfile::tempdir().expect("data");
        let (gone, kept) = (
            tempfile::tempdir().expect("gone"),
            tempfile::tempdir().expect("kept"),
        );
        let core = Core::open(CoreConfig {
            paths: Paths::new(data.path()),
            app_version: "0.1.0-test".into(),
            channel: BuildChannel::Development,
        })
        .expect("open");
        let gone = core.open_workspace(gone.path()).expect("gone workspace");
        let kept = core.open_workspace(kept.path()).expect("kept workspace");
        let account = new_id();
        let bindings = |conn: &Connection| -> Vec<(String, String)> {
            let mut stmt = conn
                .prepare(
                    "SELECT provider_id, scope_id FROM provider_account_bindings
                     ORDER BY provider_id, scope_id",
                )
                .expect("prepare");
            stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
                .expect("query")
                .collect::<std::result::Result<_, _>>()
                .expect("rows")
        };
        {
            let conn = core.conn();
            conn.execute(
                "INSERT INTO provider_accounts (
                   id, provider_id, display_name, authentication_state, is_default, created_at
                 ) VALUES (?1, 'gemini-cli', 'Gemini A', 'authenticated', 1, '2026-09-28T00:00:00Z')",
                [&account],
            )
            .expect("account");
            for scope in [&gone.id, &kept.id] {
                conn.execute(
                    "INSERT INTO provider_account_bindings (provider_id, kind, scope_id, account_id)
                     VALUES ('gemini-cli', 'workspace', ?1, ?2)",
                    [scope, &account],
                )
                .expect("binding");
            }
            // Same id as the removed workspace, but a different scope kind: never touched.
            conn.execute(
                "INSERT INTO provider_account_bindings (provider_id, kind, scope_id, account_id)
                 VALUES ('gemini-cli', 'agent', ?1, ?2)",
                [&gone.id, &account],
            )
            .expect("agent binding");
        }

        core.remove_workspace(&gone.id).expect("remove");
        let mut expected = vec![
            ("gemini-cli".to_owned(), gone.id.clone()),
            ("gemini-cli".to_owned(), kept.id.clone()),
        ];
        expected.sort();
        let remaining = bindings(&core.conn());
        assert_eq!(remaining.len(), 2);
        let kinds: Vec<String> = {
            let conn = core.conn();
            let mut stmt = conn
                .prepare("SELECT kind FROM provider_account_bindings WHERE scope_id = ?1")
                .expect("prepare");
            stmt.query_map([&gone.id], |r| r.get(0))
                .expect("query")
                .collect::<std::result::Result<_, _>>()
                .expect("rows")
        };
        assert_eq!(
            kinds,
            ["agent"],
            "only the removed workspace's own binding went"
        );
        assert_eq!(remaining, expected);
    }

    /// Regression: an exit report from a session that Restart replaced must not end the tab's
    /// new shell (it used to mark the new row exited and publish `shell.failed`).
    #[test]
    fn a_late_exit_from_a_replaced_session_is_ignored() {
        let data = tempfile::tempdir().expect("data");
        let project = tempfile::tempdir().expect("project");
        let core = Arc::new(
            Core::open(CoreConfig {
                paths: Paths::new(data.path()),
                app_version: "0.1.0-test".into(),
                channel: BuildChannel::Development,
            })
            .expect("open"),
        );
        let workspace = core.open_workspace(project.path()).expect("workspace");
        let shell = if cfg!(windows) { "cmd" } else { "sh" };
        let terminal = core
            .create_terminal(
                &workspace.id,
                Some(shell),
                TerminalSize::new(80, 24).expect("size"),
                None,
            )
            .expect("create");
        let first = core
            .terminal_registry()
            .generation(&terminal.id)
            .expect("generation");
        // The shell exits and its exit is recorded; then Restart replaces the session.
        core.write_terminal(&terminal.id, b"exit\r").expect("exit");
        let deadline = Instant::now() + Duration::from_secs(20);
        while core
            .terminal(&terminal.id)
            .expect("terminal")
            .ended_at
            .is_none()
        {
            assert!(Instant::now() < deadline, "shell did not exit");
            std::thread::sleep(Duration::from_millis(25));
        }
        let terminal = core
            .restart_terminal(&terminal.id, TerminalSize::new(80, 24).expect("size"))
            .expect("restart");
        assert_eq!(terminal.status, TerminalStatus::Running);
        let current = core
            .terminal_registry()
            .generation(&terminal.id)
            .expect("generation");
        assert_ne!(first, current);

        let published = Arc::new(Mutex::new(Vec::new()));
        let sink = published.clone();
        core.subscribe(move |e| {
            sink.lock().expect("lock").push(e.event.type_name());
            true
        });
        core.on_terminal_exit(
            &terminal.id,
            first,
            ExitInfo {
                code: 5,
                success: false,
                killed: false,
            },
        );
        let after = core.terminal(&terminal.id).expect("terminal");
        assert_eq!(after.status, TerminalStatus::Running);
        assert_eq!(after.ended_at, None);
        assert!(
            published.lock().expect("lock").is_empty(),
            "no event for a stale exit"
        );

        // The current session's own exit is still recorded.
        core.on_terminal_exit(
            &terminal.id,
            current,
            ExitInfo {
                code: 5,
                success: false,
                killed: false,
            },
        );
        assert!(
            core.terminal(&terminal.id)
                .expect("terminal")
                .ended_at
                .is_some()
        );
        assert_eq!(*published.lock().expect("lock"), vec!["shell.failed"]);
        core.shutdown();
    }

    #[test]
    fn ids_must_be_canonical_uuids() {
        assert!(validate_id("0192f3c4-0000-7000-8000-000000000000").is_ok());
        assert!(validate_id(&new_id()).is_ok());
        for bad in [
            "",
            "not-a-uuid",
            "0192f3c400007000800000000000000000000",
            "0192f3c4-0000-7000-8000-00000000000g",
            "0192f3c4-0000-7000-8000-0000000000000",
            "{0192f3c4-0000-7000-8000-00000000000}",
            "0192f3c4_0000_7000_8000_000000000000",
            "../../../../etc/passwd-00000000000000",
        ] {
            assert_eq!(validate_id(bad).expect_err(bad).code, "invalid_id", "{bad}");
        }
    }

    #[test]
    fn shell_ids_are_short_words() {
        assert!(validate_shell_id("git-bash").is_ok());
        assert!(validate_shell_id("pwsh").is_ok());
        assert!(validate_shell_id("").is_err());
        assert!(validate_shell_id("C:\\Windows\\System32\\cmd.exe").is_err());
        assert!(validate_shell_id(&"a".repeat(MAX_SHELL_ID_LEN + 1)).is_err());
    }

    #[test]
    fn verbatim_prefixes_are_removed() {
        assert_eq!(
            strip_verbatim(PathBuf::from(r"\\?\C:\Users\me\site")),
            PathBuf::from(r"C:\Users\me\site")
        );
        assert_eq!(
            strip_verbatim(PathBuf::from(r"\\?\UNC\server\share\x")),
            PathBuf::from(r"\\server\share\x")
        );
        assert_eq!(
            strip_verbatim(PathBuf::from("/home/me/site")),
            PathBuf::from("/home/me/site")
        );
    }

    #[test]
    fn shells_never_receive_kalcode_or_browser_runtime_variables() {
        let names = [
            "KALCODE_DATA_DIR",
            kalcode_contracts::operations::OPERATION_ARTIFACT_REPORT_ENV,
            "kalcode_e2e_pick_folder",
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
            "WEBVIEW2_SOME_FUTURE_OVERRIDE",
            "webview2_user_data_folder",
            "COREWEBVIEW2_MAX_INSTANCES",
            "WEBKIT_INSPECTOR_SERVER",
            "PATH",
            "HOME",
            "MY_WEBVIEW2_NOTES",
        ];
        let removed = shell_env_removals(names.iter().map(|n| (*n).to_owned()));
        assert_eq!(removed, &names[..8]);
    }

    #[test]
    fn drive_roots_and_the_home_folder_are_not_workspaces() {
        let broad = |root: &str, home: Option<&str>| {
            refuse_broad_root(Path::new(root), home.map(Path::new))
                .err()
                .map(|e| e.code)
        };
        if cfg!(windows) {
            let home = Some(r"C:\Users\me");
            for root in [
                r"C:\",
                r"\\?\C:\",
                r"D:\",
                r"\\server\share\",
                r"\\?\UNC\server\share\",
                r"C:\Users\me",
                r"c:\users\ME\",
                r"\\?\C:\Users\me",
            ] {
                assert_eq!(broad(root, home), Some("folder_too_broad"), "{root}");
            }
            for root in [
                r"C:\Users\me\site",
                r"C:\Users",
                r"D:\work",
                r"C:\Users\me2",
            ] {
                assert_eq!(broad(root, home), None, "{root}");
            }
            assert_eq!(
                broad(r"C:\Users\me", Some(r"\\?\C:\Users\me")),
                Some("folder_too_broad")
            );
        } else {
            let home = Some("/home/me");
            for root in ["/", "/home/me", "/home/me/"] {
                assert_eq!(broad(root, home), Some("folder_too_broad"), "{root}");
            }
            for root in ["/home/me/site", "/home", "/home/Me", "/home/me2"] {
                assert_eq!(broad(root, home), None, "{root}");
            }
        }
        // Without a known home folder only drive roots are refused.
        assert_eq!(
            broad(if cfg!(windows) { r"C:\" } else { "/" }, None),
            Some("folder_too_broad")
        );
    }

    #[test]
    fn folder_names_fall_back_to_the_path() {
        assert_eq!(folder_name(Path::new("/home/me/site")), "site");
        assert_eq!(folder_name(Path::new("/")), "/");
    }
}
