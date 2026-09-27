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

## Production closeout continuation (2026-09-27 UTC)

This entry supersedes the earlier undeployed production-boundary snapshots above. Canonical main and origin/main remain `ad4d073faea0a4800fbdd027b8f2fee87ff43752`; the integration candidate is `release/recovery-20260926`, most recently `ee240199f4c72760ca9e7ce8c6eacd8e78739cf9`. No final desktop release has been published or certified.

All four OIDC bindings were found as plain-text configuration, converted to encrypted secrets without exposing their values, and verified by binding name/type. The owner subsequently confirmed replacement of both provider secrets. Client IDs were preserved. Historical Worker versions containing the old plain-text configuration must not be used for rollback. Secret rotation completion is owner-reported; no secret values or fingerprints were retrieved to compare rotations.

Production API migration 0007 succeeded, but 0008 exposed the legacy account schema mismatch. Commit `b61bb2df27d0f8387ce3fa383c23b58cb8822f76` supplies the independently reviewed guarded recovery and maintenance gate. Its final API suite passed 273 tests in 33 files with zero skips. The maintenance gate and nonempty legacy webhook refusal each have retained failing-before/fixed-after evidence. Production was held with Worker `62b085df-5bf9-4b4b-9007-4186bcf02dab`; after draining requests, recording a D1 bookmark and confirming zero legacy receipts/active billing leases, the guarded batch and migrations 0008/0009 succeeded. Schema parity, foreign keys and D1 quick-check passed. The same source reopened as API Worker `01741dc3-53c7-452c-8082-af5399f37fe4`, preserving encrypted bindings and disabled checkout. See `API-LEGACY-SCHEMA-RECOVERY-20260926.md` for recovery constraints. No account rows were exported.

Website migration 0006 succeeded after schema inspection and a recovery bookmark. Website Worker `15c05299-3dd4-4b5e-8ca6-9c32134ebe44` serves the previously tested social sign-in code. Home, Product, KalVoice, Pricing, Docs, Updates, Download, Account, Security, Privacy and Terms returned 200; `/changelog` returned 301 to `/updates`. The existing Windows preview download returned 200, which is not evidence for the pending signed release. Release catalog activation remains disabled.

Bounded production probes passed unknown-state denial, S256/nonce/callback binding, wrong-PKCE denial and cancellation handoff for both providers and both website/desktop client kinds. Both actual ten-minute state-expiry probes passed. These are API security checks, not authenticated provider-login certification. After the owner's latest browser retry, the account page displayed `Social sign-in could not be completed. Start again.` Aggregate-only D1 checks found zero Google identities, zero Microsoft identities and zero active website sessions. At least one website attempt per provider had been consumed, narrowing investigation to exchange/account/session completion. Successful OAuth remains BLOCKED; no credential change or repeated owner retry is requested until diagnosis is ready.

Corrected Mac updater cleanup packet `8d31c6a671836cd9c978bc6e85a94b6a978e5dc0` was independently reviewed and harvested as `ee24019`. The earlier `e497750` packet is superseded because cleanup preceded durable cancellation and restored-app launch. The accepted version preserves failed stages until cancellation and relaunch succeed, then removes only the verified staged sibling. Parent updater rerun passed 30 tests. Physical Mac review reported 32 updater tests and the helper-order regression passing, plus a temporary arm64 helper proof of staged removal while running. Actual signed installed update/rollback remains required.

The native lane now proves three crash-recovery cases with the original five-second assertion; its Browser download-isolation case remains a blocker, so the mutable packet is not harvested. The sole Apple runtime submission `f90019b5-8b0e-4862-921f-daf6a69ab7c3` last reported In Progress; the timed-out client wait was resumed against that same submission without another upload. No Accepted status, final app notarization, staple, Gatekeeper assessment or physical production install is claimed.

Evidence remains under root `target/recovery-20260926`, including API held/open deployment logs, schema/migration proofs, website deployment/live-page results, OAuth negative probes and integrated updater results. Production database restore requires a write hold and adjudication of intervening changes; source rollback is a bounded revert, never a reset or blind database restore. Remaining gates include successful real OAuth, native Browser proof, immutable final integration/full suites, private push, final signed builds, notarization, publication, real update/rollback, clean installs and live device QA.

Safe OIDC failure-stage diagnostics were reviewed and integrated as `69eed9e`. Parent verification passed all 276 API tests, typecheck and deployment dry run before API deployment `110a8a78-1ad9-4830-a03a-e4b66c460e5d`. All four OIDC bindings remain encrypted after deployment. The public error and identity/claim validation policies are unchanged. Only static provider/stage fields enter the existing structured log sink; raw exceptions and provider responses are discarded. A fresh owner-selected Google retry is pending with a bounded collector that persists only allowlisted stage entries, never request URLs, authorization data or raw logs. Additional test-only coverage from `da6d65b..80f0c61` proves mutated-stage sanitization and logger-failure containment: parent focused tests passed 22/22; isolated full API passed 277/277. The parent integrated Mac helper rollback-order regression also passed 1/1.

The next owner retry yielded the static Google `discovery` failure stage. An actual pinned Workerd probe isolated `redirect: "error"` as an immediate TypeError even for a canonical 200 response; plain fetch, timeout and strict UTF-8 decoding passed. Repair `aa637757` was inspected and harvested as `3c74f82`: manual redirect mode exposes 3xx without following it, and existing non-2xx rejection remains intact. Parent integrated API verification passed 281 tests in 34 files, zero skips, plus typecheck and dry run. Actual Workerd tests prove canonical discovery progresses and discovery/token/JWKS redirects never contact the redirect destination. Production API is now `4ea7147e-0f1b-4c53-8675-ce91dd5906c3`; all four OIDC bindings remained encrypted.

Google production new-user sign-in then succeeded. The signed-in account persisted through a browser reload; aggregate-only D1 checks showed one Google identity and one active website session. Free activation succeeded with 0/75 used, 75 remaining and unlimited local dictation. Sign-out and returning Google sign-in succeeded using the exact same owner-selected account, retaining the Free plan and one Google identity. No paid checkout occurred. Microsoft personal-account sign-in is now awaiting the owner's local account selection/consent. Desktop handoff and the rest of the auth matrix remain separate outstanding proof.

Windows component publication revalidated the existing signed catalog and uploaded its immutable signed runtime, but Wrangler rejected the 795 MiB reasoning model at its 300 MiB CLI limit. No catalog pointer was activated. Evidence: `windows-component-prepublish.log` and `windows-component-publish.log`. A multipart release-tool repair is in progress; full artifact readback, checksum/signature verification and D1 pointer checks must remain mandatory. The native Browser packet remains blocked after diagnostics proved two manual synthetic downloads had succeeded; further probes were stopped and subsequent testing confined to an owned download sink. Two synthetic files named `kalcode-browser-unsafe.txt` may exist in Windows Downloads; no existing owner files were inspected or deleted.

## Microsoft claim verification and native Browser reproof

Microsoft's production registration was inspected without printing credentials: the app supports personal and organizational accounts, has the exact production web callback, and requests both email and xms_edov optional ID-token claims. The first live failure exposed case-sensitive comparison against an uppercase configured UUID client ID. `34f96fd` canonicalizes only a UUID-shaped Microsoft configured audience; the different-UUID regression still fails closed. Google and non-UUID audience behavior are unchanged.

Subsequent allowlisted diagnostics proved that the signature-verified personal-account token represents affirmative xms_edov as exact string `"1"`. No raw token, claim, authorization URL, account identifier, or provider error was persisted. The new signed personal-account regression first failed with `claims_email_verification_one_text`. Independently reviewed correction `f7f82c6` accepts only Boolean true or exact string `"1"`, after existing signature, issuer, tenant, audience, nonce, time, version and subject validation. Numeric 1, near-match strings, arrays, objects, null, missing verification, false and string `"true"` remain rejected. The temporary one-text diagnostic was removed after diagnosis. Final API verification passed 282 tests in 34 files, zero skips, plus typecheck, Biome and staged secret scan.

Production API `aef6a83e-4f97-40b2-9f4f-24d05d043d40` contains the correction. All four OIDC bindings were reverified as encrypted by name/type only. The fresh authorized personal-account retry passed claim verification and reached `identity_collision`: its email is already registered by the Google identity. Automatic email-based linking remains denied and no Microsoft session is claimed. A distinct owner-authorized Microsoft QA account is pending; positive account linking and desktop authenticated handoff remain unproven. Google new/returning website sign-in, reload persistence and Free 75 activation remain proven as recorded above.

The isolated native Browser focused suite now passes 2/2, including actual native download denial, upstream blob navigation rejection, ownership-checked pointer delivery, exact request/callback counters, empty isolated download sink, popup containment and restored redacted state after restart/reload. This supersedes the earlier Browser blocker but does not substitute for the complete native suite or final integrated gate. The packet remains mutable and unharvested while remaining native cases run.

Multipart publisher packet `e91eb8c` was independently inspected and harvested as `883711c`; parent focused verification passed 19 tests and the full tooling suite passed 319. Its actual remote publication attempt failed during remote connection setup before catalog activation. The failure is retained in `windows-component-multipart-publish.log`; a bounded setup diagnostic/repair is in progress. Component provisioning is not yet certified. Apple's same runtime submission remains In Progress. Main/private push, final signed installers, publication, installed update/rollback and physical production QA are still outstanding.

The owner then completed Microsoft sign-in with a distinct authorized personal account. The actual website displayed Signed in; reload retained authenticated account controls and the activated FREE plan with 0/75 used, 75 remaining and unlimited local dictation. Sign-out and returning Microsoft sign-in using that exact owner-selected account succeeded, preserving the same Free plan. Aggregate-only D1 checks before and after returning login showed one Google identity, one Microsoft identity and one active website session; no account rows or identifiers were exported. New/returning personal Microsoft website login and duplicate prevention are now LIVE. Organizational login and actual authenticated desktop handoff remain NOT_PROBED_THIS_PASS. Explicit cross-provider account linking is NOT_IMPLEMENTED by the existing documented product contract; same-email implicit linking is intentionally denied and was proven live. No manual identity mutation was performed.

Apple's sole runtime job `f90019b5-8b0e-4862-921f-daf6a69ab7c3` now reports Accepted. Its downloaded log reports zero issues and the exact submitted ZIP digest. The local curation command still refused promotion because its bare-code post-notarization requirement check failed. All eleven members passed ordinary strict signature verification. Independent review identified Apple's documented `--check-notarization` flag as absent from the existing check; the Mac lane will probe that stronger check before changing the gate. The archive remains non-release-eligible locally until that verification is corrected and reproven. Final app/DMG signing, notarization, staple, Gatekeeper and installation are separate outstanding gates.

## Verified component publication and remaining native blocker

