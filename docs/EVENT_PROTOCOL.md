# KalCode Event Protocol — v1

Status: v1 defined in Z0 · Source of truth: `crates/contracts/src/events.rs` (Rust; stored and
delivered by `crates/native-core/src/events/`) → generated TypeScript in
`packages/protocol/src/generated/`.

## 1. Goals

Events are **typed, versioned, persisted, streamable, inspectable and replayable**. They drive
the Dashboard, Mission Control, the activity feed, notifications, recovery, auditing and
diagnostics through one pipeline instead of many ad-hoc state channels.

## 2. Envelope

```jsonc
{
  "id": "0192f3c4-…",              // UUIDv7 (time-ordered), globally unique
  "seq": 1042,                      // per-installation monotonic sequence (SQLite rowid)
  "type": "settings.changed",       // dotted name: <domain>.<verb_or_state>
  "version": 1,                     // payload schema version for this type
  "occurredAt": "2026-09-24T18:02:11.412Z", // RFC 3339, UTC
  "source": "core",                 // "core" | "ui" | "provider" | "kalvoice" | "supervisor" | …
  "correlation": {                  // all optional; indexed for filtering
    "workspaceId": null,
    "threadId": null,
    "missionId": null,
    "providerId": null,
    "requestId": null
  },
  "payload": { "keys": ["theme"] }  // type-specific, schema determined by (type, version)
}
```

Rules:

1. `seq` is the ordering authority. Consumers must apply events in `seq` order and deduplicate
   by `seq`.
2. Events are persisted before being published.
3. Payloads never contain secrets, credentials, file contents or full prompts. Where a payload
   needs to reference user content, it references it by id.
4. Changing a payload shape incompatibly requires a new `version`; readers must handle every
   version they may find in the database.
5. A reader that encounters an unknown `type` decodes it as `unrecognized` (keeping `type` and
   `version`) instead of failing — the activity feed shows it generically.

## 3. Catalog

Status legend: **I** implemented and emitted · **D** defined, emitted from its campaign.

