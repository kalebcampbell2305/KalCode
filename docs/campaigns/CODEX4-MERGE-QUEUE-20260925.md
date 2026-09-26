# Lead 4 integration queue — 2026-09-25

Terminal #1 alone owns canonical main, final integration, full release gates and publication.
Lead 4 owns only its preparation branches, validation and this handoff. No main merge/push occurred.

## Snapshot and integration choices

- Starting main and preparation base: `ad4d073faea0a4800fbdd027b8f2fee87ff43752`.
- READY branch/worktree: `codex4/ready-wave1`, `.worktrees/codex4-integration-queue`.
- Ready source checkpoint before registration/documentation: `88b6e14735d53d6167f11fa77d1d692b2d894380`.
- NEEDS FIX preserved branch: `codex4/integration-queue` at `8837145`; includes the withheld quoted-redaction packet.
- Small independent CI-only option: `codex4/ready-ci` at `551043b`, based on the same main.
- Rollback reference: `codex4/rollback-queue-base`, pointing to the starting main.
- Review checkpoint excludes subsequent producer commits unless explicitly mapped below.

Use the combined branch OR the original scoped packets, not both. If CI-only `551043b`
was already integrated, do not replay its patch-equivalent CI changes blindly. Compare
patch IDs/current main and prepare the remaining series. Recheck dirty primary sources
before applying: compatibility checks are snapshots, not a lease on another writer.

The combined preparation has no new migration, route, public command, dependency version,
lockfile, credential, production database, or provider configuration change. Existing
canonical systems are EXTEND; main, production stores and release authority are DO_NOT_TOUCH.

## Ordered handoffs

All rows inherit BASE `ad4d073`. TESTS refer to the independently rerun matrix below.
CONFLICT STATUS: all source rows applied cleanly in the Lead 4 worktree and main remains
the exact ancestor. Early combined patch checks passed both primary dirty trees. Final
check still passes `integration-stage`, but `sec-harden` has since independently fixed
the same locator recency fixture. Retain its deterministic reference-clock/exact-title
test and omit source `9e9134a` / prep `985d6db` there. A patch excluding only
`crates/locator/tests/locator.rs` passes current sec-harden apply-check; preserved under
`target/codex4-primary-minus-recency.patch`. No product-code conflict was found and no
primary file was edited. Recheck this selection against current owner state before use.
RECOMMENDED MERGE ORDER is the table order; explicit dependencies take precedence.

| Order / scope | BRANCH | COMMIT(s), source order | Preparation equivalent(s) | DEPENDENCIES |
| --- | --- | --- | --- | --- |
| 1. CI metadata/audit | codex3/release-gates | 6417827, 1e73507 | 80012fa, 0ccc327 | Apply metadata before audit; CI-only alternative is 551043b |
| 2. Performance evidence | codex3/release-gates | 728ae00, 21a244f | b89e120, d5e66b7 | Both commits required; first alone had confirmed false-green gap |
| 3. Diff virtualization | codex2/diff-virtualization | 3d97b4f | defb419 | None |
| 4. Notification pagination | codex2/attention-pagination | ed4da0d, 3fa720f | eb2389d, dd97765 | Both in order |
| 5. Toast focus | codex2/toast-focus | 3f27f62 | 225929a | None |
| 6. Diff notices | codex2/diff-notices | 216d3e7 | 2595a0e | After 3d97b4f |
| 7. Segmented focus | codex2/segmented-focus | 2713ea5 | 94f52fb | None |
| 8. Locator aliases/fixture | codex2/locator-aliases | ade3b0b, 9e9134a | d6d940f, 985d6db | Both in order; preserve primary privacy commit b197561 |
| 9. Notification coalescing | codex2/notification-coalescing | 077a6b9 | 3e82057 | None |
| 10. Settings races | codex2/settings-races | 1dab3b2 | af5d22b | Also appears as equivalent 70f9af0 in backfill ancestry; apply once |
| 11. Event history/backfill | codex2/event-history, codex2/event-backfill | b5d8696, a683e0b, af7a944, feb8ad4 | 62637cb, 7824e2c, 9bb4cbe, cc6cb63 | af7a944 also requires settings row; feb8ad4 is required race repair |
| 12. Git blank context | codex2/git-diff-format | 27f249f | 1bf9564 | None |
| 13. Menu composition | codex3/navigation-hardening | 24edaa2 | a49b54a | None |
| 14. Tooltip description | codex3/tooltip-hardening | 94fd6ec | 83130f0 | None |
| 15. Home path privacy | codex3/path-privacy | c14174f, 1fe19b3 | 4850fb1, 559b28a | Both in order; preserve primary continuity additions in runtime.rs |
| 16. Primitive browser regressions | codex3/ui-verification | 980586e | 88b6e14 | Menu + tooltip; Lead 4 registration correction also required |

