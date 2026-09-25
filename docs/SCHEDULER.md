# Intelligent Parallelism Scheduler
Status: **planned — not built.** Nothing described here exists in KalCode yet. Plan and
acceptance criteria: `docs/campaigns/ADVANCED.md`; proposed types, events, IPC and tables:
`docs/CONTRACTS_ADVANCED.md` (PROPOSED, pending lead approval).

System code **SCH** · Phase **P4**

Decides which mission tasks run now, in which worktree, on which provider, and explains every
decision in typed reasons.

## What it builds on

Z9 Missions (tasks, dependency edges, predicted paths, priority, risk) · Z6a worktrees · Z8 agent
assignment · Resource Governor pressure (`RESOURCE_GOVERNOR.md`) · Provider Health capacity
(`PROVIDER_HEALTH.md`) · Diff Intelligence overlaps (`DIFF_INTELLIGENCE.md`) · the Trust Kernel
for every start.

## States and reasons

Every task is RUNNING, QUEUED, BLOCKED, WAITING or CONFLICTED, with one or more typed reasons:
an unfinished dependency, a held file claim, no worktree available, provider concurrency, an
observed provider backoff, CPU/RAM/disk pressure, a pending approval, waiting for the user, a
manual hold, manual mode, lower priority, a risk gate, a detected conflict, or the kill switch.
"Why is X waiting?" returns the same explanation in the UI and through KalVoice. Scheduling
states are derived, never stored on tasks.

## Modes and overrides

Auto and manual modes. Overrides (force start, hold, priority, ignore resource limits) are
audited and expire. No override bypasses permissions or silently ignores a conflict. Nothing is
auto-merged.

## Events

`scheduler.mode_changed`, `scheduler.task_queued` / `_started` / `_blocked` / `_waiting` /
`_conflicted` (transitions only), `scheduler.override_applied` / `_cleared`.
