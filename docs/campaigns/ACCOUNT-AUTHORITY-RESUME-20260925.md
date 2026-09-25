# Account authority resume evidence - 2026-09-25

Status: account-owned native authority and desktop account integration complete. Canonical release,
signing, publication, deployment, and production verification remain integration-authority work.

## Continuity and scope

- Native account repair worktree: `.worktrees/desktop-account-stage`
- Native account branch and starting HEAD: `work/desktop-account-20260925` at
  `c6f5fb331d8f7805a570707ab224da650091810c`
- Canonical integration worktree: `.worktrees/sec-harden`
- Canonical branch and starting HEAD: `sec/providers-harden` at
  `35c99cb43699813c8aba58e1fead6a5cd536076b`
- No commit, merge, push, production credential, account, email, payment, browser, provider, or
  network effect was made by this workstream.
- Existing updater, provider-account, context, resource, KalVoice, and other concurrent changes
  were preserved.

## Native authority repairs

The native account work fixed and regression-tested these confirmed defects:

1. A cancelled email-auth request could complete a protected-store write and publish obsolete
   pending authority. Generation is now checked after the durable write and at publication.
2. Logout revoked the generation but did not join the account request lane. Logout now revokes
   first, waits the lane, clears durable state, publishes SignedOut, and only then completes its
   best-effort remote cleanup.
3. Checkout and portal browser effects were not generation-bound. `BrowserLaunch` carries an opaque
   generation and `commit_browser_launch` validates it at the opener boundary.
4. Duplicate bootstrap repeated remote verification. Bootstrap is idempotent for an initialized
   runtime, retryable after failure, and exposed through an off-thread command entry point.
5. No-op email-auth cancellation invalidated an unrelated active lease. Cancellation now preserves
   the generation when no email-auth operation exists.
6. `AuthorityLease::generation()` exposes the opaque account epoch needed by the runtime
   coordinator while all authority checks remain in `validate_active_lease`.

Native account verification run in the isolated account worktree:

- `cargo test -p kalcode-desktop --test account_runtime --jobs 2`: 14 passed, 0 failed.
- `cargo test -p kalcode-desktop --test account_api --test account_commands --test account_model --test account_runtime --test account_session_cache --jobs 2`:
  26 passed, 0 failed.

The canonical integration authority copied the frozen native source, added coordinator admission
and synchronous drain wiring, and reported a successful native compile. Shared coordinator and
facade verification remains recorded by that authority.

## Desktop integration

The canonical desktop now:

- parses and validates redacted account snapshots, usage, and exact runtime lifecycle status;
- rejects inconsistent runtime readiness and credential-shaped response fields;
- generation-fences late account and runtime results after cancellation or logout;
- bounds plan-confirmation and runtime-transition polling, exposes an honest retry after timeout,
  and never derives a local plan or local authority;
- mounts `RuntimeProvider` and the workspace only when account authority is `ready` or
  `offline_grace` and native runtime status is `ready`;
- keeps relogin locked while native cleanup is `draining`, distinguishes `blocked_unclean`, and
  requires restart before another account can enter that runtime;
- exposes public email, signed plan, usage, portal, and logout controls in Settings;
- provides deterministic UI-test account scenarios with zero email, checkout, browser, credential,
  payment, or network effects.

## Frontend verification

- Focused account unit/integration tests: 22 passed, 0 failed across IPC validation, deterministic
  memory flows, reducer fencing, provider races and polling, onboarding, logout/relogin, redacted
  errors, settings, and runtime gating.
- Complete desktop Vitest suite:
  `pnpm --filter @kalcode/desktop test`: 55 files, 450 tests passed, 0 failed. The increase is the
  registered native E2E helper-inventory contract.
- Desktop typecheck:
  `pnpm --filter @kalcode/desktop typecheck`: passed.
