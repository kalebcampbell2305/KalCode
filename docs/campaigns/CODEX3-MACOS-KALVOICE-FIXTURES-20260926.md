# Mac KalVoice fixture repair

- Scope: test-only trusted component directory permissions and fallible provisioning helpers.
- Branch: `codex3/macos-kalvoice-fixtures`, based on `13e3f775feb583e788e91b4f9cdb669730a5a93e`.
- Runtime source changes: none. Production trusted-directory validation remains unchanged.

The physical Mac desktop run on `2f61f64` failed eight KalVoice tests with
`UnsafeStorage`. Their temporary roots inherited a permissive process umask,
while the production component store requires owner-only directory permissions.
Existing lower-level component tests already explicitly use mode `0700`.

The shared test helper now applies `0700` to its newly created temporary root on
Unix before opening it as trusted storage. The two cache fixtures and the shared
provisioning fixture use that helper. Provisioning setup, signing, token creation,
and synthetic lock failures return errors to the test assertion boundary instead
of using helper-level unwraps. No production permission check or lint is disabled.

## Verification

- Before: physical Mac desktop run, 155 passed / 14 failed: eight storage fixture
  failures and six provider tests missing the separately built guardian helper.
- After: physical Apple Silicon Mac, isolated worktree, **174 passed / 0 failed**:
  `cargo test -p kalcode-desktop --lib --target aarch64-apple-darwin --features kalvoice-whisper --locked --jobs 1 -- --test-threads=1`.
- All eight storage failures passed. The six provider tests also passed with the
  real `kalcode-provider-guardian` built by the parent in the shared target.
- `cargo fmt --all -- --check` and `git diff --check` passed.
- Independent source review by the billing repair worker found no blocking issue.
- Full strict host Clippy remains part of the parent's integrated gate; this
  isolated packet did not run a second full native build on Windows.

Local evidence: `target/codex3-takeover/mac-desktop-tests.log` (before) and
`target/codex3-macos-fixtures/mac-desktop-green.log` (after). The Mac worktree is
`~/Developer/KalCode-codex3-macos-kalvoice-fixtures`; existing checkouts were not
overlaid. Tests use synthetic signed metadata and do not establish microphone,
model inference, signing, notarization, or installation QA.

## Integration

Cherry-pick the packet onto the candidate. No migration or runtime dependency is
introduced. The two `kalvoice_reasoning.rs` changes only adapt test calls to the
fallible shared fixture. Production behavior and model release artifacts are
unchanged.