Mac runtime correction `628985b` was independently reviewed and harvested as `5631658`. It adds Apple's documented online ticket lookup without removing the per-member notarized requirement. Parent curator/notary tests passed 11/11 before and after integration. The physical Mac resumed the same Accepted submission with integrated code, passed all eleven strict online notarization checks and promoted the unchanged ZIP record to releaseEligible. No new submission occurred. Exact public evidence is retained in root `target/recovery-20260926/macos-components`; the initial handed-off commit `effbff1` is preserved under archive/recovery-mac-notary-initial-effbff1 after the author replaced it with a documentation-corrected packet. Further handoff amendments were prohibited.

Multipart recovery `e18d74b` and deadline correction `d74d3d9` were independently reviewed and harvested as `238bc38` and `c210c7d`. The remote-binding RPC fields are awaited before exact validation. Only proxy setup can retry, at most three isolated processes; one monotonic 29-minute budget includes all retries and terminates the owned process tree before the publisher's 30-minute outer timeout. Parent focused tests passed 14/14; the integrated tooling suite passed 324/324, zero skipped/flaky, and the packet secret scan passed. A retained timeout regression failed before the deadline correction.

Canonical remote component publication then passed for Stable Windows x86_64 sequence 1 and Stable macOS aarch64 sequence 1. Both completed full R2 artifact readback, exact SHA/size and signed-manifest verification, catalog verification, D1 immutable claims/pointer verification, and public catalog/range checks. Logs: `windows-component-publish-retry.log` and `mac-component-publish.log`, both exit 0. The Mac catalog was signed locally with the existing Windows-protected component key; no key was exported or rotated. Shared model bytes were reused; the Mac runtime retains its independently Accepted Developer ID archive. This certifies published components, not installed application provisioning. Actual signed-app download consent, atomic installation, Doctor status, STT and local inference remain physical QA requirements.

The complete native suite passed 22/23; the remaining Browser main-reload case still fails the existing five-second readiness assertion. Bounded diagnostics identify `browser_download_guard_failed` during restored child initialization, after which fail-closed cleanup removes the child record. The production lifecycle repair is under review; no unguarded navigation, broad error retry or timeout increase is accepted. The earlier focused 2/2 result remains valid but does not override this complete-suite failure.

A first-release updater staging gap is also being repaired in an isolated tooling lane. Normal publication requires real update/rollback proof, while the first signed Mac baseline and candidate have no existing feed. The reviewed design stages only exact signed immutable version descriptors/artifacts without advancing any channel pointer, uses a never-merged lower-version QA baseline with a pinned immutable candidate URL, and exercises the exact final candidate's install/health/rollback/reupdate. Normal Stable publication remains fully gated. No QA receipt, baseline artifact or successful update/rollback is claimed yet. Free-account billing navigation was also verified live: it reports billing availability after a paid subscription and did not initiate a charge.

## Clean-profile preparation and release-tool preflight

The owner confirms separate local standard users named `kalcodeqa` are ready on Windows and macOS, with clean profiles, no migrated KalCode data/credentials, and existing development sessions preserved. This is owner-reported preparation, not clean-install proof. No password was requested or shared. Installation and functional QA remain outstanding until the exact signed artifacts are available.

The Windows release-tool preflight found Artifact Signing tools available and verified that the existing protected updater key matches the tracked public key. This did not build or sign a new artifact. A read-only production `kalcode-web` query found no release channel pointers and no immutable release claims for versions 0.1.4 or 0.1.5. The QA staging tool must still perform its own fresh object/claim collision and pointer checks immediately before any effect.

The Browser reload failure was localized to two separate lease rotations followed by cleanup that could capture a newly created replacement child. The repair now uses a shared atomic lease rotation and record drain for reload and runtime cleanup; independent review additionally requires failed exact old-child closes to remain retryable without overwriting a replacement. The packet is still under verification and remains unharvested.

## Immutable updater route bootstrap repair

Production's existing `RELEASE_CATALOG_ENABLED=false` intentionally preserves the legacy customer preview, but also prevented exact-version updater URLs from reading the D1 claims required for first-release update/rollback QA. Four new local Workerd regressions failed against the original route: claimed versions were unavailable and an unclaimed legacy version object was served. The repair reuses the existing D1 catalog for exact-version updater descriptors and their descriptor-authorized artifacts/signatures regardless of the moving-pointer rollout flag. Latest manifests, customer download links, mutable Stable/Beta/Dev feeds and legacy pinned downloads retain their prior behavior until explicit cutover. No new environment flag, store, pointer writer or unsigned-artifact exception was introduced.

Independent route review passed. Local D1/R2 coverage proves Stable/Beta/Dev version lookup, unchanged preview and pointer rows, Windows/Mac range and signature binding, cross-target denial, missing-row 404, and corruption/D1-failure 503 without legacy fallback. The expanded website suite passes 339 tests in 24 files, zero skips. Website typechecking passed with zero errors/warnings, the production build generated 18 pages, Biome and diff checks passed, and the deployment dry run retained the disabled moving-pointer flag. Exact-version prepublication availability is not completed installed updater QA. Roll back this route repair by a bounded source revert with current encrypted bindings preserved; no production data migration is involved.

Route repair `4892dcd3b7a0644c0b85e87b175c3312bea45f8e` is deployed as website Worker `c69b6947-97d8-42ae-aa83-ab4a210b898b`, preserving variables and the false rollout flag. Live checks prove the missing 0.1.4 version returns D1-authoritative 404, the legacy Stable feed remains 404, Windows preview remains 200, Mac latest remains 404, and the public latest manifest bytes are unchanged. The authorized Microsoft website session survived a browser reload with the Free plan and 75 requests remaining. No release object, version row or channel pointer was mutated by this deployment.

Updater staging packet `046d3949d58eee425cb7908be7d67873d690fc96` was independently reviewed and harvested as `1830b96309b4ac9aee02cb117f697cf8a2c3d7dc`. Parent focused verification passed 40/40 and the integrated registered tooling suite passed 338/338 with zero skips/flaky results; the exact packet secret scan passed. Review caught and repaired caller-controlled upload arguments and an incomplete pointer snapshot guard before handoff. Upload commands now derive only from validated immutable object fields, and each immutable D1 claim binds the complete pointer/version snapshot without pointer mutation. Normal publication still requires exact clean-install and real update/rollback/re-update evidence. Stable, Beta and Dev channel binding remains supported. See `docs/UPDATER_QA_STAGING.md`; no updater QA artifacts or receipt have been staged yet.

One additional standard profile named `kalcodeqa2` was requested on each platform so the final candidate and older baseline can each receive separate direct clean-install proof without clearing the first QA profile. This additional preparation is pending owner confirmation. The native Browser focused tests passed after fixing replacement-page lease capture timing; the final late-creator failed-close retention repair is undergoing its final rebuild and complete native verification. No final source freeze or main integration is claimed.

## OWNER entitlement closeout and clean QA profiles

The owner confirmed `kalcodeqa2` on both platforms in addition to `kalcodeqa`. Read-only checks now verify both Windows accounts are enabled non-administrators and both Mac accounts are standard users with distinct existing homes. No profile data was read, cleared, copied or migrated. The first profile remains reserved for the final candidate direct clean install; the second for the independently signed lower-version baseline and update/rollback/reupdate sequence.

The owner explicitly designated the verified Google production QA KalCode identity as the permanent OWNER account. Existing authority was preserved: an operator-only D1 grant, immutable account binding, database constraints, atomic audit trigger, signed entitlement snapshots, unlimited usage, and OWNER precedence over billing. The public pricing catalog still excludes OWNER. Signed snapshots retain normal bounded validity and session security; the server grant does not expire.

The actual trusted-tool dry run exposed an account-ID grammar mismatch: authentication generates `acct_` base64url IDs, but the operator CLI rejected underscores. Independently reviewed packet `bf51eb801340ad6773261142c0b2a82c4f1da2b3` was harvested as `1ac2e11a5220e81faa913823c3da7995959cc18c`. Its canonical-ID regression failed before repair and passed afterward, including dry-run/no-write, grant/revoke and malformed-input denial. Parent independent local D1 tests passed 11/11; integrated API passed 283 tests in 34 files, zero skips. Rust entitlement tests passed 25/25, zero ignores. Packet diff and secret scans passed. Live unauthenticated entitlement/usage and spoofed OWNER-tier probes all returned 401.

After a successful production dry run, the existing administrator command applied the authorized OWNER grant once. An additional SQL verification query failed after the operation, so no write retry occurred. Read-only reconciliation through the canonical grant/audit helpers verified exactly one active permanent operator OWNER grant and its matching atomic grant audit; no other account holds OWNER. The authorized Google website session was refreshed and visibly showed OWNER and `0 used · Unlimited`. Evidence contains only status/counts, not account IDs, emails, tokens or credentials: root `target/recovery-20260926/owner-entitlement-grant.json` and related test logs. Revocation, if explicitly required later, uses the existing audited revoke-owner tool; never delete a grant or reset a database.

The website's generic billing controls incorrectly suggested that OWNER needed a subscription, and desktop lacked explicit no-payment text. A separate isolated UI/regression packet is still under final verification. This entry does not claim that display correction deployed or that a final signed desktop has consumed the production OWNER entitlement. Main integration, final gates, signed installers, actual installed provisioning/update/rollback and physical QA remain pending.

OWNER display packets `e9bbdadde735c29f895d72893063c5720bdc6ae6` and `8265b13dc6056d5b51c87a3ea1c7f2e758e34192` were independently reviewed and harvested as `0c7fb6b` and `4040c27`. The initial wider verification exposed four build-dependent website skips and stale isolated-worktree protocol/cmdk dependencies. These were not accepted: a fresh normal website build enabled all checks, and an isolated offline dependency install applied the checked-in cmdk patch and correct worktree links without source dependency changes. The enabled public-HTML check also exposed hidden static OWNER wording; the follow-up preserves the test and populates an empty account-only placeholder after the authenticated server returns OWNER.

Exact integrated `4040c27af2f06c0a1c3546007e48f52c7a0130d1` passed website 341/341, API 284/284, desktop 882/882, desktop typecheck and account browser E2E 7/7, all with zero test skips. The added real local D1 regression proves ordinary Stripe upgrade, downgrade and cancellation snapshots cannot revoke or displace the permanent operator OWNER grant. Focused parent reruns, independent review, diff checks and bounded secret scans passed. The website deploy dry run preserved the disabled release-catalog pointer flag.

Website deployment `502c3ea1-5f01-4da7-bc0e-3927021624ab` now serves the verified OWNER display, with current variables preserved. Live public account/pricing HTML checks passed. The exact authorized Google session survived reload and showed OWNER, Unlimited and no subscription payment requirement; Manage billing, Activate Free and public upgrade controls were absent. No Stripe charge or checkout occurred. Desktop display code is integrated and tested, but installed production desktop proof remains pending the final signed builds. The native Browser complete-suite gate is still red and blocks final source freeze; a focused pass is not treated as completion.

