# Shutdown Proof — 2026-09-25

## Authority and scope

- Starting branch / commit: `sec/providers-harden` / `35c99cb43699813c8aba58e1fead6a5cd536076b`.
- Canonical worktree: `.worktrees/sec-harden`.
- Owned implementation: thread-runtime termination proof, hook-bridge listener join proof, the two desktop shutdown wrappers, shutdown regressions, and this evidence record.
- Protected state: no provider calls, credentials, owner memory, production stores, publishing, signing, installation, or deployment were used.

## Confirmed root causes

1. `ThreadRuntime::end_session` removed its `AgentSession`, advanced the generation, and persisted an interrupted/failed state even when `AgentSession::terminate` returned an error. The runtime therefore lost the only process owner without proof that the provider process tree ended.
2. `ThreadRuntime::shutdown` returned `()` and only logged per-session failures, so its caller could not distinguish a complete drain from a live retained process.
3. `BridgeServer::shutdown` set the stopping flag before joining. Concurrent and repeat callers returned as soon as they saw the flag, even while the first caller was still joining, and the join panic result was discarded.
4. Desktop shutdown wrappers discarded both runtime and bridge proof. Provider-pane webview attachments also remained in the retained view map during teardown.
5. A detached provider-health recheck retained an old registry but acquired only the current `ThreadsState`. After logout and relogin it could pair the old registry with a replacement thread runtime, emit stale events, and synchronize stale detection into the new epoch.

## Implemented contracts

- `ThreadRuntime::shutdown_checked(&self) -> kalcode_core::Result<()>`
  - attempts every running session;
  - returns `Ok(())` only when every termination call succeeds;
  - leaves a failed session and its state owned for a later retry;
  - keeps `shutdown()` as a logging compatibility wrapper.
- `BridgeServer::shutdown_checked(&self) -> Result<(), BridgeShutdownError>`
  - uses a two-second bound;
  - returns typed `TimedOut` or `ListenerPanicked` failures;
  - retains the join handle after timeout;
  - stores and replays the joined terminal result to concurrent/repeat callers;
  - keeps `shutdown()` as a logging compatibility wrapper.
- `ThreadsState::shutdown_checked(&self) -> kalcode_core::Result<()>` forwards thread proof.
- `ProviderPanesState::shutdown_checked(&self) -> Result<(), BridgeShutdownError>` drains and detaches retained pane views before forwarding bridge proof.
- The account runtime coordinator consumes both checked wrapper results when classifying a drain as clean.
- Provider-health listeners carry weak identity for their exact `HealthMonitor` and `ProviderRegistry`. Transitions acquire and hold current health/provider runtime leases; rechecks also hold the current thread lease. Exact `Arc` identity and every lease are revalidated before detection, before each event emission, and before provider synchronization.

## Red evidence

- Thread regression initially failed to compile because `ThreadRuntime::shutdown_checked` did not exist (`E0599`).
- Hook-bridge regressions initially failed to compile because `ListenerThread` and `BridgeShutdownError` did not exist (`E0433`).
- The standalone coordinator source guard failed because `RuntimeBundle::stop` still called the void shutdown wrappers.
- The provider-health epoch regression initially failed to compile because the `HealthEpoch` identity guard did not exist (`E0433`).

## Green evidence

- `cargo test -p kalcode-threads -j 2`
  - 64 passed, 0 failed: 22 unit, 2 migration, 38 runtime, 2 workspace; doc tests 0/0.
  - Includes failed termination retention/retry and all-session drain despite one failure.
- `cargo test -p kalcode-hook-bridge -j 2`
  - 43 passed, 0 failed: 26 unit and 17 integration; doc tests 0/0.
  - Includes timeout ownership retention/retry, typed repeatable listener panic, eight concurrent checked callers, repeat shutdown, and endpoint rebind.
- `cargo test -p kalcode-desktop --test shutdown_authority`: 1 passed, 0 failed after coordinator wiring and full desktop compilation.
- Focused provider-health epoch regression: 1 passed, 0 failed. It rejects replacement health epochs, monitor substitution, registry substitution, and revoked leases before allowing a side effect.
- Neighboring desktop library suite: 110 tests executed; 104 passed and 6 guardian-owned authentication fixtures failed closed with `provider_guardian_unavailable` while the guardian workstream was still changing its executable checkpoint. The provider-health and shutdown tests passed in that run; this is recorded as an external workstream checkpoint, not a clean full-suite claim.
- Owned-path `git diff --check`: clean.

## Recovery and compatibility

- Retrying checked thread shutdown reuses the retained live `AgentSession` and only clears runtime state after termination succeeds.
- Retrying checked bridge shutdown reuses the retained `JoinHandle`; a terminal join result is idempotent for every later caller.
- Existing void `shutdown()` APIs remain source compatible and log any unproven cleanup.
- No schema, migration, durable data, provider profile, pricing, auth, billing, or release-format change is part of this repair.

## Effects and rollback

- Memory mutations: 0.
- Archive imports: 0.
- External effects: 0.
- Paid provider calls: 0.
- Secret/private-file staging: 0.
- Commit/push/deploy/sign actions: 0.
- Rollback: restore the owned file hunks from the phase rollback reference; no data rollback is required.
