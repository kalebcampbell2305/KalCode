-- v9 (Z7-W1): the pane layout store. One layout per workspace (the versioned `PaneLayout` tree
-- from crates/contracts/src/workspace_ui.rs, validated natively before it is written) and the
-- user's saved layout presets (shapes only; no content ids). Owned by crates/workspace-ui.
-- Workspace ids are resolved through Z1's Rust API, so there is no foreign key to `workspaces`.

CREATE TABLE workspace_layouts (
    workspace_id   TEXT PRIMARY KEY NOT NULL,
    schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
    layout         TEXT NOT NULL CHECK (json_valid(layout) AND length(layout) <= 65536),
    updated_at     TEXT NOT NULL
) STRICT;

CREATE TABLE layout_presets (
    id             TEXT PRIMARY KEY NOT NULL,
    name           TEXT NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 60),
    schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
    layout         TEXT NOT NULL CHECK (json_valid(layout) AND length(layout) <= 65536),
    builtin        INTEGER NOT NULL DEFAULT 0 CHECK (builtin IN (0, 1)),
    created_at     TEXT NOT NULL
) STRICT;