- Production frontend build:
  `pnpm --filter @kalcode/desktop build`: passed; Vite reported only the pre-existing large-chunk
  and Tauri dynamic-import warnings.
- Headless UI account flow:
  `pnpm --filter @kalcode/desktop exec playwright test --config tests/ui/playwright.config.ts tests/ui/account.spec.ts`:
  2 passed, 0 failed. This covered onboarding, Free activation, workspace admission, Settings
  logout, clean relogin, offline-grace visibility, and serious/critical axe checks.

## Isolated native lifecycle fixture

The `e2e` feature now provides two deterministic account modes behind the exact
`KALCODE_E2E_ACCOUNT_FIXTURE` opt-in:

- `onboarding-v1` starts signed out and exercises the real account commands through email/PKCE,
  Free activation, signed authority, usage, logout, cleanup, and relogin.
- `ready-v1` seeds only an in-memory synthetic session and checked-in signed Free entitlement so
  the existing native suites can reach their original runtime assertions without reading the OS
  credential store or contacting the account API.

The fixture accepts only an absolute, canonical, explicitly marked `kalcode-e2e-*` directory. It
rejects symlinks, standard application-data paths, invalid markers, and existing native stores
that lack the exact E2E attestation. This supports deterministic restart tests while refusing an
unmarked production-shaped store. Paid checkout, portal, browser opening, real email, network,
and production signing keys are absent from the fixture.

The real WebView2 account lifecycle test asserts:

- `runtime_status` is `signed_out` with `ready: false` before activation;
- shell admission is denied as `authentication_required` while signed out and
  `account_not_activated` before plan activation;
- runtime readiness is published only after signed Free authority;
- logout returns only after runtime status becomes signed out, shell admission is revoked, and a
  direct activation attempt cannot restore authority without authentication;
- relogin reuses signed server truth and never repeats plan selection.

Verification completed in the canonical integration tree:

- `cargo test -p kalcode-desktop --features e2e account::e2e::tests --jobs 2`: 5 passed, 0 failed.
- `cargo check -p kalcode-desktop --features e2e --jobs 2`: passed after provider-owned compile
  repairs; only pre-existing dead-code and provider import warnings remained.
- `pnpm --filter @kalcode/desktop typecheck`: passed.
- Native Playwright registration: 23 tests in 13 files, including the new account lifecycle test.
- Clean release-mode native E2E build:
  `pnpm --filter @kalcode/desktop build:e2e`: passed. The build now derives hook, guardian, and fake
  provider targets from one checked-in inventory and fails if any required sibling executable is
  absent afterward.
- Compiled WebView2 account lifecycle:
  `pnpm --filter @kalcode/desktop exec playwright test --config tests/e2e/playwright.config.ts tests/e2e/account.spec.ts`:
  1 passed, 0 failed in 2.9 seconds.

The first compiled lifecycle run exposed a real clean-build defect: the account became active, but
the coordinator could not construct a complete runtime because `build:e2e` omitted the required
`kalcode-provider-guardian` sibling. The coordinator correctly cleaned the partial bundle and kept
the workspace closed. Adding the guardian to the canonical helper inventory made the same flow
reach Ready, then prove synchronous logout/revocation and relogin. A registered contract prevents
that helper from disappearing from future clean E2E builds.

## Compatibility and remaining integration proof

- Native public account snapshot and secret-envelope versions are unchanged.
- The portal response remains `{ opened: true }`; checkout remains `confirming_plan` until signed
  server truth is observed.
- Remote logout is still best effort after local revocation and protected-store deletion.
- Blocking HTTP calls remain bounded by client timeouts. Generation fencing prevents late results
  from restoring authority but does not cancel transport code already executing.
- Release assembly, code signing, publication, deployment, and production verification are owned
  by the canonical integration/release authority.

Rollback is path-scoped removal of the account frontend additions plus restoration of the prior
account native files. No runtime database, personal memory, private archive, or production account
state was mutated by this workstream.
