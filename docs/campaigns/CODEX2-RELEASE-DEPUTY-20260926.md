# Release deputy verification — 2026-09-26

This packet records bounded independent review, not production certification. The Primary Release Lead retains canonical main, integration, signing, publication and deployment authority. Three subagents were created and reused; the user's four-subagent lifetime limit applies.

## Reviewed snapshot and ownership

- Source: `68ca2f81e924f2b57091fec1f6c0e5ef379ba860`, `codex3/takeover-integration`.
- Deputy snapshot: `codex2/release-deputy-20260926`, `.worktrees/codex2-release-deputy-20260926`.
- Main at recovery: `ad4d073faea0a4800fbdd027b8f2fee87ff43752`; candidate has 131 additional commits and no main-only commits.
- All 20 newest branch heads examined were included or patch-equivalent in the candidate. Do not cherry-pick them again.
- Existing dirty worktrees and recovered root progress were preserved. In particular, `refs/recovery/codex3-root-progress-20260926` and `.worktrees/codex3-root-progress-preserved/RECOVERY.md` remain separate provenance, not approved release content.
- Fresh Primary Lead tests, native E2E repairs and `.worktrees/recovery-release-repairs` are excluded from deputy source ownership.

## Independent security and release review

### Account deletion

Reviewed the `db66730` deletion-proof repair as integrated in the snapshot. Destructive transaction statements require the live account/email/purpose/expiry proof and a per-call nonce. The caller requires a website session for that same account; billing/owner/checkout exclusions remain in force. Existing concurrency and stale-proof regression tests were inspected, not rerun. No actionable finding in this bounded review; this is not certification of all authentication flows.

### Mac verification and platform feeds

Four adversarial responses were injected into the actual `verifyMacRelease` verifier using its existing in-memory filesystem/process adapters:

| Input | Required and observed rejection |
| --- | --- |
| Accepted Apple log naming another submission | `notary_log_failed` |
| Accepted Apple log omitting `issues` | `notary_log_failed` |
| Debug entitlement `com.apple.security.get-task-allow` | `unsafe_entitlements` |
| Nested helper signed by another team | `codesign_identity_mismatch` |

Both the worker and lead ran `node target/mac-contract-review/probe.mjs`: four checks passed, exit 0. The lead also ran `node --test tooling/release/macos-verify.test.mjs`: 11 passed, zero failed/skipped, exit 0. This includes valid fixture controls. No Apple signing, submission, installation or native process was performed by these tests.

Reproduction and hash-bound results are retained in the deputy worktree's ignored `target/mac-contract-review/probe.mjs` and `evidence.json`. Reviewed source hashes:

- `macos-verify.test.mjs`: `c5895063db891ad8de5cb8e6195d1b4d85d3d686f469a3b9b0f3899c8aac9665`
- `macos-verify-lib.mjs`: `c09da52e7ffc2ead831401130f74d4c86da11a0b45d097ddd5e4f0113c0170ee`
- `macos-contract.mjs`: `7c50635ee21bca4ad3d0b196ff6604dbdb20e7bdc345fe8a76954a70be137c3b`

Source review found version/commit agreement across platform feeds and cryptographic target/channel binding. No new reachable bypass was established. The Primary Lead's later Mac tooling changes require their own verification.

### Evidence limits

- Windows installer verification installs the candidate as both the baseline and `/UPDATE` input. This proves same-version update-mode rehearsal, not migration from a prior released version.
- Read-only SSH identified the physical Mac as `arm64`, macOS `27.0`; the supplied `26.2` description is stale. Existing Mac source directories contain independent work and were not modified.
- Existing records of individual Mac binary signing do not certify an app, DMG, Apple acceptance or stapling.
- A deliberately nonsettling custom stream cancellation can exceed `boundedJsonFetch`'s timeout, but native Node 24.16 fetch cancelled promptly against stalled local HTTP responses. No native-production blocker was demonstrated; no speculative closeout change was made. Probe retained in repository-root `target/codex2-cancel-probe`.

## Handoff contract

- **Scope:** independent recovery inventory and bounded auth/Mac release security verification.
- **Branch:** `codex2/release-deputy-20260926`.
- **Commit:** this documentation packet; exact hash is recorded in `.worktrees/CODEX2-CLAIMS.md` after commit.
- **Base:** `68ca2f81e924f2b57091fec1f6c0e5ef379ba860`.
- **Files:** this document only.
- **What changed:** records current provenance, review results, commands and remaining evidence limits.
- **Focused tests:** four Mac rejection probes and 11 Mac verifier tests, all passing.
- **Broader tests:** not rerun by deputy; Primary Lead's fresh recovery gates remain their evidence and authority.
- **Security notes:** no credentials inspected, source authority changed or release controls relaxed.
- **Dependencies:** reviewed source snapshot; later source changes are outside this evidence.
- **Conflict status:** new documentation path; no primary-source edits.
- **Recommended merge order:** optional evidence-only packet; it does not replace a source repair or unlock a release gate.
- **Known risk:** no physical clean-install, microphone/provider account, live billing or production update certification is claimed.
