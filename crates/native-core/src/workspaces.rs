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
pub use kalcode_pty::TerminalSize;
use kalcode_pty::{AttachId, ExitInfo, PtySession, ShellInfo, SpawnSpec};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::error::{ErrorCategory, KalError, Result};
use crate::events::{Correlation, EventEnvelope, EventPayload, EventSource, EventStore, NewEvent};
use crate::runtime::{Core, display_path};
use crate::time::now_rfc3339;

/// Upper bound on terminal tabs per workspace, to contain runaway creation.
pub const MAX_TERMINALS_PER_WORKSPACE: usize = 12;
/// Upper bound on a single input write from the WebView.
pub const MAX_WRITE_BYTES: usize = 64 * 1024;
/// Longest shell id accepted over IPC (real ids are short words like `pwsh`).
const MAX_SHELL_ID_LEN: usize = 32;
/// How long closing a tab waits for its shell to end before forgetting the tab anyway.
const CLOSE_TIMEOUT: Duration = Duration::from_secs(5);
const META_ACTIVE_WORKSPACE: &str = "active_workspace_id";

/// Variables never passed to a user's shell: KalCode's own settings and test hooks.
const SHELL_ENV_REMOVE: &[&str] = &[
    "KALCODE_DATA_DIR",
    "KALCODE_E2E_PICK_FOLDER",
    "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
    "WEBVIEW2_BROWSER_EXECUTABLE_FOLDER",
    "WEBVIEW2_USER_DATA_FOLDER",
    "WEBVIEW2_RELEASE_CHANNEL_PREFERENCE",
    "WEBVIEW2_PIPE_FOR_SCRIPT_DEBUGGER",
    "WEBKIT_INSPECTOR_SERVER",
    "WEBKIT_INSPECTOR_HTTP_SERVER",
];

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
    /// The shell's display name.
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

struct Attachment {
    session: PtySession,
    attach: AttachId,
    terminal_id: String,
}

