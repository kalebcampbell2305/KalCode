# KalVoice component catalog renewal (R2–R4 runbook)

This runbook renews the signed KalVoice component catalogs: sequence 1 becomes sequence 2. The
source plan is `docs/release/certification-B5/POST-SHIP-OPS.md`, steps R0–R7. R1 is the tooling
described here.

| Catalog (stable) | Live seq | Hard expiry (UTC) | Live sha256 |
|---|---|---|---|
| `windows/x86_64` | 1 | **2026-10-25T04:13:50Z** (1792901630) | `f296b481…6aa5` |
| `macos/aarch64` | 1 | **2026-10-26T01:57:40Z** (1792979860) | `24f1f3f7…105a` |

There is no grace period. At `expiresAt` the app's `verify_catalog` returns
`Signature(Expired)`, and every new speech-model or local-intelligence install fails with
`component_catalog_invalid`.

Due dates: **R2–R4 by Tue 2026-10-13**, then R5 (publish) on Wed 2026-10-14. The last safe publish
date is **Thu 2026-10-22**.

Step owners:
- **[OWNER]** Only the owner may do this: key custody, Cloudflare auth, or approving a publish.
- **[CLAUDE]** Claude runs this in the owner's Windows session.

Nothing in this runbook reads, prints, copies or exports private key material. The signer opens the
DPAPI store itself, and only public keys and signed tokens leave it.

## What the tool does

`tooling/release/component-renew.mjs` renews one platform per run:

- It reads the published catalog (`catalog.jws`) and authenticates it against the pinned public key
  `tooling/release/component-public-key.json`. It also authenticates all 7 nested manifests. It does
  not check time, so an already-expired catalog can still be renewed.
- It copies every signed field verbatim, except:
  - `sequence`: +1 for each manifest; the catalog gets `--sequence`, which defaults to prev+1.
  - `issuedAt`: `--issued-at`, or now if omitted.
  - `expiresAt`: `issuedAt + 29 days`.
- It re-signs the 7 manifests and then the catalog through the **same release signer** as the
  originals: `component-signing.mjs` wrapping `tooling/component-signer`, with the key store given as
  `--store` at run time.
- It verifies the result three ways:
  1. `verify-manifest` ×7 and `verify-catalog` with the release signer against the pinned key.
  2. A byte-level comparison with the previous signed payloads.
  3. The app's own verifier, the `kalcode-kalvoice` example `component_catalog_check`. It runs
     `ComponentVerifier` + `verify_catalog` with the production contract. It then checks
     `advance_catalog_floor(previous floor → new)` and `authorize_transition` for every manifest.
     Finally it checks that the reverse (new floor → old catalog) is refused as `RollbackDenied`.
- It writes `publication.json` for `component-publish.mjs`, plus `renewal-record.json`. It never
  publishes anything.

It refuses the renewal, with a `code:`, in these cases:

| Code | Meaning |
|---|---|
| `sequence_not_increasing`, `invalid_sequence` | The new sequence is ≤ the published one: equal is `ConflictingSequence`, lower is `RollbackDenied` |
| `stale_previous`, `below_floor` | `--floor-sequence` (the live D1 pointer) is above the supplied catalog, or ≥ the new sequence |
| `artifact_changed` | The artifact bytes, `sha256`, `sizeBytes` or `artifactUrl` differ from the published manifest |
| `field_changed` | Any signed field other than `sequence`/`issuedAt`/`expiresAt` would change |
| `wrong_key` | The key store's public key ≠ the pinned key (checked **before** any signature), or the previous catalog is not signed by it |
| `invalid_window` | `issuedAt` is in the future or not after the old one, or the new window does not end after the old one |
| `output_not_fresh` | The output directory exists and is not empty |
| `app_verifier_rejected` | The kalvoice verifier refused the result |

## Fixed paths

```powershell
$Repo      = 'C:\Users\Kaleb\Downloads\KalCode'
$Backup    = 'C:\Users\Kaleb\KalCode-component-workspaces-backup-20260928'   # R0
$WinPrev   = "$Backup\target_codex3-components"
$MacPrev   = "$Backup\target_recovery-20260926_macos-components"
$Pub       = "$Repo\.worktrees\component-publish-seq2"                   # clean main checkout (R2.1)
$Out       = 'C:\Users\Kaleb\KalCode-component-renewals\seq2'             # durable, outside the repo and target/
$Store     = "$env:LOCALAPPDATA\KalCode\ReleaseKeys\component-distribution-signing.dpapi"
```

The Mac workspace contains only the Mac `runtime.zip` and `runtime-build.json`. Its six model files
are the same bytes as in `$WinPrev`, so the Mac run searches `$MacPrev` first and then `$WinPrev`.

## R2: preconditions and key check (by 2026-10-13)

**R2.0 [OWNER] Key custody.**
- Confirm the component key store is present for your Windows user. Confirm that its offline backup
  from the 2026-09-30 item exists.
