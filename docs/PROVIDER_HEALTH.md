# Provider Health + Capacity

Status: **built in PROVIDERS-2** (`docs/campaigns/PROVIDERS-2.md`) — the live model, events,
IPC, Providers → Health view and the Dashboard widget feed. Not built yet: persisted hourly
rollups (the v13 `provider_health_rollups` table; rollups are kept in memory for 30 days until
then, so trend history restarts with the app) and the Scheduler / Hot-Swap consumers (they don't
exist yet). Plan and acceptance criteria: `docs/campaigns/ADVANCED.md` §7.14; types:
`crates/contracts/src/health.rs` (`docs/CONTRACTS_ADVANCED.md` §6.1).

System code **PH** · Phase **P2** · Code: `crates/providers/src/health/`,
`apps/desktop/src-tauri/src/provider_health_commands.rs`, `apps/desktop/src/surfaces/providers/`.

## What is shown, and where it comes from

| Field | Source | Unknown when |
| --- | --- | --- |
| Detection (installed / not installed / outdated / error), version, minimum | Z2 detection (`--version`), pushed by the provider registry after every detection | never checked |
| Sign-in | a documented side-effect-free status command, when one exists (`codex login status` first line), or a real provider session | Claude Code and Gemini CLI have no safe passive command — unknown doesn't block a coding session |
| Account label | not read: KalCode never reads account details from a provider | always, until API-key accounts exist |
| Models | the adapter's documented list | Codex (listed only by app-server) |
| Process running, active sessions | sessions started and ended through the thread runtime (`ObservedProvider` wraps every adapter) | — |
| Latency p50 / p95 | time from sending a message to the first model output (message, delta or tool call), real sessions only, last 15 minutes | no session in the window |
| Recent failures, last failure | session errors in the last 60 minutes: crashed turn processes, failed turns, API errors, protocol errors, failed starts. Not counted: warnings, reconnect notices, user stops, "limited status" notices | — |
| Capacity / rate limit | **only** structured provider reports: Claude Code `api_rate_limit` (assistant `error: rate_limit`) and pane `StopFailure rate_limit`; Gemini CLI `RetryableQuotaError` → rate limited, `TerminalQuotaError` → quota exhausted. Codex's exec stream has no such shape, so a Codex limit is never reported. Message text is never interpreted. | no report (shown as "None reported") |
| Backoff until | only when a provider reports a retry time in a documented shape — none does today | always |
| Trend | hourly rollups: failures + rate limits per session in the latest hour with data vs the earlier hours (up to 6) | fewer than two hours with data |
| Recoverability | install / update / sign in (the provider's own command) / restart / automatic (a reported limit) | — |

## States

| State | When |
| --- | --- |
| `unknown` | not checked yet, or the health subsystem isn't running (every provider, `reason_code: health_unavailable`) |
| `unavailable` | not installed, outdated, detection failed, or signed out |
| `degraded` | a reported rate limit or quota error (capacity `backing_off`), or two or more failures since the last successful turn |
| `healthy` | otherwise (sign-in unknown says so in `reason`) |

A reported limit clears on the next successful turn, or goes stale after 60 minutes without
another observation.

## Events, cost and isolation

- `provider.health_changed { providerId, from, to, reason }` and
  `provider.capacity_changed { providerId, state, activeSessions, limit, retryAt }` on
  transitions only — never samples (`docs/EVENT_PROTOCOL.md`).
- Recording an observation is a bounded in-memory update under one lock; sinks forward the
  provider's event to the thread runtime **before** observing it, so health can't delay or drop
  thread events. Events and re-detections are delivered by one driver thread that sleeps until
  an observation arrives or the next one ages out of its window.
- **No polling.** Health never starts a coding session. A read-only re-detection
  (`--version` plus a side-effect-free status command when one exists) is requested only after a session couldn't start
  or a provider reported a sign-in failure: at most once a minute per provider, backing off to
  30 minutes. "Check again" on the Providers page always works.
- The code doesn't panic by construction (release builds abort on panic, so there is no
  unwinding to catch). If the monitor is missing, the IPC answers "unknown" for every provider
  and threads run unaffected (PH-06).

## Consumers

The Providers → Health view, the Dashboard "Provider health" widget, and later the Scheduler
(concurrency and backoff), Hot-Swap (failover signals), missions and the Command Center through
`provider_health_list` / `provider_health_get` / `provider_health_trend` (hours ≤ 720). The
Environment Doctor reads this snapshot rather than probing again.
