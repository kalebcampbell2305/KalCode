//! Workspaces (project folders) and their terminal tabs.
//!
//! A workspace is a folder the user chose natively; the WebView never supplies paths. Terminals
//! run detected shells in the workspace folder. Tab metadata is persisted so tabs survive a
//! restart; processes cannot, so restored tabs come back as ended with a Restart action.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError, Weak};

use kalcode_pty::{AttachId, ExitInfo, PtySession, ShellInfo, SpawnSpec, TerminalSize};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::error::{ErrorCategory, KalError, Result};
use crate::events::{Correlation, EventPayload, EventSource, NewEvent};
use crate::runtime::{Core, display_path};
use crate::time::now_rfc3339;

/// Upper bound on terminals per workspace, to contain runaway creation.
pub const MAX_TERMINALS_PER_WORKSPACE: usize = 12;
/// Upper bound on a single input write from the WebView.
pub const MAX_WRITE_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    /// Full path, for display to the user who chose it.
    pub root_path: String,
    /// The path with the home folder shown as `~`.
    pub display_path: String,
    pub created_at: String,
    pub last_opened_at: String,
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
    pub shell_id: String,
    pub title: String,
    pub position: i64,
    pub status: TerminalStatus,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    pub exit_code: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ShellOption {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

/// Live terminal sessions, keyed by terminal id.
#[derive(Default)]
pub struct TerminalRegistry {
    sessions: Mutex<HashMap<String, PtySession>>,
    shutting_down: std::sync::atomic::AtomicBool,
}

impl TerminalRegistry {
    fn sessions(&self) -> std::sync::MutexGuard<'_, HashMap<String, PtySession>> {
        self.sessions.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn get(&self, id: &str) -> Option<PtySession> {
        self.sessions().get(id).cloned()
    }

    fn is_running(&self, id: &str) -> bool {
        self.get(id).is_some_and(|s| s.exit_info().is_none())
    }
}

fn not_found(what: &'static str) -> KalError {
    KalError::validation("not_found", format!("That {what} no longer exists."))
}

/// Ids crossing IPC must look like UUIDs; anything else is rejected before touching storage.
pub fn validate_id(id: &str) -> Result<()> {
    let ok = id.len() == 36 && id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-');
    if ok { Ok(()) } else { Err(KalError::validation("invalid_id", "Invalid identifier.")) }
}

fn folder_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| path.display().to_string())
}

/// Canonicalizes and validates a chosen folder.
pub fn canonical_folder(path: &Path) -> Result<PathBuf> {
    let canonical = std::fs::canonicalize(path).map_err(|e| {
        KalError::new(ErrorCategory::Filesystem, "folder_not_found", "That folder doesn't exist or can't be opened.")
            .with_source(e)
    })?;
    if !canonical.is_dir() {
        return Err(KalError::new(ErrorCategory::Filesystem, "not_a_folder", "Choose a folder, not a file."));
    }
    Ok(strip_verbatim(canonical))
}

/// `std::fs::canonicalize` returns `\\?\C:\...` on Windows; shells and users expect `C:\...`.
fn strip_verbatim(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
        _ => path,
    }
}

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

const WORKSPACE_COLUMNS: &str = "id, name, root_path, created_at, last_opened_at, active_terminal_id";

pub(crate) fn load_workspace(conn: &Connection, id: &str) -> Result<Option<Workspace>> {
    Ok(conn
        .query_row(&format!("SELECT {WORKSPACE_COLUMNS} FROM workspaces WHERE id = ?1"), [id], row_to_workspace)
        .optional()?)
}

fn row_to_terminal(row: &rusqlite::Row<'_>, registry: &TerminalRegistry) -> rusqlite::Result<TerminalInfo> {
    let id: String = row.get(0)?;
    let ended_at: Option<String> = row.get(7)?;
    let end_reason: Option<String> = row.get(9)?;
    let status = if ended_at.is_none() && registry.is_running(&id) {
        TerminalStatus::Running
    } else if end_reason.as_deref() == Some("exited") {
        TerminalStatus::Exited
    } else {
        TerminalStatus::EndedByApp
    };
    Ok(TerminalInfo {
        id,
        workspace_id: row.get(1)?,
        shell_id: row.get(2)?,
        title: row.get(3)?,
        position: row.get(4)?,
        status,
        started_at: row.get(6)?,
        ended_at,
        exit_code: row.get(8)?,
    })
}