- Confirm that you approve its use to sign sequence 2 for both platforms.
- Do not move, copy or re-initialize the store. `signer init` refuses to overwrite a store, but never
  run it against `$Store`.

**R2.1 [CLAUDE] Clean publishing checkout** at a `main` commit that contains
`tooling/release/component-renew.mjs`, which means this branch must be merged first.
- `.worktrees/` is gitignored, so the tree stays clean.
- The remote publish in R5 refuses any dirty or untracked file.

```powershell
git -C $Repo fetch origin
git -C $Repo worktree add $Pub origin/main
cd $Pub; pnpm install --frozen-lockfile         # provides apps/website/node_modules/wrangler
git -C $Pub status --porcelain                  # must print nothing
Test-Path "$Pub\tooling\release\component-renew.mjs"   # True
```

If the branch is not merged by 2026-10-13, sign from the branch worktree instead (R3) and keep
`--publish-checkout $Pub`.
- `$Pub` must still be a clean `main` checkout.
- Its `component-public-key.json` must be identical to the pinned key; the tool checks this.

**R2.2 [CLAUDE] Backup integrity.** The artifacts must be byte-identical to R0:

```bash
cd /c/Users/Kaleb/KalCode-component-workspaces-backup-20260928 && sha256sum -c SHA256SUMS | grep -v ': OK$'
# Expected: only the self-referential "./SHA256SUMS: FAILED" line, and nothing else.
```

**R2.3 [CLAUDE] Key check** (plan R2). It prints only the status and a match verdict:

```powershell
cd $Pub
node --input-type=module -e "import {componentKeyStatus,componentPublicKey} from './tooling/release/component-signing.mjs'; import {readFileSync} from 'node:fs'; const storePath=process.argv[1]; const t=JSON.parse(readFileSync('tooling/release/component-public-key.json','utf8')); console.log(JSON.stringify(componentKeyStatus({storePath})), JSON.stringify(componentPublicKey({storePath}))===JSON.stringify(t)?'MATCHES tracked key':'MISMATCH')" $Store
```

Expected: `{"configured":true,"kid":"component-2026-1"} MATCHES tracked key`. **Stop on anything
else** and escalate to the owner.

**R2.4 [CLAUDE] Live floor.** Confirm that production still serves sequence 1. That value becomes
`--floor-sequence`.

```powershell
foreach ($p in 'windows/x86_64','macos/aarch64') {
  $t = (Invoke-WebRequest "https://kalcoded.com/components/v1/catalog/stable/$p.jws" -UseBasicParsing).Content.Trim()
  $b = $t.Split('.')[1].Replace('-','+').Replace('_','/'); $b += '=' * ((4 - $b.Length % 4) % 4)
  $c = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b)) | ConvertFrom-Json
  "$p seq=$($c.sequence) expires=$([DateTimeOffset]::FromUnixTimeSeconds($c.expiresAt).UtcDateTime.ToString('o'))"
}
```

If either sequence is not 1, stop.
- Someone has published since this runbook was written.
- Renew from that catalog's packet instead, with `--floor-sequence` set to its sequence.

**R2.5 [CLAUDE] Tooling tests.**

```powershell
cd $Pub
node --test tooling/release/component-renew.test.mjs          # policy (all platforms)
node --test tooling/release/component-renew.native.mjs        # real signer + kalvoice verifier, throwaway DPAPI TEST key
```

## R3: sign sequence 2 for both platforms (by 2026-10-13)

**R3.1 [CLAUDE] Dry preparation.** It does not touch the key. Review each `renewal-plan.json`: it
must show `1 -> 2` for the catalog and for all 7 manifests.

```powershell
cd $Pub
$Plan = "$env:TEMP\kalcode-renew-plan-$(Get-Date -Format yyyyMMddHHmmss)"
node tooling/release/component-renew.mjs --platform windows --previous-packet "$WinPrev\publication.json" --previous-catalog "$WinPrev\catalog.jws" --artifact-dir $WinPrev --output-dir "$Plan\windows" --floor-sequence 1 --prepare-only
node tooling/release/component-renew.mjs --platform macos --previous-packet "$MacPrev\publication.json" --previous-catalog "$MacPrev\catalog.jws" --artifact-dir $MacPrev --artifact-dir $WinPrev --output-dir "$Plan\macos" --floor-sequence 1 --prepare-only
```

**R3.2 [CLAUDE] One shared issue time** for both platforms (plan §3). Set it once, then run both
platforms within 5 minutes:

```powershell
$Issued = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
"issuedAt=$Issued expiresAt=$($Issued + 29*86400) ($([DateTimeOffset]::FromUnixTimeSeconds($Issued + 29*86400).UtcDateTime.ToString('o')))"
```

**R3.3 [CLAUDE, key use approved in R2.0] Sign.**

```powershell
cd $Pub
node tooling/release/component-renew.mjs --platform windows `
  --previous-packet "$WinPrev\publication.json" --previous-catalog "$WinPrev\catalog.jws" `
  --artifact-dir $WinPrev --output-dir "$Out\windows" `
  --store $Store --issued-at $Issued --sequence 2 --floor-sequence 1 --publish-checkout $Pub
