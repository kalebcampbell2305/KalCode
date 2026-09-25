//! Persistence for migration v7: `git_worktrees` and `checkpoints`.
//!
//! [`GIT_MIGRATION`] is deliberately **not** registered in `kalcode_core::db::MIGRATIONS` on this
//! branch (wave 2 is renumbering v2–v4); the lead appends it at integration. Every function takes
//! a connection or transaction supplied by `Core` (`Core::read` / `Core::write_with_events`), so
//! callers decide atomicity. Parameterized SQL only. Git never runs while a connection is held.

use rusqlite::{Connection, OptionalExtension, Row, params};

use kalcode_contracts::ids::is_valid_id;
use kalcode_core::db::Migration;
use kalcode_core::time::now_rfc3339;
use kalcode_core::{KalError, Result};

use crate::checkpoint::CreatedCheckpoint;
use crate::types::{
    Checkpoint, CheckpointTrigger, Page, PageRequest, Worktree, WorktreePurpose, WorktreeStatus,
};
use crate::worktree::NewWorktree;

/// Migration v7 (campaign Z6a). Append to `kalcode_core::db::MIGRATIONS` at integration; it
/// has no foreign key to another campaign's tables.
pub const GIT_MIGRATION: Migration = Migration {
    version: 7,
    name: "git",
    sql: include_str!("../migrations/0007_git.sql"),
};

fn check_id(id: &str) -> Result<()> {
    if is_valid_id(id) {
        Ok(())
    } else {
        Err(KalError::validation("invalid_id", "That id isn't valid."))
    }
}

fn not_found(what: &'static str) -> KalError {
    KalError::new(
        kalcode_core::ErrorCategory::Git,
        what,
        "That item no longer exists.",
    )
}

// ---------- Worktrees ----------

const WORKTREE_COLUMNS: &str =
    "id, workspace_id, branch, base_commit, purpose, owner_ref, status, created_at, removed_at";

fn row_to_worktree(row: &Row<'_>) -> rusqlite::Result<Worktree> {
    let purpose: String = row.get(4)?;
    let status: String = row.get(6)?;
    Ok(Worktree {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        branch: row.get(2)?,
        base_commit: row.get(3)?,
        purpose: WorktreePurpose::parse(&purpose).unwrap_or(WorktreePurpose::User),
        owner_ref: row.get(5)?,
        status: WorktreeStatus::parse(&status).unwrap_or(WorktreeStatus::Abandoned),
        created_at: row.get(7)?,
        removed_at: row.get(8)?,
    })
}

pub fn insert_worktree(conn: &Connection, new: &NewWorktree) -> Result<Worktree> {
    check_id(&new.id)?;
    check_id(&new.workspace_id)?;
    let now = now_rfc3339();
    conn.execute(
        "INSERT INTO git_worktrees (id, workspace_id, path, branch, base_commit, purpose, owner_ref, status, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'active', ?8)",
        params![
            new.id,
            new.workspace_id,
            new.path.to_string_lossy(),
            new.branch,
            new.base_commit,
            new.purpose.as_str(),
            new.owner_ref,
            now
        ],
    )?;
    get_worktree(conn, &new.id)
}

pub fn get_worktree(conn: &Connection, id: &str) -> Result<Worktree> {
    check_id(id)?;
    conn.query_row(
        &format!("SELECT {WORKTREE_COLUMNS} FROM git_worktrees WHERE id = ?1"),
        [id],
        row_to_worktree,
    )
    .optional()?
    .ok_or_else(|| not_found("worktree_unknown"))
}

/// The native folder of a managed worktree (never sent to the WebView).
pub fn worktree_path(conn: &Connection, id: &str) -> Result<std::path::PathBuf> {
    check_id(id)?;
    let path: Option<String> = conn
        .query_row(
            "SELECT path FROM git_worktrees WHERE id = ?1",
            [id],
            |row| row.get(0),
        )
        .optional()?;
    path.map(std::path::PathBuf::from)
        .ok_or_else(|| not_found("worktree_unknown"))
}

