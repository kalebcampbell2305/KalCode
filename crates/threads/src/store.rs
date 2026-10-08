//! SQL for the Z3 tables (`threads`, `thread_messages`, `tool_calls`, `thread_files`). Only
//! this module touches them; other campaigns read threads through [`crate::ThreadRuntime`].

use kalcode_contracts::agent::{FileChange, ProviderId};
use kalcode_contracts::ids::{is_valid_id, new_id};
use kalcode_contracts::permissions::PermissionMode;
use kalcode_contracts::threads::{MessageRole, ThreadMessage, ThreadStatus};
use kalcode_core::{KalError, Result};
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::types::{ToolCallRecord, ToolCallStatus};

/// snake_case wire name of a unit enum (`ThreadStatus::RunningTool` → `running_tool`).
pub fn enum_str<T: Serialize>(value: T) -> String {
    match serde_json::to_value(value) {
        Ok(serde_json::Value::String(s)) => s,
        _ => String::new(),
    }
}

fn parse_enum<T: DeserializeOwned>(index: usize, text: &str) -> rusqlite::Result<T> {
    serde_json::from_value(serde_json::Value::String(text.to_owned())).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(index, rusqlite::types::Type::Text, Box::new(e))
    })
}

pub fn thread_not_found() -> KalError {
    KalError::validation(
        "thread_not_found",
        "That thread doesn't exist. It may have been removed.",
    )
}

/// A persisted thread plus derived counts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThreadRow {
    pub id: String,
    pub name: String,
    pub provider_id: ProviderId,
    pub provider_name: String,
    pub model: Option<String>,
    pub active_model: Option<String>,
    pub effort: Option<String>,
    pub active_effort: Option<String>,
    pub provider_account_id: Option<String>,
    pub account_label: Option<String>,
    pub workspace_id: String,
    pub workspace_name: String,
    pub cwd: String,
    pub permission_mode: PermissionMode,
    pub status: ThreadStatus,
    pub current_activity: Option<String>,
    pub provider_session_id: Option<String>,
    pub created_at: String,
    pub last_activity_at: String,
    pub pending_approvals: u32,
    pub archived_at: Option<String>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub unread_messages: u32,
    pub files_changed: u32,
    pub permission_profile_id: Option<String>,
    /// The thread's own active Git worktree (`git_worktrees`, purpose `thread`), if any.
    pub worktree_id: Option<String>,
    /// That worktree's branch.
    pub worktree_branch: Option<String>,
    /// The thread was created with its own worktree (a `git_worktrees` row of any status names
    /// it). Such a thread never runs in the workspace folder.
    pub isolated: bool,
    /// A valid user message is durably marked for delivery on the next explicit resume.
    pub resume_has_pending_input: bool,
}

/// One durable user turn, bounded by the exact event-log sequence numbers that started and
/// completed it. Old imported messages can legitimately have no matching events; those turns
/// remain visible with unknown execution evidence instead of being assigned a guessed result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentTurnRecord {
    pub message_id: String,
    pub thread_id: String,
    pub workspace_id: String,
    pub created_at: String,
    pub started_event_seq: Option<i64>,
    pub next_started_event_seq: Option<i64>,
    pub completed_event_seq: Option<i64>,
    pub completed_at: Option<String>,
    pub ok: Option<bool>,
    pub interrupted: Option<bool>,
    pub has_later_turn: bool,
    /// The exact durable Operation whose interval covers this turn, if any. Only the first user
    /// turn in an Operation interval is covered, so later manual turns on the same thread remain
    /// independently visible in Runs history.
    pub operation_id: Option<String>,
    /// Provider/account binding recorded for the exact native session that ran this turn.
    pub observed_provider_id: Option<ProviderId>,
    pub observed_provider_account_id: Option<String>,
    pub observed_account_label: Option<String>,
    /// Last provider-confirmed model effective during this exact turn. This is derived from the
    /// durable runtime-identity event log and remains `None` when old history has no evidence.
    pub observed_model: Option<String>,
    /// Last provider-confirmed reasoning effort effective during this exact turn.
    pub observed_effort: Option<String>,
}

/// A tool call together with its canonical workspace ownership.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolCallHistoryRecord {
    pub workspace_id: String,
    pub call: ToolCallRecord,
    pub observed_provider_id: Option<ProviderId>,
    pub observed_provider_account_id: Option<String>,
    pub observed_account_label: Option<String>,
    pub observed_model: Option<String>,
    pub observed_effort: Option<String>,
}

const MAX_OBSERVED_HISTORY_PAGE: u32 = 200;

const THREAD_COLUMNS: &str =
    "t.id, t.name, t.provider_id, t.provider_name, t.model, t.provider_account_id, t.account_label,
    t.workspace_id, t.workspace_name, t.cwd, t.permission_mode, t.status, t.current_activity,
    t.provider_session_id, t.created_at, t.last_activity_at, t.pending_approvals, t.archived_at,
    t.error_code, t.error_message,
    (SELECT COUNT(*) FROM thread_messages m
       WHERE m.thread_id = t.id AND m.role = 'assistant' AND m.seq > t.last_read_seq),
    (SELECT COUNT(*) FROM thread_files f WHERE f.thread_id = t.id),
    t.permission_profile_id, t.effort, w.id, w.branch, w.status,
    EXISTS(
      SELECT 1 FROM app_meta a
      JOIN thread_messages pending
        ON pending.id = a.value AND pending.thread_id = t.id AND pending.role = 'user'
      WHERE a.key = 'thread.undelivered_message:' || t.id
    ), t.active_model, t.active_effort";

/// `threads t` with the thread's own Git worktree `w` (`git_worktrees`, purpose `thread`, owned
/// by the thread): the active one, else the newest. `NULL` columns for a thread without one.
const THREAD_FROM: &str = "threads t LEFT JOIN git_worktrees w ON w.id = (
    SELECT w2.id FROM git_worktrees w2
     WHERE w2.purpose = 'thread' AND w2.owner_ref = t.id
     ORDER BY (w2.status = 'active') DESC, w2.created_at DESC, w2.id DESC LIMIT 1)";

fn row_to_thread(row: &Row<'_>) -> rusqlite::Result<ThreadRow> {
    Ok(ThreadRow {
        id: row.get(0)?,
        name: row.get(1)?,
        provider_id: ProviderId::new(row.get::<_, String>(2)?),
        provider_name: row.get(3)?,
        model: row.get(4)?,
        active_model: row.get(28)?,
        provider_account_id: row.get(5)?,
        account_label: row.get(6)?,
        workspace_id: row.get(7)?,
        workspace_name: row.get(8)?,
        cwd: row.get(9)?,
        permission_mode: parse_enum(10, &row.get::<_, String>(10)?)?,
        status: parse_enum(11, &row.get::<_, String>(11)?)?,
        current_activity: row.get(12)?,
        provider_session_id: row.get(13)?,
        created_at: row.get(14)?,
        last_activity_at: row.get(15)?,
        pending_approvals: row.get(16)?,
        archived_at: row.get(17)?,
        error_code: row.get(18)?,
        error_message: row.get(19)?,
        unread_messages: row.get(20)?,
        files_changed: row.get(21)?,
        permission_profile_id: row.get(22)?,
        effort: row.get(23)?,
        active_effort: row.get(29)?,
        worktree_id: None,
        worktree_branch: None,
        isolated: false,
        resume_has_pending_input: row.get(27)?,
    })
    .and_then(|mut thread| {
        let id: Option<String> = row.get(24)?;
        let active = row.get::<_, Option<String>>(26)?.as_deref() == Some("active");
        thread.isolated = id.is_some();
        if active {
            thread.worktree_id = id;
            thread.worktree_branch = row.get(25)?;
        }
        Ok(thread)
    })
}

pub struct NewThreadRow<'a> {
    pub id: &'a str,
    pub name: &'a str,
    pub provider_id: &'a ProviderId,
    pub provider_name: &'a str,
    pub model: Option<&'a str>,
    pub effort: Option<&'a str>,
    pub provider_account_id: Option<&'a str>,
    pub account_label: Option<&'a str>,
    pub workspace_id: &'a str,
    pub workspace_name: &'a str,
    pub cwd: &'a str,
    pub permission_mode: PermissionMode,
    pub now: &'a str,
}

pub fn insert_thread(conn: &Connection, t: &NewThreadRow<'_>) -> Result<()> {
    conn.execute(
        "INSERT INTO threads (id, name, provider_id, provider_name, model, provider_account_id, account_label,
            workspace_id, workspace_name, cwd, permission_mode, status, created_at, last_activity_at, effort)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'starting', ?12, ?12, ?13)",
        params![
            t.id,
            t.name,
            t.provider_id.as_str(),
            t.provider_name,
            t.model,
            t.provider_account_id,
            t.account_label,
            t.workspace_id,
            t.workspace_name,
            t.cwd,
            enum_str(t.permission_mode),
            t.now,
            t.effort,
        ],
    )?;
    Ok(())
}

pub fn get(conn: &Connection, id: &str) -> Result<ThreadRow> {
    conn.query_row(
        &format!("SELECT {THREAD_COLUMNS} FROM {THREAD_FROM} WHERE t.id = ?1"),
        [id],
        row_to_thread,
    )
    .optional()?
    .ok_or_else(thread_not_found)
}

/// Most recently active first.
pub fn list(
    conn: &Connection,
    workspace_id: Option<&str>,
    include_archived: bool,
) -> Result<Vec<ThreadRow>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {THREAD_COLUMNS} FROM {THREAD_FROM}
         WHERE (?1 IS NULL OR t.workspace_id = ?1) AND (?2 OR t.archived_at IS NULL)
         ORDER BY t.last_activity_at DESC, t.id DESC LIMIT 2000"
    ))?;
    let rows = stmt.query_map(params![workspace_id, include_archived], row_to_thread)?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

