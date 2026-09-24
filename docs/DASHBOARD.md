# Dashboard

The Dashboard is KalCode's flagship surface. It answers, as runtime truth: what is running, who is
doing it (provider, model, account), what each thread is doing now, which threads are idle,
blocked, finished, failed or waiting on the user, and what happened recently.

Source: `apps/desktop/src/surfaces/dashboard/`. Campaign: Z5 (`docs/campaigns/Z5.md`).

## Layout

```text
Dashboard                                         (h1)
<one-sentence runtime summary, most urgent first>
──────────── proportional rule: working | needs you | resting ────────────
3 Working   2 Need approval   1 Needs a reply   1 Failed   3 Terminals      (jump links)

Needs approval (2)                                  │ Runtime (health rail)
┃ Push chore/deps to origin      Deny  Allow for thread  Approve once      │ Terminals
┃ origin chore/deps                                                        │
┃ Thread  Provider  Workspace  Mode                                        │
┃ [Git push] reason                              Asked 3 minutes ago       │
Threads                                                                    │
  Needs you / Working / Blocked / Idle and paused   (grouped rows)         │
Recent completions and failures                                            │
Activity (live event log)                                                  │
```

Below 1180 px the rail moves between Recent and Activity; approvals always stay first.
Thread rows reflow by container width (three columns, then status-over-name, then stacked).

## Design decisions

- **One bold element: the approval queue.** A raised panel with an amber hairline on each request.
  Everything else is hairline structure on the page ground. No card grid.
- **Status is glyph + words + tone**, never colour alone (`StatusLabel`). Every contract
  `ThreadStatus` has a sentence-case label, a tone and a group (`data/status.ts`).
- **Width is the expressive type axis:** summary counts use Lexend Exa; everything else Lexend Deca.
- **Motion communicates state only:** a new approval slides in with an amber pulse on its rule; a
  thread whose status changes flashes its status label. All durations are `--dur-*` tokens, which
  collapse to 0 under reduced motion.
- **Honesty:** a command this build does not register renders an honest state ("Threads arrive
  with provider support"); the Dashboard never shows sample data outside the UI-test build.

## Data layer (`surfaces/dashboard/data/`)

| Module | Purpose |
| --- | --- |
| `DashboardData.tsx` | `DashboardDataProvider` and hooks `useThreadSummaries()`, `usePendingApprovals()`, `useRunningTerminals()`, `useDashboardAnnouncements()` |
| `resource.ts` | `useResource` — `loading` / `ready` (with stale-refresh error) / `unavailable` / `error`; ignores out-of-order responses |
| `refresh.ts` | `resourcesFor(eventType)` and `RefreshTracker` (watermark on event `seq`) |
| `status.ts` | `STATUS_META`, `isLive` / `isTerminal` / `needsAttention` (mirror the Rust contract), `sortOpenThreads`, `recentOutcomes`, `countThreads` |
| `actions.ts` | `availableActions(status)` — the only actions a state offers |
| `format.ts` | durations, permission-mode and scope labels, `describeAction(ActionKind)` |
| `summary.ts` | `summarizeRuntime()` / `describeRuntime()` — plain functions KalVoice can reuse for "what are my threads doing?" |

### Contract bindings

| Hook / action | Command (owner) | Refreshed by events |
| --- | --- | --- |
| `useThreadSummaries` | `thread_list { workspaceId: null, includeArchived: false }` (Z3) | `thread.*`, `tool.*`, `file.*`, `agent.message`, `approval.*`, `permission.mode_changed`, `workspace.*`, `provider.connected/disconnected/error` |
| `usePendingApprovals` | `approval_list { status: "pending" }` (Z4) | `approval.*`, `permission.mode_changed` |
| `decide(request, decision)` | `approval_decide { requestId, decision }` (Z4) | — |
| `useRunningTerminals` | `terminals_running` (Z1) | `shell.*`, `workspace.*` |
| Pause | `thread_interrupt { threadId }` (Z3) | |
| Stop (confirmed inline) | `thread_stop { threadId }` (Z3) | |
| Resume, Retry (failed) | `thread_resume { threadId }` (Z3) | |
| Archive | `thread_archive { threadId }` (Z3) | |
| Open | navigates to the Threads surface | |

Refreshes are debounced (120 ms) so a busy thread's burst of events costs one read per source.
The tracker starts once event history has loaded; history is covered by the first reads.

### "Not in this build"

Tauri rejects an unregistered command with a plain string before any native code runs
(`Command X not allowed by ACL` in release, `X not allowed. Command not found` in debug).
`toKalCodeError(error, command)` maps exactly that — for the command that was called — to a
typed `KalCodeError { category: "internal", code: "command_unavailable" }`. A source that is
unavailable is never polled again. The in-memory transport rejects unknown commands with the
same string, so this path is exercised by tests.

### Action availability

| Status | Actions |
| --- | --- |
| live (starting … reviewing, recovering), waiting for permission, blocked | Open, Pause, Stop |
| waiting for user | Open, Stop |
| idle | Open, Stop, Archive |
| paused | Open, Resume, Stop |
| offline | Open, Resume |
| completed | Open, Archive |
| failed | Open, Retry, Archive |
| stopped (`interrupted`) | Open, Resume, Archive |

## Accessibility

- Each approval is focusable; with it focused, **A** approves once, **T** allows for the thread,
  **D** denies (letters typed on a button never decide). After a decision, focus moves to the next
  request, else the queue heading. Tab order: summary, approvals (request, Deny, Allow for thread,
  Approve once), threads.
- New approvals are announced in an assertive live region ("New approval request: …", or a count
  for bursts); decisions and action results in a polite one.
- Stop asks for confirmation inline; Escape cancels and returns focus to Stop.
- axe (WCAG 2.2 AA tags) is clean for every scenario in both themes.

## Development and tests

Scenarios (UI-test build only, `?scenario=`): `busy`, `approvals-flood`, `empty`, `errors`,
`loading`; no scenario mirrors today's native build (commands unavailable). Fixtures:
`apps/desktop/src/ipc/memory/dashboard.ts`, typed with the generated contract types and
implementing the contract validation (ids, transitions, non-pending decisions) and events.
Test hook `window.__kalcodeMemory.dashboard` (`requestApproval`, `setThreadStatus`, `recover`).

```bash
pnpm --filter @kalcode/desktop test                                   # Vitest
KALCODE_UI_TEST_PORT=1436 pnpm --filter @kalcode/desktop test:ui      # Playwright (z5 port)
KALCODE_UI_TEST_PORT=1436 pnpm --filter @kalcode/desktop test:ui --grep @dashboard-shots
```

Screenshots land in `apps/desktop/qa/screenshots/dashboard/` (git-ignored); curated evidence is in
`docs/campaigns/z5-evidence/`.

## Integration notes

- `apps/desktop/src/ipc/pendingContracts.ts` mirrors Z1's `TerminalInfo`; delete it when Z1's
  generated type lands in `@kalcode/protocol`.
- `ApprovalItem` is Dashboard-specific; unify with Z4's `PermissionPrompt` at integration.
- Native commands must be added to `src-tauri/build.rs` and `capabilities/main.json` by their
  owning campaigns; the Dashboard switches from "unavailable" to live data with no UI change.