node tooling/release/component-renew.mjs --platform macos `
  --previous-packet "$MacPrev\publication.json" --previous-catalog "$MacPrev\catalog.jws" `
  --artifact-dir $MacPrev --artifact-dir $WinPrev --output-dir "$Out\macos" `
  --store $Store --issued-at $Issued --sequence 2 --floor-sequence 1 --publish-checkout $Pub
```

Each run ends with:
- `kalvoice verify_catalog + advance_catalog_floor accepted sequence 2`
- `Nothing was published.`

The signer itself refuses a window that is not currently valid. If a run fails part-way:
- **Keep** the partial directory for audit.
- Re-run into a **new** output directory, for example `$Out\windows-2`. The tool refuses a
  non-empty one.
- Unpublished sequence-2 tokens are harmless.
- Once any R5 `--remote` attempt has touched D1 for sequence 2, **never** re-sign sequence 2. Use
  `--sequence 3`, because D1 version rows are insert-once.

**R3.4 [CLAUDE] Independent verification** from the publishing checkout:

```powershell
cd $Pub
foreach ($p in 'windows','macos') {
  node --input-type=module -e "import {verifyComponentCatalog} from './tooling/release/component-signing.mjs'; verifyComponentCatalog({publicKeyPath: process.argv[1], tokenPath: process.argv[2]}); console.log('release signer: OK')" "$Pub\tooling\release\component-public-key.json" "$Out\$p\catalog.jws"
}
cargo run --quiet --locked -p kalcode-kalvoice --example component_catalog_check -- --public-key-file "$Pub\tooling\release\component-public-key.json" --token "$Out\windows\catalog.jws" --previous-token "$WinPrev\catalog.jws" --platform windows
cargo run --quiet --locked -p kalcode-kalvoice --example component_catalog_check -- --public-key-file "$Pub\tooling\release\component-public-key.json" --token "$Out\macos\catalog.jws" --previous-token "$MacPrev\catalog.jws" --platform macos
Get-FileHash "$Out\windows\catalog.jws","$Out\macos\catalog.jws" -Algorithm SHA256
```

Each verifier line must include:
- `"ok":true`
- `"sequence":2`
- `"floorAdvancedTo":2`
- `"reverseRollbackDenied":true`

Record both catalog sha256 values on the board. The sha256 in `renewal-record.json` is of the token
**without** the trailing newline, which is what the publisher uploads. `Get-FileHash` includes the
newline, so the two values differ by design.

## R4: publisher dry run (by 2026-10-13)

**R4.1 [CLAUDE]** Run from the clean `$Pub` checkout. `publication.json.publicKeyPath` already
names `$Pub`'s tracked key.

```powershell
cd $Pub
node tooling/release/component-publish.mjs --packet "$Out\windows\publication.json" --dry-run
node tooling/release/component-publish.mjs --packet "$Out\macos\publication.json" --dry-run
git -C $Pub status --porcelain   # must still print nothing
```

Expected for each: `Verified component catalog stable/<platform>/<arch> sequence 2; N immutable
objects planned. No external effect occurred.`
- The dry run re-verifies every token and artifact.
- It applies the approved component contract, including the Windows/Mac runtime curation evidence,
  whose `createdAt` must be ≤ the new `issuedAt`.

**R4.2 [CLAUDE]** Append the results to `target/RELEASE-STATUS-BOARD.md`: output directories,
catalog sha256 values, `issuedAt`/`expiresAt`, and the dry-run lines. Then ask the owner for the R5
approval.

## After R4 (plan R5–R7, for reference)

- **R5 [OWNER approves → CLAUDE runs; OWNER re-logs Wrangler if needed]**
  - Run `node tooling/release/component-publish.mjs --packet "$Out\<platform>\publication.json" --remote`
    from `$Pub`.
  - Allow about 1–2 h per platform.
  - It compare-and-swaps the D1 pointer from 1 to 2. It refuses if the pointer already names a newer
    sequence.
- **R6 [CLAUDE]** Verify the public routes (`200`, `application/jose`,
  `x-kalcode-component-authority: d1-v1`, `etag` = the new sha) per plan §3 step 7.
- **R7 [OWNER Mac / CLAUDE Windows QA profile]** Install one speech model that is not yet installed.
  This proves that a client holding floor 1 accepts sequence 2.

## Recurring renewal (sequence N → N+1)

Renew every ≤ 21 days. If sequence 2 is issued around Oct 13, sequence 3 is due by about Nov 4.

Use the same commands with these changes:
- `--previous-packet "$Out\<platform>\publication.json"`. It names that catalog, so no
  `--previous-catalog` is needed.
- `--sequence N+1` and `--floor-sequence N`.
- A new `$Out` for sequence N+1.
- Keep `--artifact-dir $WinPrev` (and `$MacPrev` for the Mac run). The R0 backup holds the artifact
  bytes; they never change.
