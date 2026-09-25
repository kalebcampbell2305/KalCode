//! The pane layout store (campaign Z7-W1, `docs/campaigns/ADVANCED.md` §16).
//!
//! * [`types`] — the IPC shapes: [`WorkspaceLayout`] and [`SavedLayoutPreset`].
//! * [`validate`] — native validation of a
//!   [`PaneLayout`](kalcode_contracts::workspace_ui::PaneLayout) before it is stored: the
//!   contract's structural checks plus content-id checks.
//! * [`store`] — schema v9 (`workspace_layouts`, `layout_presets`): one layout per workspace and
//!   the user's saved layout shapes. Functions take a connection, so callers decide atomicity.
//!
//! Layouts are UI state. Saving one never starts, stops or changes a process, and emits no
//! events; a stored layout that no longer validates is ignored rather than failing.

pub mod store;
pub mod types;
pub mod validate;

pub use kalcode_core::db::WORKSPACE_UI_MIGRATION;
pub use types::{SavedLayoutPreset, WorkspaceLayout};
pub use validate::{validate_layout, validate_preset_name};

/// The schema version that adds the layout tables.
pub const WORKSPACE_UI_SCHEMA_VERSION: i64 = 9;

/// Most saved layout presets.
pub const MAX_PRESETS: usize = 50;

/// Largest stored layout, in bytes of JSON.
pub const MAX_LAYOUT_BYTES: usize = 65_536;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migration_is_registered_as_v9() {
        assert_eq!(
            (WORKSPACE_UI_MIGRATION.version, WORKSPACE_UI_MIGRATION.name),
            (WORKSPACE_UI_SCHEMA_VERSION, "workspace_ui")
        );
        let registered = kalcode_core::db::MIGRATIONS.iter().find(|m| m.version == 9);
        assert!(registered.is_some_and(|m| m.sql == WORKSPACE_UI_MIGRATION.sql));
        assert!(
            WORKSPACE_UI_MIGRATION
                .sql
                .contains("CREATE TABLE workspace_layouts")
        );
        assert!(
            WORKSPACE_UI_MIGRATION
                .sql
                .contains("CREATE TABLE layout_presets")
        );
    }
}
