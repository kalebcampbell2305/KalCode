//! SQL for the tables migration 0004 (schema v4) creates. Parameterized statements only. Every function
//! takes a connection or transaction supplied by `Core`, so callers decide atomicity.

use kalcode_contracts::permissions::{
    ApprovalDecision, ApprovalRequest, ApprovalStatus, NormalizedAction, PermissionMode,
    PermissionProfile, PermissionScope, PolicyDecision,
};
use kalcode_core::time::now_rfc3339;
use kalcode_core::{KalError, Result};
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::grants::{Grant, GrantKind};

/// Names shown in the approval prompt, captured when the request opens.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ApprovalContext {
    pub thread_name: Option<String>,
    pub workspace_name: Option<String>,
    pub provider_name: Option<String>,
}

/// An approval request as the UI shows it: the contract's `ApprovalRequest` plus the answers
/// the user may give, what a standing approval would cover, and display names.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ApprovalView {
    #[serde(flatten)]
    pub request: ApprovalRequest,
    pub allowed_decisions: Vec<ApprovalDecision>,
    /// What "Allow for thread / workspace" would cover ("changing any file in this workspace").
    pub grant_coverage: String,
    pub context: Option<ApprovalContext>,
    pub created_at: String,
    /// Why an expired request expired ("thread_stopped", "superseded", …).
    pub expire_reason: Option<String>,
}

/// Permission preferences.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PermissionSettings {
    /// The mode new threads start in. Every mode is available on every plan.
    pub default_mode: PermissionMode,
    /// The Custom profile new threads use when `default_mode` is Custom.
    pub default_profile_id: Option<String>,
}

impl Default for PermissionSettings {
    fn default() -> Self {
        Self {
            default_mode: PermissionMode::Approve,
            default_profile_id: None,
        }
    }
}

/// A stored approval plus the fields the service needs to act on it.
#[derive(Debug, Clone)]
pub struct StoredApproval {
    pub view: ApprovalView,
    pub fingerprint: String,
    pub grant_matcher: Option<String>,
}

pub struct NewApproval<'a> {
    pub id: &'a str,
    pub action: &'a NormalizedAction,
    pub decision: &'a PolicyDecision,
    pub mode: PermissionMode,
    pub allowed: &'a [ApprovalDecision],
    pub context: Option<&'a ApprovalContext>,
    pub fingerprint: &'a str,
    pub grant_matcher: Option<&'a str>,
    pub grant_coverage: &'a str,
}

fn json<T: Serialize>(value: &T) -> Result<String> {
    Ok(serde_json::to_string(value)?)
}

fn enum_str<T: Serialize>(value: &T) -> Result<String> {
    match serde_json::to_value(value)? {
        serde_json::Value::String(s) => Ok(s),
        _ => Err(KalError::internal(
            "serialization_failed",
            "Unexpected value.",
        )),
    }
}

fn parse_enum<T: for<'de> Deserialize<'de>>(text: &str) -> Result<T> {
    Ok(serde_json::from_value(serde_json::Value::String(
        text.to_owned(),
    ))?)
}

pub fn insert_approval(conn: &Connection, new: &NewApproval<'_>) -> Result<()> {
    conn.execute(
        "INSERT INTO approvals (id, origin_kind, origin_id, thread_id, workspace_id, provider_id, action_id,
           request, decision, allowed_decisions, context, fingerprint, grant_matcher, grant_coverage,
           permission_mode, status, created_at)
         VALUES (?1, 'thread', ?2, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 'pending', ?14)",
        params![
            new.id,
            new.action.thread_id,
            new.action.workspace_id,
            new.action.provider_id.as_str(),
            new.action.id,
            json(new.action)?,
            json(new.decision)?,
            json(&new.allowed)?,
            new.context.map(json).transpose()?,
            new.fingerprint,
            new.grant_matcher,
            new.grant_coverage,
            enum_str(&new.mode)?,
            now_rfc3339(),
        ],
    )?;
    Ok(())
}