/// Managed worktrees of a workspace, newest first (removed ones included unless filtered).
pub fn list_worktrees(
    conn: &Connection,
    workspace_id: &str,
    include_removed: bool,
) -> Result<Vec<Worktree>> {
    check_id(workspace_id)?;
    let mut stmt = conn.prepare(&format!(
        "SELECT {WORKTREE_COLUMNS} FROM git_worktrees
         WHERE workspace_id = ?1 AND (?2 OR status <> 'removed')
         ORDER BY created_at DESC, id DESC LIMIT 500"
    ))?;
    let rows = stmt.query_map(params![workspace_id, include_removed], row_to_worktree)?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

pub fn set_worktree_status(
    conn: &Connection,
    id: &str,
    status: WorktreeStatus,
) -> Result<Worktree> {
    check_id(id)?;
    let removed_at = (status == WorktreeStatus::Removed).then(now_rfc3339);
    let changed = conn.execute(
        "UPDATE git_worktrees SET status = ?2, removed_at = ?3 WHERE id = ?1",
        params![id, status.as_str(), removed_at],
    )?;
    if changed == 0 {
        return Err(not_found("worktree_unknown"));
    }
    get_worktree(conn, id)
}

// ---------- Checkpoints ----------

const CHECKPOINT_COLUMNS: &str = "id, workspace_id, commit_oid, parent_id, trigger, event_seq, files, bytes_added, pinned, created_at, pruned_at";

fn row_to_checkpoint(row: &Row<'_>) -> rusqlite::Result<Checkpoint> {
    let trigger: String = row.get(4)?;
    let files: i64 = row.get(6)?;
    let bytes: i64 = row.get(7)?;
    Ok(Checkpoint {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        commit_oid: row.get(2)?,
        parent_id: row.get(3)?,
        trigger: serde_json::from_str(&trigger).unwrap_or(CheckpointTrigger::User),
        event_seq: row.get(5)?,
        files: u32::try_from(files).unwrap_or(u32::MAX),
        bytes_added: u64::try_from(bytes).unwrap_or(0),
        pinned: row.get::<_, i64>(8)? != 0,
        created_at: row.get(9)?,
        pruned_at: row.get(10)?,
    })
}

/// Records a checkpoint the store just created. `parent_id` is the previous live checkpoint of
/// the workspace (looked up here); `event_seq` is the latest event sequence number.
pub fn insert_checkpoint(
    conn: &Connection,
    workspace_id: &str,
    created: &CreatedCheckpoint,
    trigger: &CheckpointTrigger,
    event_seq: i64,
    pinned: bool,
) -> Result<Checkpoint> {
    check_id(workspace_id)?;
    check_id(&created.id)?;
    let parent = latest_checkpoint(conn, workspace_id)?.map(|c| c.id);
    let trigger_json = serde_json::to_string(trigger).map_err(|e| {
        KalError::internal(
            "checkpoint_encode",
            "KalCode couldn't record the checkpoint.",
        )
        .with_source(e)
    })?;
    conn.execute(
        &format!(
            "INSERT INTO checkpoints ({CHECKPOINT_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL)"
        ),
        params![
            created.id,
            workspace_id,
            created.commit_oid,
            parent,
            trigger_json,
            event_seq.max(0),
            i64::from(created.files),
            i64::try_from(created.bytes_added).unwrap_or(i64::MAX),
            i64::from(pinned),
            now_rfc3339()
        ],
    )?;
    get_checkpoint(conn, &created.id)
}

pub fn get_checkpoint(conn: &Connection, id: &str) -> Result<Checkpoint> {
    check_id(id)?;
    conn.query_row(
        &format!("SELECT {CHECKPOINT_COLUMNS} FROM checkpoints WHERE id = ?1"),
        [id],
        row_to_checkpoint,
    )
    .optional()?
    .ok_or_else(|| not_found("checkpoint_unknown"))
}

/// The newest live (unpruned) checkpoint of a workspace.
pub fn latest_checkpoint(conn: &Connection, workspace_id: &str) -> Result<Option<Checkpoint>> {
    check_id(workspace_id)?;
    Ok(conn
        .query_row(
            &format!(
                "SELECT {CHECKPOINT_COLUMNS} FROM checkpoints
                 WHERE workspace_id = ?1 AND pruned_at IS NULL
                 ORDER BY created_at DESC, id DESC LIMIT 1"
            ),
            [workspace_id],
            row_to_checkpoint,
        )
        .optional()?)
}

/// Live checkpoints, newest first, paged by `(created_at, id)` keyset cursor.
pub fn list_checkpoints(
    conn: &Connection,
    workspace_id: &str,
    page: &PageRequest,
) -> Result<Page<Checkpoint>> {
    check_id(workspace_id)?;
    if page.limit == 0 || page.limit > crate::types::MAX_PAGE {
        return Err(KalError::validation(
            "invalid_page",
            "Page size must be between 1 and 500.",
        ));
    }
    // Checkpoint ids are UUIDv7 (time-ordered), so the id alone is a stable keyset cursor.
    if let Some(cursor) = &page.cursor {
        check_id(cursor)?;
    }
    let mut stmt = conn.prepare(&format!(
        "SELECT {CHECKPOINT_COLUMNS} FROM checkpoints
         WHERE workspace_id = ?1 AND pruned_at IS NULL AND (?2 IS NULL OR id < ?2)
         ORDER BY id DESC LIMIT ?3"
    ))?;
    let rows = stmt.query_map(
        params![workspace_id, page.cursor, i64::from(page.limit) + 1],
        row_to_checkpoint,
    )?;
    let mut items: Vec<Checkpoint> = rows.collect::<std::result::Result<_, _>>()?;
    let more = items.len() > page.limit as usize;
    items.truncate(page.limit as usize);
    Ok(Page {
        next_cursor: if more {
            items.last().map(|c| c.id.clone())
        } else {
            None
        },
        items,
        total_estimate: None,
    })
}

pub fn set_pinned(conn: &Connection, id: &str, pinned: bool) -> Result<Checkpoint> {
    check_id(id)?;
    let changed = conn.execute(
        "UPDATE checkpoints SET pinned = ?2 WHERE id = ?1 AND pruned_at IS NULL",
        params![id, i64::from(pinned)],
    )?;
    if changed == 0 {
        return Err(not_found("checkpoint_unknown"));
    }
    get_checkpoint(conn, id)
}

/// Unpinned live checkpoints, oldest first: what quota pruning may remove.
pub fn prune_candidates(conn: &Connection, workspace_id: &str) -> Result<Vec<String>> {
    check_id(workspace_id)?;
    let mut stmt = conn.prepare(
        "SELECT id FROM checkpoints WHERE workspace_id = ?1 AND pruned_at IS NULL AND pinned = 0
         ORDER BY id ASC",
    )?;
    let rows = stmt.query_map([workspace_id], |row| row.get(0))?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

pub fn mark_pruned(conn: &Connection, ids: &[String]) -> Result<usize> {
    let now = now_rfc3339();
    let mut changed = 0;
    for id in ids {
        check_id(id)?;
        changed += conn.execute(
            "UPDATE checkpoints SET pruned_at = ?2 WHERE id = ?1 AND pinned = 0 AND pruned_at IS NULL",
            params![id, now],
        )?;
    }
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use kalcode_contracts::ids::new_id;

    fn db() -> Connection {
        let mut conn = kalcode_core::db::open_in_memory().expect("db");
        let mut all = kalcode_core::db::MIGRATIONS.to_vec();
        // Fill the reserved gap so the gap-free runner on this branch accepts v7.
        for version in (all.len() as i64 + 1)..7 {
            all.push(Migration {
                version,
                name: "reserved",
                sql: "SELECT 1;",
            });
        }
        all.push(GIT_MIGRATION);
        kalcode_core::db::migrate(&mut conn, &all, None).expect("migrate");
        conn
    }

    fn created(id: &str) -> CreatedCheckpoint {
        CreatedCheckpoint {
            id: id.to_owned(),
            commit_oid: "a".repeat(40),
            tree_oid: "b".repeat(40),
            files: 3,
            bytes_added: 10,
            skipped_large: 0,
            user_head: None,
        }
    }

    #[test]
    fn migration_is_isolated_and_numbered_seven() {
        assert_eq!(GIT_MIGRATION.version, 7);
        assert!(
            kalcode_core::db::MIGRATIONS.iter().all(|m| m.version != 7),
            "v7 is registered by the lead at integration, not on this branch"
        );
    }

    #[test]
    fn checkpoints_round_trip_page_pin_and_prune() {
        let conn = db();
        let ws = new_id();
        let mut ids = Vec::new();
        for _ in 0..5 {
            let id = new_id();
            insert_checkpoint(
                &conn,
                &ws,
                &created(&id),
                &CheckpointTrigger::User,
                7,
                false,
            )
            .expect("insert");
            ids.push(id);
        }
        let second = get_checkpoint(&conn, &ids[1]).expect("get");
        assert_eq!(second.parent_id.as_deref(), Some(ids[0].as_str()));
        let first = list_checkpoints(
            &conn,
            &ws,
            &PageRequest {
                limit: 2,
                cursor: None,
            },
        )
        .expect("page");
        assert_eq!(
            first.items.iter().map(|c| c.id.clone()).collect::<Vec<_>>(),
            [ids[4].clone(), ids[3].clone()]
        );
        let next = list_checkpoints(
            &conn,
            &ws,
            &PageRequest {
                limit: 5,
                cursor: first.next_cursor.clone(),
            },
        )
        .expect("page");
        assert_eq!(next.items.len(), 3);
        assert_eq!(next.next_cursor, None);

        set_pinned(&conn, &ids[0], true).expect("pin");
        let candidates = prune_candidates(&conn, &ws).expect("candidates");
        assert_eq!(candidates, ids[1..].to_vec());
        assert_eq!(
            mark_pruned(&conn, &ids[..2]).expect("prune"),
            1,
            "pinned is never pruned"
        );
        assert!(
            get_checkpoint(&conn, &ids[1])
                .expect("get")
                .pruned_at
                .is_some()
        );
        assert!(
            set_pinned(&conn, &ids[1], true).is_err(),
            "pruned can't be pinned"
        );
        let latest = latest_checkpoint(&conn, &ws)
            .expect("latest")
            .expect("some");
        assert_eq!(latest.id, ids[4]);
    }

    #[test]
    fn database_refuses_inconsistent_rows() {
        let conn = db();
        let bad_oid = conn.execute(
            "INSERT INTO checkpoints (id, workspace_id, commit_oid, trigger, event_seq, files, bytes_added, created_at)
             VALUES (?1, ?2, 'short', '{}', 0, 0, 0, 'now')",
            params![new_id(), new_id()],
        );
        assert!(bad_oid.is_err());
        let bad_json = conn.execute(
            "INSERT INTO checkpoints (id, workspace_id, commit_oid, trigger, event_seq, files, bytes_added, created_at)
             VALUES (?1, ?2, ?3, 'not json', 0, 0, 0, 'now')",
            params![new_id(), new_id(), "a".repeat(40)],
        );
        assert!(bad_json.is_err());
        let removed_without_time = conn.execute(
            "INSERT INTO git_worktrees (id, workspace_id, path, branch, base_commit, purpose, status, created_at)
             VALUES (?1, ?2, '/x', 'b', ?3, 'task', 'removed', 'now')",
            params![new_id(), new_id(), "a".repeat(40)],
        );
        assert!(removed_without_time.is_err());
    }

    #[test]
    fn worktrees_round_trip() {
        let conn = db();
        let ws = new_id();
        let new = NewWorktree {
            id: new_id(),
            workspace_id: ws.clone(),
            path: std::path::PathBuf::from("/data/worktrees/x"),
            branch: "kal/task".into(),
            base_commit: "c".repeat(40),
            purpose: WorktreePurpose::Task,
            owner_ref: Some("task-1".into()),
        };
        let wt = insert_worktree(&conn, &new).expect("insert");
        assert_eq!(wt.status, WorktreeStatus::Active);
        assert_eq!(worktree_path(&conn, &wt.id).expect("path"), new.path);
        let removed = set_worktree_status(&conn, &wt.id, WorktreeStatus::Removed).expect("remove");
        assert!(removed.removed_at.is_some());
        assert!(list_worktrees(&conn, &ws, false).expect("list").is_empty());
        assert_eq!(list_worktrees(&conn, &ws, true).expect("list").len(), 1);
        assert!(insert_worktree(&conn, &new).is_err(), "path is unique");
    }
}
