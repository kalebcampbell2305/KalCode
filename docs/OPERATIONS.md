# Operations

Operations is KalCode's local engineering harness for Runs, Queue, Services, Environments, and
Activity. This document describes the implemented architecture and its truth limits. It is not a
production-release certification.

## One model

Migration 20 adds `operations`, `operation_moments`, and the single-row `operations_state` table
to KalCode's existing SQLite database. `OperationsStore` is the only durable writer. A queued task
keeps the same operation ID when it is claimed, bound to execution, and completed; the Runs view
is history for that same record. Dependencies, priority, lane, provider selection, branch,
revision, status, and outcome therefore do not need a second queue or run database.

Services, Environments, and Activity are read-only projections. They combine operation records
with bounded native observations, typed event envelopes, and read-only Git samples. Existing
threads, tool calls, terminals, and Environment Doctor runs can appear as observed runs, but those
rows remain owned by their original runtime and are not copied into `operations` or made
executable through the queue.

## Admission and execution

Saving or starting work crosses the native IPC boundary. KalCode validates the workspace,
execution shape, dependency graph, provider/account/model selection, secret-free input, and
environment before showing a native confirmation. Unsupported per-task effort values are refused
rather than silently ignored.

Consent is held only in memory for the exact operation specification, provider selection, and
captured Git branch/revision. It expires after 30 minutes, is consumed once, and is invalidated by
a workspace revision change, edit, sign-out, shutdown, or restart. It is never restored or
replayed. A queued item without current consent stays blocked until **Run now** obtains a new
confirmation. Production is identified explicitly in that confirmation.

Agent work starts through the existing account-bound thread runtime and its provider-native
permission path. Commands, builds, tests, scripts, deploys, releases, background commands, and
services start through Core's guarded operation PTY in the selected workspace. The scheduler
borrows the current account runtime lease, uses atomic store claims and bounded execution slots,
and pauses on unproven cleanup. A restart does not retry work: active durable records are resolved
from recorded terminal evidence where possible, otherwise interrupted, and the queue is paused.

### Command artifact reports

An Operations command can opt in to artifact evidence through the native-only
`KALCODE_OPERATION_ARTIFACT_REPORT` environment variable. The command must finish each output
first, write a sibling temporary report, close it, and atomically rename it to the supplied path
before the command exits. The version 1 JSON shape is
`{"version":1,"artifacts":["dist/app.zip"]}`. Reports are limited to 64 KiB and 256 paths.
Paths must be workspace-relative, must not contain private or secret-shaped components, and must
resolve without links or reparse points to regular files inside the exact operation workspace.
Directory bundles such as `.app` and `.dSYM` must be packaged as a regular `.zip` or `.dmg` for
this version of the contract.

This portable Node pattern works from Windows and macOS build scripts without exposing the native
data directory anywhere else:

```js
import { renameSync, writeFileSync } from "node:fs";

const report = process.env.KALCODE_OPERATION_ARTIFACT_REPORT;
if (report) {
  const temporary = `${report}.tmp`;
  writeFileSync(temporary, JSON.stringify({ version: 1, artifacts: ["dist/app.zip"] }));
  renameSync(temporary, report);
}
```

KalCode validates reported files after the terminal exits and persists typed, exact run/workspace
evidence. Missing reports are valid. KalCode does not scan the workspace or infer artifacts from
terminal output, and a report proves only that the command declared a verified file as an output.

## What each view proves

- **Runs** shows durable Operations records plus bounded observations from the thread, tool,
  terminal, and Doctor authorities. Durable logs are bounded to 512 KiB and pass through the
  shared secret redactor before storage. Typed file events and exact run, thread, terminal, tool
  call, or Doctor-run identities supply detail evidence; prose is not parsed into test counts or
  artifacts.
- **Queue** is the pending subset of the same durable records. Edits and reordering use the
  `operations_state.revision` optimistic lock. Dependency ordering is computed transactionally;
  blocked dependencies cannot be bypassed by drag order or **Run now**.
- **Services** samples workspace-related processes and listening ports through native Windows and
  macOS implementations. A process can be shown without a port, and a listening port does not
  prove HTTP health. Stop and restart are enabled only when the process belongs to an
  Operations-owned runtime identity; externally discovered services remain view-only.
