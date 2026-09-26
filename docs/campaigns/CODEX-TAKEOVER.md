# KalCode takeover — 2026-09-25

## Authority and release hold

Starting integration commit: `3ca2eb507c7f80010ce651b264021674916d9a30` on `main`.
Security integration worktree: `.worktrees/sec-harden`, branch `sec/providers-harden`.
Rollback checkpoint: `takeover-20260925-before-hardening`.

The owner explicitly requires security hardening before new features, installation,
publication, or deployment. No private private personal assistant project is in scope. Provider inference,
account changes, production stores and credentials are not needed for certification.

## Recovered Git state

- Main was clean. No stashes were present.
- All 31 linked worktrees were inspected with `git status --short` and ancestry counts.
- All branch tips except `p2/utility-dock` were already ancestors of main.
- `p2/utility-dock` contains one unique commit, `a957a3e`, with native utilities,
  IPC and KalVoice integration. It is preserved, pending completeness/security review.
- `.worktrees/env-doctor` at `943b001` contains modified contracts, permission
  classification/service/tests and untracked `crates/doctor`. Preserve these edits.
- `sec/providers-harden` is clean at the starting integration commit. Its reflog
  records branch creation only; no partial hardening implementation was recovered there.

## Takeover map

| Classification | Recovered area | Evidence / next gate |
| --- | --- | --- |
| COMPLETE at campaign scope, historical verification | Foundation, terminal/workspace runtime, thread runtime, permissions, dashboard, pane canvas, rail/home, provider panes | Z0–Z7 campaign records and merged ancestry; fresh integration baseline running |
| PARTIAL | KalVoice, Git core, Context/Firewall, Resource Governor, provider health | Implementations exist; distinguish library completion from remaining integration and release gates |
| NEEDS INTEGRATION / REVIEW | Utility Dock | `a957a3e`; must retain newer provider changes when merging |
| PARTIAL / NEEDS REVIEW | Environment Doctor | Uncommitted work in its existing worktree |
| BLOCKED for release | Current provider integration | Owner's six security findings below |
| NOT STARTED or partial contracts, pending detailed census | Remaining advanced roadmap and gated Agents/Missions/Automations/Skills/Plugins/Memory/Command Center | Compare current code with ADVANCED plan; do not infer completion from contracts or documents |

The local 0.1.5 installer build record identifies `363d5a0` and includes
`kalvoice-whisper`; documentation claiming the installer omits speech is stale.
The checked-in website release manifest identifies 0.1.1. Neither artifact proves
current main safe to install or publish.

## Security repair order and ownership

The owner's updated concurrency limit is one lead plus at most two active subagents.
The active isolated scopes are locator privacy and hook hardening; the lead owns
provider launch policy, integration, testing and commits. Earlier audit agents are stopped.

1. Reproduce and repair locator privacy: immediate opt-out purge, workspace deletion,
   stale indexing races and restart persistence. Ownership: `crates/locator`.
2. Reproduce provider launch weaknesses: Gemini Plan self-escalation, repository config,
   connected Codex tools, and interactive/headless policy parity. Ownership to be assigned
   after supported CLI controls are verified; no guessed flags.
3. Authenticate and bound hook records, including provider/session binding, replay,
   payload validation and resource limits. Review the existing HMAC protocol first.
4. Run focused regressions, complete checks, isolated real-app tests, then independent
   adversarial review. Repair confirmed findings and repeat affected gates.
5. Only the lead stages explicit reviewed paths, commits, integrates and assesses release.
   Resume the preserved Utility Dock/Doctor work and remaining roadmap after security gates.

## Verification ledger

Fresh baseline `pnpm check` on unchanged main exited 0: format, lint, typecheck,
JS/Rust tests, branding, capability grants, zero-cost and release manifest checks passed.
JS tests: protocol 56, testing 24, UI primitives 26, API 119, desktop 332, website 239;
tooling 18. Existing explicit provider-quota and release-performance ignores remain.

Security regression `terminal_control_sequences_cannot_forge_canonical_provider_status`
failed on the inherited code with a forged `WaitingForUser` event, then passed after
removing OSC 9's authority to change canonical thread status. This is focused proof,
not completed hardening certification.

