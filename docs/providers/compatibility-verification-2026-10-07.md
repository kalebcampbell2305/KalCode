# Provider compatibility repair — 2026-10-07

Starting main: `0297e87fe0bc144e07e80c7c10180a74a0800c84`.
Implementation branch: `fix/provider-capability-compatibility`.

## Reproduction and authority

An isolated executable using the starting commit's `VersionWindow` reproduced the exact
rejection of installed stable `codex-cli 0.161.0`: the managed Codex allowlist ended at 0.160.
Authentication and managed headless/PTY launch applied the restriction before checking actual
CLI behavior. Updating that allowlist would only defer the next failure.

The production launch authority is now the adapter's capability and isolated app-server probe,
plus optional verified declarative policy. The former Codex `MANAGED_VERSIONS` authority was
removed. A verified platform minimum remains distinct from a minor-version allowlist.

## Requirement-to-evidence map

| Requirement | Implementation and proving surface |
| --- | --- |
| Current stable, exact 0.161.0, patch/minor/future stable | `version.rs`, `codex/compatibility.rs`; unit classification and `codex_compatibility` guarded process tests |
| Alpha/beta/rc, build metadata, malformed output | Strict SemVer parsing, explicit release channel, malformed token boundaries and guarded experimental-path tests |
| Actual required commands, flags, profile/session protocol | Bounded help probes and credential-free initialize/account-read in disposable `CODEX_HOME`; omitted flag and wrong-home regressions |
| Reasoning configuration survives version changes | Generated native `ConfigReadResponse` schema; required current choices before runtime promotion, schema-driven future values, per-launch descriptor checks and removed-value fallback regression |
| Missing CLI, changed CLI, old and new agents together | Discovery fingerprints, asynchronous observer, runtime selection, real child-process replacement test, PTY and headless lease regressions |
| Known-bad release, previous validated fallback | `codex_runtime_fallback` signs a real test policy rejecting current 0.161 and proves selection of previous 0.160 |
| Offline, corrupt manifest, atomic updates, rollback | `compatibility.rs` signature/schema/revision/cache tests, eight-revision retention and same-revision corrupt-cache recovery |
| Immutable owned runtimes and active-session retention | `managed_runtime.rs` receipt/hash/pointer/lease tests; active snapshot and staging retention; corrupt-current recovery |
| Native installation and credential preservation | Global installations are read-only; snapshot layout contains distribution files only; managed profiles and account auth stay canonical |
| Native npm wrapper parity | Snapshot-local package root and package-manager marker; real auth child environment regression; Windows nested and macOS hoisted npm layouts |
| Safe binary change detection | File identities plus metadata, nested native/helper fingerprints, equal-size replacement with restored timestamp regression |
| Fast repeated launch | Metadata/cache-only warm selection, single-flight probes and zero extra subprocesses on a cache hit; PTY/auth may use a validated direct process, while multi-turn headless sessions require an immutable pin |
| Missing-global managed runtime remains usable | Separate `managedRuntime` readiness; registry, Threads, KalVoice, health and frontend regressions keep native detection truthful |
| Asynchronous readiness reaches an open form | New Thread refreshes cached choices on provider readiness events while preserving the user's draft and selections |
| Shared architecture | Generic policy, owned runtime store and registry observation; provider-specific probing and Cursor calendar-version parsing stay in adapters |
| Remote data is never executable | Domain-separated Ed25519 JWS, strict schema, fixed HTTPS endpoint, trusted embedded public key and disable-only policy overrides |

## Review-driven repairs

Independent reviewers found and the implementation repaired: lease acquisition versus pruning;
path-check/open races; abandoned staging retention; timestamp-preserving binary replacement;
known-bad current runtime masking a valid previous snapshot; corrupt policy cache preventing a
valid same-revision repair; missing native wrapper environment; insufficient interactive and Plan-mode flag
checks; malformed version prefix acceptance; fallback hidden by installation-only availability;
stale open New Thread choices; macOS npm symlink and hoisted package resolution; and a Cursor
calendar-version regression introduced by stricter shared SemVer parsing.

