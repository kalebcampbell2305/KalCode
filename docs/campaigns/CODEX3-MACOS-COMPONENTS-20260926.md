# Apple Silicon KalVoice runtime curation

Branch: codex3/macos-components. Base: takeover b32b8fa, plus independent notice-byte repair 6982713.
Scope: component contract, Mac curator, notarization resume, publisher policy and focused tests.

The contract pins the official llama.cpp b11146 arm64 archive, commit
7fe450e19305b828c199d602c23a8337aaa1f03b, 11,189,714 bytes, SHA-256
1ad3f9eff80edb9dbef4259ad564d1720612ef7eea48fa4afed0e54f5f3d5711.
Its 61 tar members include one root directory. Only the consumer's exact 11 Mach-O files plus
MIT LICENSE are retained. Nine known dylib aliases are copied from their exact regular in-archive
targets; no filesystem symlink is extracted. Gzip/TAR bounds, checksum, paths, aliases, duplicate
names and inventory are checked before signing. The original archive is never modified.

On the physical Mac, all 11 files are arm64 with minOS 13.3 and only @loader_path rpath. Every
non-system dependency resolves within the retained closure; external paths are rejected. The
MIT notice matches pinned SHA-256 94f29bbed6a22c35b992c5c6ebf0e7c92f13b836b90f36f461c9cf2f0f1d010d.
The curated ZIP has precisely the existing native consumer inventory. Consumer extraction already
sets llama-server executable mode explicitly; the ZIP stores ordinary files only.

The curator replaces the upstream ad hoc signatures with the existing Developer ID Application
identity for team JG5K9T47ZF, hardened runtime, secure timestamps and no entitlement exceptions.
It verifies every code member and the pinned runtime version before writing the immutable ZIP
and a non-publishable curation record. This signing implementation is **not yet a successful
production signing proof**: the actual first codesign failed with errSecInternalComponent.

Commands on an authorized Mac, with ordinary existing output directories:

```sh
export KALCODE_APPLE_TEAM_ID=JG5K9T47ZF
export KALCODE_APPLE_SIGNING_IDENTITY='Developer ID Application: Kaleb Campbell (JG5K9T47ZF)'
node tooling/release/component-curate-macos.mjs \
  --source /absolute/llama-b11146-bin-macos-arm64.tar.gz \
  --artifact /absolute/staging/runtime.zip \
  --record /absolute/staging/runtime-build.json

# Only after the owner supplies the existing notarytool keychain profile:
node tooling/release/component-notarize-macos.mjs \
  --artifact /absolute/staging/runtime.zip \
  --record /absolute/staging/runtime-build.json
```

The second command reads KALCODE_NOTARY_KEYCHAIN_PROFILE, validates exact candidate/ZIP/member
digests, persists Apple's returned job ID before waiting and reuses it on retries. Ambiguous
submission outcomes and stale invocation locks fail closed. It requires Accepted, an issue-free
log binding the exact ZIP SHA-256, and `codesign --verify --strict -R=notarized` on every code member.
Only then does the local record become release-eligible. The publisher now recognizes this exact
Mac policy and rejects missing, pending, mismatched or incomplete evidence. Windows signing,
component-key custody and publisher gates remain authoritative and unchanged.

Apple explains that bare command-line tools and dylibs can and should be notarized but cannot be
stapled, and documents the notarized code-signing requirement for their verification:
[Apple WWDC notarization workflow](https://developer.apple.com/videos/play/wwdc2019/703/).
ZIP notarization and inspection of the full log are supported by the current
[Apple custom workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow).
This pipeline does not invent a successful ZIP staple or require a fake app bundle.

Verification: four initial new tests failed before implementation. The final Windows component
gate passed 43 tests across contract, both curators, notarization, notice staging, signer wrappers
and publisher. On the physical Mac, the platform-relevant component gate passed 35 tests with
one existing Windows-only real-signer test skipped. The separate component-signing wrapper tests
use hard-coded Windows DPAPI paths and were verified on Windows; they are not a Mac key-custody
claim. An initial Mac test copy omitted the website migration fixture; after adding that exact
source fixture, all publisher tests in the platform-relevant gate passed. No D1/R2 publication or
real Apple notarization occurred. Scoped Biome and diff checks passed.

Physical signing boundary: security find-identity still reports exactly one valid Developer ID
Application identity, SHA-1 8314F3D0536DA13FA2D7DC1BD64684D3FDFC7E17. A bounded diagnostic retry
confirmed codesign --force fails on libggml-base.0.dylib with errSecInternalComponent. One authorized
post-wake curator retry also failed with the sanitized codesign error; no further signing retries
were attempted. The default user keychain is login.keychain-db. No ZIP or
signed record was produced, and no keychain ACL, key material, certificates or security setting
was changed. Evidence is preserved at root target/codex3-macos-components/signing-boundary.json.
Mac source/evidence live under ~/Developer/KalCode-codex3-components/source-b32b8fa and its parent;
the exact archive and extracted originals remain intact. All processes from this packet finished.

Remaining production proof: owner resolves access to the existing signing key; rerun curator once;
review the actual signed ZIP/version/closure evidence; supply notary profile and complete Apple
checks; create the separately signed catalog using existing component-key custody; validate the
consumer install and local inference against the exact artifact. No release eligibility or
publication should be claimed until those actual gates pass.
