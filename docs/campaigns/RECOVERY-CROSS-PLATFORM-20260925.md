# Recovery and cross-platform continuation ? 2026-09-25

## Preserved authority

- Main/local and remote starting commit: `ad4d073faea0a4800fbdd027b8f2fee87ff43752`.
- Active desktop integration: `sec/providers-harden`, HEAD `35c99cb43699813c8aba58e1fead6a5cd536076b`, with preserved uncommitted work.
- Staged historical harvest: `integrate/staged-20260925`, HEAD `63d2071122e9848a5815fe7a63b76dfd88e50abe`. Do not merge wholesale: portions predate main and canonical security repairs.
- Root main's partial Cargo/utility files remain preserved. No reset, stash, cleanup, merge, commit, or push in this continuation yet.
- Current owner-approved concurrency: up to 15 subagents across the whole tree, with two integrators. Primary owns canonical shared files/final integration; Mac integrator owns isolated `integrate/macos-20260925` and the physical Mac checkout.

## Fresh recovery evidence

- Recovered all 42 registered worktrees and their dirty inventories; previous agents were unavailable, four read-only recovery specialists started, then assigned disjoint confirmed repairs and macOS work.
- Main remote ref equals local main. No existing cargo/rustc build was active at initial recovery.
- Public home/pricing/account/updates/download HEAD and entitlement public-key endpoint returned 200. Public release manifest remains unsigned preview `0.1.1`.
- Installed local desktop is unsigned `0.1.5`; desktop and Start-menu shortcuts point at that executable. These observations do not certify a release.
- JavaScript registered workspace run: tooling 99, protocol 56, testing 24, UI 27, API 221, desktop 493, website 299; all passed, command exit 0. Logs: ignored `target/recovery-js-tests.log`.
- Fresh guardian contract 6 and supervisor 8 passed; desktop standalone 493 passed.
- First Rust workspace run failed to compile the Utility migration test: a Migration struct was compared to SQL text. Corrected the assertion to `.sql`; focused migration tests 2/2 passed.
- Second Rust workspace run reached desktop tests: 119 passed, 1 failed in concurrent provider-auth shutdown. Repair assigned to account workstream; no full-suite green claim.
- Reconciled 12 individually reviewed website/API paths from current main into canonical desktop worktree. Preserved prior bytes in ignored `target/recovery-pre-main-reconcile`. This retains the deployed API domain, D1 parser-compatible migration, immutable-version conflict trigger and explicit release-catalog activation gate. Website reproof: 302/302, exit 0 (three previously absent main regression tests restored).

## Integration now in progress

- Utility adapter previously existed but was not compiled or reachable. Added 28 registered commands, main capability grants, RuntimeBundle construction/drain/service and existing feature-gated pane mount. Source registration regression first failed, then passed (4/4 ownership checks); capability audit passed 189 commands plus one debug/E2E hook; desktop typecheck passed. Native compile exposed three preserved integration gaps; constructor dependencies are being reconciled. Utility is not READY/LIVE.
- Guardian child inherited desktop environment. Specialist reproduced with a synthetic sentinel, corrected isolated environment handling and reported focused reproof. Lead independent final reproof pending.
- Managed-profile Windows lock namespace protection is being repaired in its exclusive leaf scope.
- Existing main clippy error in UTF-16 decoding corrected to fixed-size array chunks; semantics unchanged; current clippy reproof pending.

## macOS authorization and gates

Owner added production macOS to the SAME source tree, account, subscription, design system and updater. Windows work continues. The initial access blocker is superseded: agent-backed SSH was verified without reading any private key. Physical probes show Apple M1, 8 CPU/8 GPU cores, arm64, 16 GiB RAM, macOS 26.2 (25C56), about 1.6 TiB free, CLT/clang17. Full Xcode and Developer ID identities are absent. No Mac download is available.

