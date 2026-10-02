# KalVoice complete intelligence and control — 2026-10-01

This is the concise requirement-to-evidence ledger for the KalVoice control-layer upgrade. It is
not a release declaration. Code presence, a mocked test, and a historical release are recorded
separately from current live proof.

Campaign state: **IN PROGRESS — final integration, release and physical platform proofs are open.**

## Resumed verification — 2026-10-02 UTC

The owner requested completion, merge to main, and shipment. Recovery located this worktree at
`2fafcc1ddc9ab2bb55859b18f0bf9f4239cdcdea`, with the implementation still uncommitted. Remote main
was `b464a1fb319e85d99b6237918910aed90320fecb`; the canonical lifecycle status probe at
`2026-10-02T01:53:03Z` confirmed desktop `0.1.8+923` and the website at that main commit. Historical
`+901` references below describe the earlier campaign baseline, not current production.

Fresh verification passed desktop TypeScript, test inventory `19/19`, and the Windows runner ACL
fixture (six protected items). A candidate-path scan covered 148 source/documentation paths with
zero forbidden artifacts and zero matches for the checked private-key/token patterns. This does
not replace the final staged-diff scan.

The complete functional UI rerun executed 275 tests: 274 passed and one failed. Independent
reproduction confirmed that a spoken session choice delivers its message but leaves the widget
Processing because the follow-up drops its request-scoped result reporter. The same review found
missing cancellation propagation into composer directives. A separate native review confirmed
that full Claude model IDs pass the desktop preflight but fail the thread runtime's alias-only
catalog validation; its desktop fixture incorrectly used Codex's empty model catalog. Both are
mandatory repairs under current verification. Original failing evidence remains in
`target/kalvoice-resume-functional.log` and `target/kalvoice-review-target/`.

The separate B14 release lane remains independently owned. This campaign must use isolated
release preparation and current artifact-bound gates. Schema-21 recovery changes need a semantic
port into that new kit; the earlier B13 prepared packet cannot be copied over current pins.
No merge, product publication, or production profile mutation occurred during this recovery.

Resumed repair receipts:

- Full Claude model IDs: the nonempty alias-catalog regression failed with `invalid_model`, then
  passed after create and reconfigure shared the provider-specific model predicate. The desktop
  fixture now uses real Claude capabilities. Primary reproof: thread runtime `52/52`, desktop
  voice launch `4/4`, whole-workspace Clippy with warnings denied (exit zero).
- Spoken/clicked follow-ups: the original browser failure was reproduced independently; scoped,
  awaited results and cancellation propagation repaired it. Exact browser spec `6/6`, full
  functional browser suite `275/275`, and directives `17/17` passed.
- Desktop unit reproof: unrestricted parallel execution hit eight five-second timeouts; the
  complete unchanged suite with two workers passed `1,434/1,434`, zero skipped/flaky, validated
  by the canonical suite parser. Timeouts and failed logs were preserved, not weakened.
- Final review found `AbortSignal.any` incompatible with the supported early macOS 14 WebView.
  A local fallback preserves first abort reason and removes listeners on abort. Tests first
  failed with the API absent, then passed, including integrated routing under that condition.
- Final review found missing request signals at provider send and delayed pane-command delivery.
  The existing provider input queue now receives the signal. Pane queues discard cancelled
  entries and activation checks cancellation before navigation. Both pane regressions were
  observed red, then `18/18` passed; helper/provider/directive focused reproof passed `32/32`.
- Bulk-stop implementation was accepted after independent tracing of its generation checks and
  truthful `Stopped X of Y` reporting. The earlier ledger's whole-operation zero-effect claim
  was narrowed to the actual preflight guarantee; no transactional process-stop guarantee exists.
- Shared contract gates passed: branding, capabilities (219 commands), zero-cost policy, release
  manifest, package typechecks, protocol `59/59`, UI package `68/68`, testing package `24/24`.
- Final source path scan covered `153` intended paths: zero forbidden paths and zero checked
  secret-pattern matches. No production memory imports, paid-provider calls, or private-file
  staging occurred in this resumed verification.
- Isolated KV15 recovery kit: independent review cleared the nine-file schema-21 port; Windows
  recovery `7/7`, Mac profile `9/9`, existing Mac fixtures `77/77`, and receipt integrity passed.
  Its 73 open pins are deliberate until the merged candidate and signed artifacts exist.
- Local rollback reference: `rollback/kalvoice-control-pre-integration-20261002`, pointing to
  `b464a1fb319e85d99b6237918910aed90320fecb`. Preserve schema 21 during a forward code revert.

Post-repair complete desktop unit verification passed `1,443/1,443` with zero skipped/flaky
(canonical parser validated); the affected browser suite passed `36/36`. TypeScript, Biome
(990 files; one existing website warning), and diff checks passed. Independent final source
verification identified a further native in-flight cancellation truth gap: renderer abort cannot
undo an already admitted native command. Both typed and spoken native calls now share an exclusive in-flight lease: replacement and Escape
keep Processing, explain that cancellation is too late, and preserve the eventual result. Earlier
renderer work remains cancellable. Primary and independent combined regression proof passed
`35/35`; both false-Cancelled regressions were observed red first. Final source review accepted
the repair with no remaining confirmed source blocker. Release preparation is isolated under root
`target/recovery-KV15*`; it is not artifact certification or publication.

