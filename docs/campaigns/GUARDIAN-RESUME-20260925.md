# Provider guardian resume evidence — 2026-09-25

Status: implementation integrated in the working tree; final campaign/release certification is
owned by the integration lead.

Starting commit: `35c99cb43699813c8aba58e1fead6a5cd536076b`

Canonical worktree: `.worktrees/sec-harden`, branch `sec/providers-harden`.

## Authority and invariants

The provider guardian is the process-lifecycle authority below the account runtime coordinator.
One desktop generation owns one guardian authority. Profile identity binds provider ID, account UUID,
and profile generation. Process identity binds PID to Windows creation time so PID reuse cannot satisfy
a root-process commit.

Admission is closed before cleanup starts. `seal` rejects both new profile leases and later
`PREPARED` job transitions. A job belongs to the generation from the moment its `PREPARED` marker is
durable, including when no root process was committed. Draining terminates every registered job,
queries each authoritative Job Object until its active process count is zero, durably records `CLEAN`,
and only then returns the opaque generation proof. Any I/O, marker, process-query, identity, or state
ambiguity retains blocked authority and prevents replacement.

Markers contain no command, arguments, environment, profile path, credentials, tokens, or provider
output. IPC frames are length-bounded before allocation and bind protocol version, a pipe-only nonce,
desktop generation, exact sequence, and request ID.

## TDD evidence

The first focused run failed before production code existed:

```text
cargo test -p kalcode-providers --test guardian_contract --no-default-features
error: couldn't read crates/providers/tests/../src/guardian/mod.rs (os error 3)
```

After the bounded protocol, marker, durable store, authority, Windows platform implementation,
out-of-process supervisor, and canonical launcher wiring:

```text
running 3 tests
test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
```

Covered behavior:

- 1 MiB frame limit before allocation; exact nonce, generation, version, and monotonic sequence.
- Unknown schema/state and corrupt JSON fail closed.
- Profile and job object swapping fail without mutating state.
- Shared and exclusive capabilities follow closed arbitration rules.
- `PREPARED`, `RUNNING`, `QUIESCING`, and `CLEAN` transitions are one-way and non-replayable.
- Two-slot durable storage refuses to fall back to an older `CLEAN` record after a torn newer slot.
- Generation sealing rejects new leases and late `PREPARED` work.
- Draining includes rootless `PREPARED` jobs and persists `CLEAN` before returning proof.
- Failed job-count proof produces `BlockedUnclean` and no clean proof.
- A real named Windows Job Object is opened by a second owner before launch; the provider fixture is
  created hidden and suspended, assigned before its first instruction, terminated, and polled to zero.
- A separate hidden guardian process retains that second Job Object handle. Closing the simulated
  desktop owner and authenticated pipe makes the guardian terminate the provider, prove zero active
  processes, and exit successfully.
- Deserialized profile/provider identities and PID creation times are revalidated rather than trusted.

Additional verified behavior:

- Guardian jobs are committed only after creation-time assignment. Ordinary provider processes use
  the retained original process handle; ConPTY commits a PID plus creation time read from its
  retained child handle and the supervisor reopens and verifies both exact birth time and membership
  in the prepared job.
- ConPTY uses `PROC_THREAD_ATTRIBUTE_JOB_LIST` for the external guardian at process creation, then
  attaches its local kill/wait job. The exact same valid `ProgramSpec` was exercised guarded and
  unguarded; `conpty_root_is_atomically_admitted_to_the_external_guardian_job` passed.
- Provider installation and authentication probes use the runtime-owned `internal_probe` subject;
  ordinary terminals use `internal_terminal`. Neither identity is an AccountStore row or selectable
  provider account.
- Production desktop construction uses `ProviderRegistry::installation_only_guarded`. Thread
  provider metadata is the guarded registry's cached detection and cannot start an unmanaged
  process in release builds. Debug/E2E fallback remains explicitly test-hook scoped.
- KalVoice's legacy split provider/config methods fail closed. Its atomic `provider_session` resolves
  the active workspace/default account, performs launch policy checks, constructs the managed
  adapter, and writes that exact account ID into `SessionConfig`; concurrent config construction was
  regression tested. The current KalVoice orchestrator uses local interpretation and does not invoke
  provider reasoning, so this interface is integrated for native compatibility but is not claimed as
  a live KalVoice cloud-reasoning call path.
- Marker slots are opened relative to one retained, non-reparse directory handle. Reparse-backed and
  multiply-linked slots are rejected before truncation, and restart, torn-write, reparse, and hardlink
  behavior has deterministic unit coverage. Marker files are never loaded as production authority;
  only the live external helper's zero-process result can create a typed clean proof.
- Restart exclusion uses two independent byte-range leases opened through that anchored directory.
  `desktop-epoch.v1.lock` is shared by `GuardianRuntime` and `GuardianInner`, so authority/job clones
  retain it and killing the helper cannot admit a replacement while the old desktop generation is
  live. `helper-drain.v1.lock` is acquired by the helper before its health handshake and retained
  through termination, zero-count proof, and Job Object drop; a replacement helper waits for that
  drain (bounded to 15 seconds) before it can expose a new authority.
- `helper_hard_kill_cannot_release_a_live_desktop_epoch` proves a live provider remains owned by the
  desktop's Job Object handle after forced helper death and a same-root replacement is denied.
  `replacement_helper_waits_for_prior_helper_drain_after_desktop_loss` proves a new factory cannot
  return while an old helper retains its drain lease. If both owners crash, Windows
  `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` terminates every associated process when the final job handle
  closes before destroying that job. Lease disappearance never fabricates or returns a historical
  `GenerationQuiescenceProof`.

Focused commands run at the final source checkpoint:

```text
cargo test -p kalcode-providers --test guardian_supervisor --no-default-features -- --nocapture
test result: ok. 7 passed; 0 failed

cargo test -p kalcode-providers --test guardian_contract --no-default-features -- --nocapture
test result: ok. 6 passed; 0 failed

cargo test -p kalcode-providers --lib --no-default-features guardian:: -- --nocapture
test result: ok. 10 passed; 0 failed; 195 filtered out

cargo check -p kalcode-desktop --lib --features e2e --jobs 2
Finished dev profile successfully (three unrelated pre-existing dead-code warnings)

cargo test -p kalcode-desktop --lib --features e2e concurrent_provider_configs_keep_their_selected_account -- --nocapture
test result: ok. 1 passed; 0 failed

cargo build --locked --profile release --package kalcode-providers --bin kalcode-provider-guardian
Finished release profile successfully; clean/no warnings on the incremental final rebuild
```

## Residual limits and campaign-owned proof

- The unkeyed marker checksum detects torn/corrupt writes but is not an authentication primitive.
  Marker contents cannot mint a clean proof and production never loads them as authority. Same-user
  denial of service against the marker directory remains possible and fails closed.
- The final integration writer still owns the complete desktop/workspace suites, package signature
  and installed-helper verification, crash/restart live probes, audited staging, commit, and release
  gates.

No provider, network, paid service, production profile, owner memory, or credential was accessed.
