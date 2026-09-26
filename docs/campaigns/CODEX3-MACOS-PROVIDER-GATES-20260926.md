# Complete provider gate on the physical Mac

Base: b516056. Scope: macOS-only test setup in interactive.rs, interactive_cli.rs and pipeline.rs.
Managed fixtures now launch the real bundled guardian and bind profile storage to its authority,
matching production. The lifetime is retained for the entire fixture. Other-platform fixture
behavior, provider version expectations and safety checks are unchanged.

The interactive managed-version fixture failed before this setup because missing guardian authority
prevented the expected version probe. Broader inspection found the same missing setup in the Codex,
Gemini and managed Claude pipeline fixtures; these now exercise the actual guarded path.

Full gate on physical Apple Silicon: `cargo test -p kalcode-providers --locked --offline --jobs 1`
returned exit 0: **286 passed, zero failed, nine intentionally ignored** across library, integration
and documentation test runners. Ignored cases include real provider/account/quota tests; those
were not enabled. Windows-only integration binaries contained zero tests on this Mac and still
need the parent's Windows verification. The inherited fake_provider.rs unused_mut warning remains.

Runner environment: PATH prepends ~/.local/bin and ~/.cargo/bin; TMPDIR points at the ordinary
~/Developer/KalCode-codex3-native-qa/tmp (Darwin's default /var ancestry is a symlink and is deliberately
rejected by managed profile storage). CARGO_TARGET_DIR uses the isolated sibling target directory.
Source: ~/Developer/KalCode-codex3-native-qa/source-cbe58da-guardian, previously documented immutable
base archive plus the exact recovered and reviewed overlays. No other Mac checkout was overwritten.
Evidence: providers-fixtures.log in the isolated QA root. Mac build jobs are complete.

Merge order: c800aea native recovery, 22b15d9 build/resume stages, 8ae26cb root privacy,
b516056 session lease lifetime, then this fixture packet. Applicable remaining release gates include
the parent's shared Windows guardian reproof, final integrated desktop build/signing, notarization,
stapling, Gatekeeper, physical install/upgrade and product QA. A passing provider test suite is not
a published or installed macOS release.