## Candidate identity and truth labels

- Starting commit: `d36ac814aafb13c64931cb5a7d917527ae1e3b26`.
- Working branch: `feat/kalvoice-complete-control`.
- Public version: `0.1.8`; it must not be bumped by this work.
- Live production at campaign start: `0.1.8+901`, product commit
  `6867475421761476d0103ee733115732538ac532`.
- Target: the next internal `0.1.8+N`, where `N > 923` is derived from the exact final merged
  `main` commit. The resumed lifecycle probe confirmed `+923` live. Do not pin this campaign's `N` before its final merge.
- `SOURCE`: present in the working tree but not sufficient proof.
- `TESTED`: a named current-candidate test passed.
- `LIVE`: a current bounded runtime or production probe passed.
- `PENDING`: required proof or a confirmed repair is still open.

## Requirement-to-evidence matrix

| Requirement | Canonical path | Current evidence | State |
| --- | --- | --- | --- |
| Live semantic scene | `useVoiceScene`, `sceneTargets`, Code canvas registry, canonical workspace/thread/pane stores | Privacy-bounded workspace, terminal, thread, provider pane, browser, dashboard, widget and Git metadata; no terminal output, prompts, responses, URLs or filesystem paths. Integrated and independently reviewed scene suites are green. | TESTED shared UI / PENDING packaged app |
| Natural target resolution | `sceneRouting`, `useVoiceScene`, native session resolver | Named/current/previous/adjacent/other/recently completed/recently failed targets, structured task matching, and equal-match chooser behavior are implemented. Native live-scene, invalid-request, session-resolver and desktop-executor integration tests are green. A guarded real Qwen inference selected the exact Website thread from two live scene choices using isolated copies of the signed Windows artifacts. | TESTED Windows / PENDING physical macOS model probe |
| Navigation and Operations | `sceneOperations`, `KalVoiceProvider`, `OperationsPage`, canonical Operations client | Operations/Runs/Queue/Services/Environments/Activity, latest failed run, production, running/blocked/just-finished queries, safe service restart, follow-up focus, scroll and electric-blue focus state. A bounded focus lease repaired the production-card mount race; focused Vitest and Chromium memory-app proof are green. Typed scene commands now settle their history row instead of remaining “Working…”. | TESTED / PENDING physical app proof |
| Locate, focus and illuminate | existing navigation/UI-intent owners plus scene registries and `data-kalvoice-focused` styling | Target is revalidated, its owning view is opened, it is scrolled/focused, and the existing trace/active outline is used. Focus failure is reported instead of claiming success. Operations focus is browser-proved; other target kinds still need final integrated browser/native proof. | PARTIAL TESTED / PENDING |
| Follow-up context | provider scene target plus Operations target continuity | “focus it”, “open it”, “that one”, “same terminal/agent/thread”, and “other” reuse a bounded prior target and revalidate its current identity. Provider client/feed replacement and failed new focus clear the old target so “open it” cannot resurrect it. Deterministic and guarded local-reasoner target selection are tested. Per-request generation, abort and request-ID checks fence renderer actions; native typed/spoken calls remain exclusive until their result settles and cannot falsely report cancellation, while a chooser remains actionable after push-to-talk cancellation/nothing-heard and revalidates the exact target on click. | TESTED Windows / PENDING physical macOS model probe |
| Direct terminal/provider speech | exact provider/account/process-instance dictation registry, pane composer, native `TalkTarget` boundary | Raw terminals remain insert-only and cannot submit/clear. Provider panes retain governed submit. Captured delivery, full-identity remount reconnect, flush-time readiness, initial/active steering and process-instance revalidation are implemented; native writes hold provider registry/lifecycle locks and reject stale replacements, known structured approval prompts and Claude Waiting/Limited hook state while still permitting insert-only draft. Focused frontend, replay/terminal, Chromium, provider guard and desktop command tests are green. Codex notify/Gemini process-only modes cannot authoritatively expose every provider-native approval prompt, so an ordinary voice send can land on an unreported native prompt. | TESTED / PENDING physical app |
| Natural multi-agent launch | `KalVoiceIntent`, grammar, desktop executor, canonical account resolver and `ThreadRuntime` | Counted Claude/Codex/Gemini launches create real interactive sessions. Account/workspace/model/effort and counted assignments survive chooser retry, including long payloads; all initial prompts are preflighted before provider start, while provider-start failures report started/queued/failed counts truthfully. Explicit account wins over focused context and a signed-out named account cannot fall through. Owner/Max unlimited entitlements remain unlimited; the 16-session request bound and resource governor are technical controls, not plan caps. A generic provider-less request with several eligible providers now produces provider-qualified choices and an exact typed retry. | TESTED deterministic / PENDING physical provider |
| Provider account reuse | canonical provider account resolver | A sole valid account or unambiguous workspace/default account is reused without another sign-in; an explicitly named account is honored. Same-provider, generic-provider and mixed-provider grouped ambiguity use concise provider-qualified choosers. The retry binds only the ambiguous group while preserving the full typed group list; sequential choosers complete before one all-group preflight and no provider starts partially. Encoded retry payloads stay out of visible history. No provider call begins on ambiguity, invalid entitlement or failed preflight. | TESTED deterministic / PENDING physical provider |
| Model and effort | persisted thread configuration and provider argv owners plus generation-bound recent-launch context | Nullable additive thread effort persists across restart/resume. Claude receives separate `--effort`; Codex receives separate reasoning-effort configuration; validated full Claude IDs and aliases retain the exact model; Gemini truthfully rejects effort. Model and effort work inline and as the standalone follow-up “Use Claude Opus 4 1 at High effort for all of them.” The two-minute/three-command context binds exact thread ID plus generation and reconfigures only a complete same-provider recent group while unused and idle, then persists values and restarts through the canonical runtime. Stale, partial, used or active groups refuse with zero effects; two-phase reservation protects PTY drafts. | TESTED Windows / PENDING physical macOS runtime |
| Local-first reasoning | deterministic grammar first; existing guarded llama.cpp/Qwen fallback | Deterministic routing is unchanged. Grounded native scene actions use only sanitized owner-visible `ThreadSummary` metadata, max eight candidates, and the existing 1.5 s deadline. No connected-provider fallback exists. Contract/executor paths and one guarded real Windows Qwen inference are green; the equivalent registered arm64 path has not run on the physical Mac this pass. | TESTED Windows / PENDING physical macOS model probe |
| Repository vocabulary | Whisper prompt/token cache plus one-second scene-name and Locator path cache | Bounded sanitized names cover workspace, terminal, thread, provider, account, exact model, branch and recent repository path/package components without transcript rewriting or per-take disk/network scans. Whisper-feature compile, two focused vocabulary tests and a paired 24-WAV synthetic tiny.en run are green. | TESTED Windows synthetic / PENDING physical microphone + macOS |
| Spoken lifecycle callbacks | Core event subscriber, typed lifecycle signal and existing OS `SpeechOutput` | Concise named completion/failure/needs-user/permission/OAuth/provider-disconnect and deploy/release outcomes; live-only, deduplicated, preference-aware, silent during microphone/shutdown. Native speech is serialized with bounded completion/shutdown waits and prewarmed on the existing warm thread only when enabled. The speech backend now acknowledges actual start before Speaking=true, lifecycle target binding or the spoken log; backend failure settles false without those signals. Callback, post-commit, privacy/serialization, protocol export and frontend lifecycle tests are green. | TESTED / PENDING physical OS TTS |
| Ambiguity and safety | chooser contracts, canonical app/account/provider permission owners | Equal valid matches ask which one. KalVoice adds no voice-only approval gate for any user or owner; each action keeps the controls used by the same UI/account/provider path. Counted bulk stop snapshots the exact live set and refuses count or preflight-snapshot mismatches with zero effects. Execution then stops only generation/ticket-bound targets; concurrent replacements remain untouched and partial stops are reported as Stopped X of Y with the failure reason. Named pane close requires an exact or unique partial target and refuses ambiguous/missing/blank names; unqualified close keeps focused-pane behavior. | TESTED / PENDING physical app |
| Windows and macOS equivalence | shared Rust/TypeScript paths plus native capture/TTS/package owners | Current source is shared; Windows-hosted deterministic tests exist. The Mac GUI session, expected Developer ID identity and existing notary profile are ready. No current KalVoice candidate package/install proof exists on either OS. | PENDING release proof |
| Permanent shared agent directive | repository-root `AGENTS.md`, imported by `CLAUDE.md` | The owner’s KalVoice reuse, priority, safety and continuous-delivery rule is present in the working-tree policy for Claude Code, Codex and future agents. It remains uncommitted until the candidate is integrated. | SOURCE / PENDING integration |
| Continuous delivery | `tooling/release/ship.mjs`, trusted Windows/Mac release hosts and signed v2 feeds | The resumed lifecycle probe confirms `0.1.8+923` live. The candidate is not merged, signed, published, installed or production-probed. | PENDING |

