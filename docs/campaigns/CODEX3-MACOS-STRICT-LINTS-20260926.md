# Physical Mac strict native gate repair

Branch: `codex3/macos-strict-lints`, based on frozen candidate
`a60c917e194b0f4ea4e207dbae22c7ef29dfb784`.

Rust stable on the physical Mac was newer than the Windows compiler and rejected
constant-size `chunks_exact` calls. The UTF-16 decoder and three developer WAV
readers now use `as_chunks::<2>()`. UTF-16 still rejects odd-length input before
decoding; WAV readers still discard a trailing incomplete pair. Byte order and
sample scaling are unchanged. This API remains compatible with the declared
Rust 1.89 minimum.

Windows retained-process helper traits/functions now compile under
`cfg(any(windows, test))`: the Windows implementation and cross-platform synthetic
identity/custody tests remain available. The non-Windows preparation path still
identifies the process first, then returns the same unavailable error; its unused
info value is explicitly consumed. No process authority or platform support changed.

## Verification

- Before repairs, actual Mac strict Clippy failed on the decoder and Whisper WAV
  readers. The desktop test build also reported unused Windows-only helper code.
- Frozen `a60c917` desktop library with `kalvoice-whisper`: **174 passed** on actual
  aarch64 macOS. That suite was not needlessly repeated for this mechanical packet.
- After this packet, Mac context and utilities tests: **209 passed, 1 existing
  ignored**, zero failed, including synthetic process identity/custody tests.
- Scoped all-target strict Clippy for context, utilities, and KalVoice with Whisper:
  exit 0.
- Full workspace all-target strict Clippy with desktop Whisper: exit 0 after also
  applying the separate provider worker's three-file Mac fixture lint packet.
  Those provider files are not included in this commit.
- `cargo fmt --all -- --check` and `git diff --check`: pass.
- Independent billing worker review approved all five source-file changes.

Commands used the production `aarch64-apple-darwin` target, SDK environment,
deployment target14.0, compile-only helper configuration, shared isolated target,
and jobs1. All warnings remained enabled with `-D warnings`. Cargo still reports a
third-party `block`0.1.6 future-incompatibility notice; this does not represent a
clean future-toolchain guarantee.

Evidence in root `target/codex3-mac-native-final`: `mac-clippy.log` and
`mac-clippy-repair.log` (failures), `mac-scoped-clippy.log`,
`mac-focused-tests.log`, `mac-clippy-final.log`, and `mac-desktop-tests.log`.
The isolated Mac source tree is `~/Developer/KalCode-codex3-native-final-a60c917`.

## Integration

Cherry-pick this packet and the separate provider fixture packet before declaring
the full Mac strict gate integrated. There is no migration or dependency change.
Windows source behavior is unchanged; its frozen full gate remains evidence for
the earlier candidate, and affected checks should be rerun after integration.
No production signing, notarization, deployment, or installation was performed.
