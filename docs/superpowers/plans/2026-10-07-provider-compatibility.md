# Provider compatibility implementation plan

**Goal:** Normal Codex updates keep managed accounts and coding terminals usable without a minor-version whitelist.

**Starting commit:** `0297e87fe0bc144e07e80c7c10180a74a0800c84`.

**Architecture:** Retain canonical provider discovery, guarded process supervision, managed profile isolation, and PTY ownership. Replace Codex's version window as a launch authority with semantic version classification and bounded adapter probes. Share declarative compatibility policy and owned runtime recovery infrastructure across adapters. Existing processes retain their runtime; changes affect subsequent launches only.

**Constraints:** Never mutate global provider installations or credentials. Never stop the owner's app or terminals. Remote policy is signed data, never code, and cannot grant unproven capabilities. No remote lookup on the UI/startup critical path. Keep platform-specific verified minimum constraints only where required by real behavior. Shared merge train and current-version signed release remain authoritative.

## Tasks

- [x] Reproduce installed stable 0.161.0 rejection and add failing regression.
- [x] Implement semver classification and cached Codex capability descriptor/probes; cover stable drift, prereleases, malformed/missing CLI, removed capabilities and binary replacement.
- [x] Implement shared signed compatibility policy/cache and owned last-known-good runtime recovery; cover offline, corruption, known-bad entries, atomic updates and rollback.
- [x] Integrate authentication, launch, diagnostics and current documentation; remove routine-drift blocking and downgrade instructions.
- [x] Verify active old runtime alongside new launches, Windows and macOS, and focused rendered product behavior.
- [ ] Independently review exact diff, run relevant gates, submit PR to shared train, ship and verify production update delivery.

## Evidence and review focus

Installed `codex --version` reports `codex-cli 0.161.0`. Current `VersionWindow::supports` compares exact major/minor against an array ending at 0.160; `require_managed_version` rejects before capability negotiation. Build metadata is also wrongly excluded by the empty-suffix check. Two existing Codex PIDs were observed read-only at preflight; no stop/restart action was taken.

Review boundaries: profile-home isolation, required security flags/config, changed launcher targets, concurrent probes, invalid signed-policy rollback, fallback preserving account/session/config identity, and honest unsupported-capability diagnostics. Capability detection must not silently grant absent behavior or weaken provider security.

## Ownership

Core adapter worker: Codex module, Codex compatibility probes, semantic-version parser. Parent: integration and documentation. Read-only audits: launch/cache/session lifetime and manifest/runtime/release infrastructure. Additional bounded ownership is recorded in task messages before writes.
