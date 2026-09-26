# KalVoice interrupted activation repair

An update could publish its verified component directory and then fail before activating its pointer. Subsequent loading and explicit retries both rejected the resulting history with `InvalidPointer`. The new install-only recovery path accepts a retry of that exact signed candidate, verifies the retained payload and full manifest again, validates the remaining history against the existing pointer, and completes the forward transition.

Ordinary `acquire` and `status` remain fail-closed until explicit retry. This does not automatically select an older revision, weaken the signed sequence floor, or add a new provisioning architecture.

## Integration handoff

- **Scope:** recover interrupted component activation without relaxing load-time rollback checks.
- **Branch:** `codex2/kalvoice-interrupted-install`.
- **Commit:** `770b66c3e3cb07c5ea6c566ba1b9f714c822af1e`.
- **Base:** `68ca2f81e924f2b57091fec1f6c0e5ef379ba860`.
- **Files:** `crates/kalvoice/src/component_store.rs`, `crates/kalvoice/src/component_store_tests.rs`.
- **What changed:** narrowly exclude only the exact verified, unreferenced candidate when validating the pre-activation history during an explicit install retry; all other pointer checks are unchanged.
- **Focused tests:** corrected regression failed with `InvalidPointer` before the fix; component-store suite 21 passed, one existing ignored fixture; parent independently reran the compiled regression successfully.
- **Broader tests:** full KalVoice library 242 passed, two existing ignored fixtures; strict scoped Clippy passed; `git diff --check` passed.
- **Security notes:** rejects older/newer candidates, changed signed metadata, expired tokens, wrong platforms, conflicting revision sequences, corrupt retained payloads and corrupt receipts. It preserves the exact prior revision. Independent source review found no actionable issue.
- **Dependencies:** current release candidate's signed component-store implementation; no other deputy commit required.
- **Conflict status:** `git apply --check` passed against both `codex3-takeover` and `recovery-release-repairs` after source commit. Neither target worktree was changed by that check.
- **Recommended merge order:** this source commit can be cherry-picked independently; evidence documents are optional and follow source.
- **Known risk:** load/status stays unavailable until the explicit exact-candidate retry. This packet does not prove automatic recovery, Mac execution, Whisper, microphone behavior or production provisioning. The original full release gates must be rerun by the Primary Lead on the integrated candidate.

## Reproduction and evidence

Evidence is retained under `.worktrees/codex2-kalvoice-interrupted-install/target/`. Builds used one Cargo job, the idle deputy `codex2-verification/target` cache, and a separate ignored TypeScript export directory. No primary build cache or source was changed.

| Command | Result | Log |
| --- | --- | --- |
| `cargo test --locked -p kalcode-kalvoice --lib explicit_install_retry_recovers_a_verified_revision_after_activation_failure -- --nocapture` | Before fix: public retry fails with `InvalidPointer` | `interrupted-install-red-corrected.log` |
| `cargo test --locked -p kalcode-kalvoice --lib component_store::tests -- --test-threads=1` | 21 passed, 1 ignored | `interrupted-install-green.log` |
| `cargo test --locked -p kalcode-kalvoice --lib -- --test-threads=1` | 242 passed, 2 ignored | `kalvoice-lib-final.log` |
| `cargo clippy --locked -p kalcode-kalvoice --lib --tests -- -D warnings` | Exit 0 | `kalvoice-clippy-final.log` |

The deterministic fixture uses the real staging/publication helpers, forces the actual activation helper to fail, reopens the store, and calls the public retry API. It simulates the interruption boundary; it does not terminate a running production app. The first fixture attempt failed during setup and is retained in `interrupted-install-red.log`; it is not counted as defect proof.

Existing ignored tests require an interactive OS credential store and a pinned local runtime archive. No ignores were added. Reviewed source SHA-256 values:

- `component_store.rs`: `41380216f85ccb30dd6dd28d504976225f1cbe53b6b88c6dc84d6da317e19252`
- `component_store_tests.rs`: `627b7e47fda3c2fe1bbd35bf61e0e96ab6d2da9f7b60a64a84c43473a71896da`
