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
| `workspace.created` / `.opened` / `.closed` | 1 | D (Z1) | `{ workspaceId, name }` |
| `shell.started` / `.completed` / `.failed` | 1 | D (Z1) | `{ terminalId, shell, exitCode? }` |
| `provider.detected` | 1 | I (Z2) | `{ providerId, installed, version? }` — on the first detection and whenever the state or version changes; `installed` is true for installed and outdated |
| `provider.error` | 1 | I (Z2) | `{ providerId, code, message }` — when detection first ends in error (not repeated while it stays in error); `code` e.g. `version_timeout` |
| `provider.connected` / `.disconnected` | 1 | D (accounts, later campaign) | `{ providerId, accountLabel? }` |
| `thread.created` / `.started` / `.status_changed` / `.idle` / `.paused` / `.resumed` / `.completed` / `.failed` | 1 | D (Z3) | `{ threadId, status, … }` |
| `agent.message` | 1 | D (Z3) | `{ threadId, messageId, role }` |
| `tool.requested` / `.started` / `.completed` / `.failed` | 1 | D (Z3) | `{ threadId, toolCallId, tool }` |
| `file.created` / `.modified` / `.deleted` | 1 | D (Z3) | `{ workspaceId, path }` |
| `approval.requested` / `.approved` / `.denied` | 1 | D (Z4) | `{ requestId, scope, decision? }` |
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