pub fn status(conn: &Connection, id: &str) -> Result<ThreadStatus> {
    let text: String = conn
        .query_row("SELECT status FROM threads WHERE id = ?1", [id], |r| {
            r.get(0)
        })
        .optional()?
        .ok_or_else(thread_not_found)?;
    Ok(parse_enum(0, &text)?)
}

/// Sets status and activity; returns the previous status.
pub fn set_status(
    conn: &Connection,
    id: &str,
    to: ThreadStatus,
    activity: Option<&str>,
    now: &str,
) -> Result<ThreadStatus> {
    let from = status(conn, id)?;
    conn.execute(
        "UPDATE threads SET status = ?2, current_activity = ?3, last_activity_at = ?4 WHERE id = ?1",
        params![id, enum_str(to), activity, now],
    )?;
    Ok(from)
}

pub fn set_activity(conn: &Connection, id: &str, activity: Option<&str>, now: &str) -> Result<()> {
    conn.execute(
        "UPDATE threads SET current_activity = ?2, last_activity_at = ?3 WHERE id = ?1",
        params![id, activity, now],
    )?;
    Ok(())
}

pub fn touch(conn: &Connection, id: &str, now: &str) -> Result<()> {
    conn.execute(
        "UPDATE threads SET last_activity_at = ?2 WHERE id = ?1",
        params![id, now],
    )?;
    Ok(())
}

pub fn set_provider_session(
    conn: &Connection,
    id: &str,
    session_id: &str,
    model: Option<&str>,
    effort: Option<&str>,
) -> Result<()> {
    let changed = conn.execute(
        "UPDATE threads
         SET provider_session_id = ?2, active_model = ?3, active_effort = ?4
         WHERE id = ?1",
        params![id, session_id, model, effort],
    )?;
    if changed == 0 {
        return Err(thread_not_found());
    }
    Ok(())
}

/// A new provider process has not confirmed its runtime identity yet. Launch intent remains.
pub fn reset_active_identity(conn: &Connection, id: &str) -> Result<()> {
    let changed = conn.execute(
        "UPDATE threads SET active_model = NULL, active_effort = NULL WHERE id = ?1",
        [id],
    )?;
    if changed == 0 {
        return Err(thread_not_found());
    }
    Ok(())
}

/// Process restart invalidates identity on sessions that should still have had a live provider.
/// Terminal rows retain their last provider-observed identity as durable execution history.
pub fn reset_nonterminal_active_identities(conn: &Connection) -> Result<usize> {
    Ok(conn.execute(
        "UPDATE threads SET active_model = NULL, active_effort = NULL
         WHERE status NOT IN ('completed', 'failed', 'interrupted')
           AND (active_model IS NOT NULL OR active_effort IS NOT NULL)",
        [],
    )?)
}

/// Changes only the launch-time model and effort for an existing thread. Runtime callers hold
/// the thread authority lock and perform their all-target readiness check before this write.
pub fn set_launch_configuration(
    conn: &Connection,
    id: &str,
    model: &str,
    effort: &str,
) -> Result<()> {
    let changed = conn.execute(
        "UPDATE threads SET model = ?2, effort = ?3 WHERE id = ?1",
        params![id, model, effort],
    )?;
    if changed == 0 {
        return Err(thread_not_found());
    }
    Ok(())
}

/// Whether this thread has ever received or produced conversation content.
pub fn has_messages(conn: &Connection, id: &str) -> Result<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM thread_messages WHERE thread_id = ?1)",
        [id],
        |row| row.get(0),
    )?)
}

/// Rebinds a thread to another provider account: the account id and its owner-visible label
/// snapshot change, and the provider resume id is cleared in the same statement. Resume ids are
/// account-scoped (Claude `CLAUDE_CONFIG_DIR/projects`, Codex `CODEX_HOME/sessions`, Gemini
/// `GEMINI_CLI_HOME/.gemini/tmp` live in the old account's profile home), so keeping one would
/// make the next start fail under the new account or silently skip the new-session notice.
/// Messages, tool calls and files are untouched.
pub fn set_account(
    conn: &Connection,
    id: &str,
    provider_account_id: &str,
    account_label: Option<&str>,
) -> Result<()> {
    let changed = conn.execute(
        "UPDATE threads
         SET provider_account_id = ?2, account_label = ?3, provider_session_id = NULL,
             active_model = NULL, active_effort = NULL
         WHERE id = ?1",
        params![id, provider_account_id, account_label],
    )?;
    if changed == 0 {
        return Err(thread_not_found());
    }
    Ok(())
}

/// What the thread runtime may know about a provider account: its owner, label and whether it
/// was removed from KalCode. Never identity, authentication state or credentials.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountRef {
    pub provider_id: ProviderId,
    pub display_name: String,
    pub archived: bool,
}

/// Reads an account's owner, label and archive state (`None` when no such account exists).
pub fn account(conn: &Connection, id: &str) -> Result<Option<AccountRef>> {
    Ok(conn
        .query_row(
            "SELECT provider_id, display_name, archived_at IS NOT NULL
             FROM provider_accounts WHERE id = ?1",
            [id],
            |r| {
                Ok(AccountRef {
                    provider_id: ProviderId::new(r.get::<_, String>(0)?),
                    display_name: r.get(1)?,
                    archived: r.get(2)?,
                })
            },
        )
        .optional()?)
}

pub fn set_error(conn: &Connection, id: &str, error: Option<(&str, &str)>) -> Result<()> {
    conn.execute(
        "UPDATE threads SET error_code = ?2, error_message = ?3 WHERE id = ?1",
        params![id, error.map(|e| e.0), error.map(|e| e.1)],
    )?;
    Ok(())
}

pub fn set_pending_approvals(conn: &Connection, id: &str, count: usize) -> Result<()> {
    conn.execute(
        "UPDATE threads SET pending_approvals = ?2 WHERE id = ?1",
        params![id, i64::try_from(count).unwrap_or(i64::MAX)],
    )?;
    Ok(())
}

/// Copies history with new local ids and without provider-owned message identities.
pub fn copy_messages(conn: &Connection, source: &str, destination: &str) -> Result<()> {
    let mut stmt = conn.prepare(
        "SELECT role, content, created_at FROM thread_messages WHERE thread_id = ?1 ORDER BY seq",
    )?;
    let mut rows = stmt.query([source])?;
    while let Some(row) = rows.next()? {
        let role: String = row.get(0)?;
        let content: String = row.get(1)?;
        let created_at: String = row.get(2)?;
        conn.execute("INSERT INTO thread_messages (id, thread_id, role, content, created_at) VALUES (?1, ?2, ?3, ?4, ?5)", params![new_id(), destination, role, content, created_at])?;
    }
    conn.execute("UPDATE threads SET last_read_seq = (SELECT COALESCE(MAX(seq), 0) FROM thread_messages WHERE thread_id = ?1) WHERE id = ?1", [destination])?;
    Ok(())
}

pub fn move_to_workspace(
    conn: &Connection,
    id: &str,
    workspace_id: &str,
    workspace_name: &str,
    cwd: &str,
    now: &str,
) -> Result<()> {
    conn.execute("UPDATE threads SET workspace_id = ?2, workspace_name = ?3, cwd = ?4, provider_session_id = NULL, active_model = NULL, active_effort = NULL, status = 'idle', current_activity = 'Moved to another workspace', last_activity_at = ?5, error_code = NULL, error_message = NULL WHERE id = ?1", params![id, workspace_id, workspace_name, cwd, now])?;
    clear_undelivered(conn, id)?;
    Ok(())
}

pub fn rename(conn: &Connection, id: &str, name: &str) -> Result<()> {
    conn.execute(
        "UPDATE threads SET name = ?2 WHERE id = ?1",
        params![id, name],
    )?;
    Ok(())
}

/// Naming provenance is kept with existing application metadata; prompts are never retained.
pub fn name_origin(conn: &Connection, id: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT value FROM app_meta WHERE key = ?1",
            [format!("thread.name.origin:{id}")],
            |row| row.get(0),
        )
        .optional()?)
}

pub fn set_name_origin(conn: &Connection, id: &str, origin: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO app_meta (key,value,updated_at) VALUES (?1,?2,datetime('now'))
        ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
        params![format!("thread.name.origin:{id}"), origin],
    )?;
    Ok(())
}

pub fn archive(conn: &Connection, id: &str, now: &str) -> Result<()> {
    conn.execute(
        "UPDATE threads SET archived_at = ?2 WHERE id = ?1 AND archived_at IS NULL",
        params![id, now],
    )?;
    Ok(())
}

/// Restores an archived thread to the open list. Returns whether a row changed (an open thread
/// is left alone).
pub fn unarchive(conn: &Connection, id: &str) -> Result<bool> {
    let changed = conn.execute(
        "UPDATE threads SET archived_at = NULL WHERE id = ?1 AND archived_at IS NOT NULL",
        params![id],
    )?;
    Ok(changed > 0)
}

/// Stores a thread's permission mode and, for Custom, its profile (cleared otherwise).
pub fn set_permission_mode(
    conn: &Connection,
    id: &str,
    mode: PermissionMode,
    profile_id: Option<&str>,
) -> Result<()> {
    let profile_id = if mode == PermissionMode::Custom {
        profile_id
    } else {
        None
    };
    conn.execute(
        "UPDATE threads SET permission_mode = ?2, permission_profile_id = ?3 WHERE id = ?1",
        params![id, enum_str(mode), profile_id],
    )?;
    Ok(())
}

