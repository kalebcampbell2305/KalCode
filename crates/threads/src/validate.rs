//! Native validation of every value that reaches the thread runtime from IPC or another
//! caller. The WebView is untrusted: ids, names, prompts, models and modes are checked here
//! before they touch storage or a provider.

use kalcode_contracts::agent::ProviderId;
use kalcode_contracts::ids::is_valid_id;
use kalcode_contracts::permissions::PermissionMode;
use kalcode_core::{KalError, Result};

pub const MAX_NAME_CHARS: usize = 80;
pub const MAX_PROMPT_CHARS: usize = 100_000;
pub const MAX_MODEL_CHARS: usize = 128;
pub const MAX_PROVIDER_ID_CHARS: usize = 64;
pub const MAX_PAGE: u32 = 500;
/// Most threads a single bulk create may start.
pub const MAX_BULK_CREATE: usize = 16;

pub fn thread_id(id: &str) -> Result<()> {
    if is_valid_id(id) {
        Ok(())
    } else {
        Err(KalError::validation(
            "invalid_thread_id",
            "That thread reference isn't valid.",
        ))
    }
}

pub fn workspace_id(id: &str) -> Result<()> {
    if is_valid_id(id) {
        Ok(())
    } else {
        Err(KalError::validation(
            "invalid_workspace_id",
            "That workspace reference isn't valid.",
        ))
    }
}

/// Provider ids are short lowercase slugs (`claude-code`, `gemini-cli`).
pub fn provider_id(id: &str) -> Result<ProviderId> {
    let valid = !id.is_empty()
        && id.len() <= MAX_PROVIDER_ID_CHARS
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !id.starts_with('-')
        && !id.ends_with('-');
    if valid {
        Ok(ProviderId::new(id))
    } else {
        Err(KalError::validation(
            "invalid_provider",
            "That provider reference isn't valid.",
        ))
    }
}

/// An optional model id. Empty means "the provider's default".
pub fn model(model: Option<&str>) -> Result<Option<String>> {
    let Some(model) = model.map(str::trim).filter(|m| !m.is_empty()) else {
        return Ok(None);
    };
    let valid = model.chars().count() <= MAX_MODEL_CHARS
        && model.chars().all(|c| {
            c.is_ascii_alphanumeric()
                || matches!(
                    c,
                    '.' | '_' | '-' | ':' | '/' | '@' | '[' | ']' | '=' | '?' | '&' | ','
                )
        });
    if valid {
        Ok(Some(model.to_owned()))
    } else {
        Err(KalError::validation(
            "invalid_model",
            "That model name isn't valid.",
        ))
    }
}

/// A thread name: trimmed, whitespace collapsed, 1–80 characters, no control characters.
pub fn name(name: &str) -> Result<String> {
    // Whitespace controls (tab, newline) are collapsed below; any other control is refused.
    if name.chars().any(|c| c.is_control() && !c.is_whitespace()) {
        return Err(KalError::validation(
            "invalid_name",
            "Thread names can't contain control characters.",
        ));
    }
    let collapsed = name.split_whitespace().collect::<Vec<_>>().join(" ");
    let count = collapsed.chars().count();
    if count == 0 {
        return Err(KalError::validation(
            "invalid_name",
            "Give the thread a name.",
        ));
    }
    if count > MAX_NAME_CHARS {
        return Err(KalError::validation(
            "invalid_name",
            format!("Thread names can be at most {MAX_NAME_CHARS} characters."),
        ));
    }
    Ok(collapsed)
}

/// A prompt or message: must contain text, at most 100,000 characters. NUL is rejected; other
/// content (code, newlines, tabs) is kept exactly as written.
pub fn prompt(text: &str) -> Result<String> {
    if text.contains('\0') {
        return Err(KalError::validation(
            "invalid_prompt",
            "The message contains characters KalCode can't send.",
        ));
    }
    if text.trim().is_empty() {
        return Err(KalError::validation(
            "invalid_prompt",
            "Write a message first.",
        ));
    }
    if text.chars().count() > MAX_PROMPT_CHARS {
        return Err(KalError::validation(
            "invalid_prompt",
            "That message is too long. Keep it under 100,000 characters.",
        ));
    }
    Ok(text.trim_end().to_owned())
}