Independent Mac packaging/bootstrap audit and implementation is assigned to the release workstream. Native platform census covers guardian/PTY/process, profile authority, files/Git/resources; lead also inspected audio, Keychain, component manifests and browser. Known release blockers include non-Windows guardian fail-closed paths, Windows-only update installer, WKWebView focus/profile parity, real mic/shortcut/sleep-wake proof, signed local-model distribution and Apple/physical-device certification. Existing shared Keychain and macOS audio code is implementation, not real-device proof.

Current official references: Tauri platform config and macOS application bundle docs; Apple notarization and Developer ID docs. Production requires Developer ID/hardened runtime, accepted notary log, stapled ticket, Gatekeeper and physical installation QA; never ad-hoc or bypass instructions.

## Effects and release truth

This continuation has made no production mutations, sent no messages, created no charges/subscriptions, made no paid-provider calls, migrated no production stores, modified no owner memory, imported no archives, staged no private files and published no artifacts. Read-only public/hosting/signing metadata probes are distinguished from deployment. No new product has shipped.

Rollback: preserve all worktrees. Reconciliation prior bytes are retained; integration edits require path-scoped forward repair. Existing production source/tag and immutable artifacts remain unchanged. Do not reset main or erase subsequent work. Final requirement matrix and platform certification remain open.

## Subsequent verified increments

- Mac: intermittent sleep/network timeouts were reported to owner; a bounded caffeinated session established `~/Developer/KalCode` at main `ad4d073` via source-only Git bundle because Mac GitHub auth was unavailable. Origin remains the private canonical GitHub URL. Installed user-local Node24.21, pnpm10.33.2, Rust1.98.1/arm64; no sudo/Homebrew/system setting changes. The 14-file release/bootstrap overlay is not the full desktop candidate; native app build awaits dependency-closed source snapshot.
- Physical Mac audio module: isolated native arm64 compile and eight synthetic tests pass. No microphone was opened or audio recorded; real prompt/capture/STT/sleep-wake remain NOT_PROBED.
- Mac package/verification packet: initial Windows12/12 tests passed independently; Mac integrator reports native16/16 after channel and cleanup regressions. No signed artifact or notarization exists. Failed DMG detach retains its mount workspace; signing verification is not physical feature QA.
- Provider authentication: concurrent cleanup identity repair reported7/7 tests including original failure. Managed Windows profile-lock repair reported11/11. Guardian cleared-environment contract6/supervisor8 pass. Fresh full workspace reproof remains pending.
- Utility: runtime command registration and pane integration compile. Visibility now requires Available as well as visible (RED/GREEN gate). SQLite hardlink repair13/13; HTTP22/22; exact durable DNS approval precedes lookup and a separate resolved request approval precedes send. Resolver workers are bounded and owned through shutdown. Windows blocking DNS cannot be forcibly canceled; unfinished workers report unclean.
- Resource Governor: atomic total/provider launch reservations and retained session lifecycle tests16/16, resources admission11/11. Lead wired wrapper inside AccountBoundProvider and outside observed adapters, passing the same runtime governor. Registration regression5/5; native post-integration proof pending.
- UI: platform keyboard packet focused15/15; full desktop509/509 at that checkpoint. Lead added DNS approval display regression30/30 and desktop typecheck passed. Later concurrent account/voice changes require final rerun.
- Website E2E: reviewer traced cold-render focus failure to content-visibility timing; test now scrolls and verifies focus before existing keyboard assertions. Reported full145 pass/8 existing conditional skips/0 fail, unchanged153 registrations. Independent final reproof remains pending.
- Updater: v2 schema adds explicit platform-bound artifact integrity. Lead producer tests14/14; v1 Windows behavior retained. Mac feed requires exact signing/notary/Gatekeeper, channel and physical QA evidence and never invents platform parity. Signer worker tests Rust7/JS10 reported; no product key/signing operations. Native updater and website consumer integration continue.
- Windows disk free fell to about6 GiB. Inactive root incremental cache measured43.58 GiB; attempted path-checked cleanup was rejected by execution policy. Nothing was deleted. Builds remain bounded; do not erase source/evidence/artifacts to recover space.

