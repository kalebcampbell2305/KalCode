# Account-bound KalVoice Request accounting

Scope: replace the production `ProvisionalEntitlement` with verified native account authority,
server usage receipts, and durable offline request reconciliation. Branch:
`codex3/kalvoice-account-entitlement`, based on integrated candidate `083c1ee`.

## Behavior

- `AccountRuntime` re-verifies signed entitlement and usage documents for the native account;
  the WebView supplies neither account identity nor tier/allowance. OWNER remains a signed
  server grant. Same-account refresh is supported; logout/relogin cannot revive an old adapter.
- The production orchestrator uses this adapter. Signed receipt start/reset timestamps retain
  their exact UTC billing cycle. When no current verified receipt exists, the existing documented
  offline policy uses only this account's provisional device count and signed allowance.
- Native migration `0019_kalvoice_account_usage` adds an account/request-keyed outbox with no
  content or credentials. Last-unit admission and reservation occur in one SQLite transaction.
  Old unscoped execution rows are not attributed to any account.
- The original execution ledger still claims before any HTTP or command effect. Its internal
  UUID is derived from account identity and client request UUID; public events and server calls
  keep the original client UUID. Retries cannot execute twice, including after process loss.
- The existing `POST /v1/kalvoice/requests` uses a bounded 750ms request and exact idempotency key.
  Verified online receipts replace provisional usage. Unknown transport outcomes may proceed
  under the reserved verified offline allowance. Invalid proofs never authorize execution.
- `unconfirmed` reservations replay in online mode; admitted offline requests replay in offline
  mode. Reconciliation is retained by KalVoice's background-task owner, generation checked,
  shutdown sealed, and bounded to 32 records per pass. No database transaction spans HTTP.
- Dictation bypasses request metering entirely. Local commands and local reasoning use the same
  account allowance; no provider inference, authentication, or approval behavior changes.
- The existing service has no refund endpoint. “Type it instead” preserves counted account
  requests and the UI says so. Unknown proof failures warn that usage may have been counted;
  they never claim an action executed.
- Named `KalVoiceServices` packages the native coordinator's dependencies; the previous wiring's
  descending catalog sort now uses `sort_by_key(Reverse)` without changing selection. Unmapped
  speech entries are omitted rather than panicking or advertising an unsupported download.

## Verification

- `cargo test -p kalcode-kalvoice --lib -- --test-threads=1`: **240 passed, 2 existing ignored**.
  Includes account/legacy key isolation, duplicate execution fencing, interrupted metering,
  exhausted allowance and unlimited focused dictation, plus existing local-only provider tests.
- `cargo test -p kalcode-desktop --lib -- --test-threads=1`: **185 passed**.
  Includes all 40 account tests and five new actual SQLite/signed-vector adapter regressions:
  paid/OWNER/empty offline limits and exact cycle; lost response and restart replay; invalid
  receipt and old-generation refusal; independent-adapter last-unit race/legacy exclusion;
  authoritative allow/deny receipt counts replacing provisional counts.
- UI boundary suite: **7 passed**, including truthful counted-request “Type it instead” copy.
- Native migration runner: **6 passed**. After the final component lint cleanups, focused native
  KalVoice/account tests: **34 passed**, including signed speech mappings and provisioning.
- Runtime ownership source suite: **9 passed**. Desktop TypeScript, scoped Biome and Rust format
  checks pass.
- Strict desktop Clippy exposed existing non-packet findings in context, resource provider,
  thread, updater and utility host files. The parallel native gate worker owns those fixes.
  New accounting cycle/init and prior KalVoice catalog sort/mapping findings were repaired here.

## Integration and release

Cherry-pick the final packet onto the integrated candidate after existing voice wiring/browser/
Doctor changes. No API migration or new endpoint is required. Native migration 19 is registered
in the normal backed-up migration runner and must ship with the desktop binary.

The receipt write and SQLite acknowledgment are separate durable stores. A crash between them
can temporarily over-count a pending request; replay repairs this conservatively. An online
reservation may have been counted remotely even when the local action never ran. Recovery
reconciles usage only; it never replays command effects. These are intentional at-most-once
execution tradeoffs, not a server refund promise.

Tests use synthetic accounts, existing signed test vectors, fake transport, actual SQLite and
native code. No live billing mutation, production account request, physical microphone test,
installer signing, or publication was performed by this packet. The cfg(e2e) account fixture
explicitly reports an unavailable synthetic metering service so it exercises offline accounting
without fabricating production receipts; physical E2E remains a separate release gate.
