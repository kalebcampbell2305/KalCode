# Execution Time Machine
Status: **planned — not built.** Nothing described here exists in KalCode yet. Plan and
acceptance criteria: `docs/campaigns/ADVANCED.md`; proposed types, events, IPC and tables:
`docs/CONTRACTS_ADVANCED.md` (PROPOSED, pending lead approval).

System code **TM** · Phase **P2**

A causal timeline of everything that happened in a workspace, built on the Event Protocol and
Git checkpoints. It separates what is technically possible from what is not.

## Five actions, each labelled Valid / Degraded / Invalid

| Action | Valid when |
| --- | --- |
| VIEW HISTORY | Always (read-only; `events_query` + causation links). |
| RESTORE FILE/GIT STATE | The checkpoint exists, no live thread is writing to the workspace, a safety checkpoint is taken first, the user confirms natively. Ignored files are never touched; HEAD moves only on an explicit "reset branch". |
| BRANCH FROM CHECKPOINT | Always non-destructive: a new branch or worktree at the checkpoint. |
| REPLAY ACTIONS | Only actions with a complete recorded `NormalizedAction` (Trust Kernel action log); every step is re-evaluated under the *current* mode. Model reasoning is never replayed. |
| RESUME SESSION | The provider documents resume and the thread has a provider session id; otherwise "start a new thread with this checkpoint's context". |

## Checkpoints

Stored in a self-contained shadow repository per workspace in KalCode's data folder (never in the
user's repository), with a quota, pruning and visible usage. Created at turn start when the
workspace changed, at task start, before restores, before automation runs and on request.

## Failure Autopsy (cross-cutting)

Reads a failure's timeline window and labels findings CONFIRMED (deterministically checked
evidence), LIKELY (heuristic, with confidence) or UNKNOWN. Remediations (test, rule, memory; skill
once Skills exist) are created only after the user accepts them, through the normal paths. Built
with the Benchmark Lab (`BENCHMARK_LAB.md`).

## Events

`timeline.checkpoint_created` / `_pruned`, `timeline.restore_started` / `_completed` / `_failed`,
`timeline.branch_created`, `timeline.replay_started` / `_completed`.