const APPROVAL_COLUMNS: &str = "id, request, decision, permission_mode, status, resolved_decision, resolved_at,
    allowed_decisions, grant_coverage, context, created_at, expire_reason, fingerprint, grant_matcher";

struct RawApproval {
    id: String,
    request: String,
    decision: String,
    mode: String,
    status: String,
    resolved_decision: Option<String>,
    resolved_at: Option<String>,
    allowed: String,
    coverage: String,
    context: Option<String>,
    created_at: String,
    expire_reason: Option<String>,
    fingerprint: String,
    matcher: Option<String>,
}

fn row_to_approval(row: &Row<'_>) -> rusqlite::Result<RawApproval> {
    Ok(RawApproval {
        id: row.get(0)?,
        request: row.get(1)?,
        decision: row.get(2)?,
        mode: row.get(3)?,
        status: row.get(4)?,
        resolved_decision: row.get(5)?,
        resolved_at: row.get(6)?,
        allowed: row.get(7)?,
        coverage: row.get(8)?,
        context: row.get(9)?,
        created_at: row.get(10)?,
        expire_reason: row.get(11)?,
        fingerprint: row.get(12)?,
        matcher: row.get(13)?,
    })
}

fn build(raw: RawApproval) -> Result<StoredApproval> {
    Ok(StoredApproval {
        view: ApprovalView {
            request: ApprovalRequest {
                id: raw.id,
                action: serde_json::from_str(&raw.request)?,
                decision: serde_json::from_str(&raw.decision)?,
                permission_mode: parse_enum(&raw.mode)?,
                status: parse_enum(&raw.status)?,
                resolved_decision: raw
                    .resolved_decision
                    .as_deref()
                    .map(parse_enum)
                    .transpose()?,
                resolved_at: raw.resolved_at,
            },
            allowed_decisions: serde_json::from_str(&raw.allowed)?,
            grant_coverage: raw.coverage,
            context: raw
                .context
                .as_deref()
                .map(serde_json::from_str)
                .transpose()?,
            created_at: raw.created_at,
            expire_reason: raw.expire_reason,
        },
        fingerprint: raw.fingerprint,
        grant_matcher: raw.matcher,
    })
}

pub fn get_approval(conn: &Connection, id: &str) -> Result<Option<StoredApproval>> {
    let raw = conn
        .query_row(
            &format!("SELECT {APPROVAL_COLUMNS} FROM approvals WHERE id = ?1"),
            [id],
            row_to_approval,
        )
        .optional()?;
    raw.map(build).transpose()
}

pub fn list_approvals(
    conn: &Connection,
    status: Option<ApprovalStatus>,
    limit: u32,
) -> Result<Vec<ApprovalView>> {
    let status = status.map(|s| enum_str(&s)).transpose()?;
    let mut stmt = conn.prepare(&format!(
        "SELECT {APPROVAL_COLUMNS} FROM approvals WHERE (?1 IS NULL OR status = ?1)
         ORDER BY created_at DESC, id DESC LIMIT ?2"
    ))?;
    let rows = stmt.query_map(params![status, limit], row_to_approval)?;
    let mut out = Vec::new();
    for raw in rows {
        out.push(build(raw?)?.view);
    }
    Ok(out)
}

/// Resolves a pending request. Returns false when it was no longer pending (a concurrent
/// decision or an expiry got there first).
pub fn resolve_approval(
    conn: &Connection,
    id: &str,
    status: ApprovalStatus,
    decision: ApprovalDecision,
) -> Result<bool> {
    let changed = conn.execute(
        "UPDATE approvals SET status = ?2, resolved_decision = ?3, resolved_at = ?4, resolved_by = 'user'
         WHERE id = ?1 AND status = 'pending'",
        params![id, enum_str(&status)?, enum_str(&decision)?, now_rfc3339()],
    )?;
    Ok(changed == 1)
}