## Explicit product-boundary finding

`Favorites` maps to the existing pinned workspace rail; `Agent Fleet` maps to the existing Agents
surface and keeps its availability gate. `Squads` and `Recipes` have no canonical product surfaces
or scene-object contracts, so their vocabulary hints are not control semantics. `Handoffs` has no
standalone surface; the unrelated internal context `handoff` purpose is not a user-facing product,
and provider handoff remains governed by its existing feature gate. KalVoice does not invent
targets behind absent or gated product owners.

## Current verification receipts

- Task-start coordinator baseline: desktop frontend `190/190`; the exact command receipt remains
  to be attached before final closeout.
- Coordinator focused Operations plus KalVoice Provider run: `54/54`; navigation Rust regression
  was observed red for the intended reason and then green.
- Current deterministic frontend integration:
  `pnpm --filter @kalcode/desktop exec vitest run` over the six named scene, Operations,
  boundaries and dictation-registry files: 6 files, `57/57` passed. These use deterministic
  runtime/DOM fixtures, not a real microphone, provider or macOS app.
- Scene implementation receipt: `11/11` focused tests, desktop TypeScript, Biome and diff checks
  passed. This overlaps the broader frontend set and is not added to its count.
- Final integrated scene suite passed `74/74`, desktop TypeScript and Biome. Independent adversarial
  scene/Operations review passed `116/116`, desktop TypeScript and native callbacks `10/10`, with no
  confirmed scene defect remaining.
