# Agent Handoff Chains

A chain passes one piece of work through an ordered set of real coding agents, for example
**Implement → Review → Fix → Test → Ready to merge**, without the person re-explaining the task at
each step. Each step can use a different provider, account, exact model and effort. Single-step
Hand Off (`docs/AGENT_HANDOFF.md`) stays the quick way to pass one task to one agent; a chain is
the multi-step form.

Plan: MAX and above (the `provider_handoff` placement), matching `handoff-chains` in
`packages/protocol/src/plans.ts`.

## Model: a relation over Operations, never a second workflow engine

- **Every step attempt is one Agent Operation.** It is a real provider terminal and a Run/Queue
  item. The Operations runtime owns queueing, the dependency wait, the session, settlement,
  restart recovery and Run history. Chains add no scheduler and no status enum of their own.
- **Ordering is Operations `dependencies`.** A chain launch is an ad-hoc Squad launch
  (`squad_launches` + `squad_launch_members`, no saved template), so the existing dependency-bound
  member path delivers each step's task exactly once, after its dependencies succeed. A failed
  step blocks only its dependents. Parallel branches are steps that share a dependency.
- **Chain-only facts** live in migration `0027_chains.sql`: goal, acceptance criteria, worktree
  mode, each step's intent and instructions, the current attempt per step, the structured step
  report, and the person's explicit decisions (pause, skip, cancel, recorded outcome).
- **Phases are derived on every read** (`ChainStepPhase`, `ChainPhase`, `waitingReason`,
  `nextAction`) from the Operation, the report and those decisions. They are never stored.
- Chain launches are filtered out of the Squads list; Squads stay reusable templates.

Contracts: `crates/contracts/src/chains.rs` (exported to `@kalcode/protocol`). Native store:
`crates/native-core/src/chains.rs`. Commands: `apps/desktop/src-tauri/src/chain_commands.rs`.
Client: `apps/desktop/src/ipc/chains.ts` (`client.chains`).

## Commands

| Command | Purpose |
|---|---|
| `chains_snapshot(workspaceId?)` | Chains plus exactly the Operations their steps point at |
| `chains_start(request)` | Idempotent by `requestId`; validates the graph and every step's route |
| `chains_pause(id)` / `chains_resume(id)` | Holds / releases steps that have not started; running steps keep running |
| `chains_cancel(id)` | Cancels steps that have not started; started terminals stay open under the person's control |
| `chains_retry_step(id, stepKey, route?)` | New attempt for a failed, blocked, cancelled or interrupted step; dependents are rewired to it |
| `chains_skip_step(id, stepKey)` | Dependents continue without this step; nothing already running is stopped |
| `chains_reroute_step(id, stepKey, route)` | New provider/account/model/effort for a step that has not started |
| `chains_record_step(id, stepKey, result, summary)` | The person's explicit outcome for a step whose agent finished without a report |

## The handoff package

When a step's dependencies are satisfied, KalCode builds its task at delivery time, not at launch.
It is small and structured. Raw terminal history is never copied.

1. Chain, step `n of N`, intent, goal and acceptance criteria.
2. Where to work: the shared worktree path and branch (or the project checkout) and its HEAD.
3. Each earlier step: name, intent, provider/model, result, its report summary, tests run with
   their result, and blockers.
4. Changed files in the working tree (paths only, at most 40, Context Firewall filtered).
5. Relevant Unified Memory for the goal and intent (the canonical retrieval, smallest useful set).
6. The step's own instructions, then the intent's action line.
7. The step report contract (below).

The whole package passes the Context Firewall before it is written to the terminal.

## Real outcomes: the step report

A provider's turn ending is not completion, and terminal prose is never parsed. Each step's agent
is asked to write one JSON file when it finishes:

```
.kalcode/chain-reports/<operationId>.json
{"version":1,"result":"passed"|"failed"|"changes_requested","summary":"…",
 "tests":[{"command":"pnpm test","passed":true}],"blockers":["…"]}
```

The folder is added to the repository's `info/exclude`, so it never appears as a change. Native
code reads it bounded (64 KiB), without following links, with unknown fields rejected, and strips
control characters. Then:

- `passed` or `changes_requested` → the Operation succeeds and dependents may run.
- `failed` → the Operation fails; only dependents are blocked.
- A Fix step whose review predecessors all **passed** is skipped automatically ("Review passed;
  nothing to fix"), recorded as a skip, never as a pass.
- No report when the turn ends → the step is **Needs report**: the agent may have asked a
  question. It surfaces in Needs You with **Open agent** and **Record outcome**. A report written
  later, after the person answers, still settles it.
- The provider process failing, the terminal closing, or an interrupted turn settle the step
  through the ordinary Operations path (failed or interrupted).

## Worktrees

- **Shared** (default): the first step creates one KalCode-managed worktree and branch; every
  later step attaches to the same tree, so review, fix and test see exactly the implementation,
  including uncommitted changes. Parallel steps in a shared tree may not both write: at most one
  of Implement, Fix and Continue can run at a time, so `chains_start` rejects parallel writers.
- **Project**: every step runs in the project checkout.

## Providers and capabilities

Chains are provider-agnostic: a step can use any provider that can run as an Operations agent
with task delivery (today Claude Code, Codex and Cursor; Gemini cannot yet prove readiness for
delivery). The check is capability-based, never a provider-name branch in chain logic. If a route
is unavailable (signed out, missing account, unsupported delivery), `chains_start` and reroute
fail with an actionable message that names compatible alternatives; KalCode never silently
switches provider or account. A step whose account signs out later is held with **Reconnect**,
exactly like any Squad member.

## Superseded work

When the shared branch is already merged into its base by newer work, steps that have not started
are cancelled as **Superseded**, with the reason, instead of running obsolete work.

## Merge and ship

When every step is satisfied the chain is **Ready to merge**, showing its branch. It then enters the
normal merge and ship pipeline like any validated change; a chain never adds a second release
ceremony. Outcome labels stay truthful: *agent done*, *verified*, *merged* and *shipped* are
different facts.

## UI

- **Start a chain** from a coding agent's **Hand off** dialog (the *Chain* tab), from Activity, or
  from the command palette (`New handoff chain`). Presets: *Implement → Review → Fix → Test* and
  *Review → Fix*. Each step row picks intent, provider/account/model/effort with the same pickers as
  New agent, and optional instructions. The current agent can be step 1 (its work is handed on).
- **Progress rail** (`ChainRail`): one node per step, connected left to right, parallel steps
  stacked. Each node shows intent, provider glyph and model, phase, and the waiting reason or
  outcome. The running step carries the electric-blue energy trace; waiting = amber; failed = red;
  passed = green; skipped and superseded are muted. One line under the rail states the next action.
- **Where it appears:** Activity (a *Chains* section above the Agent Fleet), each step's provider
  pane header (a compact `Chain · Review 2/4` chip that opens the rail), and the Fleet card of a step
  agent.
- **Needs You:** a step in *Needs report*, a failed step and a held (signed-out) step each produce
  one item with what happened, why it needs you and what to do next. A step that is only waiting
  for its predecessor is never an item.
- Controls: Pause/Resume and Cancel per chain; Retry, Skip, Reroute, Record outcome and Open agent
  per step, offered only when safe for that phase.

## Restart and recovery

Operations recovery applies unchanged: a step that was running when KalCode stopped is
interrupted, never replayed. Retry starts a new attempt in the same worktree. Reports already
recorded are durable.