## Native release gate recovery, September 27

The preceding native Browser failure is resolved. Independently reviewed fixture commit `3cfc33f9a33970d7e47fecf3fcdcf81435b81887` was harvested as `a92bcc0189e7eabbf01e46f731a8f5ab6aa86099`; parent fixture-contract verification passed 2/2. Signed synthetic account fixtures remain restricted to the isolated E2E build, with production Whisper enabled and real Resource Governor admission. The already integrated equivalent PTY parent was not duplicated.

Independently reviewed native packet `a4a819d6602c8a69b69406ececee9d712c5f99e3` was harvested as `e77bb8246b2408d52c612327d3e5a55013f216fc`, with exactly 17 audited paths. Windows Browser children start inert until native download denial and confined download storage are bound. Page-lease rotation and old-record detachment are atomic; exact old close targets survive failed cleanup without overwriting replacements. Browser information no longer reports creating or closing children as ready. The external guardian retains job handles until process-zero proof, drops them before publishing exact-epoch CLEAN, and serializes replacement epochs behind helper drain. Fatal provider-auth bootstrap failure cleans partial owners and remains blocked.

The trace-free native E2E run passed 23/23 with zero skips or retries, including actual owned-window pointer input, download callback/request counts, bounded cancellation-temp cleanup, empty stable download storage, reload, crash recovery, providers and KalVoice. Evidence: root `target/recovery-20260926-native/desktop-e2e-full23-final-green-rerun.log`. This supersedes earlier focused-only and failed full-suite results. The original Browser attach deadline remains unchanged.

Full production-feature Rust exposed two timing-racy auth lease tests and outdated direct-helper fixtures. Test-only corrections synchronize the final lease observer, prove exclusivity before release, join cleanup before assertions, and prove later acquisition. Direct-helper tests retain a canonical RUNNING epoch and preserve positive process-cleanup assertions; a separate missing-epoch case proves fail-closed behavior. No production auth bypass or missing-epoch fallback was introduced. Focused auth tests passed 2/2 in three runs; guardian contract tests passed 7/7. Final exact-source workspace verification passed 2,012 tests, zero failures and the existing 16 explicit registered ignores across 120 result groups. Strict production-feature workspace/all-targets Clippy, Rust formatting, scoped Biome, desktop typechecking and bounded secret scans passed. Parent independently reran Browser regressions: 17/17, zero ignores. Generated formatting-only protocol drift was inspected and restored before the clean immutable commit.

Canonical main remains `ad4d073faea0a4800fbdd027b8f2fee87ff43752` at this record. `rollback/main-before-production-20260927` preserves that exact commit; the earlier recovery rollback remains intact. Untracked root `marketing/` is preserved. Historical aggregate diff-check warnings in already applied migration EOF spacing and integrity-bound third-party license bytes must not be normalized as incidental release work. The exact final-main gate is still pending and must bind its commit, clean execution worktree, canonical main equality, fresh website build/state, registered suite counts, and zero flaky UI tests. Signed Windows/Mac final artifacts, Mac app notarization/stapling, clean profiles, installed component provisioning, real updater/rollback/reupdate, Stable activation and final production verification remain outstanding. No SHIPPED claim is made.

## Final-main portability reproof

Canonical main was fast-forwarded to `3738515e837533a7e052b6b945ae2309e4c82a5a` after independent source/harvest audit. The private remote was reverified as private and still at `ad4d073`; no push occurred. At exact main 3738515, all 20 Windows non-Rust gates passed: 1,994 registered JavaScript unit tests without skips/flaky results; website E2E 148 executed with eight reviewed conditional skips and no flaky results; desktop UI 301, widgets two and UI primitives four, all without skips/flaky results. Formatting, lint, typecheck, fresh website build, policy checks and dependency audit passed. Existing transitive advisory warnings remain recorded; GLib is not selected in either shipped Windows x64 or Mac arm64 dependency tree, and no new waiver was added.

The first Windows registered Rust command returned exit 101 with child output suppressed. Its exact cause could not be recovered. A direct full rerun, a registered rerun and an instrumented registered run preserving the exact child invocation each passed 2,015 tests with the same 16 intentional ignores. The original failure remains unexplained, not fixed or waived. Subsequent final registered runs must capture the child output from their first attempt. Evidence is under root `target/recovery-20260927-finalF-native`.

Physical Mac tooling on 3738515 exposed 42 failures: valid fixtures used the system `/var` temporary alias while strict path guards correctly required `/private/var`, and several signing fixtures assumed Windows absolute-path syntax. Correcting those fixtures also exposed a production issue: the component publisher internally created noncanonical temporary staging, which reached the multipart upload guard for large model artifacts. A physical regression failed on the internal staging path while externally supplied directory-link rejection remained green.

Independently approved immutable packet `b280225db0b4a9ad1e9672449831e25a9e9b57af` was fast-forward integrated into the release branch. Its only production change canonicalizes the newly created publisher-owned staging directory; external path, link, checksum and signature guards remain unchanged. Nine test files now use valid platform-native/canonical fixtures. One new directory-link denial test raises Windows tooling from 338 to 339 tests and Mac tooling from 337 to 338 total. Exact packet verification passed Windows registered tooling 339/0 skipped, physical Mac registered tooling 336/2 existing skips, independent Windows focused tests 114/114 and parent publisher/signing tests 38/38. Formatting, lint, diff and bounded secret scans passed. No artifact was published during these tests.

The owner confirmed a fresh Mac login/default-keychain unlock. SSH still reports restricted interaction/default keychain locked; a GUI-session probe is being used to distinguish session scope without exposing credentials or changing access controls. Final full gates must bind the forward integrated main commit; prior-commit results above are retained evidence, not substitutes. Private push, final signed application artifacts, physical installation/provisioning, actual updater recovery and public Stable activation remain pending.

## Captured final-main failures and bounded corrections

At exact main `6ff92f7dc79ca5e1bb3ed001b41b84606be3272a`, the first Windows registered Rust run captured seven failures in Claude auth fixtures. The fake CLI recursively launches the provider test executable; concurrent fixture starts exceeded their existing two-second startup/probe windows before the intended scenario assertions. Focused parallel and serial runs each passed 10/10, which localized the failure but did not clear the full gate. Independently reviewed test-only packet `23aa8130de24bb723d6521d1c32621a5608209a8` was harvested as `6f539ab8329b937b416125c457b8358a115e8602`. A process-local fixture slot remains held through teardown; review corrected its field order before final proof. Production code, timeouts and the internal concurrent-cancellation scenario are unchanged. The corrected canonical full run passed 2,015 tests, zero failures, 16 existing intentional ignores and zero flaky results. Strict workspace/all-target Clippy, formatting, diff and bounded secret checks passed. An additional explicit installed Codex 0.157.0 configuration-isolation test passed with synthetic profiles and no inference. Evidence: root `target/recovery-20260927-finalN-native`. The earlier opaque 3738515 exit 101 remains historical unexplained evidence; this repair proves only the later captured failure.

The physical Mac formatting gate found the tracked empty hook-cache JSON was not Biome-formatted. Formatting-only packet `9ea37deecdb378fcb8731fda86e29a67d94c0af5` changes that one file without changing its JSON value, guards or behavior. Windows and physical Mac formatting checks passed. The Mac website browser suite separately found its package-pinned Chromium runtime missing; installing that runtime and rerunning the unchanged suite is environment preparation, not a test waiver. Final combined-main gates remain required.

The bounded notary-profile probe now succeeds from the owner's existing GUI session using a temporary, subsequently removed LaunchAgent. SSH's restricted keychain context is not treated as a credential failure. No password, credential value, raw notary history or keychain access-control change was recorded. This is credential readiness, not final-app notarization.

## Remaining production evidence at source freeze

The source repairs above are integrated; private push remains gated. The final candidate and never-merged lower-version QA baseline still require Windows Azure-signed installer/update artifacts and Mac Developer ID app/DMG, Accepted notarization with issue-free log, stapling and Gatekeeper proof. Prepared standard users `kalcodeqa` and `kalcodeqa2` on both platforms are not clean-install evidence.

Physical product checks remain pending for installed component provisioning, Doctor, microphone/STT, local reasoning and focused provider dictation; logged-in Claude/Codex/Gemini, account routing and native permission behavior; Browser, workspace/Dashboard, secure storage, notifications, Retina behavior, reconnect and sleep/wake. Final desktop OWNER consumption and browser handoff remain pending. Production email sign-in and organizational Microsoft sign-in where an authorized account is safely available are not yet probed. Google and distinct personal Microsoft website sign-in and server-authoritative OWNER website display retain their recorded live evidence; implicit duplicate-email linking remains safely denied, and explicit account linking is not implemented.

Billing navigation and local backend/webhook regressions are verified; a complete safe production billing lifecycle is not claimed. No real charge was created. Both platforms still require immutable QA staging with pointer-invariance evidence, normal direct baseline/candidate clean installs, and actual update, rollback and re-update. Final Stable feed/catalog activation, signed Windows/Mac downloads, and complete production readback remain pending. Current public pages return 200 and `/changelog` redirects 301 to `/updates`; this does not prove final artifact delivery.

Release tooling explicitly permits a release-notes-only descendant of the exact artifact build commit. After candidate artifacts supply their SHA-256 values, `docs/releases/<version>.md` may be committed without changing runtime source; the final report must distinguish artifact build commit from final main notes commit. The baseline derives from the artifact build commit. No campaign or other source-path commit may enter that post-build tail. The actual final main notes commit still requires its requested final gate and private push. No SHIPPED status is claimed.

## Shared provider fixture resource correction

The first captured registered Rust gate at `d5e52a0651a34ed36db87b0b77aed624f0360a5e` failed two provider tests: Codex timed out while awaiting shared cancellation/RPC cleanup after successful login start, while Claude timed out at login start. This disproves the sufficiency of the earlier Claude-only fixture slot and supersedes a startup-only explanation. Evidence remains in root `target/recovery-20260927-final-d5e-native`.

Inspection identified all three fixtures recursively launching the same provider unit-test executable: Codex auth, Claude auth and provider-view PTYs. Independently approved packet `6798b6b333abea7a433cbe29c57bb64c7b878c69` was fast-forward integrated. Its four-file test-only change governs that shared synthetic resource for the complete fixture lifecycle. Auth guards drop last; each of six provider-view parent tests holds a test-scope guard before constructing its Rig values. Independent review caught an intermediate per-Rig deadlock in the intentional two-Rig case; that invalid focused attempt was stopped and corrected before accepted proof. The recursive fake child does not take the guard, and internal multi-child/concurrent-cancel scenarios remain intact. Production behavior, deadlines, assertions and test counts are unchanged.

