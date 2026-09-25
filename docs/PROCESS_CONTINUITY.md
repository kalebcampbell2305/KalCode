# Process Continuity Engine
Status: **planned — not built.** Nothing described here exists in KalCode yet. Plan and
acceptance criteria: `docs/campaigns/ADVANCED.md`; proposed types, events, IPC and tables:
`docs/CONTRACTS_ADVANCED.md` (PROPOSED, pending lead approval).

System code **PC** · Phase **P1 (built in Z7-W1/W4)**

Crash and restart recovery. It is a separate system from the Time Machine, which is about
history.

## Labels

| Label | Examples |
| --- | --- |
| RESTORABLE | Layout, panes, sizes, thread history, mission state, browser URLs, profiles |
| RECONNECTABLE | Provider sessions with a documented resume and a stored session id; remote hosts |
| RESTARTABLE | Terminal shells (a fresh shell in the same folder) |
| NOT RECOVERABLE | In-memory process state, terminal scrollback, pending approvals (expired by design), live remote channels |

## Rules

It formalises existing recovery — Z0's interrupted-session detection, Z1's ended tabs with
Restart, Z3's `interrupted` threads with provider resume — into one inventory; it does not
reimplement them. It never re-runs a command: the last command is shown as text at most.
Recovery actions are user-initiated (or policy-allowed) and pass the Trust Kernel.

## Persistence and events

Layout, panes, terminal/process metadata, mission state, thread and provider session ids,
browser URLs, branch/worktree and timestamps are persisted by their owners. The inventory itself
is derived at startup. `continuity.recovery_summarized` is emitted once per start; per-item
recovery reuses `thread.*`, `shell.*` and `workspace.remote_*` events.
