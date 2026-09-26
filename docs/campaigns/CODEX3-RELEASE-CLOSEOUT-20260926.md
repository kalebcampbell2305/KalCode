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
| KalVoice signed runtime/model desktop wiring | Integrated `04c83a8` | Physical microphone and provisioned desktop QA |
| Browser account authority | Integrated `b03f933` | Real WebView account-isolation QA |
| Mac guardian recovery | Integrated with private-root and multi-turn lease fixes | Full final-source gates and real provider QA |
| Mac build-only/resume | Integrated `e0943a9` | Actual signed candidate and notarization |
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

## Subsequent verification and remaining repairs

- Registered tooling subsequently passed 293 tests with no skips. Cargo deny passed
  advisories, bans, licenses and sources; duplicate warnings remain reported.
- Physical Mac provider tests: 286 passed, 9 existing intentional ignores. Windows
  guardian tests: 23 passed. These do not prove logged-in provider interaction.
- Windows desktop library: 180 passed after Browser authority and KalVoice wiring.
- The exploratory full browser run finished 309 passed / 7 failed. It overlapped a
  development-server reload and is not an immutable release gate. KalVoice dark-theme
  accessibility passed on a fixed candidate rerun. Email onboarding's locator was
  repaired with both account-flow tests passing. Four further focused checks passed
  after aligning shortcut/account expectations and giving context delivery an explicit
  enabled-feature fixture; a separate test verifies the ordinary gated state.
- Command-palette accessibility still fails in both themes: the active descendant
  references a removed option. A production repair is required; axe remains enabled.
- Frozen `b03f933` Rust workspace run stopped after 1,549 passes, 7 intentional
  ignores and 2 Gemini fixture failures. Windows guarded-fixture and strict-Clippy
  repairs are in progress; no full Rust gate pass is claimed.
- Environment Doctor local-runtime observation is integrated in `083c1ee`: 49
  crate tests passed, including absent-source and changing native-state checks.
  Desktop compilation and broader strict-Clippy verification remain pending.
- Exact upstream notice bytes are restored in `afed16e`. Git line-ending conversion
  had changed the hash-pinned Qwen license; no trusted checksum was changed. All four
  notice integrity/staging tests passed.
- Mac component signing reached the existing production identity but failed with
  `errSecInternalComponent`. No signed Mac component archive, app, DMG, notarization,
  installation or publication is claimed. The certificate/key was not replaced,
  exported or printed, and keychain access controls were not changed.

Canonical main remains `ad4d073`, with its original uncommitted work preserved.
No source push, release publication or website deployment has occurred in this closeout.