The first corrected canonical registered workspace run passed 2,015 tests, zero failures and 16 existing ignores across 120 result groups, with zero flaky results. Provider tests passed 228/0/1, including both latest failures and the two-Rig regression; strict production-feature workspace/all-target Clippy, formatting, diff and bounded secret scans passed. Parent independently parsed the complete captured results and inspected the final diff; the independent reviewer bound approval to the immutable clean commit. Evidence: root `target/recovery-20260927-shared-recursive-slot`. The historical opaque 3738515 failure remains unrecoverable; no cause is retroactively asserted for it.

Physical Mac d5e headless verification passed fresh website and desktop builds, strict production-feature Clippy, typechecking, formatting, lint, policy checks, all registered JavaScript unit suites, and website E2E. Real Keychain-backed registered Rust is still running in the existing GUI session with no skip override. The next combined-main gate must still prove the integrated repair. All signed-package, installed-product and publication requirements listed above remain pending.

## Acquisition cancellation test readiness

The first captured combined-main Rust run at `6e480c73d0c25df05f693cf1f01adab0ca2d6a2c` found a separate KalVoice test failure: cancellation correctly returned `Cancelled` with zero transport calls, but its elapsed-time assertion failed. The test slept 50 ms without proving the worker had completed preflight and reached the held acquisition lock, so its clock could include unrelated preflight/scheduling work. The failed run remains under root `target/recovery-20260927-final-6e480-native`.

Independently approved packet `c22c4df1db490229b8fdeb4e24077f39b2170147` adds a test-only actual-lock-conflict observer and bounded readiness/resume handshake. The original cancellation limit remains strictly less than one second. The test requires cancellation completion while the lock remains held, retains exact `Cancelled` and zero-transport assertions, and releases/joins its worker before failure assertions. Non-test code/layout, the 25 ms poll and production cancellation behavior are unchanged. A temporary mutation removing the conflict cancellation return failed deterministically within 2.04 seconds without hanging; the exact source was restored and the focused test passed again.

The first corrected canonical full run passed 2,015/0/16 across 120 result groups with zero flaky results; the KalVoice block passed 242/0/2. Strict workspace/all-target production-feature Clippy, formatting, diff and bounded secret checks passed. Parent parsed the complete captured results and reviewed the diff; independent review bound approval to the clean two-file commit. Evidence: root `target/recovery-20260927-kalvoice-lock-cancel`. This verification does not substitute for the next exact combined-main gate or installed KalVoice proof. The final source security review at 6e480c7 found no new confirmed security blocker; this subsequent packet is test-only and independently reviewed.

## Exact Windows gate and first-publication recovery

At exact main `92d79e69fbb0bf4ab48bf8be2f2e2d14d8fa366c`, the first captured Windows registered Rust gate passed 2,015/0/16 with zero flaky results. Strict production-feature Clippy, formatting and diff checks passed. A fresh native build with production Whisper plus isolated E2E hooks passed the complete registered native suite: 23 executed, zero skipped and zero flaky, in 3.7 minutes. Pre/post HEAD matched main and the execution tree was clean. Evidence: root `target/recovery-20260927-final-92d79-native`. These test-hook artifacts are not production release packages.

Independent release sequencing review found a pre-effect reliability blocker in initial D1 authority bootstrap: an interruption after the first pointer insertion but before completing the tracked website manifest made the old bootstrap reject a safe retry. Independently approved packet `24510f97727e6e4353e8b67978d334dd4ff1d1af` was fast-forward integrated. It permits only an exact existing candidate to resume, grants no pointer initializer to that path, preserves all signed artifact/final schema-v2 QA/object/version checks, and rereads exact authority before manifest output. Conflicting or malformed authority still fails closed.

Recovery after partial manifest output or formatter failure preserves the failed dirty worktree. A fresh clean checkout of the same publication commit receives the byte-identical complete ignored release packet, with the external updater-QA receipt preserved separately. Normal strict revalidation then resumes; no dirty-tree exception or manual manifest bypass exists. Real SQLite and filesystem tests cover first insertion, complete-write/formatter failure, partial-write failure, fresh-workspace retry and conflicting state. Intended RED was observed; final focused tests passed 30/30, including an independent parent rerun. Registered tooling passed 342/342 with zero skips/flaky results; three new tests raise the total registered JavaScript expectation from 1,995 to 1,998. Scoped lint/format, diff and bounded secret checks passed. No production pointer, artifact, binding or deployment was changed during verification.

The release documentation now distinguishes B (artifact build), N (B plus artifact-hash release notes; clean publisher authority), and W (generated website manifest and deliberate D1 authority enablement; final pushed/deployed main). Before first cutover, immutable version-specific QA is the live evidence; mutable Stable verification follows deployment with the true catalog binding through the normal idempotent publisher from N. W must pass its requested final gates. Artifacts remain truthfully bound to B. After cutover, rollback must preserve D1/true authority.

Physical Mac d5e GUI Rust reached its unchanged 30-minute timeout during compilation, before test execution; owned cargo/rustc processes and the temporary launcher were removed and the clean source/cache preserved. This is infrastructure timeout evidence, not a test pass. A separate no-run compile-preparation attempt on exact 92 then exposed missing CMake in the GUI build environment. Existing toolchain paths are being checked before any official user-local bootstrap. The final Mac registered Rust/Keychain gate and all signed installed-device requirements remain pending. Later combined-main source gates must include the reviewed publication repair above; no SHIPPED status is claimed.

## Cross-platform release gate corrections after b2c79054

At exact b2c79054, all 20 non-Rust gates passed: 1,998 registered JavaScript tests, website E2E 148 executed plus eight reviewed conditional skips, and 307 UI tests, with zero flaky results. Dependency audits passed with the existing seven allowed advisories unchanged. Windows registered production-feature Rust passed 2,015/0/16 across 120 groups and strict Clippy passed. Native E2E failed two of 23 checks: the harness accepted an uninitialized document, and single-shot WebView2 context discovery raced startup. Original failures remain in target/recovery-20260927-final-b2c790-native.

Independently reviewed native packet 1cc70da175625ace3950387f30a1e1f9e1266f30 adds bounded CDP/context/document readiness within the original shared 30-second deadline. It checks owned-process state, initialized Tauri and a nonempty root, handles late connections and pending rejections, and does not require Dashboard instead of a legitimate onboarding/error screen. Review caught and corrected unbounded evaluation, extended connection timeout and acceptance of a closed page. Eleven deterministic units, the two original failures and all 23 registered native tests passed, with zero skips/flaky results. Parent reran the 11 units. One operator invocation incorrectly selected an old root binary; it is preserved and excluded from product-failure and accepted-proof evidence. Only the fresh worktree binary supplied accepted native evidence.

Physical Mac registered gates exposed ordinary temporary-directory aliases in ManagedProfiles and SQLite test fixtures. Reviewed bb0c8ba, b0d89a8 and 67eb964 canonicalize those ordinary fixture paths only on macOS, including the expected reported working directory. Windows paths and explicit linked-parent/hardlink attack tests remain unchanged. Production path/link guards and SQLite OPEN_NOFOLLOW remain intact. Focused Mac and Windows suites passed. Native-picker alias compatibility remains unproven and fail-closed, not a confirmed production defect.

The full Mac provider pipeline exposed a production Claude interrupt event-order race: matching control acknowledgement could reach the caller after the reader had emitted completion. Reviewed 063b07f makes the matching reader claim exact request authority and emit Interrupted before acknowledgement. Pending/claimed arbitration, bounded timeout handling, exact cleanup and an attempt guard prevent overwrite, speculative success, lock-held sink invocation and indefinite waits. Seven new deterministic tests cover response/timeout races, concurrent rejection, write failure, wrong/negative/duplicate responses, panic/disconnect and finish cleanup. Windows full provider suites, strict Clippy, parent independent seven-test rerun, and focused physical Mac pipeline passed. The original real Mac failure is the authoritative reproduction; an extracted helper RED is synthetic and is not represented as an unchanged original execution.

Repeated full Mac KalVoice gates then failed the existing strictly-less-than-two-second noncooperative timeout assertion. Idle passes did not clear the blocker. Separate diagnostic commits a90015d, 6384f08 and 09ab8bf were never integrated. Their non-failing observations did not explain the natural failure numerically. Reviewed 72ebbc5194bac65ff5e02d58483d38be90f79ffe fixes the independently reproduced cumulative-budget defect: timeout cleanup now uses the original primary deadline plus the existing 250 ms settle budget, rather than granting a fresh 250 ms after a delayed wake. The 1,500 ms primary budget, original response assertion, cancellation, retained custody, drain and busy/retry behavior are unchanged. A test-only per-instance observer proves a delayed wake deterministically; the former expression fails and the correction passes against the original two-second budget with bounded cleanup. The new regression adds one test. Windows KalVoice passed 243/0/2 plus integration/schema suites; physical Mac focused/full KalVoice passed 246/0/2 plus integration/schema suites. Strict production Whisper Clippy passed on both. Parent independently reran both noncooperative timeout tests. Source review and bounded secret scans passed.

The exact combined-main gate and signed installed-product proof are separate mandatory stages. Test-hook binaries and focused passes are not production packages or physical customer QA. Preserve all earlier failed attempts and their classifications. No production artifact, release pointer or source push was made during these repairs.
The next exact 72 physical registered run exited101 after213.241 seconds: 1,038 passed, two Locator short-alias failures and seven existing ignores before the runner stopped. Both original and new KalVoice timeout tests passed (KalVoice 246/0/2). The two Locator failures returned no alias result under load; isolated execution passed. Measured bounded-load diagnostics proved SQLite interrupted alias widening at 12.038 ms with no direct matches, exactly the existing best-effort 12 ms fallback contract. All owned load processes were bounded and cleaned. The runner's stop-before-normalization left generated-only protocol drift; canonical normalization restored it. This source-integrity status is preserved separately from the test failures. Keychain and explicit Codex steps were not reached in that failed run.

Independently reviewed 8324fc3d60fe436173c020341c6d30abc9a74d3d makes the two large structural assertions deterministic in private unit scope. They keep their original names, result-cap/scan-limit/long-FTS assertions and actual SQL. Four public-search integration tests remain registered; three private tests replace the two moved tests, for a net increase of one and no removed suite. A private interrupt-policy seam preserves the real clock start, 12 ms budget, progress cadence, production SQL and fallback. The new forced-interruption regression verifies direct-result retention, alias omission and handler cleanup. Five deliberate mutations failed as intended: removing the candidate limit, scan limit, long-FTS branch, direct-result fallback or handler cleanup. Windows full Locator passed 39 unit,16 integration,6 rail and4 short-alias tests; the existing release performance ignore remained registered. Strict Clippy, formatting, diff and bounded secret checks passed. Parent independently reran the three unit contracts. Physical Mac focused 3/3 and4/4, strict Clippy and the explicit release performance test passed: 100,000 entries, overall p95 20.79 ms and worst-query p95 21.06 ms against 30 ms. Evidence is in target/recovery-20260926/mac-locator-alias-contracts. The complete physical registered lifecycle remains a separate gate.