Documentation-only source commits `6a8576c` and `06cbecf` are preserved as `c90362a`
and `57908c3`. Their earlier observations/counts are historical; this queue record
supersedes their readiness claims where later defects and repairs are described.

## Files, security and known risk by scope

| Scope | FILES | SECURITY REVIEW | KNOWN RISK |
| --- | --- | --- | --- |
| CI | .github/workflows/ci.yml | contents:read retained; cargo-audit pinned 0.22.2; failures unsuppressed | Hosted install/runtime under 15-minute timeout not executed here; seven existing cached-audit warnings remain |
| Performance | apps/desktop/tests/perf/check.ts, check.test.ts, lib/compare.ts, lib/compare.test.ts | Invalid numeric values, malformed supplied baseline and budgets fail closed | Schema/platform envelope hardening remains optional; missing metric with an absolute budget intentionally permits absolute-only checking |
| Diff | packages/ui/src/components/DiffView.tsx, DiffView.model.ts, DiffView.test.tsx, DiffView.notices.test.ts, tests/diffview/manual-scroll.spec.ts | React text; bounded visible windows; no HTML execution | Chromium covered; physical macOS/WebKit/screen-reader proof not performed |
| Notifications UI | apps/desktop/src/shell/notifications/NotificationCenter.tsx, NotificationsProvider.tsx, NotificationsProvider.test.tsx | Generation-fenced pages, native page cap preserved, duplicate loads bounded | Native finite keyset pages assumed |
| Toast/segmented | packages/ui/src/components/Toast.tsx, Toast.test.tsx, SegmentedControl.tsx, SegmentedControl.test.tsx | Timer cleanup and originating-group focus checks | Existing four-toast eviction can remove a focused toast; dynamic callback replacement during a queued segmented callback remains a follow-up |
| Locator | crates/locator/src/index.rs, tests/locator.rs, tests/short_aliases.rs | SQL parameters bound; visible-field short scans capped at 20k; existing body opt-in preserved | Alias search remains best effort under its existing time budget; release benchmark not rerun here |
| Notifications store | crates/notifications/src/store.rs | Unread-first ordering agrees between SQLite/memory; no schema change | Full product lifecycle remains final integration gate |
| Runtime/settings | apps/desktop/src/runtime/RuntimeProvider.tsx, RuntimeProvider.test.tsx, eventFeed.ts, eventFeed.test.ts | Sequence/client/eviction fences; no authority or store API change | Production uses one boot client; speculative hot-swap/Suspense semantics not expanded; stale older page is discarded and next user action retries |
| Git | crates/git/src/diff.rs, tests/diff_format.rs | Constant read-only config override; no persistent config/index mutation; hostile config gates retained | Existing 20k-file benchmark not run |
| Menu/tooltip | packages/ui/src/components/DropdownMenu.tsx, DropdownMenu.test.tsx, Tooltip.tsx, Tooltip.test.tsx | Installed Radix composition/ref/handler semantics inspected; no authority change | Generic asChild element styling parity not certified; no current production asChild menu caller found |
| Path privacy | crates/native-core/src/runtime.rs | Windows mixed separators and documented extended UNC forms redact home, preserve suffix/boundary; Unix semantics retained | String display sanitization is not filesystem authorization |
| Browser registration | packages/ui/package.json, tests/primitives/{index.html,main.tsx,playwright.config.ts,primitives.spec.ts,vite.config.ts}, .github/workflows/ci.yml | Test-only harness, no native transport; isolated port; read-only CI permission unchanged | Real native desktop integration is a separate gate |

## Verification evidence

Only one bounded Rust build slot (`--jobs 2`, isolated `target/codex4-focused`) was used.
JS suites used one worker. Offline frozen pnpm install downloaded nothing and left lockfiles
unchanged. Tests used temporary/fixture state, not owner stores.