- **Environments** always projects Local, Preview, Staging, and Production for each workspace.
  Local state can prove an observed process or port, never endpoint health. Remote deploy success
  is `deployed_unverified` until a current provider health probe exists. A later failed deploy does
  not erase the preceding successful branch/version, and declared URLs are targets rather than
  liveness evidence.
- **Activity** projects typed events, run transitions, and bounded Git log samples. File areas come
  only from safe workspace-relative paths. Secret-shaped or private paths are withheld.

Environment-variable values never enter Operations. Specs contain expected names only. Local
presence means the variable name exists in KalCode's inherited process environment; it does not
inspect a workspace `.env` file, a child service's complete environment, a provider secret store,
or a remote platform. Preview, Staging, and Production variable presence remains unknown without
an authoritative provider adapter. Configuration names and declared URLs come from the current
successful remote deployment, or from currently running local services linked to their run; old
deployments and queued future work do not accumulate into the environment view.

## Finite observations and history

The overview is deliberately finite. A snapshot contains every pending/active durable record,
the latest 200 finalized records, and the additional deployment/service records needed to retain
current truth. Its observed-runtime portion contains the latest 100 agent turns and 100 tool
calls. Older durable Operations, agent-turn, tool-call, shell, and Doctor records remain available
through one cursor-based history, 100 at a time. Opening one of those rows resolves its exact
detail from the canonical source identity rather than relying on the overview window. A source
record without durable completion evidence is **Unknown**; KalCode does not infer success or
failure from its age or absence from the overview.

Activity reads at most ten 500-event pages and reports when older events were omitted. Service
observations are cached for five seconds. Git activity is sampled for at most 16 workspaces and 50
commits per workspace, cached for 30 seconds. The merged Activity response is deduplicated,
sorted, and capped at 5,000 items. These limits mean absence outside the displayed window is
unknown, not proof that work never occurred.

## Verification

The focused evidence suite in `crates/utilities/src/operation_evidence.rs` verifies environment
truth labels, failed-deploy preservation, exact event correlation, sibling tool/Doctor isolation,
turn outcomes, safe paths, secret redaction, and non-invented test results. Native integration
tests in `crates/native-core/tests/operations.rs` exercise the durable identity, dependency order,
atomic claims, concurrency slots, recovery, real command completion, output bounds, and paged
history. `operations_terminals.rs` exercises real operation terminals, generation-bound stop and
restart, exit codes, logs, and workspace ownership. Desktop Rust, IPC, model, and component tests
cover consent lifetime, observation mapping, command envelopes, history loading, queue actions,
environment truth, and the Activity heatmap.

Windows and macOS use the same contracts and product flow with platform-native process, port, and
PTY implementations. Each platform still requires its signed-build and physical release checks;
passing the shared tests alone is not evidence that a production build is live.

## Rollback and migration 20

The current public milestone remains `0.1.7`. For this Operations shipment, `0.1.7+1` is the
private, never-selected QA baseline derived from the candidate source, and `0.1.7+2` is the
production candidate. Neither signed physical-platform QA nor live publication is claimed here.

Recovery after migration 20 is forward-only: publish a higher internal `+N` build that restores
the previous application behavior while preserving migration 20 and its data. Device-local
**Restore previous** is allowed only when the verified retained build is schema-compatible. On
macOS, the forward-only schema upgrade fence must durably remove rollback ownership from the
shipped legacy helper before Core opens and migration begins; failure to write the fence blocks
Core startup. Do not delete the tables, edit the recorded migration checksum, reset the user's
database, or copy an old database/profile over the active one. A later corrective migration may
archive or transform Operations data transactionally if a schema defect requires it.

Migration 20 is applied in one transaction after KalCode creates its normal pre-migration backup.
An older binary that knows only schema 19 will refuse a schema-20 database as too new. Testing or
using that binary requires a verified clone of the pre-upgrade backup in an isolated data root;
never make an old binary compatible by deleting migration rows or Operations tables from the
current database.

The private `0.1.7+1` baseline contains the same schema-20-capable code as the candidate. A
`0.1.7+1 -> 0.1.7+2 -> 0.1.7+1 -> 0.1.7+2` trial can prove updater mechanics and compatible-only
rollback. It does not prove that the real published schema-19 `0.1.7` can open a profile after
migration 20, and release evidence must not describe it that way.
