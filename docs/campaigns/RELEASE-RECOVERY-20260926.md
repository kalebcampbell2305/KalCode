# Release recovery, 2026-09-26

This record continues the prior closeout. It is not release certification.

## Recovered authority

- Canonical main and freshly fetched private origin/main: `ad4d073faea0a4800fbdd027b8f2fee87ff43752`.
- Recovered integration candidate: `codex3/takeover-integration`, `68ca2f81e924f2b57091fec1f6c0e5ef379ba860`.
- Bounded repair branch: `release/recovery-20260926`, based on that candidate.
- Read-only census found 130 worktrees, 18 dirty, two clean detached, and no staged paths before this repair worktree was created. Existing dirty work remains preserved.
- Patch-equivalence review found no missing committed production packet. Historical continuity/Git mutation packets remain outside this release's activation scope.

## Repairs

### Mac updater trust

The Mac packager inherited `KALCODE_UPDATER_PUBLIC_KEY` without loading the tracked trust anchor. A normal shell therefore produced a build with no updater key, while an inherited substitution could select different trust. The desktop's existing `option_env!` consumer correctly fails closed when the key is absent.

The packager now reads the canonical public key before compilation. Its build-environment contract validates the explicit key and overwrites any inherited value before building helpers and the app. No private key is needed on the Mac, no trust key rotates, and notarization-only resume does not rebuild artifacts.

The regression first failed with an absent resulting key. It now proves deterministic injection, substituted-environment rejection by replacement, missing/malformed input denial, caller-environment preservation, and packager wiring. Focused Mac/updater tests: 48 passed. All release-tool tests: 199 passed. Full tooling/performance unit registration: 309 passed, zero failed/skipped; the increase from 308 is the new regression. A first full-tooling attempt in the fresh repair worktree failed because dependencies were absent; frozen offline installation resolved that prerequisite without changing the lockfile.

Independent review by the retained Mac verifier accepted the trust flow and compatibility. Actual signed Mac build and update execution remain required.

### Preserved Unix hook fixture

The uncommitted repair from `codex3-hook-shutdown-fixture` was recovered exactly from `target/codex3-mac-native-final/mac-hook-shutdown.patch`. Checked shutdown removes both the Unix socket and its private parent; the fixture previously attempted to rebind without recreating that parent. The repair asserts both removals and recreates only the fixture's directory with mode 0700 before testing endpoint reuse.

The prior physical Mac workspace run proves the original ENOENT failure. The retained focused rerun passed all 16 bridge tests and strict Clippy. This patch was NOT part of commit `28fa4c3`; the earlier dirty Mac tree had that HEAD plus this unstaged change. Current-candidate Mac rerun remains required. The change is Unix test-only; production and Windows behavior are unchanged.

## Fresh baseline evidence

At recovered candidate `68ca2f8`, seven JavaScript suites passed: desktop 881, website 334, API 258, protocol 56, shared testing 24, UI 68, tooling 308. Total 1,929, zero skipped/flaky. Workspace typecheck passed, including 118 Astro files with zero diagnostics. Website build and E2E passed (145 executed, eight registered skips, zero flaky). Static branding/capability/zero-cost/release-manifest checks passed; the manifest still describes the older Windows release and is not new-release proof.

Windows strict workspace/all-target Clippy passed. The first full Rust workspace run failed a managed Codex pane's 30-second output wait. Its exact rerun and complete 15-test subsystem passed; a fresh full workspace rerun was started. Preserve the original failure rather than classifying the first run green. Rust ts-rs tests rewrite generated TypeScript whitespace; use the canonical protocol normalizer after exporters finish, without restoring stale files.

Evidence is in root `target/recovery-20260926` and the candidate's/root's `target/recovery-20260926-{js,native,browser}` directories. Historical evidence remains intact.

## Production boundaries

