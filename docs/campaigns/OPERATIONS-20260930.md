# Operations integration evidence

Status: implementation and verification in progress; not shipped.

Starting integration commit: `210715ec0a76067a14bc16d3401bf66ae7042e74` (`origin/main`).
Working branch: `feat/operations-services`, isolated from the owner's dirty main checkout.
Rollback checkpoint: `rollback/operations-20260930` at the starting commit. Do not reset later work to this checkpoint.
Policy-only commit: `bca19178`, requiring immediate shipping within the current public version.
Public milestone remains `0.1.7`; no owner-declared version change occurred.

> **Integration note (branch `feat/operations-services-integrated`).** This log records the
> original `feat/operations-services` work. When it was integrated onto the 0.1.7 build-revision
> line (PR #34), #34's canonical `X.Y.Z+N` build identity (N = commit count) replaced this
> branch's own build-revision work: the `0.1.7+1`/`0.1.7+2` candidate identities, the updater,
> macOS bundle, release-tooling and website version changes, the schema-20 recovery floor, the
> macOS forward-only rollback fence and the healthy-startup update gating described below were
> dropped. Statements below about those pieces describe the original branch, not the integrated one.

## Canonical ownership

`OperationsStore` extends the account's existing Core SQLite database with migration 20.
One record moves from queued work into execution and final history. Native Operations IPC owns
admission and consent, and delegates execution to the existing guarded PTY and provider-thread
runtimes. Services, environments and activity are projections of those records and existing native
process, event and Git evidence. The five UI tabs consume one shared snapshot and typed details.

Contracts: `crates/contracts/src/operations.rs`; native adapter:
`apps/desktop/src-tauri/src/operations_commands.rs`; store:
`crates/native-core/src/operations.rs`; projections: `crates/utilities/src/services.rs` and
`operation_evidence.rs`; UI: `apps/desktop/src/surfaces/operations`.

## Verification recorded so far

- Desktop final complete unit rerun: 144 files, 1,283 tests passed, zero failed (four workers), plus five identity script tests.
- Native coordinator focused run: six tests passed, including fourteen successive real PTY commands,
  durable final log retrieval and bounded terminal-tab retention.
- Browser Operations suite: four Chromium tests passed; keyboard, drag ordering, queue-to-run transition,
  service actions, history pagination, accessibility and empty states. Dark/light screenshots inspected.
- Operations UI/client/model/polling/memory tests: 23 passed; Stable shell neighbors: 28 passed.
- Core package final rerun: 206 passed, zero failed or ignored, including 19 Operations tests and 17 upgrade/persistence tests.
- Services tests: seven passed; complete Utilities package passed 128 tests.
- Provider thread runtime: 45 tests passed, including explicit durable agent-turn completion.
- Test inventory: 19 tests passed after increasing the functional UI floor from 262 to 265.
  Three new functional tests and one separately tagged screenshot test account for the increase.
- Native command capability registration passed: 219 commands and one debug/E2E-only test hook.
- Protocol: 68 tests passed. Desktop production frontend build and typecheck passed.
- Desktop native final library run: 417 passed, zero failed, one pre-existing ignored latency test.
- Real Windows Operations E2E: one test passed in 34.3 seconds; dependency execution, local
  service stop/restart, logs, history, application restart, and no replay.
- macOS packaging/version targeted tests: 47 passed. Physical Mac packaging remains open.
- Dependency audit: zero vulnerabilities at every severity after the narrow Undici patch override.
- Updater signing-key availability check passed; no key material was printed.

The first fresh full desktop JavaScript run exposed an eager fixture workspace read during a
startup-error scenario and the newly increased native E2E inventory. Both were repaired with
regression coverage. A concurrent command-palette timeout did not recur in the focused or full
rerun. The full native desktop run exposed a transient terminal-exit persistence race; the
focused repair and subsequent full native rerun passed. A later full JavaScript run passed
1,282 tests and hit one five-second KalVoice test timeout; the unchanged suite is being rerun
with bounded workers and all 1,283 passed. The new StrictMode polling regression accounts for that total.

These are individual proving runs, not a declaration that every release gate has passed. Final
full-suite, macOS, immutable-candidate, signing, update installation and production proofs remain open.

## Defects found and repaired during implementation

- Idle provider threads did not identify successful turns: added the canonical `agent.turn_completed` event.
- Queued default provider accounts could drift: canonical selection is resolved before confirmation.
- Consent lacked an expiry and revision binding: it now binds the exact normalized task, account epoch,
  workspace Git revision and a thirty-minute deadline; restart never restores consent.
- Finished Operations terminals exhausted the workspace tab quota: output is retained in the run and
  only four recent finished Operations terminal tabs are retained per workspace.
- Crash recovery discarded definitive terminal exit evidence or lost the start/bind association:
  recovery uses exact durable identities and outcomes and never replays execution.
- Cross-workspace dependency removal could poison startup: missing dependencies remain explicit blockers.
- Tool/Doctor detail correlation could omit or mix evidence: projection tests require exact source identity.
- Restart could stop a healthy service before queue admission: the successor is reserved before stopping.
- Binary output could expand beyond the log limit: output is bounded after UTF-8 decoding and redaction.
- Probe failure could imply no service existed: incomplete observations are explicitly unavailable/unknown.
- Windows desktop unit executables lacked Common Controls v6 activation: a debug-only MSVC manifest
  now permits the real test harness to start. Production signing/resources remain with Tauri.
- A paused, already-started agent was classified as pending in the UI: it remains in Runs and
  Queue Now and cannot receive pending-only edit/reorder actions.
- Live logs could stop refreshing when only output changed: detail refresh follows observation
  timestamps, coalescing concurrent requests rather than relying only on the queue revision.
- Secret-shaped environment-variable names passed identifier checks: the shared scanner now rejects
  them before persistence and withholds them from inherited-name projections.

The independent reviewer retracted the proposed cross-environment contamination finding after
verifying that the caller already filters by both workspace and environment.

## Shipping and continuity

GitHub authentication and Actions execution are restored. The observed unrelated CI run executed
Windows/macOS/Linux jobs; it later ended cancelled. Its validation failures included dependency
advisories, a yanked Rust dependency, a Linux lint issue and an outdated test-count assertion.

Installed updater comparison supports numeric build metadata (`0.1.7+N`). Continuous-build publication
validators and public presentation are being aligned without changing the signed v2 feed schema or
overwriting immutable releases. A real legacy macOS upgrade remains a required compatibility gate.

No production deployment, paid provider call, owner-memory import, production database mutation,
or secret/private-file staging has been performed by this workstream. Local synthetic test stores
and bounded test processes were used. No main-branch push or merge has occurred.

Migration 20 is additive. Preserve its database and migration backup. Prefer a forward code revert
that understands schema 20; testing an older binary requires a verified pre-migration clone, never
deleting current user data. Historical log storage has per-run bounds but no automatic deletion
policy. Remote deployment commands are not proof of live service health; missing evidence stays unknown.

The first workspace-wide all-targets Clippy pass found six `expect_used` diagnostics in new
Operations test helpers. Narrow existing-convention test-helper allowances repaired these diagnostics; all-targets native-core Clippy and all 19 Operations tests passed afterward.

Fresh registered tooling suite: 426 executed, zero skipped/flaky. API: 34 files and 293 tests
passed with unchanged timeouts. All workspace typechecks passed after adding the required new
agent-turn event to the exhaustive shared test fixture; its 24 tests passed.

## Requirement evidence map

| Requirement | Canonical implementation | Current proof |
| --- | --- | --- |
| Runs and details | OperationsStore, operations_commands, operations_observed, OperationsPage | Store/coordinator tests; Windows native execution/log/history/restart E2E |
| Queue and dependencies | Same records, transactional claims, revisions, consent, dependency graph | Concurrent claim/order/recovery tests; browser reorder/actions; native dependency execution |
| Services | Existing guarded PTY owner plus utilities/services platform probes | Windows native discovery, stop/restart and logs; shared native unit tests; macOS physical proof pending |
| Environments | operation_evidence projections from deployment/service records | 13 evidence tests including failed deploy preservation, unknown health and secret-free variable presence; browser states |
| Activity | Shared event/run/Git evidence projection and heatmap | Exact correlation/path redaction tests; browser filters and accessible heatmap |
| Current-version delivery | +N strict version identity across updater, publisher and website | Updater/protocol/tooling/website tests; signed legacy upgrade and production delivery pending |
| Permanent policy | AGENTS.md imported by CLAUDE.md | Also merged independently to main in PR #33, commit 93adddb244e6c687c2948e01d2bdccfe1ada3ab5 |

Final browser functional suite: 265 passed in 3.4 minutes. Visual suite: 56 passed in 3.9 minutes;
no baselines changed. Full workspace Clippy with all targets and warnings denied passed after
narrow test-helper repair. Shared registered package suites passed: protocol 68, UI 68, testing 24.
A candidate-source credential scan reported only intentional synthetic redaction fixtures in the
Operations store/evidence tests; these are not credentials. Runtime artifacts are excluded from
staging. No personal memory or historical archive was imported or mutated.

Specialists used: Operations store, runtime, services, evidence, UI, independent adversarial review,
continuous shipping, build revision compatibility, website revisions, and release gate repairs.
Their accepted findings and regressions are recorded above. The independent reviewer rejected
cross-environment contamination after tracing caller filtering, rejected unreachable same-ID
terminal recreation as an exposed replay, and preserved Later as explicit owner scheduling intent.

Registered website browser gates passed: website E2E 151 executed, eight existing profile skips,
zero flaky; checkout-enabled E2E three executed, zero skipped/flaky. Widget pointer checks 2/2
and shared primitive browser checks 4/4 passed. The first full Rust run found the permissions
migration inventory still ended at 19; adding the exact new `(20, operations)` entry preserved
its full-list assertion. All 36 permission tests passed; the full workspace rerun remains pending.

Final independent review confirmed a requirement gap after the first integration proofs: older
observed agent/tool runs beyond the recent snapshot could not be reached through Runs history.
The repair extends cursor-paged read projections and exact detail lookup over existing canonical
thread/tool/event authorities, without duplicating execution records. This repair is in progress;
previous test results do not certify its final implementation. The review also raised macOS
bundle-version/legacy-updater compatibility concerns; these are being reconciled against the
published legacy helper and the actual Developer ID packaging path before any release claim.

The full workspace Rust rerun completed with exit 0: 2,521 passed, zero failed, 22 existing
opt-in/physical/performance tests ignored across 127 test/doc-test executables. These results
precede the final observed-history and authenticated Mac identity bridge repairs and will not be
misrepresented as proof of those later changes. Registered website unit suite independently
passed 610 tests with zero skipped/flaky.

Final history repair verification: desktop native suite 430 passed, zero failed, one existing
ignored test; focused Operations desktop suite 18 passed. Canonical Store Operations tests 23/23,
Threads 97/97, and Core 209/209 passed, with the later shell-identity regression separately proved.
An independent reviewer verified exact paged history, per-turn suppression, event-sequence bounds,
and snapshot/history shell identity. Two transient integration defects (a shell lookup type mismatch
and an invalid staged-app fixture) were repaired and the affected tests rerun.

The continuous-build bridge now uses compiled native build identity, authenticates macOS bundle
identity before probing its executable, fences legacy application rollback before schema-20
migration, requires healthy Core startup before acknowledging an update, and refuses recovery
below schema-compatible build `0.1.7+1`. Updater tests 41/41, desktop updater tests 25/25,
pre-Core and legacy-helper fence tests passed; independent review found no material blocker.
Real macOS signing, notarization, helper execution, and production recovery are still required.
No safe database downgrade or automatic profile restoration is claimed.

The owner explicitly reaffirmed shipping the entire authorized change. Canonical source authorities
now identify production candidate `0.1.7+2`. Fresh combined Rust and desktop JavaScript verification
is running against this revision before the implementation commit and gated PR integration.

## Resumed audit, 2026-09-30

Recovered the canonical implementation on `feat/operations-services` at `bca19178`;
remote main was `3580a6b8ba23`. The older queue/runs worktrees are superseded partial work,
not additional implementations to merge. The owner's dirty main checkout remains untouched.

The first fresh workspace Rust run passed 2,547 tests across 127 executables, with zero
failures and the same 22 intentional ignores. Desktop unit baseline passed 1,285 tests.
Release checks passed branding, 219 native commands, zero-cost policy, and the current
two-platform manifest. Protocol/UI/testing packages passed 68/68/24 tests; website unit
tests passed 610. Dependency policy and both dependency audits passed their existing policies.
These results precede the additional audit repairs below.

Independent review confirmed and reproduced missing active-run cancellation controls and
unreachable older history when a workspace's recent snapshot is empty. The native cancellation
route already existed; Runs detail now exposes it only for active Operations-owned records.
History pagination remains reachable in the empty state. Four new UI regressions prove both
command/agent cancellation, observed-run denial, and older workspace history. The focused
Operations frontend suite passed 33 tests; four browser tests passed without changing baselines.

Activity attribution also used the latest shared thread/terminal run for older events. Two
failing regressions reproduced it. The repair prefers exact payload/run identities and requires
a unique valid execution time window for shared identities; ambiguous events stay unlinked.
Independent cross-review accepted this approach. The Utilities package passed 133 tests in
the specialist's isolated target; primary final reproof remains required.

Browser-fixture review found active cancellation missing from the memory transport and fixture
health claims stronger than native evidence. Two failing regressions reproduced these gaps.
Fixtures now distinguish observed processes from unprobed deployments and leave remote variable
presence unknown; cancellation preserves the run identity and records a truthful outcome.

The startup-ownership tooling assertion still searched for the old direct Core-open expression.
It now verifies the new rollback fence precedes Core opening while retaining context-recovery
and guardian-before-exposure assertions; its nine focused tests pass. Subsequent complete runs
exposed timing-only failures under concurrent release compilation (a 2-second hook budget and
5-second UI test budgets). No timing limits or assertions were relaxed; isolated reproof is pending.

GitHub Actions again refused to start because account billing or its spending limit blocks jobs;
retry attempt 2 of run `36784123323` also failed before execution. The owner was notified and
reaffirmed shipping. This does not turn the missing CI gate into a pass. The Mac host is reachable
and Windows updater signing-key readiness passed without exposing key material.

The released Mac 0.1.7 helper requires the feed identity to equal raw bundle short-version metadata.
The candidate's compiled build-identity bridge supports future updates but cannot change that old
helper's first-upgrade check. Actual Developer ID signing, notarization, and legacy upgrade remain
mandatory. Apple's documented short-version format alone is not evidence of notary rejection.
No production publication, provider call, private-store change, or public version milestone occurred.

### Additional independent review and reproof

The historical-detail regression reproduced loss of completion evidence after 5,001 newer
same-workspace events. Completed detail queries now apply the exclusive millisecond successor
of `ended_at` before the bounded query, preserving events at the completion timestamp. Primary
reproof passed all 12 native Operations tests and all 133 Utilities tests.

The complete desktop rerun passed 1,291 tests in 144 files; the complete tooling rerun passed
426 tests with zero failures or skips. The four Operations browser tests passed, including active
cancellation and truthful unprobed environment labels. The first updated browser assertion used
the wrong capitalization; correcting it to the existing `Not Probed` label preserved the assertion.
Fresh screenshots were inspected. These runs precede the remaining scoped review repairs below.

The final reviewer reproduced a workspace-filter change leaving the old run's cancellation
drawer open. A failing regression proved the stale drawer, and changing workspace now closes
it without cancelling anything. All 30 focused Operations UI/client/model/polling tests passed.
Further review identified stale service/run/environment fixture transitions and active agent
detail status diverging from snapshot status; these repairs remain under verification.

Remote main advanced to `b5a46bc760e55119b05c97e7027c260671867109` during this pass.
Its terminal-limit changes require compatibility integration; they are not silently included in
the preceding candidate test results. GitHub's newest checked run, `36792330052`, still reports
the account-payment/spending-limit refusal. No missing CI result is treated as successful.

The final bounded independent review accepted every scoped repair. Agent snapshot/detail now
reuse one active-thread projection with exact thread/workspace validation; completed durable
truth and cancellation authority are unchanged. Its regression covers Paused, WaitingForUser,
and WaitingForPermission. Primary reran all 13 native Operations tests successfully. The test
fixture shuts down the thread runtime before the resource governor, matching production order.

Memory service stop/cancel now finalize the owning run and update detail/activity evidence;
restart creates a distinct successor and rebinds process/service/environment evidence. All nine
memory tests and desktop typecheck passed. Unsupported preview-health success text and a
test-pass Activity record linked to queued work were removed. These are test-transport fixtures,
not claimed production observations. Reviewer rejected apparent console mojibake as an encoding
display artifact and found no remaining material scoped source defect.

Workspace Clippy with `--all-targets -- -D warnings`, all Rust formatting, five desktop identity
tests, generated-type normalization, diff checks, and Biome CI passed (two existing warnings,
one existing configuration information notice). The audited 175-path candidate contains no
private store, runtime artifact, or credential path. Secret-pattern matches are confined to the
reviewed synthetic security-test fixtures.

The registered production-speech Rust suite failed; direct diagnostic execution reproduced a
speech stalled-body timeout-test failure while unrelated long-running tests continued. The exact
same speech test binary passed that test in isolation, unchanged, in 14.22 seconds. Full-suite
success is not claimed from that focused pass. Final native E2E and frontend reproof are pending.

Source checkpoint `84a7c4e088be0d3baae49eaacbadae9cfcffe444` was pushed only to
`feat/operations-services`; draft PR 41 records all remaining gates. Final browser reproof
passed all four tests after replacing the obsolete fabricated test-success assertion with the
actual cancellation Activity outcome and explicit absence of the fabricated record.
The speech diagnostic completed with 298 passed, one failed, and two intentional ignores in
that package: the failed blocked-read duration was 6.9509094 seconds against 6.5 seconds.
The assertion and timeout remain unchanged. Other workspace packages after that failure did
not execute, so the production-speech suite remains open.
