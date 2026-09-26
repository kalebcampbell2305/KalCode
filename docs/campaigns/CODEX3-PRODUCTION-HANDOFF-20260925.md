# Lead 3 production acceleration handoff

Lead 1 remains the sole canonical main writer, integration authority and release owner.
Lead 3 recovered main at `ad4d073`, preserved all dirty worktrees, and recorded live
ownership in `.worktrees/CODEX3-CLAIMS.md`. Main already contains download integrity
and web account/billing increments. Lead 2 owns diff, notification, locator, toast and
segmented-control repairs. Existing account/provider/KalVoice/browser, utilities,
Doctor, resources, Git, updater, signing, macOS and film work was not duplicated.

## Integration-ready increments

All implementation commits are on `codex3/release-gates`, worktree `.worktrees/codex3-release-gates`.
They are independent of the active product implementation branches. Cherry-pick the
commits below in listed order, or separately by scope; do not merge unrelated dirty
worktrees. Neither change builds, signs, publishes or deploys a product artifact.

### CI release manifest gate

- Commit: `6417827`.
- File: `.github/workflows/ci.yml`.
- Implementation: run the existing release-manifest and release-notes validator in
  the CI checks job. Previously the local aggregate gate ran it but CI omitted it.
- Focused verification: missing CI invocation reproduced before repair; valid
  manifest/notes fixture exits 0; invalid schema and missing release notes exit 1.
- Broader verification: real committed manifest passes; whitespace validation clean.
- Review: parent inspected the two-line diff and independently ran the actual checker.
- Risk/dependency: hosted GitHub Actions was not executed; no new dependencies.
- Release impact: invalid release metadata or missing notes now block CI.

### Performance evidence validation

- Commit: `728ae003fddf8d1a1228e233595e6fe5482027b2`.
- Files: `apps/desktop/tests/perf/check.ts`, `check.test.ts`,
  `lib/compare.ts`, `lib/compare.test.ts`.
- Implementation: reject non-finite/non-numeric measurements and baseline values;
  require units and valid improvement direction; reject baseline unit/direction
  mismatch. CLI rejects wrong-kind, wrong-platform and explicitly missing baselines.
  Existing optional default baseline and explicit `--no-baseline` behavior remain.
- Root cause: JSON converts non-finite measurements into null; JavaScript comparisons
  allowed null or NaN to pass absolute ceilings. Unchecked baseline metadata could
  suppress meaningful comparisons or silently disable a requested regression check.
- Focused verification: four comparison regressions failed before repair; three CLI
  metadata regressions returned success before repair. All 17 focused tests now pass.
- Broader verification: complete tooling test command passes 28/28 with no skips;
  scoped Biome, strict TypeScript with noUncheckedIndexedAccess, and diff checks pass.
- Independent review: no concrete defects; reviewer independently ran 17/17 tests.
- Risk/dependency: changes test tooling only; no desktop runtime or permission change.
  No new native performance measurements were taken on the busy shared machine.
- Release impact: invalid measurement evidence fails instead of claiming a green gate.

### Read-only CI security audit

- Commit: `1e73507`.
- File: `.github/workflows/ci.yml`.
- Implementation: replace the RustSec wrapper with pinned `cargo-audit 0.22.2`,
  installed with `--locked`, then run `cargo audit --file Cargo.lock` directly.
  The pinned wrapper has no reporting-disable option and attempts to create a GitHub
  check for informational warnings, causing HTTP 403 with the read-only CI token.
- Focused verification: actual installed audit version matches the pin; current
  lockfile exits 0 with seven existing warnings. A vulnerable smallvec 1.6.0 fixture
  exits 1 with RUSTSEC-2021-0003; patched 1.6.1 exits 0. YAML validation confirms
  read-only permissions, no error suppression and unchanged cargo-deny advisory gates.
- Parent verification: inspected diff and independently reran current lock audit
  against the cached advisory database, confirming exit 0 and seven warnings;
  independently reran both fixtures, confirming vulnerable exit 1 and patched exit 0.
- Risk: warnings remain, including glib RUSTSEC-2024-0429; this does not waive or fix
  them. Hosted CI needs an integrated rerun. Tool installation is not locally rerun
  because the exact pinned executable is already available.
- Merge order: after `6417827` if applying both CI commits; performance repair is independent.
- Release impact: audit failures reflect vulnerabilities or tool failures rather than
  an unnecessary GitHub check-writing permission. No write permission is added.

## Release audit: do not publish the older staging pipeline

Read-only snapshots of the active release candidates were taken under
`target/codex3-release-audit` in the root checkout. Six sec-harden suites passed
75/75 both in the worker and in the lead's independent rerun: publish-plan, signing,
guardian-packaging, release-build-contract, updater-signing and updater-manifest.
The snapshot files remained byte-identical to the owner files during the review.

