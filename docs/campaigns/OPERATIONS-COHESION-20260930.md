# Operations cohesion

Owner scope: connect Runs, Queue, Services, Environments, and Activity through the existing
Operations model. Claude owns release integration and shipping; this packet is isolated from
the shipping checkout on `fix/operations-cohesion`, starting at
`1186f335bfcc877ed84756ec7fb62372ac2cfcbe`.

## Contract

- A queued operation retains its identity through claim, execution, completion, and history.
  Every active item in Queue's Now column opens that same run, including the fifth concurrent
  item allowed by the existing scheduler.
- Run details join services, environment outcomes, and Activity by both workspace and run ID.
  Current observations refresh from the shared snapshot. Historical relationships must remain
  distinguishable from current process or endpoint health.
- Artifact evidence must come from typed producer reports, never inferred from terminal prose.
- Activity must preserve the existing durable operation moments rather than replacing the
  preceding transitions with the latest status.
- Existing SQLite Operations records, operation moments, event records, terminal ownership,
  and service/environment projections remain authoritative. No additional database or queue
  is introduced.

## Validation and delivery

Initial UI regressions failed because Queue's active items were not navigable and run details
omitted linked services/environment/activity. A browser viewport regression also reproduced
the clipped evidence drawer before its flex/scroll correction. Intermediate verification passed
57 affected JavaScript tests, four browser checks, desktop typechecking, and 15 native Operations
tests. These counts will be superseded by the final combined results below.

Independent review identified the four-card Now truncation, missing newer-deployment-failure
notes, misleading empty-state copy, lost historical relationships, absent command artifact
reports, and lifecycle Activity being reduced to latest status. Follow-up review reproduced
collapsed concurrent same-command services, deployment/service claims being mistaken for
execution, and snapshot retention choosing creation order instead of execution recency.
Artifact review covered durable replay, canonical path deduplication, rejection visibility,
cleanup recovery, and avoiding repeated event queries for already-finalized runs.

Five specialists contributed: release readiness (read-only lane identification), canonical
lifecycle Activity, historical relationships, artifact production, and independent adversarial
review. Implementation remained in isolated worktrees, with combined integration and verification
owned by the primary agent. No agent modified the Claude-owned release worktree.

| Requirement | Canonical implementation | Proving coverage |
| --- | --- | --- |
| Queue becomes a Run | Existing atomic claim/bind plus Queue Now navigation | Store identity/concurrency tests; component and browser navigation |
| Runs expose outputs | Exact current/historical relationships; typed command artifact events | Relationship projection, real PTY artifact producer, replay/restart, run drawer |
| Activity reflects lifecycle and outputs | Durable operation moments plus typed event projection | Queue/start/finish native test; artifact provenance and evicted-run linkage |
| Environments follow execution state | Bound deployment/service evidence, execution-recency retention | Failed-launch denial, failed-deploy preservation, >200-record retention |
| One shared model | Existing OperationsStore, EventStore, runtime ownership and read projections | No added durable store or migration; exact workspace/run correlation tests |

Combined verification covers implementation commit `e9e3dfb20df013aae046367cd7200b43b7f7221c`
and test-only lint cleanup `894ed321`:

- `cargo test -p kalcode-contracts -p kalcode-native-core -p kalcode-utilities`: 630 passed,
  zero failed/ignored, across 11 nonempty suites. Contracts 274; Core 215 across eight suites;
  Utilities 141 across two suites. The post-cleanup rerun also passed.
- Desktop native `--lib operation -- --test-threads=1`: 36 passed, zero failed/ignored,
  407 outside the filter. Includes 15 coordinator tests, eight artifact tests, and observed
  runtime/account lifecycle tests. The artifact producer creates a real file through a real
  temporary-workspace Windows PTY and verifies its durable typed event.
- Affected desktop JavaScript: 59 passed across six files. Protocol: 68 passed across seven files.
- Operations Chromium: four passed (real UI against memory IPC), including axe, keyboard flow,
  current/historical relationships, evidence scrolling, and dark/light screenshots.
- `pnpm -r --if-present typecheck`: passed, including desktop, protocol, testing, UI, API, and
  website; website diagnostics covered 120 files with zero errors/warnings/hints.
- Biome checks on changed handwritten TypeScript/CSS and `cargo fmt --all -- --check`: passed.
  Generated protocol normalization produced 365 types without unexpected generated changes.
- Strict Clippy passed for desktop, contracts, native-core, and utilities with `--all-targets --
  -D warnings`; no lint was suppressed. The final native package rerun passed all 630 tests.

The Utilities unit suite grew from the observed 131-test baseline to 139. Added coverage is
additive; no existing suite, test, or assertion was disabled to obtain these results. Rust test
names and results are retained in the local `target/cohesion-*.log` files.

Owner-memory mutations: 0; archive imports: 0; paid provider calls: 0; production-store mutations:
0; customer/external action executions: 0. The native tests run only bounded local processes and
temporary files. Private/runtime files staged: 0. The added diff passed private-key/provider-token
pattern scanning and the forbidden-path check. This is bounded scanning, not a claim that generic
patterns constitute a complete secret detector.
No production publication or signed Windows/macOS upgrade is claimed by this document.
Windows native tests use temporary workspaces and real bounded local PTYs; browser tests use the
existing memory IPC fixture. The fixture is UI evidence, not a live production deployment.
macOS uses the shared model and its existing native process/PTY implementations, but macOS
runtime/signing verification remains part of Claude's release lane.