- Provider-scene lifecycle regressions passed `7/7`, including clearing callback/follow-up context
  on runtime feed replacement and clearing a stale prior target after a failed new focus.
- Final owned KalVoice Provider lifecycle suite passed `23/23` in 2.77 s. It covers every callback
  class, canonical thread/run detail for “what did it do”, “open it”, private activity/error
  exclusion, deleted/archived/object-swapped refusal, client replacement, duplicate provider labels
  with account/workspace context and spoken ordinal selection. Final UI control-layer remains `5/5`.
- Post-review scene regressions passed `29/29` in 10.26 s and were independently rerun `29/29`.
  They prove terminal history settlement for
  handled typed scene work, typed-to-typed cancellation, push-to-talk `listening_started`
  cancellation of older typed work, stale request-ID action-result rejection, and an ambiguous
  chooser remaining actionable after push-to-talk cancelled/nothing-heard before exact revalidation
  and focus. Biome passed. This is deterministic hook/reducer proof, not physical microphone evidence.
- Native scene proof passed KalVoice live scene `4/4`, bounded invalid-request `1/1`, session
  resolver `16/16` with one pre-existing ignored latency report, exact effort phrase `1/1`, and
  desktop executor integration `1/1`; Rustfmt and targeted diff-check passed. A guarded real Qwen
  live-inference test passed `1/1` with 485 filtered in a 23.31 s harness, using an isolated 893,206,136-byte
  copy of the production-signed Windows runtime/model artifacts under native GuardianRuntime
  custody. With the real 1,500 ms orchestrator deadline unchanged, guarded cold start was 1,314 ms
  and warm scene inference was 791 ms. It selected the exact Website `OpenThread` from two choices
  and drained cleanly. This is one current sample under concurrent build load, not p50/p95. The
  arm64 equivalent is compiled and registered against the signed receipt but was not run on the
  physical Mac this pass. The full KalVoice lib run was interrupted only at the long understanding
  benchmark after its observed tests were green, so it is not recorded as a completed full-suite
  result. Tooling inventory passed `19/19`.
- A later isolated Windows fallback proof sampled 2,041 ms guarded cold start and 895 ms warm
  inference. It is a single fallback-path sample, not a replacement for the paired deterministic
  percentiles or the production-deadline sample above.
- Terminal/control review initially passed four focused files, `31/31`, while exposing stale-target,
  insert/submit, queue-revalidation and initial-readiness defects. This is retained as the defect
  discovery receipt; the later terminal-voice and Chromium results below supersede that source state.
- After three accepted direct-prompt repairs, the focused TypeScript set
  (`dictationRegistry`, `PaneTerminal.voice`, `KalVoiceProvider.boundaries`, `logic`) passed
  `48/48` in 3.43 s and diff-check passed. Later full-identity reconnect, initial-readiness and
  native lock-boundary repairs are covered by the final terminal-voice receipt below.
- After provider readiness repair, deterministic Chromium
  `kalvoice-control-layer.spec.ts --grep "KalVoice provider-pane delivery"` passed `2/2` in
  19.9 s. It proved captured provider identity across focus movement, insert-only Type, Send that,
  navigation exclusion, unchanged raw-terminal input and exactly-once Tell Claude delivery. It
  made no external provider or network call.
- The four-flow control-layer file then passed `4/4` on isolated port 1447 in 29.1 s. A new exact
  owner-requested case on port 1448 passed `1/1` in 11.3 s: a bare “Refactor navigation and run
  the tests.” spoken into the focused Claude pane submitted exactly once, stayed on Code and left
  the raw terminal unchanged. Fresh final shared-state reproof after lifecycle/protocol fixes
  passed the combined file `5/5` in 20.9 s on isolated port 1451.
- The final focused KalVoice/Operations frontend set passed 9 files, `163/163` tests in 13.60 s;
  desktop typecheck and owned Biome passed. These deterministic tests made no external provider or
  network calls.
- Final terminal-voice slice passed `65/65` focused frontend, `57/57` terminal/memory, `37/37`
  replay, `2/2` Chromium provider flows in 15.8 s, provider voice guards `3/3`, and the desktop
  provider command test `1/1` with the development Tauri config. Protocol typecheck, Biome,
  Rustfmt and diff-check passed. These repairs bind provider/account/process instance across
  remount and revalidate at queue flush. Codex notify and Gemini process-only transports still
  cannot observe every provider-native approval prompt. KalVoice does not deliberately classify or
  approve an unreported prompt, but an ordinary provider send can reach it; the provider UI and its
  permission mode remain the available authority.
