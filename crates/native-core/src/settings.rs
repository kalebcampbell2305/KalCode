//! Typed, validated user settings persisted in the `settings` table (docs/DATA_MODEL.md).

use rusqlite::{Connection, Transaction, params};
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
}

const KEY_THEME: &str = "appearance.theme";
const KEY_MOTION: &str = "appearance.motion";
const KEY_DENSITY: &str = "appearance.density";
const KEY_SIDEBAR: &str = "layout.sidebarCollapsed";

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

    let now = now_rfc3339();
    for (key, value) in &changed {
        tx.execute(
            "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![key, value.to_string(), now],
        )?;
    }
    Ok((
        next,
        changed.into_iter().map(|(k, _)| k.to_owned()).collect(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

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
