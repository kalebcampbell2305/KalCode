//! KalVoice preferences (table `kalvoice_preferences`): shortcuts, the reasoning provider
//! ("KalVoice intelligence"), the speech model and spoken replies.

use kalcode_contracts::agent::ProviderId;
use kalcode_contracts::kalvoice::KalVoiceIntelligence;
use kalcode_core::time::now_rfc3339;
use kalcode_core::{KalError, Result};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use crate::models;
use crate::shortcuts;

/// Where the floating KalVoice panel sits: docked to an edge or corner, or placed freely.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum PanelAnchor {
    Free,
    TopLeft,
    Top,
    TopRight,
    Left,
    Right,
    BottomLeft,
    Bottom,
    BottomRight,
}

/// How much of the panel is shown.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum PanelView {
    /// The orb only.
    Orb,
    /// Orb, name, state line and waveform.
    Compact,
    /// Compact plus the request box and results.
    Expanded,
}

/// Window width classes; the panel remembers a placement for each.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum SizeClass {
    Narrow,
    Regular,
    Wide,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PanelPlacement {
    pub size_class: SizeClass,
    pub anchor: PanelAnchor,
    /// Free position of the panel's top-left corner in thousandths (0–1000) of the space the
    /// panel can move in, so it stays in proportion when the window is resized.
    pub x: u16,
    pub y: u16,
    pub view: PanelView,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct KalVoicePreferences {
    /// Hold to dictate. Canonical accelerator, e.g. `CommandOrControl+Shift+Space`.
    pub dictation_shortcut: String,
    /// Press to open the command bar.
    pub command_shortcut: String,
    /// Which connected provider handles requests that need reasoning. `None` = automatic: the
    /// only connected provider, if exactly one is connected.
    pub intelligence: Option<KalVoiceIntelligence>,
    /// Speech model id from the catalog (`base.en` by default).
    pub speech_model: String,
    /// Speak short replies with the operating system's speech synthesis. Off by default.
    pub voice_replies: bool,
    /// Where the floating panel starts in a window size class it hasn't been placed in.
    pub panel_default: PanelAnchor,
    /// Whether the floating panel is shown (it reopens with the command shortcut).
    pub panel_visible: bool,
    /// Remembered placement per window size class.
    pub panel_placements: Vec<PanelPlacement>,
}

impl Default for KalVoicePreferences {
    fn default() -> Self {
        Self {
            dictation_shortcut: shortcuts::DEFAULT_DICTATION.to_owned(),
            command_shortcut: shortcuts::DEFAULT_COMMAND.to_owned(),
            intelligence: None,
            speech_model: models::DEFAULT_MODEL.to_owned(),
            voice_replies: false,
            panel_default: PanelAnchor::BottomRight,
            panel_visible: true,
            panel_placements: Vec::new(),
        }
    }
}

/// A partial update. Unknown fields are rejected.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct KalVoicePreferencesPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dictation_shortcut: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub command_shortcut: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub intelligence: Option<IntelligenceChoice>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub speech_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub voice_replies: Option<bool>,
    /// Also forgets remembered placements, so the panel moves to the new default.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub panel_default: Option<PanelAnchor>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub panel_visible: Option<bool>,
    /// Saves the placement for one window size class.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub panel_placement: Option<PanelPlacement>,
}

/// The reasoning provider a user picks in Settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum IntelligenceChoice {
    /// The only connected provider, if exactly one is connected.
    Automatic,
    Provider {
        provider_id: ProviderId,
    },
    /// On-device reasoning (not available yet; selecting it explains that).
    Local,
}

impl IntelligenceChoice {
    fn into_selection(self) -> Option<KalVoiceIntelligence> {
        match self {
            Self::Automatic => None,
            Self::Provider { provider_id } => Some(KalVoiceIntelligence::Provider { provider_id }),
            Self::Local => Some(KalVoiceIntelligence::Local),
        }
    }
}

const KEY_DICTATION: &str = "dictationShortcut";
const KEY_COMMAND: &str = "commandShortcut";
const KEY_INTELLIGENCE: &str = "intelligence";
const KEY_MODEL: &str = "speechModel";
const KEY_REPLIES: &str = "voiceReplies";
const KEY_PANEL_DEFAULT: &str = "panelDefault";
const KEY_PANEL_VISIBLE: &str = "panelVisible";
const KEY_PANEL_PLACEMENTS: &str = "panelPlacements";

