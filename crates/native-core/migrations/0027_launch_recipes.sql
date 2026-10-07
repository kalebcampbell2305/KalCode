-- Launch Recipes: saved working desks (agents, terminals, Browser pages, Services, widgets,
-- layout, optional Squad) that recreate in one action. A Recipe only REFERENCES canonical
-- objects by id and never stores credentials.
CREATE TABLE launch_recipes (
  id              TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  name            TEXT NOT NULL COLLATE NOCASE CHECK (length(name) BETWEEN 1 AND 120),
  schema_version  INTEGER NOT NULL CHECK (schema_version >= 1),
  -- Deliberately NOT a foreign key. Removing a project must neither silently turn its Recipes
  -- into "any project" (ON DELETE SET NULL) nor delete them (CASCADE). Keeping the dangling id
  -- lets the UI say "project removed" and offer to repoint or delete the Recipe.
  workspace_id    TEXT CHECK (workspace_id IS NULL OR length(workspace_id) BETWEEN 1 AND 128),
  pinned          INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  position        INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
  definition_json TEXT NOT NULL CHECK (
                    json_valid(definition_json) AND json_type(definition_json) = 'object'
                  ),
  updated_at      TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX launch_recipes_name_idx ON launch_recipes (name COLLATE NOCASE);
CREATE INDEX launch_recipes_order_idx ON launch_recipes (pinned DESC, position);