Reviewed documentation packet 9865b42 corrects obsolete no-Mac/no-Apple-access and Windows-only publication claims. It also reconciles the private Windows verification workflow's exact four assets and preserves failed notarization checkpoints. Only docs/MACOS.md and docs/RELEASING.md change. The final production app/DMG and physical gates remain explicitly pending; published runtime-component evidence is not substituted for app evidence. Release-manifest and branding checks, diff and bounded secret checks passed. The initial unavailable Prettier invocation was an invalid tool choice, not accepted format evidence; this repository uses its registered checks.
The next exact 832 registered Mac gate passed Locator and KalVoice but stopped at Gemini's immediate post-drop lease assertion: 1,559 passed, one failed and eight existing ignores across 64 groups (277.681 seconds). The retained output worker legitimately owns a shared profile lease through cleanup, so dropping the outer handle does not guarantee synchronous exclusive reacquisition. The failed result is preserved under physical-8324fc3-full-failed. A complete unchanged-feature supplemental no-fail-fast run then passed 1,977/0/16 across 120 groups in 356.582 seconds. This exposed no additional failure; its passing Gemini result did not erase the original race. Real GUI-session Keychain and pinned Codex0.157 configuration-isolation probes each passed 1/1 with no skip override. Pre/post source remained exact 832 and clean, owned helpers were removed, and the exact temporary GUI launcher was removed. Parent independently parsed the complete logs and floor results under physical-8324fc3-nofailfast.

Independently reviewed 7f2e47c82546529f646c258a5e113f55a8ba9c32 corrects only crates/providers/tests/gemini_managed_policy.rs. A controlled second-turn event proves that terminate and outer-session drop cannot release the lease while the output reader is retained. The test then releases the reader, waits for final sink cleanup, and requires actual exclusive reacquisition. The existing 20-second bound stays unchanged. Review caught and corrected unbounded test callback waiting, mutex-poison/double-panic cleanup, and failure-path worker cleanup before acceptance. The callback has explicit timeout evidence; cleanup is poison-tolerant and panic-safe. One new callback-timeout regression raises Gemini integration 2 to 3, with no removed tests. Windows full providers passed 329/0/9 across 19 groups, strict Clippy and formatting passed, and the bounded secret scan passed. Production lease, guardian and provider behavior are unchanged.

The reviewed integration sequence uses the comprehensive832 Mac inventory plus scoped full-provider proof for this test-only correction, then runs the complete unchanged release gates against the actual combined main commit. No source push or production build is permitted before those final-main gates pass. This avoids repeating an intermediate complete Mac rebuild whose production code has not changed, without substituting focused or diagnostic evidence for the final-main gate.
The Gemini fixture's two adversarial mutations failed deterministically: the old immediate reacquisition assertion failed while the reader gate held the lease, and an unbounded callback failed after 20 seconds with its owned worker released and joined. Exact source was restored. Parent rebuilt and independently reran all three Gemini integration tests: 3/3 passed in 0.58 seconds; pre/post source was clean at 7f2e47c after canonical generated-protocol normalization. Mutation logs and parent proof are in target/recovery-20260926/mac-gemini-lifecycle-test.
Physical Mac 7f2e47c scoped proof passed: 301/0/9 across 19 provider groups, both focused lifecycle checks, strict Clippy and canonical protocol normalization. Pre/post source was exact and clean. The first external runner incorrectly stripped the leading Git porcelain status column and rejected an expected generated path; that invalid harness result is preserved separately. Corrected v2 repeated the checks without changing source and passed. Parent independently parsed the results; final independent approval binds the immutable commit.

The integration worktree fast-forwarded from b2c79054 through 7f2e47c, preserving the seven-commit Rust repair chain. Reviewed documentation 9865b42 was harvested as 6d8a1f3 and native harness 1cc70da as 729ca3b; no conflicts or duplicate runtime commits were introduced. The integration rollback reference rollback/main-before-cross-platform-20260927 preserves b2c79054; the original pre-production rollback still preserves ad4d073. Root untracked marketing/ remains untouched. All diagnostic-only commits remain excluded.

This entry freezes the combined source for actual-main final verification. Expected registered counts are Windows Rust 2,025 (nine added tests since b2 plus the Gemini timeout test), Mac Rust 1,978, and JavaScript 2,009; the runner must report actual counts and account for every existing ignore. No push, production application build, app notarization, installer publication, Stable pointer change or website cutover is claimed here. The previous live OAuth/OWNER and signed component publication evidence remains valid within its documented scope. Final-main gate receipts will be retained outside the tracked source, so recording a result cannot silently change the commit under test.

## Private CI and production packaging closeout after d5c903f

The actual `d5c903fca46944cfc00eef42481c51372be1746c` local final gates passed: Windows Rust 2,025/0/16 across 120 groups, strict production Clippy, formatting, fresh native build and native E2E 23/0/0; physical Mac Rust 1,978/0/16 across 120 groups, real Keychain floor 1/1 without an override, pinned Codex isolation 1/1, and headless checks; JavaScript 2,009/0/0, website E2E 148 passed plus eight reviewed skips, and UI 307/0/0. Independent review accepted the exact-source receipts. Private `main` was fast-forward pushed from ad4d073 to d5c903f and read back exactly. The root's untracked marketing directory remains preserved.

The subsequent private CI run 36309792151 exposed additional gates: two Biome import-order errors in the release publisher files, unused callback parameters in the unsupported-platform PTY branches, and missing real macOS Tauri sidecars on the hosted runner. Independently reviewed packet `4ff4f19983ee4b2d7c0dfb38a9c8af73c17e24e9` corrects those exact causes. Its fresh CI run 36310523472 passed Biome and the Mac helper preparation, formatting and strict Clippy, then exposed one further Linux-only unused Duration import. Reviewed follow-up `205c0867b8226e4a70a033737706d9164397c1b1` places that import in its existing Windows/macOS module. Windows focused strict Clippy and 243 KalVoice tests passed, with two existing ignores; standalone Linux-target module compilation passed with warnings denied. The unavailable local Linux C compiler prevented a full local cross-check and is not counted as proof. The fresh combined hosted Linux Clippy/workspace tests remain mandatory. The same hosted run also exposed a Doctor fixture whose empty PATH still discovers runner-installed tools in known macOS directories, while the Desktop UI job exposed an unresolved suite-selection/time-budget issue. Both then required isolated investigation; their reviewed repairs are recorded below. This candidate is not yet frozen or accepted as release-ready while the Mac DMG packaging issue and fresh combined gates remain outstanding. No supported-platform runtime policy or timeout was changed, and no CI gate was removed or weakened.

The first production Windows build at d5c903f compiled and signed its NSIS installer, but correctly exited 1 at the final application signature check. Inspection proved that Tauri CLI 2.11.5 had packaged a valid timestamped application and then restored its unsigned working copy, as the upstream bundler specifies. The original logs and byte-verified copies of the root app, helpers and installer remain in ignored evidence; no build receipt was fabricated and nothing was published or installed. Reviewed packet `d90fed5bd0fc21de67424c71c895774af1a4b502` restores the working copy's signature through the existing pinned signer after bundling and before temporary metadata cleanup. Only the normalized NotSigned/untimestamped state is repaired; valid timestamped output is retained, and other states fail. Existing final timestamp, publisher identity, build-info, checksum and source gates remain. Focused regression tests passed 32/32 and registered tooling passed 343/0/0. The next canonical signed build and clean installer verification must prove the root and packaged app, helpers and installer; the old inspection is root-cause evidence, not release certification.

Checkout remains held until signed desktop certification. The website's default account test intentionally asserts that hold, so it cannot also certify a checkout-enabled deployment. Reviewed packets `6869a19aa0a9d91100118e25ca5dcbed5bd5126a` and `648b9626ddd06caa0bce258731b6b564d531179f` add a separate registered enabled-build gate while retaining the default 148 passed/eight reviewed skips. Its three tests cover Free checkout routing, OWNER without billing actions, and unauthenticated denial. The initial HTTPS-only test fence was rejected and superseded: the final fence permits only owned static GET/HEAD requests and explicit API/fake-Stripe fixtures, and denies unexpected requests, including external HTTP and same-origin mutations. The held artifact failed the enabled capability assertion as intended; a fresh enabled artifact passed 3/3 with no skip or flaky result. The full held gate and tooling 342/0/0 passed on that isolated chain. Reviewed workflow packet `45090e2e4cb67c8799cd7f388c4f571151a72ada` adds the enabled gate after the unchanged default website gate. No real payment or billing mutation occurred in these tests.

These reviewed changes are assembled into one new candidate before the next artifact build commit. Before the additional CI investigations, the combined expected Windows JavaScript count is 2,010 (one new signing-policy regression); enabled website E2E adds three separately registered cases. Further regression additions must be reconciled against actual registered results before the candidate is frozen. Actual final counts, hosted CI, complete platform gates and production builds must be recorded against the new immutable commit. The ongoing d5 Mac package is retained as a diagnostic checkpoint/cache, not as a substitute for matching final-source artifacts. The private baseline `063652ffc9eefcf1f6839db4c6d56b29cf281a13` was correctly derived from d5, but must be re-derived from the next final build source before use; it is never a main integration candidate. Publication, final notes, clean-profile product QA, provisioning, update/rollback/re-update, checkout enablement, website/API cutover and live verification remain outstanding. No SHIPPED claim is made.

Reviewed Doctor fixture packet `968cbe968a47fba05aa10f324ad9171e3661e05b` isolates the intentionally empty tool installation from the hosted macOS runner. Only its synthetic HostFacts platform changes to Windows with no environment variables, so fallback installation directories are deterministically absent. The exact `tools.node.missing`, ignore persistence and stale-fix assertions remain. The authoritative hosted failure is retained; focused 1/1, complete Doctor 49/49, strict Doctor Clippy and source/secret checks passed. Parent independently reran all 49 Doctor tests, normalized generated protocol whitespace using the canonical generator, and confirmed a clean exact-source worktree. Production Doctor discovery and path defenses are unchanged. Fresh hosted macOS full-workspace proof remains pending.

