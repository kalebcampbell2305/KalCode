# macOS release work packet — 2026-09-25

## Authority and checkpoint

- Starting branch: `sec/providers-harden`
- Starting commit: `35c99cb43699813c8aba58e1fead6a5cd536076b`
- Repository state: shared dirty integration worktree; this packet adds only its exclusive new paths.
- Product truth at start: Windows preview artifacts existed; macOS was explicitly unavailable.
- External state: an Apple M1/arm64 Mac running macOS 26.2 with 16 GiB RAM and Command Line Tools
  clang 17 is reachable. Node and Rust are absent from its default PATH. No Developer ID credential
  or notarization profile is configured. No macOS build, signing, notarization, install,
  publication, or production probe ran.

## Exclusive ownership

This packet owns only:

- `tooling/bootstrap-macos.sh`
- `tooling/macos/**` (reserved; currently unused)
- `tooling/release/macos-*.mjs`
- `apps/desktop/src-tauri/tauri.macos.conf.json`
- `apps/desktop/src-tauri/Info.plist`
- `apps/desktop/src-tauri/entitlements.plist`
- `docs/MACOS.md`
- `docs/campaigns/MACOS-RELEASE.md`

It does not modify the shared release library, updater signer, package scripts, GitHub workflows,
website manifest/schema/routes, Rust platform code, provider guardian, Browser, KalVoice runtime, or
public release state. Those remain lead-owned integration boundaries. No file is staged or committed
by this packet.

## Implemented contract

1. A default read-only bootstrap discovers the real native architecture, safe OS/tool versions,
   pinned Node/pnpm/Rust prerequisites, plist validity, certificate count, and configuration state.
   Its explicit `--install` path uses only already-installed Corepack and rustup providers.
2. The Tauri platform overlay fixes the deployment target at macOS 14.0, builds a DMG, enables
   hardened runtime, merges the KalVoice microphone purpose string, and applies only the audio-input
   entitlement. The base configuration's approved `icon.icns` remains canonical.
3. The package command builds one native slice and requires Developer ID Application identity bound
   to the expected team. It strips automatic-notarization variables, includes on-device
   `kalvoice-whisper`, submits the exact staged DMG with a named `notarytool` keychain profile,
   requires Accepted plus an issue-free log, staples, and invokes independent verification. It does
   not publish.
4. Verification binds file name, size, SHA-256, bundle metadata, architecture, code-sign authority,
   team, secure timestamp, hardened runtime, exact entitlement allowlist, application Gatekeeper,
   DMG Gatekeeper, stapled ticket, accepted submission, and issue-free log. Errors never echo tool
   output that may contain identity details.
5. The pure decision layer and injected verifier adapters run on any host, so negative cases are
   covered without pretending Windows synthetic output is macOS runtime proof.

## Minimum version decision

The 14.0 minimum follows the product's Browser isolation contract, not the current workstation.
Pinned Tauri 2.11.6 documents `data_store_identifier` as the WKWebView replacement for unavailable
`data_directory`, and the API requires macOS 14+. Canonical Browser code now derives deterministic,
data-root- and workspace-specific identifiers on macOS, with pure identity tests. That repair still
needs actual WKWebView persistence and isolation proof. Lowering the minimum needs an alternate
isolation design plus real compatibility proof.

## Local evidence

Run from the worktree root:

```text
node --test tooling/release/macos-contract.test.mjs tooling/release/macos-verify.test.mjs
pnpm exec biome check tooling/release/macos-contract.mjs tooling/release/macos-verify-lib.mjs tooling/release/macos-verify.mjs tooling/release/macos-package.mjs tooling/release/macos-contract.test.mjs tooling/release/macos-verify.test.mjs apps/desktop/src-tauri/tauri.macos.conf.json
bash -n tooling/bootstrap-macos.sh
```

Current result: 12/12 Node tests pass; Biome passes on every new JS/config path; Bash syntax passes.
No Mac-only command was executed on Windows, and these results do not claim a Mac build.

## Required integration work owned elsewhere

The lead integration stream must connect this packet without duplicating release authority:

1. Add package scripts and a protected macOS workflow after review. Pin action commits and use a
   protected GitHub Environment. Import Developer ID material into an ephemeral keychain and delete
   it at job end. Do not echo identities or credentials.
2. Decide the advertised architecture set from available runners. Build arm64 and x64 separately.
   A later universal DMG is allowed only after `lipo` proves both slices and both native lanes pass.
3. Implement the macOS provider guardian and prove the new Browser WKWebsiteDataStore isolation
   before functional certification. The current provider runtime becomes unavailable off Windows;
   the Browser identity abstraction has pure tests but no real WKWebView proof yet.
4. Extend the canonical updater, shared manifest/publisher, D1/R2 records, website routes, MIME and
   range handling, and release tests. Reuse the existing updater key and immutable publication
   authority; do not create a second key or mutable pointer path.
5. Add native clean-machine E2E and install/update/rollback tests. Packaging verification is one gate,
   not functional product verification.

## Mac-only acceptance gates

- Bootstrap check passes on every native runner without mutation.
- Fresh clean checkout, frozen dependencies, clippy/test/frontend build are green on both advertised
  architectures.
- The package command produces new redacted build and verify records from the exact commit.
- Developer ID, expected team, hardened runtime, timestamp, exact entitlements, Accepted notary info,
  issue-free log, staple, app Gatekeeper, and DMG Gatekeeper all pass.
- Fresh-machine DMG install and first/second launch pass with no development keychain influence.
- Keychain, auth/signout, provider-account isolation, terminal/provider crash cleanup, Browser storage
  isolation, KalVoice, sleep/wake, shutdown, update, rollback, and uninstall/retention pass.
- Website and updater entries resolve only immutable digest-qualified objects and read back the exact
  signed bytes after deployment.
- The public manifest becomes available only after both release evidence and production readback.

## Compatibility and rollback

The source change is additive and platform-specific. Windows configuration and release tooling are
untouched. macOS 13 and earlier are intentionally outside this candidate contract. Neither source
configuration nor synthetic tests migrate user data.

Before publication, rollback is deletion/revert of these exclusive paths and deletion of ignored
local Mac artifacts. After publication, preserve immutable objects and records; recover with a
higher-version corrective release. Never overwrite an immutable artifact, silently move a same-version
pointer, or rotate the existing updater key as part of Mac enablement.
