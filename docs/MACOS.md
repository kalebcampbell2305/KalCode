# KalCode on macOS

## Current truth

The repository has the canonical macOS Tauri overlay, least-privilege signing inputs, read-only
bootstrap, native-architecture DMG packager, fail-closed verifier, updater consumer and multi-platform
publisher. The physical Apple silicon Mac, Developer ID signing identity and `KalCode-release`
notarization profile are configured. Profile access was verified in the owner's GUI session; an SSH
session alone may lack access to the unlocked Keychain. No credential values belong in this document
or release evidence.

As of the September 27 release closeout, the separately signed arm64 KalVoice runtime archive has
an Accepted, issue-free Apple notarization result and has been published with signed manifests.
That component proof does not certify the application. The final production KalCode.app/DMG has not
yet completed build, notarization, stapling, Gatekeeper, clean-profile product QA or public delivery.
No macOS application download may be advertised until those gates pass. Detailed commit-bound test
results, failed attempts and current pending work are in
[campaigns/RELEASE-RECOVERY-20260926.md](campaigns/RELEASE-RECOVERY-20260926.md).

The direct-download target is macOS 14 or later. This is deliberate: the pinned Tauri 2.11.6 API
documents `data_store_identifier` as the WKWebView replacement for `data_directory`, and that API is
available on macOS 14+. KalCode's Browser promises per-workspace persistent isolation. The canonical
Browser now derives deterministic, root- and workspace-specific identifiers on macOS while retaining
filesystem directories elsewhere. Its pure identity tests pass; actual WKWebView cookie/storage
isolation remains a release gate. The target must not be lowered until an alternate design plus a
real, older-OS compatibility and isolation pass proves the complete product.

KalCode never guesses the runner architecture. `tooling/bootstrap-macos.sh` reads `uname -m`, and
the packager emits either an `arm64` or `x64` DMG with a matching single-slice executable. An arm64
artifact must be built and exercised on an Apple silicon lane; an x64 artifact must be built and
exercised on an Intel lane. Do not call an artifact universal unless `lipo` proves both slices and
every bundled native dependency has passed on both architectures.

## Local bootstrap

The default command is read-only:

```bash
tooling/bootstrap-macos.sh
tooling/bootstrap-macos.sh --check
```

It reports the safe OS/build version, native architecture, Xcode, Node, pnpm, Rust target, CMake, plist
validity, Developer ID Application identity count, and whether a notary profile name is configured.
It does not show certificate identities, hashes, serials, credentials, or private-key data.

The mutation path is explicit:

```bash
tooling/bootstrap-macos.sh --install
```

`--install` may activate the repository's pinned pnpm through an already-installed Corepack, add the
native Rust target through an already-installed rustup, and run the frozen-lockfile install. It does
not install Homebrew, Xcode, Node, rustup, CMake, certificates, or Apple credentials. Install those
through an owner-approved provider first when the check reports them missing. CMake is a development
build prerequisite for bundled local KalVoice STT; customers do not need a system CMake installation.

The bootstrap compiles a small C++17 probe against the selected macOS SDK. This catches Command Line
Tools installations whose libc++ headers are present in the SDK but absent from Clang's default
search path. The release packager binds `SDKROOT`, `CMAKE_OSX_SYSROOT`, and `CXXFLAGS` to that selected
SDK before compiling bundled KalVoice. For an unsigned manual development build, use the same values:

```bash
export SDKROOT="$(xcrun --show-sdk-path)"
export CMAKE_OSX_SYSROOT="$SDKROOT"
export CXXFLAGS="-isystem$SDKROOT/usr/include/c++/v1"
```

## Apple access

The release operator needs all of the following on an authorized Mac or protected macOS CI runner:

1. An active Apple Developer Program team and a **Developer ID Application** certificate with its
   private key in a temporary or login keychain. A development, Mac App Distribution, self-signed,
   or ad hoc identity is rejected.
2. A `notarytool` keychain profile backed by an App Store Connect API key with the minimum required
   role, or another Apple-supported notarization credential. The key/profile is created outside the
   repository.
3. These process variables, populated without logging their values:
   `KALCODE_APPLE_TEAM_ID`, `KALCODE_APPLE_SIGNING_IDENTITY`, and
   `KALCODE_NOTARY_KEYCHAIN_PROFILE`.