Hosted Windows CI then exposed a second Doctor fixture scheduling assumption: the mixed 25 ms plan sometimes classified an uncompleted panic worker as timed out, which is truthful production behavior but contradicted the test's completed-panic expectation. Reviewed packet `1c123d7e70b6cb5908a594210f761a2a020f98a5` splits the original assertions into a bounded two-second completed OK/panic/private-error batch and a separate fresh-context slow-check test retaining the original 25 ms deadline and exact timeout reason. Exact panic/error reasons and private-payload redaction remain; production Runner code and limits are unchanged. The original hosted RED is preserved. Focused runner 5/5, complete Doctor 50/50, strict Clippy and source/secret checks passed; parent independently reran all 50 tests and confirmed clean source after canonical generated-protocol normalization. The split adds one registered Rust test, bringing the next expected full-platform counts to Windows 2,026 and Mac 1,979, with the existing 16 ignores unchanged. Actual final and hosted counts remain mandatory.

The preserved d5 physical Mac package attempt completed its cold application build, then exited 1 during Tauri DMG layout after 43 minutes 57 seconds. The actual bundled app reports version 0.1.5, Stable and testHooks=false; independent deep/strict codesign verification passed with the expected Developer ID team and timestamp. Source stayed exact d5 and clean. A writable temporary DMG exists, but there is no final DMG, notarization submission, staple or Gatekeeper release proof. The exact temporary GUI launcher was removed and app/temp-DMG/cache evidence remains preserved under `target/recovery-20260926/final-mac/d5c903f-package`. The Finder/AppleScript packaging failure is being localized; this diagnostic checkpoint is not a publishable final-source artifact.

Reviewed UI packet `c1645402fe7241b24792a6e263953ba2a8e78c79` fixes a real pane-drag race: a render between pointerdown and the drag threshold copied null render state over the active gesture ref. Removing that render-time assignment preserves the existing explicit start/move/cancel/end ownership. The strengthened existing browser test forces a ResizeObserver render in that interval; the original source fails at the missing drop-zone assertion and the correction passes, including 20 exact focused executions. No product feature or drag threshold changed.

The same packet separates the existing automated UI set into registered functional and visual gates with separate hosted jobs. Exact case-ID comparison proves a disjoint union of 245 functional plus 56 alternate-tag visual cases, equal to the previous 301-case automated set on all platforms. The 22 literal `@screenshots` manual cases retain their existing exclusion; widget 2 and shared primitive 4 remain separate, for the same 307 aggregate automated cases. An initial platform-count assumption was rejected after both hosted logs proved `Running 301 tests`; no unsupported Linux count was accepted. Review also rejected an accidental Rust-profile overlap, which was removed before freezing. Registry validation still requires every existing test/test:e2e script and rejects nonexistent registered scripts; explicitly registered UI scripts must exist. Bounded listing tests enforce the exact partition. Scoped registered results passed functional 245/0/0, visual 56/0/0, widgets 2/2, primitives 4/4 and tooling 344/0/0; types, workflow parsing and secret checks passed. Parent independently reran the strengthened drag test and all 344 tooling tests on the assembled candidate, then Biome CI passed with the same two warnings and one informational finding. This adds one tooling regression, so the expected next Windows JavaScript total is 2,011; actual final results and both hosted UI time budgets remain required.

The physical DMG diagnostic reproduced an exact Finder AppleEvent timeout (-1712) at 120 seconds, not a keychain or signing denial. The pinned Tauri bundler supports unattended DMG creation through CI=true with its override absent. A copied exact signed d5 app successfully produced a read-only compressed image; independent read-only mounting verified the Applications-to-/Applications link, unchanged app/helper bytes, all four arm64 signatures and minimum macOS 14.0. All owned mounts were detached. Reviewed `464601d3bf376377a4689f7156a0af724256e4fd` makes only that canonical child-environment choice and documents the omitted Finder cosmetics; all signing/notary/staple/Gatekeeper gates remain. The inherited-environment regression failed on original code and passed after correction; focused 14/14, registered tooling 344/0/0 and source/secret checks passed. Parent independently reran the 14 contract tests on the combined candidate. No old-source notarization was attempted.

Later hosted native Windows results remain release blockers: original d5 ran 23 cases with 14 passed and nine failed; the 4ff attempt ran 23 with 13 passed and ten failed. Failure evidence includes an assumed installed Claude CLI, truthful Resource Governor admission refusals on the overloaded two-core host, hidden workspace headings, and a folder-picker cancellation busy-state failure. These are under bounded independent localization; no production resource policy, timeout or passing requirement has been weakened. The candidate remains unfrozen until confirmed causes are repaired and the complete exact-source native and other gates pass.

Reviewed responsive-header packet `8bd76e72f0f1d668110dbff83c53a5c6a817dd7d` fixes the two hosted hidden-heading failures. At 1024 by 700 with the expanded rail, the existing Code header actions consumed the available width and collapsed the workspace heading to zero; workspace navigation itself had succeeded. The minimal CSS change allows the header and action group to wrap with bounded width. The strengthened existing narrow-rail test failed on the original zero-width heading, then passed with a visible heading and all controls contained. Functional UI 245/245, visual UI 56/56, widgets 2/2, primitives 4/4, desktop units 894/894, type and source checks passed. Parent independently reran the focused case on combined `7b92c6f`; patch equivalence and independent review passed. No test count, timeout or navigation contract changed. Hosted native fixtures and lifecycle cleanup remain under repair before the candidate can freeze.

Independently reviewed native fixture packet `fa3f0c8d02ad96aaa75298c81f10a5b5628ba10b` is isolated on parent a778d0e with exactly 17 paths. It replaces the hosted installed-CLI assumption with three exact path/version-checked no-network provider fixtures; corrects the folder-picker helper to require an actual Window control and successful WindowPattern close; and gives every one of the 13 launching specs explicit per-test child ownership with bounded teardown and worker-final retry. Ownership begins before the first await, failed cleanup stays registered, already signaled children are terminal, and process cleanup never scans or kills an unowned tree. Review corrected pre-spawn authorization, exit-listener races, timer disposal, unresolved-record retention and Playwright fixture registration before freezing.

Six provider specs explicitly request one fixed resource sample only in cfg(e2e) builds, through the existing attested account data directory and canonical Governor::start_with. Inherited resource fixture environment values are stripped. Invalid opt-ins or unattested roots fail closed; the production build has no resource-fixture environment hook. Engine, capacity, reservations, pressure and provider limits remain authoritative, including tested global and provider-specific denial. This deterministic CI fixture is not physical provider or resource QA.

Scoped immutable evidence passed desktop JavaScript 902/902 across 103 files (894 existing plus eight helper regressions), helper tests 10/10, feature=e2e desktop Rust library 201/201, focused Rust 3/3, and native registration 23 cases across 13 specs. Mandatory production kalvoice-whisper strict Clippy, formatting, TypeScript, scoped Biome, diff and secret checks passed. Parent independently reran helper 10/10 with clean source before and after. The additional optional feature=e2e strict Clippy check exits 101 on three unchanged expect_used findings in account/e2e.rs; it is preserved as failed supplementary evidence, not suppressed or counted as a production gate. Mutation evidence fails on removed ownership, inherited fixture stripping and exit-race protection. Combined responsive-header/native runtime proof remains pending before integration acceptance and final-main gates.

Combined native proof `9923cf795a4c0a27e9bd6467e6a651a6de52f4a5` (fa3 plus the already-reviewed responsive header) now passed a fresh production-Whisper E2E build and registered native suite 23/0/0. Postflight confirms clean exact source, zero owned application processes and no listener on the test port. Parent read the actual exit and cleanup receipts. The initial unnecessary cold build was stopped and preserved as an interrupted diagnostic; the accepted build used the retained warm tree, produced new exact-source bytes, and exited zero. The isolated candidate harvested fa3 as `a288583`; its entire source tree matches the proved combined tree except this recovery ledger. No diagnostic mutation was integrated.

This entry freezes the next combined source for actual-main verification. Expected registered production counts are Windows Rust 2,026 and Mac Rust 1,979, both retaining the 16 existing ignores; Windows JavaScript 2,019, including desktop 902 and tooling 344; website held 148 plus eight reviewed skips and separately enabled 3/0/0; desktop UI functional 245 plus visual 56, widgets 2 and primitives 4. Report actual platform-specific counts rather than infer success from these expectations. Rollback `rollback/main-before-hosted-closeout-20260927` preserves exact d5c903f. Fresh combined hosted CI, full actual-main platform gates, matching signed production artifacts, Apple Accepted notarization/stapling/Gatekeeper, baseline/update/rollback trials, physical product QA, publishing/cutover and public live verification remain mandatory. No final application is published or declared shipped. Final gate receipts stay outside tracked source to preserve the exact tested build commit.


## Final source recovery after hosted 688 gates

The previous exact `688cda68d0523b4ef476d992701bebab33f161dc` local gates passed: Windows production-Whisper Rust 2,026/0/16 across 120 result groups, strict Clippy/format/protocol, fresh native build and native E2E 23/0/0; JavaScript 2,019, held website E2E 148 plus eight reviewed skips, separately enabled checkout 3/0/0, and desktop/UI suites 245+56+2+4 without failures or extra skips. Physical Mac production Rust was 1,979/0/16 across 120 groups, with the real isolated Keychain and pinned Codex checks passed, and headless JavaScript 2,016 plus two existing platform skips. These historical results do not certify the source frozen by this entry. Private remote main remains d5c903f until the new final gates pass.

Hosted failures led to bounded reviewed repairs, preserved in the candidate history rather than replaced or suppressed. Supported-platform cfg guards remove unused Linux updater/benchmark declarations while retaining the portable KalVoice corpus; the unsupported RecoveryLock test helper was unused and removed. A guarded hosted-Ubuntu cleanup reclaims only the documented Android and .NET SDK roots after exact path, link, runner and protected-root checks. Canonical-only execution independently reproduced ENOSPC before that repair. Functional UI retains all tests and per-test limits; its job budget changes from 20 to 30 minutes after reaching 243/245 with no test failure at the old cutoff. One new tooling regression raises the Windows tooling count to 345.

The Windows provider process fixture now uses a controlled process-tree handshake instead of nested shell startup, preserving real descendant/quiescence assertions. Native E2E uses controlled provider versions. A real Windows home-path privacy defect was repaired in native-core: trusted home aliases are redacted without arbitrary input path resolution; partial alias failures, Unicode case/length differences, unsafe parent suffixes and plausible unresolved short aliases have regression coverage. Intermediate repairs rejected by review remain documented outside the release source. The final privacy packet passed native-core 176 tests, strict Clippy, a fresh Whisper native build and all 23 registered native cases. Nine new Windows-only and four portable tests account for its platform count changes.