The cache protects remote signature/revision integrity. It does not claim to defend against the
same OS account deleting all application state or replacing its own executable installation.
Adding a separate credential-backed anti-deletion authority was rejected as unrelated to that
trust boundary. No provider security or account-authentication checks were relaxed.

Three new process-based unit cases were relocated into the existing guarded integration harness
because unit tests cannot manufacture production guardian admission. The integration harness now
also proves concurrent single-flight behavior and same-path replacement; coverage was preserved.
Existing opt-in real-provider/quota tests remain opt-in. The new credential-free real Codex
certification was explicitly executed on both supported platforms.

## Observed verification

- Windows provider library and all registered integration targets: **619 passed, 0 failed**;
  23 opt-in native/provider tests ignored in that default invocation (22 existing plus the
  new real-runtime certification, executed separately on both supported platforms).
- Windows desktop affected provider filter: **93 passed, 0 failed**; additional exact KalVoice
  managed-runtime readiness test: **1 passed**.
- macOS provider library and all registered integration targets: **604 passed, 0 failed**;
  23 opt-in tests ignored. Final changed capability units **5/5**, integration **6/6**, real
  official 0.161.0 selector **1/1**, and strict provider Clippy passed. The final 29-file
  provider snapshot manifest is `1c953a6c98efe8e536fdaf6d51ee9859a58419868bfe9432e728f512dcb84337`.
- Frontend touched aggregate: **94/94**, New Thread full file **19/19**, website provider
  copy **35/35**. Managed recovery rendered UI flows **2/2**; final copy reproof **1/1**.
  TypeScript and production desktop Vite build passed. Rendered recovery diagnostics and
  selectable Codex were visually inspected; slow supplementary diagnostics do not delay choices.
- Windows real 0.161.0 final selector: direct first-use validation **4.35 s**, background
  isolated snapshot preparation **16.74 s**, warm immutable selection **65 ms**. macOS: **1.04 s**,
  **17.69 s**, **15 ms**, respectively. Distribution copying does not block single-process
  PTY/auth launch; asynchronous startup prewarming absorbs cold validation when possible.
  Multi-turn headless sessions require a snapshot before admission so later turns cannot switch
  binaries; a cold snapshot miss performs this work off the UI thread.
- Distribution signer: **11 passed**. Declarative policy publication tooling: **5 passed**.
- Real official Codex 0.161.0: isolated initialize/account-read succeeded on Windows and macOS;
  production selector verified owned immutable snapshots on both platforms.
- Native smoke probes used fresh temporary homes, no user credentials and no model/inference
  requests. Global Windows Codex remained 0.161.0; global macOS Codex remained 0.160.0 while its
  0.161.0 proof used an isolated official npm prefix.
- The owner KalCode process and both Codex processes observed at preflight remained running.

The shared train identified a missing inventory registration for the new opt-in native
certification. Its reviewed entry and exact cross-platform ignore counts were added; no existing
test was disabled. The inventory audit reproduced the omission before the correction.

Combined-candidate release proof also caught account display incorrectly depending on launch
readiness for an outdated CLI. The account remains visibly signed in while launch readiness stays
false; existing outdated-provider and managed-recovery browser regressions passed independently
after this correction. A 21-worker frontend run timed out in three files; bounded unchanged-source
reproof passed all 11 cases, with initial failure evidence preserved and the other 286 passing
files retained. No timeout or assertion was weakened.

Exact combined-candidate CI subsequently found a strict desktop test lint (`cloned_ref_to_slice_refs`)
that the provider-only Clippy pass did not cover. The registry regression now uses
`std::slice::from_ref`; desktop all-target Clippy with `-D warnings` and the exact registry test
both pass. The same CI run exceeded the registered desktop-unit time budget twice and timed out
in unchanged website tests. The latter two files passed all eight cases on the exact candidate
with one worker. These timeout failures remain recorded; final merge evidence must establish a
green corrected candidate and may not treat the interrupted run as passing.