An isolated, synthetic Codex 0.155.1 configuration probe showed that
`-c mcp_servers={}` does NOT clear an existing server map: the synthetic server
remained enabled in `codex mcp list --json`. Do not use an empty map as a deny control.
The probe used a temporary CODEX_HOME containing only test configuration, no credentials,
and started no provider inference or MCP server.

No installation, publication or deployment has occurred during takeover.

### Independent review and provider isolation decision

Locator initially passed 55 tests, including atomic opt-out and stale-worker tests.
Independent review identified an additional visibility window: a search after workspace
deletion could return old rows before the queued cleanup ran. Repair now also covers
authoritative workspace validation in search/open, with a blocked-worker regression.
Canonical thread history remains untouched, as required by migration 0003.

Hook repair initially passed 40 hook-bridge tests and 17 session tests. Independent review
found a session-exit/approval-insertion race, an unbound registration API, and acceptance
of semantically empty Codex notifications. These are undergoing regression-first repair.
Session-key authentication cannot distinguish the legitimate helper from a child inheriting
that same key; channel, identity, resource bounds and policy routing remain essential.

The installed Codex 0.155.1 native terminal has no supported user-config isolation flag.
Headless `--ignore-user-config` exists, but does not suppress every managed/system source.
Empty MCP maps, profiles over inherited configuration, and enumerate/disable approaches
do not establish the required authority boundary.

The owner selected **KalCode-managed provider profiles with separate supported sign-in**.
Preserve the existing standalone CLI setup; do not copy/link/read authentication files.
This is a security prerequisite, not permission to relax the Trust Kernel.

A temporary Gemini system-settings overlay was rejected after testing the actual published
0.61.0 package. Its loader skips user-owned system files as insecure, and its local `admin`
settings are replaced by remote-admin defaults. A synthetic hostile workspace retained its
mutating tool list in the real loader despite the proposed floor. The experiment was removed
from the source tree; its source and failing offline probe remain in ignored `target` evidence.
Do not revive this approach based on the passing Rust argument/configuration tests alone.

Provider, hook, and locator release certification remains incomplete. No provider inference
or real account sign-in has been performed during these synthetic tests.


### Subsequent hardening evidence

The final independent hook review found no reproducible remaining approval, channel or
lifecycle bypass. It reran 41 bridge tests, 21 session tests, and four lifecycle races
20 times each (80/80). Same-session child key inheritance remains an explicit limit.
The production event sink is nonblocking; its queue has no lifetime byte cap.

The lead reran all 127 provider library tests successfully. The locator IPC opt-out/restart
proof is now a standalone `locator-privacy.spec.ts` (1 passed), allowing a coherent privacy
repair commit independent of provider profile work.

Published Gemini 0.61.0 loader probes show that managed workspace settings require
`GEMINI_CLI_TRUST_WORKSPACE=true` before launch; `--skip-trust` alone happens too late.
The candidate design uses a dedicated `GEMINI_CLI_HOME`, stable neutral per-thread CWD,
exact built-in tool registry floor and an actual repository included only for context.
A random MCP allowlist sentinel is required to prevent server startup; wildcard exclusion
alone is insufficient. Machine policy and runtime reload paths still require containment.
The profile architecture is approved, but implementation and release verification are pending.


### Owner architecture correction and queued app work

The latest owner direction supersedes the earlier Trust Kernel model for hosted CLI sessions:
KalCode/KalVoice control the workspace without approval; each real provider CLI owns execution
permissions and native prompts. Mode selectors must map supported native behavior. Remove
KalVoice's create/resume approval concept and production duplicate provider approval routing.
Direct KalCode shell/file/deploy/external-tool/browser automation must not become an unrestricted
bypass: route it through a provider or keep it unavailable pending an explicit security model.

KalVoice must support quantities, provider synonyms, mixed-provider batches, active/named
workspaces, independent real provider panes, automatic persistent layouts, and named pane
resize/reorder/maximize/collapse. Preserve existing work. Reuse the local deterministic router.
Current inspection found create commands start headless idle threads and navigate to Threads;
this must change to genuine interactive provider sessions and the Code canvas.

