# Releasing KalCode desktop

How a KalCode desktop build gets from a commit to the **Download** button on kalcoded.com, and what
has actually been verified. The rule: the website shows a download only for a build that exists,
was built from a clean commit, passed the checks below and is being served. Nothing else is
claimed.

## Status

| Platform | Status |
| --- | --- |
| Windows 10 (1809) or later, x64 | Built and verified on Windows 11. NSIS per-user installer. **Not code-signed.** |
| macOS | Not available. No macOS build machine or Apple signing. |
| Linux | Not available. No Linux build machine; never tested. |

Until the first publish, `apps/website/src/data/releases.json` has `"latest": null` and the site
shows "no public build yet".

## Pipeline

```
pnpm release:build        tooling/release/build-windows.mjs   clean commit → NSIS installer + build.json
pnpm release:verify       tooling/release/verify-windows.mjs  silent install/uninstall in a temp dir → verify.json
(E2E on the same commit)  pnpm --filter @kalcode/desktop build:e2e
                          KALCODE_E2E_CDP_PORT=9440 pnpm --filter @kalcode/desktop test:e2e
docs/releases/<v>.md      release notes with the evidence (must list the installer SHA-256)
pnpm release:publish:dry-run                                   every check, no upload
pnpm release:publish      tooling/release/publish.mjs          R2 upload + writes releases.json
commit releases.json, build and deploy the website
```

Everything lands in `dist/release/<version>/` (ignored by git): the installer, `build.json`,
`verify.json` and `latest.json`.

### 1. Build

`pnpm release:build` refuses to run on a dirty working tree, runs
`pnpm --filter @kalcode/desktop tauri build --bundles nsis` and copies
`target/release/bundle/nsis/KalCode_<version>_x64-setup.exe` into the staging folder. It checks
the tree is still clean afterwards (the build must not change tracked files) and records the
version (from `apps/desktop/src-tauri/tauri.conf.json`), full commit, build time, size, SHA-256,
Authenticode status and toolchain versions in `build.json`.

It also refuses if `bundle.windows.webviewInstallMode` is not `downloadBootstrapper` or the NSIS
install mode is not `currentUser`.

### 2. Verify the installer

`pnpm release:verify` never starts KalCode. The release build of KalCode uses
`%APPDATA%\com.kalcode.desktop`, which on the development machine holds the owner's live
database, so the verification only installs and uninstalls:

1. The staged file still matches `build.json` (size, SHA-256); the recorded signature status is
   the real one.
2. **Safety preflight.** It stops with `skipped` (exit code 2) if KalCode is already installed:
   an uninstall entry named KalCode (HKCU or HKLM), `%LOCALAPPDATA%\KalCode`,
   `%LOCALAPPDATA%\Programs\KalCode`, `HKCU\Software\KalCode\KalCode`, or a `KalCode.lnk` on the
   desktop or in the Start menu. Installing over or uninstalling a real install would change it.
   It also stops if any `kalcode.exe` is running: the Tauri installer and uninstaller silently
   kill running `kalcode.exe` processes of the current user.
3. **Pass `no-shortcuts`**: `KalCode_<v>_x64-setup.exe /S /NS /D=<temp>\KalCode`. Checks
   `kalcode.exe` (product version; identical to `target/release/kalcode.exe` except the 3-byte
   bundle-type marker Tauri stamps as `NSS`) and
   `uninstall.exe`, the per-user uninstall entry
   (`HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\KalCode`: DisplayName,
   DisplayVersion, Publisher, InstallLocation, UninstallString), no autostart value and no
   shortcuts. Then `uninstall.exe /S` and checks the files, uninstall entry and folder are gone.
4. **Pass `default`**: the same without `/NS`, and checks that the Start-menu and desktop
   shortcuts are created and then removed by the uninstaller.
5. `%APPDATA%\com.kalcode.desktop` and `%LOCALAPPDATA%\com.kalcode.desktop` are untouched: only
   their existence and the folder's own timestamp are compared. Neither is opened.

The Tauri uninstaller intentionally keeps `HKCU\Software\KalCode\KalCode` (the last install
location) unless "Delete the application data" is ticked. Because the preflight proved the key
did not exist, the script removes the copy its own run created and records that in `verify.json`.

**Where to run it.** Since 2026-09-24 the development machine has the owner's real KalCode
install, so `release:verify` stops at the preflight there (by design) and must not be forced.
Run build + verify on a clean Windows machine instead: a GitHub Actions `windows-latest` runner,
a spare Windows VM, or Windows Sandbox on a Pro/Enterprise edition (this machine runs Windows 11
Home, which has no Sandbox). If a release has to be published without that test, pass
`--without-install-test` to `publish`; it then requires the release notes to say, on one line,
that the install test was not run for this build.

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
SHA-256, signed: no), the verification and E2E results, the SmartScreen note and known
limitations. `publish` refuses if the notes are missing or do not contain the build's SHA-256, and
`pnpm check:releases` refuses a published manifest whose version has no notes. The manifest's
`notesUrl` is `/changelog#release-<version with dots as dashes>` (for example
`/changelog#release-0-1-0`), so the changelog page should carry an entry with that `id`.

