# Agent runtime (threads)

Status: implemented in campaign Z3 · Source: `crates/threads` (`kalcode_threads`), IPC in
`apps/desktop/src-tauri/src/thread_commands.rs`, UI in `apps/desktop/src/surfaces/threads/`.

A **thread** is a persistent unit of AI work: one provider session (Claude Code, Codex, Gemini
CLI, …) running in one workspace under one permission mode. The thread runtime owns thread
persistence, drives provider sessions through the shared `AgentProvider` contract, turns their
normalized `AgentEvent`s into stored state and protocol events, routes every action the provider
asks to take through the `PermissionGate`, and recovers threads after a crash.

## 1. Boundaries

```text
            ┌──────────────── kalcode_threads::ThreadRuntime ────────────────┐
IPC (Z3) ──▶│ create/send/interrupt/pause/stop/resume/rename/archive/list/… │◀── non-UI callers
            │                                                                │    (voice layer, missions)
            │  ProviderRegistry ──▶ Arc<dyn AgentProvider>      (Z2 adapters) │
            │  WorkspaceResolver ─▶ name + canonical root        (Z1)         │
            │  PermissionGate ────▶ evaluate / open_request / expire (Z4)     │
            │  Core ──────────────▶ SQLite (0004) + event store + event bus   │
            └─────────────────────────────────────────────────────────────────┘
```

The runtime depends only on the shared contracts (`crates/contracts`) and on three injected
seams. Nothing provider-, workspace- or policy-specific lives in it.

| Seam | Type | Implemented by | On this branch |
| --- | --- | --- | --- |
| Providers | `ProviderRegistry` holding `Arc<dyn AgentProvider>` (+ account label, secret reference) | Z2 adapters | empty in the app; fake providers in tests |
| Workspaces | `trait WorkspaceResolver { list(); resolve(id) -> ResolvedWorkspace { id, name, root } }` | Z1 over its `workspaces` table | `NoWorkspaces` in the app; fakes in tests |
| Permissions | `PermissionGate` (contracts) | Z4 engine | `AskUnlessReadGate` in the app; a scriptable test gate in tests |

`ResolvedWorkspace.root` is native-resolved and canonical; it becomes the session's working
directory and never crosses IPC. The WebView supplies only ids.

## 2. Lifecycle and status

Status is **structured runtime truth** (`ThreadStatus`), never inferred from model prose.

| Trigger | Status change | Events |
| --- | --- | --- |
| `create` | new row, `starting` | `thread.created` |
| provider session started | — | `thread.started` |
| first prompt sent / any `send` | → `active` | `agent.message` (user), `thread.status_changed` |
| start with no input (resume without a message) | → `idle` | `thread.status_changed` |
| `AgentEvent::SessionStarted` while `starting` | → `active`; stores provider session id | `thread.status_changed` |
| `AgentEvent::Status` (provider-settable states only) | → that state | `thread.status_changed` |
| `ToolStarted` | → `running_tool` (activity = tool summary) | `tool.started` |
| `ToolCompleted` (no other tool running) | `running_tool` → `active` | `tool.completed` / `tool.failed` |
| `ApprovalRequired` + gate says Ask | → `waiting_for_permission` | (gate emits `approval.requested`) |
| last pending approval resolved | → status held before the approval | `thread.status_changed` |
| `TurnCompleted` | → `idle` | `thread.status_changed` |
| `interrupt` | → `idle` ("Interrupted by you") | `thread.status_changed` |
| `pause` | → `paused` (held until resumed) | `thread.status_changed` |
| `stop` / app exit | → `interrupted` ("Stopped by you" / "KalCode closed") | `thread.status_changed` |
| `Error { recoverable: true }` | unchanged; error recorded | `provider.error` |
| `Error { recoverable: false }` | → `failed`; session terminated | `thread.failed` |
| `Exited(0)` after a finished turn | → `completed` | `thread.completed` |
| `Exited` otherwise / sink dropped | → `failed` (`provider_exited`) | `thread.failed` |
| start/resume fails (`ProviderError`) | → `failed` with a user-safe reason | `thread.failed` |
| KalCode starts and finds a non-final thread | → `interrupted` ("KalCode closed while this thread was running") | `thread.status_changed` |

Providers may report only working states (`active`, `thinking`, `running_tool`,
`running_command`, `editing`, `testing`, `reviewing`, `idle`, `waiting_for_user`,
`waiting_for_dependency`). Lifecycle (`starting`, `completed`, `failed`, `interrupted`), approval
(`waiting_for_permission`) and user (`paused`) states belong to the runtime; a paused thread
stays paused until the user resumes it.

**Valid actions** (native rules; the UI mirrors them in `model.ts::threadActions`):