- A stale Playwright fixture that treated canonically ready `IDLE` as an unverified provider was
  corrected to use a visibly Limited Claude pane. Native and memory guards now reject submit for
  Claude Waiting/Limited hook state, allow submit only while Active, and retain insert-only draft.
  Pane tests passed `16/16`, the native lifecycle guard passed `1/1`, and exact terminal-dictation
  Playwright passed `5/5` in 12.6 s: raw insert added no Enter, multiline content was sanitized
  without execution, raw “Send that” was refused, and Limited/native-permission provider submits
  were refused without replacement. Biome, Rustfmt and diff-check passed.
- Fresh deterministic Chromium memory-app run:
  `pnpm --filter @kalcode/desktop exec playwright test --config tests/ui/playwright.config.ts tests/ui/kalvoice-control-layer.spec.ts --workers=1`
  initially finished `1 passed, 3 failed` in 29.7 s. Every Operations tab obtained actual DOM focus and the
  focus marker. Production-card focus lacked the marker, and both provider prompt flows were
  rejected as still working. This was the defect-discovery receipt; the later `5/5` combined run
  above supersedes it.
- The final Operations mount-race and multi-workspace Production ambiguity slice passed `50/50`
  focused Vitest tests across
  `sceneOperations` and `OperationsPage`. A fresh Chromium run of
  `kalvoice-control-layer.spec.ts --grep "Operations control layer"` passed `2/2` in 18.2 s,
  including every Operations tab and failed run to Production to follow-up “open it”.
- Baseline release understanding benchmark at pristine `d36ac814`:
  `cargo test --release -p kalcode-kalvoice --lib understanding_bench -- --nocapture --test-threads=1`
  passed `1/1` over 375 corpus entries, 55 holdout entries and 75,000 samples. Results:
  deterministic understand p50/p95/p99 `0.433/1.168/1.909 ms`; production path
  `0.924/3.060/5.473 ms`; fallthrough preparation `0.514/1.166/2.821 ms`; cold `1.195 ms`.
- The same command on the current shared tree passed `1/1`: cold `1.200 ms`; understand
  p50/p95/p99 `0.508/1.255/2.164 ms`; production `1.090/3.243/5.368 ms`; fallthrough
  `0.555/1.116/2.318 ms`; normalization `0.557/1.103/2.155 ms`. Against pristine d36,
  understand p50/p95 changed `+0.075/+0.087 ms` and production p50/p95
  `+0.166/+0.183 ms`; fallthrough and normalization p95 improved `0.050/0.063 ms`. These are
  low-single-tenths changes under shared-machine contention, not an improvement claim.
- `cargo test --release -p kalcode-kalvoice stt::tests::recognition_vocabulary -- --nocapture --test-threads=1`
  passed `2/2`. `cargo check -p kalcode-kalvoice --features whisper --lib` passed after the
  vocabulary seam.
- Paired synthetic speech proof used the same 24 locally generated, speech-end-trimmed Windows
  System.Speech WAVs, the independently verified signed `tiny.en`, 2,000 workspace names and one
  pass of each tree. Both budget checks exited zero. Pristine d36 versus current p50/p95 was:
  key-up to final `348.4/540.9 ms` versus `417.0/699.4 ms` (`+68.6/+158.5 ms`); partial
  `289.3/413.1 ms` versus `367.0/439.9 ms` (`+77.7/+26.8 ms`); final-to-recognized
  `0.4/0.9 ms` versus `0.3/0.9 ms`; recognized-to-executed `1.1/41.1 ms` versus
  `0.9/14.1 ms`. CPU moved from 46% to 65% for d36 and 39% to 83% for current, so these results do
  not support a speedup claim. Exact transcript accuracy was `18/24` to `19/24`, WER
  `6.40%` to `4.65%`, and command accuracy `21/24` to `20/24`; the command difference came from
  the STT transcript “Code, Exide”, not deterministic grammar. Redacted evidence is under
  `target/kalvoice-synthetic-stt-20261001` and is not source-controlled.
- Callback-focused native suite passed `10/10`, zero failed/ignored, with 476 filtered in 0.44 s
  after queue-time deduplication hardening.
  It includes identity-required silence, Core/Operations semantic deduplication, and six delayed
  named speech events completing in order without overlap. Operations post-commit passed `1/1`,
  typed lifecycle privacy/serialization passed `1/1`, and ts-rs export passed `34/34`; the generated
  protocol includes lifecycle class/target enums and the callback signal variant.
- Final speech-truth regression first failed at the missing start-admission seam, then passed `1/1`.
  Backend failure now emits only settled(false), with no Speaking=true, lifecycle target binding or
  spoken log. Accepted playback emits started before completion and then settled(true). The desktop
  callback suite recompiled against that API and remained `10/10`; no dependency/runtime/model was
  added.
- Effort plumbing verification passed Contracts `275`, provider library `301` with one existing
  opt-in ignore, provider/thread all-target compilation, persistence/restart, input/injection,
  migration upgrade/reopen, migration-numbering, desktop Rust library check, owned Rustfmt/Biome
  and diff checks. No live provider call occurred; macOS runtime proof remains in the release lane.
