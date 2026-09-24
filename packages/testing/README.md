# @kalcode/testing

Typed, deterministic test fixtures for KalCode's shared contracts (the ts-rs types generated
into `packages/protocol/src/generated`). Use it in Vitest component tests, Playwright UI tests'
in-memory transport, Storybook-style previews and perf tests instead of hand-writing objects.

- **Typed against the contracts.** Every builder returns the generated type. When a Rust
  contract changes and `pnpm gen:protocol` runs, `pnpm typecheck` fails here until fixtures
  follow. Enum lists (`THREAD_STATUSES`, …) and `samplePayloads()` are checked for
  exhaustiveness at compile time.
- **Deterministic.** No `Date.now()`, `Math.random()` or `crypto.randomUUID()`. The same seed
  produces byte-identical data: stable snapshots, reproducible failures.
- **Consistent defaults.** A `failed` thread has an `error`; a thread `waiting_for_permission`
  has `pendingApprovals: 1`; a resolved approval has `resolvedAt`; envelopes derive
  `correlation` from their payload's ids.

## Install

Add it to a workspace package's `devDependencies`:

```json
"@kalcode/testing": "workspace:*"
```

## Two ways to use it

```ts
import { createFixtures } from "@kalcode/testing";

// Preferred: an isolated context per test (its own ids, clock and event sequence).
const fx = createFixtures({ seed: 1 });
const thread = fx.buildThreadSummary({ status: "running_command" });
const approval = fx.buildApprovalRequest({
  action: fx.buildNormalizedAction({ threadId: thread.id, action: fx.buildActionKind("package_install") }),
});
```

```ts
import { beforeEach } from "vitest";
import { buildThreadSummary, resetFixtures } from "@kalcode/testing";

// Or the shared default context. Reset it when a file depends on exact ids or seq numbers.
beforeEach(() => resetFixtures());
const thread = buildThreadSummary({ status: "failed" });
```

## Override rules

Overrides always win, with one exception: an override that is `undefined` keeps the default,
so a spread of optional props never erases a derived value. Use `null` to clear a nullable
field (`{ error: null }`).

## API

### Context

| Export | Description |
| --- | --- |
| `createFixtures(options?)` | New isolated context. `options`: `seed` (default 1), `start` (clock start, RFC 3339, default `DEFAULT_EPOCH` = `2026-09-24T12:00:00.000Z`), `stepMs` (default `clock.tick()` step, 1000). Returns every builder below plus `ids`, `clock`, `id()`, `defaultWorkspace()`. |
| `resetFixtures(options?)` | Replaces the shared default context used by the top-level builders; returns it. |
| `fixtures()` | The shared default context. |

### Builders (on a context, and as top-level functions on the shared context)

| Builder | Returns | Defaults worth knowing |
| --- | --- | --- |
| `buildThreadSummary(overrides?)` | `ThreadSummary` | `status: "idle"`, provider `claude-code` (`providerName` derived), default workspace; `currentActivity`, `pendingApprovals` and `error` derived from `status` |
| `buildThreadError(overrides?)` | `ThreadError` | user-safe message |
| `buildThreadMessage(overrides?)` | `ThreadMessage` | assistant role |
| `buildActionKind(kind, overrides?)` | `ActionKind` variant `kind` | a realistic default per kind (`command` → `npm test`, `git` → `push origin`, …) |
| `buildNormalizedAction(overrides?)` | `NormalizedAction` | `summary` derived from `action` ("Run npm test") |
| `buildPolicyDecision(overrides?)` | `PolicyDecision` | `effect: "ask"`, approvable |
| `buildApprovalRequest(overrides?)` | `ApprovalRequest` | `status: "pending"`; `decision.scopes` from `defaultScopesFor(action)`; `resolvedDecision`/`resolvedAt` consistent with `status` |
| `buildCorrelation(overrides?)` | `Correlation` | all `null` |
| `buildEventEnvelope(payload, meta?)` | `EventEnvelope` | next `seq`, `version` 1 (or `originalVersion` for `unrecognized`), `correlation` derived from payload ids, `source` by type |
| `buildEvent(type, payload, meta?)` | `EventEnvelope` | typed shorthand: `buildEvent("thread.started", { threadId })` |
| `buildProviderDetection(overrides?)` | `ProviderDetection` | `state: "installed"`, authenticated; version/path/message consistent with `state` |
| `buildProviderCapabilities(overrides?)` | `ProviderCapabilities` | streaming, interrupt, resume, host approvals |
| `defaultWorkspace()` (context only) | `WorkspaceRef` | one workspace per context; threads and actions use it unless overridden |

`defaultScopesFor(action)` gives plausible scopes per action kind. It is a fixture default,
not the policy engine (Z4 owns the real mapping).

### Scenarios

Each returns `{ workspace, threads, approvals, events, providers }` with cross-referenced ids;
`events` are in ascending `seq`. All accept a context for seeding.

| Scenario | Contents |
| --- | --- |
| `busyWorkspace(fx?)` | 18 threads, one per `ThreadStatus` in lifecycle order, over three providers and several permission modes; a pending approval for the waiting thread; lifecycle events for every thread |
| `approvalFlood({ count = 50, threads = 5, fixtures? })` | `count` pending approvals across `threads` threads, cycling every action kind; each thread's `pendingApprovals` matches |
| `failures(fx?)` | failed (with errors), interrupted, offline and recovering threads; installed/outdated/not-installed/error providers; denied and expired approvals; `thread.failed`, `tool.failed`, `provider.error`, `shell.failed`, `app.previous_session_interrupted` events |
| `eventStream(count, fx?)` | `count` envelopes cycling through every event type (feeds, virtualization, perf) |
| `samplePayloads(fx?)` | one valid `EventPayload` per event type, keyed by type |

### Constants and helpers

`THREAD_STATUSES` (all 18), `LIVE_THREAD_STATUSES`, `ATTENTION_THREAD_STATUSES`,
`TERMINAL_THREAD_STATUSES` (mirror the Rust `ThreadStatus` helpers), `PERMISSION_MODES`,
`APPROVAL_STATUSES`, `APPROVAL_DECISIONS`, `DETECTION_STATES`, `ACTION_KINDS`,
`PROVIDER_NAMES`; `createIdFactory({ seed, epoch })` (monotonic UUIDv7), `createClock({ start,
stepMs })`, `createRandom(seed)`, `isValidId(id)` (same rule as Rust `is_valid_id`),
`isUuidV7(id)`, `withOverrides(defaults, overrides)`.

## When the contracts change

A new enum value or event type makes `pnpm --filter @kalcode/testing typecheck` fail with
`Type 'true' is not assignable to type 'false'` (enum lists) or a missing-property error
(`samplePayloads`). Add the value/sample, and a sensible default to the affected builder.
