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
Integration of this stacked follow-up into #41, conflict resolution against current main, the
registered release gates, signed Windows/macOS builds, publication, and production update
verification remain owned by Claude. No owner credential or manual action was requested by this
implementation pass. Delivery truth: implemented and locally verified; not published by this pass.

## Broader CI follow-up

PR #46 triggered the registered hosted matrix. Dependency policy and dependency audit passed.
The first macOS job exposed an inherited updater test still calling the five-argument
`reconcile_after_cleanup` helper with four arguments. The test-only correction supplies
`startup_healthy = true`, preserving its existing successful-reconciliation assertions; independent
review approved this narrow compatibility repair. No updater production behavior changed.
The Linux job also reported pre-existing KalVoice Fn-key dead-code errors outside Operations.
Current-main compatibility and any remaining release-lane baseline fixes must be reconciled before
claiming a green complete matrix or publication. The local results above do not assert that broader
CI passed.