/// A request that was expired, with the ids needed for its event.
#[derive(Debug, Clone)]
pub struct Expired {
    pub id: String,
    pub thread_id: String,
    pub workspace_id: String,
    pub provider_id: String,
}

/// Expires pending requests matching the filter; returns what changed.
pub fn expire_pending(
    conn: &Connection,
    thread_id: Option<&str>,
    action_id: Option<&str>,
    reason: &str,
) -> Result<Vec<Expired>> {
    let mut stmt = conn.prepare(
        "SELECT id, COALESCE(thread_id, ''), COALESCE(workspace_id, ''), COALESCE(provider_id, '') FROM approvals
         WHERE status = 'pending' AND (?1 IS NULL OR thread_id = ?1) AND (?2 IS NULL OR action_id = ?2)",
    )?;
    let expired: Vec<Expired> = stmt
        .query_map(params![thread_id, action_id], |row| {
            Ok(Expired {
                id: row.get(0)?,
                thread_id: row.get(1)?,
                workspace_id: row.get(2)?,
                provider_id: row.get(3)?,
            })
        })?
        .collect::<std::result::Result<_, _>>()?;
    let now = now_rfc3339();
    for item in &expired {
        conn.execute(
            "UPDATE approvals SET status = 'expired', resolved_at = ?2, resolved_by = 'system', expire_reason = ?3
             WHERE id = ?1 AND status = 'pending'",
            params![item.id, now, reason],
        )?;
    }
    Ok(expired)
}

pub fn insert_grant(conn: &Connection, grant: &Grant, source_request_id: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO permission_grants (id, kind, thread_id, workspace_id, scopes, fingerprint, matcher,
           source_request_id, created_at, expires_at_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            grant.id,
            grant.kind.as_str(),
            grant.thread_id,
            grant.workspace_id,
            json(&grant.scopes)?,
            grant.fingerprint,
            grant.matcher,
            source_request_id,
            now_rfc3339(),
            grant.expires_at_ms,
        ],
    )?;
    Ok(())
}

/// Unrevoked, unexpired grants relevant to a thread in a workspace, plus every rule grant.
pub fn active_grants(
    conn: &Connection,
    thread_id: &str,
    workspace_id: &str,
    now_ms: i64,
) -> Result<Vec<Grant>> {
    let mut stmt = conn.prepare(
        "SELECT id, kind, thread_id, workspace_id, scopes, fingerprint, matcher, expires_at_ms
         FROM permission_grants
         WHERE revoked_at IS NULL AND (expires_at_ms IS NULL OR expires_at_ms > ?3)
           AND ((kind = 'thread' AND thread_id = ?1 AND workspace_id = ?2)
             OR (kind = 'workspace' AND workspace_id = ?2)
             OR kind = 'rule')",
    )?;
    let rows = stmt.query_map(params![thread_id, workspace_id, now_ms], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, Option<String>>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, String>(5)?,
            row.get::<_, Option<String>>(6)?,
            row.get::<_, Option<i64>>(7)?,
        ))
    })?;
    let mut grants = Vec::new();
    for row in rows {
        let (id, kind, thread_id, workspace_id, scopes, fingerprint, matcher, expires_at_ms) = row?;
        let Some(kind) = GrantKind::parse(&kind) else {
            continue;
        };
        let scopes: Vec<PermissionScope> = serde_json::from_str(&scopes)?;
        grants.push(Grant {
            id,
            kind,
            thread_id,
            workspace_id,
            scopes,
            fingerprint,
            matcher,
            expires_at_ms,
        });
    }
    Ok(grants)
}

