# Provider Hot-Swap with Intelligent Handoff
Status: **planned — not built.** Nothing described here exists in KalCode yet. Plan and
acceptance criteria: `docs/campaigns/ADVANCED.md`; proposed types, events, IPC and tables:
`docs/CONTRACTS_ADVANCED.md` (PROPOSED, pending lead approval).

System code **HS** · Phase **P5**

Moves work from one provider to another through a handoff capsule that contains only observable
or reconstructable state.

## The capsule

Objective, originating request, mission/task, acceptance criteria, steps done and remaining,
decisions, workspace/repository/branch/worktree, files changed and diff, tests and results, build
status, errors, pending permissions (listed, **never transferred**), relevant memory, artifacts
and approved context, and a provider-independent summary. The structured summary is generated
deterministically; a model-written summary (from the user's own provider) is optional and
labelled.

## Modes

Manual · assisted (recommendations from Provider Health, never acted on automatically) ·
automatic failover only when the user's policy explicitly allows it for that provider (default
off).

## Rules

The capsule is a context package: it passes the Context Firewall and a user preview. The new
thread's permission mode is never broader than the old one. Every handoff is recorded on the Time
Machine timeline. If the capsule cannot be built, the original thread is untouched.

## Events

`provider.handoff_recommended`, `provider.handoff_started` / `_completed` / `_failed`.
