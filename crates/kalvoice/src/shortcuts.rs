//! KalVoice keyboard shortcuts: parsing, canonical form and conflict detection.
//!
//! Shortcuts are stored in the canonical form the Tauri global-shortcut plugin parses, e.g.
//! `CommandOrControl+Shift+Space` (Ctrl on Windows and Linux, ⌘ on macOS). A shortcut must use
//! Ctrl/⌘ or Alt (Shift alone would block typing), must not be one of KalCode's own bindings or a
//! common system/editor shortcut, and the two KalVoice shortcuts must differ.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub const DEFAULT_DICTATION: &str = "CommandOrControl+Shift+Space";
pub const DEFAULT_COMMAND: &str = "CommandOrControl+Shift+K";

/// A binding KalVoice may not take, with who owns it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ReservedShortcut {
    pub accelerator: String,
    pub owner: String,
}

/// Why a shortcut can't be used.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShortcutProblem {
    pub code: &'static str,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct Parsed<'a> {
    mod_key: bool,
    alt: bool,
    shift: bool,
    key: &'a str,
}

const KALCODE_BINDINGS: &[(&str, &str)] = &[
    ("CommandOrControl+K", "KalCode command palette"),
    ("CommandOrControl+B", "KalCode sidebar"),
];

/// Common system, editor and terminal shortcuts KalVoice never takes.
const SYSTEM_BINDINGS: &[(&str, &str)] = &[
    ("CommandOrControl+A", "Select all"),
    ("CommandOrControl+C", "Copy / interrupt in terminals"),
    ("CommandOrControl+V", "Paste"),
    ("CommandOrControl+X", "Cut"),
    ("CommandOrControl+Z", "Undo"),
    ("CommandOrControl+Y", "Redo"),
    ("CommandOrControl+Shift+Z", "Redo"),
    ("CommandOrControl+S", "Save"),
    ("CommandOrControl+F", "Find"),
    ("CommandOrControl+W", "Close"),
    ("CommandOrControl+Q", "Quit"),
    ("CommandOrControl+T", "New tab"),
    ("CommandOrControl+N", "New window"),
    ("CommandOrControl+P", "Print / quick open"),
    ("CommandOrControl+R", "Reload"),
    ("CommandOrControl+Shift+C", "Terminal copy"),
    ("CommandOrControl+Shift+V", "Terminal paste"),
    ("CommandOrControl+Shift+P", "Editor command palette"),
    ("CommandOrControl+Space", "Input source / Spotlight"),
    ("Alt+Space", "Window menu"),
    ("Alt+F4", "Close window"),
];

/// Every binding KalVoice may not take.
pub fn reserved() -> Vec<ReservedShortcut> {
    KALCODE_BINDINGS
        .iter()
        .chain(SYSTEM_BINDINGS)
        .map(|(accelerator, owner)| ReservedShortcut {
            accelerator: (*accelerator).to_owned(),
            owner: (*owner).to_owned(),
        })
        .collect()
}

fn canonical_key(token: &str) -> Option<&'static str> {
    const LETTERS: [&str; 26] = [
        "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q", "R",
        "S", "T", "U", "V", "W", "X", "Y", "Z",
    ];
    const DIGITS: [&str; 10] = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];
    const FUNCTION: [&str; 12] = [
        "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
    ];
    const NAMED: [&str; 12] = [
        "Space",
        "Backquote",
        "Minus",
        "Equal",
        "BracketLeft",
        "BracketRight",
        "Backslash",
        "Semicolon",
        "Quote",
        "Comma",
        "Period",
        "Slash",
    ];
    let upper = token.to_ascii_uppercase();
    LETTERS
        .iter()
        .chain(&DIGITS)
        .chain(&FUNCTION)
        .chain(&NAMED)
        .find(|k| k.eq_ignore_ascii_case(&upper))
        .copied()
}

fn parse(input: &str) -> Result<Parsed<'static>, ShortcutProblem> {
    let invalid = || ShortcutProblem {
        code: "shortcut_invalid",
        message: "Use Ctrl or Alt with a letter, number, function key or Space.".into(),
    };
    let mut parsed = Parsed {
        mod_key: false,
        alt: false,
        shift: false,
        key: "",
    };
    let mut key = None;
    for token in input.split('+').map(str::trim) {
        match token.to_ascii_lowercase().as_str() {
            "commandorcontrol" | "cmdorctrl" | "commandorctrl" | "cmdorcontrol" | "control"
            | "ctrl" | "command" | "cmd" | "mod" => {
                if parsed.mod_key {
                    return Err(invalid());
                }
                parsed.mod_key = true;
            }
            "alt" | "option" => {
                if parsed.alt {
                    return Err(invalid());
                }
                parsed.alt = true;
            }
            "shift" => {
                if parsed.shift {
                    return Err(invalid());
                }
                parsed.shift = true;
            }
            _ => {
                if key.is_some() {
                    return Err(invalid());
                }
                key = Some(canonical_key(token).ok_or_else(invalid)?);
            }
        }
    }
    parsed.key = key.ok_or_else(invalid)?;
    if !parsed.mod_key && !parsed.alt {
        return Err(ShortcutProblem {
            code: "shortcut_needs_modifier",
            message: "Include Ctrl (⌘ on macOS) or Alt, so the shortcut doesn't interrupt typing."
                .into(),
        });
    }
    Ok(parsed)
}