Active remaining work includes real Mac guardian/PTY implementation and proof, full-source Mac build, native UI/Browser/Keychain/mic/auth/update QA, consumer KalVoice provisioning, Google/Microsoft auth integration, complete Windows test/E2E/security gates, signed releases and production deployment. No completion or shipping claim is warranted.

## Native build recovery and current proof

- Disk exhaustion is resolved. Purpose-built Cargo package cleanup removed only old root desktop dev outputs; the owner subsequently removed only root `target/debug/incremental`. Latest bounded probe: 32.96 GB free after rebuilding. Source, release artifacts, worktrees and unrelated terminals are preserved.
- Registered JavaScript workspace run `pnpm -r --if-present test` exited 0: tooling123, protocol56, testing24, UI27, API245, desktop517, website312 = 1,304 passes. Subsequent website stable-channel regression raises its focused full result to313. These are checkpoints, not final frozen-source certification.
- Rust workspace run3 compiled desktop and passed its144 tests, then failed Doctor service's obsolete missing-schema fixture. Doctor now tests a database explicitly ending before registered v16, preserving its fail-closed requirement. Worker reported47/47 Doctor tests; lead started full workspace reproof4.
- Capability audit passes190 registered commands plus one debug/E2E-only hook. Google/Microsoft native handoff is registered through a bounded native callback queue and existing account mutation authority; production OAuth is still unconfigured and no real login has been claimed.
- Physical M1 received the audited source-only snapshot with matching archive inventory/per-file hashes. Private origin remains canonical; no credentials were copied. Shared desktop tests510 and typecheck passed. Native guardian unsupported contracts now compile and reject execution explicitly; real Mac guardian remains incomplete.
- Physical M1 PTY tests21/21 pass. Latest KalVoice native library192 pass/1 pinned-archive test intentionally ignored, with no microphone opened. Windows pinned local Q8 reasoning benchmark65/65 exact, zero unsafe actions; this does not substitute for desktop provisioning/integration.
- Windows browser close tests now exercise the actual page-lease-aware production helpers instead of unused duplicate helpers. Approval expiry comparisons retain identical inclusive bounds while satisfying current clippy.
- Update signatures now bind target AND channel in canonical five-field trusted comments. Producer tests16/16, Worker parser19/19; Stable rejects prerelease versions. No stable feed or signed production platform artifact has been published.

Current primary HEAD remains35c99cb43699813c8aba58e1fead6a5cd536076b on sec/providers-harden; main remainsad4d073faea0a4800fbdd027b8f2fee87ff43752. No staging, commits, main integration, production store mutations or publication occurred in these increments.

## Current integration checkpoint (later same recovery)

- Latest registered JavaScript workspace run exited0 with1,344 passes: tooling146, protocol56, testing24, UI27, API245, desktop523, website323. A newer runtime-ownership assertion now passes7/7; later component work will require another frozen-source pass.
- Full Rust run4 passed earlier packages then caught a UTC-boundary Locator fixture defect. It now uses one fixed clock and exact expected results; Locator36 unit+16 integration+6 rail/home pass. The complete Rust suite has NOT yet passed this recovery.
- First physical M1 real `KalCode.app` bundle built with local Whisper and nested arm64 updater helper. This is development/testHooks=true, ad-hoc/no Developer ID and not production-signature verified. No installation/notarization/production readiness claim.
- Mac updater core29/29, desktop updater8/8 and helper compile pass. Windows E2E current-source build passes; native E2E execution remains under investigation.
- Release publisher full suite125/125 passes after aggregate platform continuity, CAS concurrency and preview-channel isolation fixes. Windows emits separate legacy and target/channel-bound signatures. No actual product signing/publication occurred.
- Website Mac route and honest platform UI pass323 tests, download E2E4/4, typecheck/build. Current public preview still has no Mac artifact; no fabricated download was added.
- Context schema18 is now registered locally; v17 upgrade/backup/reopen and backward-clock recovery pass. Actual desktop startup calls the reconciler before exposing core. New file-backed desktop startup tests2/2 pass (first recovery1, second0, blocked/no replay, missing schema fails). Features remain gated pending independent privacy review.
- Independent review confirmed forbidden raw-source hash persistence in Context metadata/logs; exact repair is assigned and must pass before activation. No production database was opened or changed.
- KalVoice cancellation now retains and joins bounded inference custody, permanently seals admission on shutdown, and propagates failure to settle through desktop shutdown. Orchestrator34/34 and worker9/9 reported; primary registration7/7 passes. New signed-component catalog, secure signing/curation, existing-domain component hosting, resource admission and desktop provisioning are still active implementation scopes.
- Component revision identity now compares all signed fields. Primary regression first failed then component-manifest11/11 passed; trust/time changes require a new sequence. Upstream runtime ZIPs remain unfit for production until required OS signing/verification is completed.