Linux diagnostic runs exposed resource subscriber fixture races, Unix terminal-process classification, unsupported managed-guardian positive fixtures and writable fake executable aliases. Resource fixtures now register before the first controlled sample; their original overflow/history assertions remain. Unix Zombie/Dead states are recognized only after existing process-identity checks. Windows/macOS guardian success contracts retain their coverage; Linux has explicit fail-closed denial contracts instead. Unix fake aliases are immutable same-filesystem hard links, with a Linux write-open executable control; Windows copy behavior remains unchanged. Windows and physical Mac focused/full subsystem evidence is retained. No test timeout, permission boundary or existing ignore was relaxed.

Repeated complete Linux execution found two production interruption races. Source a73644e captures the committed interrupt/pause response under per-thread authority and resolves display metadata after unlocking; subsequent provider completion may update durable activity without changing the captured response. Follow-up c698362 applies the newer hosted Clippy direct-expression requirement. Source 3313acc binds cancellation to each exact turn and output reader, admits an interrupted turn through the existing bounded cleanup path, and prevents a later interruption from changing an older reader's exit classification. Deterministic original-behavior and overwrite mutations failed as intended; restored Windows providers passed 330/0/9 and physical Mac providers 302/0/9, with strict checks and exact clean source. The canonical Linux rerun then exposed terminal state publication before approval expiry. The reviewed final threads packet expires approvals after live session/routes teardown but before terminal state publication, preserves termination-failure retry authority, and adds a gated two-provider regression. Its observer is one-shot so teardown cannot re-enter a blocking test callback. The production expiry packet is harvested as bcbbf8c and the one-shot test follow-up as 6071d15; their gate receipts are retained externally and excluded from tracked source.

The owner explicitly selected standard-user Mac installation in `~/Applications`. Guidance commits fe89fc6 and c8ca93a explain creating that folder and copying the app explicitly: the DMG's Applications shortcut still targets system `/Applications`, where standard users need administrator-managed manual replacement. There is no elevation service, automatic relocation or permission weakening. Source 83a68ad, harvested as ff3050b, claims the sibling staging directory with exclusive creation before copying and grants cleanup ownership only after success. Only permission/read-only errors receive the actionable install-location diagnostic. Physical UID501 tests passed all four cases, the complete desktop library 183/0 and production-feature strict Clippy. Literal prior precheck behavior failed only the unwritable-folder regression; exact restoration returned four passes. An earlier broader mutation and an initial missing-sidecar setup failure are preserved and excluded from that exact-old proof. The known block 0.1.6 future-compatibility warning remains recorded.

QA schema records remain governed operator attestations. Separate physical receipts must bind actual installed location, bundle/application identity, signature, source artifact and exact staged baseline to update, rollback and re-update outcomes. Neither schema booleans nor package verification alone proves customer-device behavior. Website documentation now distinguishes immutable version proof before W from D1-backed mutable Stable proof after W; B/N/W publication authority and rollback rules remain intact. OWNER, OAuth bindings, account security, billing authority and the local KalVoice architecture are preserved.

The final expected production Rust counts are Windows 2,042 and Mac 1,990, each retaining 16 existing ignores across 120 groups; Linux without production Whisper expects 1,955/0/13 across 120 groups. Windows JavaScript expects 2,020, including desktop 902, website 341, API 284 and tooling 345; Mac expects 2,017 plus two existing platform skips. Website and UI expectations remain as above. Expectations are not passing results. Full local actual-final-main Windows/Mac/non-Rust/native gates and every normal hosted CI job remain mandatory, including Linux canonical tests and generated protocol checks. A separate Linux-only diagnostic rerun is omitted because the exact final-source CI covers that boundary. Diagnostic workflow commits are excluded from the source ancestry. Rollback preserves main 688; untracked marketing and browser traces remain untouched. Gate receipts remain outside tracked source so the tested build identity stays fixed. Signed matching artifacts, Apple Accepted notarization/stapling/Gatekeeper, clean installs, real product and updater trials, publication, cutover and live production verification are still required. No final release is declared shipped by this entry.

The following 15 diagnostic-only commits were individually checked and are not ancestors of the frozen source:

- `a90015d5d40755aacb103b498998c568acd7e1a9`
- `6384f08952ec55fcc645c078cdb396e52e98155b`
- `09ab8bf90dd6534100d1a872e23b6e740086d1df`
- `7f21038456aa90c2674cc9032eb404aa441a6915`
- `bbde6d57a8e596efadfe13ca2b7b7c3e836e6581`
- `34898193306b9a31f0c4c2ad5291885a0f49eee0`
- `9e769b450ad5f41610479c09920b8b2d7cd20a31`
- `ae9f5ff78e7644e57e7a0ec3b488113bfa88dc33`
- `e451b719a1f4e5fdf3ae2037667f818422c542b6`
- `be7e4eb606ad3a6c2e2daf33ba84908b7dd33c3a`
- `038b153710811c653fe0698156c1cc5337ab519c`
- `3f08d6b325d04bbd4cf6583a6de7c777d81db583`
- `5b9454dfeb8d7aa9f607c2f021598ba8acf55cfd`
- `e606e2d7ed7d869413722c688602677d9c7be3f0`
- `d4d495a436e8ec6f9201f8bdd80e6671f6aa3466`

### 2026-09-27 — Final-gate repairs after source 72b2dfb

The exact `72b2dfbaed2e987e88ee88a99dc04ab25a452957` gate was not release-green.
Local Windows production-Whisper Rust passed 2,042 tests with 16 existing ignores,
strict Clippy/format/protocol checks passed, and a fresh native E2E build passed all 23 tests.
The physical Mac headless gate passed 2,017 JavaScript tests with two existing platform skips
and website E2E 148 passed/eight reviewed skips; its GUI Rust gate was still running at this entry.
Hosted run `36330146500` completed seven successful jobs and three failed jobs:
Windows PTY lifecycle (two tests), Linux PTY output replay (one test), and UI dropdown primitives
(two tests). Hosted native E2E 23, functional UI 245, visual UI 56, website, and macOS Rust passed.
Hosted macOS uses the default-feature profile (1,990 passed/15 ignored); this does not replace
the physical production-Whisper profile. Ubuntu protocol verification remained unexecuted after failure.

Three bounded repairs were independently reviewed and harvested in order:

- `d4a8065f35d56eb8ac8404664a90859edbe65ef1` → `8bc7889`: dropdown entrance animation
  now applies only while open, and closed content is hidden independently of animation events.
  Existing action/radio effects, visibility, and focus assertions are unchanged. Browser primitives
  passed 4/4, UI units 68/68, and post-integration browser reproof passed 4/4. Hosted failure logs
  remain the original regression evidence; final hosted reproof is mandatory.
- `434bd109aa7649a6acec77bfba2c6575ba71c604` → `f25870f`: test-only PTY fixture repair.
  The unattached-startup test now waits up to five seconds for reader delivery after its unchanged
  15-second exit wait. Windows lifecycle fixtures use the existing exact test executable, live-child
  verification, and atomic PID publication instead of PowerShell startup. Production PTY/JobObject
  behavior is unchanged. Three focused tests passed ten times each; package 34/34, strict Clippy,
  and formatting passed. Disabling quiescence made both lifecycle assertions fail on a live child;
  production bytes were restored and the package passed again, including independent parent reproof.
- `8be3ddfe1d89f55e4e71bb932b823aeb7bccd7ee` → `976881d`: pane drag hit testing reads current
  controller/layout and live canvas dimensions after resize, with current controller use on drop.
  The strengthened reachable two-axis resize regression failed with the old captured geometry
  (`center` instead of `bottom`). An initial repair typo was separately preserved and corrected.
  Final proof: focused 20/20 plus independent 1/1, desktop units 902/902, functional UI 245/245,
  visual UI 56/56, widgets 2/2, primitives 4/4, typecheck and Biome; no flaky result was accepted.

All three packets received immutable-commit review and canonical secret scanning. No suite was removed,
no production timeout increased, and no new product scope or credential change was introduced.
Rollback reference `rollback/main-before-final-gate-repairs-20260927` preserves exact 72b2dfb.
Evidence is retained under `target/recovery-20260927-final-B-hosted-ci`,
`target/recovery-20260927-dropdown-presence`, `target/recovery-20260927-linux-pty-output-drain`,
and `target/recovery-20260927-pane-drag-geometry`.
The next frozen main commit still requires complete integrated gates, private main push, matching
production builds/signatures, Apple Accepted/staple/Gatekeeper proof, physical clean-install/product
and update/rollback trials, publication, website cutover, and live verification. Nothing is SHIPPED.

### 2026-09-27 — Final shortcut repair and release source freeze

Source 47ac59c completed Windows production-Whisper Rust 2042 passed/16 existing ignores,
strict Clippy/format/protocol, JavaScript 2020 passed, website 148 passed/8 reviewed skips,
and physical Mac Rust 1990 passed/16 existing ignores plus real GUI Keychain and pinned
Codex isolation checks. Mac JavaScript 2017 passed/2 existing skips and website 148/8 passed.
Hosted run 36332602930 passed all three Rust platforms, Ubuntu protocol, dependency/security,
format/type/unit and website jobs. Its functional and visual failures were the same rail shortcut defect.
Windows native reproof passed 23/23 with the identical binary after the prior cookie-request timing
occurrence failed to reproduce in the focused case and ten lifecycle/cookie cases. The original
failure remains preserved; no Browser production repair or timeout relaxation is claimed.

Immutable eebd5efd9aaf5743392a458c1eb849b0531f5167 was independently reviewed and harvested
as 1452268. Both rail More-actions triggers now allow canonical global shortcut chords to bubble;
ordinary tree keys retain propagation isolation. Instrumented key capture/bubble evidence proved
the original Ctrl+K was swallowed after menu focus restoration. Three exact files changed.
Focused functional 2/2, affected pane/visual selection 49/49, full functional 245/245,
shortcut units 3/3, typecheck, Biome and canonical secret scan passed. No test was removed.
The redundant visual run was canceled under the owner's closeout override and is not claimed green.

Evidence: target/recovery-20260927-rail-menu-readiness,
target/recovery-20260927-final-47ac59c-native-reproof,
target/recovery-20260927-final-mac/47ac59c, and target/recovery-20260927-final-47ac-hosted-ci.
The only change after those platform/backend gates is RailTree shortcut propagation and its two UI
regressions, plus this ledger. Unaffected green gates carry forward under explicit owner instruction;
focused final-main shortcut proof binds the integrated source. Existing rollback references remain.
Production build/signing, notarization/stapling, physical install/update/rollback, installed KalVoice,
Stable publication, website cutover and live verification remain required. Nothing is SHIPPED.
### 2026-09-27 — Physical closeout failures and bounded repairs

The 7afdfec source was pushed to the private remote. Both Windows candidate 0.1.5 and private
0.1.4 baseline were built, timestamp-signed, and independently verified for the installer,
application, guardian and both updater signatures. They remain preserved diagnostic artifacts.
They were not published to Stable and do not substitute for rebuilt repaired-source artifacts.

