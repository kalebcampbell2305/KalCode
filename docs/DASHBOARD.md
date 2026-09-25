# Dashboard

The Dashboard is KalCode's live board of agents. It answers, from runtime truth only: how many
agents there are and what each is doing, which ones need you, which finished, which are idle — and
it lets you act (approve, open, pause, resume, retry, stop, archive) without leaving it.

Source: `apps/desktop/src/surfaces/dashboard/` (board), `apps/desktop/src/shell/widgets/` (dock),
`apps/desktop/src/shell/notifications/` (notification center). Campaigns: Z5 (first Dashboard),
Z7-W3 (this rewrite, `docs/campaigns/Z7-W3.md`).

## Layout

```text
Dashboard                                             [Last hour ▁▁▂▅█ 15 events]
21 agents · 2 working · 19 idle                        (summary from real counts)
[All 21] [Waiting for you 3] [Working 2] [Done 4] [Idle 12]   [Search agents] Group by Status|Project|Provider
┌ board ─────────────────────────────────────────────┐ ┌ Widgets ────────── Customize ┐
│ ⌄ NEEDS YOU 3                                       │ │ Needs your approval   2      │
│ [ACTION NEEDED card][FAILED card][WAITING card]     │ │ Active agents         2      │
│ ⌄ WORKING 2                                         │ │ Provider health              │
│ [card][card]                                        │ │ Activity                     │
│ ⌄ DONE 4   ⌄ IDLE 12 …                              │ │ Terminals · Runtime health   │
└─────────────────────────────────────────────────────┘ └──────────────────────────────┘
```

- **Full window.** The board fills the width. Cards never get narrower than 300 px: wider windows
  get more card columns (7 at 3440 px), not stretched cards. From 68 rem of content width the dock
  sits beside the board (sticky, scrolling on its own); on ultrawide it becomes two columns; on
  narrow windows it moves below the board.
- **Status is glyph + words + tone**, never colour alone, through the one contract mapping
  (`displayStatusOf`, `StatusChip`): working green (soft breathing hairline), waiting / permission
  neutral grey (static), idle muted, done high-contrast neutral (one-shot transition when it
  arrives), failed red (static hairline), paused amber (the only amber), recovering blue. Reduced
  motion removes every animation.

## Cards

Provider mark (glyph + name + model), name (the focus button), workspace, branch, current activity
(structured events only; failed shows the runtime's user-safe error), status, permission mode,
files changed, last activity, and an actions menu (Open, Pause, Resume, Retry, Stop… with an inline
confirmation, Archive — only the actions valid for the state, `data/actions.ts`).

- **ACTION NEEDED** (PERMISSION REQUIRED): a band and the inline approval — the exact action, its
  scopes, and the answers in the app's order **Deny · Allow for workspace · Allow for thread ·
  Approve once** (only those the engine allows), through Z4 `approval_decide`.
- **DONE**: a "✓ COMPLETED" band with Open (and View changes once a diff surface exists).
- **FAILED**: the error and Retry. **WAITING FOR YOU**: Reply.
- **Clicking a card focuses the thread** through the UI focus intent (`runtime/uiIntents.tsx`):
  a provider-pane thread opens its pane in Code; a headless thread opens in Threads. The pane
  system (Z7-W1) registers a handler to focus its own panes.

## Counts, filters, search, grouping, scale

- Chip counts use `ThreadStatus → DashboardChip` (FAILED counts under Waiting for you). Chips
  filter instantly and announce the result politely.
- Search matches every word against name, workspace, branch, provider, model and activity.
- Grouping: Status (Needs you, Working, Done, Idle), Project, Provider. Agent and Mission grouping
  are not shown until Agents (Z8) and Missions (Z9) exist. Groups collapse. The mode is remembered.
- 1 → 50+ agents: rows (group headings and card rows) are virtualized against the nearest
  scrolling ancestor once there are more than 12; row heights are measured. Tested at 1, 6, 20
  and 50 agents; recomputing counts, filters and groups for 50 threads is well inside a frame.

## Widgets (`shell/widgets`)

A small dock with sensible defaults — Needs your approval, Active agents, Provider health
(read-only detection state; never runs a check), Activity, Terminals, Runtime health — at most six
visible. Each widget moves (handle with pointer or arrow keys, or the menu), resizes (bottom edge
with pointer or arrow keys, or Small/Medium/Large), hides and is restored from Customize; Reset
restores the defaults. The layout is remembered per viewer. `WidgetPane` renders any widget as
pane content for the pane system.

## Notification center (`shell/notifications`, `crates/notifications`)

Actionable notifications for the events that exist today: thread completed, thread failed,
permission required, provider signed out, and work that can be resumed after KalCode closed
mid-run. Opening one marks it read and focuses its entity. Deduplicated (repeats coalesce into
the unread notification with a count), rate-limited (10 s per entity, 30 new per minute), kept to
the newest 500; unread state is stored natively (migration v11). No OS toasts yet (see Z7-W3.md).

## Data (`surfaces/dashboard/data/`)

| Module | Purpose |
| --- | --- |
| `DashboardData.tsx` | Threads (`thread_list`) and running terminals (`terminals_running`), re-read on the events that change them (debounced 120 ms); thread actions; `DashboardDataBoundary` for widgets and panes |
| `board.ts` | Pure model: chip counts, `summaryLine`, filter/search, grouping and ordering, activity buckets |
| `actions.ts`, `status.ts`, `format.ts`, `refresh.ts`, `resource.ts` | As in Z5 |

Pending approvals come from the permission engine's shared state (`usePermissions`, Z4).

## KalVoice

"Show only agents that are working", "Show everything waiting for me", "Show completed work",
"Show idle agents", "Show all agents" are deterministic intents (`KalVoiceIntent::FilterDashboard`)
that open the Dashboard with that chip.

## Development and tests

Scenarios (UI-test build only, `?scenario=`): `busy`, `empty`, `approvals-flood`, `errors`,
`loading`, and the scale scenarios `dash-1`, `dash-6`, `dash-20`, `dash-50`. Notifications are
derived by `src/ipc/memory/notifications.ts` (a double of `crates/notifications`). Test hooks:
`window.__kalcodeMemory.dashboard` (`requestApproval`, `setThreadStatus`, `recover`) and
`window.__kalcodeMemory.simulate(event)`.

```bash
pnpm --filter @kalcode/desktop test
KALCODE_UI_TEST_PORT=1453 pnpm --filter @kalcode/desktop test:ui --workers=2 tests/ui/dashboard.spec.ts tests/ui/notifications.spec.ts
KALCODE_UI_TEST_PORT=1453 pnpm --filter @kalcode/desktop test:ui --grep @dashboard-shots   # qa/screenshots/w3/
```
