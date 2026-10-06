# Squads and unified orchestration

Squads save a reusable team of real coding agents. Open **Code → Squads** or
**Operations → Squads**, choose the project, and launch the team. Each member keeps
its selected provider account, exact model and supported effort. Roles, launch
tasks, ownership paths, dependencies and manager relationships are optional.

The Squad editor and New Agent launcher share account-scoped model discovery.
Codex models come from its native app-server catalog, including each model's
supported effort levels. A saved exact selection remains visible if a refresh is
unavailable; background metadata never silently replaces it. Model discovery is
bounded independently of coding-agent execution.

Available members open the same native coding terminals used by Code and Agent
Fleet, including members whose tasks depend on other work. Those terminals show
Waiting while their canonical Operations remain queued; no launch prompt is sent
until the dependencies succeed. A member without a launch task becomes ready
without receiving a synthetic prompt. An unavailable provider/account holds only
its affected member with an actionable reason.

Saved Squad Recipes select a Squad and an optional goal override. KalVoice commands
such as “launch Engineering squad” and “run Review recipe” use the same native
launch commands as the buttons. Names must resolve uniquely. Launch request IDs
prevent duplicate sessions if a caller retries the same request.

## One authority

`crates/native-core/src/squads.rs` stores templates and relationships in the
existing Core SQLite database. A launched member points to one canonical
`OperationRecord`; that record owns its queue/run lifecycle and real coding
session ID. Squads do not store a second copy of agent status, account usage,
terminal state, task completion or release state.

`OperationsState` starts members through the provider-pane routes and existing
thread runtime. Provider adapters retain native tools and authorization. Agent
operations can run concurrently; the separate shell/service admission rules
remain intact. User-requested Squad agents use the interactive resource priority.

Dependencies are operation IDs. A failed member blocks only work depending on it.
Launch failures carry a durable attention reason, surfaced by the existing Needs
You model. Routine dependency waits are not user decisions. The existing stalled
agent detection reads the same canonical session activity.

Isolated members use the canonical Git worktree lifecycle. Shared-workspace
ownership declarations serialize tasks with overlapping scopes. An undeclared
scope means unknown workspace-wide ownership and also serializes shared-checkout
tasks; explicit disjoint scopes and isolated worktrees remain parallel. Waiting
members still have real coding terminals, with their launch task withheld.
Ownership guidance is advisory about what an agent should edit, not an OS
filesystem sandbox. Native provider permissions remain authoritative. Review
actual changed-file overlaps and merge conflicts before integrating work.

Manager relationships organize a team without owning worker processes. Changing
a manager does not recreate, erase or stop workers. A manager is a dependency only
when explicitly listed as one.

Handoffs continue to use the existing reviewed context delivery and exact source
and target coding sessions. A completed provider turn is **agent done**, not proof
that changes passed tests, merged or shipped. Use canonical run and outcome
evidence for those separate facts. Repository integration policy remains in
force: KalCode development submits ready PRs to the shared merge train, whose
parallel gate and release jobs operate independently of Squad membership.

Outcome attribution follows exact session IDs and explicit downstream Operation
dependencies. It does not infer a deployment from a shell command's name or an
agent's claim. A merge/release script executed inside a native provider terminal
retains its normal behavior; unless that pipeline supplies canonical linked
deployment evidence, KalCode shows delivery as unverified. A completed Squad
therefore says **Agents done**, never automatically **Shipped**.

## Recovery and compatibility

Migration 26 adds Squad templates, Recipes, launch relations and an optional
Operations attention reason. Existing operations, coding sessions, credentials
and project memory retain their authorities. Template edits or deletion do not
rewrite historical launches.

Startup reconciles Operations against durable session evidence. It never
automatically repeats an uncertain prompt. Interrupted or unavailable work stays
visible with a recovery action. Retry an affected member from its canonical Queue
when it is held before execution; keep independent members running. Completed,
failed and interrupted runs retain their final history. Open the member's real
terminal or use Handoff to continue its work; inspecting a run never replays it.
If a prepared member encounters a native setup or permission prompt before its
task is written, its terminal stays open and its Operation pauses with an
actionable reason. Resolve the prompt in that terminal, then explicitly run the
member again. Ordinary session resume does not resend the held task. An uncertain
write remains an interrupted or failed attempt rather than an automatic retry.
A repeated launch request returns the
original launch instead of creating another team.

Squads and these Squad-based Recipes retain the existing MAX plan placement.
The separate general Launch Recipes roadmap and its Free/Pro quotas are not
promoted to available by this implementation. Squads add no cap on local coding
agents. Model support, actual provider authentication, OS resources and the
existing plan authority remain distinct checks.

## Validation and rollback

Focused coverage lives in `crates/native-core/tests/squads.rs`, Operations and
thread runtime tests, Squad UI/model and IPC tests, KalVoice tests, Needs You
tests, and `apps/desktop/tests/e2e/squads.spec.ts`. Native E2E uses isolated
profiles and deterministic provider executables; it does not call paid services
or touch the owner's live application.

For rollback, preserve the database backup made by the canonical migration
runner. Prefer a forward corrective release retaining migration 26 and its
stored history. An older binary refuses a newer schema; reverting only the
binary is not a supported data downgrade. Never delete live worktrees, sessions
or database rows to roll back the interface.

Release verification must record the exact merged commit, internal build,
Windows and macOS updater receipts, and focused production proof before calling
this work shipped.
