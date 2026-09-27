# OWNER usage credential repair

> Execute with subagent-driven-development; the release lead owns integration and publication.

**Goal:** Preserve server-authoritative OWNER Unlimited usage after Google login and restart without exceeding Windows credential-entry capacity.

**Architecture:** Keep the secure session and entitlement in their existing credential. Persist the signed usage receipt separately as a cache, preserving legacy reads, account/signature validation, and logout cleanup. No frontend tier-based allowance override and no OAuth changes.

**Tech stack:** Rust native account runtime and OS credential store; TypeScript API and connected React regression tests.

**Spec:** Owner's 2026-09-27 installed Windows report: Google chooser and automatic desktop return work; restart restores the main app; Settings shows Owner and Unlimited dictation but KalVoice Usage unavailable. Fix only this inconsistency, test both installed platforms, retain secure server authority.

## Constraints and evidence

- Build authority before repair: 1671ac27293913bf3f77c0153393a725a79d339c.
- Preserve existing signed artifacts as evidence; do not relabel their source identity.
- Windows credential password storage uses UTF-16 with a 2,560-byte entry limit.
- Synthetic production-shaped OWNER envelope fits before receipt (1,540 bytes) but exceeds capacity with receipt (2,584 bytes).
- Keep working Google chooser, handoff, session persistence, and receipt validation.
- No UI redesign, broad audit, unrelated refactoring, or repeated unchanged gates.

## Review focus

Legacy envelopes must restore; account switches cannot reuse another account's usage; failed cache writes cannot corrupt the saved session; logout removes both credentials; malformed or mismatched receipts never authorize requests.

## Task 1: Native storage repair

Files: `apps/desktop/src-tauri/src/account/session_store.rs`, focused account session-store/runtime tests.

- [x] Add a constrained SecretStore regression using synthetic production-shaped signed OWNER data and the actual UTF-16 capacity limit.
- [x] Run the focused test and record the capacity failure before production changes.
- [x] Separate the receipt cache with safe migration/read/write/clear semantics; preserve native verification and account isolation.
- [x] Test legacy restore, partial failures, account changes, clear/logout, and real Google-completion-to-usage restoration using synthetic credentials.
- [x] Run only affected native account tests and relevant formatting/lint checks.

## Task 2: Preserve connected desktop behavior

Files: existing account-flow and Settings tests; production frontend remains unchanged.

- [x] Cover signed-out -> Google pending -> authoritative OWNER -> ready workspace and Settings Owner/Unlimited requests/Unlimited dictation/no payment.
- [x] Cover direct cold restoration without sign-in or plan selection.
- [x] Run focused connected account tests.

## Task 3: Verify server contract

File: `apps/api/tests/unit/router.test.ts`; production API remains unchanged.

- [x] Add OWNER GET usage receipt coverage with unlimited allowance despite high usage and no subscription.
- [x] Run the affected API test and existing Google chooser/automatic-handoff regressions.

## Integration and release

- [x] Independently review the complete focused diff and failure/green receipts.
- [ ] Integrate and push; calculate precisely affected artifact and gate scope from actual source changes.
- [ ] Rebuild/re-sign only invalidated artifacts with truthful new source identity; preserve completed previous packets.
- [ ] Repeat installed OWNER usage and Google/restart checks on Windows and Mac, then continue outstanding physical product/updater/publication gates.

No installed fix or release acceptance is claimed by unit-test success.
