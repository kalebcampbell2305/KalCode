# Website social sign-in release evidence — 2026-09-26

## Scope and authority

- Starting commit: `68ca2f81e924f2b57091fec1f6c0e5ef379ba860`
- Isolated branch: `release/web-social-20260926`
- Isolated worktree: `.worktrees/recovery-web-social`
- Requirement: expose production Google and Microsoft sign-in on the public Account page through the existing canonical API, identity, account, and session authorities.
- Existing callbacks remain exact: `/v1/auth/google/callback` and `/v1/auth/microsoft/callback` on `https://api.kalcoded.com`.
- No new route, provider registration, provider client, secret, paid call, production store access, deployment, or external effect was introduced.

## Implemented contract

Migration `0009_social_oidc_browser.sql` adds a constrained `client_kind` to `oauth_attempts`. Its `desktop` default preserves GitHub attempts, existing OIDC attempts, and the shipped native request body. OIDC attempt creation, retrieval, and one-use consumption now bind the state hash, provider, PKCE challenge, nonce hash, client kind, expiry, and unconsumed state.

Desktop requests retain the existing `{ codeChallenge }` start request, native deep link, and bearer completion response. Website starts explicitly send `{ client: "website", codeChallenge }` from the exact `https://kalcoded.com` Origin. Only an unexpired stored website attempt can make the registered API callback redirect to the fixed `https://kalcoded.com/account` fragment. No caller controls a return URL.

The browser stores the ten-minute PKCE verifier and OIDC nonce in a state-keyed `sessionStorage` record. It validates the server-provided provider URL and parameters, removes the callback fragment and pending record before completion, and never stores an account session or bearer. Website completion requires the exact Origin, consumes the same attempt once, uses the existing verified provider-subject account authority, creates a canonical `website` session, and returns only the host-scoped `__Host-kalcode_session` cookie with `Path=/; HttpOnly; Secure; SameSite=Lax`.

Email sign-in and social sign-in share the canonical cookie helpers. Provider subject binding and the existing no-email-auto-link collision policy remain unchanged.

## Test-driven evidence

The first focused run was intentionally red:

- API OIDC route suite: five expected browser-contract failures.
- Browser migration suite: failed because `0009_social_oidc_browser.sql` did not yet exist.
- Website account unit suite: failed because Google and Microsoft controls did not yet exist.

Final verification on the completed diff:

- API TypeScript typecheck: passed.
- Focused API OIDC, migration, D1 store, origin, cookie, replay, and callback tests: 3 files, 18 tests passed.
- Full API suite with `KALCODE_API_TEST_PORT=28433`: 31 files, 264 tests passed.
- The default API live-test inspector port was transiently occupied during the first full run. The isolated worker suite then passed 8/8 and the complete suite passed on the repository-documented port override; no source or test was changed to obtain that result.
- Website Astro and Worker typecheck: 118 files, zero errors, warnings, or hints.
- Website unit suite: 24 files, 334 tests passed.
- Focused Account browser suite: 6 tests passed.
- Full website Playwright suite: 147 tests passed, 8 existing conditional skips.
- Website production build: 18 pages built successfully, including `/account.html`.

The browser E2E proves the submitted verifier hashes to the start request's S256 challenge, the provider nonce and state survive the registered callback continuation, transient storage is deleted before completion, the completion response contains no bearer, and the account page resumes through the cookie contract. Primary review also identified a malformed-callback cleanup gap after the first green implementation; the final regression proves a valid owned state is deleted before duplicate provider/code rejection, unrelated storage is preserved, the fragment is cleared, and no completion request occurs.

## Rollback and compatibility

Application rollback must first disable new website social starts and wait the ten-minute attempt TTL before reverting to the older API. That prevents an in-flight website attempt from reaching the older callback behavior, which only knows the native deep link. After the TTL, revert the eventual integration commit normally. The additive database column may remain: older code ignores it, every pre-existing row is `desktop`, and expired attempts are cleaned by the canonical store. Do not drop or rewrite active attempt rows during rollback.

No desktop source changed. The existing native request and response wire shapes are covered by regression tests. Production activation still depends on the owner's provider-console registration and Worker secret provisioning through the separately governed release procedure.

## Truth state

Implementation and local verification are complete in the isolated branch. Integration, production migration, provider authentication, deployment, and live production verification remain owned by the primary release process.