No commit, main integration, push, production migration, release publication, paid-provider call, owner-memory mutation, archive import or production deployment occurred at this checkpoint. All development/test stores are isolated. Root main and its dirty work remain preserved.

## Resumed integration after owner disk recovery

- Owner recovered Windows disk capacity; direct C: probe reports184.73 GiB free. No additional owner deletion needed now.
- Root reproduced terminal epoch owner retention after logout (focused regression failed), then releases Core guardian reference only after verified terminal exit and persistence while admission remains sealed/sticky. Whole workspaces_and_terminals suite22/22 passes. Native relogin E2E remains required.
- E2E synthetic account seeder now called only in attested e2e build startup; production account policy unchanged.
- Prompt-review commands registered in canonical handler/registry/main capability; generated DTO exports added. Capability audit192 commands+1 testhook passes; runtime ownership7/7 passes.
- Five new component release test files registered in tooling test script. Independent signer review found publisher snapshot basename incompatibility with real manifest verifier; correction and real-signer regression assigned. No real signing authority initialized yet.
- Physical M1 worker reports214 KalVoice library passes/1 intentional ignore and two CPU-baseline65-case runs64 exact/0 unsafe, p95489/492ms. These are DEV runtime tests, not microphone or signed production proof.
- Mac guardian live integration exposed Darwin AF_UNIX timeout EINVAL and PTY failure; repair remains active. No production readiness claim.
- Current canonical HEAD remains35c99cb; source unstaged, main/origin preserved; no release publication or deployment.

## Integration and independent-review follow-up

- Registered JS run completed exit0: tooling172+protocol56+testing24+UI27+API245+desktop535+website332 =1391 passes. Later cancellation and Dashboard regressions require another final run. Cargo-deny fresh explicit native exit0: advisories/bans/licenses/sources all OK under existing documented policy.
- Prompt warning cancellation capacity defect confirmed by independent review; exact one-shot backend cancellation and main-Webview IPC plus frontend cancellation on all abandoned reviews implemented. Root registered command and capability; audit193 commands+1hook. Frontend full536 reported, backend proving slot pending.
- Dashboard resource-generation repair harvested from prior verified work after6-failure RED. Root reviewed actual hook and independently reran8/8 regressions; worker Dashboard112/112 and typecheck pass.
- Component signing key initialized using freshly locked-built standalone signer into purpose-separated current-user DPAPI custody outside Git. Only strict-schema public JSON exported to tooling/release/component-public-key.json and readback verified. New desktop verifier embeds this exact document and only kalcoded.com. No artifact signing/publication yet.
- Real-signer publisher regression found/fixed temp basename mismatch, then production catalog gate strengthened to all5 existing speech models+default. A stale ignored signer binary path was also fixed by mandatory locked build before invocation. Independent notice review found pinned Whisper README hash mismatch and absence of full license delivery; exact license correction/bundle ongoing.
- Physical M1 reports guardian18 library+3 actualintegration andPTY21 tests passed after Darwin timeout repair, and root terminal logout suite22/22 passed. Packet remains isolated pending independent adversarial review and complete helper packaging.
- Coverage audit found missing Review Center/Compare Run, inconsistent legacy feature flags, and absent Stable-specific native proof. Canonical architecture extensions and explicit suite inventory are assigned; no false release completion.