/// Reads preferences; missing or invalid stored values fall back to defaults.
pub fn load(conn: &Connection) -> Result<KalVoicePreferences> {
    let mut prefs = KalVoicePreferences::default();
    let mut stmt = conn.prepare("SELECT key, value FROM kalvoice_preferences")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    for row in rows {
        let (key, raw) = row?;
        let Ok(value) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        let ok = match key.as_str() {
            KEY_DICTATION => serde_json::from_value::<String>(value)
                .ok()
                .and_then(|v| shortcuts::canonicalize(&v).ok())
                .map(|v| prefs.dictation_shortcut = v)
                .is_some(),
            KEY_COMMAND => serde_json::from_value::<String>(value)
                .ok()
                .and_then(|v| shortcuts::canonicalize(&v).ok())
                .map(|v| prefs.command_shortcut = v)
                .is_some(),
            KEY_INTELLIGENCE => serde_json::from_value(value)
                .map(|v| prefs.intelligence = v)
                .is_ok(),
            KEY_MODEL => serde_json::from_value::<String>(value)
                .ok()
                .filter(|v| models::find(v).is_some())
                .map(|v| prefs.speech_model = v)
                .is_some(),
            KEY_REPLIES => serde_json::from_value(value)
                .map(|v| prefs.voice_replies = v)
                .is_ok(),
            KEY_PANEL_DEFAULT => serde_json::from_value(value)
                .map(|v| prefs.panel_default = v)
                .is_ok(),
            KEY_PANEL_VISIBLE => serde_json::from_value(value)
                .map(|v| prefs.panel_visible = v)
                .is_ok(),
            KEY_PANEL_PLACEMENTS => serde_json::from_value::<Vec<PanelPlacement>>(value)
                .map(|v| prefs.panel_placements = normalize_placements(v))
                .is_ok(),
            _ => true,
        };
        if !ok {
            tracing::warn!(event = "kalvoice.preference_invalid", key = %key);
        }
    }
    Ok(prefs)
}

/// What changed in an update, for events.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Changes {
    /// Setting keys, namespaced for `settings.changed` (`kalvoice.dictationShortcut`).
    pub keys: Vec<String>,
    /// Set when the reasoning provider selection changed.
    pub intelligence: Option<Option<KalVoiceIntelligence>>,
}

/// Validates and applies a patch inside the caller's transaction.
pub fn apply(
    conn: &Connection,
    patch: &KalVoicePreferencesPatch,
) -> Result<(KalVoicePreferences, Changes)> {
    if *patch == KalVoicePreferencesPatch::default() {
        return Err(KalError::validation(
            "empty_preferences_patch",
            "No KalVoice preferences were provided to update.",
        ));
    }
    let current = load(conn)?;
    let mut next = current.clone();
    if let Some(v) = &patch.dictation_shortcut {
        next.dictation_shortcut = v.clone();
    }
    if let Some(v) = &patch.command_shortcut {
        next.command_shortcut = v.clone();
    }
    // Validate both against each other after applying the patch, so swapping works.
    next.dictation_shortcut =
        shortcuts::validate(&next.dictation_shortcut, Some(&next.command_shortcut))
            .map_err(problem)?;
    next.command_shortcut =
        shortcuts::validate(&next.command_shortcut, Some(&next.dictation_shortcut))
            .map_err(problem)?;
    if let Some(choice) = &patch.intelligence {
        let intelligence = choice.clone().into_selection();
        if let Some(KalVoiceIntelligence::Provider { provider_id }) = &intelligence {
            let id = provider_id.as_str();
            let valid = !id.is_empty()
                && id.len() <= 64
                && id
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
            if !valid {
                return Err(KalError::validation(
                    "invalid_provider",
                    "That provider isn't recognized.",
                ));
            }
        }
        next.intelligence = intelligence;
    }
    if let Some(model) = &patch.speech_model {
        if models::find(model).is_none() {
            return Err(KalError::validation(
                "unknown_speech_model",
                "That speech model isn't in KalVoice's catalog.",
            ));
        }
        next.speech_model = model.clone();
    }
    if let Some(v) = patch.voice_replies {
        next.voice_replies = v;
    }
    if let Some(anchor) = patch.panel_default {
        next.panel_default = anchor;
        next.panel_placements.clear();
    }
    if let Some(v) = patch.panel_visible {
        next.panel_visible = v;
    }
    if let Some(placement) = patch.panel_placement {
        if placement.x > 1000 || placement.y > 1000 {
            return Err(KalError::validation(
                "invalid_panel_position",
                "The KalVoice panel position is out of range.",
            ));
        }
        next.panel_placements
            .retain(|p| p.size_class != placement.size_class);
        next.panel_placements.push(placement);
        next.panel_placements = normalize_placements(std::mem::take(&mut next.panel_placements));
    }

    let mut changes = Changes::default();
    let mut writes: Vec<(&str, Value)> = Vec::new();
    if next.dictation_shortcut != current.dictation_shortcut {
        writes.push((
            KEY_DICTATION,
            Value::String(next.dictation_shortcut.clone()),
        ));
    }
    if next.command_shortcut != current.command_shortcut {
        writes.push((KEY_COMMAND, Value::String(next.command_shortcut.clone())));
    }
    if next.intelligence != current.intelligence {
        writes.push((KEY_INTELLIGENCE, serde_json::to_value(&next.intelligence)?));
        changes.intelligence = Some(next.intelligence.clone());
    }
    if next.speech_model != current.speech_model {
        writes.push((KEY_MODEL, Value::String(next.speech_model.clone())));
    }
    if next.voice_replies != current.voice_replies {
        writes.push((KEY_REPLIES, Value::Bool(next.voice_replies)));
    }
    if next.panel_default != current.panel_default {
        writes.push((KEY_PANEL_DEFAULT, serde_json::to_value(next.panel_default)?));
    }
    if next.panel_visible != current.panel_visible {
        writes.push((KEY_PANEL_VISIBLE, Value::Bool(next.panel_visible)));
    }
    if next.panel_placements != current.panel_placements {
        writes.push((
            KEY_PANEL_PLACEMENTS,
            serde_json::to_value(&next.panel_placements)?,
        ));
    }
    let now = now_rfc3339();
    for (key, value) in &writes {
        conn.execute(
            "INSERT INTO kalvoice_preferences (key, value, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![key, value.to_string(), now],
        )?;
        changes.keys.push(format!("kalvoice.{key}"));
    }
    Ok((next, changes))
}