The owner also requires official provider marks alongside every visible provider-name label,
across app and website, including disconnected/missing states. Existing shared ProviderMark
and website ProviderGlyph intentionally use invented glyphs, so both need replacement using
verified provider-native assets and a shared identity treatment.

These requests steer the continuing build; they do not authorize installation/publication
before the security gates pass. The managed-profile choice remains approved.

Checkpoint verification after locator commit: rebuilt the E2E app and both helper binaries;
`providers2.spec.ts` plus `locator-privacy.spec.ts` passed 3/3 in 33.3 seconds. The tested
Codex scalar floor is an interim conservative implementation; native mode mappings are being
reconciled with the owner's newer architecture before release.

The locator precommit format scanner flagged one unchanged, pre-existing redaction test
fixture. PowerShell continued to the commit despite that scanner's nonzero exit. Subsequent
comparison proved the match byte-for-byte unchanged from the baseline and the committed
added-line scan had zero matches. Future scan and commit commands are separate gated steps.

### Continuing owner requirements (2026-09-25)

Concurrency is lead plus at most seven independent workers. Provider security still blocks
installation, publication, and deployment. Main and the installed application remain unchanged.

- Accounts are first-class managed profiles: official provider authentication, credential-free
  metadata, explicit thread account snapshots, isolated supported provider configuration, and
  no inspection or copying of standalone credentials. Missing named accounts must not silently
  fall back. Codex/Claude supported auth interfaces have been researched; Gemini's exact-version
  PTY auth lifecycle still needs certification with real separate accounts.
- KalVoice is provider-independent: local STT, deterministic commands, then constrained local
  reasoning only when needed. External coding providers are targets, never the fallback brain.
  Local model licensing, packaging, integrity, resource behavior, updates, rollback, and clean
  Windows installation must be proved before shipping. Runtime research and removal of the old
  automatic provider reasoning path are underway; bundled local reasoning is not complete.
- Focus-aware voice dictation must retain exact pane/session/account identity, use the existing
  conversation, submit only recognized provider prompts by default, and never automatically run
  raw shell transcription. Field dictation stays ordinary text input. Local dictation is unlimited
  and does not consume KalVoice Requests. Focus/close/exit/cancel races and real desktop latency
  require testing; current implementation is being traced before repair.
- Workspace resolution must reuse known workspaces and a private local catalog with approved
  discovery roots. Ambiguous projects require selection. No blind filesystem crawling or
  provider upload of project inventory. Universal resolver integration is not complete.
- Provider-pane quick spawn and the Dashboard must use real session identities, accounts, and
  runtime events. Every open provider pane must appear on the Dashboard and focus back exactly.
  New frontend layout commands use exact thread IDs, preserve existing work, and arrange four
  new panes as a 2x2 subgroup; native launch/account integration is still pending.
- Desktop technical visuals must communicate real state or an action/navigation purpose.
  Removed Dashboard constellation art, shared empty-state decorative dots/glow, and startup
  constellation background. The true empty state now has plain guidance, provider identity,
  Open Code, and New Session. The activity chart is retained because it aggregates recorded
  events. This bounded cleanup passed 15 Dashboard state/accessibility tests, 27 shared UI
  tests, and two screenshot runs covering five window widths in dark/light themes. The dark
  1440px screenshot was manually inspected. These are frontend tests, not provider release proof.

In-progress account/schema, local interpretation, provider identity, and pane-layout changes
are preserved in this worktree. Do not mistake their presence for a released or fully integrated
build. Fresh full-suite and native E2E verification remain required after integration.

The ten all-in-one workflow additions are recorded in the active owner extension at the top of
`ADVANCED.md`, with P0/P1 security and core workflow ahead of P2/P3. Remote control remains
post-core-release; no new listeners or parallel command/notification stores are authorized.