| Action | Valid when | Otherwise |
| --- | --- | --- |
| send | live session, no pending approval, not archived | `thread_not_running`, `thread_waiting_for_permission`, `thread_archived` |
| interrupt | live session and mid-turn (working or waiting for permission) | `thread_not_running`, `thread_not_working`, `interrupt_unsupported` |
| pause | live session | `thread_not_running` |
| stop | live session (or a non-final thread without one) | `thread_not_running` |
| resume | no live session, or paused; not archived | `thread_already_running`, `thread_archived`, `provider_unavailable`, `workspace_not_found` |
| rename | always (1–80 characters) | `invalid_name` |
| archive | no live session (idempotent) | `thread_running` |

**Resume** re-resolves the workspace, then starts a new session. When the provider supports
resume and the thread has a provider session id, the session is resumed
(`SessionConfig.resume_session_id`); otherwise a fresh session starts and a system message says
the provider won't remember the earlier conversation.

**Naming.** Without an explicit name, `naming::name_from_prompt` derives a deterministic,
title-cased name from the first sentence of the first prompt (filler and articles dropped,
acronyms canonicalised, identifiers kept, ≤ 48 characters): "fix the OAuth callback race in the
login flow" → "Fix OAuth Callback Race". The user can rename at any time.

## 3. Permissions

`AgentEvent::ApprovalRequired { request_id, action }`:

1. The runtime overwrites the action's `thread_id`, `workspace_id` and `provider_id` with its
   own (identity never comes from the adapter) and bounds the summary.
2. `gate.evaluate(action, thread.permission_mode)`:
   - **Allow** → `session.respond_to_approval(request_id, ApproveOnce)`.
   - **Deny** → respond `Deny`.
   - **Ask** → `gate.open_request(...)` (Z4 persists it and emits `approval.requested`); the
     thread goes `waiting_for_permission` with `pendingApprovals` and a structured activity
     ("Waiting for approval: Run npm install lodash"). If `open_request` fails, the runtime
     **fails closed** and responds `Deny`.
3. Decisions arrive on the event bus as `approval.approved` (with the decision),
   `approval.denied` or `approval.expired` for the gate's request id. A dispatcher thread
   forwards them to the session (`expired` and `denied` both answer `Deny`). A decision that
   arrives before the runtime has registered its request is held and applied on registration.
4. Interrupt, pause, stop and session end deny every pending request to the provider and call
   `gate.expire_for_thread`.

`ToolRequested/Started/Completed` from providers that run tools themselves are recorded but not
gated — only host-approval providers can be stopped before acting (see docs/PERMISSIONS.md §3).

Threads can be created in **Plan**, **Approve** (default) or **Auto**. Bypass needs an explicit,
confirmed user action and Custom needs a profile; both are set after creation through the
permission engine, which calls `ThreadRuntime::set_permission_mode` (records
`permission.mode_changed` atomically).

## 4. Persistence (migration 0004)

`crates/native-core/migrations/0004_threads.sql`:

| Table | Holds |
| --- | --- |
| `threads` | id, name, provider id/name, model, account label, workspace id/name, cwd, permission mode, status, current activity, provider session id, created/last-activity/archived times, error code/message, pending approvals, last-read message, token/cost counters |
| `thread_messages` | role, content, provider message id, time (ordered by `seq`) |
| `tool_calls` | tool, summary, status (`requested`/`running`/`completed`/`failed`/`cancelled`), result summary, requested/started/completed times |
| `thread_files` | distinct files a thread changed (workspace-relative path, last change) |

No credentials are stored: accounts are labels, and a session's `secret_ref` is passed through
from the registry and never persisted. Event payloads carry ids and short structured facts only —
never message text.

**Atomicity.** Every state change and its events commit in one SQLite transaction through
`Core::write_with_events` (added to native-core); events are published only after commit.

**Numbering and the workspace foreign key (integration).** Versions must be contiguous, and this
branch doesn't have Z1's `0002` or Z2's `0003`, so `db.rs` registers `0004_threads.sql` as
version 2 here. At integration register it as version **4**, after `0002` (Z1) and `0003` (Z2);
if Z2 ships no `0003`, either renumber the threads migration to 3 or add an empty `0003`
placeholder. `threads.workspace_id` has an index but no `REFERENCES workspaces(id)` clause, so
the migration applies independently of 0002. Because 0004 is unreleased, the lead may add
`REFERENCES workspaces (id) ON DELETE RESTRICT` to it at integration once Z1 guarantees a
workspace referenced by threads is never hard-deleted (or a later migration can rebuild the
table with the constraint).

## 5. Concurrency and isolation

- Each live session has its own channel and worker thread. A provider's `AgentEventSink` only
  enqueues, so a slow provider never blocks KalCode and one provider's failure (crash, error,
  hang) affects only its own threads.
- Per-thread state sits behind one mutex. Lock order: thread state → database. The runtime never
  holds the database lock while calling a provider, the gate or the resolver.
- Event-bus subscribers run while the core holds its database lock, so the runtime's subscriber
  only enqueues approval decisions for a dispatcher thread.