fn render(p: &Parsed<'_>) -> String {
    let mut parts = Vec::new();
    if p.mod_key {
        parts.push("CommandOrControl");
    }
    if p.alt {
        parts.push("Alt");
    }
    if p.shift {
        parts.push("Shift");
    }
    parts.push(p.key);
    parts.join("+")
}

/// Parses and canonicalizes a shortcut (`ctrl+shift+space` → `CommandOrControl+Shift+Space`).
pub fn canonicalize(input: &str) -> Result<String, ShortcutProblem> {
    parse(input).map(|p| render(&p))
}

/// Validates one KalVoice shortcut against reserved bindings and the other KalVoice shortcut.
/// Returns the canonical form.
pub fn validate(input: &str, other_kalvoice: Option<&str>) -> Result<String, ShortcutProblem> {
    let canonical = canonicalize(input)?;
    if let Some((_, owner)) = KALCODE_BINDINGS
        .iter()
        .chain(SYSTEM_BINDINGS)
        .find(|(accelerator, _)| canonicalize(accelerator).is_ok_and(|c| c == canonical))
    {
        return Err(ShortcutProblem {
            code: "shortcut_conflict",
            message: format!("{} is already used for {owner}.", display(&canonical)),
        });
    }
    if let Some(other) = other_kalvoice
        && canonicalize(other).is_ok_and(|c| c == canonical)
    {
        return Err(ShortcutProblem {
            code: "shortcut_conflict",
            message: format!(
                "{} is already your other KalVoice shortcut.",
                display(&canonical)
            ),
        });
    }
    Ok(canonical)
}

/// Windows/Linux display form: `Ctrl+Shift+Space`.
pub fn display(canonical: &str) -> String {
    canonical.replace("CommandOrControl", "Ctrl")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_valid_and_distinct() {
        assert_eq!(
            validate(DEFAULT_DICTATION, Some(DEFAULT_COMMAND)).as_deref(),
            Ok(DEFAULT_DICTATION)
        );
        assert_eq!(
            validate(DEFAULT_COMMAND, Some(DEFAULT_DICTATION)).as_deref(),
            Ok(DEFAULT_COMMAND)
        );
    }

    #[test]
    fn canonical_form_is_order_and_case_insensitive() {
        for input in [
            "ctrl+shift+space",
            "Shift+Ctrl+Space",
            "SHIFT + CONTROL + space",
            "CmdOrCtrl+Shift+Space",
        ] {
            assert_eq!(
                canonicalize(input).as_deref(),
                Ok(DEFAULT_DICTATION),
                "{input}"
            );
        }
        assert_eq!(canonicalize("alt+f5").as_deref(), Ok("Alt+F5"));
        assert_eq!(display(DEFAULT_COMMAND), "Ctrl+Shift+K");
    }

    #[test]
    fn rejects_malformed_and_modifier_free_shortcuts() {
        for bad in [
            "",
            "Ctrl",
            "Ctrl+",
            "Ctrl+Ctrl+K",
            "Ctrl+K+J",
            "Ctrl+Escape",
            "Ctrl+🙂",
            "Hyper+K",
        ] {
            assert_eq!(
                canonicalize(bad).map_err(|p| p.code),
                Err("shortcut_invalid"),
                "{bad:?}"
            );
        }
        for bad in ["K", "Shift+K", "Shift+Space", "F5"] {
            assert_eq!(
                canonicalize(bad).map_err(|p| p.code),
                Err("shortcut_needs_modifier"),
                "{bad}"
            );
        }
    }

    #[test]
    fn detects_conflicts() {
        let conflict = |s: &str, other: Option<&str>| validate(s, other).map_err(|p| p.code);
        assert_eq!(conflict("Ctrl+K", None), Err("shortcut_conflict"));
        assert_eq!(conflict("ctrl+b", None), Err("shortcut_conflict"));
        assert_eq!(conflict("Ctrl+C", None), Err("shortcut_conflict"));
        assert_eq!(conflict("Alt+F4", None), Err("shortcut_conflict"));
        assert_eq!(
            conflict("Ctrl+Shift+K", Some("CommandOrControl+Shift+K")),
            Err("shortcut_conflict")
        );
        assert_eq!(
            conflict("Ctrl+Alt+J", Some(DEFAULT_COMMAND)),
            Ok("CommandOrControl+Alt+J".into())
        );
        let message = validate("Ctrl+K", None).expect_err("conflict").message;
        assert_eq!(
            message,
            "Ctrl+K is already used for KalCode command palette."
        );
    }

    #[test]
    fn every_reserved_binding_parses() {
        for r in reserved() {
            assert!(canonicalize(&r.accelerator).is_ok(), "{}", r.accelerator);
        }
    }
}
