# macOS native guardian recovery — focused proof passed, broader gate held

Branch: `codex3/macos-notary-null`, after packaging recovery `cbe58daae4f8a6b8b7bb2c357278862262b45057`.

This packet recovers sixteen source files from the preserved mac-integration working tree, plus the single existing-libc dependency edge in Cargo.lock. The adjacent JSON records original and recovered SHA-256 values, exact-byte copy results, unchanged-original checks, and hashes of the archives used for physical testing. No original worktree was modified. No private keys, credentials, runtime account data, or built artifacts were copied.

## Implementation and reviewed boundaries

- Per-job macOS custodians use private Unix socket pairs; the provider cannot inherit the desktop control descriptor. A separate trusted anchor owns a new session/process group and remains alive until the provider root is exactly reaped, preventing premature process-group reuse.
- The root waits for activation. The desktop verifies custodian/anchor/root process identity and topology, durably records RUNNING, then permits execution. PTY custody additionally establishes the controlling terminal and foreground group.
- Natural exit, timeout, and desktop control loss trigger group cleanup. A matching CLEAN frame and reserved-group absence are required before durable markers and account leases can be retired. Unproved cleanup blocks further admission.
- Pipe-based providers and probes retain their intended stdin/stdout/stderr behavior. PTY integration shares one completion operation between kill/wait paths. The vendored portable-pty addition only clones a close-on-exec Unix slave descriptor; existing Windows Job Object code remains intact.
- The shared admission/cleanup code preserves Windows behavior, but needs Windows regression verification after integration. Deliberate provider `setsid`/`setpgid` escape is outside the previously documented supported-provider custody contract; this is not an OS credential sandbox.

The comparison deliberately excluded two older Mac copies: native-core/workspaces.rs would remove the newer runtime-epoch guardian-owner release, and fake_provider.rs would remove provider-specific version fixture support. All other unchanged provider/account sources remain at the recovery base.

## Physical native evidence

Source: `~/Developer/KalCode-codex3-native-qa/source-cbe58da-guardian`; exclusive target directory: sibling `target`. Node/Rust tool paths were supplied explicitly. Cargo used `--locked --offline --jobs 1`. No existing Mac checkout/cache was overwritten.

Commands completed successfully on Apple Silicon/macOS 27/Xcode 27:

```text
cargo test -p kalcode-providers --lib guardian --locked --offline --jobs 1
cargo test -p kalcode-providers --test guardian_supervisor_macos --locked --offline --jobs 1
cargo test -p kalcode-pty --lib --locked --offline --jobs 1
```

Results: **18 guardian tests, 3 real native guardian/process/PTY integration tests, and 21 PTY tests passed**, zero failures/ignored in those focused runs. Real process cases covered natural exit, a TERM-resistant root plus same-group descendant, and a guarded PTY. Unit coverage includes buffered CLEAN after natural helper exit, mandatory proof after disconnected termination, partial-frame deadlines, durable markers and fail-closed recovery. This does not prove every desktop crash/account/login scenario.

Logs are `guardian-unit.log`, `guardian-integration.log`, and `pty-unit.log` in the exclusive QA root. Scoped Rust formatting and whitespace checks pass locally. The original native sources remained byte-identical at the final local check.

## Broader gate remains HOLD

`cargo test -p kalcode-providers --locked --offline --jobs 1` failed at its library suite: **149 passed, 54 failed, 1 ignored**. The reported failures reject managed-profile roots with `managed profile storage must not contain filesystem links`, arising under macOS's default temporary-directory ancestry. This is outside the recovered guardian source; the same managed-profile security checks are unchanged. There was also an inherited non-Windows unused-mut warning in the fake-provider fixture.

The next diagnostic step is a fresh run using an ordinary, explicitly isolated TMPDIR. That command **did not start**: SSH to the physical Mac timed out repeatedly before it could execute. Therefore this packet does not claim that alternate TMPDIR clears the failures, nor that full provider integration suites have run successfully.

Resume without changing security policy:

```bash
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
qa="$HOME/Developer/KalCode-codex3-native-qa"
cd "$qa/source-cbe58da-guardian"
mkdir -p "$qa/tmp"
export TMPDIR="$qa/tmp"
export CARGO_TARGET_DIR="$qa/target"
cargo test -p kalcode-providers --locked --offline --jobs 1
```

Retain the failing `providers-full.log`; resolve any remaining errors and run native clippy before release. The primary owns the Windows compiler slot; it should run provider guardian and PTY Windows regressions after harvesting this packet. No release or signing gate is cleared by these focused results.

## Essential Mac dependency queue

The following implementations are already in recovery base 63efef4; importing the older Mac branch wholesale would not improve them:

| Area | Existing source | Required next proof |
| --- | --- | --- |
| Microphone | kalvoice/audio.rs uses AVAudioApplication permission state/request and CPAL capture; signing overlay includes the audio-input entitlement and purpose text. | Actual first-use permission, denial/recovery, hold/speak/release, device change and sleep/wake with the signed app. |
| Browser | desktop browser_profile.rs derives per-root/workspace persistent WKWebView store UUIDs. | Real WKWebView cookie/storage isolation, restart persistence, removal, navigation and split/focus behavior. |
| Updater | updater/mac_swap.rs and desktop macOS installer/update-helper implement signature checks and sibling app swaps. | Native temporary-bundle swap tests, then signed staged-update, restart, rollback and wrong-platform rejection through the desktop. |
| Keychain | secure-store uses the OS credential-store backend and labels macOS Keychain. | Isolated synthetic-entry store/read/delete and failure behavior; account signout/restart proof without reading existing credentials. |
| Provider accounts | Shared account/profile code and Unix hook sockets are present. | Clear the broader native tests, then official provider auth/account isolation and desktop-loss/helper-loss cleanup. |

Merge source after the packaging packet and review the complete dependency closure. Physical QA, native full build, clippy, Windows compatibility, production signing/notarization, installer/update verification and publication remain separate required gates. This is preserved, focused-tested implementation with an explicitly held broader gate, not a shipped release.
