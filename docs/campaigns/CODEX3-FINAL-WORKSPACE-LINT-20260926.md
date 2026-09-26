# Codex 3 final workspace lint and protocol repair — 2026-09-26

Branch: `codex3/workspace-lint-final`, based on `0289c26`.

The strict workspace all-target Clippy gate exposed an oversized internal HTTP result enum and three assertions inside Doctor test helpers. Both HTTP payloads now use Box; the native command immediately moves the same response or prepared redirect out of the box. This does not change the IPC representation, approval sequence, pinned destination, redirect history, or credential stripping. Doctor fixture IO and mock lock failures propagate to their existing test boundaries.

The full workspace test export also recovered the missing generated `UtilityEffectOutcome` type. It exactly matches the existing native enum and hand-maintained desktop IPC union. Its generated index export is restored, and `gen:protocol` includes `kalcode-utilities` so the type is reproducible. No wire discriminator or field changed. Existing unrelated generated whitespace was not included.

## Validation

- Full Utilities crate: 109 tests passed, including one-hop execution, fresh redirect DNS/send authority, credential stripping, history redaction, and authority migration tests.
- Full Doctor crate: 49 tests passed, including cancellation, timeout/privacy sanitization, and exact fix approval checks.
- Desktop TypeScript checking, package Biome check, workspace Rust formatting, and diff check passed.
- Strict workspace all-target Clippy cleared these four diagnostics and found one remaining test-only `type_complexity` in the independently owned KalVoice provisioning fixture. That follow-up is separate; this document does not claim the entire lint gate is green yet.

Prior immutable full workspace run at `75e208c` (same Git tree as integrated `d11031f`) reported 1,989 passed, four stale migration expectation failures, and 15 explicitly ignored tests. The four expectations are independently repaired in `d356d16` with all 53 affected suite tests passing. Those failures were not hidden or converted to ignores.

## Integration and limits

Cherry-pick this packet after the candidate base; it does not depend on the migration expectation or fixture type-alias repairs. Integrate all three before final workspace verification. Production HTTP behavior is covered by synthetic local loopback tests; no external HTTP request or provider session was required. Signing, packaging, publication and real-provider ignored tests are not claimed by this packet.
