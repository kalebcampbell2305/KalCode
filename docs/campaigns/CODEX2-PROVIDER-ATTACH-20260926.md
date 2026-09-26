# Provider pane listener lifetime repair

The fresh primary workspace run on `68ca2f8` failed `managed_codex_panes_use_the_exact_account_policy_and_hold_the_lease_until_drop`: its fake-provider banner never appeared and the pane remained empty. A single isolated rerun of the original binary passed; that did not clear the failure.

Source investigation found independently reproducible view-count races. Before a view was registered with the PTY, and after it had been removed, the Codex cursor responder could still observe `views == 1` and decline to answer. Direct listener removal after registry replacement could also leave the original session counted. The fix ties the count to the listener's actual lifetime and original session.

## Integration handoff

- **Scope:** synchronize provider pane view counts with PTY listener registration/removal.
- **Branch:** `codex2/provider-attach-handshake`.
- **Commit:** `50c600744962a7526333aeeb01b57486b0d03dfc`.
- **Base:** `68ca2f81e924f2b57091fec1f6c0e5ef379ba860`.
- **Files:** `crates/providers/src/interactive/provider.rs`, new `provider_view_tests.rs` in that directory.
- **What changed:** a weak, listener-owned guard activates counting only after accepted replay under the PTY lock. Rejected delivery releases the count before returning; removal drops the guard exactly once. Explicit detach no longer separately decrements the count.
- **Focused tests:** three deterministic before-fix failures with three passing controls; final seven focused tests passed, including replay uniqueness. Parent independently reran the exact compiled test binary: seven passed.
- **Broader tests:** all 15 `interactive_cli` integration tests passed; provider library 228 passed with one existing ignored fixture; strict scoped Clippy, rustfmt and diff checks passed.
- **Security notes:** provider identity, account policy, credential isolation and permissions are unchanged. Ownership uses a weak reference to the original session, preventing a registry replacement from transferring accounting authority. Scheduling hooks exist only under `cfg(test)`.
- **Dependencies:** reviewed release candidate; independent of KalVoice repair `770b66c`.
- **Conflict status:** clean committed source worktree. `git apply --check` passed against both `codex3-takeover` and `recovery-release-repairs`, without changing either.
- **Recommended merge order:** after the release candidate baseline, this commit and `770b66c` can be cherry-picked in either order. Follow with integrated primary gates; evidence-only documentation can follow separately.
- **Known risk:** the original intermittent workspace failure is consistent with the repaired race but was not traced to that exact schedule. A separate source-review edge remains when the watcher runs before a view rejects the same cursor-query chunk; this packet does not certify every transport-loss handshake. No real signed-in provider, Mac execution or final release certification is claimed.

## Evidence and reproduction

Logs are retained in `.worktrees/codex2-provider-attach-handshake/target/`.

| Command | Result | Log |
| --- | --- | --- |
| `cargo test --locked -p kalcode-providers --lib interactive::provider::view_tests -- --test-threads=1` | Before fix: 3 failed, 3 controls passed | `provider-views-red.log` |
| Same command, final source | 7 passed | `provider-views-final.log` |
| `cargo test --locked -p kalcode-providers --test interactive_cli -- --test-threads=1` | 15 passed | `provider-interactive-cli.log` |
| `cargo test --locked -p kalcode-providers --lib -- --test-threads=1` | 228 passed, 1 ignored | `provider-lib-final.log` |
| `cargo clippy --locked -p kalcode-providers --lib --tests -- -D warnings` | Exit 0 | `provider-clippy.log` |

Tests pause real registry attach/detach boundaries and use a real helper PTY to observe the counter under the delivery lock. They do not use probabilistic sleeps to reproduce the race. Seven final tests include one child-process fixture entry point. The unchanged ignored test explicitly certifies an installed Codex CLI 0.157.0; it is not required to run these fake-provider fixtures.

Parent verification used the worker's compiled binary with SHA-256 `78c9a7d750a2f9765ba8dcc9026297698ce0e60a16b2b66ff7fbe51453d079d4`. Independently reviewed source hashes:

- `provider.rs`: `ed46c0a1a330ece1ba187812f706e851ff42a1a318d96a3d47c7a520e9caf62f`
- `provider_view_tests.rs`: `3de531bc04636405366f320d88732db3ed841574ad6838f7eb1fc06735ef0214`

Original-failure rerun evidence remains under the deputy evidence worktree's `target/provider-review/`; it is diagnostic evidence, not a before-fix clean gate. The primary full-workspace log remains authoritative for that failed run.