const TERMINAL_COLUMNS: &str =
    "id, workspace_id, shell_id, title, position, created_at, started_at, ended_at, exit_code, end_reason";

fn correlation(workspace_id: &str) -> Correlation {
    Correlation { workspace_id: Some(workspace_id.to_owned()), ..Default::default() }
}

impl Core {
    // ---------- Workspaces ----------

    /// Workspaces, most recently opened first.
    pub fn workspaces(&self) -> Result<Vec<Workspace>> {
        let conn = self.conn();
        let mut stmt =
            conn.prepare(&format!("SELECT {WORKSPACE_COLUMNS} FROM workspaces ORDER BY last_opened_at DESC"))?;
        let rows = stmt.query_map([], row_to_workspace)?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    pub fn active_workspace(&self) -> Result<Option<Workspace>> {
        let conn = self.conn();
        match crate::db::meta_get(&conn, "active_workspace_id")? {
            Some(id) => load_workspace(&conn, &id),
            None => Ok(None),
        }
    }

    /// Opens `folder` (chosen natively), creating its workspace on first use, and makes it active.
    pub fn open_workspace(&self, folder: &Path) -> Result<Workspace> {
        let root = canonical_folder(folder)?;
        let root_text = root.to_string_lossy().into_owned();
        let now = now_rfc3339();
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let existing: Option<String> =
            tx.query_row("SELECT id FROM workspaces WHERE root_path = ?1", [&root_text], |r| r.get(0)).optional()?;
        let (id, created) = match existing {
            Some(id) => {
                tx.execute("UPDATE workspaces SET last_opened_at = ?1 WHERE id = ?2", params![now, id])?;
                (id, false)
            }
            None => {
                let id = uuid::Uuid::now_v7().to_string();
                tx.execute(
                    "INSERT INTO workspaces (id, name, root_path, created_at, last_opened_at) VALUES (?1, ?2, ?3, ?4, ?4)",
                    params![id, folder_name(&root), root_text, now],
                )?;
                (id, true)
            }
        };
        crate::db::meta_set(&tx, "active_workspace_id", &id)?;
        let workspace = load_workspace(&tx, &id)?.ok_or_else(|| not_found("workspace"))?;
        let payload = if created {
            EventPayload::WorkspaceCreated { workspace_id: id.clone(), name: workspace.name.clone() }
        } else {
            EventPayload::WorkspaceOpened { workspace_id: id.clone(), name: workspace.name.clone() }
        };
        let envelope = crate::events::EventStore::append(
            &tx,
            NewEvent { source: EventSource::Core, correlation: correlation(&id), event: payload },
        )?;
        tx.commit()?;
        self.publish(&envelope);
        Ok(workspace)
    }

    /// Makes an existing workspace active.
    pub fn activate_workspace(&self, id: &str) -> Result<Workspace> {
        validate_id(id)?;
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let now = now_rfc3339();
        if tx.execute("UPDATE workspaces SET last_opened_at = ?1 WHERE id = ?2", params![now, id])? == 0 {
            return Err(not_found("workspace"));
        }
        crate::db::meta_set(&tx, "active_workspace_id", id)?;
        let workspace = load_workspace(&tx, id)?.ok_or_else(|| not_found("workspace"))?;
        let envelope = crate::events::EventStore::append(
            &tx,
            NewEvent {
                source: EventSource::Core,
                correlation: correlation(id),
                event: EventPayload::WorkspaceOpened { workspace_id: id.to_owned(), name: workspace.name.clone() },
            },
        )?;
        tx.commit()?;
        self.publish(&envelope);
        Ok(workspace)
    }

    /// Removes a workspace from KalCode's list. The folder and its files are never touched.
    pub fn remove_workspace(&self, id: &str) -> Result<()> {
        validate_id(id)?;
        let running = self.terminals(id)?.into_iter().any(|t| t.status == TerminalStatus::Running);
        if running {
            return Err(KalError::validation(
                "terminals_running",
                "Close this workspace's running terminals before removing it.",
            ));
        }
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let workspace = load_workspace(&tx, id)?.ok_or_else(|| not_found("workspace"))?;
        let terminal_ids: Vec<String> = {
            let mut stmt = tx.prepare("SELECT id FROM terminals WHERE workspace_id = ?1")?;
            let rows = stmt.query_map([id], |r| r.get(0))?;
            rows.collect::<std::result::Result<_, _>>()?
        };
        tx.execute("DELETE FROM workspaces WHERE id = ?1", [id])?;
        if crate::db::meta_get(&tx, "active_workspace_id")?.as_deref() == Some(id) {
            tx.execute("DELETE FROM app_meta WHERE key = 'active_workspace_id'", [])?;
        }
        let envelope = crate::events::EventStore::append(
            &tx,
            NewEvent {
                source: EventSource::Core,
                correlation: correlation(id),
                event: EventPayload::WorkspaceRemoved { workspace_id: id.to_owned(), name: workspace.name },
            },
        )?;
        tx.commit()?;
        drop(conn);
        let mut sessions = self.terminal_registry().sessions();
        for terminal in terminal_ids {
            sessions.remove(&terminal);
        }
        drop(sessions);
        self.publish(&envelope);
        Ok(())
    }

    // ---------- Shells ----------

    pub fn shells(&self) -> Vec<ShellOption> {
        self.detected_shells()
            .iter()
            .map(|s| ShellOption { id: s.id.clone(), name: s.name.clone(), is_default: s.default })
            .collect()
    }

    fn shell(&self, shell_id: Option<&str>) -> Result<ShellInfo> {
        let shells = self.detected_shells();
        let found = match shell_id {
            Some(id) => shells.iter().find(|s| s.id == id),
            None => shells.iter().find(|s| s.default).or(shells.first()),
        };
        found.cloned().ok_or_else(|| {
            KalError::new(ErrorCategory::Terminal, "shell_unavailable", "That shell isn't available on this computer.")
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

    /// Running terminals across all workspaces (Dashboard).
    pub fn running_terminals(&self) -> Result<Vec<TerminalInfo>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!(
            "SELECT {TERMINAL_COLUMNS} FROM terminals WHERE started_at IS NOT NULL AND ended_at IS NULL ORDER BY started_at"
        ))?;
        let registry = self.terminal_registry();
        let rows = stmt.query_map([], |row| row_to_terminal(row, registry))?;
        let all: Vec<TerminalInfo> = rows.collect::<std::result::Result<_, _>>()?;
        Ok(all.into_iter().filter(|t| t.status == TerminalStatus::Running).collect())
    }

    fn terminal(&self, id: &str) -> Result<TerminalInfo> {
        validate_id(id)?;
        let conn = self.conn();
        let registry = self.terminal_registry();
        conn.query_row(&format!("SELECT {TERMINAL_COLUMNS} FROM terminals WHERE id = ?1"), [id], |row| {
            row_to_terminal(row, registry)
        })
        .optional()?
        .ok_or_else(|| not_found("terminal"))
    }

    /// Opens a new terminal tab in `workspace_id` and starts its shell.
    pub fn create_terminal(self: &Arc<Self>, workspace_id: &str, shell_id: Option<&str>, size: TerminalSize) -> Result<TerminalInfo> {
        validate_id(workspace_id)?;
        let shell = self.shell(shell_id)?;
        let id = uuid::Uuid::now_v7().to_string();
        {
            let conn = self.conn();
            let workspace = load_workspace(&conn, workspace_id)?.ok_or_else(|| not_found("workspace"))?;
            if !workspace.available {
                return Err(KalError::new(
                    ErrorCategory::Filesystem,
                    "folder_not_found",
                    "This workspace's folder no longer exists. It may have been moved or deleted.",
                ));
            }
            let count: i64 =
                conn.query_row("SELECT COUNT(*) FROM terminals WHERE workspace_id = ?1", [workspace_id], |r| r.get(0))?;
            if count as usize >= MAX_TERMINALS_PER_WORKSPACE {
                return Err(KalError::validation(
                    "too_many_terminals",
                    format!("A workspace can have up to {MAX_TERMINALS_PER_WORKSPACE} terminals. Close one to open another."),
                ));
            }
            let position: i64 = conn.query_row(
                "SELECT COALESCE(MAX(position), -1) + 1 FROM terminals WHERE workspace_id = ?1",
                [workspace_id],
                |r| r.get(0),
            )?;
            conn.execute(
                "INSERT INTO terminals (id, workspace_id, shell_id, title, position, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![id, workspace_id, shell.id, shell.name, position, now_rfc3339()],
            )?;
            conn.execute("UPDATE workspaces SET active_terminal_id = ?1 WHERE id = ?2", params![id, workspace_id])?;
        }
        if let Err(error) = self.start_session(&id, workspace_id, &shell, size) {
            let _ = self.conn().execute("DELETE FROM terminals WHERE id = ?1", [&id]);
            return Err(error);
        }
        self.terminal(&id)
    }

    /// Starts a fresh shell in an ended tab.
    pub fn restart_terminal(self: &Arc<Self>, id: &str, size: TerminalSize) -> Result<TerminalInfo> {
        let terminal = self.terminal(id)?;
        if terminal.status == TerminalStatus::Running {
            return Ok(terminal);
        }
        let shell = self.shell(Some(&terminal.shell_id)).or_else(|_| self.shell(None))?;
        self.start_session(id, &terminal.workspace_id, &shell, size)?;
        self.terminal(id)
    }

    fn start_session(self: &Arc<Self>, id: &str, workspace_id: &str, shell: &ShellInfo, size: TerminalSize) -> Result<()> {
        let root = {
            let conn = self.conn();
            load_workspace(&conn, workspace_id)?.ok_or_else(|| not_found("workspace"))?.root_path
        };
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
            size,
        };
        let weak: Weak<Core> = Arc::downgrade(self);
        let terminal_id = id.to_owned();
        let session = PtySession::spawn(spec, move |exit| {
            if let Some(core) = weak.upgrade() {
                core.on_terminal_exit(&terminal_id, exit);
            }
        })
        .map_err(|e| {
            KalError::new(ErrorCategory::Terminal, "terminal_start_failed", "KalCode couldn't start that shell.")
                .with_source(e)
        })?;

        let mut conn = self.conn();
        let tx = conn.transaction()?;
        tx.execute(
            "UPDATE terminals SET started_at = ?1, ended_at = NULL, exit_code = NULL, end_reason = NULL WHERE id = ?2",
            params![now_rfc3339(), id],
        )?;
        let envelope = crate::events::EventStore::append(
            &tx,
            NewEvent {
                source: EventSource::Core,
                correlation: correlation(workspace_id),
                event: EventPayload::ShellStarted {
                    terminal_id: id.to_owned(),
                    shell_id: shell.id.clone(),
                    shell_name: shell.name.clone(),
                },
            },
        )?;
        tx.commit()?;
        drop(conn);
        if let Some(previous) = self.terminal_registry().sessions().insert(id.to_owned(), session) {
            let _ = previous.kill();
        }
        self.publish(&envelope);
        Ok(())
    }

    fn on_terminal_exit(&self, id: &str, exit: ExitInfo) {
        if self.terminal_registry().shutting_down.load(std::sync::atomic::Ordering::SeqCst) {
            return; // shutdown() already recorded these as ended by the app
        }
        let result = (|| -> Result<Option<crate::events::EventEnvelope>> {
            let mut conn = self.conn();
            let tx = conn.transaction()?;
            let workspace_id: Option<String> =
                tx.query_row("SELECT workspace_id FROM terminals WHERE id = ?1", [id], |r| r.get(0)).optional()?;
            let closed_by_user = workspace_id.is_none() || exit.killed;
            if let Some(workspace_id) = &workspace_id {
                tx.execute(
                    "UPDATE terminals SET ended_at = ?1, exit_code = ?2, end_reason = 'exited' WHERE id = ?3",
                    params![now_rfc3339(), i64::from(exit.code), id],
                )?;
                let payload = if exit.success || closed_by_user {
                    EventPayload::ShellCompleted { terminal_id: id.to_owned(), exit_code: i64::from(exit.code), closed_by_user }
                } else {
                    EventPayload::ShellFailed { terminal_id: id.to_owned(), exit_code: i64::from(exit.code) }
                };
                let envelope = crate::events::EventStore::append(
                    &tx,
                    NewEvent { source: EventSource::Core, correlation: correlation(workspace_id), event: payload },
                )?;
                tx.commit()?;
                return Ok(Some(envelope));
            }
            Ok(None)
        })();
        match result {
            Ok(Some(envelope)) => self.publish(&envelope),
            Ok(None) => {}
            Err(error) => tracing::error!(event = "terminal.exit_record_failed", error = %error.diagnostic()),
        }
    }

    /// Closes a tab: ends its shell (and programs started in it) and forgets the tab.
    pub fn close_terminal(&self, id: &str) -> Result<()> {
        let terminal = self.terminal(id)?;
        {
            let conn = self.conn();
            conn.execute("DELETE FROM terminals WHERE id = ?1", [id])?;
            conn.execute(
                "UPDATE workspaces SET active_terminal_id = NULL WHERE id = ?1 AND active_terminal_id = ?2",
                params![terminal.workspace_id, id],
            )?;
        }
        let session = self.terminal_registry().sessions().remove(id);
        if let Some(session) = session {
            session.kill().map_err(|e| {
                KalError::new(ErrorCategory::Terminal, "terminal_close_failed", "KalCode couldn't stop that terminal.")
                    .with_source(e)
            })?;
        }
        Ok(())
    }

    pub fn write_terminal(&self, id: &str, data: &[u8]) -> Result<()> {
        validate_id(id)?;
        if data.len() > MAX_WRITE_BYTES {
            return Err(KalError::validation("input_too_large", "That input is too large to send to the terminal."));
        }
        let session = self.terminal_registry().get(id).ok_or_else(|| not_found("terminal"))?;
        session.write(data).map_err(|e| {
            KalError::new(ErrorCategory::Terminal, "terminal_write_failed", "The terminal isn't accepting input.")
                .with_source(e)
        })
    }

    pub fn resize_terminal(&self, id: &str, cols: u16, rows: u16) -> Result<()> {
        validate_id(id)?;
        let size = TerminalSize::new(cols, rows)
            .map_err(|_| KalError::validation("invalid_size", "Invalid terminal size."))?;
        let Some(session) = self.terminal_registry().get(id) else {
            return Ok(()); // an ended tab has nothing to resize
        };
        if session.exit_info().is_some() {
            return Ok(());
        }
        session.resize(size).map_err(|e| {
            KalError::new(ErrorCategory::Terminal, "terminal_resize_failed", "The terminal couldn't be resized.")
                .with_source(e)
        })
    }

    /// Streams a terminal's output (scrollback first) to `listener`.
    pub fn attach_terminal(&self, id: &str, listener: impl Fn(&[u8]) -> bool + Send + Sync + 'static) -> Result<Option<AttachId>> {
        self.terminal(id)?; // validates and checks existence
        Ok(self.terminal_registry().get(id).map(|session| session.attach(listener)))
    }

    pub fn detach_terminal(&self, id: &str, attach: AttachId) {
        if let Some(session) = self.terminal_registry().get(id) {
            session.detach(attach);
        }
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
        if changed == 0 { Err(not_found("terminal")) } else { Ok(()) }
    }

    /// Ends every shell and records the tabs as ended by the app. Called from `shutdown`.
    pub(crate) fn stop_all_terminals(&self) {
        let registry = self.terminal_registry();
        registry.shutting_down.store(true, std::sync::atomic::Ordering::SeqCst);
        if let Err(error) = mark_running_terminals_ended(&self.conn()) {
            tracing::error!(event = "terminal.shutdown_record_failed", error = %error.diagnostic());
        }
        let sessions: Vec<PtySession> = registry.sessions().drain().map(|(_, s)| s).collect();
        for session in sessions {
            let _ = session.kill();
        }
    }

    pub(crate) fn terminal_registry(&self) -> &TerminalRegistry {
        &self.terminals
    }
}

/// Marks tabs whose shell was running as ended by the app (clean exit or crash recovery).
pub(crate) fn mark_running_terminals_ended(conn: &Connection) -> Result<usize> {
    Ok(conn.execute(
        "UPDATE terminals SET ended_at = ?1, end_reason = 'app_closed' WHERE started_at IS NOT NULL AND ended_at IS NULL",
        [now_rfc3339()],
    )?)
}