Automatic updates are also approved: Stable default plus opt-in Beta/Dev, silent launch check,
verified background staging, safe restart-only application, durable recovery and data preservation.
Audit found no updater plugin/config; the current release tooling neither requires nor records
the compile-time channel and publishes a single preview manifest. Existing unsigned artifacts
are not eligible for the requested production updater. Signing, authenticated manifests/artifacts,
channel binding, interrupted download, failed verification, migration/rollback compatibility,
installer recovery and actual Windows upgrade tests must be implemented and proved before feed
publication. Current source work is not a shipped update system.

Cleanup checkpoint: `35c99cb` contains only the seven reviewed desktop visual-cleanup paths.
Other work remains uncommitted pending its integration gates; main, installed app, production
website and release feeds have not been changed by this campaign.

### Resume checkpoint — 2026-09-25, current session

Recovered clean integration `main` at `3ca2eb507c7f80010ce651b264021674916d9a30`
and preserved dirty `sec/providers-harden` at
`35c99cb43699813c8aba58e1fead6a5cd536076b`. All linked worktree statuses were
inspected. Environment Doctor's dirty work and Utility Dock's unmerged commit
remain preserved. No running Cargo, Rust compiler, or KalCode process was found
at preflight; current Codex processes were left alone. No Git remote is configured.

Fresh recovery checks (not release certification):

- Provider library: 166 passed, zero failed/ignored.
- Account-binding and managed Gemini integration: four passed.
- Native desktop `cargo check`: passed.
- Typechecking first failed because the shared ThreadSummary fixture lacked
  `providerAccountId`. An explicit null restored the unbound fixture contract;
  independently rerun workspace typechecking passed.
- `pnpm test`: all JavaScript suites passed (tooling 27, protocol 56, testing 24,
  UI 27, API 119, desktop 366, website 239). Rust compilation then failed because
  interactive CLI tests referenced two unfinished managed-profile methods.
- KalVoice library: 138 passed, two failed. The existing timeout and single-flight
  regressions exposed unfinished local interpreter bounds. Repair is in progress.
- Biome identified import ordering/formatting errors in 14 files; only the
  reported paths received safe formatting/import fixes. Final checks pending.

Read-only recovery, security, and release audits are separate from bounded workers
for fixture repair, canonical resume account enforcement, interactive profile
isolation, and local interpreter bounds. The lead owns integration and commits.
No provider inference, sign-in, install, push, publication, or deployment has run.
The owner reported creating an Azure account; signing readiness is not implied.
Microsoft's official Artifact Signing portal setup was supplied to the owner.
Git destination and verified signing access remain external release prerequisites.

Resume repairs and further gates:

- Confirmed legacy resume bypass: migration 12 leaves old account IDs null and
  creation-only account resolution did not cover resume. The desktop's outer
  AccountBoundProvider now rejects unbound/invalid production starts before the
  routed adapter. A call-spy regression failed with the guard removed and passed
  when restored. This does not implement managed account registration or auth.
- Confirmed bound interactive panes previously ignored account IDs. The missing
  managed Codex/Gemini launch implementation now reuses canonical policy and
  profile leases; focused proof and independent review are underway.
- Local interpretation now has a 1.5-second timeout and one in-flight worker.
  The lead independently reran all 140 KalVoice library tests successfully.
  Late output cannot execute or consume an allowance. The current interpreter
  trait cannot cancel a hung worker; one hung invocation retains the lane until
  restart. No packaged local reasoning model has been added.
- Six focused browser UI dictation tests passed; these use the in-memory
  transport and do not certify native microphone/provider behavior.
- Migration inventory expected only versions 1–12 despite the preserved lifecycle
  migration 13 being registered. The explicit expected inventory now includes
  `kalvoice_request_lifecycle`; all 15 upgrade/persistence tests passed on temp DBs.
- Zero-cost scanning initially matched a provider-brand ternary as an SDK import.
  The brand attribute now uses a static lookup with identical labels. The scanner
  was not weakened; its rerun passed across 515 product files. Biome CI passed
  with one nonblocking warning and two informational diagnostics.

Independent account audit still blocks full integration: account IPC/auth are not
registered; Claude/Gemini native sign-in is incomplete; archived-account resume,
archive/start races, account/provider matching in canonical persistence, binding
scope existence, restart auth invalidation, and certified CLI version handling
need implementation/proof before managed factories are enabled. No account
capability is classified READY or LIVE.