- Final launch verification passed protocol generation for 369 types, Contracts `275`, KalVoice
  generation/routing `317` with two existing ignored tests, desktop launch `22/22`, natural-agent
  launch `2/2`, both testing and desktop TypeScript checks, and the earlier Stable provider-pane
  frontend slice at 5 files, `36/36`. These deterministic tests made no live provider call.
- The final mixed-provider account-chooser regression increased desktop launch to `23/23` and
  KalVoice clippy passed. It proves complete typed-group retry, ambiguous-group-only binding,
  sequential chooser resolution, and all-group preflight before any start, with no partial launch.
  The final privacy regression proves native receives the exact encoded retry and workspace while
  visible history shows only the account label and excludes the payload. Root independently passed
  the full KalVoice Provider scene set `30/30`.
- Exact recent-launch model/effort follow-up proof passed threads launch `4/4` (success, atomic
  draft refusal, partial failures and concurrent stop), providers `2/2`, KalVoice grammar/context/
  route `3/3`, desktop launch `23/23`, and protocol plus desktop TypeScript checks. Exact launch
  instances are generation-bound; recovery reconciles every target and LiveState locks cover commit
  plus provider launch. Four-crate all-target clippy with `-D warnings`, formatting and diff-check
  passed. The independent launch reviewer found no remaining concrete blocker.
- Primary fresh gates passed: KalVoice provider scene/boundary `30/30`, desktop typecheck,
  branding inventory across 2,567 files, native capability inventory at 219 commands, zero-cost
  policy across 738 files, and Biome across 988 files. The release-manifest check passed against
  live baseline `0.1.8+901`; it is not proof of the new candidate manifest or publication.
- Registered desktop unit suite passed 153 files, `1,425` executed, zero skipped/flaky. The first
  full run exposed a test-only ResizeObserver cleanup-order defect; it was repaired without a
  production fallback and the full registered suite reproof passed.
- Broad registered source gates passed: tooling `439`, shared-package groups `59 + 68 + 24`, API
  `293`, and website `600`. Whole-repository formatting passed after three unused test-fixture
  `mut` bindings were removed and the callback queue variant was boxed without changing behavior.
  Whole-workspace clippy then passed in 44.65 s. Native E2E build session 96624 passed. The full UI
  functional run passed `274/275`, with its only failure the stale terminal fixture repaired above;
  that exact terminal spec then passed `5/5`. A complete post-repair UI functional rerun remained
  pending at this point; the composed Rust reproof is recorded below. The visual suite passed `54/56`; the other two failed only because
  concurrent default-output cleanup removed their trace artifacts, and both passed on unchanged
  source with isolated output in 20.4 s. Native execution initially had two under-load failures;
  both raw reruns passed, including KalVoice routing/usage/widget restart in 10.2 s, and schema
  v1/v4/v5/v6 migration cases passed. The continuing native run exposed one Windows Browser
  foreground activation failure, later isolated below. The registered Rust runner exited 101 with
  suppressed diagnostics; the composed raw reproof below supersedes that runner attempt.
- Root independently reran six KalVoice slices `53/53` and the final scene chooser `29/29`; the
  final reviewer passed all three repaired scopes. Native raw execution passed `23/24`, and the
  Windows Browser foreground case passed `1/1` in isolation, giving passing evidence for all 24
  cases. The final native build’s KalVoice plus notification cases passed `2/2` in 39 s with the
  latest scene/TTS repairs. The full Rust retry exposed only the permissions migration registry's
  expected-list stopping at 20; schema 21 was appended while preserving the full sequence, and
  permissions passed `36/36`. The raw Rust prefix recorded 1,795 passes, that one superseded failure
  and nine intentional ignores. Nine remaining crates (providers, PTY, resources, secure store,
  threads, timeline, updater, utilities and workspace UI) added 837 passes and 15 intentional
  ignores, all exit zero. After replacing the stale 35-test permissions binary with its 36-test
  reproof, the unique aggregate was 2,633 passes and 24 intentional ignores. Other permissions
  integration binaries then passed 30 more cases and whole-workspace docs passed. Canonical
  `parse/validateSuiteResult` over the non-overlapping original passing binaries, repaired
  permissions binary, remaining binaries and docs records `2,663` executed, zero failed, 24
  registered intentional ignores and zero flaky. The receipt is
  `target/kalvoice-rust-composed-proof.json`; it retains the original failure and exact inputs. This
  is a composed reuse of valid proofs under repository policy, not one fresh registered invocation.
- Bulk-stop contract, grammar, exact running-session snapshot and desktop zero-effect mismatch
  regressions each passed (`1/1` each). The final affected pane subsystem passed 7 files,
  `77/77` tests, including exact single-tab close, ambiguous/blank zero effect and unqualified
  focused-pane close. No KalVoice-specific confirmation implementation remains.
- Paired full-model synthetic WAV timing is recorded above. Physical push-to-talk, microphone and
  user-speech timing was not run. The registered desktop unit suite is green, but the complete
  workspace/release gates, physical app, signed install and update-feed/install results remain
  PENDING.

Do not sum overlapping test receipts. A final receipt must name the exact immutable candidate and
include exit codes.

## Local models, runtimes and size accounting

