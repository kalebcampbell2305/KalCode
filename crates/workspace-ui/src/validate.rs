//! Native validation of layouts and preset names. The WebView is treated as possibly
//! compromised: nothing it sends is stored until it passes these checks.

use kalcode_contracts::ids::is_valid_id;
use kalcode_contracts::workspace_ui::{LayoutError, PaneContent, PaneLayout, PaneNode};
use kalcode_core::KalError;

use crate::MAX_LAYOUT_BYTES;

/// Longest browser URL a layout may remember, in characters.
pub const MAX_URL_CHARS: usize = 2048;
/// Longest preset name, in characters.
pub const MAX_PRESET_NAME_CHARS: usize = 60;

fn invalid(message: &'static str) -> KalError {
    KalError::validation("invalid_layout", message)
}

fn structural(error: &LayoutError) -> KalError {
    invalid(match error {
        LayoutError::UnsupportedVersion(_) => {
            "That layout was made by a different version of KalCode."
        }
        LayoutError::BadSplit => "A split in that layout needs at least two panes.",
        LayoutError::BadRatios => "The pane sizes in that layout don't add up.",
        LayoutError::TooDeep => "That layout is nested too deeply.",
        LayoutError::TooLarge => "That layout has too many panes or tabs.",
        LayoutError::BadPaneId => "That layout has a missing or repeated pane id.",
        LayoutError::BadActiveTab => "A pane in that layout points at a tab it doesn't have.",
        LayoutError::UnknownMaximizedPane => "The maximized pane in that layout doesn't exist.",
    })
}

/// Widget ids: `^[a-z0-9][a-z0-9_.-]{0,63}$`.
pub fn is_widget_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    match bytes.first() {
        Some(first) if first.is_ascii_lowercase() || first.is_ascii_digit() => {
            bytes.len() <= 64
                && bytes.iter().all(|b| {
                    b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'_' | b'.' | b'-')
                })
        }
        _ => false,
    }
}

/// A browser pane's URL: `http://` or `https://`, at most 2048 characters, no control
/// characters.
pub fn is_browser_url(url: &str) -> bool {
    url.chars().count() <= MAX_URL_CHARS
        && !url.chars().any(char::is_control)
        && (url.starts_with("http://") || url.starts_with("https://"))
}

fn check_content(content: &PaneContent) -> Result<(), KalError> {
    let ok = match content {
        PaneContent::Thread { thread_id } => is_valid_id(thread_id),
        PaneContent::Terminal { terminal_id } => is_valid_id(terminal_id),
        PaneContent::Git { workspace_id } => is_valid_id(workspace_id),
        PaneContent::Dashboard => true,
        PaneContent::Widget { widget_id } => is_widget_id(widget_id),
        PaneContent::Browser { url } => url.as_deref().is_none_or(is_browser_url),
    };
    if ok {
        Ok(())
    } else {
        Err(invalid(
            "A pane in that layout refers to something KalCode can't open.",
        ))
    }
}

fn check_node(node: &PaneNode) -> Result<(), KalError> {
    match node {
        PaneNode::Split { children, .. } => children.iter().try_for_each(check_node),
        PaneNode::Leaf { tabs, .. } => tabs.iter().try_for_each(check_content),
    }
}

/// Structural checks (the contract's [`PaneLayout::validate`]), content-id checks on every tab
/// and dock item, and the stored size limit (64 KiB of JSON).
pub fn validate_layout(layout: &PaneLayout) -> Result<(), KalError> {
    layout.validate().map_err(|e| structural(&e))?;
    check_node(&layout.root)?;
    layout.dock.iter().try_for_each(check_content)?;
    if encoded_len(layout)? > MAX_LAYOUT_BYTES {
        return Err(invalid("That layout is too large to save."));
    }
    Ok(())
}

pub(crate) fn encoded_len(layout: &PaneLayout) -> Result<usize, KalError> {
    serde_json::to_vec(layout).map(|v| v.len()).map_err(|e| {
        KalError::internal("layout_encode_failed", "KalCode couldn't read that layout.")
            .with_source(e)
    })
}

/// A preset name, trimmed: 1–60 characters, no control characters.
pub fn validate_preset_name(name: &str) -> Result<String, KalError> {
    let trimmed = name.trim();
    let count = trimmed.chars().count();
    if count == 0 || count > MAX_PRESET_NAME_CHARS || trimmed.chars().any(char::is_control) {
        return Err(KalError::validation(
            "invalid_preset_name",
            "Layout names are 1 to 60 characters, without line breaks or control characters.",
        ));
    }
    Ok(trimmed.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn widget_ids_and_urls() {
        for good in ["dashboard-summary", "a", "resources.v2", "0_x"] {
            assert!(is_widget_id(good), "{good}");
        }
        let long = "x".repeat(65);
        for bad in ["", "-a", "A", "a b", "a/b", long.as_str()] {
            assert!(!is_widget_id(bad), "{bad}");
        }
        assert!(is_browser_url("http://localhost:3000"));
        assert!(is_browser_url("https://example.com/a?b=c"));
        for bad in [
            "file:///c:/x",
            "javascript:alert(1)",
            "localhost:3000",
            "https://a\nb",
        ] {
            assert!(!is_browser_url(bad), "{bad}");
        }
        assert!(!is_browser_url(&format!(
            "https://{}",
            "a".repeat(MAX_URL_CHARS)
        )));
    }

    #[test]
    fn preset_names() {
        assert_eq!(
            validate_preset_name("  Review  ").ok().as_deref(),
            Some("Review")
        );
        assert_eq!(
            validate_preset_name(&"é".repeat(60))
                .map(|n| n.chars().count())
                .ok(),
            Some(60)
        );
        for bad in ["", "   ", "a\nb", "tab\there"] {
            assert_eq!(
                validate_preset_name(bad).err().map(|e| e.code),
                Some("invalid_preset_name"),
                "{bad:?}"
            );
        }
        assert!(validate_preset_name(&"x".repeat(61)).is_err());
    }
}
