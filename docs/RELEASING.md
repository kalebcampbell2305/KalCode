# Releasing KalCode desktop

How a KalCode desktop build gets from a commit to the **Download** button on kalcoded.com, and what
has actually been verified. The rule: the website shows a download only for a build that exists,
was built from a clean commit, passed the checks below and is being served. Nothing else is
claimed.

## Status

| Platform | Status |
| --- | --- |
| Windows 10 (1809) or later, x64 | NSIS per-user installer. Public builds must pass Azure Artifact Signing, timestamp, clean-install, update-mode and uninstall verification. |
| macOS | Not available. No macOS build machine or Apple signing. |
| Linux | Not available. No Linux build machine; never tested. |

When no verified build is published, `apps/website/src/data/releases.json` has `"latest": null`
and the site shows "no public build yet".

## Pipeline

```
pnpm release:updater-key:status                              prove DPAPI key matches tracked public key
pnpm release:build --channel stable
                          tooling/release/build-windows.mjs   clean commit to signed NSIS + .sig + build.json
pnpm release:verify       tooling/release/verify-windows.mjs  silent install/uninstall in a temp dir → verify.json
(E2E on the same commit)  pnpm --filter @kalcode/desktop build:e2e
                          KALCODE_E2E_CDP_PORT=9440 pnpm --filter @kalcode/desktop test:e2e
docs/releases/<v>.md      release notes with the evidence (must list the installer SHA-256)
pnpm release:publish:dry-run                                   every check, no upload
pnpm release:publish      tooling/release/publish.mjs          immutable R2 upload + atomic D1 pointer
commit releases.json, build and deploy the website
```

Everything lands in `dist/release/<version>/` (ignored by git): the installer, its detached
`.sig`, `build.json`, `verify.json`, the website manifest, and the channel updater manifest.

### 1. Build

`pnpm release:build --channel stable` refuses to run on a dirty working tree, runs
`pnpm --filter @kalcode/desktop tauri build --bundles nsis` and copies
`target/release/bundle/nsis/KalCode_<version>_x64-setup.exe` into the staging folder. It checks
the tree is still clean afterwards (the build must not change tracked files) and records the
version (from `apps/desktop/src-tauri/tauri.conf.json`), full commit, build time, size, SHA-256,
redacted Authenticode status, timestamp presence and toolchain versions in `build.json`. A
temporary release-only Tauri overlay sends every Windows binary and the NSIS installer through
Microsoft's Artifact Signing SignTool integration. The overlay and metadata are removed after the
build, so the normal development configuration never gains signing authority.

For a signed build, the release script also fails before compilation unless the updater signing
key in the current Windows user's DPAPI-protected external store matches
`tooling/release/updater-public-key.txt`. That public key is injected through
`KALCODE_UPDATER_PUBLIC_KEY` and compiled into the desktop binary. After Authenticode signing,
the same raw NSIS `.exe` is signed with Minisign. The trusted comment binds the exact file name
and semantic version. The detached `.sig` is immediately verified against the exact installer
bytes before `build.json` records redacted updater-signature evidence.

It also refuses if `bundle.windows.webviewInstallMode` is not `downloadBootstrapper` or the NSIS
install mode is not `currentUser`. `--unsigned-local` is accepted only with `--channel dev`; that
output is marked ineligible for public release and cannot pass `release:verify`.

### 2. Verify the installer

`pnpm release:verify` never starts KalCode. The release build of KalCode uses
`%APPDATA%\com.kalcode.desktop`, which on the development machine holds the owner's live
database, so the verification only installs and uninstalls:

1. The staged file still matches `build.json` (size, SHA-256), has a valid Authenticode signature
   and carries a trusted timestamp. Reports contain only status booleans, never certificate
   subject, address, thumbprint or other identity material.