Release audit found a live unsigned 0.1.1 preview, an installed unsigned 0.1.5,
and no exact-build installer verify.json among the existing staged versions.
Cloudflare access is available; earlier R2 activation notes are stale. Azure
signing resources/identity validation and a source Git destination are not yet
configured. Windows Authenticode and updater signatures are separate gates.
No updater implementation or stable feed exists. A clean Windows runner is
required for installer and upgrade proof; the existing owner install is preserved.

Fresh broader reproof: `cargo test --workspace --no-fail-fast --quiet` ran 87
target result blocks: 1,336 passed, five failed, 11 explicitly ignored. Failures
are in `interactive_cli` (two) and `turns_pipeline` (three), where preserved
native-mode implementation conflicts with older conservative-mode assertions.
No assertions were relaxed and no suites were removed. Account lifecycle and
permission-contract certification remain mandatory before release.

The isolated E2E executable and fake helpers built successfully. Initial selected
native tests found two obsolete expectations that installation discovery reports
standalone Codex auth as authenticated. They now require unknown, matching the
intentional installation-only discovery boundary; fake-executable safety checks
remain intact. `providers2.spec.ts` plus `locator-privacy.spec.ts` then passed
3/3 in 32.2 seconds, including native restart. This build predates the subsequent
interactive lease-race refinement and is not final release proof.

Independent review additionally identified Gemini detection before lease acquisition
and profile lease release before the PTY exit callback finished. Repairs/tests are
in progress in the existing interactive provider and canonical lease helper.
Descendant-process quiescence and full managed authentication remain uncertified.
No staging, new commit, merge, push, installation, or publication was performed;
the rollback checkpoint and clean integration main remain unchanged.

Lease-race refinement: both new deterministic tests failed on the prior ordering
and lifetime, then passed. The lead independently reran managed interactive tests
(9/9) and managed lease unit tests (6/6). Gemini now acquires its lease before
detection, and session plus exit callback share the canonical lease lifetime.
This proves parent-process exit observation/callback cleanup only. Full descendant
quiescence remains a release gate. The full interactive target still has the two
permission-contract failures described above; no success token or ship claim applies.

Final independent narrow review confirmed both lease-race repairs with no new
definite defect in those edits. Account wiring/archival and descendant-process
quiescence remain separate release blockers. All source changes remain preserved
and unstaged on `sec/providers-harden` at the same starting HEAD; main is clean.

### Codex native permission-contract reconciliation — 2026-09-25

Scope: `crates/providers/src/codex/**`, `crates/providers/src/interactive/codex.rs`,
`crates/providers/tests/{turns_pipeline,interactive_cli}.rs`, and the provider
architecture notes. No account/auth/managed-profile implementation was changed.

Root cause: the production argv builders already contained the owner's corrected
provider-native mapping, while five integration assertions still encoded the
superseded conservative mapping. The failures reproduced deterministically:

- headless Approve expected `read-only` instead of `workspace-write/on-request`;
- headless Bypass expected `workspace-write` instead of
  `danger-full-access/never`;
- the all-mode headless assertion required `never/read-only` for modes whose
  native contract differs;
- interactive Approve expected `read-only/never`;
- interactive Bypass expected `workspace-write` and forbade
  `danger-full-access`.

Accepted finding: the five assertions and provider documentation were stale.
They now prove the exact mapping: Plan `read-only/never`, Approve and Custom
`workspace-write/on-request`, Auto `workspace-write/never`, and Bypass
`danger-full-access/never`. Headless resume is explicitly checked to retain the
Approve pair. Interactive status remains authenticated-notify plus process state;
KalCode does not answer Codex approvals. Forbidden convenience/authority switches
remain rejected, including `--dangerously-bypass-approvals-and-sandbox`,
`--dangerously-bypass-hook-trust`, `--approve-for-me`, `--search`, and `--add-dir`.

Rejected finding: there was no evidence that the production native mapping should
be reverted to the older read-only/workspace-write floor. Installed
`codex-cli 0.157.0` help and the current official CLI/configuration references
confirm the three sandbox values, interactive `on-request|never`, config-based
headless `approval_policy`, and both resume surfaces. Twelve no-inference parser
probes accepted fresh and resumed argument combinations. No provider process was
allowed to begin inference, and no account, credential, external effect, or paid
call was used.

