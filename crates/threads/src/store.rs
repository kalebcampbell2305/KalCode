//! SQL for the Z3 tables (`threads`, `thread_messages`, `tool_calls`, `thread_files`). Only
//! this module touches them; other campaigns read threads through [`crate::ThreadRuntime`].

use kalcode_contracts::agent::{FileChange, ProviderId};
use kalcode_contracts::ids::new_id;
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
}

const THREAD_COLUMNS: &str =
    "t.id, t.name, t.provider_id, t.provider_name, t.model, t.provider_account_id, t.account_label,
    t.workspace_id, t.workspace_name, t.cwd, t.permission_mode, t.status, t.current_activity,
    t.provider_session_id, t.created_at, t.last_activity_at, t.pending_approvals, t.archived_at,
    t.error_code, t.error_message,
    (SELECT COUNT(*) FROM thread_messages m
       WHERE m.thread_id = t.id AND m.role = 'assistant' AND m.seq > t.last_read_seq),
    (SELECT COUNT(*) FROM thread_files f WHERE f.thread_id = t.id),
    t.permission_profile_id";

fn row_to_thread(row: &Row<'_>) -> rusqlite::Result<ThreadRow> {
    Ok(ThreadRow {
        id: row.get(0)?,
        name: row.get(1)?,
        provider_id: ProviderId::new(row.get::<_, String>(2)?),
        provider_name: row.get(3)?,
        model: row.get(4)?,
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
    })
}

pub struct NewThreadRow<'a> {
    pub id: &'a str,
    pub name: &'a str,
    pub provider_id: &'a ProviderId,
    pub provider_name: &'a str,
    pub model: Option<&'a str>,
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
            workspace_id, workspace_name, cwd, permission_mode, status, created_at, last_activity_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'starting', ?12, ?12)",
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
        ],
    )?;
    Ok(())
}

pub fn get(conn: &Connection, id: &str) -> Result<ThreadRow> {
    conn.query_row(
        &format!("SELECT {THREAD_COLUMNS} FROM threads t WHERE t.id = ?1"),
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
        "SELECT {THREAD_COLUMNS} FROM threads t
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
) -> Result<()> {
    conn.execute(
        "UPDATE threads SET provider_session_id = ?2, model = COALESCE(model, ?3) WHERE id = ?1",
        params![id, session_id, model],
    )?;
    Ok(())
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
         SET provider_account_id = ?2, account_label = ?3, provider_session_id = NULL
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

pub fn rename(conn: &Connection, id: &str, name: &str) -> Result<()> {
    conn.execute(
        "UPDATE threads SET name = ?2 WHERE id = ?1",
        params![id, name],
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
        "SELECT {THREAD_COLUMNS} FROM threads t
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
        insert_thread(
            conn,
            &NewThreadRow {
                id,
                name: "Fix Bug",
                provider_id: &ProviderId::new("fake"),
                provider_name: "Fake",
                model: None,
                provider_account_id: None,
                account_label: None,
                workspace_id: &new_id(),
                workspace_name: "Repo",
                cwd: "/repo",
                permission_mode: PermissionMode::Approve,
                now,
            },
        )
        .expect("insert");
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
        set_provider_session(&conn, &id, "gemini-chat-under-a", Some("gemini-2.5-pro"))
            .expect("resume id");

        set_account(&conn, &id, &b, Some("Gemini B")).expect("rebind");
        let row = get(&conn, &id).expect("row");
        assert_eq!(row.provider_account_id.as_deref(), Some(b.as_str()));
        assert_eq!(row.account_label.as_deref(), Some("Gemini B"));
        assert_eq!(
            row.provider_session_id, None,
            "a resume id lives in the old account's profile home and must not survive a rebind"
        );
        assert_eq!(row.model.as_deref(), Some("gemini-2.5-pro"));
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
}