/// Revokes the unrevoked thread grants of a thread; returns their ids.
pub fn revoke_thread_grants(
    conn: &Connection,
    thread_id: &str,
    reason: &str,
) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT id FROM permission_grants WHERE kind = 'thread' AND thread_id = ?1 AND revoked_at IS NULL",
    )?;
    let ids: Vec<String> = stmt
        .query_map([thread_id], |row| row.get(0))?
        .collect::<std::result::Result<_, _>>()?;
    let now = now_rfc3339();
    for id in &ids {
        conn.execute(
            "UPDATE permission_grants SET revoked_at = ?2, revoke_reason = ?3 WHERE id = ?1 AND revoked_at IS NULL",
            params![id, now, reason],
        )?;
    }
    Ok(ids)
}

pub struct AuditEntry<'a> {
    pub kind: &'a str,
    pub actor: &'a str,
    pub thread_id: Option<&'a str>,
    pub workspace_id: Option<&'a str>,
    pub request_id: Option<&'a str>,
    pub detail: serde_json::Value,
}

pub fn audit(conn: &Connection, entry: &AuditEntry<'_>) -> Result<()> {
    conn.execute(
        "INSERT INTO permission_audit (id, occurred_at, kind, actor, thread_id, workspace_id, request_id, detail)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            kalcode_contracts::ids::new_id(),
            now_rfc3339(),
            entry.kind,
            entry.actor,
            entry.thread_id,
            entry.workspace_id,
            entry.request_id,
            entry.detail.to_string(),
        ],
    )?;
    Ok(())
}

/// One audit row, for tests and diagnostics.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuditRow {
    pub kind: String,
    pub actor: String,
    pub thread_id: Option<String>,
    pub request_id: Option<String>,
    pub detail: String,
}

pub fn audit_rows(conn: &Connection) -> Result<Vec<AuditRow>> {
    let mut stmt = conn.prepare(
        "SELECT kind, actor, thread_id, request_id, detail FROM permission_audit ORDER BY seq",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(AuditRow {
            kind: row.get(0)?,
            actor: row.get(1)?,
            thread_id: row.get(2)?,
            request_id: row.get(3)?,
            detail: row.get(4)?,
        })
    })?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

const SETTINGS_KEY: &str = "defaults";

pub fn load_settings(conn: &Connection) -> Result<PermissionSettings> {
    let value: Option<String> = conn
        .query_row(
            "SELECT value FROM permission_settings WHERE key = ?1",
            [SETTINGS_KEY],
            |row| row.get(0),
        )
        .optional()?;
    Ok(match value {
        Some(text) => serde_json::from_str(&text).unwrap_or_else(|error| {
            tracing::warn!(event = "permissions.settings_invalid", error = %error);
            PermissionSettings::default()
        }),
        None => PermissionSettings::default(),
    })
}

pub fn save_settings(conn: &Connection, settings: &PermissionSettings) -> Result<()> {
    conn.execute(
        "INSERT INTO permission_settings (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![SETTINGS_KEY, json(settings)?, now_rfc3339()],
    )?;
    Ok(())
}

pub fn stored_profiles(conn: &Connection) -> Result<Vec<PermissionProfile>> {
    let mut stmt =
        conn.prepare("SELECT id, name, base_mode, rules FROM permission_profiles ORDER BY name")?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (id, name, mode, rules) = row?;
        match (
            parse_enum::<PermissionMode>(&mode),
            serde_json::from_str(&rules),
        ) {
            (Ok(mode), Ok(rules)) => out.push(PermissionProfile {
                id,
                name,
                mode,
                rules,
                builtin: false,
            }),
            _ => tracing::warn!(event = "permissions.profile_invalid", profile_id = %id),
        }
    }
    Ok(out)
}

/// Saves a custom profile (used by tests and the future profile editor).
pub fn save_profile(conn: &Connection, profile: &PermissionProfile) -> Result<()> {
    let now = now_rfc3339();
    conn.execute(
        "INSERT INTO permission_profiles (id, name, base_mode, rules, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, base_mode = excluded.base_mode,
           rules = excluded.rules, updated_at = excluded.updated_at",
        params![
            profile.id,
            profile.name,
            enum_str(&profile.mode)?,
            json(&profile.rules)?,
            now
        ],
    )?;
    Ok(())
}