Subsequent Windows default workspace rerun passed 1,994 tests, zero failed, 15 ignored. This exposed a registry mismatch: the registered command omitted the optional production Whisper feature while expecting its sixteenth ignored opt-in test. The release gate now explicitly enables `kalcode-desktop/kalvoice-whisper`, preserving all source ignore declarations and requiring the speech engine's tests. Linux expects 15 because the separate pinned local-reasoning artifact probe compiles only on Windows x64/Mac arm64; supported release targets expect 16. The registry regression failed before the correction, then all 16 registry tests passed. The final tooling run passed 310 tests with zero skips/failures, two more than the recovered baseline. Actual production-feature workspace verification remains a separate required run; the default 1,994-pass run cannot substitute for it.

The current-user updater signing key matches the tracked public key. Azure's existing account reports Enabled; a new installer signing probe is still required. GitHub visibility was independently confirmed PRIVATE.

Mac SSH recovered. Fresh physical inspection reports arm64 and macOS 27.0, superseding the historical 26.2 claim. The signed runtime ZIP remains unchanged and Developer ID verified. Initial notarization could not authenticate because the login keychain was locked; its checkpoint has no submission ID. Reconcile Apple history before another submit. Never infer Accepted from an upload or a prepared script.

Production API version: `a0c48810-09c0-42d5-8017-6b8048506b36`. Website version: `3af2bc5a-4966-41a2-9ab1-380c83946b87`. API migrations 0007/0008 and website component-publication migration 0006 are pending. Google/Microsoft production registrations are owner setup in progress. Checkout remains held. No deployment, migration, publication, customer installation, paid-provider call, or charge has been performed by this recovery packet.

The existing website account page implements email sign-in only; the current Google/Microsoft callback completes the desktop flow. Do not claim website social login merely from registering provider credentials. Mac native customer QA and a real signed old-to-new update/rollback remain unproven.

## Deputy harvest and subsequent recovery evidence

The completed deputy handoff was read from `codex2/release-deputy-20260926` at `2fa9c38`. Its three clean source branches were inspected against their actual bases and harvested without conflicts: `770b66c` became `3b263eb` (exact signed interrupted component retry), `50c6007` became `86ecc49` (PTY listener-owned view accounting), and `2e4aa5b` became `7d23cac` (Linux gate inventory). All four deputy evidence documents were retained through `948eae9`. The first two source repairs are independent children of `68ca2f8`; the registry correction depends on `91166fa`.

The Linux correction supersedes this record's earlier count of 15: both the pinned runtime archive probe and local-reasoning probe are target-gated out on Linux, so its production-feature inventory expects 14 ignores. Windows and Mac remain 16. No source ignore or suite was removed. Parent verification reran the deputy binaries (21 component-store tests plus one existing ignore; seven provider-view tests) and all 16 registry tests, then rebuilt and reran the same focused tests after harvest. All passed. The provider packet does not certify every cursor-query transport-loss schedule; its documented last-view rejection edge is being separately reproduced.

Independent review also identified a raw backend error crossing the provider-pane IPC boundary. Commit `7b720fe` substitutes fixed user-safe messages while preserving the ended-pane error code and recovery instruction. The regression first failed on synthetic backend detail; all three pane tests then passed. A first complete desktop-library run failed six setup tests because the fresh isolated target lacked the provider guardian. Building that exact helper resolved the prerequisite; the unchanged complete library passed 186 tests with zero failures or ignores. This is scoped packet evidence, not the final workspace gate.

The frozen Windows `68ca2f8` production-feature workspace gate passed 1,994 tests, zero failures, 16 registered ignores. Its native E2E run completed with 10 passes and 13 failures. Preserved traces show missing account-runtime readiness, a stale Browser shell locator, schema expectation 18 versus canonical 19, an exhausted signed KalVoice fixture, and provider launches before resource admission. Those failures remain red until corrected fixtures pass against the actual rebuilt native app; production resource and entitlement decisions must not be bypassed.

Physical Mac `91166fa` full workspace tests with production Whisper passed 1,948 tests, zero failures, 16 registered ignores. The real OS Keychain round trip ran unskipped in the logged-in GUI context; the recovered Unix hook fixture passed. Strict all-target Clippy with the production feature passed; a third-party future-incompatibility notice remains. Rust export tests rewrote only generated TypeScript trailing whitespace, which must be normalized with the existing generator after exporters stop.