Native build verification initially exhausted Windows memory during parallel compilation. The
same build passed with `CARGO_BUILD_JOBS=1`. Combined compilation caught an immutable truncation
flag in the artifact detail merge; it was repaired without changing evidence limits. Strict lint
also required reducing the shell helper's parameter count: passing the existing Workspace object
keeps its identity and root together without a new abstraction or lint suppression. Final review
added a failing memory-runtime regression for an unbound claimed deployment and aligned that
fixture projection with native behavior.

## Compatibility and rollback

The public version remains 0.1.7; the inherited candidate is 0.1.7+2. This work does not change
release identities or migration 20. UI-only changes can be reverted independently. The existing
EventStore maps unknown event variants to `Unrecognized`, so older readers preserve and safely
read the new artifact rows; the reviewer rejected the suspected decoder/startup incompatibility.
A forward corrective build should retain artifact decoders to preserve their meaning. Never
delete persisted events as rollback. Migration-20 recovery remains forward-only as documented
in `docs/OPERATIONS.md`.

Source rollback reference: `rollback/operations-cohesion-20260930` at `1186f335`. Use a forward
revert/corrective commit that preserves subsequent work, not a reset or database downgrade.
The primary checkout's main branch and Claude's release checkout remain unchanged by this task.
Claude owns canonical integration and production signing/publication. Codex continued beyond the
initial handoff to assemble and validate an isolated combined checkout, resolve integration
conflicts, and repair failing gates. A handoff is not delivery. No owner credential or manual
action has been requested. Delivery truth remains unpublished until the final production build
and update feed have been verified.

## Broader CI follow-up

PR #46 triggered the registered hosted matrix. Dependency policy and dependency audit passed.
The first macOS job exposed an inherited updater test still calling the five-argument
`reconcile_after_cleanup` helper with four arguments. The test-only correction supplies
`startup_healthy = true`, preserving its existing successful-reconciliation assertions; independent
review approved this narrow compatibility repair. No updater production behavior changed.
The Linux job also reported pre-existing KalVoice Fn-key dead-code errors outside Operations.
Commit `6f12d65a` scopes the three native Fn adapters to Windows/macOS and allows dead code only
inside the reducer module on unsupported platforms; its shared cancellation/reset ownership
remains available. All 16 Fn reducer tests passed and independent review approved the target
boundary. Linux CI reproof is still required; no global lint setting changed.

## Resumed build and integration verification

At CI head `4aa9dab7`, run `36800899035` passed Windows workspace formatting, strict Clippy,
all workspace tests (2,576 passed, zero failed, 22 registered ignores, 127 result blocks), and
protocol freshness. The complete desktop Vitest suite passed 1,301 tests; the visual evidence,
website build/E2E, dependency audit, and dependency policy jobs also passed. These are genuine
results for that source revision, not a claim that the later candidate is already released.

Functional browser CI passed 264 tests and failed one inherited startup-message assertion.
Commit `fb030455` reuses the exact correction already present in Claude's release integration;
four focused browser checks passed. A local full-unit run under load passed 1,297 and timed out
four tests; all 16 tests in those two files passed when isolated. A subsequent serialized
registered frontend gate exceeded its unchanged five-minute deadline. After native compilation
finished, bounded six-worker execution passed the registered gate on the combined source:
1,306 executed, zero skipped, zero flaky. No assertion or deadline was weakened.

The macOS job exposed a real context-redaction idempotence failure. The first local correction
was rejected by independent review because splitting opaque values at internal equals signs
could miss secrets. It was never pushed or published alone. Corrective commit `f5678a08`
restores opaque-token detection and passes accepted format findings from the canonical scanner
to bounded prefix analysis. The worker's complete context suite passed 110 tests with one
registered performance ignore; an independent reviewer passed all 15 redaction-roundtrip tests.
Regressions include the original failure, internal-equals true positives, long values, delimiter
crossing, accepted fixed-format suffixes, and false-positive controls. Do not revert only this
corrective commit to its rejected intermediate parent; use a reviewed forward correction or
restore both redactor changes together.

The isolated `verify/operations-cohesion` branch in `C:/kc-ops-proof` combines Claude's integration,
this follow-up, and current main without modifying Claude's checkout. The merge forwards the
existing TerminalLimit through the artifact-report wrapper to the canonical terminal creator.
A denial regression proves no operation terminal, command artifact, or report is created when
the limit rejects execution. Combined native Operations tests passed 38/38; Operations and shell
browser checks passed 19/19; the frontend production build passed. Claude's schema-20 and
KalVoice-provisioning E2E corrections through `3d94d9ad` are included.

The combined release range also contains a film patch fixture with intentional CRLF payload
and blank unified-diff context markers. Independent review approved an exact-file whitespace
attribute; the fixture bytes remain unchanged and range diff-check passes. Secret scanning
identified one inherited deterministic credential-shaped rejection fixture in
`operation_inputs_are_bounded_and_never_persist_secret_values`. Independent review classified
that exact historical finding as synthetic; the scanner rule remains enabled.

Trusted-machine gate copies under ignored `target/operations-cohesion-gates` preserve the B12
checks, add the previously unexecuted permissions suite, and pin one exact candidate. Windows
uses one Cargo build job after a reproduced out-of-memory failure at higher concurrency. Mac
and Windows native gates, production packaging, publication, and installed-update verification
must have their own completed receipts before delivery can be claimed. The original B12
release infrastructure and production data remain untouched by this validation work.