2. **Safety preflight.** It stops with `skipped` (exit code 2) if KalCode is already installed:
   an uninstall entry named KalCode (HKCU or HKLM), `%LOCALAPPDATA%\KalCode`,
   `%LOCALAPPDATA%\Programs\KalCode`, `HKCU\Software\KalCode\KalCode`, or a `KalCode.lnk` on the
   desktop or in the Start menu. Installing over or uninstalling a real install would change it.
   It also stops if any `kalcode.exe` is running: the Tauri installer and uninstaller silently
   kill running `kalcode.exe` processes of the current user.
3. **Pass `no-shortcuts`**: `KalCode_<v>_x64-setup.exe /S /NS /D=<temp>\KalCode`. Checks
   `kalcode.exe` (product version, valid timestamped Authenticode signature and the same signing
   identity as the installer) and
   `uninstall.exe`, the per-user uninstall entry
   (`HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\KalCode`: DisplayName,
   DisplayVersion, Publisher, InstallLocation, UninstallString), no autostart value and no
   shortcuts. Then `uninstall.exe /S` and checks the files, uninstall entry and folder are gone.
4. **Pass `default`**: the same without `/NS`, and checks that the Start-menu and desktop
   shortcuts are created and then removed by the uninstaller.
5. **Pass `upgrade`**: installs a baseline copy without shortcuts, writes a non-user-data
   sentinel, reruns the installer with `/UPDATE`, proves the sentinel survived, verifies the
   installed app signature again, and then uninstalls.
6. `%APPDATA%\com.kalcode.desktop` and `%LOCALAPPDATA%\com.kalcode.desktop` are untouched: only
   their existence and the folder's own timestamp are compared. Neither is opened.

The Tauri uninstaller intentionally keeps `HKCU\Software\KalCode\KalCode` (the last install
location) unless "Delete the application data" is ticked. Because the preflight proved the key
did not exist, the script removes the copy its own run created and records that in `verify.json`.

**Where to run it.** Since 2026-09-24 the development machine has the owner's real KalCode
install, so `release:verify` stops at the preflight there (by design) and must not be forced.
Run build + verify on a clean Windows machine instead: a private CI Windows runner, a spare
Windows VM, or Windows Sandbox on a Pro/Enterprise edition (this machine runs Windows 11 Home,
which has no Sandbox). There is no public-release bypass: `publish` rejects a missing, skipped or
failed verification report.

For the private GitHub repository, `.github/workflows/windows-release-verify.yml` provides the
clean Windows runner without putting Azure credentials in CI. After a clean local signed build is
frozen, create a private **draft** release containing exactly its `build.json`, installer, and
installer `.sig`, then
dispatch the workflow at the exact build commit with the draft tag, version, full commit and
installer SHA-256. The workflow validates those immutable inputs, downloads only the three expected
assets, rechecks the SHA-256, verifies the updater signature using the tracked public key, checks
the redacted signing contract, runs `release:verify`, and uploads only
`verify.json` for seven days. Download that report into `dist/release/<version>/verify.json` before
the public publish dry run. Delete the temporary draft and tag after the report is recovered.

Use a distinct candidate tag such as `verify-0.2.0-<12-char-commit>` and dispatch the workflow
itself with `--ref <candidate-tag>`, passing the tag's full commit separately in the `commit`
input. The job resolves the tag and refuses when the workflow commit and candidate commit differ.
Do not replace assets on an existing candidate tag. Create a new tag if candidate bytes change.

### 3. Functional evidence (same commit)

The E2E suite drives the real compiled app (release profile with the `e2e` feature, built into
`target/e2e`) over WebView2's DevTools protocol, with an isolated temporary data folder. The
`e2e` feature only enables test hooks (data-folder override, WebView2 debugging); it is never used
for shipped installers.

```
pnpm --filter @kalcode/desktop build:e2e
KALCODE_E2E_CDP_PORT=9440 pnpm --filter @kalcode/desktop test:e2e
```

Record the result in the release notes.

### 4. Release notes

