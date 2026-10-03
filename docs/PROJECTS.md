# Sidebar Projects

Click **Projects** (or its chevron) to collapse or expand the section. The choice is
remembered on this device, independently of the full sidebar width. Opening a
project folder remains available from the header.

Right-click a project or open its options button to **Pin Project** / **Unpin
Project**. Pins appear first, in the user's saved order. New pins append to that
order. Drag a pinned row onto another pin to move it to that position; Escape
cancels. The menu's **Move pin up/down** actions also support keyboard use
(Shift+F10 opens the menu). Activating projects and newer activity never sort pins.
Unpinned projects continue to sort by last opened time.

A moved or missing folder stays pinned with an **Unavailable** label. Its options
remain accessible. Pin-save failures show an error and reload the durable state.

## Ownership and compatibility

- Workspaces and availability: `WorkspaceProvider` and native workspace store.
- Pin state and order: existing native `workspace_rail`, exposed by `RailProvider`.
  The compact Projects view shares this state with the full workspace rail.
- Collapse: `DeckUiProvider`, per-device local storage alongside the agents rail
  layout. A storage failure is reported; the current session still responds.
- No new database, schema migration, entitlement, or Favorites store.
- Pointer gestures work without HTML drag/drop, which Tauri's native Windows file
  handling intercepts. The same React implementation serves Windows and macOS.

Focused proofs: `tests/ui/projects.spec.ts`, `tests/ui/command-deck.spec.ts`,
`src/shell/rail/{projectPins,RailProvider}.test.ts[x]`, and native
`crates/locator/tests/rail_home.rs` (temporary stores, including real restart and a
moved folder). Rollback is a normal revert of the feature commit; existing pins
stay in the native store and the extra device layout key is harmless to older builds.