Verification after correction:

- `turns_pipeline`: 14 passed;
- `interactive_cli`: 15 passed;
- focused Codex library tests: 25 passed;
- full `kalcode-providers` crate: 244 passed, zero failed, eight explicit real-CLI
  tests ignored because they require a real install or consume provider quota;
- `git diff --check` on owned paths: clean.

One first full provider run observed the unrelated account-store test
`removal_tombstones_clears_bindings_and_selects_a_surviving_default` fail with
`provider_account_scope_unknown`. It passed alone and in the immediate fresh full
rerun. This lane did not change `accounts.rs`; the transient cross-test/order
signal was reported to the account owner for independent adjudication.

Confidence is high for argv construction, forbidden-switch exclusion, native CLI
parser acceptance, fake-process integration, and resume preservation. Actual
provider command execution and approval UI behavior remain unprobed in this pass
because that would consume provider inference; release truth remains constrained
by the separate managed-account isolation and real-session certification gates.

## 2026-09-25 � Product-upgrade integration continues (uncommitted)

- Preserved canonical dirty sec/providers-harden worktree at 35c99cb; root main remains unchanged. No staging, commit, source push, installation of KalCode, or production publication performed in this pass.
- Owner expanded concurrency to eight useful workers. Independent lanes cover provider/account hardening, browser, browser voice, focus, plans, Updates, and release signing. Read-only runtime and signing audits supplied concrete gaps before implementation.
- Browser child-webview trust boundary: main and debug test capabilities now target only webviews=[main], never windows=[main]. Added four selector regressions: RED 4 failures, GREEN all15 capability tests. Embedded pages receive no app/native capability grants.
- Browser layout identity: PaneContent::Browser now has browserId UUID; legacy placeholder layouts get an ID through serde default and retain other tabs. Content key uses ID instead of URL. Native legacy load/save regression passes; workspace-ui suite12 passed before new regression, added legacy test1 passed; pane model31 passed. Browser CodeCanvas integration ongoing; duplicate URL update implementation consolidated into browser/browserModel.ts.
- Registered credential-free provider account metadata commands behind trusted-main capability; lifecycle agent wired canonical per-launch validation under shared lease and startup cached-auth invalidation. Production managed adapter/auth wiring remains in progress, not certified.
- Azure official CLI installed and owner completed interactive sign-in. No prior signer grant; lead successfully assigned Artifact Signing Certificate Profile Signer to current signed-in user at exact kalcodewindows certificate profile scope only. Owner explicitly authorized use/publication of current certificate after disclosure discussion. Do not copy subject/address/identity documents into evidence. Artifact Signing Client Tools installation awaiting second Windows elevation prompt. Signing itself NOT PROBED.
- Remote absent; authenticated GitHub hosting not yet available. This does not stop implementation.
- Remaining major runtime gaps from read-only census: actual local reasoning runtime/component delivery absent, whisper feature must be required in stable release, installed-model integrity check needed, managed sign-in UI/factories incomplete, updater absent. These are release gates, not completed features.

### Same-pass external readiness and local speech proof

- Official Azure CLI, Artifact Signing Client Tools, LLVM/libclang, and GitHub CLI installed with owner-completed Windows elevation. Azure sign-in uses the official flow; secrets remain outside evidence.
- Signing worker reports authorized disposable executable probe: Authenticode Valid, timestamp present, signer and timestamp chains valid. This is tooling proof only; production app/installer not signed yet.
- GitHub official device sign-in completed; CLI reports Windows keyring storage. Created private repository https://github.com/kalebcampbell2305/KalCode and configured origin. No source pushed. Initial gh --source worktree command rejected local repository detection before creation; separate private create plus git remote add succeeded and privacy flag was verified.
- Main independently built whisper feature with LIBCLANG_PATH pointing at installed LLVM. Real whisper E2E used a synthetic local TTS command and a copied official tiny.en model under ignored target/resume-whisper-smoke: 1 passed, 0 failed, no ignored in explicit run. Model verify ~1.1s; transcription ~72ms; actual grammar produced the expected four Codex thread action. No microphone input/private recording or paid inference used.
- Main independently reran pane model, memory layout, browser target and dictation session regressions:47 passed. Browser policy/model + pane model target focused run:53 passed. Capability guard now covers119 production commands plus1 debug test hook and2 core grants.
- Q4 local-model candidate and official CPU runtime archive downloaded into ignored target/component-candidates, exact upstream SHA256 checked. Runtime help only executed in sanitized environment after flat allowlist extraction; no model inference or production component publication yet.

