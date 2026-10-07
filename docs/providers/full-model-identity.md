# Full model identity

The canonical account state is `ProviderAccountSessions`; the canonical session
projection is `sessionIdentity`. UI consumers share those authorities rather than
starting separate account, model or quota probes. Native provider adapters own model
discovery and launch syntax.

## Contracts

| Fact | Authority | Unknown or stale behavior |
| --- | --- | --- |
| Provider and account | Thread provider ID and exact bound account ID | Preserve the binding and snapshot nickname; offer reconnect without substituting another account |
| Requested model/reasoning | Persisted thread `model` and `effort` | Explicitly label as selected; never imply a provider confirmed them |
| Reported model/reasoning | Authenticated structured provider metadata | Omit unreported values and show provider-controlled state |
| Available models | Exact-account catalog, with provenance and observation time | Keep cached choices visible while checking; only fresh runtime evidence proves absence |
| Launch preference | Existing local launch memory, indexed by workspace/provider/account | Read legacy entries only for their recorded context; preserve explicit default model IDs |
| Compact usage | Existing canonical weekly-window selector | No weekly report means unavailable; rolling windows remain in expanded detail |
| Task name | Existing persisted automatic/manual name ownership | First meaningful prompt supplies a task title; explicit save always owns the name |

Provider reports do not rewrite launch preferences. Starting a new process or changing
accounts clears its previously reported runtime identity. Completed execution history
must use its own durable event evidence, never the latest model of a reused agent.

## Surface integration

Code headers, Agent Fleet, Workspace Dock, Threads, Runs, Queue, Squads, Handoffs and KalVoice consume
canonical session facts. Account Usage and terminal headers share weekly usage state.
Task titles remain primary. Truncated identity is available through full detail, with
keyboard access in the compact terminal header. The website demonstration labels its
simulated identity and follows the same weekly-first presentation.

Workspace Dock Runs and Queue reuse the Operations identity projection. Completed
runs retain their own observed account/model/effort even when their terminal is reused.
Queued work displays selected intent. Account health retains unknown, checking and
expired states instead of presenting unverified accounts as healthy.

## Failure and isolation guarantees

- Catalog responses must match both requested account ID and provider ID. Late results
  are discarded after account revision or transport changes.
- Informational model/usage failure does not revoke authentication. Expiry retains the
  bound account and reconnect path.
- Documented aliases and stale caches cannot reject an explicit model or reasoning
  choice as unsupported. A fresh runtime catalog can offer a compatible next choice.
- Missing effort metadata remains unknown even in a fresh model catalog. Only an
  explicit model or account effort list can disprove a saved reasoning choice.
- Provider model switches use authenticated root-session metadata; subagent model
  reports cannot replace the parent session's identity.
- Exact model selectors are bounded opaque arguments. Windows batch shims must
  resolve to their native executable/script before launch; an unresolved wrapper
  is rejected with an actionable error rather than interpreting model text in a shell.
- Quota advice uses the reported model where available. Model-scoped windows match
  complete identifier tokens, so `opus-4-1` cannot borrow `opus-4-10` usage.

## Compatibility and rollback

Migration 0028 adds nullable runtime identity columns. Existing launch columns and
legacy preference storage remain readable. New protocol fields are additive and
optional. Tests and release update proof use isolated databases and profiles.

Rollback is a forward corrective release through the shared merge train. Preserve
migration 0028 and its schema registration when reverting behavior: do not ship an
older schema reader against a database that has already advanced, remove user data,
or reset shared main. Keep subsequent commits and signed update ordering intact.
An older binary fails closed with `schema_too_new`; the updater rollback floor must
prevent installing it over schema 28. A pre-migration backup is for explicit disaster
recovery, with acknowledged loss of later local changes, and must be reopened with a
schema-28-or-newer build. Never edit migration checksums or overwrite the active profile
as routine rollback.

## Validation scope

Focused regression coverage covers configured-versus-reported identity, model switches,
account/project preference isolation, renamed/expired accounts, stale catalogs,
explicit defaults, future native selectors, historical execution identity, restart,
migration persistence, same-name manual ownership, and weekly usage. Browser proof
covers four concurrent Claude Code/Codex panes, responsive headers in both themes,
keyboard identity details and inline renaming. Deterministic adapters do not constitute
a paid-provider or upstream model-availability certification.