No new model or runtime dependency is introduced by this upgrade. Existing optional signed,
on-demand components remain:

| Component | Bytes | MiB | Delivery |
| --- | ---: | ---: | --- |
| Whisper `tiny.en` | 77,704,715 | 74.105 | optional signed component |
| Qwen3.5 0.8B Q8 | 833,592,096 | 794.975 | optional signed component |
| llama.cpp runtime, Windows | 18,560,055 | 17.700 | optional signed component |
| llama.cpp runtime, macOS arm64 | 10,693,267 | 10.198 | optional signed component; fresh catalog sequence 2 |
| Optional default total, Windows | 929,856,866 | 886.781 | downloaded on demand, not installer payload |
| Optional default total, macOS arm64 | 921,990,078 | 879.278 | downloaded on demand, not installer payload |

The new vocabulary and callback work is code-only. Exact installer delta, idle RAM and active RAM
must come from the final packaged candidate. A prior contended synthetic sample peaked at 173.14 MiB
for d36 and 206.55 MiB for current; it is indicative only and not a controlled idle/active-RAM
measurement. The current reasoner admission estimate is model MiB
plus 1,024 MiB (about 1,819 MiB for the default model); that is a guard value, not measured RSS.
The existing performance process probe is Windows-only, so physical macOS measurements remain
required.

## Release and rollback

- Preserve the live `0.1.8+901` publication, feed and B12 evidence byte-for-byte until the new
  candidate passes every gate.
- The Windows trusted release runner ACL implementation now enforces the exact approved path,
  rejects unsafe/reparse roots, rejects active Workers except the exact idle gate-listener lineage,
  rechecks before the first write and applies exact protected owner/SYSTEM/Administrators ACLs
  without changing contents. Its focused Windows PowerShell 5.1 suite passed. The gate label was
  paused for 108.2 s while the active job finished normally; the release tree was then hardened,
  re-registered with the exact release labels, brought online idle and verified with exact effective
  owner/SYSTEM/Administrators FullControl on all 326 runtime items, including safe inherited ACLs on
  the listener’s new diagnostic log. The gate label was restored and queued run `36907536339`
  completed. The isolated repair commit `37589510` was integrated as `5fac5547`; primary
  independently proved six protected fixture items. Follow-up helper commit `283b2d1f` adds strict
  setup and runtime inheritance verification; it was integrated as `2fafcc1d` and its PowerShell
  proof independently passed. Cached
  official Actions Runner v2.337.0 supply-chain verification matched the published asset and all
  275 installed files with zero missing/mismatched files. Historical credential confidentiality
  under the former broad ACL cannot be proven; no credential was read or fingerprinted. A fresh
  query-only Mac GUI probe at
  `/Users/kalebcampbell/KalCode-zero-owner-probe/20261001T182308Z` reports the Aqua session
  unlocked, the expected Developer ID identity present and the existing `KalCode-release` notary
  profile valid. It made no submission or keychain change. The public signed reasoner catalog,
  runtime and model were later staged on the Mac under a mode-0700 directory with mode-0600 files;
  their exact bytes and SHA-256 values matched catalog sequence 2 and the trusted offline signer
  receipt. Model execution still waits for exact committed candidate `C`. This candidate still needs
  signing, notarization, packaging, same-version upgrade/install and launch proof.
- The final release kit must be regenerated from exact merged commit `C`, internal revision `N`,
  artifact hashes, signing/notarization receipts and feed hashes. Historical `+901` HTTP 200
  responses are baseline evidence only.
- Schema 21 makes the current lifecycle LC-A recovery path a release blocker. LC-B baseline/candidate
  rollback remains valid because both sides derive from exact candidate `C` and share schema 21;
  its recorded temporary rollback-floor override must stay explicit and schema-truthful. LC-A must
  not install or launch live `+901`/schema 20 over a profile already migrated to schema 21. Before
  shipping, the harness must preserve the complete migrated profile aside and either restore a
  verified pre-LC-A schema-20 full-profile snapshot into absent roots before any `+901` launch, or
  fail closed and recover only to the candidate. Direct database overwrite or WAL/SHM mixing is
  forbidden. The isolated recovery repair tests pass Windows `7/7` and Mac `9/9`. The same Mac
  fixture then passed `9/9` on the physical release machine using an isolated fake HOME, with no
  production profile or app touched. Its receipt is
  `target/recovery-B13-schema21-merge-20261001T1945Z/mac/lca-profile-physical-mac-20261001T1958Z.log`.
  Canonical hash application remains required before this blocker is cleared.
- Create a phase-scoped pre-integration rollback ref for the exact candidate. Normal rollback is a
  non-destructive forward revert plus the existing signed feed/artifact rollback path; never reset
  `main` or delete newer user data.
- Migration `0021_threads_effort.sql` is additive and nullable. Core takes the exclusive lock and
  creates one SQLite backup of schema 20 before the transactional `ALTER`. Regression proof keeps
  the existing row, gives legacy rows a null effort, retains selected effort after reopen, and
  verifies the backup still contains the original row and no effort column. Preserve the migration
  on forward code revert: an older build refuses schema 21, and the updater rollback floor prevents
  an unsafe downgrade. Recovery is a controlled manual restore of the exact schema-20 backup; no
  automatic or destructive schema downgrade is claimed.

