# Account runtime integration gate

Status: implementation required; not release-certified.

Starting integration commit: `35c99cb43699813c8aba58e1fead6a5cd536076b`.
Primary owns the canonical startup coordinator and shared integration. The account
worker owns account authentication; the provider guardian owns process quiescence.

## Required lifecycle

The process-free shell manages AccountRuntime and a stable runtime coordinator.
Account bootstrap runs off the UI thread. A verified Active authority permits a
fresh runtime bundle to start; no provider probe, bridge, terminal, speech model,
or provider authentication process starts before this transition.

The coordinator states are SignedOut, Starting, Ready, Draining, BlockedUnclean,
and AppExiting. Every bundle has an account generation and runtime epoch. Startup
constructs off-lock and commits only after rechecking authoritative admission.
An obsolete or partly constructed bundle must be drained, retaining ownership if
cleanup cannot be proved. Duplicate Active notifications are idempotent.

The bounded account observer is a notification mechanism, not admission proof.
Every runtime command acquires an authoritative account lease plus runtime lease;
queued or long-running work revalidates immediately before its external effect.
Logout advances authority before waiting for cleanup. Events from older runtime
epochs cannot update the replacement UI/runtime.

Draining denies admission first, cancels startup/input, stops KalVoice, pending
provider authentication, threads/PTYs, panes/bridge, and locator/health, then waits
for in-flight operations and guardian quiescence. No coordinator/account mutex
may be held while waiting on another thread or UI operation. RuntimeShutdown's
application-exit success cache must not be reused for logout.

Existing void shutdown methods, auth-only success, callback delivery, and empty
registries are not generation-wide quiescence proof. The guardian must seal new
PREPARED admissions, include partial-start jobs, prove all registered job process
counts are zero, and persist CLEAN before returning the typed completion proof.
Failure retains authority in BlockedUnclean and prevents overlapping relogin.

## Integration dependencies

- Replace provider-pane process-global OnceLock routers with bundle-owned routes.
- Resolve provider/auth/thread/locator/health/KalVoice command facades through the
  current coordinator instead of immutable, one-shot Tauri-managed runtimes.
- Preserve permissions, mode bindings and provider registries within their epoch.
- Keep valid cached signed offline entitlement admission separate from network
  refresh progress; a routine refresh must not unnecessarily stop valid sessions.
- Keep account truth separate from local cleanup failure in UI state.

## Required regression and live proof

Unauthenticated cold start launches no workspace processes. Duplicate Active
updates start once. Logout during every partial startup stage cannot publish a
bundle. A queued pre-logout command cannot execute after logout. Routine refresh
preserves valid authority. Expiry and verified rejection revoke admission. Rapid
relogin waits for old-generation cleanup. Unproved cleanup retains ownership.
Guardian crash/restart tests demonstrate no overlapping profile use. After clean
logout, relogin creates fresh, working services and shortcuts. Native desktop E2E
must exercise these paths; isolated state-machine tests alone do not certify them.
