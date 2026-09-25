//! Persistence for schema v9: `workspace_layouts` and `layout_presets`.
//!
//! Every function takes a connection supplied by the caller (`Core::read` /
//! `Core::transact`), so callers decide atomicity. Parameterized SQL only. Layout writes emit
//! no events: layouts are UI state, saved on every resize (debounced by the UI).

use kalcode_contracts::ids::{is_valid_id, new_id};
use kalcode_contracts::workspace_ui::{PANE_LAYOUT_SCHEMA_VERSION, PaneLayout, PaneNode};
use kalcode_core::time::now_rfc3339;
use kalcode_core::{KalError, Result};
use rusqlite::{Connection, OptionalExtension, params};

use crate::MAX_PRESETS;
use crate::types::{SavedLayoutPreset, WorkspaceLayout};
use crate::validate::{validate_layout, validate_preset_name};

fn check_id(id: &str) -> Result<()> {
    if is_valid_id(id) {
        Ok(())
    } else {
        Err(KalError::validation("invalid_id", "Invalid identifier."))
    }
}

fn encode(layout: &PaneLayout) -> Result<String> {
    serde_json::to_string(layout).map_err(|e| {
        KalError::internal("layout_encode_failed", "KalCode couldn't save that layout.")
            .with_source(e)
    })
}

/// Parses and re-validates a stored layout; `None` (logged) when it no longer passes.
fn decode(stored: &str, what: &'static str, key: &str) -> Option<PaneLayout> {
    let parsed: std::result::Result<PaneLayout, _> = serde_json::from_str(stored);
    match parsed {
        Ok(layout) if validate_layout(&layout).is_ok() => Some(layout),
        Ok(_) => {
            tracing::warn!(event = "layout.discarded", kind = what, id = %key, reason = "invalid");
            None
        }
        Err(error) => {
            tracing::warn!(event = "layout.discarded", kind = what, id = %key, reason = %error);
            None
        }
    }
}

/// The layout saved for `workspace_id`. A stored row that no longer parses or validates is
/// ignored (the UI builds a default), never an error.
pub fn get_layout(conn: &Connection, workspace_id: &str) -> Result<Option<WorkspaceLayout>> {
    check_id(workspace_id)?;
    let row: Option<(String, String)> = conn
        .query_row(
            "SELECT layout, updated_at FROM workspace_layouts WHERE workspace_id = ?1",
            params![workspace_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    Ok(row.and_then(|(stored, updated_at)| {
        decode(&stored, "workspace", workspace_id).map(|layout| WorkspaceLayout {
            workspace_id: workspace_id.to_owned(),
            schema_version: layout.schema_version,
            layout,
            updated_at,
        })
    }))
}

/// Validates and stores `workspace_id`'s layout (replacing the previous one).
pub fn save_layout(
    conn: &Connection,
    workspace_id: &str,
    layout: &PaneLayout,
) -> Result<WorkspaceLayout> {
    check_id(workspace_id)?;
    validate_layout(layout)?;
    let updated_at = now_rfc3339();
    conn.execute(
        "INSERT INTO workspace_layouts (workspace_id, schema_version, layout, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (workspace_id) DO UPDATE SET
           schema_version = excluded.schema_version,
           layout = excluded.layout,
           updated_at = excluded.updated_at",
        params![
            workspace_id,
            layout.schema_version,
            encode(layout)?,
            updated_at
        ],
    )?;
    Ok(WorkspaceLayout {
        workspace_id: workspace_id.to_owned(),
        schema_version: layout.schema_version,
        layout: layout.clone(),
        updated_at,
    })
}

/// Forgets `workspace_id`'s layout. Returns whether one was stored.
pub fn delete_layout(conn: &Connection, workspace_id: &str) -> Result<bool> {
    check_id(workspace_id)?;
    Ok(conn.execute(
        "DELETE FROM workspace_layouts WHERE workspace_id = ?1",
        params![workspace_id],
    )? > 0)
}

/// The layout's shape only: every pane empty and expanded, nothing maximized, no dock.
pub fn shape_only(layout: &PaneLayout) -> PaneLayout {
    fn strip(node: &PaneNode) -> PaneNode {
        match node {
            PaneNode::Split {
                axis,
                ratios,
                children,
            } => PaneNode::Split {
                axis: *axis,
                ratios: ratios.clone(),
                children: children.iter().map(strip).collect(),
            },
            PaneNode::Leaf { pane_id, .. } => PaneNode::Leaf {
                pane_id: pane_id.clone(),
                tabs: Vec::new(),
                active_tab: 0,
                collapsed: false,
            },
        }
    }
    PaneLayout {
        schema_version: layout.schema_version,
        root: strip(&layout.root),
        maximized_pane_id: None,
        dock: Vec::new(),
    }
}

/// The user's saved layout presets, oldest first.
pub fn list_presets(conn: &Connection) -> Result<Vec<SavedLayoutPreset>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, layout, created_at FROM layout_presets ORDER BY created_at, name",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
        ))
    })?;
    let mut presets = Vec::new();
    for row in rows {
        let (id, name, stored, created_at) = row?;
        if let Some(layout) = decode(&stored, "preset", &id) {
            presets.push(SavedLayoutPreset {
                id,
                name,
                schema_version: layout.schema_version,
                layout,
                created_at,
            });
        }
    }
    Ok(presets)
}

/// Saves `layout`'s shape as a named preset.
pub fn save_preset(
    conn: &Connection,
    name: &str,
    layout: &PaneLayout,
) -> Result<SavedLayoutPreset> {
    let name = validate_preset_name(name)?;
    validate_layout(layout)?;
    let shape = shape_only(layout);
    let taken: bool = conn
        .query_row(
            "SELECT 1 FROM layout_presets WHERE name = ?1",
            params![name],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if taken {
        return Err(KalError::validation(
            "preset_name_taken",
            "A layout with that name already exists.",
        ));
    }
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM layout_presets", [], |r| r.get(0))?;
    if usize::try_from(count).unwrap_or(usize::MAX) >= MAX_PRESETS {
        return Err(KalError::validation(
            "too_many_presets",
            "You can save up to 50 layouts. Delete one to save another.",
        ));
    }
    let id = new_id();
    let created_at = now_rfc3339();
    conn.execute(
        "INSERT INTO layout_presets (id, name, schema_version, layout, builtin, created_at)
         VALUES (?1, ?2, ?3, ?4, 0, ?5)",
        params![
            id,
            name,
            PANE_LAYOUT_SCHEMA_VERSION,
            encode(&shape)?,
            created_at
        ],
    )?;
    Ok(SavedLayoutPreset {
        id,
        name,
        schema_version: PANE_LAYOUT_SCHEMA_VERSION,
        layout: shape,
        created_at,
    })
}

/// Deletes a saved preset.
pub fn delete_preset(conn: &Connection, id: &str) -> Result<()> {
    check_id(id)?;
    let removed = conn.execute("DELETE FROM layout_presets WHERE id = ?1", params![id])?;
    if removed == 0 {
        return Err(KalError::validation(
            "preset_not_found",
            "That layout no longer exists.",
        ));
    }
    Ok(())
}
