# Acting primary release closeout — 2026-09-26

Terminal 3 is the sole active canonical integrator. Terminals 1, 2 and 4 are offline.
The integration branch is `codex3/takeover-integration`; canonical main remains
`ad4d073` until the recovered native candidate passes its applicable gates.
Nothing in this report certifies a production release or customer installation.

## Preserved and integrated

- Recovery commit `63efef4` preserves 911 source paths from the interrupted primary
  worktree. The original dirty worktrees and excluded trace artifacts remain intact.
- Reviewed candidate `4072a07` was merged with deliberate conflict resolution;
  newer OAuth/account and platform-binding protections were retained.
- Terminal 2's final source packets are integrated: Rail `d4669e1`, `f5be0c1`,
  `74da6ff`; profile `7a5b297`; terminal callback fencing `6f6d174`; capability
  scanner `0346210`; complete Rust inference scan `71dddfa`.
  Terminal 2's final handoff is `4b24b791315d935235288ca7e1b0d26e07a84799`.
- API account deletion and checkout retry repairs, secure component-directory
  helpers, terminal replay query suppression with preserved human input, canvas
  background selection, and actual KalVoiceProvider destination tests are integrated.
- `dd7823e` removes panic-based redaction serialization/test sink locks.
- `2365021` repairs the real Windows PowerShell ZIP dependency. Its new real ZIP
  regression failed before the fix; all six focused curation tests passed afterward.
- `40b832d` restores the notification contract implemented by native persistence and
  existing TypeScript consumers. The orphan extension remains in recovery history;
  no fabricated attention counters or incomplete feature activation were added.

## Current queue

| Work | State | Required next evidence |
| --- | --- | --- |
| KalVoice signed runtime/model desktop wiring | Running, isolated worker | Native compilation, consent/custody tests, review and integration |
| Browser native authority fixtures | Needs repair | Resolve recovered API/test mismatch without weakening account authority |
| Mac guardian recovery `c800aea` | Held for follow-up | Private-root repair, multi-turn lease lifecycle repair, Windows compatibility |
| Mac build-only/resume `22b15d9` | Reviewed, dependent | Integrate with native packet; actual signed candidate and notarization |
| KalVoice server entitlement adapter | Needs repair | Replace production provisional Free source with verified account authority |
| Windows component distribution | Locally verified | Publish only with eligible desktop and verified production routes |
| Mac component distribution | Needs implementation closeout | Approved arm64 runtime curation/signing and platform-bound catalog |
| Canonical main / private remote | Held | Full applicable gates on actual integrated release commit |
| Signed installers, feeds, site and clean installs | Held | Build, verify, publish, deploy, install and live QA |

## Verified evidence and limits

- Integrated desktop: 872 tests across 100 files passed, including registered
  readiness regressions. Workspace TypeScript passed, including 118 Astro files.
- API: 258 tests passed in one serial-worker invocation after the API repairs.
- Website: 332 tests passed after its production build. Shared UI 68 and protocol
  56 tests passed earlier in this candidate sequence.
- Registered tooling: 278 tests passed before the additional real ZIP regression.
  Capability, zero-cost, branding and manifest checks passed. The existing manifest
  still describes the older one-platform preview; that check is not new-release proof.
- Focused browser gate: 57 passed with one worker and zero retries. The subsequent
  full 316-test browser run is in progress; its first failure was a stale email-button
  locator, with the complete onboarding/logout/relogin assertions retained.
- Rust workspace gates are not yet green. Recovered production and fixture wiring
  failures are being repaired, not hidden or excluded.
- Mac focused native custody/PTY tests passed on the physical machine. Broader
  provider QA exposed fixture and lease-lifetime issues; no full Mac pass is claimed.

## KalVoice boundary findings

The installed unsigned 0.1.5 executable is not the current candidate. Its metadata
contains three Claude-targeted reasoning sessions followed by local commands; the
exact weekly-limit text was not recovered and its source cannot be conclusively
attributed. The user's successful Dashboard command confirms that installed build
also has a functioning local lane.

Current candidate routing uses deterministic commands and a local interpreter;
there is no implicit provider reasoning fallback. Frontend boundary tests verify
captured Claude/Codex/Gemini destinations and prevent raw provider quota prose from
becoming KalVoice's own error. These are test seam results, not microphone-to-native
desktop verification. Actual signed model/runtime wiring and installation remain gates.

## Actual Windows component preparation

Evidence is outside source under `target/codex3-components` in the canonical root.
The pinned llama.cpp runtime `0.5.0-b11146` has 22 executable/DLL members signed by
the existing Azure identity, timestamped and publisher-identity verified.

- Runtime archive: 17,497,972 bytes.
- SHA-256: `e72f5ea3c771844320c19f0e0fc3cbbe32e4b61ea2112cf0e5be3d06a69d8404`.
- Qwen reasoning model and all five approved Whisper models passed exact size/hash checks.
- All seven manifests and the Windows Stable sequence-1 catalog were signed with
  the existing purpose-separated key and independently verified by the signer.
- Publication dry-run passed: eight immutable objects planned. No upload or pointer
  advance occurred. No private key was printed, exported or committed.

Runtime and catalog records, signed tokens, dry-run log and the preparation script
are preserved locally. The catalog has a bounded validity window; recheck validity
and authoritative sequence immediately before publication. Billing migration 0008
must precede deployment of the checkout retry repair. Paid checkout remains held
until signed desktop certification; no charge-producing test was run.