/// Modes a thread may be created with. Bypass is the default start (owner directive 2026-10-03:
/// no approvals); Custom needs a profile through the permission engine after creation.
pub fn creation_mode(mode: PermissionMode) -> Result<PermissionMode> {
    match mode {
        PermissionMode::Plan
        | PermissionMode::Approve
        | PermissionMode::Auto
        | PermissionMode::Bypass => Ok(mode),
        PermissionMode::Custom => Err(KalError::validation(
            "custom_not_allowed_at_create",
            "Custom permission profiles aren't available when creating a thread yet.",
        )),
    }
}

pub fn page_limit(limit: u32) -> Result<u32> {
    if (1..=MAX_PAGE).contains(&limit) {
        Ok(limit)
    } else {
        Err(KalError::validation(
            "invalid_page_size",
            format!("Page size must be between 1 and {MAX_PAGE}."),
        ))
    }
}

/// Short user-safe text from a provider (error messages, tool summaries): control characters
/// removed, length bounded.
pub fn provider_text(text: &str, max_chars: usize) -> String {
    let cleaned: String = text
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= max_chars {
        collapsed
    } else {
        let mut cut: String = collapsed
            .chars()
            .take(max_chars.saturating_sub(1))
            .collect();
        cut.push('…');
        cut
    }
}

/// A provider-supplied machine code, or `fallback` when it isn't a plain slug.
pub fn provider_code(code: &str, fallback: &str) -> String {
    let ok = !code.is_empty()
        && code.len() <= 64
        && code
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'));
    if ok {
        code.to_owned()
    } else {
        fallback.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_checked() {
        assert!(thread_id(&kalcode_contracts::ids::new_id()).is_ok());
        assert_eq!(
            thread_id("../x").expect_err("bad").code,
            "invalid_thread_id"
        );
        assert!(workspace_id("").is_err());
    }

    #[test]
    fn provider_ids_are_slugs() {
        assert!(provider_id("claude-code").is_ok());
        assert!(provider_id("gemini-cli").is_ok());
        for bad in ["", "Claude", "a b", "-x", "x-", "../p", &"a".repeat(65)] {
            assert!(provider_id(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn models_are_optional_and_bounded() {
        assert_eq!(model(None).expect("none"), None);
        assert_eq!(model(Some("  ")).expect("blank"), None);
        assert_eq!(
            model(Some("claude-sonnet-4-5")).expect("ok").as_deref(),
            Some("claude-sonnet-4-5")
        );
        assert!(model(Some("x; rm -rf /")).is_err());
        assert!(model(Some(&"m".repeat(129))).is_err());
        for exact in ["gpt-5.4[effort=high]", "custom/deepseek-v9?reasoning=high"] {
            assert_eq!(
                model(Some(exact)).expect("runtime model").as_deref(),
                Some(exact)
            );
        }
        for invalid in [
            "model\n--force",
            "model\0id",
            "model;command",
            "model`command",
        ] {
            assert!(model(Some(invalid)).is_err());
        }
    }

    #[test]
    fn names_are_normalized() {
        assert_eq!(name("  Fix   the\tbug ").expect("ok"), "Fix the bug");
        assert!(name("   ").is_err());
        assert!(name(&"n".repeat(81)).is_err());
        assert!(name("bad\u{7}bell").is_err());
        assert_eq!(name(&"n".repeat(80)).expect("80").len(), 80);
    }

    #[test]
    fn prompts_keep_content() {
        assert_eq!(
            prompt("line 1\n  code()\n\n").expect("ok"),
            "line 1\n  code()"
        );
        assert!(prompt(" \n\t").is_err());
        assert!(prompt("a\0b").is_err());
        assert!(prompt(&"p".repeat(MAX_PROMPT_CHARS + 1)).is_err());
    }

    #[test]
    fn creation_modes_exclude_only_custom() {
        assert!(creation_mode(PermissionMode::Approve).is_ok());
        assert!(creation_mode(PermissionMode::Plan).is_ok());
        assert!(creation_mode(PermissionMode::Auto).is_ok());
        // Bypass is the default start (owner directive 2026-10-03: no approvals).
        assert!(creation_mode(PermissionMode::Bypass).is_ok());
        assert!(creation_mode(PermissionMode::Custom).is_err());
    }

    #[test]
    fn provider_text_is_sanitized() {
        assert_eq!(provider_text("a\u{1b}[31mred\nx", 100), "a [31mred x");
        assert_eq!(provider_text(&"z".repeat(10), 5), "zzzz…");
        assert_eq!(provider_code("rate_limited", "x"), "rate_limited");
        assert_eq!(
            provider_code("bad code!", "provider_error"),
            "provider_error"
        );
    }
}