The subsequent integration review found a remaining observing-hook minor-version predicate,
unconsumed reasoning support, and two lifecycle gaps: cold headless sessions retaining a mutable
global executable path between turns, and initial fallback readiness reaching launch consumers
after native detection. The capability and immutable-session repairs are committed in
`f74b90af37a4af080b3dd361a87ff8c388f7190a`. The desktop repair shares initial managed readiness
only at a selected Codex launch boundary, keeps generic reads and unrelated providers nonblocking,
refreshes adapters after later installation changes, and retries transient failures on the next
bounded watcher cycle. The earlier signed candidate is retained as evidence and is not eligible
for publication.

Reasoning-schema reproof passed on actual Windows 0.161 and isolated official macOS 0.161;
schema-only probes also verified the installed macOS 0.160. Both native versions advertise an
open non-empty string, not a closed effort enum. The implementation retains those constraints
instead of turning the current UI choices into a ceiling. Probes use scratch home/config/cache
directories and exclude credential variables. Parser work, references, dialects, file reads and
process lifetime are bounded. Windows junction coverage executes without symlink privilege;
final-file symlink coverage remains conditional on that host privilege.

The immutable-session regression was independently reproduced in a detached worktree by reverting
only the headless selector call to its former mutable path. The original session's second turn
reported `new-runtime` instead of `old-runtime`. The corrected Windows and macOS tests both prove
cold pinning, immediate last-known-good selection during an update race, background adoption of
0.162, a new session on that runtime, and the original session still on 0.161. Compatibility **6/6**,
recovery **1/1**, and headless pin **1/1** passed on both platforms; Windows turns **14/14** passed.
Strict provider all-target Clippy and the **27/27** suite-inventory tests passed. The new opt-in
credential-free native hook certification is registered explicitly; no existing test was disabled.

The optional hook probe verifies the native six-event session-flag/trust contract without a model
turn. Windows real 0.161 passed with independently measured warm cache p50 **1.84 ms**, max **2.33 ms**;
macOS native 0.160 and isolated 0.161 passed with launcher p50 below **0.5 ms**. Timeout/child reaping,
scratch cleanup and binary replacement regressions pass. A separate bounded loopback fixture drove
the actual native hook lifecycle on Windows and macOS, including a declined approval and an
interrupted turn. Those synthetic model responses stayed on localhost; external and paid model
requests were zero. Existing provider approval decisions remain authoritative.

Nine focused desktop regressions cover readiness fanout, later adapter registration/removal,
unchanged-installation retry, selected Codex versus unrelated-provider admission, canonical
KalVoice provider/account/context precedence, and the account/model schema fixture. Independent
review caught and repaired an overly broad initial wait, a missing later refresh, a retry-starvation
case, and account-identity ambiguity introduced by transient readiness. The final implementation
uses one canonical inference routine and never chooses a different account because Codex is still
warming.

Final desktop all-target Clippy passed with `-D warnings`. The parent independently replayed
all nine focused regressions against the executable built from the frozen final source: **9/9
passed**, with individual logs in `target/evidence/provider-compatibility-focused-f74b90af`.
An intervening shared-target rebuild failed with ENOSPC, and a database-backed replay failed
with SQLITE_FULL before its product assertions. Those attempts were not counted as passing;
after disk space became available, the complete focused replay passed without rebuilding or
changing source. Warm Cargo caches and all active user processes were preserved.

The existing launcher spinner acknowledges immediately. In the missing-global/last-known-good
startup case, the persisted pane appears after the necessary local readiness check; this repair
does not introduce a deferred pane-identity system. A normally installed compatible Codex receives
no added readiness wait, and no user interaction waits on a remote compatibility lookup.

## Rollback and delivery

No database migration, credential migration, personal-memory mutation or archive import is
required. Runtime snapshots and policy caches are additive and separate from account profiles.
Code rollback uses a revert PR and a newer signed internal build. Policy rollback republishes
the previous declarative content under a higher signed revision; never lower the production
revision or mutate the user's global CLI.

Merge and shipping use the shared train and current public version. This source evidence does
not itself certify production delivery: the release identity, signed platform artifacts,
production feed and updater receipt must establish that separately.
