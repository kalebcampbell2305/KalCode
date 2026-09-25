//! Shared primitives (adopted in CA-1 from `docs/CONTRACTS_ADVANCED.md` §4): opaque file handles
//! and paging. Moved from `kalcode_git::types` with identical JSON.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Opaque, session-scoped reference to a file native code listed (ADVANCED.md §3 D4). The
/// WebView can only point at files native code already listed; containment is re-checked on use.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FileHandle {
    pub id: String,
}

/// What the UI may display about a handle.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FileRef {
    pub handle: FileHandle,
    pub workspace_id: String,
    /// Workspace-relative, `/`-separated.
    pub display_path: String,
}

/// Largest page any list returns.
pub const MAX_PAGE: u32 = 500;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PageRequest {
    /// 1..=500.
    pub limit: u32,
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Page<T> {
    pub items: Vec<T>,
    pub next_cursor: Option<String>,
    pub total_estimate: Option<u64>,
}

/// Why a page request is invalid. Stable codes for IPC errors.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum PageError {
    #[error("Page size must be between 1 and 500.")]
    InvalidPage,
    #[error("That page cursor isn't valid.")]
    InvalidCursor,
}

impl PageError {
    pub fn code(self) -> &'static str {
        match self {
            Self::InvalidPage => "invalid_page",
            Self::InvalidCursor => "invalid_cursor",
        }
    }
}

impl PageRequest {
    /// Validates the limit (1..=500) and parses an offset cursor.
    pub fn offset(&self) -> Result<(usize, usize), PageError> {
        if self.limit == 0 || self.limit > MAX_PAGE {
            return Err(PageError::InvalidPage);
        }
        let offset = match &self.cursor {
            None => 0,
            Some(cursor) => cursor
                .parse::<usize>()
                .map_err(|_| PageError::InvalidCursor)?,
        };
        Ok((offset, self.limit as usize))
    }
}

/// Pages a fully materialized, already ordered list with an offset cursor.
pub fn page_of<T: Clone>(items: &[T], request: &PageRequest) -> Result<Page<T>, PageError> {
    let (offset, limit) = request.offset()?;
    let end = offset.saturating_add(limit).min(items.len());
    let slice = items
        .get(offset.min(items.len())..end)
        .unwrap_or(&[])
        .to_vec();
    Ok(Page {
        items: slice,
        next_cursor: (end < items.len()).then(|| end.to_string()),
        total_estimate: Some(items.len() as u64),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_shapes_are_unchanged_from_the_git_crate() {
        let r = FileRef {
            handle: FileHandle { id: "h".into() },
            workspace_id: "w".into(),
            display_path: "src/a.rs".into(),
        };
        assert_eq!(
            serde_json::to_value(&r).expect("json"),
            serde_json::json!({"handle": {"id": "h"}, "workspaceId": "w", "displayPath": "src/a.rs"})
        );
        let page = Page {
            items: vec![1],
            next_cursor: None,
            total_estimate: Some(1),
        };
        assert_eq!(
            serde_json::to_value(&page).expect("json"),
            serde_json::json!({"items": [1], "nextCursor": null, "totalEstimate": 1})
        );
    }

    #[test]
    fn pages_validate_limits_and_cursors() {
        let items: Vec<u32> = (0..7).collect();
        let req = |limit, cursor: Option<&str>| PageRequest {
            limit,
            cursor: cursor.map(str::to_owned),
        };
        let first = page_of(&items, &req(3, None)).expect("page");
        assert_eq!(first.items, [0, 1, 2]);
        assert_eq!(first.next_cursor.as_deref(), Some("3"));
        let last = page_of(&items, &req(5, Some("5"))).expect("page");
        assert_eq!(last.items, [5, 6]);
        assert_eq!(last.next_cursor, None);
        assert_eq!(page_of(&items, &req(0, None)), Err(PageError::InvalidPage));
        assert_eq!(
            page_of(&items, &req(501, None)),
            Err(PageError::InvalidPage)
        );
        assert_eq!(
            page_of(&items, &req(1, Some("-1"))),
            Err(PageError::InvalidCursor)
        );
        assert!(
            page_of(&items, &req(2, Some("99")))
                .expect("page")
                .items
                .is_empty()
        );
        assert_eq!(PageError::InvalidCursor.code(), "invalid_cursor");
    }
}
