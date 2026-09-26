# macOS release pipeline recovery and physical prerequisite audit

Scope: recover the newer mac-integration packaging/bootstrap/verifier source into an isolated branch based on immutable `63efef4`. Branch: `codex3/macos-notary-null`. Originals remain untouched. The adjacent JSON records all eleven source-file SHA-256 values, initial exact-byte copy checks, final recovered hashes, and unchanged-origin checks. Only substantive pipeline/config/docs changes are committed; matching release-channel files and unchanged plist content are retained from the base.

The recovered pipeline requires an explicit channel and probes the compiled production binary, signs and verifies all three native helpers (update helper, provider guardian, hook), checks SDK libc++ availability, binds helper digests and channel/source evidence, and preserves the temporary mount workspace if detach fails. Signing identity and team remain process configuration, not hardcoded machine policy.

The parser now accepts explicit `issues: null` as well as an empty array, while still requiring the matching Accepted submission. Missing/malformed/nonempty issues, wrong job ID, and non-Accepted status remain rejected. The new regression failed before repair (1 failed, 2 passed), then passed. Apple's [workflow documentation](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow) requires reviewing logs even after acceptance because warnings can exist; it does not establish an explicit successful-null schema. This is a bounded compatibility repair with deterministic local evidence, not a claim of observing a successful Apple notarization in this session.

## Verification

`node --test tooling/release/macos-contract.test.mjs tooling/release/macos-verify.test.mjs tooling/release/macos-notary-log.test.mjs tooling/release/release-channel.test.mjs tooling/release/updater-manifest.test.mjs tooling/release/publish-platforms.test.mjs`: **62 passed, zero failed/skipped**.

The first composed run was 61/62: the old positive updater fixture lacked the newer signed/helper/channel evidence. The fixture now models the actual package record, with additional negative helper/signature/eligibility/probe cases. Production publisher and updater policy were not relaxed. Scoped Biome, Bash syntax, and whitespace checks pass. Verifier tests inject process/filesystem adapters; they do not certify actual signing, notarization, Gatekeeper, or installation.

## Physical Mac, read-only SSH observations

- arm64; macOS 27.0 build 26A428; Xcode 27.0 build 27A266a selected under `/Applications/Xcode.app/Contents/Developer`.
- Exactly one valid identity: Developer ID Application: Kaleb Campbell (JG5K9T47ZF). Team JG5K9T47ZF. Public SHA-1 certificate identifier: 8314F3D0536DA13FA2D7DC1BD64684D3FDFC7E17. No private key or credential was read/exported.
- Node 24.21.0, pnpm 10.33.2, Corepack 0.36.0, CMake 4.4.3, Rust 1.98.1, and `aarch64-apple-darwin` target are installed. Noninteractive SSH requires `export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"` for Node/pnpm. Selected SDK contains the libc++ array header. notarytool 1.1.3 (42) and stapler are available.
- `~/Developer/KalCode` is dirty main at ad4d073; preserve it. `~/Developer/KalCode-codex2-qa` contains independent source/archive/test directories and is not a Git repository at its root. No Codex3 Mac directory was created.
- The located KalCode.app is a debug arm64 bundle with an ad hoc linker signature, no team binding or sealed resources; strict deep verification fails. No release DMG or macOS build/verify records were found in the inspected checkout target/dist and QA target directories.
- `KALCODE_NOTARY_KEYCHAIN_PROFILE` is unset in the SSH environment. No genuine stored profile name was identified; profile names were not guessed and no authenticated history request was made. Certificate presence alone does not prove notarization account readiness or unattended signing access.

## Exact operator pipeline after integration and prerequisite closure

Use a clean isolated Mac checkout of the final reviewed commit, not either existing dirty/QA directory. Set the public team and identity variables to the values above, and obtain the genuine existing profile name through the release owner:

```bash
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
export KALCODE_APPLE_TEAM_ID=JG5K9T47ZF
export KALCODE_APPLE_SIGNING_IDENTITY='Developer ID Application: Kaleb Campbell (JG5K9T47ZF)'
# KALCODE_NOTARY_KEYCHAIN_PROFILE must name the operator's actual stored profile.
bash tooling/bootstrap-macos.sh --check
node tooling/release/macos-package.mjs --channel stable
node tooling/release/macos-verify.mjs --artifact dist/release/<version>/KalCode_<version>_arm64.dmg --record dist/release/<version>/macos-arm64-build.json
```

The bootstrap's check mode performs a temporary C++ compile probe; it was not invoked during this read-only audit. Packaging builds native helpers and the Tauri DMG, signs, submits the exact staged DMG with `xcrun notarytool submit ... --keychain-profile ... --wait --output-format json`, validates its log, staples, and verifies. Neither command publishes. The existing verifier can write an optional report with `--output <path>`.

## Dependencies, merge order, and remaining gates

Integrate this packet after recovery base 63efef4 (or equivalent full source) and review the complete newer Mac pipeline together. No shared release-channel source change is required; its bytes match the preserved owner copy. The updater fixture change is part of this packet.

The Mac guardian/PTY runtime packet in mac-integration remains a separate critical dependency: recovery base still returns "the provider crash guardian requires Windows Job Objects" in the non-Windows admission path. A correctly signed guardian binary does not establish working Mac custody. Provider/PTY sources, the custodian C probe, and associated native tests were deliberately not copied into the packaging packet. Native build and Windows compatibility proof are required after that source is integrated.

No native compilation, signing, notarization submission, stapling, mounting, installation, app launch, publication, or secret inspection was performed by this audit/repair. Remaining release gates include credential/profile validation, clean native production build, all nested signatures, Accepted Apple log, staple/Gatekeeper, physical install and product QA, update/rollback, and immutable publication/readback. This packet is integration-ready source, not a shipped Mac release.