The team and identity must match exactly. The packager removes Tauri's standard notarization
credential variables from the build environment so the build cannot perform an unobserved automatic
submission. It signs during the Tauri build, then submits the exact staged DMG using the named
keychain profile and records the accepted submission before stapling.

## Package and verification

From a clean, immutable commit on the native Mac runner:

```bash
node tooling/release/macos-package.mjs --channel stable
```

The product channel is mandatory (`stable`, `beta`, or `dev`). The production package always includes `kalvoice-whisper`; additional safe Cargo features can be
specified with `--features`. The command builds only a DMG, requires the repository's explicit 14.0
deployment target and hardened runtime configuration, refuses `e2e`, uses the approved Developer ID
identity, waits for Apple to accept notarization, requires an issue-free notary log, staples the
ticket, and invokes the independent verifier. It writes architecture-specific build and verify
records under `dist/release/<version>/`. It never uploads or publishes anything.

To finish the signed app and DMG before supplying notarization credentials, use:

```bash
node tooling/release/macos-package.mjs --channel stable --build-only
```

This stage needs only `KALCODE_APPLE_TEAM_ID` and `KALCODE_APPLE_SIGNING_IDENTITY`.
It verifies the mounted app, every required helper, Developer ID signatures, hardened runtime,
entitlements, architecture, exact hashes, and the executable's production build-info response.
It leaves an immutable DMG in `dist/release/<version>/macos-<arch>-candidate/` and a sibling
`macos-<arch>-candidate.json`. The candidate is explicitly ineligible for publishing; no final
build or verification report is written. Gatekeeper and notarization remain pending.

After the owner configures `KALCODE_NOTARY_KEYCHAIN_PROFILE`, resume from the same clean source
commit with the same channel, native architecture and Apple team:

```bash
node tooling/release/macos-package.mjs --channel stable \
  --resume dist/release/<version>/macos-<arch>-candidate.json
```

Resume does not rebuild. It repeats candidate verification and binds the checkpoint to both the
DMG SHA-256 and the exact candidate JSON bytes. The Apple job ID is saved before waiting; a retry
reuses that job. Apple must report Accepted with an issue-free matching log. Stapling operates on
a disposable copy, preserving the signed candidate for retries. Only after the complete release
verifier passes are the final DMG and build/verify records exposed to the publisher. Repeating a
completed resume re-verifies the final artifact and can restore a missing evidence file.

A crash before Apple's returned job ID was recorded is intentionally ambiguous: reconcile that
submission through Apple before restoring its exact job ID in the checkpoint. Do not delete the
checkpoint to silently submit again. A process killed while running can leave a `macos-<arch>-notary.lock`
directory; remove only that empty directory after confirming no packaging process still owns it.
Unexpected existing artifacts, corrupt records, changed candidate bytes, or mismatched source/channel
fail closed. Do not edit a candidate record to bypass a mismatch. No credentials or raw notary logs
are stored in the checkpoint. The default command retains the complete build-and-notarize behavior.

The verifier can be rerun against the exact files:

```bash
node tooling/release/macos-verify.mjs \
  --artifact dist/release/<version>/KalCode_<version>_<arm64-or-x64>.dmg \
  --record dist/release/<version>/macos-<arm64-or-x64>-build.json \
  --output dist/release/<version>/macos-<arm64-or-x64>-verify.json
```

Verification stops unless all of these checks pass:

- the DMG is a plain file whose name, size, and SHA-256 match the exact build record;
- a read-only mount contains exactly one plain `KalCode.app`;
- bundle ID, version, 14.0 deployment target, microphone purpose string, and Mach-O architecture
  match the record;
- strict deep code-sign verification finds one timestamped Developer ID Application authority,
  the expected team, the KalCode bundle identifier, and hardened runtime;
- signed entitlements contain only `com.apple.security.device.audio-input=true`;
- Gatekeeper accepts the mounted application and the exact DMG;
- `stapler` validates the ticket on the exact DMG; and
- `notarytool info` and the full log still identify the recorded accepted submission with no issues.

Command failures are redacted. Build and verification JSON intentionally omit certificate subjects,
private-key material, credential values, and notary logs.

The macOS overlay enables hardened runtime and only Apple's audio-input entitlement. `Info.plist`
explains KalVoice microphone use. App Sandbox is intentionally absent because KalCode opens
owner-selected workspaces and starts owner-selected developer tools; enabling it without a complete
capability redesign would break the product. Runtime exceptions such as `get-task-allow`, JIT,
unsigned executable memory, DYLD variables, and disabled library validation are not granted.

