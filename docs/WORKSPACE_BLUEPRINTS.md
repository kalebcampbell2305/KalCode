# Workspace Blueprints
Status: **planned — not built.** Nothing described here exists in KalCode yet. Plan and
acceptance criteria: `docs/campaigns/ADVANCED.md`; proposed types, events, IPC and tables:
`docs/CONTRACTS_ADVANCED.md` (PROPOSED, pending lead approval).

System code **BP** · Phase **P5**

Reusable workspace setups: layout, provider panes, profile bindings, permission defaults, terminal
presets, browser/Git/utility panes, mission config, agent team, verification defaults,
automation hooks and resource sizing.

## Operations

Create, read, update, delete, "save current", and apply with a preview of every change.
Import and export use native file dialogs. Parts whose system is not built yet are omitted and
listed.

## Safety

Exports never contain secrets or secret references — only credential aliases (labels). Import
validates the schema; an imported Bypass becomes Approve plus a "needs your confirmation" item;
imported automations are disabled; imported rules are shown for review; nothing applies from a
repository file automatically.

## Placement

The workspace menu in the rail (Z7) — not a new top-level surface.