### 5. Publish

```
pnpm release:publish:dry-run   # all checks + the exact wrangler commands and manifest
pnpm release:publish           # the real thing
```

`publish` refuses unless: the working tree is clean, HEAD is the build commit (or a later commit
that only adds `docs/releases/` notes, since the notes carry the SHA-256), `verify.json`
says `passed` for this exact build (commit and SHA-256; or `--without-install-test` with the
notes saying so), the staged file still matches its SHA-256, the release notes exist
and list the SHA-256, the manifest validates, and the live `https://kalcoded.com/releases/latest.json`
does not already have this version with different bytes (pinned URLs are cached as immutable, so
a changed build needs a version bump).

It then uploads, in this order, with `wrangler r2 object put … --remote`:

1. `kalcode-releases/releases/<version>/<file>` (the installer)
2. `kalcode-releases/releases/latest.json` (the manifest; only after the file it points at exists)

reads `latest.json` back to confirm, writes `apps/website/src/data/releases.json` and prints the
deploy commands:

```
git add apps/website/src/data/releases.json && git commit -m "Release <version>: publish Windows x64 installer"
pnpm --filter @kalcode/website build
pnpm --filter @kalcode/website exec wrangler deploy
curl -sI https://kalcoded.com/download/windows-x64
```

`pnpm release:publish --local` does the same against the local R2 simulation that `wrangler dev`
uses and leaves the committed manifest alone. `pnpm release:smoke:local` then starts
`wrangler dev` on port 8790 and downloads the installer through the Worker, comparing its SHA-256.

### Rollback

Point the manifest back at the previous version (its files are still in R2) and redeploy the site:

```
cd apps/website
pnpm exec wrangler r2 object put kalcode-releases/releases/latest.json --file ../../dist/release/<previous>/latest.json --content-type "application/json; charset=utf-8" --remote
git revert <the "Release <version>" commit>   # restores the previous releases.json
pnpm build && pnpm exec wrangler deploy
```

To withdraw a build entirely, publish a manifest with `"latest": null` the same way.

## One-time setup

1. **Enable R2** on the Cloudflare account (dashboard → R2 Object Storage). As of 2026-09-24 the
   account returns `Please enable R2 through the Cloudflare Dashboard [code: 10042]`, so the
   bucket does not exist yet. Usage within R2's free allowance (storage, operations; egress is
   free) costs nothing, but enabling it is a dashboard step for the account owner.
2. `pnpm --filter @kalcode/website exec wrangler r2 bucket create kalcode-releases`
3. The Worker's binding is already in `apps/website/wrangler.jsonc` (`RELEASES` →
   `kalcode-releases`). **`wrangler deploy` fails while the bucket does not exist**, so do steps 1
   and 2 before deploying a website build that includes the binding. The Worker itself treats a
   missing binding as "no release" (downloads 404, the site works).

The bucket stays private: files are only reachable through the Worker routes below. No public
bucket URL or r2.dev subdomain is needed.

## Hosting

R2 object layout:

```
releases/latest.json                          the manifest (same document as releases.json)
releases/<version>/KalCode_<version>_x64-setup.exe
```

Worker routes (`apps/website/worker/downloads.ts`, hooked in `worker/index.ts` before the site
router; `www` and plain-HTTP requests are redirected by the site router first):

| Route | Serves | Cache |
| --- | --- | --- |
| `GET/HEAD /download/windows-x64` | the latest Windows installer (from `latest.json`) | `public, max-age=300, must-revalidate` |
| `GET/HEAD /download/<version>/<file>` | one pinned file | `public, max-age=31536000, immutable` |
| `GET/HEAD /releases/latest.json` | the manifest | `public, max-age=60, must-revalidate` |

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
    "channel": "preview",
    "publishedAt": "2026-…Z",
    "commit": "<40-char sha>",
    "notesUrl": "/changelog#release-0-1-0",
    "platforms": [
      {
        "os": "windows", "arch": "x64", "label": "Windows 10 (1809) or later, 64-bit",
        "kind": "nsis", "file": "KalCode_0.1.0_x64-setup.exe",
        "url": "/download/windows-x64", "pinnedUrl": "/download/0.1.0/KalCode_0.1.0_x64-setup.exe",
        "size": 0, "sha256": "<hex>", "signed": false
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

There is no code-signing certificate, so the installer and `kalcode.exe` are **unsigned**
(`signed: false` in the manifest and release notes). On first run Windows SmartScreen shows
"Windows protected your PC" because the publisher is unknown and the file has no download
reputation yet. Users who trust the download can choose **More info → Run anyway**. They can
check the file first against the SHA-256 in the release notes:

```
Get-FileHash .\KalCode_<version>_x64-setup.exe -Algorithm SHA256
```

Signing later means an Authenticode certificate (OV/EV, or a cloud signing service), configured
through `bundle.windows.signCommand` or `certificateThumbprint` in `tauri.conf.json`, with the
signature status recorded by `release:build` (it already reads it) and `signed: true` then
following automatically. Tauri's updater signatures (for in-app updates) are a separate key and
are not set up.

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