| Command / scope | Fresh result |
| --- | --- |
| node --test apps/desktop/tests/perf/check.test.ts apps/desktop/tests/perf/lib/compare.test.ts | 25 passed, 0 skipped |
| tooling registered node test command | 36 passed, 0 skipped |
| pnpm --filter @kalcode/ui test --maxWorkers=1 | 65 tests / 7 files passed |
| RuntimeProvider + eventFeed focused Vitest | 30 tests / 2 files passed after feb8ad4 |
| pnpm --filter @kalcode/desktop test --maxWorkers=1 | 355 tests / 35 files passed after feb8ad4 |
| pnpm --filter @kalcode/ui test:ui --workers=1 | 8 Chromium/axe/layout/keyboard/scroll tests passed, port 15445 |
| pnpm --filter @kalcode/ui test:ui:primitives | 3 Chromium menu/tooltip tests passed, port 15446 |
| UI + desktop typecheck | Passed |
| Desktop production frontend build | Passed; existing oversized JS chunk warning retained |
| Scoped Biome and rustfmt edition 2024; git diff --check | Passed |
| cargo test -p kalcode-native-core | Ready subset: 128 passed (97 library, 14 upgrade/persistence, 17 workspace/terminal), 0 ignored. Withheld security candidate had 133 existing tests pass but 2 independent regression probes fail |
| cargo test -p kalcode-context | 85 passed; 1 existing release-only performance gate ignored |
| cargo test -p kalcode-locator | 57 passed; 1 pre-existing release-only benchmark ignored |
| cargo test -p kalcode-notifications | 15 passed, 0 ignored |
| cargo test -p kalcode-git | 86 passed; 1 pre-existing 20k-file benchmark ignored |
| Manifest / capabilities / zero-cost checks | Passed; 98 commands, 1 debug/e2e hook, 2 core permissions |
| cargo audit --no-fetch --no-yanked --file Cargo.lock | Exit 0 using cached 1271-advisory database; 7 existing warnings; not a fresh network/yanked audit |
| Final patch apply-check | integration-stage passes; sec-harden passes with its already-equivalent locator fixture retained as described above |

Final downstream context/redaction test result and final commit are recorded in the appended
closeout below. No test was removed or weakened. Counts increased as regressions were added:
UI 59 to 65, desktop 336 to 341 to 352 to 355, tooling 28 to 36. Filtered focused runs
reported unselected tests as skipped; full affected suites above had no new skips.

## Findings and adjudication

1. Confirmed perf false green: present null baseline/missing metrics skipped comparison.
   Accepted; producer `21a244f` fixed it, reviewer rechecked, 25/36 tests passed.
2. Confirmed older-page eviction race after initial backfill repair. Independent Lead 4
   regression first failed with cursor 1 instead of 5, then passed after a narrow fence.
   Producer `feb8ad4` arrived concurrently with equivalent repair and stronger boundary tests.
   Adopted producer commit; independent reproduction patch preserved only under ignored
   `target/codex4-older-page-reproduction.patch`. No duplicate implementation was committed.
3. Confirmed primitive browser suite was not registered in a package script or CI.
   Lead 4 adds `test:ui:primitives`, invokes it in the existing desktop-ui CI job,
   includes its failure artifacts and exposes the existing port environment convention.
   Independent review then caught missing trace/screenshot capture. Added retain-on-failure
   traces and only-on-failure screenshots. An intentional temporary failure produced exactly
   one trace and one PNG; probe removed, real suite reran 3/3. Evidence is under ignored
   `.worktrees/target/codex4-artifact-proof` (the initial verifier used the wrong relative
   evidence path; corrected verification found both artifacts).
4. Rejected lower/mixed-case extended UNC marker concern: bounded Windows Path API did not
   classify those spellings as UNC roots; uppercase documented spelling is covered.
5. Rejected first-wave SQL injection, unbounded DiffView DOM and backend coalescing divergence
   claims after parameter, window, comparator and test inspection.
6. No invented release readiness: inherited primary campaign/build/CI issues are outside this
   queue. The older staging publisher must not supersede the newer coherent publication unit.

## NEEDS FIX and next intake

