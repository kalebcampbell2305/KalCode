# Mac runtime ZIP producer/consumer repair

Branch `codex3/macos-component-modes`, base `13e3f77`. Required follow-up to the
macOS component curation packet; no production artifact has been signed or published by this repair.

Read-only integration review found that the shared deterministic ZIP writer hard-coded
`0100644` for every member. The new Mac curator used that writer, while the real component
consumer requires `llama-server` to have `0100755` in the signed archive before extraction.
Signing, notarization and a matching digest would not prevent `UnsafeArchive` at installation.
The previous curation tests covered names and native dependency closure but missed this mode
contract. A byte-level reproduction and the new Node regression failed on `33188 !== 33261`.

The writer now accepts an explicit, validated executable-member list. Its default remains
empty, preserving Windows ZIP bytes. `writeMacRuntimeZip` uses the pinned Mac closure and
marks only its `llama-server` entrypoint executable; all dylibs and LICENSE stay `0100644`.
The production Mac curator invokes this same tested helper. No consumer gate was relaxed.

The 1,705-byte test fixture at `crates/kalvoice/tests/fixtures/macos-runtime-modes.zip` contains
only harmless `fixture:<member-name>` text. It is produced by the actual Mac ZIP helper,
and the Node test requires byte-for-byte equality. The Rust test feeds those exact bytes
through `extract_runtime` and `verify_runtime` with the entire production Mac extraction
policy. Its SHA-256 is `5b35b30f4ab2b2fbcfd30bfcb8748047c459627091c8a03e9b400e236483696c`.
This is extraction compatibility evidence, not code-signing or model-inference evidence.

The default Windows two-member ZIP regression retains the pre-fix SHA-256
`da64729e518b9e15722426a2839dc81153525aa17ff78d4618172337510855a3` on both Windows and Mac.
Existing signed Windows runtime artifacts and curation records are not rewritten. A future
curation run naturally records the changed tool recipe hash, but this does not invalidate
already signed artifact bytes or their matching historical evidence.

Source review found no additional concrete mismatch in the bounded target/channel/provenance
scope: catalog and nested manifest signatures bind the target, IDs, ABIs and validity;
the app derives its channel and target from build/host configuration; source hashes and licenses
are publication-policy checked; acquisition and installed receipts recheck trusted signatures
and bytes. Updater schema v2 independently binds version, target and channel in its trusted
signature comment. This does not claim a broader security audit or change legacy updater policy.

Checks: Node regression RED before repair, 34 focused Windows component tests GREEN after;
physical Mac curator suites 11/11 GREEN, including exact Windows-byte preservation and exact
Mac fixture bytes. Scoped Biome, rustfmt and diff checks pass. The native Windows Rust test accepts and re-verifies the exact Mac producer fixture;
the existing decoder test also accepts executable ZIP mode and rejects missing execute mode.
Both focused native tests pass with jobs=1. Native Mac Rust execution awaits the shared test
slot; the byte-identical producer fixture has already been regenerated and checked on the Mac.

Merge after the original Mac component packet. Actual Developer ID key access, successful
curation/signing, Apple notarization and real installed inference remain separate release gates.
