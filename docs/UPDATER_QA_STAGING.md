# Updater release QA staging

The Stable publisher requires real customer-path updater evidence from both Windows x64 and macOS
arm64. A same-version installer rehearsal does not satisfy that gate. Before the first public
release, `release:stage-updater-qa` can place a signed lower-version baseline and the exact final
candidate behind unlisted immutable version URLs. It cannot move Stable, Beta or Dev.

## Build the baseline

Create a clean baseline checkout from the exact candidate build commit. Its diff must contain only:

- the version in `apps/desktop/package.json` and `apps/desktop/src-tauri/tauri.conf.json`
  (a candidate from before the version split, whose `Cargo.toml` still declares the public
  version, also changes the version in `Cargo.toml` and `Cargo.lock`); and
- the Stable endpoint in `crates/updater/src/lib.rs`, pinned to
  `https://kalcoded.com/releases/updater/stable/<candidate-version>.json`.

The baseline version must be lower than the candidate. Since the version split the Cargo workspace
carries the fixed internal version `0.0.0`, so leave `Cargo.toml` and `Cargo.lock` untouched; for an
older candidate, regenerate `Cargo.lock` and do not hand-edit unrelated package entries. Build, sign, notarize and verify both platform artifacts with the normal
production tooling. The compiled `--build-info` version, Tauri version, artifact file name and
build records must all name the baseline version. Test hooks remain disabled.

Both staging directories need the ordinary build and verification packets plus preliminary device
QA records:

| Target | Build | Verification | Preliminary QA |
| --- | --- | --- | --- |
| Windows x64 | `build.json` | `verify.json` | `windows-x86_64-qa.json` |
| macOS arm64 | `macos-arm64-build.json` | `macos-arm64-verify.json` | `macos-arm64-qa.json` |

Preliminary QA uses schema version 2, status `preliminary-passed`, all product checks true (including
the exact artifact's normal clean install under a dedicated clean standard OS user), every
safeguard false, and `updateTrial: null`. It binds the exact target, Stable channel, version,
commit and artifact SHA-256. Windows still requires Azure Artifact Signing, timestamp and its
target/channel Minisign signature. macOS still requires Developer ID, hardened runtime, exact
entitlements, Accepted notarization with an issue-free log, staple and Gatekeeper evidence. The
preliminary status is accepted only by this staging tool; `release:publish` requires the completed
trial.

Use `kalcodeqa` for the direct candidate install and the separately prepared `kalcodeqa2` for the
direct baseline install and its update/rollback/re-update sequence on each platform. Preserve both
profiles and the owner's development session; do not clear or migrate profile data between trials.
On macOS, copy the candidate explicitly to `/Users/kalcodeqa/Applications/KalCode.app` and the
baseline explicitly to `/Users/kalcodeqa2/Applications/KalCode.app`. Create each `Applications`
directory as its standard user when needed. Do not use the DMG's `Applications` shortcut for these
trials: it targets system `/Applications`, requires administrator authority and would require an
administrator to replace a standard user's app manually for later versions.

## Dry run and stage

Use absolute, distinct paths. The candidate source must be the clean checkout containing the
executing release tool. Keep the receipt outside both source and artifact staging trees.

```powershell
pnpm release:stage-updater-qa -- `
  --baseline-source C:\qa\kalcode-baseline `
  --baseline-staging C:\qa\stage-baseline `
  --candidate-source C:\qa\kalcode-candidate `
  --candidate-staging C:\qa\stage-candidate `
  --receipt C:\qa\receipts\updater-stage.json `
  --dry-run
```

The release owner repeats the command with `--remote` after reviewing the dry run. On a new run the
tool proves both version rows and every planned R2 key are unused, writes and flushes the exact
local receipt, uploads digest-qualified immutable objects, reads every byte back, claims only the
two `release_publication_versions` rows, verifies both public-by-URL version descriptors, and
proves the Stable pointer did not change. An interrupted run can resume only with the byte-identical
receipt. Conflicting objects, rows, timestamps, descriptors, signatures or pointer movement stop
the run.

The candidate staging directory receives create-once `publication.json`, `latest.json` and
`stable.json` bytes. Preserve them. A later normal publish must regenerate the same descriptors
from the final QA packet and reuse those exact bytes. Changed signatures, notes, artifacts,
timestamps or descriptor bytes require a new version.

## Real device sequence

Install the signed baseline normally from its unlisted immutable descriptor. On each platform run:

1. baseline to candidate update;
2. candidate to retained-baseline rollback; and
3. baseline to candidate re-update.

Record the exact baseline and candidate version, commit and artifact SHA-256 in each final schema-v2
QA record. Every outcome must bind its exact source and destination identities and pass. Cache
seeding, authentication or TLS bypasses, test hooks and fixture-only proof are forbidden.
Retain a separate device evidence receipt for each platform. For macOS it must record the exact
per-user installation path, prove the installed bundle identifier, version and production
build-info, Developer ID team and strict signature, and bind the installed copy to the source DMG
SHA-256. Before approving the final record, cross-check its baseline and candidate identities with
the durable staging receipt and both immutable version rows. Preserve these receipts outside the
source and artifact staging trees with the other governed release evidence.

Replace the preliminary QA records with final status `passed` records after the physical runs.
`pnpm release:publish:dry-run` then rechecks both platform signatures and complete QA. Only
`release:publish` can atomically advance Stable after all normal release gates pass.

## Rollback

Before Stable moves, abandoning the staged QA version requires no feed mutation: leave or delete
the local receipt and build a new version. Immutable remote objects and version rows remain
unselected evidence. Never rewrite them or point Stable at the private baseline. After Stable moves,
the normal rollback policy is a higher-version release; device-local retained-candidate rollback is
the recovery path tested above.