/// The Custom permission profile a thread uses, if any.
pub fn permission_profile_id(conn: &Connection, id: &str) -> Result<Option<String>> {
    use rusqlite::OptionalExtension;
    Ok(conn
        .query_row(
            "SELECT permission_profile_id FROM threads WHERE id = ?1",
            [id],
            |r| r.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten())
}

pub fn set_cwd(conn: &Connection, id: &str, cwd: &str, workspace_name: &str) -> Result<()> {
    conn.execute(
        "UPDATE threads SET cwd = ?2, workspace_name = ?3 WHERE id = ?1",
        params![id, cwd, workspace_name],
    )?;
    Ok(())
}

pub fn add_usage(
    conn: &Connection,
    id: &str,
    input: Option<u64>,
    output: Option<u64>,
    cost_micros: Option<u64>,
) -> Result<()> {
    let clamp = |v: Option<u64>| i64::try_from(v.unwrap_or(0)).unwrap_or(i64::MAX);
    conn.execute(
        "UPDATE threads SET input_tokens = input_tokens + ?2, output_tokens = output_tokens + ?3,
            cost_usd_micros = cost_usd_micros + ?4 WHERE id = ?1",
        params![id, clamp(input), clamp(output), clamp(cost_micros)],
    )?;
    Ok(())
}

/// (input tokens, output tokens, cost in micro-dollars).
pub fn usage(conn: &Connection, id: &str) -> Result<(u64, u64, u64)> {
    conn.query_row(
        "SELECT input_tokens, output_tokens, cost_usd_micros FROM threads WHERE id = ?1",
        [id],
        |r| {
            let get = |i: usize| r.get::<_, i64>(i).map(|v| u64::try_from(v).unwrap_or(0));
            Ok((get(0)?, get(1)?, get(2)?))
        },
    )
    .optional()?
    .ok_or_else(thread_not_found)
}

/// Threads a previous KalCode process left running (not archived, not in a final state).
pub fn unfinished(conn: &Connection) -> Result<Vec<ThreadRow>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {THREAD_COLUMNS} FROM {THREAD_FROM}
         WHERE t.archived_at IS NULL AND t.status NOT IN ('completed', 'failed', 'interrupted')"
    ))?;
    let rows = stmt.query_map([], row_to_thread)?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

// ---- Messages ----

pub fn insert_message(
    conn: &Connection,
    thread_id: &str,
    role: MessageRole,
    content: &str,
    provider_message_id: Option<&str>,
    now: &str,
) -> Result<ThreadMessage> {
    let id = new_id();
    conn.execute(
        "INSERT INTO thread_messages (id, thread_id, role, content, provider_message_id, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![id, thread_id, enum_str(role), content, provider_message_id, now],
    )?;
    touch(conn, thread_id, now)?;
    Ok(ThreadMessage {
        id,
        thread_id: thread_id.to_owned(),
        role,
        content: content.to_owned(),
        created_at: now.to_owned(),
    })
}

/// Up to `limit` messages before the message `before` (or the newest), oldest first.
pub fn messages(
    conn: &Connection,
    thread_id: &str,
    limit: u32,
    before: Option<&str>,
) -> Result<Vec<ThreadMessage>> {
    let before_seq: Option<i64> = match before {
        None => None,
        Some(before) => Some(
            conn.query_row(
                "SELECT seq FROM thread_messages WHERE id = ?1 AND thread_id = ?2",
                params![before, thread_id],
                |r| r.get(0),
            )
            .optional()?
            .ok_or_else(|| {
                KalError::validation("invalid_cursor", "The message cursor is invalid.")
            })?,
        ),
    };
    let mut stmt = conn.prepare(
        "SELECT id, thread_id, role, content, created_at FROM thread_messages
         WHERE thread_id = ?1 AND (?2 IS NULL OR seq < ?2) ORDER BY seq DESC LIMIT ?3",
    )?;
    let rows = stmt.query_map(params![thread_id, before_seq, limit], |r| {
        Ok(ThreadMessage {
            id: r.get(0)?,
            thread_id: r.get(1)?,
            role: parse_enum(2, &r.get::<_, String>(2)?)?,
            content: r.get(3)?,
            created_at: r.get(4)?,
        })
    })?;
    let mut page: Vec<ThreadMessage> = rows.collect::<std::result::Result<_, _>>()?;
    page.reverse();
    Ok(page)
}

/// Newest-first durable user turns across open and archived threads. The cursor is the exact
/// message id at the end of the previous page and is valid only in the same workspace scope.
pub fn agent_turn_history(
    conn: &Connection,
    workspace_id: Option<&str>,
    before_message_id: Option<&str>,
    limit: u32,
) -> Result<(Vec<AgentTurnRecord>, Option<String>)> {
    validate_observed_history_request(workspace_id, before_message_id, limit)?;
    let cursor = before_message_id
        .map(|id| agent_turn_cursor(conn, workspace_id, id))
        .transpose()?;
    let fetch = i64::from(limit) + 1;
    let rows = load_agent_turns(
        conn,
        "m.role = 'user'
         AND (?1 IS NULL OR t.workspace_id = ?1)
         AND (?2 IS NULL OR m.created_at < ?2 OR (m.created_at = ?2 AND m.id < ?3))",
        params![
            workspace_id,
            cursor.as_ref().map(|item| item.0.as_str()),
            cursor.as_ref().map(|item| item.1.as_str()),
            fetch
        ],
        "ORDER BY m.created_at DESC, m.id DESC LIMIT ?4",
    )?;
    let has_more = rows.len() > limit as usize;
    let page: Vec<_> = rows.into_iter().take(limit as usize).collect();
    let next = has_more
        .then(|| page.last().map(|turn| turn.message_id.clone()))
        .flatten();
    Ok((page, next))
}

/// Exact durable user turn in the requested workspace scope.
pub fn agent_turn(
    conn: &Connection,
    message_id: &str,
    workspace_id: Option<&str>,
) -> Result<Option<AgentTurnRecord>> {
    validate_observed_history_request(workspace_id, Some(message_id), 1)?;
    Ok(load_agent_turns(
        conn,
        "m.role = 'user' AND m.id = ?1 AND (?2 IS NULL OR t.workspace_id = ?2)",
        params![message_id, workspace_id],
        "LIMIT 1",
    )?
    .into_iter()
    .next())
}

