# Full model identity implementation plan

**Goal:** Every surface identifies the actual provider, bound account, exact model and reasoning state without confusing launch preferences with provider-confirmed runtime facts.

**Architecture:** Extend the existing thread summary and account capability authority. Keep configured model/effort for launch compatibility and persist separately observed model/effort from validated provider events. Derive presentation through one shared selector; retain existing task naming and weekly usage selectors where already correct.

**Tech stack:** Rust/SQLite provider and thread runtime, generated TypeScript protocol, React account context, Vitest and Playwright.

**Specification:** Owner's “Full Model Identity Everywhere” request, 2026-10-07. Start: `0297e87fe0bc144e07e80c7c10180a74a0800c84`. Production observed: `0.1.10+2188`, commit `d63b5aac930a8c3608b9c179774e3bef23050165`.

## Constraints

- Account and project isolation; explicit choices survive refresh and restart. No silent account substitution.
- Provider adapters own discovery and native metadata. No inferred active model from a friendly alias or terminal text.
- Task title remains primary; identity is compact secondary detail using existing KalCode design tokens.
- Existing signed production releases, credentials, owner app, other worktrees, and warm build caches remain protected.
- Both Windows and macOS; shared merge train and current public version release.

## Implementation and evidence

- [x] Runtime: regress selected-versus-observed model, native model switch, absent effort, subagent isolation, restart; add nullable observed state and propagate through existing events. Thread library 35 tests, runtime identity 5 tests, native selectors 2 tests, exact rebind and migration backup/reopen/recovery tests pass. Historical turns retain their own sequence-bounded identity, including same-message redelivery.
- [x] Launch: regress project/account preference bleed, explicit default model loss, model-specific reasoning values, disappeared models; extend existing preference persistence compatibly. Final focused launcher proof: 84 tests passed, including removed-account blocking and fresh-versus-stale capability authority.
- [x] Account capabilities: retain safe cached metadata during refresh with freshness labels and exact account/provider matching; expire safely and never infer sign-out from informational failure. Account-state/cache/selector proof: 41 tests passed before the later canonical-name extension; identity/weekly/quota regression group subsequently passed all 45 tests.
- [x] Presentation: shared identity selector for headers, Fleet, Runs, Queue, Squads, Handoffs, KalVoice and account/session details; regression tests for unknown and renamed account states. Responsive dark/light headers, four concurrent panes and keyboard identity details were reviewed in the rendered product. The final shared selector passes 8 tests; protocol tests pass 69 cases.
- [x] Existing behavior: verify weekly compact usage and durable task naming/manual ownership, repairing only confirmed gaps. Terminal Stack 9 tests passed; provider-header same-name rename and Fleet weekly/unknown regressions passed. The website demonstration has 22 passing focused tests and a reviewed production preview.
- [x] Local review: focused tests, desktop typecheck, repository Biome, Rust formatting, rendered desktop UI at realistic dimensions and independent adversarial review. Parent independently reran the complete provider session module: 59 passed, including delayed completion, bounded tracking exhaustion, subagent isolation and native model-switch invalidation. Exact merged-candidate validation remains a delivery gate.
- [ ] Delivery: submit exact validated candidate to shared train, ship signed Windows/macOS internal build, verify production updater availability and isolated update evidence, preserve evidence and clean task-owned disposable outputs.

## Review focus

Provider reports a different model than requested; account changes while a discovery request is pending; explicit default model changes upstream; reasoning unavailable despite configured effort; restart must not present old runtime metadata as currently observed.

Independent review reproduced delayed-hook identity rollback, subagent completion affecting its parent, stale identity after a native `/model` command, and unsafe unresolved Windows batch-wrapper interpretation. These receive deterministic regressions. Running the entire affected session module also exposed a pending-submit accounting regression that the new-case filters missed; completion accounting and stale-turn identity protection must remain separate.

The complete thread runtime file passes 75 tests after updating two assertions to the intended contract: a null identity boundary precedes process startup, and provider reports populate `active_model` without rewriting the configured model. Parent-run adapter checks pass 19 argv tests, 67 account-auth tests and 5 catalog tests. Focused Operations/Squads/KalVoice presentation checks pass 114 cases; the final Operations effort-selector extension adds four regressions and its full 56-test file passes. The Squads exact-ID dropdown regression also passes.

## Rollback

Use a forward corrective release through the shared train, retaining migration 0027 and its schema registration. An older schema reader cannot open an upgraded profile. Preserve subsequent work; never reset shared main or rewrite another worker's history. The pre-change source reference is `rollback/full-model-identity-20261007`; it is not a database downgrade instruction. See `docs/providers/full-model-identity.md` for the rollback and recovery contract.