## Effects and durable-state accounting so far

- Production owner-memory mutations: 0.
- Historical archive imports: 0.
- Paid provider calls: 0.
- External messages/publications/deployments: 0.
- Trusted release-infrastructure mutations: 1 Windows runner ACL hardening and short-lived
  re-registration; no release was queued or started.
- Production database mutations: 0.
- Production artifacts published by this campaign: 0.
- Secret/private-file staging: 0 known; final staged-path and secret scans remain required.

These counts apply only to the work recorded before final integration and release. The final
release receipt must replace them with audited end-state counts and the exact rollback reference.

## Immutable PR verification ? 2026-10-02 UTC

Recovered implementation committed as `c36bf5b1`; current main merged as `c9b13f20` and
[PR 67](https://github.com/kalebcampbell2305/KalCode/pull/67) opened. Inventory conflicts
preserved the proven 275 functional / 56 visual partition; inventory tests passed. The
post-serialization browser rerun passed `11/11`; source worktree was clean. No publication
or production-profile mutation has occurred.

The first physical macOS trusted gate rejected a constant-size `chunks_exact(2)` under
Rust 1.98 Clippy. The parser now uses `as_chunks::<2>()` and the same remainder/count checks;
this is compatible with the declared Rust 1.89 minimum. The original job log is preserved at
`target/kalvoice-pr67-mac-job.log`. The gate must rerun on the corrected commit.

Correction reproof: grammar `47/47`, KalVoice all-target Clippy, and independent native
review passed. A complete committed desktop rerun hit one existing five-second palette
timeout under concurrent build load; that unchanged palette file passed immediately with
one worker. Original failure is preserved in `target/kalvoice-resume-desktop-committed.json`;
no timeout or assertion was changed. Trusted immutable PR gates remain required.

The next macOS gate exposed a Unix-only test-helper `expect_used` lint. Directory-permission
setup now returns its I/O error to the actual test, which still fails with the same message;
production behavior and test assertions are unchanged. Windows desktop all-target Clippy
passed. The local gate had passed tooling, packages, API, and website units/build; it was
stopped at website E2E so final verification can start from the corrected immutable commit.

## Current-main integration and physical Mac fixture repair

Merged B14 main `6378ce65` into the feature as `fa3ec10b`. The sole conflict was KalVoice
routing; both scene controls and KalTidy were retained. KalTidy execution shares the native
exclusive lease and scoped result reporting. Primary integrated tests `151/151`, KalTidy
`6/6`, inventory `19/19`, typecheck, and independent interaction review passed.

The physical Mac passed full-workspace Clippy, then exposed the idle provider fixture
dropping its event sink before its session ended. The runtime correctly classified the
disconnected session as failed. The fixture now owns its sink and shuts down its runtime
on drop. A deterministic lifetime regression failed before repair and passed afterward;
launch tests passed `4/4` after cleanup and `20/20` across repeated earlier runs. Independent
review and desktop all-target Clippy passed. No production provider logic changed.

Unchanged-lane local proofs passed tooling `439`, API `293`, website units `600`, website
E2E `151` with eight registered skips, and checkout E2E `3`, all zero flaky. A two-worker
desktop run exceeded the existing 300-second suite deadline; its orphan child was identified
and stopped, evidence preserved, and the unchanged suite restarted with four workers. No
timeout, assertion, skip policy, or test count was weakened. Final exact-commit gates and
publication remain pending.

## Production-feature gate correction

Physical Mac default-feature Clippy and workspace tests passed at `339fde9d`
(2645 passed, 23 intentional ignores). Independent review found that the trusted
Mac workflow omitted the production Whisper feature required by the registered
Rust suite. Both Mac commands now enable `kalcode-desktop/kalvoice-whisper`;
the feature-enabled proof remains pending. Windows trusted verification stopped
at website-unit exit 1 with suppressed child output despite the same commit's
local 600-test pass. This is unresolved pending diagnostic output and reproof;
neither a partial gate nor default-feature success certifies delivery.

## Command Deck integration regression

Integrated main `81db65cb` at `97455bd7`, preserving both sets of UI tests.
Independent review reproduced the collapsed-widget push-to-talk activity bar
overlapping the new status strip by 12 pixels. The activity now consumes the
existing ShellSlots bottom inset for both active and disconnected states.
The regression failed before repair and passed at ordinary and smaller window
sizes afterward; neighboring UI 3/3 and focused units 18/18 passed. The new test
raises functional UI inventory to 282 and the combined established suite to 338.
Final integrated gates, merge, signed packages, and delivery remain pending.

The current UI gate also reproduced a midnight fixture defect: an activity
required in Today was timestamped 20 minutes ago and therefore appeared in
Yesterday shortly after local midnight. The test now fixes browser-local time
at 00:10; the fixture modification occurs at the current time. Production date
filtering is unchanged. Deterministic red/green, independent exact UI reproof,
neighboring Home UI 3/3, and recency units 11/11 passed. No tests were skipped
or removed, and the existing test count is unchanged.