/// The exact first durable user turn covered by one Operation interval.
///
/// Operations store a thread and time interval rather than a message id. Resolve the same first
/// `agent.message` event used by [`load_agent_turns`] without paging or joining the thread's latest
/// identity, then reuse the exact turn query and its sequence-bounded runtime evidence.
pub fn agent_turn_for_operation(
    conn: &Connection,
    operation_id: &str,
) -> Result<Option<AgentTurnRecord>> {
    if !is_valid_id(operation_id) {
        return Err(KalError::validation(
            "invalid_operation_id",
            "That operation reference isn't valid.",
        ));
    }
    let message_id = conn
        .query_row(
            "SELECT json_extract(e.payload, '$.messageId')
             FROM operations o
             JOIN events e
               ON e.type = 'agent.message'
              AND e.thread_id = o.thread_id
              AND json_extract(e.payload, '$.threadId') = o.thread_id
              AND json_extract(e.payload, '$.role') = 'user'
              AND e.occurred_at >= o.started_at
              AND (o.ended_at IS NULL OR e.occurred_at <= o.ended_at)
             WHERE o.id = ?1 AND o.started_at IS NOT NULL
             ORDER BY e.seq
             LIMIT 1",
            [operation_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    message_id
        .as_deref()
        .map(|message_id| agent_turn(conn, message_id, None))
        .transpose()
        .map(Option::flatten)
}

fn agent_turn_cursor(
    conn: &Connection,
    workspace_id: Option<&str>,
    message_id: &str,
) -> Result<(String, String)> {
    conn.query_row(
        "SELECT m.created_at, m.id FROM thread_messages m
         JOIN threads t ON t.id = m.thread_id
         WHERE m.id = ?1 AND m.role = 'user' AND (?2 IS NULL OR t.workspace_id = ?2)",
        params![message_id, workspace_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .optional()?
    .ok_or_else(invalid_observed_history_cursor)
}

fn load_agent_turns(
    conn: &Connection,
    filter: &str,
    query_params: impl rusqlite::Params,
    order_and_limit: &str,
) -> Result<Vec<AgentTurnRecord>> {
    let sql = format!(
        "WITH selected AS (
           SELECT m.id AS message_id, m.thread_id, t.workspace_id, m.created_at,
                  m.seq AS message_seq,
                  (SELECT MIN(e.seq) FROM events e
                   WHERE e.type = 'agent.message'
                     AND e.thread_id = m.thread_id
                     AND json_extract(e.payload, '$.threadId') = m.thread_id
                     AND json_extract(e.payload, '$.messageId') = m.id
                     AND json_extract(e.payload, '$.role') = 'user') AS started_event_seq
           FROM thread_messages m
           JOIN threads t ON t.id = m.thread_id
           WHERE {filter}
           {order_and_limit}
         ), bounded AS (
           SELECT s.*,
                  (SELECT MIN(next.seq) FROM events next
                   WHERE next.type = 'agent.message'
                     AND next.thread_id = s.thread_id
                     AND json_extract(next.payload, '$.threadId') = s.thread_id
                     AND json_extract(next.payload, '$.role') = 'user'
                     AND next.seq > s.started_event_seq) AS next_started_event_seq,
                  (SELECT MIN(done.seq) FROM events done
                   WHERE done.type = 'agent.turn_completed'
                     AND done.thread_id = s.thread_id
                     AND json_extract(done.payload, '$.threadId') = s.thread_id
                     AND done.seq > s.started_event_seq
                     AND done.seq < COALESCE((
                       SELECT MIN(next.seq) FROM events next
                       WHERE next.type = 'agent.message'
                         AND next.thread_id = s.thread_id
                         AND json_extract(next.payload, '$.threadId') = s.thread_id
                         AND json_extract(next.payload, '$.role') = 'user'
                         AND next.seq > s.started_event_seq
                     ), 9223372036854775807)) AS completed_event_seq,
                  (SELECT MIN(boundary.seq) FROM events boundary
                   WHERE boundary.type = 'thread.runtime_identity_changed'
                     AND boundary.thread_id = s.thread_id
                     AND json_extract(boundary.payload, '$.threadId') = s.thread_id
                     AND boundary.seq > s.started_event_seq
                     AND boundary.source IN ('core', 'ui')
                     AND json_type(boundary.payload, '$.activeModel') = 'null'
                     AND json_type(boundary.payload, '$.activeEffort') = 'null')
                    AS next_identity_boundary_seq
           FROM selected s
         )
         SELECT b.message_id, b.thread_id, b.workspace_id, b.created_at,
                b.started_event_seq, b.next_started_event_seq, b.completed_event_seq,
                completed.occurred_at,
                CAST(json_extract(completed.payload, '$.ok') AS INTEGER),
                CAST(json_extract(completed.payload, '$.interrupted') AS INTEGER),
                EXISTS(
                  SELECT 1 FROM thread_messages later
                  WHERE later.thread_id = b.thread_id AND later.role = 'user'
                    AND later.seq > b.message_seq
                ),
                (SELECT o.id FROM operations o
                 WHERE o.thread_id = b.thread_id
                   AND o.started_at IS NOT NULL
                   AND b.started_event_seq = (
                     SELECT MIN(covered.seq) FROM events covered
                     WHERE covered.type = 'agent.message'
                       AND covered.thread_id = b.thread_id
                       AND json_extract(covered.payload, '$.threadId') = b.thread_id
                       AND json_extract(covered.payload, '$.role') = 'user'
                       AND covered.occurred_at >= o.started_at
                       AND (o.ended_at IS NULL OR covered.occurred_at <= o.ended_at)
                   )
                 ORDER BY o.started_at, o.id LIMIT 1),
                json_extract(identity.payload, '$.providerId'),
                json_extract(identity.payload, '$.providerAccountId'),
                json_extract(identity.payload, '$.accountLabel'),
                json_extract(identity.payload, '$.activeModel'),
                json_extract(identity.payload, '$.activeEffort')
         FROM bounded b
         LEFT JOIN events completed ON completed.seq = b.completed_event_seq
         LEFT JOIN events identity ON identity.seq = (
           SELECT MAX(observed.seq) FROM events observed
           WHERE b.started_event_seq IS NOT NULL
             AND observed.type = 'thread.runtime_identity_changed'
             AND observed.thread_id = b.thread_id
             AND json_extract(observed.payload, '$.threadId') = b.thread_id
             AND observed.seq <= CASE
               WHEN b.completed_event_seq IS NOT NULL THEN b.completed_event_seq
               ELSE MIN(
                 COALESCE(b.next_started_event_seq - 1, 9223372036854775807),
                 COALESCE(b.next_identity_boundary_seq - 1, 9223372036854775807)
               )
             END
         )
         ORDER BY b.created_at DESC, b.message_id DESC"
    );
    let mut stmt = conn.prepare(&sql)?;
    Ok(stmt
        .query_map(query_params, |row| {
            Ok(AgentTurnRecord {
                message_id: row.get(0)?,
                thread_id: row.get(1)?,
                workspace_id: row.get(2)?,
                created_at: row.get(3)?,
                started_event_seq: row.get(4)?,
                next_started_event_seq: row.get(5)?,
                completed_event_seq: row.get(6)?,
                completed_at: row.get(7)?,
                ok: row.get(8)?,
                interrupted: row.get(9)?,
                has_later_turn: row.get(10)?,
                operation_id: row.get(11)?,
                observed_provider_id: row.get::<_, Option<String>>(12)?.map(ProviderId::new),
                observed_provider_account_id: row.get(13)?,
                observed_account_label: row.get(14)?,
                observed_model: row.get(15)?,
                observed_effort: row.get(16)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?)
}

fn validate_observed_history_request(
    workspace_id: Option<&str>,
    cursor: Option<&str>,
    limit: u32,
) -> Result<()> {
    if workspace_id.is_some_and(|id| !is_valid_id(id)) {
        return Err(KalError::validation(
            "invalid_workspace_id",
            "That workspace reference isn't valid.",
        ));
    }
    if cursor.is_some_and(|id| !is_valid_id(id)) {
        return Err(invalid_observed_history_cursor());
    }
    if !(1..=MAX_OBSERVED_HISTORY_PAGE).contains(&limit) {
        return Err(KalError::validation(
            "invalid_observed_history_limit",
            "Observed Runs history pages must contain between 1 and 200 records.",
        ));
    }
    Ok(())
}

fn invalid_observed_history_cursor() -> KalError {
    KalError::validation(
        "invalid_observed_history_cursor",
        "That observed Runs history cursor is invalid for this workspace.",
    )
}

// ---- Undelivered message ----
//
// A user message that is in the thread's history but never reached the provider: its launch or
// turn was held for system resources, or the provider was refused or could not start before the
// message was delivered. Resume (without new text) delivers it. The marker lives in `app_meta`
// (one key per thread, no schema change) and names the message by id; it is cleared once the
// message is delivered, when new text supersedes it, and on account rebind or archive.

fn undelivered_key(thread_id: &str) -> String {
    format!("thread.undelivered_message:{thread_id}")
}

pub fn set_undelivered(conn: &Connection, thread_id: &str, message_id: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO app_meta (key, value, updated_at) VALUES (?1, ?2, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![undelivered_key(thread_id), message_id],
    )?;
    Ok(())
}

pub fn clear_undelivered(conn: &Connection, thread_id: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM app_meta WHERE key = ?1",
        params![undelivered_key(thread_id)],
    )?;
    Ok(())
}

/// Whether a valid user message is durably marked for delivery on Resume. This query returns
/// only a boolean; callers that decide whether a resume is safe never read prompt text.
pub fn has_undelivered(conn: &Connection, thread_id: &str) -> Result<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(
           SELECT 1 FROM app_meta a
           JOIN thread_messages m
             ON m.id = a.value AND m.thread_id = ?2 AND m.role = 'user'
           WHERE a.key = ?1
         )",
        params![undelivered_key(thread_id), thread_id],
        |row| row.get(0),
    )?)
}

/// The text of the thread's undelivered user message, if any (and if it still exists).
pub fn undelivered(conn: &Connection, thread_id: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT m.content FROM app_meta a
             JOIN thread_messages m ON m.id = a.value AND m.thread_id = ?2 AND m.role = 'user'
             WHERE a.key = ?1",
            params![undelivered_key(thread_id), thread_id],
            |r| r.get(0),
        )
        .optional()?)
}

/// Marks every current message of the thread as seen.
pub fn mark_read(conn: &Connection, thread_id: &str) -> Result<()> {
    conn.execute(
        "UPDATE threads SET last_read_seq =
            COALESCE((SELECT MAX(seq) FROM thread_messages WHERE thread_id = ?1), 0)
         WHERE id = ?1",
        [thread_id],
    )?;
    Ok(())
}

// ---- Tool calls ----

pub fn insert_tool_call(
    conn: &Connection,
    thread_id: &str,
    provider_call_id: &str,
    tool: &str,
    summary: &str,
    now: &str,
) -> Result<String> {
    let id = new_id();
    conn.execute(
        "INSERT INTO tool_calls (id, thread_id, provider_call_id, tool, summary, status, requested_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'requested', ?6)",
        params![id, thread_id, provider_call_id, tool, summary, now],
    )?;
    touch(conn, thread_id, now)?;
    Ok(id)
}

pub fn tool_started(conn: &Connection, id: &str, now: &str) -> Result<()> {
    conn.execute(
        "UPDATE tool_calls SET status = 'running', started_at = COALESCE(started_at, ?2)
         WHERE id = ?1 AND status IN ('requested', 'running')",
        params![id, now],
    )?;
    Ok(())
}

pub fn tool_finished(
    conn: &Connection,
    id: &str,
    ok: bool,
    result_summary: Option<&str>,
    now: &str,
) -> Result<()> {
    conn.execute(
        "UPDATE tool_calls SET status = ?2, result_summary = ?3, completed_at = ?4
         WHERE id = ?1 AND status IN ('requested', 'running')",
        params![
            id,
            enum_str(if ok {
                ToolCallStatus::Completed
            } else {
                ToolCallStatus::Failed
            }),
            result_summary,
            now
        ],
    )?;
    Ok(())
}

/// Cancels every unfinished tool call of the thread; returns how many changed.
pub fn cancel_open_tool_calls(conn: &Connection, thread_id: &str, now: &str) -> Result<usize> {
    Ok(conn.execute(
        "UPDATE tool_calls SET status = 'cancelled', completed_at = ?2
         WHERE thread_id = ?1 AND status IN ('requested', 'running')",
        params![thread_id, now],
    )?)
}

/// The latest `limit` tool calls, oldest first.
pub fn tool_calls(conn: &Connection, thread_id: &str, limit: u32) -> Result<Vec<ToolCallRecord>> {
    let mut stmt = conn.prepare(
        "SELECT id, thread_id, tool, summary, status, result_summary, requested_at, started_at, completed_at
         FROM tool_calls WHERE thread_id = ?1 ORDER BY seq DESC LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![thread_id, limit], |r| {
        Ok(ToolCallRecord {
            id: r.get(0)?,
            thread_id: r.get(1)?,
            tool: r.get(2)?,
            summary: r.get(3)?,
            status: parse_enum(4, &r.get::<_, String>(4)?)?,
            result_summary: r.get(5)?,
            requested_at: r.get(6)?,
            started_at: r.get(7)?,
            completed_at: r.get(8)?,
        })
    })?;
    let mut page: Vec<ToolCallRecord> = rows.collect::<std::result::Result<_, _>>()?;
    page.reverse();
    Ok(page)
}

/// Newest-first tool-call history across all threads, with an optional workspace and thread
/// scope. The cursor must belong to the same scope, preventing cross-workspace cursor probing.
pub fn tool_call_history(
    conn: &Connection,
    workspace_id: Option<&str>,
    thread_id: Option<&str>,
    before_tool_id: Option<&str>,
    limit: u32,
) -> Result<(Vec<ToolCallHistoryRecord>, Option<String>)> {
    validate_observed_history_request(workspace_id, before_tool_id, limit)?;
    if thread_id.is_some_and(|id| !is_valid_id(id)) {
        return Err(KalError::validation(
            "invalid_thread_id",
            "That thread reference isn't valid.",
        ));
    }
    let cursor = before_tool_id
        .map(|id| tool_call_cursor(conn, workspace_id, thread_id, id))
        .transpose()?;
    let fetch = i64::from(limit) + 1;
    let mut stmt = conn.prepare(
        "SELECT c.id, c.thread_id, c.tool, c.summary, c.status, c.result_summary,
                c.requested_at, c.started_at, c.completed_at, t.workspace_id,
                json_extract(identity.payload, '$.providerId'),
                json_extract(identity.payload, '$.providerAccountId'),
                json_extract(identity.payload, '$.accountLabel'),
                json_extract(identity.payload, '$.activeModel'),
                json_extract(identity.payload, '$.activeEffort')
         FROM tool_calls c
         JOIN threads t ON t.id = c.thread_id
         LEFT JOIN events identity ON identity.seq = (
           SELECT MAX(observed.seq) FROM events observed
           WHERE observed.type = 'thread.runtime_identity_changed'
             AND observed.thread_id = c.thread_id
             AND json_extract(observed.payload, '$.threadId') = c.thread_id
             AND observed.seq <= (
               SELECT MIN(requested.seq) FROM events requested
               WHERE requested.type = 'tool.requested'
                 AND requested.thread_id = c.thread_id
                 AND json_extract(requested.payload, '$.threadId') = c.thread_id
                 AND json_extract(requested.payload, '$.toolCallId') = c.id
             )
         )
         WHERE (?1 IS NULL OR t.workspace_id = ?1)
           AND (?2 IS NULL OR c.thread_id = ?2)
           AND (?3 IS NULL OR c.requested_at < ?3 OR (c.requested_at = ?3 AND c.id < ?4))
         ORDER BY c.requested_at DESC, c.id DESC LIMIT ?5",
    )?;
    let rows = stmt
        .query_map(
            params![
                workspace_id,
                thread_id,
                cursor.as_ref().map(|item| item.0.as_str()),
                cursor.as_ref().map(|item| item.1.as_str()),
                fetch
            ],
            tool_call_history_from_row,
        )?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let has_more = rows.len() > limit as usize;
    let page: Vec<_> = rows.into_iter().take(limit as usize).collect();
    let next = has_more
        .then(|| page.last().map(|row| row.call.id.clone()))
        .flatten();
    Ok((page, next))
}

/// Exact tool call in the requested canonical workspace scope.
pub fn tool_call(
    conn: &Connection,
    tool_id: &str,
    workspace_id: Option<&str>,
) -> Result<Option<ToolCallHistoryRecord>> {
    validate_observed_history_request(workspace_id, Some(tool_id), 1)?;
    Ok(conn
        .query_row(
            "SELECT c.id, c.thread_id, c.tool, c.summary, c.status, c.result_summary,
                    c.requested_at, c.started_at, c.completed_at, t.workspace_id,
                    json_extract(identity.payload, '$.providerId'),
                    json_extract(identity.payload, '$.providerAccountId'),
                    json_extract(identity.payload, '$.accountLabel'),
                    json_extract(identity.payload, '$.activeModel'),
                    json_extract(identity.payload, '$.activeEffort')
             FROM tool_calls c
             JOIN threads t ON t.id = c.thread_id
             LEFT JOIN events identity ON identity.seq = (
               SELECT MAX(observed.seq) FROM events observed
               WHERE observed.type = 'thread.runtime_identity_changed'
                 AND observed.thread_id = c.thread_id
                 AND json_extract(observed.payload, '$.threadId') = c.thread_id
                 AND observed.seq <= (
                   SELECT MIN(requested.seq) FROM events requested
                   WHERE requested.type = 'tool.requested'
                     AND requested.thread_id = c.thread_id
                     AND json_extract(requested.payload, '$.threadId') = c.thread_id
                     AND json_extract(requested.payload, '$.toolCallId') = c.id
                 )
             )
             WHERE c.id = ?1 AND (?2 IS NULL OR t.workspace_id = ?2)",
            params![tool_id, workspace_id],
            tool_call_history_from_row,
        )
        .optional()?)
}

fn tool_call_cursor(
    conn: &Connection,
    workspace_id: Option<&str>,
    thread_id: Option<&str>,
    tool_id: &str,
) -> Result<(String, String)> {
    conn.query_row(
        "SELECT c.requested_at, c.id FROM tool_calls c
         JOIN threads t ON t.id = c.thread_id
         WHERE c.id = ?1 AND (?2 IS NULL OR t.workspace_id = ?2)
           AND (?3 IS NULL OR c.thread_id = ?3)",
        params![tool_id, workspace_id, thread_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .optional()?
    .ok_or_else(invalid_observed_history_cursor)
}

fn tool_call_history_from_row(row: &Row<'_>) -> rusqlite::Result<ToolCallHistoryRecord> {
    Ok(ToolCallHistoryRecord {
        workspace_id: row.get(9)?,
        observed_provider_id: row.get::<_, Option<String>>(10)?.map(ProviderId::new),
        observed_provider_account_id: row.get(11)?,
        observed_account_label: row.get(12)?,
        observed_model: row.get(13)?,
        observed_effort: row.get(14)?,
        call: ToolCallRecord {
            id: row.get(0)?,
            thread_id: row.get(1)?,
            tool: row.get(2)?,
            summary: row.get(3)?,
            status: parse_enum(4, &row.get::<_, String>(4)?)?,
            result_summary: row.get(5)?,
            requested_at: row.get(6)?,
            started_at: row.get(7)?,
            completed_at: row.get(8)?,
        },
    })
}

// ---- Files ----

pub fn record_file(
    conn: &Connection,
    thread_id: &str,
    path: &str,
    change: FileChange,
    now: &str,
) -> Result<()> {
    conn.execute(
        "INSERT INTO thread_files (thread_id, path, change, changed_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (thread_id, path) DO UPDATE SET change = excluded.change, changed_at = excluded.changed_at",
        params![thread_id, path, enum_str(change), now],
    )?;
    touch(conn, thread_id, now)?;
    Ok(())
}

/// Most paths [`touched_paths`] returns per thread.
pub const MAX_TOUCHED_PATHS: usize = 200;

/// The files a thread's provider reported editing, sorted, at most [`MAX_TOUCHED_PATHS`], and
/// whether more exist. `None` for an unknown thread.
pub fn touched_paths(conn: &Connection, thread_id: &str) -> Result<Option<(Vec<String>, bool)>> {
    let known = conn
        .query_row("SELECT 1 FROM threads WHERE id = ?1", [thread_id], |_| {
            Ok(())
        })
        .optional()?;
    if known.is_none() {
        return Ok(None);
    }
    let mut stmt = conn.prepare_cached(
        "SELECT path FROM thread_files WHERE thread_id = ?1 ORDER BY path LIMIT ?2",
    )?;
    let mut paths = stmt
        .query_map(params![thread_id, MAX_TOUCHED_PATHS as i64 + 1], |row| {
            row.get::<_, String>(0)
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let truncated = paths.len() > MAX_TOUCHED_PATHS;
    paths.truncate(MAX_TOUCHED_PATHS);
    Ok(Some((paths, truncated)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use kalcode_core::db;

    fn conn() -> Connection {
        let mut conn = db::open_in_memory().expect("open");
        db::migrate(&mut conn, db::MIGRATIONS, None).expect("migrate");
        conn
    }

    fn thread(conn: &Connection, id: &str, now: &str) {
        thread_in(conn, id, &new_id(), now);
    }

    fn thread_in(conn: &Connection, id: &str, workspace_id: &str, now: &str) {
        insert_thread(
            conn,
            &NewThreadRow {
                id,
                name: "Fix Bug",
                provider_id: &ProviderId::new("fake"),
                provider_name: "Fake",
                model: None,
                effort: None,
                provider_account_id: None,
                account_label: None,
                workspace_id,
                workspace_name: "Repo",
                cwd: "/repo",
                permission_mode: PermissionMode::Approve,
                now,
            },
        )
        .expect("insert");
    }

    fn workspace(conn: &Connection, id: &str) {
        conn.execute(
            "INSERT INTO workspaces (id, name, root_path, created_at, last_opened_at)
             VALUES (?1, 'Repo', ?2, '2026-09-30T10:00:00.000Z', '2026-09-30T10:00:00.000Z')",
            params![id, format!("C:/fixture/{id}")],
        )
        .expect("workspace");
    }

    fn event(
        conn: &Connection,
        event_type: &str,
        workspace_id: Option<&str>,
        thread_id: Option<&str>,
        payload: serde_json::Value,
        occurred_at: &str,
    ) -> (String, i64) {
        let id = new_id();
        conn.execute(
            "INSERT INTO events (
               id, type, version, occurred_at, source, workspace_id, thread_id, payload
             ) VALUES (?1, ?2, 1, ?3, 'core', ?4, ?5, ?6)",
            params![
                id,
                event_type,
                occurred_at,
                workspace_id,
                thread_id,
                payload.to_string()
            ],
        )
        .expect("event");
        let seq = conn.last_insert_rowid();
        (id, seq)
    }

    #[test]
    fn enums_round_trip_through_text() {
        assert_eq!(
            enum_str(ThreadStatus::WaitingForPermission),
            "waiting_for_permission"
        );
        assert_eq!(enum_str(ToolCallStatus::Cancelled), "cancelled");
        assert_eq!(enum_str(PermissionMode::Approve), "approve");
        let status: ThreadStatus = parse_enum(0, "running_tool").expect("parse");
        assert_eq!(status, ThreadStatus::RunningTool);
        assert!(parse_enum::<ThreadStatus>(0, "teleporting").is_err());
    }

    #[test]
    fn thread_rows_round_trip_with_counts() {
        let conn = conn();
        let id = new_id();
        thread(&conn, &id, "2026-09-24T10:00:00.000Z");
        let row = get(&conn, &id).expect("get");
        assert_eq!(row.status, ThreadStatus::Starting);
        assert_eq!(row.unread_messages, 0);

        insert_message(
            &conn,
            &id,
            MessageRole::User,
            "hi",
            None,
            "2026-09-24T10:00:01.000Z",
        )
        .expect("user");
        insert_message(
            &conn,
            &id,
            MessageRole::Assistant,
            "hello",
            None,
            "2026-09-24T10:00:02.000Z",
        )
        .expect("assistant");
        record_file(
            &conn,
            &id,
            "src/a.rs",
            FileChange::Modified,
            "2026-09-24T10:00:03.000Z",
        )
        .expect("file");
        record_file(
            &conn,
            &id,
            "src/a.rs",
            FileChange::Deleted,
            "2026-09-24T10:00:04.000Z",
        )
        .expect("file again");
        assert_eq!(
            touched_paths(&conn, &id).expect("touched"),
            Some((vec!["src/a.rs".to_owned()], false))
        );
        assert_eq!(touched_paths(&conn, &new_id()).expect("unknown"), None);
        let row = get(&conn, &id).expect("get");
        assert_eq!(row.unread_messages, 1);
        assert_eq!(row.files_changed, 1);
        assert_eq!(row.last_activity_at, "2026-09-24T10:00:04.000Z");
        mark_read(&conn, &id).expect("read");
        assert_eq!(get(&conn, &id).expect("get").unread_messages, 0);
        assert_eq!(
            get(&conn, &new_id()).expect_err("missing").code,
            "thread_not_found"
        );
    }

    #[test]
    fn message_pages_are_oldest_first_with_cursor() {
        let conn = conn();
        let id = new_id();
        thread(&conn, &id, "2026-09-24T10:00:00.000Z");
        let ids: Vec<String> = (0..5)
            .map(|i| {
                insert_message(
                    &conn,
                    &id,
                    MessageRole::User,
                    &format!("m{i}"),
                    None,
                    "2026-09-24T10:00:01.000Z",
                )
                .expect("insert")
                .id
            })
            .collect();
        let latest = messages(&conn, &id, 2, None).expect("latest");
        assert_eq!(
            latest
                .iter()
                .map(|m| m.content.as_str())
                .collect::<Vec<_>>(),
            ["m3", "m4"]
        );
        let older = messages(&conn, &id, 2, Some(&ids[3])).expect("older");
        assert_eq!(
            older.iter().map(|m| m.content.as_str()).collect::<Vec<_>>(),
            ["m1", "m2"]
        );
        assert_eq!(
            messages(&conn, &id, 2, Some(&new_id()))
                .expect_err("bad cursor")
                .code,
            "invalid_cursor"
        );
    }

    fn account_row(conn: &Connection, id: &str, provider: &str, label: &str, archived: bool) {
        conn.execute(
            "INSERT INTO provider_accounts (
                id, provider_id, display_name, authentication_state, is_default, created_at,
                archived_at
             ) VALUES (?1, ?2, ?3, 'authenticated', 0, '2026-09-28T00:00:00Z', ?4)",
            params![
                id,
                provider,
                label,
                archived.then_some("2026-09-28T01:00:00Z")
            ],
        )
        .expect("account");
    }

    #[test]
    fn set_account_changes_the_snapshot_and_clears_the_account_scoped_resume_id() {
        let conn = conn();
        let id = new_id();
        thread(&conn, &id, "2026-09-28T10:00:00.000Z");
        let (a, b) = (new_id(), new_id());
        account_row(&conn, &a, "gemini-cli", "Gemini A", false);
        account_row(&conn, &b, "gemini-cli", "Gemini B", false);
        conn.execute(
            "UPDATE threads SET provider_account_id = ?2, account_label = 'Gemini A' WHERE id = ?1",
            params![id, a],
        )
        .expect("bind a");
        set_provider_session(
            &conn,
            &id,
            "gemini-chat-under-a",
            Some("gemini-2.5-pro"),
            None,
        )
        .expect("resume id");
        let reported = get(&conn, &id).expect("reported runtime identity");
        assert_eq!(reported.model, None);
        assert_eq!(reported.active_model.as_deref(), Some("gemini-2.5-pro"));

        set_account(&conn, &id, &b, Some("Gemini B")).expect("rebind");
        let row = get(&conn, &id).expect("row");
        assert_eq!(row.provider_account_id.as_deref(), Some(b.as_str()));
        assert_eq!(row.account_label.as_deref(), Some("Gemini B"));
        assert_eq!(
            row.provider_session_id, None,
            "a resume id lives in the old account's profile home and must not survive a rebind"
        );
        assert_eq!(
            row.model, None,
            "runtime truth does not rewrite launch intent"
        );
        assert_eq!(
            row.active_model, None,
            "changing accounts clears the old session's observed identity"
        );
        assert_eq!(
            set_account(&conn, &new_id(), &b, Some("Gemini B"))
                .expect_err("missing thread")
                .code,
            "thread_not_found"
        );
    }

    #[test]
    fn account_ref_reads_owner_label_and_archive_state_only() {
        let conn = conn();
        let (active, archived) = (new_id(), new_id());
        account_row(&conn, &active, "codex", "Work", false);
        account_row(&conn, &archived, "codex", "Old", true);
        let found = account(&conn, &active).expect("read").expect("active");
        assert_eq!(found.provider_id.as_str(), "codex");
        assert_eq!(found.display_name, "Work");
        assert!(!found.archived);
        assert!(
            account(&conn, &archived)
                .expect("read")
                .expect("row")
                .archived
        );
        assert_eq!(account(&conn, &new_id()).expect("read"), None);
    }

    #[test]
    fn unarchive_restores_an_archived_thread_to_the_open_list_only() {
        let conn = conn();
        let (a, b) = (new_id(), new_id());
        thread(&conn, &a, "2026-09-24T10:00:00.000Z");
        thread(&conn, &b, "2026-09-24T10:00:01.000Z");
        assert!(
            !unarchive(&conn, &a).expect("open thread"),
            "nothing to restore"
        );
        archive(&conn, &a, "2026-09-24T11:00:00.000Z").expect("archive");
        assert_eq!(list(&conn, None, false).expect("open").len(), 1);
        assert_eq!(
            get(&conn, &a).expect("get").archived_at.as_deref(),
            Some("2026-09-24T11:00:00.000Z")
        );

        assert!(unarchive(&conn, &a).expect("restore"));
        assert_eq!(get(&conn, &a).expect("get").archived_at, None);
        assert_eq!(list(&conn, None, false).expect("open").len(), 2);
        assert!(!unarchive(&conn, &a).expect("again"), "idempotent");
        assert!(
            !unarchive(&conn, &new_id()).expect("unknown"),
            "an unknown id changes nothing"
        );
    }

    #[test]
    fn tool_calls_track_lifecycle_and_cancellation() {
        let conn = conn();
        let id = new_id();
        let now = "2026-09-24T10:00:00.000Z";
        thread(&conn, &id, now);
        let a = insert_tool_call(&conn, &id, "p1", "Bash", "Run npm test", now).expect("a");
        let b = insert_tool_call(&conn, &id, "p2", "Edit", "Edit src/a.rs", now).expect("b");
        tool_started(&conn, &a, now).expect("start");
        tool_finished(&conn, &a, false, Some("2 tests failed"), now).expect("finish");
        // A finished call cannot be restarted or re-finished.
        tool_started(&conn, &a, now).expect("noop");
        assert_eq!(cancel_open_tool_calls(&conn, &id, now).expect("cancel"), 1);
        let calls = tool_calls(&conn, &id, 10).expect("calls");
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].id, a);
        assert_eq!(calls[0].status, ToolCallStatus::Failed);
        assert_eq!(calls[0].result_summary.as_deref(), Some("2 tests failed"));
        assert_eq!(calls[1].id, b);
        assert_eq!(calls[1].status, ToolCallStatus::Cancelled);
    }

    #[test]
    fn agent_turn_history_pages_every_thread_and_only_suppresses_the_covered_turn() {
        let conn = conn();
        let workspace_id = new_id();
        workspace(&conn, &workspace_id);
        let mut all_messages = Vec::new();
        for index in 0..105 {
            let thread_id = new_id();
            let at = format!("2026-09-30T10:00:00.{index:03}Z");
            thread_in(&conn, &thread_id, &workspace_id, &at);
            let message = insert_message(&conn, &thread_id, MessageRole::User, "run", None, &at)
                .expect("message");
            let (_, started_seq) = event(
                &conn,
                "agent.message",
                Some(&workspace_id),
                Some(&thread_id),
                serde_json::json!({
                    "threadId": thread_id,
                    "messageId": message.id,
                    "role": "user"
                }),
                &at,
            );
            let (_, completed_seq) = event(
                &conn,
                "agent.turn_completed",
                Some(&workspace_id),
                Some(&thread_id),
                serde_json::json!({
                    "threadId": thread_id,
                    "ok": true,
                    "interrupted": false
                }),
                &at,
            );
            all_messages.push((message.id, started_seq, completed_seq));
        }

        let mut cursor = None;
        let mut paged = Vec::new();
        loop {
            let (page, next) =
                agent_turn_history(&conn, Some(&workspace_id), cursor.as_deref(), 17)
                    .expect("turn page");
            paged.extend(page);
            cursor = next;
            if cursor.is_none() {
                break;
            }
        }
        assert_eq!(
            paged.len(),
            105,
            "history is not capped at the old 100 rows"
        );
        let oldest = all_messages.first().expect("oldest");
        let exact = agent_turn(&conn, &oldest.0, Some(&workspace_id))
            .expect("exact turn")
            .expect("oldest survives");
        assert_eq!(exact.started_event_seq, Some(oldest.1));
        assert_eq!(exact.completed_event_seq, Some(oldest.2));
        assert_eq!(exact.ok, Some(true));

        let thread_id = new_id();
        thread_in(&conn, &thread_id, &workspace_id, "2026-09-30T11:00:00.000Z");
        let first = insert_message(
            &conn,
            &thread_id,
            MessageRole::User,
            "first",
            None,
            "2026-09-30T11:00:00.010Z",
        )
        .expect("first message");
        event(
            &conn,
            "thread.runtime_identity_changed",
            Some(&workspace_id),
            Some(&thread_id),
            serde_json::json!({
                "threadId": thread_id,
                "providerId": "codex",
                "providerAccountId": "account-a",
                "accountLabel": "Work A",
                "activeModel": "provider-model-a",
                "activeEffort": "High"
            }),
            "2026-09-30T11:00:00.005Z",
        );
        let (_, first_started) = event(
            &conn,
            "agent.message",
            Some(&workspace_id),
            Some(&thread_id),
            serde_json::json!({"threadId": thread_id, "messageId": first.id, "role": "user"}),
            "2026-09-30T11:00:00.010Z",
        );
        let (_, first_completed) = event(
            &conn,
            "agent.turn_completed",
            Some(&workspace_id),
            Some(&thread_id),
            serde_json::json!({"threadId": thread_id, "ok": true, "interrupted": false}),
            "2026-09-30T11:00:00.020Z",
        );
        event(
            &conn,
            "thread.runtime_identity_changed",
            Some(&workspace_id),
            Some(&thread_id),
            serde_json::json!({
                "threadId": thread_id,
                "providerId": "codex",
                "providerAccountId": "account-b",
                "accountLabel": "Work B",
                "activeModel": "provider-model-b",
                "activeEffort": null
            }),
            "2026-09-30T11:00:00.025Z",
        );
        let second = insert_message(
            &conn,
            &thread_id,
            MessageRole::User,
            "second",
            None,
            "2026-09-30T11:00:00.030Z",
        )
        .expect("second message");
        let (_, second_started) = event(
            &conn,
            "agent.message",
            Some(&workspace_id),
            Some(&thread_id),
            serde_json::json!({"threadId": thread_id, "messageId": second.id, "role": "user"}),
            "2026-09-30T11:00:00.030Z",
        );
        let (_, second_completed) = event(
            &conn,
            "agent.turn_completed",
            Some(&workspace_id),
            Some(&thread_id),
            serde_json::json!({"threadId": thread_id, "ok": false, "interrupted": false}),
            "2026-09-30T11:00:00.040Z",
        );
        event(
            &conn,
            "thread.runtime_identity_changed",
            Some(&workspace_id),
            Some(&thread_id),
            serde_json::json!({
                "threadId": thread_id,
                "providerId": "codex",
                "providerAccountId": "account-c",
                "accountLabel": "Work C",
                "activeModel": "provider-model-after-run",
                "activeEffort": "Max"
            }),
            "2026-09-30T11:00:00.045Z",
        );
        let operation_id = new_id();
        conn.execute(
            "INSERT INTO operations (
               id, workspace_id, name, kind, prompt, dependencies, priority, lane, environment,
               urls, env_keys, source, status, thread_id, created_at, started_at, ended_at,
               position
             ) VALUES (
               ?1, ?2, 'First agent turn', 'agent', 'first', '[]', 0, 'next', 'local',
               '[]', '[]', 'operations', 'succeeded', ?3,
               '2026-09-30T11:00:00.000Z', '2026-09-30T11:00:00.000Z',
               '2026-09-30T11:00:00.020Z', 0
             )",
            params![operation_id, workspace_id, thread_id],
        )
        .expect("linked operation");

        let first_turn = agent_turn(&conn, &first.id, Some(&workspace_id))
            .expect("first exact")
            .expect("first turn");
        assert_eq!(first_turn.started_event_seq, Some(first_started));
        assert_eq!(first_turn.next_started_event_seq, Some(second_started));
        assert_eq!(first_turn.completed_event_seq, Some(first_completed));
        assert_eq!(
            first_turn.operation_id.as_deref(),
            Some(operation_id.as_str())
        );
        assert_eq!(
            first_turn.observed_model.as_deref(),
            Some("provider-model-a")
        );
        assert_eq!(first_turn.observed_effort.as_deref(), Some("High"));
        assert_eq!(
            first_turn
                .observed_provider_id
                .as_ref()
                .map(ProviderId::as_str),
            Some("codex")
        );
        assert_eq!(
            first_turn.observed_provider_account_id.as_deref(),
            Some("account-a")
        );
        assert_eq!(first_turn.observed_account_label.as_deref(), Some("Work A"));
        assert_eq!(
            agent_turn_for_operation(&conn, &operation_id)
                .expect("operation turn")
                .expect("covered turn"),
            first_turn,
            "operation detail resolves the same exact sequence-bounded turn without paging"
        );
        assert!(first_turn.has_later_turn);
        let second_turn = agent_turn(&conn, &second.id, Some(&workspace_id))
            .expect("second exact")
            .expect("second turn");
        assert_eq!(second_turn.started_event_seq, Some(second_started));
        assert_eq!(second_turn.next_started_event_seq, None);
        assert_eq!(second_turn.completed_event_seq, Some(second_completed));
        assert_eq!(second_turn.operation_id, None, "later turn is not hidden");
        assert!(!second_turn.has_later_turn);
        assert_eq!(second_turn.ok, Some(false));
        assert_eq!(
            second_turn.observed_model.as_deref(),
            Some("provider-model-b"),
            "an identity update after completion cannot rewrite an older run"
        );
        assert_eq!(second_turn.observed_effort, None);
        assert_eq!(
            second_turn.observed_provider_account_id.as_deref(),
            Some("account-b"),
            "a later account binding cannot rewrite an older run"
        );

        let unknown_thread = new_id();
        thread_in(
            &conn,
            &unknown_thread,
            &workspace_id,
            "2026-09-30T11:30:00.000Z",
        );
        let unknown = insert_message(
            &conn,
            &unknown_thread,
            MessageRole::User,
            "old imported turn",
            None,
            "2026-09-30T11:30:00.010Z",
        )
        .expect("unknown turn");
        event(
            &conn,
            "agent.message",
            Some(&workspace_id),
            Some(&unknown_thread),
            serde_json::json!({
                "threadId": unknown_thread,
                "messageId": unknown.id,
                "role": "user"
            }),
            "2026-09-30T11:30:00.010Z",
        );
        let later = insert_message(
            &conn,
            &unknown_thread,
            MessageRole::User,
            "later turn",
            None,
            "2026-09-30T11:30:00.020Z",
        )
        .expect("later turn");
        let (_, later_started) = event(
            &conn,
            "agent.message",
            Some(&workspace_id),
            Some(&unknown_thread),
            serde_json::json!({
                "threadId": unknown_thread,
                "messageId": later.id,
                "role": "user"
            }),
            "2026-09-30T11:30:00.020Z",
        );
        let unknown_turn = agent_turn(&conn, &unknown.id, Some(&workspace_id))
            .expect("unknown exact")
            .expect("unknown turn remains visible");
        assert_eq!(unknown_turn.completed_event_seq, None);
        assert_eq!(unknown_turn.next_started_event_seq, Some(later_started));
        assert!(unknown_turn.has_later_turn);

        let imported_thread = new_id();
        thread_in(
            &conn,
            &imported_thread,
            &workspace_id,
            "2026-09-30T11:45:00.000Z",
        );
        let imported = insert_message(
            &conn,
            &imported_thread,
            MessageRole::User,
            "imported without event evidence",
            None,
            "2026-09-30T11:45:00.010Z",
        )
        .expect("imported turn");
        event(
            &conn,
            "thread.runtime_identity_changed",
            Some(&workspace_id),
            Some(&imported_thread),
            serde_json::json!({
                "threadId": imported_thread,
                "activeModel": "unrelated-live-model",
                "activeEffort": "High"
            }),
            "2026-09-30T11:45:00.020Z",
        );
        let imported_turn = agent_turn(&conn, &imported.id, Some(&workspace_id))
            .expect("imported exact")
            .expect("imported turn remains visible");
        assert_eq!(imported_turn.started_event_seq, None);
        assert_eq!(imported_turn.observed_model, None);
        assert_eq!(imported_turn.observed_effort, None);
    }

    #[test]
    fn unresolved_turn_identity_stops_before_the_next_session_reset() {
        let conn = conn();
        let workspace_id = new_id();
        let thread_id = new_id();
        thread_in(&conn, &thread_id, &workspace_id, "2026-09-30T11:50:00.000Z");
        event(
            &conn,
            "thread.runtime_identity_changed",
            Some(&workspace_id),
            Some(&thread_id),
            serde_json::json!({
                "threadId": thread_id,
                "providerId": "codex",
                "providerAccountId": "account-a",
                "accountLabel": "Work A",
                "activeModel": "provider-model-a",
                "activeEffort": "High"
            }),
            "2026-09-30T11:50:00.005Z",
        );
        let first = insert_message(
            &conn,
            &thread_id,
            MessageRole::User,
            "unresolved first turn",
            None,
            "2026-09-30T11:50:00.010Z",
        )
        .expect("first message");
        event(
            &conn,
            "agent.message",
            Some(&workspace_id),
            Some(&thread_id),
            serde_json::json!({"threadId": thread_id, "messageId": first.id, "role": "user"}),
            "2026-09-30T11:50:00.010Z",
        );

        // The first process exits without a turn-completed event. A fresh launch under B writes
        // this null boundary before accepting its first message.
        event(
            &conn,
            "thread.runtime_identity_changed",
            Some(&workspace_id),
            Some(&thread_id),
            serde_json::json!({
                "threadId": thread_id,
                "providerId": "codex",
                "providerAccountId": "account-b",
                "accountLabel": "Work B",
                "activeModel": null,
                "activeEffort": null
            }),
            "2026-09-30T11:50:00.020Z",
        );
        let second = insert_message(
            &conn,
            &thread_id,
            MessageRole::User,
            "fresh second turn",
            None,
            "2026-09-30T11:50:00.030Z",
        )
        .expect("second message");
        event(
            &conn,
            "agent.message",
            Some(&workspace_id),
            Some(&thread_id),
            serde_json::json!({"threadId": thread_id, "messageId": second.id, "role": "user"}),
            "2026-09-30T11:50:00.030Z",
        );

        let first_turn = agent_turn(&conn, &first.id, Some(&workspace_id))
            .expect("first exact")
            .expect("first turn");
        assert_eq!(first_turn.completed_event_seq, None);
        assert_eq!(
            first_turn.observed_model.as_deref(),
            Some("provider-model-a")
        );
        assert_eq!(first_turn.observed_effort.as_deref(), Some("High"));
        assert_eq!(
            first_turn.observed_provider_account_id.as_deref(),
            Some("account-a"),
            "the next process reset must not rewrite the unresolved prior turn"
        );

        let second_turn = agent_turn(&conn, &second.id, Some(&workspace_id))
            .expect("second exact")
            .expect("second turn");
        assert_eq!(second_turn.observed_model, None);
        assert_eq!(second_turn.observed_effort, None);
        assert_eq!(
            second_turn.observed_provider_account_id.as_deref(),
            Some("account-b"),
            "the fresh turn retains its exact binding while runtime selectors remain unknown"
        );

        let redelivery_thread = new_id();
        thread_in(
            &conn,
            &redelivery_thread,
            &workspace_id,
            "2026-09-30T11:51:00.000Z",
        );
        event(
            &conn,
            "thread.runtime_identity_changed",
            Some(&workspace_id),
            Some(&redelivery_thread),
            serde_json::json!({
                "threadId": redelivery_thread,
                "providerId": "codex",
                "providerAccountId": "account-a",
                "accountLabel": "Work A",
                "activeModel": "provider-model-a",
                "activeEffort": "High"
            }),
            "2026-09-30T11:51:00.005Z",
        );
        let redelivered = insert_message(
            &conn,
            &redelivery_thread,
            MessageRole::User,
            "resume this same durable turn",
            None,
            "2026-09-30T11:51:00.010Z",
        )
        .expect("redelivered message");
        event(
            &conn,
            "agent.message",
            Some(&workspace_id),
            Some(&redelivery_thread),
            serde_json::json!({
                "threadId": redelivery_thread,
                "messageId": redelivered.id,
                "role": "user"
            }),
            "2026-09-30T11:51:00.010Z",
        );
        event(
            &conn,
            "thread.runtime_identity_changed",
            Some(&workspace_id),
            Some(&redelivery_thread),
            serde_json::json!({
                "threadId": redelivery_thread,
                "providerId": "codex",
                "providerAccountId": "account-b",
                "accountLabel": "Work B",
                "activeModel": null,
                "activeEffort": null
            }),
            "2026-09-30T11:51:00.020Z",
        );
        event(
            &conn,
            "thread.runtime_identity_changed",
            Some(&workspace_id),
            Some(&redelivery_thread),
            serde_json::json!({
                "threadId": redelivery_thread,
                "providerId": "codex",
                "providerAccountId": "account-b",
                "accountLabel": "Work B",
                "activeModel": "provider-model-b",
                "activeEffort": "Max"
            }),
            "2026-09-30T11:51:00.030Z",
        );
        event(
            &conn,
            "agent.turn_completed",
            Some(&workspace_id),
            Some(&redelivery_thread),
            serde_json::json!({
                "threadId": redelivery_thread,
                "ok": true,
                "interrupted": false
            }),
            "2026-09-30T11:51:00.040Z",
        );
        let resumed_turn = agent_turn(&conn, &redelivered.id, Some(&workspace_id))
            .expect("redelivered exact")
            .expect("redelivered turn");
        assert_eq!(
            resumed_turn.observed_model.as_deref(),
            Some("provider-model-b"),
            "completion proves the same durable turn continued after the reset"
        );
        assert_eq!(resumed_turn.observed_effort.as_deref(), Some("Max"));
        assert_eq!(
            resumed_turn.observed_provider_account_id.as_deref(),
            Some("account-b")
        );
    }

    #[test]
    fn tool_call_history_pages_beyond_twenty_with_exact_workspace_ownership() {
        let conn = conn();
        let workspace_id = new_id();
        let other_workspace = new_id();
        let thread_id = new_id();
        thread_in(&conn, &thread_id, &workspace_id, "2026-09-30T12:00:00.000Z");
        let mut ids = Vec::new();
        for index in 0..25 {
            let at = format!("2026-09-30T12:00:00.{index:03}Z");
            ids.push(
                insert_tool_call(
                    &conn,
                    &thread_id,
                    &format!("provider-{index}"),
                    "Read",
                    "Read a file",
                    &at,
                )
                .expect("tool call"),
            );
        }
        event(
            &conn,
            "thread.runtime_identity_changed",
            Some(&workspace_id),
            Some(&thread_id),
            serde_json::json!({
                "threadId": thread_id,
                "providerId": "codex",
                "providerAccountId": "account-tool-a",
                "accountLabel": "Tool A",
                "activeModel": "tool-model-a",
                "activeEffort": "High"
            }),
            "2026-09-30T12:00:01.000Z",
        );
        event(
            &conn,
            "tool.requested",
            Some(&workspace_id),
            Some(&thread_id),
            serde_json::json!({
                "threadId": thread_id,
                "toolCallId": ids[0],
                "tool": "Read",
                "summary": "Read a file"
            }),
            "2026-09-30T12:00:01.001Z",
        );
        event(
            &conn,
            "thread.runtime_identity_changed",
            Some(&workspace_id),
            Some(&thread_id),
            serde_json::json!({
                "threadId": thread_id,
                "providerId": "codex",
                "providerAccountId": "account-tool-b",
                "accountLabel": "Tool B",
                "activeModel": "tool-model-b",
                "activeEffort": null
            }),
            "2026-09-30T12:00:01.002Z",
        );

        let mut cursor = None;
        let mut paged = Vec::new();
        loop {
            let (page, next) = tool_call_history(
                &conn,
                Some(&workspace_id),
                Some(&thread_id),
                cursor.as_deref(),
                6,
            )
            .expect("tool page");
            paged.extend(page);
            cursor = next;
            if cursor.is_none() {
                break;
            }
        }
        assert_eq!(paged.len(), 25, "history is not capped at the old 20 rows");
        let oldest = tool_call(&conn, &ids[0], Some(&workspace_id))
            .expect("exact tool")
            .expect("oldest tool");
        assert_eq!(oldest.workspace_id, workspace_id);
        assert_eq!(oldest.call.thread_id, thread_id);
        assert_eq!(oldest.observed_model.as_deref(), Some("tool-model-a"));
        assert_eq!(oldest.observed_effort.as_deref(), Some("High"));
        assert_eq!(
            oldest.observed_provider_account_id.as_deref(),
            Some("account-tool-a"),
            "a later identity cannot rewrite the account or model that requested this tool"
        );
        assert_eq!(
            tool_call(&conn, &ids[0], Some(&other_workspace)).expect("wrong scope"),
            None
        );
        assert_eq!(
            tool_call_history(&conn, Some(&other_workspace), None, Some(&ids[0]), 10)
                .expect_err("cursor cannot cross workspace")
                .code,
            "invalid_observed_history_cursor"
        );
    }
}