- Each session has a generation number; events from a stopped or replaced session are ignored.
- Workers hold the runtime weakly; dropping the runtime ends them and releases the core.
- Panics: release builds use `panic = "abort"`, so adapter panics are not recoverable in-process.
  Adapters must report failures as `ProviderError` / `AgentEvent::Error`.

## 6. Live streaming

Message deltas are not persisted events. `thread_stream { threadId }` opens a per-webview
channel of `AgentEvent`s (`message_delta`, `message_completed`); a new stream replaces the
window's previous one and a page reload drops it. Late subscribers first receive the text
already streamed for unfinished messages. Interrupt/stop/crash persist partial text and publish
`message_completed` so viewers never keep a stale in-progress message. Everything else reaches
the UI through the event log (`thread.*`, `agent.message`, `tool.*`, `file.*`), which triggers a
refetch of `thread_get` / `thread_messages` / `thread_tool_calls`.

## 7. IPC

| Command | Input | Output |
| --- | --- | --- |
| `thread_list` | `{ workspaceId?, includeArchived? }` | `ThreadSummary[]` (most recent first) |
| `thread_get` | `{ threadId }` | `ThreadSummary` |
| `thread_messages` | `{ threadId, limit (1–500), before? }` | `ThreadMessage[]` oldest first; the newest page marks messages read |
| `thread_create` | `{ providerId, workspaceId, model?, permissionMode, prompt, name? }` | `ThreadSummary` (a provider that fails to start yields a `failed` thread, not an error) |
| `thread_send` | `{ threadId, text }` | `ThreadSummary` |
| `thread_interrupt` / `thread_stop` | `{ threadId }` | `ThreadSummary` |
| `thread_resume` | `{ threadId, text? }` | `ThreadSummary` |
| `thread_rename` | `{ threadId, name }` | `ThreadSummary` |
| `thread_archive` | `{ threadId }` | `ThreadSummary` |
| `thread_stream` | `{ threadId }` + channel | stream id; `AgentEvent`s |
| `thread_options` *(Z3 addition)* | — | `ThreadOptions` (providers, workspaces, creatable modes, default mode) |
| `thread_tool_calls` *(Z3 addition)* | `{ threadId, limit (1–500) }` | `ToolCallRecord[]` oldest first |

Validation (all native, `kalcode_threads::validate`): ids with `is_valid_id`; provider ids as
lowercase slugs; models ≤ 128 characters from `[A-Za-z0-9._:/@[]-]` and, when the provider lists
models, one of them; names 1–80 characters without control characters; prompts non-empty,
≤ 100,000 characters, no NUL; page sizes 1–500; permission modes by enum (Bypass/Custom refused
at creation).

## 8. Non-UI API

The same `ThreadRuntime` serves callers other than the UI (the voice layer, missions,
automations) — no duplicate systems:

| KalVoice intent (`crates/contracts/src/kalvoice.rs`) | Runtime call |
| --- | --- |
| `CreateThreads { providerId, count, workspaceId? }` | `create_idle_threads(&CreateIdleThread, count)` (1–16; each starts `idle`, waiting for input; the caller resolves the workspace) |
| `OpenThread { query }` | `find(query)` (exact name, then name, then provider/workspace matches) |
| `PauseThreads { scope }` | `pause_threads(&ThreadScope)` |
| `ResumeThreads { scope }` | `resume_threads(&ThreadScope)` |
| `StopThreads { scope }` | `stop_threads(&ThreadScope)` |
| `StatusReport` | `status_summary()` (counts by status, working / needs-attention / pending approvals, every open thread) |

Bulk calls return one `BulkOutcome { threadId, ok, message }` per thread; a single named thread
(`ThreadScope::Thread`) is always attempted so the caller can say why it couldn't act. Also
available: `create`, `create_threads` (with tasks), `create_idle`, `send`, `interrupt`, `pause`,
`stop`, `resume`, `rename`, `archive`, `set_permission_mode`, `pause_all` / `resume_all` /
`stop_all`, `list`, `get`, `messages`, `tool_calls`, `options`, `subscribe_stream`, `shutdown`.

## 9. Testing

- `crates/threads/tests/runtime.rs` — 33 integration tests against a real `Core` with a fake
  provider (`tests/common`: scripted turns, slow turns, crashes, failed starts/sends,
  interrupt support, resume support), a scriptable permission gate and a fake resolver:
  lifecycle, status rules, message assembly and streaming, tool calls, files/usage, approval
  allow/deny/ask/deny-on-failure/early-decision, interrupt/pause/stop/resume, crash recovery,
  provider crash isolation, validation, bulk and scoped operations, task-less creation, search.
- `crates/threads/tests/migration.rs` — v1 database with data upgrades; schema constraints.
- Unit tests for naming, validation, store and path handling.
- UI: Vitest (`model.test.ts`, `ipc/memory/threads.test.ts`), Playwright `tests/ui/threads.spec.ts`
  (+ axe in both themes) against the in-memory transport, and a real-app E2E test that drives
  the native commands.