### Local-only UI and updater integration checkpoint (still uncommitted)

- Removed obsolete connected-provider reasoning selector/fallback. Missing local runtime is uncounted local_reasoning_unavailable. Memory regression RED then GREEN2/2; desktop typecheck passed. Website/docs corrected.
- UI reruns initially30/31 twice: first parallel trace artifact collision; second trace proved Vite HMR/context reset during speech while source was being formatted. Assertions preserved; frozen-source rerun pending. Isolated test-results-* ignored.
- Updater startup/plugin/5commands integrated with main-only grants and once-guarded canonical shutdown; lifecycle hook review ongoing. Capability check124commands and15/15tests pass. No production update claimed.
- Browser independent review8findings assigned for regression repairs. Release remains gated on reproof.

### Integration verification checkpoint

- Full JS recursive tests:920 passed (protocol56/testing24/UI27/API161/desktop407/website245), zero failures. Focused KalVoice UI frozen-source rerun31/31 including dark/light axe.
- Rust workspace run completed1415 tests successfully,14 intentionally ignored across87 result blocks, then rustdoc failed because provider process-wrap source/dependencies changed during the run; full command remains FAILED and must rerun frozen. No tests removed.
- Shutdown retry/concurrency extracted production RuntimeShutdown helper:2/2 tests prove fail-retry-success caching and8simultaneouscallers singlecleanup. Independent reviewer closed false-cachedefect; normalexit best-effortcleanup remains.
- Actual desktop boot caught plugin nullconfig crash before CDP. Removed obsoletepluginregistration while updaterowned boundedrawNSISadapter replacesunsafe plugin feedpath; realBrowserE2E rebuild pending.
- Owner confirms activated Stripeaccount. Official StripeCLI1.52.0 downloaded/hashverified under ignoredtarget; officialbrowserauthlink placedclipboard and ownerpromptpending. No keys printed,no Stripeobjectscreated.

### API provisioning (not public shipping)

- Owner confirmed activated Stripeaccount; official CLI browser authorization still pending. No payment, customer, or product mutation performed.
- Created kalcode-api D1 in ENAM, UUID576dc65f-2e33-4737-8008-f0a9434f0326. All5registered migrations applied; freshremote migrationlist reportsnonepending. Existingwebsite/JARVISdatabases untouched.
- API dryrun passed72.16KiB/17.07KiBgzip. Uploaded validated Worker to createprivateconfigurationtarget: versionfeb197db-ee6e-430a-8d25-e13c49fee8e3; workers_dev=false, preview_urls=false, no routes, commandexplicitlyreported No targets deployed. Remote deploymentlisting verifiedversion. No publicAPI/auth/billing successclaim; OAuth/Stripe/signingsecretsandpublicroutingstillpending.


### Runtime directive: background Windows execution
Owner reiterated that all non-interactive work must run hidden/headless. Existing 26 WindowsTerminal windows were minimized, with no process terminated. E2E helper execFileSync and build spawnSync calls now request windowsHide; release helpers and signing calls do likewise. Real GUI E2E retains only required application windows with cleanup. Lead independently reran release-build-contract tests: 3 passed, 0 failed. Ongoing launch-path audit distinguishes intentional provider PTYs from background probes. No blind process cleanup, staging, commit, or release occurred.


