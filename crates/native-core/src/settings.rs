//! Typed, validated user settings persisted in the `settings` table (docs/DATA_MODEL.md).

use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use crate::error::{KalError, Result};
use crate::time::now_rfc3339;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ThemePreference {
    #[default]
    System,
    Light,
    Dark,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum MotionPreference {
    #[default]
    System,
    Reduced,
    Full,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum Density {
    #[default]
    Comfortable,
    Compact,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Settings {
    pub theme: ThemePreference,
    pub motion: MotionPreference,
    pub density: Density,
    pub sidebar_collapsed: bool,
    /// The name the returning-user home greets (`profile.displayName`, Z7-W2). Set only by the
    /// user in Settings; KalCode never reads the operating system's account name. `None` when
    /// unset (the home then says "Welcome back."); omitted from the JSON then, so the field is
    /// optional for every consumer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub display_name: Option<String>,
}

/// A partial update. Unknown fields are rejected.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct SettingsPatch {
    #[ts(optional)]
    pub theme: Option<ThemePreference>,
    #[ts(optional)]
    pub motion: Option<MotionPreference>,
    #[ts(optional)]
    pub density: Option<Density>,
    #[ts(optional)]
    pub sidebar_collapsed: Option<bool>,
    /// 1–60 characters without control characters; an empty (or all-space) value clears it.
    #[ts(optional)]
    pub display_name: Option<String>,
}

/// Longest display name, in characters (`profile.displayName`, ADVANCED.md §16.4).
pub const DISPLAY_NAME_MAX_CHARS: usize = 60;

/// Validates and normalizes a display name: trimmed; `None` for an empty value (clears the
/// setting); refused when longer than [`DISPLAY_NAME_MAX_CHARS`] or when it contains control,
/// bidirectional-override or zero-width characters (the name is shown verbatim in the UI).
pub fn normalize_display_name(raw: &str) -> Result<Option<String>> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.chars().count() > DISPLAY_NAME_MAX_CHARS {
        return Err(KalError::validation(
            "display_name_too_long",
            "Your display name can be at most 60 characters.",
        ));
    }
    let forbidden = |c: char| {
        c.is_control()
            || matches!(
                c,
                '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}'
            )
    };
    if trimmed.chars().any(forbidden) {
        return Err(KalError::validation(
            "display_name_invalid",
            "Your display name can't contain control or invisible formatting characters.",
        ));
    }
    Ok(Some(trimmed.to_owned()))
}

const KEY_THEME: &str = "appearance.theme";
const KEY_MOTION: &str = "appearance.motion";
const KEY_DENSITY: &str = "appearance.density";
const KEY_SIDEBAR: &str = "layout.sidebarCollapsed";
const KEY_DISPLAY_NAME: &str = "profile.displayName";

/// Reads settings. Unknown keys are ignored; invalid stored values fall back to defaults.
pub fn load(conn: &Connection) -> Result<Settings> {
    let mut settings = Settings::default();
    let mut stmt = conn.prepare("SELECT key, value FROM settings")?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    for row in rows {
        let (key, raw) = row?;
        let Ok(value) = serde_json::from_str::<Value>(&raw) else {
            tracing::warn!(event = "settings.invalid_value", key = %key);
            continue;
        };
        let applied = match key.as_str() {
            KEY_THEME => serde_json::from_value(value)
                .map(|v| settings.theme = v)
                .is_ok(),
            KEY_MOTION => serde_json::from_value(value)
                .map(|v| settings.motion = v)
                .is_ok(),
            KEY_DENSITY => serde_json::from_value(value)
                .map(|v| settings.density = v)
                .is_ok(),
            KEY_SIDEBAR => serde_json::from_value(value)
                .map(|v| settings.sidebar_collapsed = v)
                .is_ok(),
            // A stored name that no longer validates is ignored, like any invalid value.
            KEY_DISPLAY_NAME => serde_json::from_value::<String>(value)
                .ok()
                .and_then(|name| normalize_display_name(&name).ok())
                .map(|name| settings.display_name = name)
                .is_some(),
            _ => true, // written by a newer build; keep but ignore
        };
        if !applied {
            tracing::warn!(event = "settings.invalid_value", key = %key);
        }
    }
    Ok(settings)
}

/// Applies a patch in one transaction. Returns the new settings and the keys that changed.
/// Applies a patch inside the caller's transaction (so the caller can record the matching
/// event atomically). Returns the new settings and the keys that changed.
pub fn apply(tx: &Transaction<'_>, patch: &SettingsPatch) -> Result<(Settings, Vec<String>)> {
    if *patch == SettingsPatch::default() {
        return Err(KalError::validation(
            "empty_settings_patch",
            "No settings were provided to update.",
        ));
    }
    let current = load(tx)?;
    let mut next = current.clone();
    let mut changed: Vec<(&'static str, Value)> = Vec::new();

    if let Some(v) = patch.theme.filter(|v| *v != current.theme) {
        next.theme = v;
        changed.push((KEY_THEME, serde_json::to_value(v)?));
    }
    if let Some(v) = patch.motion.filter(|v| *v != current.motion) {
        next.motion = v;
        changed.push((KEY_MOTION, serde_json::to_value(v)?));
    }
    if let Some(v) = patch.density.filter(|v| *v != current.density) {
        next.density = v;
        changed.push((KEY_DENSITY, serde_json::to_value(v)?));
    }
    if let Some(v) = patch
        .sidebar_collapsed
        .filter(|v| *v != current.sidebar_collapsed)
    {
        next.sidebar_collapsed = v;
        changed.push((KEY_SIDEBAR, Value::Bool(v)));
    }
    // Validated before anything is written; clearing deletes the stored value.
    let mut clear_display_name = false;
    if let Some(raw) = &patch.display_name {
        let name = normalize_display_name(raw)?;
        if name != current.display_name {
            match &name {
                Some(name) => changed.push((KEY_DISPLAY_NAME, Value::String(name.clone()))),
                None => clear_display_name = true,
            }
            next.display_name = name;
        }
    }

    let now = now_rfc3339();
    if clear_display_name {
        tx.execute("DELETE FROM settings WHERE key = ?1", [KEY_DISPLAY_NAME])?;
    }
    for (key, value) in &changed {
        tx.execute(
            "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![key, value.to_string(), now],
        )?;
    }
    let mut keys: Vec<String> = changed.into_iter().map(|(k, _)| k.to_owned()).collect();
    if clear_display_name {
        keys.push(KEY_DISPLAY_NAME.to_owned());
    }
    Ok((next, keys))
}

/// Key prefixes for KalCode's own remembered UI state kept in the `settings` table: the home
/// greeting history and visit watermark, the rail's collapsed sections (Z7-W2). They are not
/// user settings: [`load`] ignores them and they never emit `settings.changed`.
const STATE_PREFIXES: [&str; 2] = ["home.", "rail."];

fn check_state_key(key: &str) -> Result<()> {
    if key.len() <= 64 && STATE_PREFIXES.iter().any(|p| key.starts_with(p)) {
        Ok(())
    } else {
        Err(KalError::internal(
            "state_key_invalid",
            "KalCode tried to remember an unknown kind of state.",
        ))
    }
}

/// Reads remembered UI state (`home.*`, `rail.*`). An unreadable value reads as absent.
pub fn state_get(conn: &Connection, key: &str) -> Result<Option<Value>> {
    check_state_key(key)?;
    let raw: Option<String> = conn
        .query_row("SELECT value FROM settings WHERE key = ?1", [key], |row| {
            row.get(0)
        })
        .optional()?;
    Ok(raw.and_then(|raw| serde_json::from_str(&raw).ok()))
}

/// Writes remembered UI state (`home.*`, `rail.*`).
pub fn state_set(conn: &Connection, key: &str, value: &Value) -> Result<()> {
    check_state_key(key)?;
    conn.execute(
        "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![key, value.to_string(), now_rfc3339()],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    #[test]
    fn display_name_is_validated_persisted_and_cleared() {
        let mut conn = conn();
        let set = |name: &str| SettingsPatch {
            display_name: Some(name.to_owned()),
            ..Default::default()
        };
        let (settings, keys) = apply_committed(&mut conn, &set("  Kaleb  ")).expect("set");
        assert_eq!(settings.display_name.as_deref(), Some("Kaleb"));
        assert_eq!(keys, vec![KEY_DISPLAY_NAME.to_owned()]);
        assert_eq!(
            load(&conn).expect("reload").display_name.as_deref(),
            Some("Kaleb")
        );

        let (_, keys) = apply_committed(&mut conn, &set("Kaleb")).expect("same");
        assert!(keys.is_empty(), "an unchanged name reports no change");

        let long = "x".repeat(61);
        for bad in [
            long.as_str(),
            "Ka\u{0007}leb",
            "Ka\u{202E}leb",
            "a\nb",
            "a\u{200B}b",
        ] {
            let err = apply_committed(&mut conn, &set(bad)).expect_err("invalid");
            assert!(
                err.code.starts_with("display_name_"),
                "{bad:?}: {}",
                err.code
            );
        }
        assert_eq!(
            load(&conn).expect("kept").display_name.as_deref(),
            Some("Kaleb")
        );
        let sixty = "é".repeat(60);
        apply_committed(&mut conn, &set(&sixty)).expect("60 characters are allowed");

        let (settings, keys) = apply_committed(&mut conn, &set("   ")).expect("clear");
        assert_eq!(settings.display_name, None);
        assert_eq!(keys, vec![KEY_DISPLAY_NAME.to_owned()]);
        assert_eq!(load(&conn).expect("cleared").display_name, None);
        let rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM settings WHERE key = 'profile.displayName'",
                [],
                |r| r.get(0),
            )
            .expect("count");
        assert_eq!(rows, 0, "clearing removes the stored value");
    }

    #[test]
    fn remembered_state_is_scoped_and_not_a_setting() {
        let conn = conn();
        let value = serde_json::json!({ "history": ["a", "b"] });
        state_set(&conn, "home.greetingHistory", &value).expect("set");
        assert_eq!(
            state_get(&conn, "home.greetingHistory").expect("get"),
            Some(value)
        );
        assert_eq!(state_get(&conn, "rail.none").expect("absent"), None);
        assert!(state_set(&conn, "appearance.theme", &Value::Null).is_err());
        assert!(state_get(&conn, "profile.displayName").is_err());
        assert_eq!(load(&conn).expect("load"), Settings::default());
    }

    fn apply_committed(
        conn: &mut Connection,
        patch: &SettingsPatch,
    ) -> Result<(Settings, Vec<String>)> {
        let tx = conn.transaction()?;
        let result = apply(&tx, patch)?;
        tx.commit()?;
        Ok(result)
    }

    fn conn() -> Connection {
        let mut conn = db::open_in_memory().expect("open");
        db::migrate(&mut conn, db::MIGRATIONS, None).expect("migrate");
        conn
    }

    #[test]
    fn defaults_when_empty() {
        assert_eq!(load(&conn()).expect("load"), Settings::default());
    }

    #[test]
    fn apply_persists_and_reports_changed_keys() {
        let mut conn = conn();
        let patch = SettingsPatch {
            theme: Some(ThemePreference::Dark),
            density: Some(Density::Compact),
            ..Default::default()
        };
        let (settings, keys) = apply_committed(&mut conn, &patch).expect("apply");
        assert_eq!(settings.theme, ThemePreference::Dark);
        assert_eq!(keys, vec![KEY_THEME.to_owned(), KEY_DENSITY.to_owned()]);
        assert_eq!(load(&conn).expect("reload"), settings);
    }

    #[test]
    fn unchanged_values_report_no_keys() {
        let mut conn = conn();
        let patch = SettingsPatch {
            theme: Some(ThemePreference::System),
            ..Default::default()
        };
        let (_, keys) = apply_committed(&mut conn, &patch).expect("apply");
        assert!(keys.is_empty());
    }

    #[test]
    fn empty_patch_is_rejected() {
        let err = apply_committed(&mut conn(), &SettingsPatch::default()).expect_err("empty");
        assert_eq!(err.code, "empty_settings_patch");
    }

    #[test]
    fn invalid_and_unknown_stored_values_fall_back() {
        let conn = conn();
        conn.execute("INSERT INTO settings (key, value, updated_at) VALUES ('appearance.theme', '\"neon\"', 'x')", [])
            .expect("insert");
        conn.execute(
            "INSERT INTO settings (key, value, updated_at) VALUES ('future.key', '42', 'x')",
            [],
        )
        .expect("insert");
        assert_eq!(load(&conn).expect("load"), Settings::default());
    }

    #[test]
    fn patch_rejects_unknown_fields() {
        let result: std::result::Result<SettingsPatch, _> =
            serde_json::from_str(r#"{"theme":"dark","telemetry":true}"#);
        assert!(result.is_err());
        let ok: SettingsPatch =
            serde_json::from_str(r#"{"sidebarCollapsed":true}"#).expect("parse");
        assert_eq!(ok.sidebar_collapsed, Some(true));
    }
}
