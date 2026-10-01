# KalVoice responsiveness continuation

## Recovered authority

The owner requested recovery of the KalVoice work and faster, nearly instantaneous response.
Root checkout `main` was `26ba24c6` with unrelated marketing work in progress. This change uses
isolated branch `fix/kalvoice-responsiveness` from fetched `origin/main` `3580a6b8`.
Production Stable remains 0.1.7, source `03eeabf677754579169cfe15f5e962fd18da8719`.

`target/KALVOICE-BASELINE.md` and `target/TERMINAL-KALVOICE-GAP.md` are historical analyses.
Their normalization, session resolution, composer targeting, send/clear/tell, focus history,
and streaming-abort improvements are already integrated. The derived 15-case matrix expressly
was not the original owner matrix. Proposed later terminal renaming and context synthesis are
not added to this task. Fn and orb-release repairs also shipped in 0.1.7. Catalog sequence 2
is already published; the earlier sequence-1 renewal runbook is stale.

## Change and contracts

Canonical owners: `crates/kalvoice/src/voice.rs` and the existing desktop `DesktopRecognizers`.
Each take formerly selected/checked the recognizer three times: readiness, streaming, and final
transcription. Desktop selection reads preferences and validates signed-component metadata even
when the model is warm. The take now prepares once before opening the microphone, retains its
leased recognizer, and uses it for both streaming and final transcription.

No cross-session trust cache is introduced. New takes revalidate. Preference changes apply to
the next take. Component deletion remains blocked by the existing lease while a take uses it.
Cancellation joins the streaming worker and releases the session reference. Capture failure,
silence, transcript redaction, request routing, accounting, permission boundaries, and the
120-second cap retain their existing owners. The shared implementation covers Windows and macOS.
No schema, wire contract, public version, dependency, model, or provider changes are required.

## Evidence

- Baseline voice tests: 7 passed.
- Two new regression tests were observed failing before implementation: final transcription
  used a different recognizer from the one acquired at start; failed acquisition still opened
  the microphone. These now pass.
- Added coverage for per-take selection, next-take revalidation, acquisition failure before
  capture, cancellation releasing the recognizer, and single preparation during warm-up/takes.
- Independent review found the desktop `ReadyModel` lifecycle fixture claimed readiness but
  returned no recognizer. It now supplies a silent test recognizer; lifecycle assertions remain.
- Independent focused voice suite: 11 passed, zero failures. Four new tests increase the Windows
  KalVoice unit inventory from 300 to 304; no test or suite was removed.
- Full Windows KalVoice crate: 302 unit + 1 local-reasoning corpus + 4 schema tests passed;
  three existing optional tests ignored. Full macOS KalVoice crate: 306 + 1 + 4 passed with the
  same three optional ignores. The platform difference is existing platform-specific coverage.
  These builds do not enable Whisper; real-model and physical-microphone proof is outstanding.
- Windows native command tests: 15 passed. Full desktop native unit binary: 406 passed,
  one existing optional ignore. The Windows test binary requires a Common-Controls sidecar
  manifest; a separate copied test executable with that manifest passed. An unmanifested copy
  failed to launch with STATUS_ENTRYPOINT_NOT_FOUND, matching the documented test harness issue.
- Desktop KalVoice frontend: 20 files / 199 tests passed. Full frontend run: 1,250 passed and
  one unchanged `ThreadProblems.stable` test exceeded its 5-second timeout. Its isolated rerun
  passed all three tests without changing code or timeout. All frontend source/package files
  were compared to fixed base `3580a6b8` and are unchanged. The complete rerun passed 139 files /
  1,251 tests, zero failures or skips, plus all four desktop identity-script tests. Neither
  assertions nor timeouts were changed. The registered wrapper's earlier nonzero run and the
  direct-run timeout remain recorded rather than being treated as passing runs.
- Windows Clippy for KalVoice and desktop libraries passes with warnings denied. Desktop
  TypeScript passes. macOS desktop compile check passes using the Dev identity and an empty
  external-binary list for compile-only validation; the first default check required missing
  packaged helper copies. This is not signed packaging or real-app boot evidence.
- Static capability and zero-cost checks pass. No commands were added or removed.

The verified structural improvement is three desktop selections to one per take, with none
after release. No end-to-end millisecond improvement or physical-microphone result is claimed.
The existing WAV benchmark supplies an already-loaded recognizer and cannot measure the removed
desktop trust-store reads. Current before/after physical timing remains a release evidence gate.

## Release and rollback

This packet is not shipped. Keep public version 0.1.7. Same-version shipping depends on existing
PR34 build-revision support and its outstanding Mac packaging/notarization evidence. Hosted
Actions currently cannot start because of the account billing/spending limit; local checks must
not be described as hosted CI success. The prepared Windows tao deadlock repair is separate.

No production stores, owner memories, archives, credentials, paid providers, or installed apps
are mutated by these tests. Tests use isolated fixture stores. The root dirty worktree remains
untouched. Before integration, rollback is simply retaining production at `03eeabf6`; after a
future merge, revert this scoped change through a reviewed forward commit and ship a newer
internal build. No historical reset is needed.
Local source checkpoint: `rollback/kalvoice-responsiveness-base-20260930` at `3580a6b8`.