| Type | v | Status | Payload |
| --- | --- | --- | --- |
| `app.started` | 1 | I | `{ version, channel, platform, arch }` |
| `app.stopped` | 1 | I | `{ uptimeMs }` (graceful exits only) |
| `database.migrated` | 1 | I | `{ fromVersion, toVersion, backupCreated }` |
| `settings.changed` | 1 | I | `{ keys: string[] }` |
| `secure_store.checked` | 1 | I | `{ ok, backend }` |
| `workspace.created` | 1 | I (Z1) | `{ workspaceId, name }` — a folder was opened for the first time |
| `workspace.opened` | 1 | I (Z1) | `{ workspaceId, name }` — an existing workspace became active |
| `workspace.removed` | 1 | I (Z1) | `{ workspaceId, name }` — removed from KalCode's list (files untouched) |
| `shell.started` | 1 | I (Z1) | `{ terminalId, shellId, shellName }` — new tab or Restart |
| `shell.completed` | 1 | I (Z1) | `{ terminalId, exitCode, closedByUser }` — exit code 0, or the user closed the tab |
| `shell.failed` | 1 | I (Z1) | `{ terminalId, exitCode }` — the shell exited on its own with a non-zero code |
| `provider.detected` | 1 | I (Z2) | `{ providerId, installed, version? }` — on the first detection and whenever the state or version changes; `installed` is true for installed and outdated |
| `provider.error` | 1 | I (Z2) | `{ providerId, code, message }` — when detection first ends in error (not repeated while it stays in error); `code` e.g. `version_timeout` |
| `provider.connected` / `.disconnected` | 1 | D (accounts, later campaign) | `{ providerId, accountLabel? }` |
| `thread.created` | 1 | I (Z3) | `{ threadId, name, providerId, workspaceId }` |
| `thread.started` | 1 | I (Z3) | `{ threadId }` — a provider session started (create or resume) |
| `thread.status_changed` | 1 | I (Z3) | `{ threadId, from, to, detail? }` — idle, paused, resumed and waiting states are status changes, not separate types |
| `thread.renamed` / `.archived` / `.completed` | 1 | I (Z3) | `{ threadId, name? }` |
| `thread.failed` | 1 | I (Z3) | `{ threadId, code, message }` — user-safe message |
| `agent.message` | 1 | I (Z3) | `{ threadId, messageId, role }` — never the message text |
| `tool.requested` | 1 | I (Z3) | `{ threadId, toolCallId, tool, summary }` |
| `tool.started` / `.completed` | 1 | I (Z3) | `{ threadId, toolCallId }` |
| `tool.failed` | 1 | I (Z3) | `{ threadId, toolCallId, summary? }` |
| `file.created` / `.modified` / `.deleted` | 1 | I (Z3) | `{ threadId?, path }` — workspace-relative where possible |
| `approval.requested` | 1 | I (Z4) | `{ requestId, threadId, scopes, summary }` — the engine asked; the thread waits |
| `approval.approved` | 1 | I (Z4) | `{ requestId, threadId, decision }` — answered by the user only |
| `approval.denied` / `.expired` | 1 | I (Z4) | `{ requestId, threadId }` — expired: thread stopped or interrupted, superseded, mode changed, restart, answered in the provider |
| `permission.mode_changed` | 1 | I (Z4) | `{ threadId?, from, to }` — once per change, with its audit row; `threadId: null` for the default mode |
| `git.branch_changed` / `.diff_changed` / `.commit_created` | 1 | D (Z6) | `{ workspaceId, … }` |
| `kalvoice.dictation_started` / `.dictation_completed` / `.dictation_failed` | 1 | D (Z12) | `{ sessionId, durationMs?, characters?, code? }` — never the transcript |
| `kalvoice.request_started` / `.command_recognized` / `.command_executed` / `.request_completed` / `.request_failed` | 1 | D (Z12) | `{ requestId, input?, intent?, code? }` — never the request text |
| `kalvoice.limit_reached` | 1 | D (Z12) | `{ allowance, resetsAt }` |
| `kalvoice.provider_selected` | 1 | D (Z12) | `{ intelligence, scope }` |
| `kalvoice.voice_output_started` / `.voice_output_completed` | 1 | D (Z12) | `{ requestId }` |
| `mission.*`, `verification.*` | 1 | D (Z9/Z10) | |
| `automation.*`, `notification.created` | 1 | D (Z11) | |

Streaming high-volume data (terminal bytes, token deltas) is **not** sent as persisted events;
it uses dedicated channels, and only lifecycle transitions are events.

Provider sessions emit normalized `AgentEvent`s (message deltas, tool status, usage, errors; see
`docs/PROVIDERS.md` §8). These are **not** persisted events either: they stream live to the
thread runtime (`thread_stream`, Z3), which records only lifecycle transitions (`thread.*`,
`tool.*`, `agent.message`) in the event log. `provider.*` events come from detection, recorded
by `providers_detect`.

Z3 thread, agent, tool and file events carry `correlation.threadId`, `correlation.workspaceId`
and `correlation.providerId`; a state change and its events commit in one transaction
(`Core::write_with_events`). Live message deltas stream over `thread_stream` and are never
events.

Z1 events carry `correlation.workspaceId`. A tab and its `shell.started` event commit in one
transaction; so does a close and its `shell.completed { closedByUser: true }`. Shells that end
because KalCode exits are not individually recorded: `app.stopped` marks the end of the session
and their tabs are stored as ended by the app (see `docs/CODE_MODE.md`).

## 4. Storage

Table `events` (see `docs/DATA_MODEL.md`). Correlation ids are stored in dedicated indexed
columns. Payload is stored as JSON text.

## 5. Transport

- Native → UI: Tauri `Channel<EventEnvelope>` per subscription (`events_subscribe`).
- Backfill: `events_recent { limit ≤ 500, beforeSeq? }` returns newest-first pages.
- Subscribe-then-backfill avoids gaps; the UI store merges by `seq`.

## 6. Versioning of the protocol itself

The envelope is **protocol v1**. Adding event types or optional correlation fields is
non-breaking. Changing envelope fields requires protocol v2 and a migration plan.