**NEEDS FIX:** `codex2/quoted-secret-redaction` source `04683e6` (equivalent `7ec89c2`).
Preserved on `codex4/integration-queue` at `8837145`, excluded from `codex4/ready-wave1`.
FILES: `crates/native-core/src/redact/secrets.rs`, `crates/native-core/tests/logging.rs`.
Source parent: `fea9c55`; packet-only patch applies independently to the `ad4d073`-based queue.
DEPENDENCIES: no new API prerequisite. CONFLICT STATUS: applies cleanly; correctness blocks it.
TESTS: five producer regressions pass, but independent nested-JSON and literal-multiline
suffix probes fail deterministically (0 passed, 2 failed, exit 101). SECURITY REVIEW:
prefix matching supports too few escape levels and quoted_value stops at newline, leaving
credential suffixes. Reviewer additionally identified backtick/doubled-quote gaps requiring
producer reproduction and noted the pre-existing chunked-writer risk.
RECOMMENDED MERGE ORDER: after producer repair and fresh independent security proof.
KNOWN RISK: incomplete quoted redaction is not a certified security fix. Evidence lives in
`target/codex4-redaction-review.rs` and `.log` inside the Lead 4 worktree; synthetic input only.
Producer notice: `.worktrees/CODEX4-TO-CODEX2-SECURITY.md`. No parallel redactor was created.

**NEXT, not included in this checkpoint:** `codex2/virtual-row-lifecycle` at `c99dc9f`,
`codex3/ipc-error-classification` at `e848553`, and `codex3/dashboard-resource` at `0b137ee`.
These appeared after the ready snapshot and require their own review/test records.

**ALREADY MERGED into main at census:** historical adv/context, adv/resources, brand/final,
contracts branches, infra/testing, integrate/kalvoice, integrate/wave1, integrate/wave2,
kalvoice/migration, plan/advanced-systems, providers/codex-gemini-health, release/pipeline,
sec/fixes-0.1.1, sec/latent-hardening, web/email-confirm, web/redesign and all z1-z7/z12/z13
tips have no commits ahead of main. Web account/download increments are already integrated.
`p2/utility-dock` remains one commit ahead but is owned by the active primary utility lane;
do not queue the old packet over the owner's newer dirty integration source.

## Scope limits, owner action and rollback

READY means ready for Terminal #1's integration decision, not a deployed or signed release.
No canonical main integration, remote push, deployment, signing, publication, physical Mac
operation, paid provider call, personal-memory mutation or archive import was performed.
No production memory/store was opened; their content correctness was not independently audited.
Zero secret/private/runtime files were staged. Added-line high-signal credential scan and
forbidden-path scan returned zero matches; this is a bounded scan, not a universal secret proof.

Operational incident: a mistargeted branch-creation command briefly switched the root
checkout to the ready branch. It was immediately restored to main at the original hash;
the original five dirty/untracked path entries were unchanged. No main ref moved and no
commit/push occurred there. Subsequent commands use explicit Lead 4 worktree paths.

Terminal #1 must compare current main/dirty work and integrate once through its own process,
then run the complete workspace/hosted/native release gates. Full workspace Rust/E2E and
physical Mac verification were deliberately not launched by this deputy on the shared host.
Restart/recovery/concurrency are proven here at affected test layers, not by a new full app boot.

Before integration rollback is simply declining the preparation branch; main is unchanged.
After later integration use selective revert commits in reverse dependency order, preserving
subsequent work. Do not reset canonical history to the base reference.

Next-phase token: `LEAD1_INTEGRATION_REVIEW`. No owner action is required to complete the
local queue preparation; only Terminal #1 may perform canonical integration/release actions.

## Wave 1 closeout

Implementation checkpoint: `a403341` (registration/evidence correction), based on ready
source `88b6e14`. Final affected Rust rerun passed **371 tests**, zero failures, with three
unchanged optional performance gates ignored: native-core 128, context 85, Git 86,
locator 57, notifications 15. Full log: ignored `target/codex4-ready-rust.log`.
No newly skipped or disappearing suite. JS/component/tooling/browser results remain as above.

Five distinct independent subagents reviewed this wave: `review_lead2`, `review_lead3`,
`queue_auditor`, `review_redaction`, `review_gate_registration`. Findings were manually
validated; two source correctness gaps were repaired by producers, the registration/artifact
gap was repaired in Lead 4, and the security packet was withheld after fresh failed probes.
Three additional reviewers are processing the next intake, bringing total delegated agents
to eight with at most three active. No role claims a hosted/full-release certification.

Memory mutations: 0. Archive imports: 0. External effects: 0. Paid-provider calls: 0.
Secret/private-file staging: 0. Main stays at `ad4d073`; origin/main was read at the same
hash (no fetch/push). No master branch appeared in the census and no protected ref changed.