The older `integration-stage` publisher has a P1 integration risk: differing builds
with the same version target identical immutable object keys, and public pointers
are unconditional writes. Its live-version guard checks equality only, so an older
version is not rejected. An isolated pure-plan reproduction confirms identical
keys for differing digests and identical public pointer destinations across versions.

The owner's newer sec-harden publisher already addresses these issues through
content-addressed objects and monotonic D1 pointer advancement. Integrate its matching
publisher, website Worker routes and migration as a coherent unit before publication;
do not reintroduce the older staging publisher. No second implementation was written.

Candidate SHA-256 identities:

| Candidate/file | SHA-256 |
| --- | --- |
| sec-harden `publish.mjs` | `F9919DC8758F0945B6ADA4B087D02669349439AFF86CC89B3E4875F221E1E2DF` |
| sec-harden `publication-safety.mjs` | `D1DCD82F5909C7DFD2884F537CDC46FFE2059B724E52219DA8111B09A288434B` |
| integration-stage `publish.mjs` | `8DD3027F8AFC2D3D4CE5A61AB4608C9F900F5246E5726697DBB79CA6D2B08534` |
| integration-stage `publish-plan.mjs` | `1A135850BEAC9A9DA01E42DEA945B2E1CFC2C3B3FEFDB97F14211F565CC2A4E9` |

Local reproduction: `node target/codex3-release-audit/integration-repro.mjs`.
Complete identities: `target/codex3-release-audit/snapshot-hashes.json`.
These ignored evidence files are local review artifacts, not release inputs.

## Limits and remaining authority gates

No signing, installation, release publication, deployment, remote D1/R2 mutation,
Mac SSH job, credential access or main modification was performed. Native-core
filesystem changes were already owned elsewhere; untouched secure-store inspection
found no confirmed defect. No speculative repair was made.

Lead 1 must rerun combined checks on the final integrated candidate, then complete
applicable signing, installer/upgrade QA, physical Mac QA, publication and live proof.
This handoff is integration-ready source and verification evidence, not a shipped claim.

## Follow-on macOS candidate audit

Mac owner source was snapshotted under `target/codex3-macos-audit`; no SSH or physical
Mac resources were used. Mac contract and verifier suites pass 16/16, independently
rerun by the lead. The combined channel suite passes 25/26: the Mac checkout retains
an older Windows build entrypoint without the early channel validation expected by
the shared channel test. This is an integration composition failure, not a native
Mac execution result.

Preserve the newer mac-integration contract/package/verifier files when integrating
sec-harden. They contain additional exact channel/source evidence and safer cleanup
after detach failure. The older sec-harden copies lack these owner improvements.

Potential P1: `macos-contract.mjs` rejects a matching `Accepted` notarization log
with explicit `issues: null`, aborting before stapling. The rejection is reproduced
by `node target/codex3-macos-audit/notary-null-repro.mjs`. Successful null-shaped logs
are corroborated by developer reports; no Apple-authored schema guarantee or actual
Apple-service failure was verified in this session. The active Mac owner should
accept explicit null or an empty array, with regressions still rejecting missing,
malformed or nonempty issues, wrong submission IDs, and non-Accepted status.
No parallel patch was applied to the owner's active files. Exact hashes, source
comparisons, evidence qualification and an unapplied patch suggestion are in
`target/codex3-macos-audit/AUDIT.md` and `snapshot-hashes.json`.

## Hosted CI census

Read-only inspection of main run
<https://github.com/kalebcampbell2305/KalCode/actions/runs/36197187293>
at `ad4d073` confirms main is not green:

- Rust on all three OSes fails the command decoder's `chunks_exact` lint. The active
  sec-harden source already uses `as_chunks`; no duplicate repair was made.
- Website E2E fails dock-tab focus. The active sec-harden test already scrolls the
  control into view and asserts initial focus; no duplicate repair was made.
- Biome reports 14 import-order errors, reproduced on the Lead 3 main-derived tree.
  All affected paths are already dirty and owned by sec-harden. A read-only spot check
  there found three remaining errors: PaneParts ARIA/format and ProviderPane imports.
- Native Windows E2E reports 19 failures connecting to CDP. The newer owner's harness
  and build-helper changes need final integrated hosted proof; no cause or fix is
  inferred solely from connection-refused output.
- The Rust audit wrapper fails while creating a GitHub check with a read-only token.
  It reported zero vulnerabilities and seven informational warnings first. Lead 3
  completed the separate CI reporting repair above; dependency policy and advisory gates remain.
- cargo-deny succeeds. Desktop UI is cancelled, so it supplies no passing proof.

Full downloaded logs are local evidence under `target/codex3-ci-audit`; no remote
workflow was triggered or changed. The repository remains private.