Write `docs/releases/<version>.md`: what is in the build, the artifact table (file, size,
SHA-256, signed: yes), the verification and E2E results and known
limitations. `publish` refuses if the notes are missing or do not contain the build's SHA-256, and
`pnpm check:releases` refuses a published manifest whose version has no notes. The manifest's
`notesUrl` is `/updates#release-<version with dots as dashes>` (for example
`/updates#release-0-1-0`), so the Updates page should carry an entry with that `id`. The legacy
`/changelog` route permanently redirects to `/updates`.

### 5. Publish

```
pnpm release:publish:dry-run   # all checks + the exact wrangler commands and manifest
pnpm release:publish           # the real thing
```

`publish` refuses unless: the build is Stable, Azure Artifact Signing and trusted timestamp
evidence are valid, the working tree is clean, HEAD is the build commit (or a later commit
that only adds `docs/releases/` notes, since the notes carry the SHA-256), `verify.json`
says `passed` for this exact build (commit and SHA-256), all three installer passes prove the
installed executable's signature, the staged file still matches its SHA-256, the release notes exist
and list the SHA-256, the manifest validates, the deployed release routes identify the D1 release
authority, and neither the live route nor the authoritative D1 row already selects a newer version
or this version with different bytes. HTTP probes have strict deadlines and 64 KiB body limits.

It then uploads digest-qualified immutable objects with `wrangler r2 object put … --remote`:

1. `kalcode-releases/releases/<version>/<artifact-sha256>/<file>`
2. `kalcode-releases/releases/<version>/<download-descriptor-sha256>.json`
3. `kalcode-releases/releases/updater/<channel>/<version>/<artifact-sha256>/<file>`
4. `kalcode-releases/releases/updater/<channel>/<version>/<artifact-sha256>/<signature-sha256>/<file>.sig`
5. `kalcode-releases/releases/updater/<channel>/<version>/<updater-descriptor-sha256>.json`

Different bytes always have different object keys, so concurrent same-version uploads cannot
replace each other. The script downloads and re-verifies every selected object, atomically claims
the immutable `(channel, version)` row in D1, and advances the channel with one monotonic D1 UPSERT.
The compare-and-set rejects stale publishers, equal-precedence build-metadata variants, and
same-version descriptor changes. Fixed public feed URLs resolve the selected immutable descriptor
through D1 and verify its SHA-256 before serving it; there is no production fallback to mutable R2
pointer objects. The script reads both public feeds back before writing
`apps/website/src/data/releases.json` and printing the deploy commands:

```
git add apps/website/src/data/releases.json && git commit -m "Release <version>: publish Windows x64 installer"
pnpm --filter @kalcode/website build
pnpm --filter @kalcode/website exec wrangler deploy
curl -sI https://kalcoded.com/download/windows-x64
```

`pnpm release:publish --local` uploads only the unsigned development installer and website
manifest to the local R2 simulation. It never creates an updater feed and leaves the committed
manifest alone. `pnpm release:smoke:local` then starts
`wrangler dev` on port 8790 and downloads the installer through the Worker, comparing its SHA-256.

### Rollback

The normal rollback is a higher-version release that restores the previous application behavior;
the monotonic channel pointer intentionally rejects silent downgrades and stale replay. The desktop
updater separately preserves the installed version and rolls back a failed local apply. Emergency
feed withdrawal or an exceptional downgrade is an owner-authorized database operation with an
audited exact-current-version precondition; do not overwrite an R2 pointer object or mutate an
immutable version row.

## One-time setup

### Azure Artifact Signing

1. Install Azure CLI and the official client tools:
   `winget install -e --id Microsoft.AzureCLI` and
   `winget install -e --id Microsoft.Azure.ArtifactSigningClientTools`.
2. Sign in with the official Azure CLI flow (`az login`). Do not create, export or store a private
   signing key in this repository.
3. Grant the release operator only **Artifact Signing Certificate Profile Signer** on the exact
   `kalcodesigning` / `kalcodewindows` profile scope. Broader subscription or account roles are
   unnecessary for signing.