### Concurrency and staged integration update
Owner increased ceiling to 20 useful background subagents and requested primary plus secondary integration leads. Primary retains canonical architecture, main, merge, security and release authority. Secondary works only in a separate staging worktree, harvests explicitly frozen scopes, and prepares focused-tested commits for primary review; no concurrent canonical writer. Added independent Resource Governor, Utility Dock harvest, Environment Doctor harvest and Git workflows lanes; existing dirty work preserved. Resource probe: CPU 14 percent, 24 logical processors, approximately 12 GiB available RAM and 62.4 GiB free disk. Focused Rust builds capped at two jobs per worker; avoid duplicate full-suite builds. Background launch audit extended through lint/admin/API/E2E/performance helpers.
Website updater routes now pass unit and real local workerd/R2 checks; complete website unit suite 256 passed, 0 failed. Routes remain undeployed. Context six IPC registrations independently verified with 2 focused native tests and capability audit 136 commands. No production release, source push or signing of a product candidate claimed.

2026-09-25 primary continuation: staged integration model active. Secondary prepared plan prerequisite 63d2071122e9848a5815fe7a63b76dfd88e50abe on isolated integrate/staged-20260925; canonical remains sec/providers-harden at 35c99cb with preserved dirty work. Primary release route work: D1-selected immutable descriptor authority, exact SHA256/64KiB stream validation, content-addressed installers/signatures; focused 42 tests and local D1/R2 6 tests passed; full website 16 files/264 tests passed; worker typecheck and scoped Biome/diff checks passed. Independent review pending, no deployment. First API entitlement key k2026-09-25 provisioned through private stdin pipe into kalcode-api, public pin only in keys.rs; secret-name-only verification confirmed. No live entitlement certification yet. Provider auth owner reports23 tests pass and PTY fork24 tests/clippy/check pass; independent Windows review pending. Browser page-lease bootstrap registered in main handler/build/capability, native main PageLoadStarted rotates authority before cleanup. Desktop full tests/build/E2E pending concurrent owners. No source push, production installer, installed app update, release publication or website deployment this pass. Background-only resource policy retained; WindowsTerminal owner process deliberately preserved.2026-09-25 continued release gates: primary website D1 routes/strict updater descriptor now pass 64 focused tests including real local D1/R2; Astro+worker typecheck pass. Independent review found and repaired pointer precedence and INSERT OR REPLACE bypass; review now accepts database authority. Primary caught generator outer-Base64 signature mismatch; fixed with RED/GREEN and cross-generator proof queued. PTY in-process security now31 tests/clippy/check green and independently accepted; abrupt-desktop-crash isolation remains blocked pending hidden guardian. New isolated guardian-stage and continuity-stage preserve base35c99cb. Secondary focuses test scheduling: one Rust jobs2, up to2 light Node; primary retains full desktop E2E and release authority. Desktop frontend426 tests pass; account-pane headless UI scenario1 pass. API key-rotation duplicate/alias defect fixed9 tests; checkout and RPC email refinements awaiting fresh verification. API has entitlement signing secret and rate-limit secret; remains unrouted. Public key only pinned in source. Azure identity probe requires unsigned KalCode helper build; prior Microsoft-signed probe did not certify subscriber identity. No source push, production publication, installation, or website deployment this pass.

2026-09-25 two-lead continuation: canonical sec/providers-harden remains 35c99cb43699813c8aba58e1fead6a5cd536076b with valid dirty work preserved. Secondary controls focused test scheduling and isolated staging; primary retains canonical/main/release authority. Provider auth latest focused RED 26 pass/2 fail then GREEN 28/28; Git UI 11/11; continuity actions3/UI2/IPC1 focused pass. Azure disposable unsigned KalCode helper signing independently NotSigned before and Valid plus timestamp after; exactly one public subscriber OID 1.3.6.1.4.1.311.97.208143396.135769116.211620001.449325895; temporary copy removed. This is signing setup proof, not product release. Browser generation-label source frozen/reviewed; fresh tests pending. Updater AIA/root-update network restrictions source repaired/reviewed; fresh tests pending. Host RAM 2.44GiB free triggered new-build hold; preserve owner terminal. Exec session IDs are not Windows PIDs. No source push, product installer publication, installed-app replacement or website deployment this continuation. Mandatory account deferred-startup/signout lifecycle and provider crash guardian remain open release gates.
