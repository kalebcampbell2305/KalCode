//! The KalVoice push-to-talk key: one key, held to talk (docs/KALVOICE.md, "Push to talk").
//!
//! Any single key the OS can register without modifiers and that has no typing or toggle
//! meaning: F1–F24, Pause, Scroll Lock, Insert. F8 is the default. The key is registered only
//! while a KalCode window is focused, so it never takes the key away from other apps.
//!
//! Not offered, and why:
//! - **Fn** cannot be the registered fallback because OS hotkey APIs do not expose it. KalVoice
//!   detects standalone Fn separately when the foreground app actually receives it.
//! - **Caps Lock / Num Lock** would toggle while held; suppressing that needs a low-level
//!   keyboard hook (unsafe Win32 code), which KalCode doesn't ship yet.
//! - **Right Ctrl / Right Alt** are modifiers; the OS hotkey API can't register them alone.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub const DEFAULT_TALK_KEY: &str = "F8";

/// A key KalVoice may not take, with who owns it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ReservedShortcut {
    pub accelerator: String,
    pub owner: String,
}

/// Why a key can't be used.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShortcutProblem {
    pub code: &'static str,
    pub message: String,
}

/// Keys that already do something inside KalCode's window.
const RESERVED: &[(&str, &str)] = &[
    ("F5", "reloading the window"),
    ("F7", "caret browsing"),
    ("F12", "developer tools"),
];

/// Every key KalVoice may not take.
pub fn reserved() -> Vec<ReservedShortcut> {
    RESERVED
        .iter()
        .map(|(accelerator, owner)| ReservedShortcut {
            accelerator: (*accelerator).to_owned(),
            owner: (*owner).to_owned(),
        })
        .collect()
}

/// The keys the OS can register alone (canonical names, as the hotkey parser expects).
pub fn allowed_keys() -> Vec<String> {
    (1..=24)
        .map(|n| format!("F{n}"))
        .chain(["Pause", "ScrollLock", "Insert"].map(String::from))
        .collect()
}

/// Canonical name for a single key (`f8` → `F8`, `scroll lock` → `ScrollLock`).
pub fn canonicalize(input: &str) -> Result<String, ShortcutProblem> {
    let compact: String = input.chars().filter(|c| !c.is_whitespace()).collect();
    if compact.contains('+') {
        return Err(ShortcutProblem {
            code: "talk_key_single",
            message: "Push to talk uses one key on its own, without Ctrl, Alt or Shift.".into(),
        });
    }
    let lower = compact.to_ascii_lowercase();
    let unsupported = |what: &str, why: &str| ShortcutProblem {
        code: "talk_key_unsupported",
        message: format!("{what} can't be the push-to-talk key: {why}"),
    };
    match lower.as_str() {
        "fn" | "function" => {
            return Err(unsupported(
                "Fn",
                "KalVoice detects it separately when your keyboard reports it. Choose a fallback key here.",
            ));
        }
        "capslock" | "numlock" => {
            return Err(unsupported(
                "A lock key",
                "it would switch on and off while you hold it.",
            ));
        }
        "control" | "ctrl" | "alt" | "shift" | "meta" | "super" | "controlright" | "altright" => {
            return Err(unsupported(
                "A modifier key",
                "the system can't register it on its own.",
            ));
        }
        _ => {}
    }
    allowed_keys()
        .into_iter()
        .find(|k| k.to_ascii_lowercase() == lower)
        .ok_or_else(|| ShortcutProblem {
            code: "talk_key_invalid",
            message: "Choose a function key (F1–F24), Pause, Scroll Lock or Insert.".into(),
        })
}

/// Validates a push-to-talk key against KalCode's own keys. Returns the canonical name.
pub fn validate(input: &str) -> Result<String, ShortcutProblem> {
    let key = canonicalize(input)?;
    if let Some((_, owner)) = RESERVED.iter().find(|(k, _)| *k == key) {
        return Err(ShortcutProblem {
            code: "talk_key_conflict",
            message: format!("{} is used for {owner} in KalCode.", display(&key)),
        });
    }
    Ok(key)
}

/// Display form: `F8`, `Scroll Lock`.
pub fn display(key: &str) -> String {
    match key {
        "ScrollLock" => "Scroll Lock".into(),
        other => other.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_is_valid() {
        assert_eq!(validate(DEFAULT_TALK_KEY).as_deref(), Ok("F8"));
    }

    #[test]
    fn single_keys_only() {
        for (input, expected) in [
            ("f9", "F9"),
            ("F24", "F24"),
            ("pause", "Pause"),
            ("Scroll Lock", "ScrollLock"),
            ("insert", "Insert"),
        ] {
            assert_eq!(validate(input).as_deref(), Ok(expected), "{input}");
        }
        for (input, code) in [
            ("Ctrl+Shift+Space", "talk_key_single"),
            ("Alt+F8", "talk_key_single"),
            ("Fn", "talk_key_unsupported"),
            ("CapsLock", "talk_key_unsupported"),
            ("ControlRight", "talk_key_unsupported"),
            ("K", "talk_key_invalid"),
            ("Space", "talk_key_invalid"),
            ("F25", "talk_key_invalid"),
            ("", "talk_key_invalid"),
        ] {
            assert_eq!(validate(input).map_err(|p| p.code), Err(code), "{input}");
        }
    }

    #[test]
    fn keys_kalcode_uses_are_refused() {
        let err = validate("F5").expect_err("reserved");
        assert_eq!(err.code, "talk_key_conflict");
        assert_eq!(
            err.message,
            "F5 is used for reloading the window in KalCode."
        );
        assert!(validate("F12").is_err());
        assert_eq!(display("ScrollLock"), "Scroll Lock");
    }
}