Apple requires Developer ID distribution builds to use hardened runtime, secure timestamps, and
notarization, and recommends stapling and testing a fresh distribution on another Mac. See
[Apple's notarization requirements](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution),
[Apple's packaging guidance](https://developer.apple.com/documentation/xcode/packaging-mac-software-for-distribution),
and [Tauri's macOS configuration](https://v2.tauri.app/distribute/macos-application-bundle/).

## Product gates before publication

Packaging proof alone cannot make the macOS build releasable. These gates are currently open:

| Area | Current macOS state | Required proof |
| --- | --- | --- |
| Provider/account isolation | The integrated canonical Mac provider runtime implements the existing guardian lifecycle with a custodian, unreaped anchor, activation-gated exact root, durable state transitions, and mandatory CLEAN/Blocked proof. On the physical M1, 18 guardian regressions and three real process tests passed, including stubborn same-group descendant cleanup and a guarded PTY. Those historical focused results do not replace final-commit or installed-provider proof. | Final-commit Windows Job Object reproof, official supported-provider version certification, real multi-account separation, crash/logout/app-loss recovery, and an explicit unsupported result for intentionally detached descendants. |
| Browser | The canonical abstraction now uses deterministic `data_store_identifier` values on macOS 14+ and distinct values for different data roots/workspaces in unit tests. | Real WKWebView persistence, logout/deletion semantics, and cross-workspace cookie/storage isolation on a Mac. |
| Updater | The Mac consumer is implemented and its core policy, journal recovery, atomic `renameatx_np` swap, rollback, desktop command path, and bundled helper compile pass on the physical M1. Production package verification requires the helper at `Contents/MacOS/kalcode-update-helper`. | Developer ID/notary/ticket verification of a real old-to-new artifact, relaunch health acknowledgement, sleep/wake, clean-machine rollback proof, and canonical Windows signer handoff for the target-bound updater signature. |
| KalVoice | macOS CoreAudio/TTS code, explicit AVAudioApplication permission state, Doctor reporting, and microphone metadata exist. The physical M1 compiled the bundled Whisper feature and passed 214 current native library tests with one intentionally ignored archive test; that archive test then passed explicitly against the exact curated development ZIP. Two release-mode local-reasoning runs each produced 64/65 exact safe actions, zero unsafe actions, no inference failures, and p95 latency of 489/492 ms. No microphone was opened. | Real microphone prompt, denial, capture, transcription, TTS, device loss, cancellation, sleep/wake, privacy-retention checks, and the separately signed/notarized production component on each advertised architecture. |
| Secure store | The canonical secure-store crate selects macOS Keychain; a real GUI-session ignored Keychain floor test passed during release recovery. Final source and fresh-account coverage remain required. | Fresh-account store/read/delete, locked-keychain denial, restart, logout, and cross-account isolation on a clean Mac. |
| E2E/install | The existing compiled-app harness is WebView2/PowerShell/Windows specific. | A native macOS harness covering DMG open, drag/install, first launch, second launch, shortcut/Dock expectations, sign-in/out, Browser, providers, KalVoice, update, rollback, and uninstall/retained data. |
| CI/release | The Rust matrix compiles on `macos-latest`; the physical arm64 packaging lane and resume/verifier tooling exist, with Developer ID and notarization access configured. The final app packet and clean-profile proof are pending. | Exact clean-source native build and verification for every advertised architecture, artifact digest handoff, and independent clean-profile installation verification. |
| Website/feed | Production packager, publisher, manifests, D1 routes and updater descriptors support macOS arm64. Stable publication and installed public-feed proof are pending. | Digest-qualified immutable DMG objects, D1 release authority, friendly and pinned routes, feed entries, range/download tests, production readback, and truthful UI. |

Do not publish a macOS row, stable feed entry, or download URL until every applicable row passes.

## Rollback

Before publication, preserve failed candidates and their evidence for diagnosis or exact resume;
source rollback is an ordinary revert of the relevant Mac-scoped commit. Do not delete a recorded
notarization checkpoint to silently resubmit. After publication, immutable artifact
objects and evidence remain immutable. Product rollback uses a higher version that restores the
previous behavior. An emergency feed withdrawal or exceptional downgrade remains a separately
authorized, audited D1 operation with an exact-current-version precondition.