The owner installed 0.1.5 as the standard Windows user, closed the window with X, and initially
could not reopen it. A process remained briefly; the subsequent redacted profile diagnostic
found no process and no recorded shutdown-failure events, and a later launch succeeded.
Thus a permanent cleanup failure is not proven. The concrete lifecycle defect is that the main
window could be destroyed before bounded ExitRequested cleanup finished, leaving no window for
the single-instance callback during that interval. Reviewed edbfd91 was harvested as f47d193:
main close now prevents destruction and invokes the existing bounded exit authority. Duplicate
requests still coalesce; retry after cleanup denial, ready exit and child-window semantics remain.
RED1, focused3, desktop production-Whisper lib193, strict Clippy, format and secret scan passed.
Fresh integrated native execution and physical X/relaunch remain required.

Physical macOS packaging successfully produced the signed DMG, then failed because Tauri had
removed its temporary bundle/macos/KalCode.app. Reviewed d1fc528+b50c24b were harvested as
d2027be+edad5a7. Evidence now comes from the exact staged DMG, mounted read-only: contained
plain app/helpers, architectures, production signatures, team/identifiers/runtime/timestamps,
actual helper digests, build-info and the exact Applications link are checked. Bounded detach
must succeed before workspace removal. Canonical candidate verification independently remounts
and rechecks the completed record. No pre-bundle helper hash assumption remains. Contract
RED14/1 then GREEN15/0, related37/0 and Biome passed. Two incidental full-tooling failures came
from absent dependencies in the new worktree; after frozen offline install those exact two
checks passed. No broad rerun or source workaround was used. Actual repaired packaging remains
required. Nothing was submitted to Apple or published from the failed package attempt.

Correction to the previous hosted summary: run36332602930 also completed native22/23; provider
pane creation remained pending after admission/click. Both local full native runs passed that
case, including unchanged-binary23/23 reproof. Bounded triage found no actionable source defect;
the original RED trace remains preserved, with no timeout/retry changes or claimed hosted pass.
The automatic push run36335326373 assigned no runners and executed zero steps because GitHub
billing/spending admission rejected it. It supplies no test result.

The owner reports a blank browser tab at Google's correct authorization host during installed
OAuth QA. Native URL validation/opener navigation succeeded; no callback or credential defect
is yet proven. Browser/profile isolation is pending. No URL query, credentials or account data
are included in this ledger. Web OAuth/OWNER proofs remain valid; installed handoff is pending.
Evidence: target/recovery-20260927-macos-package-success, the Windows worker's lifecycle packet,
target/recovery-20260927-windows-production-7afdfec and the separate redacted owner diagnostic.
Unchanged prior gates carry forward; affected app/native and packaging gates bind the next main.

### Physical closeout repairs and disk preservation, 2026-09-27

Exact fc3669a passed the affected Windows desktop production-Whisper library gate (193),
strict Clippy/format, and fresh native desktop gate (23 executed, zero failures/skips).
The physical Mac passed its affected desktop library gate (186), strict Clippy/format,
and packaging contracts (37). Unchanged earlier gates carry forward. Private main was
pushed to fc3669a and its exact remote identity was read back.

Emergency cleanup removed only 71 ignored Cargo debug incremental directories. The
59 owning worktrees retained identical HEAD/status during cleanup, including unique
and uncommitted work. Actual free space rose from 42.99 GiB to 324.39 GiB (281.40 GiB
recovered). Source, release caches, signed candidate/baseline installers, evidence,
and credentials were preserved. The separate cleanup plan, removal receipts and
independent preservation review remain under target/recovery-20260927-*.

The owner installed the signed fc3669a Windows candidate and reported three successful
X-close/reopen cycles. This proves the reported regression check, not a clean install:
kalcodeqa already contained earlier candidate data. It remains preserved. The owner
prepared fresh standard Windows kalcodeqa3 for the final direct candidate install;
untouched kalcodeqa2 remains the baseline/update/rollback profile. Mac kalcodeqa and
kalcodeqa2 retain their original distinct candidate/baseline roles.

The installed Google retry still left Chrome blank and the app waiting for its browser.
A bounded redacted trace observed the Google callback returning HTTP 302 successfully.
Reviewed 2f99972 replaces only desktop Google/Microsoft callbacks with an explicit
Open KalCode browser handoff. Existing state, provider, expiry, nonce, PKCE and atomic
completion checks remain; website callbacks retain their original 302 fragment flow.
The page has no storage or external resources, no premature success claim, strict CSP,
no-store/no-referrer headers, an escaped fixed-protocol link, and a hash-bound static
script removing the callback query from browser history. RED was expected 200 versus
actual 302; focused 14, complete API 284, typecheck, Biome, dry-run and local Chromium
render/history/link proof passed. The four production OIDC bindings were confirmed as
encrypted secrets without reading their values. Production deployment/retry is pending.

Actual fc3669a Mac packaging exposed a second concrete bundler mismatch: pinned Tauri
re-signed the three helpers with basename identifiers and the app microphone entitlement.
Reviewed fe008dc preserves the exact original DMG, verifies that pinned input shape,
copies into an owned workspace, restores canonical helper identifiers with zero helper
entitlements, re-signs the app with its sole approved audio-input grant, and rebuilds
and verifies the DMG before staging it. Failed detach retains the workspace. Exact
staged bytes remain the evidence authority. Contract RED was 15/1; related tests 38/0,
Biome and secret scan passed. Physical scratch correction passed signatures, entitlements,
architectures, layout and production build-info; strict helper entitlement probes returned
exit zero and empty output for all three helpers. The actual final canonical package,
Accepted notarization, staple and Gatekeeper checks remain mandatory.

Both repairs received hash-bound independent approval. The next integrated main needs
the affected API and packaging gates, private push, and matching final platform builds.
No Stable artifacts/feed or production download cutover is authorized by these partial
physical receipts alone. Clean installs, real update/rollback/re-update, installed OAuth,
KalVoice/provider/browser QA and final live publication verification remain outstanding.

## Desktop automatic OAuth return repair � 2026-09-27

The owner rejected the manual-first desktop return page after browser authentication.
API packet ef66f6e (including 22d9c3e) supersedes that page with one automatic canonical
kalcode:// invocation after DOM readiness and a secondary fallback after 1.5 seconds.
No-script fallback, query removal, strict static-hash CSP, no-store/no-referrer and
escaped fixed-protocol values remain. The page says "Opening KalCode" for success,
cancellation and failure; navigation is not treated as proof of authentication.
Explicit desktop start requests opt into provider-native select_account. Legacy
one-key desktop requests preserve their old authorization URL contract; website
requests retain the website callback and never launch the app. Focused API 26/26,
full API 286/286, typecheck, Biome, dry-run and exact-response Chromium checks passed.

Native packet e836817 sends the explicit desktop client and strictly validates the
single account-selection prompt alongside existing OAuth parameters. Admitted warm
callbacks reuse the canonical independent unminimize/show/focus attempts. A bounded
cold-start regression exposed a genuine self-deadlock: a temporary pending-state
mutex guard survived into a branch that reacquired the same lock. The minimal scoped
clone fixes that lifetime and proves saved provider/state/PKCE/nonce completion after
bootstrap. One-use account authority remains responsible for queued duplicates.
Focused regressions, 197 desktop production-Whisper tests, strict Clippy and fmt passed.

Windows verifier packet 64440dc measures actual per-user protocol registration in
all three temporary install/upgrade passes and checks uninstall removal. It preserves
any pre-existing handler through preflight refusal and requires the exact quoted
installed executable and quoted URL argument. Adjacent release tests passed 18/18.
This is registration evidence tooling, not proof of signed OS activation.

All source packets receive immutable independent review before integration. Actual
final-main affected gates, matching signed artifacts and physical warm/cold/minimized
OAuth completion remain mandatory. Windows kalcodeqa3 is still reserved for the final
clean install, kalcodeqa2 for baseline update/rollback; prior profiles and all artifacts
are preserved. The in-progress abd6 Mac notarization may finish as preserved evidence,
but it cannot substitute for the new native source artifact. No Stable publication or
SHIPPED claim follows from these offline checks.

## Installed OAuth code and session restoration repair — 2026-09-27

The signed a1087d9 Windows candidate was installed in the clean standard-user
kalcodeqa3 profile. Its browser callback succeeded, but the desktop remained at
VERIFY. A bounded owner-run diagnostic confirmed the expected quoted per-user and
effective protocol handler, installed executable, valid Authenticode signature,
and one native social_callback_rejected event. The safe API trace showed the
callback but no session-completion request. No raw logs or callback URLs were
collected. The diagnostic's original binary-match field compared against the
build-tree executable instead of the signed installer's embedded executable; that
field is excluded from conclusions and its expected value was corrected.

Native repair 9c14ae5 aligns authorization-code parsing with the existing API's
visible-ASCII length-1-through-2048 contract. Google's percent-encoded slash was
previously rejected after decoding. Provider, state, nonce, PKCE, duplicate-field,
URI shape, expiry and one-use session checks remain unchanged. The old predicate
fails the realistic synthetic code regression. The corrected full desktop suite
passes 198 tests; strict Clippy, formatting and secret scan pass. A native runtime
regression exercises callback parsing, exact completion arguments, signed OWNER
entitlement, Ready authority, persisted session, cleared pending attempt and cold
session restoration. Its API/store adapters are deterministic test fixtures;
actual installed production OAuth remains a mandatory separate proof.

A separate frontend regression reproduced an initial bootstrapping snapshot never
being replaced after the native authority finished restoration. The repair observes
account status as well as runtime status until bootstrap resolves, within the
existing bounded polling window. Generation fencing prevents late restoration from
resurrecting a logged-out account. A failed restoration exposes a recoverable error
rather than treating a spinner as account authority.

The a1087d9 Mac checkpoint completed Developer ID signing, Apple Accepted submission
49ed6e79-b53d-41da-bc09-958687862fdb with an issue-free log, stapling and Gatekeeper
assessment. It is preserved evidence and must be replaced with the repaired source
before final physical certification. All earlier installers, QA profiles, baseline
artifacts and release evidence remain preserved. No Stable publication is claimed.
Frontend packet ebb1579 adds seven tests (five provider, one IPC/gate integration, one retry/accessibility); focused 20/20 and full desktop JavaScript 909/909 across 103 files pass, with typecheck and scoped Biome clean. The first full run exposed an existing assertion that waited for the phase element rather than its ready content; waitFor now checks the intended ready state without relaxing that requirement. The existing nonfatal jsdom canvas warning remains. Final-main affected gates and installed OAuth/OWNER/cold-restart proof remain required before publication.