4. The release tooling discovers the WinGet dlib beneath `%LOCALAPPDATA%` and the newest x64
   Windows SDK SignTool. A nonstandard runner may set both absolute
   `KALCODE_SIGNTOOL_PATH` and `KALCODE_ARTIFACT_SIGNING_DLIB_PATH`; configuring only one fails.

The short-lived Azure credential remains in the official CLI credential store. Release logs and
JSON evidence intentionally omit certificate subjects, addresses, thumbprints and SignTool output.
Artifact Signing rotates leaf certificates frequently, so the release does not pin a leaf,
thumbprint, subject, or public key. Before compilation, it signs a disposable probe through the
approved account/profile and extracts exactly one subscriber-specific Public Trust EKU beneath
Microsoft's Artifact Signing OID namespace. The generic Public Trust marker is rejected as an
identity. That exact subscriber EKU is compiled through `KALCODE_AUTHENTICODE_IDENTITY_OIDS`; every
bundled binary, installer, clean-machine install, and downloaded update must match it. KalCode's
approved public subscriber identity is pinned as
`1.3.6.1.4.1.311.97.208143396.135769116.211620001.449325895`. Operational logs and JSON evidence
record only whether the pin matched. See Microsoft's
[Artifact Signing certificate management](https://learn.microsoft.com/en-us/azure/artifact-signing/concept-certificate-management)
documentation for the durable subscriber identity EKU contract.

### Updater signing key

Run `pnpm release:updater-key:init` once on the authorized Windows release account. The command:

- generates the Minisign updater key in process;
- protects the private bytes with Windows DPAPI for the current user;
- writes the protected blob outside the repository at
  `%LOCALAPPDATA%\KalCode\ReleaseKeys\updater-signing.dpapi`;
- writes only the public verification key to `tooling/release/updater-public-key.txt`.

The helper never prints private material and decrypts it only inside its short-lived signing
process. `pnpm release:updater-key:status` proves the protected store still matches the tracked
public key. Preserve the DPAPI store and the Windows user profile through the secured machine
backup process. Losing that key means existing installations cannot trust a replacement updater
key; recovery requires a newly Authenticode-signed manual installer with an explicitly migrated
public key. Never copy cleartext private key material into Git, CI, release artifacts, logs, or
Cloudflare. Key rotation is a separate migration and the tooling refuses implicit replacement.

### Cloudflare release storage

1. Enable R2 on the Cloudflare account and authenticate Wrangler with access to the KalCode
   production account.
2. Create the private bucket once: `pnpm --filter @kalcode/website exec wrangler r2 bucket create kalcode-releases`.
3. Keep the existing `RELEASES` → `kalcode-releases` binding in
   `apps/website/wrangler.jsonc`. `wrangler deploy` fails closed when that bound bucket does not
   exist. The Worker treats a missing runtime binding as "no release" (downloads 404 while the
   rest of the site remains available).
4. Apply the website D1 migrations before deploying release routes. Production publication fails
   closed unless migration `0003_release_publication_pointers.sql` exists and the live routes return
   `X-KalCode-Release-Authority: d1-v1`.

The bucket stays private: files are only reachable through the Worker routes below. No public
bucket URL or r2.dev subdomain is needed.

## Hosting

R2 stores only digest-qualified immutable objects. D1 tables
`release_publication_versions` and `release_publication_pointers` select the current objects:

```
releases/<version>/<artifact-sha256>/<file>
releases/<version>/<download-descriptor-sha256>.json
releases/updater/<channel>/<version>/<artifact-sha256>/<file>
releases/updater/<channel>/<version>/<artifact-sha256>/<signature-sha256>/<file>.sig
releases/updater/<channel>/<version>/<updater-descriptor-sha256>.json
```

The digest is part of every immutable object's key. The publisher downloads and verifies the
exact bytes after upload and before it claims the immutable D1 version or advances the channel
pointer. A concurrent publication with different bytes therefore targets a different key; a
same-byte retry is idempotent. The supported Wrangler object command does not expose R2
conditional writes or custom metadata, so neither is claimed as an integrity boundary. The D1
pointer has an exact composite foreign key and trigger binding its channel, version, and
precedence key to the immutable version row, and its monotonic compare-and-set prevents an older
publisher from replacing a newer channel selection.

The Worker bounds descriptor reads, verifies each selected descriptor's SHA-256, and requires its
key and declared artifact size to match the D1-selected release record before streaming an
artifact. It does not claim to hash a large executable while streaming it. The native updater
independently verifies the downloaded executable's exact size, SHA-256, version-bound Minisign
signature, and Authenticode publisher before execution. The normal browser download retains the
signed descriptor SHA-256 and Windows Authenticode protections. The digest-qualified detached
`.sig` object remains private publication/readback evidence; the public updater descriptor carries
the inline signature consumed by Tauri and KalCode.

Worker routes (`apps/website/worker/downloads.ts`, hooked in `worker/index.ts` before the site
router; `www` and plain-HTTP requests are redirected by the site router first):

| Route | Serves | Cache |
| --- | --- | --- |
| `GET/HEAD /download/windows-x64` | the latest Windows installer (from `latest.json`) | `public, max-age=300, must-revalidate` |
| `GET/HEAD /download/<version>/<file>` | one D1-resolved pinned file | `public, max-age=31536000, immutable` |
| `GET/HEAD /releases/latest.json` | D1-selected download descriptor | `public, max-age=60, must-revalidate` |
| `GET/HEAD /releases/updater/<channel>.json` | D1-selected stable, beta, or dev feed | `public, max-age=60, must-revalidate` |
| `GET/HEAD /releases/updater/<channel>/<version>.json` | D1-resolved immutable version descriptor | `public, max-age=31536000, immutable` |
| `GET/HEAD /releases/updater/<channel>/<version>/<artifact-sha256>/<file>` | raw updater `.exe` | `public, max-age=31536000, immutable` |

Downloads stream from R2 with `Content-Type: application/vnd.microsoft.portable-executable`,
`Content-Disposition: attachment; filename="…"`, `Content-Length`, `ETag`, `Last-Modified`,
`Accept-Ranges: bytes` (single ranges → 206, so interrupted downloads resume; `If-None-Match` →
304) and the site's security headers (HSTS, CSP, nosniff, …). A missing release answers with the
site's own 404 page (status 404, heading "That download is not available."), a missing manifest
with a JSON 404, a storage error with a plain 503. Version and file names are validated before
they become R2 keys. Tests: `apps/website/tests/unit/downloads.test.ts` (routing, headers, ranges,
errors), `downloads-r2.test.ts` (against workerd's local R2) and `release-manifest.test.ts`.

## The manifest

`apps/website/src/data/releases.json`, typed by `apps/website/src/data/releases.d.ts`, schema
`tooling/release/releases.schema.json`, validated by `pnpm check:releases` (part of `pnpm check`):

```json
{
  "schemaVersion": 1,
  "latest": {
    "version": "0.1.0",
    "channel": "stable",
    "publishedAt": "2026-…Z",
    "commit": "<40-char sha>",
    "notesUrl": "/updates#release-0-1-0",
    "platforms": [
      {
        "os": "windows", "arch": "x64", "label": "Windows 10 (1809) or later, 64-bit",
        "kind": "nsis", "file": "KalCode_0.1.0_x64-setup.exe",
        "url": "/download/windows-x64", "pinnedUrl": "/download/0.1.0/KalCode_0.1.0_x64-setup.exe",
        "size": 0, "sha256": "<hex>", "signed": true
      }
    ]
  },
  "unavailable": [
    { "os": "macos", "label": "macOS", "reason": "Not available yet. …" },
    { "os": "linux", "label": "Linux", "reason": "Not available yet. …" }
  ]
}
```

Rules the validator enforces: every OS appears in `latest.platforms` or `unavailable`, never both;
`latest` is `null` until a publish; URLs are site-relative and served by the Worker; `signed` is
explicit.

## Signing and SmartScreen

Public Windows builds use Microsoft Azure Artifact Signing with the approved `kalcodesigning`
account and `kalcodewindows` Public Trust certificate profile in East US. The release-only Tauri
overlay invokes the official Artifact Signing dlib through the Windows SDK SignTool with SHA-256
file and RFC 3161 timestamp digests. The metadata and overlay are temporary, and neither the
repository nor release evidence contains certificate identity details.

`release:build` fails unless both the app binary and NSIS installer pass the signing command and
the staged installer has a valid timestamped Authenticode signature. `release:verify` rechecks the
installer and every installed app, including same-signer equality, while recording only redacted
status booleans. A public manifest is not produced unless `signed: true` and all signing, install,
upgrade and uninstall gates pass. Users can also compare the file with the SHA-256 in the release
notes:

```
Get-FileHash .\KalCode_<version>_x64-setup.exe -Algorithm SHA256
```

Authenticode proves the Windows publisher and protects the executable bytes. Tauri updater
signatures use a separate application-update key and are still required independently by the
stable updater feed; one signature system never substitutes for the other. KalCode verifies the
feed checksum, exact size, exact version-bound Minisign signature, and timestamped Authenticode
signature before it launches the raw NSIS installer in update mode.

## Installer behaviour (Tauri NSIS, KalCode configuration)

- **Per-user install, no admin**: `installMode: "currentUser"`. Default folder
  `%LOCALAPPDATA%\KalCode`; the uninstall entry is under HKCU; the last install folder is kept in
  `HKCU\Software\KalCode\KalCode`.
- **Shortcuts**: the interactive installer creates a Start-menu shortcut (`KalCode.lnk` directly
  in the user's Start Menu\Programs) and offers a desktop shortcut on the finish page. Silent
  (`/S`) and passive (`/P`) installs create both. `/NS` skips both.
- **Flags**: `/S` silent, `/P` passive (progress only), `/NS` no shortcuts, `/D=<dir>` install
  folder (last argument, unquoted), `/R` start the app after a silent or passive install,
  `/UPDATE` update mode (keeps shortcuts, skips the reinstall prompt).
- **WebView2**: if WebView2 is missing, the installer downloads Microsoft's bootstrapper
  (`downloadBootstrapper`); Windows 11 and current Windows 10 already have it.
- **Running app**: the installer and uninstaller close a running `kalcode.exe` (after asking in
  the interactive installer; silently with `/S`).
- **Upgrades and app data**: the installer never writes to or deletes `%APPDATA%\com.kalcode.desktop`
  or `%LOCALAPPDATA%\com.kalcode.desktop`. A silent upgrade installs over the existing folder. An
  interactive upgrade may run the old uninstaller first; app data is deleted only if the user
  ticks "Delete the application data" in the uninstaller (unticked by default; never in silent or
  update mode).

## Adding macOS and Linux later

Neither can be built or tested on the Windows development machine, and neither may appear as a
download until it has been built and tested for real. The path:

1. **CI runners** (for example GitHub Actions `macos-14` for Apple silicon + Intel universal,
   `ubuntu-22.04` for Linux) running the same steps: clean checkout, `pnpm install --frozen-lockfile`,
   `pnpm tauri build --bundles dmg` / `--bundles appimage,deb`, SHA-256, and the E2E suite where a
   driver exists (WebView2-based E2E is Windows-only; macOS/Linux need their own harness).
2. **macOS signing and notarization**: an Apple Developer ID certificate and `notarytool`
   credentials as CI secrets; Gatekeeper blocks unsigned, un-notarized apps by default, so macOS
   should not ship unsigned.
3. **Linux**: AppImage and `.deb`; optionally GPG-sign the checksums.
4. Extend `build`/`verify` records per platform, add `/download/macos-universal` and
   `/download/linux-x64` routes (same `serveFile` path in `worker/downloads.ts`), add the
   platforms to `buildManifest` in `tooling/release/manifest.mjs`, and remove them from
   `NOT_BUILT` only when a verified artifact is uploaded.