/// Live terminal sessions and the views attached to them.
#[derive(Default)]
pub struct TerminalRegistry {
    /// Terminal id → its current session (running, or exited and kept for its scrollback).
    sessions: Mutex<HashMap<String, PtySession>>,
    /// Tabs being closed by the user: terminal id → workspace id.
    closing: Mutex<HashMap<String, String>>,
    attachments: Mutex<HashMap<AttachmentId, Attachment>>,
    next_attachment: AtomicU64,
    shutting_down: AtomicBool,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl TerminalRegistry {
    fn session(&self, id: &str) -> Option<PtySession> {
        lock(&self.sessions).get(id).cloned()
    }

    fn status_of_open_tab(&self, id: &str) -> TerminalStatus {
        match self.session(id) {
            Some(session) if session.exit_info().is_none() => TerminalStatus::Running,
            // Exited, and the exit is being recorded right now.
            Some(_) => TerminalStatus::Exited,
            None => TerminalStatus::EndedByApp,
        }
    }

    /// Forgets a terminal's session and every view attached to it.
    fn forget(&self, terminal_id: &str) -> Option<PtySession> {
        lock(&self.attachments).retain(|_, a| a.terminal_id != terminal_id);
        lock(&self.sessions).remove(terminal_id)
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
        for (_, session) in sessions.drain() {
            let _ = session.kill();
        }
    }
}

fn not_found(what: &'static str) -> KalError {
    KalError::validation("not_found", format!("That {what} no longer exists."))
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
    Ok(strip_verbatim(canonical))
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
    let status = match (&ended_at, end_reason.as_deref()) {
        (None, _) => registry.status_of_open_tab(&id),
        (Some(_), Some("exited")) => TerminalStatus::Exited,
        (Some(_), _) => TerminalStatus::EndedByApp,
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
        exit_code: row.get(7)?,
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

    pub fn terminal(&self, id: &str) -> Result<TerminalInfo> {
        validate_id(id)?;
        self.terminal_in(&self.conn(), id)
    }

    /// Opens a new terminal tab in `workspace_id` running `shell_id` (or the default shell) in
    /// the workspace folder. Emits `shell.started`.
    pub fn create_terminal(
        self: &Arc<Self>,
        workspace_id: &str,
        shell_id: Option<&str>,
        size: TerminalSize,
    ) -> Result<TerminalInfo> {
        validate_id(workspace_id)?;
        if let Some(shell_id) = shell_id {
            validate_shell_id(shell_id)?;
        }
        let shell = self.shell(shell_id)?;
        let id = new_id();

        let mut conn = self.conn();
        let workspace =
            load_workspace(&conn, workspace_id)?.ok_or_else(|| not_found("workspace"))?;
        if !workspace.available {
            return Err(folder_missing());
        }
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM terminals WHERE workspace_id = ?1",
            [workspace_id],
            |r| r.get(0),
        )?;
        if usize::try_from(count).unwrap_or(usize::MAX) >= MAX_TERMINALS_PER_WORKSPACE {
            return Err(KalError::validation(
                "too_many_terminals",
                format!(
                    "A workspace can have up to {MAX_TERMINALS_PER_WORKSPACE} terminals. Close one to open another."
                ),
            ));
        }
        let tx = conn.transaction()?;
        let position: i64 = tx.query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM terminals WHERE workspace_id = ?1",
            [workspace_id],
            |r| r.get(0),
        )?;
        tx.execute(
            "INSERT INTO terminals (id, workspace_id, shell_id, title, position, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                id,
                workspace_id,
                shell.id,
                shell.name,
                position,
                now_rfc3339()
            ],
        )?;
        tx.execute(
            "UPDATE workspaces SET active_terminal_id = ?1 WHERE id = ?2",
            params![id, workspace_id],
        )?;
        let (session, envelope) =
            self.start_shell(&tx, &id, workspace_id, &workspace.root_path, &shell, size)?;
        if let Err(error) = tx.commit() {
            let _ = session.kill();
            return Err(error.into());
        }
        lock(&self.terminal_registry().sessions).insert(id.clone(), session);
        self.publish(&envelope);
        let info = self.terminal_in(&conn, &id)?;
        drop(conn);
        tracing::info!(event = "terminal.created", terminal_id = %id, shell = %shell.id);
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
        let workspace =
            load_workspace(&conn, &terminal.workspace_id)?.ok_or_else(|| not_found("workspace"))?;
        if !workspace.available {
            return Err(folder_missing());
        }
        let shell = self.shell(Some(&terminal.shell_id))?;
        let tx = conn.transaction()?;
        let (session, envelope) = self.start_shell(
            &tx,
            id,
            &terminal.workspace_id,
            &workspace.root_path,
            &shell,
            size,
        )?;
        if let Err(error) = tx.commit() {
            let _ = session.kill();
            return Err(error.into());
        }
        // The previous session (if kept for its scrollback) and its views are replaced.
        self.terminal_registry().forget(id);
        lock(&self.terminal_registry().sessions).insert(id.to_owned(), session);
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
        workspace_id: &str,
        root: &str,
        shell: &ShellInfo,
        size: TerminalSize,
    ) -> Result<(PtySession, EventEnvelope)> {
        let spec = SpawnSpec {
            program: shell.program.clone(),
            args: shell.args.clone(),
            cwd: PathBuf::from(root),
            env: vec![
                ("TERM".into(), "xterm-256color".into()),
                ("COLORTERM".into(), "truecolor".into()),
                ("TERM_PROGRAM".into(), "KalCode".into()),
                ("TERM_PROGRAM_VERSION".into(), self.app_info().version),
            ],
            env_remove: SHELL_ENV_REMOVE.iter().map(|v| (*v).to_owned()).collect(),
            size,
        };
        let weak: Weak<Core> = Arc::downgrade(self);
        let terminal_id = id.to_owned();
        let session = PtySession::spawn(spec, move |exit| {
            if let Some(core) = weak.upgrade() {
                core.on_terminal_exit(&terminal_id, exit);
            }
        })
        .map_err(terminal_error(
            "terminal_start_failed",
            "KalCode couldn't start that shell.",
        ))?;
        let recorded = (|| {
            tx.execute(
                "UPDATE terminals SET started_at = ?1, ended_at = NULL, exit_code = NULL, end_reason = NULL
                 WHERE id = ?2",
                params![now_rfc3339(), id],
            )?;
            append(
                tx,
                workspace_id,
                EventPayload::ShellStarted {
                    terminal_id: id.to_owned(),
                    shell_id: shell.id.clone(),
                    shell_name: shell.name.clone(),
                },
            )
        })();
        match recorded {
            Ok(envelope) => Ok((session, envelope)),
            Err(error) => {
                let _ = session.kill();
                Err(error)
            }
        }
    }

    /// Records a shell's exit: `shell.completed` for exit code 0 or a tab the user closed,
    /// `shell.failed` otherwise. Runs on the session's exit-watcher thread.
    fn on_terminal_exit(&self, id: &str, exit: ExitInfo) {
        let registry = self.terminal_registry();
        if registry.shutting_down.load(Ordering::SeqCst) {
            return; // shutdown already recorded running tabs as ended by the app
        }
        let mut conn = self.conn();
        // Taken after the connection lock, so a close in progress has registered itself.
        let closing = lock(&registry.closing).remove(id);
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
                        tx.execute(
                            "UPDATE terminals SET ended_at = ?1, exit_code = ?2, end_reason = 'exited'
                             WHERE id = ?3",
                            params![now_rfc3339(), exit_code, id],
                        )?;
                        let event = if exit.success {
                            EventPayload::ShellCompleted {
                                terminal_id: id.to_owned(),
                                exit_code,
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

    /// Closes a tab: ends its shell — and, because the pseudo-terminal closes, programs started
    /// in it — then forgets the tab. A running shell's end is recorded as `shell.completed`
    /// with `closedByUser`.
    pub fn close_terminal(&self, id: &str) -> Result<()> {
        validate_id(id)?;
        let registry = self.terminal_registry();
        let conn = self.conn();
        let terminal = self.terminal_in(&conn, id)?;
        let session = registry.session(id);
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
            delete_terminal_row(&conn, id)?;
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
            // The shell did not report its exit in time. Forget the tab now; the recorder
            // still records the event when the exit arrives.
            tracing::warn!(event = "terminal.close_timeout", terminal_id = %id);
            delete_terminal_row(&self.conn(), id)?;
        }
        registry.forget(id);
        Ok(())
    }

    /// Sends input to a running shell.
    pub fn write_terminal(&self, id: &str, data: &[u8]) -> Result<()> {
        validate_id(id)?;
        if data.len() > MAX_WRITE_BYTES {
            return Err(KalError::validation(
                "input_too_large",
                "That input is too large to send to the terminal.",
            ));
        }
        let session = self
            .terminal_registry()
            .session(id)
            .ok_or_else(|| not_running())?;
        session.write(data).map_err(|e| match e {
            kalcode_pty::PtyError::Exited => not_running(),
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
    /// live output. Returns `None` when the tab has no session (it ended before KalCode last
    /// started), so there is nothing to show.
    pub fn attach_terminal(
        &self,
        id: &str,
        listener: impl Fn(&[u8]) -> bool + Send + Sync + 'static,
    ) -> Result<Option<AttachmentId>> {
        validate_id(id)?;
        let conn = self.conn();
        self.terminal_in(&conn, id)?; // the tab must exist
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
        drop(conn);
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
        let sessions: Vec<PtySession> = lock(&registry.sessions).drain().map(|(_, s)| s).collect();
        for session in sessions {
            let _ = session.kill();
        }
    }
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

#[cfg(test)]
mod tests {
    use super::*;

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
    fn folder_names_fall_back_to_the_path() {
        assert_eq!(folder_name(Path::new("/home/me/site")), "site");
        assert_eq!(folder_name(Path::new("/")), "/");
    }
}