/// One placement per size class, positions clamped, in a stable order.
fn normalize_placements(mut placements: Vec<PanelPlacement>) -> Vec<PanelPlacement> {
    let mut seen = Vec::new();
    placements.retain(|p| {
        let fresh = !seen.contains(&p.size_class);
        seen.push(p.size_class);
        fresh
    });
    for p in &mut placements {
        p.x = p.x.min(1000);
        p.y = p.y.min(1000);
    }
    placements.sort_by_key(|p| p.size_class as u8);
    placements
}

fn problem(p: shortcuts::ShortcutProblem) -> KalError {
    KalError::validation(p.code, p.message)
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

    #[test]
    fn defaults() {
        let prefs = load(&conn()).expect("load");
        assert_eq!(prefs.dictation_shortcut, "CommandOrControl+Shift+Space");
        assert_eq!(prefs.command_shortcut, "CommandOrControl+Shift+K");
        assert_eq!(prefs.intelligence, None);
        assert_eq!(prefs.speech_model, "base.en");
        assert!(!prefs.voice_replies);
    }

    #[test]
    fn apply_persists_and_reports_changes() {
        let conn = conn();
        let patch = KalVoicePreferencesPatch {
            command_shortcut: Some("ctrl+alt+j".into()),
            intelligence: Some(IntelligenceChoice::Provider {
                provider_id: ProviderId::new(ProviderId::CODEX),
            }),
            voice_replies: Some(true),
            ..Default::default()
        };
        let (prefs, changes) = apply(&conn, &patch).expect("apply");
        assert_eq!(prefs.command_shortcut, "CommandOrControl+Alt+J");
        assert_eq!(
            changes.keys,
            vec![
                "kalvoice.commandShortcut",
                "kalvoice.intelligence",
                "kalvoice.voiceReplies"
            ]
        );
        assert!(changes.intelligence.is_some());
        assert_eq!(load(&conn).expect("reload"), prefs);

        // Back to automatic.
        let (prefs, changes) = apply(
            &conn,
            &KalVoicePreferencesPatch {
                intelligence: Some(IntelligenceChoice::Automatic),
                ..Default::default()
            },
        )
        .expect("apply");
        assert_eq!(prefs.intelligence, None);
        assert_eq!(changes.intelligence, Some(None));
    }

    #[test]
    fn shortcut_conflicts_are_refused_and_nothing_is_saved() {
        let conn = conn();
        for (patch, code) in [
            (
                KalVoicePreferencesPatch {
                    command_shortcut: Some("Ctrl+K".into()),
                    ..Default::default()
                },
                "shortcut_conflict",
            ),
            (
                KalVoicePreferencesPatch {
                    command_shortcut: Some("Ctrl+Shift+Space".into()),
                    ..Default::default()
                },
                "shortcut_conflict",
            ),
            (
                KalVoicePreferencesPatch {
                    dictation_shortcut: Some("Shift+D".into()),
                    ..Default::default()
                },
                "shortcut_needs_modifier",
            ),
        ] {
            assert_eq!(apply(&conn, &patch).expect_err("conflict").code, code);
        }
        assert_eq!(load(&conn).expect("load"), KalVoicePreferences::default());
    }

    #[test]
    fn swapping_the_two_shortcuts_in_one_update_is_allowed() {
        let conn = conn();
        let (prefs, _) = apply(
            &conn,
            &KalVoicePreferencesPatch {
                dictation_shortcut: Some(shortcuts::DEFAULT_COMMAND.into()),
                command_shortcut: Some(shortcuts::DEFAULT_DICTATION.into()),
                ..Default::default()
            },
        )
        .expect("swap");
        assert_eq!(prefs.dictation_shortcut, shortcuts::DEFAULT_COMMAND);
    }

    #[test]
    fn invalid_values_are_refused() {
        let conn = conn();
        let err = apply(
            &conn,
            &KalVoicePreferencesPatch {
                speech_model: Some("../../evil".into()),
                ..Default::default()
            },
        )
        .expect_err("model");
        assert_eq!(err.code, "unknown_speech_model");
        let err = apply(
            &conn,
            &KalVoicePreferencesPatch {
                intelligence: Some(IntelligenceChoice::Provider {
                    provider_id: ProviderId::new("Bad Provider!"),
                }),
                ..Default::default()
            },
        )
        .expect_err("provider");
        assert_eq!(err.code, "invalid_provider");
        let err = apply(&conn, &KalVoicePreferencesPatch::default()).expect_err("empty");
        assert_eq!(err.code, "empty_preferences_patch");
    }

    #[test]
    fn patch_json_shape() {
        let absent: KalVoicePreferencesPatch =
            serde_json::from_str(r#"{"voiceReplies":true}"#).expect("json");
        assert_eq!(absent.intelligence, None);
        let auto: KalVoicePreferencesPatch =
            serde_json::from_str(r#"{"intelligence":{"kind":"automatic"}}"#).expect("json");
        assert_eq!(auto.intelligence, Some(IntelligenceChoice::Automatic));
        let codex: KalVoicePreferencesPatch =
            serde_json::from_str(r#"{"intelligence":{"kind":"provider","providerId":"codex"}}"#)
                .expect("json");
        assert_eq!(
            codex.intelligence,
            Some(IntelligenceChoice::Provider {
                provider_id: ProviderId::new("codex")
            })
        );
        assert!(
            serde_json::from_str::<KalVoicePreferencesPatch>(r#"{"permissionMode":"bypass"}"#)
                .is_err()
        );
    }

    #[test]
    fn panel_placement_per_size_class() {
        let conn = conn();
        let place = |size_class, x, view| KalVoicePreferencesPatch {
            panel_placement: Some(PanelPlacement {
                size_class,
                anchor: PanelAnchor::Free,
                x,
                y: 500,
                view,
            }),
            ..Default::default()
        };
        apply(&conn, &place(SizeClass::Wide, 100, PanelView::Orb)).expect("wide");
        apply(&conn, &place(SizeClass::Narrow, 900, PanelView::Expanded)).expect("narrow");
        let (prefs, changes) =
            apply(&conn, &place(SizeClass::Wide, 200, PanelView::Compact)).expect("again");
        assert_eq!(changes.keys, vec!["kalvoice.panelPlacements"]);
        assert_eq!(prefs.panel_placements.len(), 2);
        assert_eq!(prefs.panel_placements[0].size_class, SizeClass::Narrow);
        assert_eq!(prefs.panel_placements[1].x, 200);
        assert_eq!(load(&conn).expect("reload"), prefs);

        let err = apply(&conn, &place(SizeClass::Wide, 1001, PanelView::Orb)).expect_err("range");
        assert_eq!(err.code, "invalid_panel_position");

        // A new default position clears remembered placements.
        let (prefs, _) = apply(
            &conn,
            &KalVoicePreferencesPatch {
                panel_default: Some(PanelAnchor::TopLeft),
                panel_visible: Some(false),
                ..Default::default()
            },
        )
        .expect("default");
        assert!(prefs.panel_placements.is_empty());
        assert_eq!(prefs.panel_default, PanelAnchor::TopLeft);
        assert!(!prefs.panel_visible);
    }

    #[test]
    fn corrupt_stored_values_fall_back() {
        let conn = conn();
        conn.execute(
            "INSERT INTO kalvoice_preferences (key, value, updated_at) VALUES ('commandShortcut', '\"Nope+?\"', 'x'), ('speechModel', '\"missing\"', 'x')",
            [],
        )
        .expect("insert");
        assert_eq!(load(&conn).expect("load"), KalVoicePreferences::default());
    }
}