The locked-keychain notarization checkpoint was preserved. Apple history in the unlocked GUI context showed no earlier submission, after which exactly one runtime ZIP job was submitted: `f90019b5-8b0e-4862-921f-daf6a69ab7c3`. Apple's last reported state remains **In Progress**; the record stays non-release-eligible. No duplicate submission, accepted status, DMG, staple, or customer installation is claimed.

A redacted history scan of `ad4d073..91166fa` reported 42 matches: 36 throwaway signed test-vector tokens, two descriptive Stripe configuration fixtures, two local D1 lease fixtures, and two Cloudflare deployment metadata entries. The embedded desktop fixture tokens were compared with the shared deterministic vectors. Zero production credentials were identified or staged. The raw scanner exit remains 1 and its separate adjudication is retained under `target/recovery-20260926`; it is not described as an unqualified zero-findings scan.

The exact non-secret owner registration instructions are in [OAUTH-OWNER-SETUP-20260926.md](OAUTH-OWNER-SETUP-20260926.md). Production binding/live OAuth proof remains pending owner registration. A new untracked root `marketing/kalcode-product-film` directory appeared during recovery and was left untouched; it is outside this release packet.

The canonical `gen-protocol-index.mjs` normalized trailing spaces in 92 already-tracked generated types; an ignore-end-of-line-whitespace comparison proves no type/content change. All 56 protocol tests passed. One redundant trailing blank line in Doctor's Cargo manifest was removed. Full candidate whitespace review deliberately preserves two existing migration SQL EOF blank lines and upstream license bytes: `native-core::db::checksum` hashes exact SQL bytes, and component notices are also hash-pinned. Reformatting those files would change durable migration or artifact identity. New repair diffs remain whitespace-clean; final comparison must report these exact preserved exceptions rather than silently editing or ignoring them without explanation.

Website social sign-in packet `efc27ff` was reviewed and harvested as `dd432a0`. Parent reruns after integration passed all 264 API tests, 334 website unit tests, the 18-page production build, and six real Chromium Account tests. These use isolated stores and provider adapters; live Google/Microsoft authentication remains unproven until owner registrations are bound. Migration 0009 is additive and must precede this API deployment. See the packet's rollback order: disable new browser starts and allow existing attempts to expire before reverting to a desktop-only API.

The resource-admission error message now states that a provider could not start and asks the user to retry after checking availability. The prior wording implied a queued start, while the existing implementation immediately returns a start failure. No admission decision, retry behavior, queue, or permission changed. All 23 existing resource-command tests passed, including atomic reservations and the real sampler's bounded shutdown.

## Rollback state

The website social packet includes additive API migration 0009 and extends existing auth routes; these changes have not been deployed. No production credential or store was modified by this recovery. Before integration, discard neither the preserved original worktrees nor release evidence. Revert bounded repair commits to undo source changes; do not reset main or later history. For deployed social-auth rollback, stop new website attempts and wait their ten-minute TTL before reverting the API; retain the additive column. Any future signed build must be regenerated from the final verified commit. Main, public release pointers, and deployed versions remain unchanged by this packet.

## Continued closeout

PTY cursor fallback repair `cfb08f6` was inspected and independently reviewed, then harvested as `45bb866`. A rejecting final listener previously left a live cursor-position query unanswered; the production reader now supplies one fallback reply when all listeners reject delivery. The redundant Codex-only watcher was removed. Parent verification passed all 34 PTY tests with zero ignores/failures. The author's production-reader regression first failed, then passed; accepting-view and initially-empty-view cases also passed. The discarded ConPTY child oracle is not counted as a pass because ConPTY consumed the response before child inspection.

Independent adversarial review of website social commit `efc27ff` passed without an actionable source defect. Migration 0009 must precede the API deployment, which must precede the website deployment. Live provider sign-in remains mandatory. The owner reports both provider registrations now exist, but Google secret rotation and confirmation of all four production bindings are pending. Preserve existing client IDs and never use the exposed prior Google secret.

The isolated native E2E fixture packet remains unharvested. Its production-Whisper build and focused account fixture tests passed, but the forced-kill third-launch test now exposes a persistent workspace bootstrap stall after account verification. The Dashboard assertion remains in place; this is a release blocker under investigation, not a timeout waived as success.
