# Self-hosted runners

KalCode's gates and releases run on the owner's own machines, so merging and shipping never depend on GitHub-hosted minutes (AGENTS.md, "Permanent release infrastructure rule"). GitHub only coordinates: it dispatches jobs to these runners. Self-hosted jobs run even while hosted Actions is on a billing hold (verified 2026-10-01).

A personal-account repository has no runner groups, so a runner label is not access control. Any branch's workflow can ask for any label. Isolation therefore comes from the operating-system account each runner uses, plus a runner-side guard:

| Runner | Machine / account | Labels | Runs | Credentials it can reach |
|---|---|---|---|---|
| `kalcode-win-gate` | Windows PC, local account `kalcode-ci`, Windows service | `kalcode-gate` | `gate.yml` for PRs (same repo only) and `main` | None. It has its own toolchain and caches under `C:\kalcode-ci` and can't read the owner's profile. |
| `kalcode-win-release` | Windows PC, the owner (`Kaleb`), starts at sign-in | `kalcode-release` | Only `release.yml` from `main`, enforced by `release-job-guard.ps1` as the runner's pre-job hook | Azure Artifact Signing login, DPAPI updater key, Wrangler |
| `kalcode-mac-gate` | Mac, hidden standard account `kalcodeci` (not an admin), LaunchDaemon | `kalcode-gate` (macOS) | The macOS Rust job in `gate.yml` | None. It can't read the owner's home folder or login Keychain (Developer ID, notary profile). |

## Install

Windows gate runner (one elevated step):

```powershell
$t = gh api -X POST repos/kalebcampbell2305/KalCode/actions/runners/registration-token --jq .token
Start-Process powershell -Verb RunAs -ArgumentList "-ExecutionPolicy Bypass -File $PWD\tooling\runners\windows\setup-gate-runner.ps1 -RegistrationToken $t"
```

Second Windows gate machine (owner directive 2026-10-04: gates move off the build PC; release builds never do). Same script, its own name and label, so it never replaces this PC's runner:

```powershell
$t = gh api -X POST repos/kalebcampbell2305/KalCode/actions/runners/registration-token --jq .token
Start-Process powershell -Verb RunAs -ArgumentList "-ExecutionPolicy Bypass -File $PWD\tooling\runners\windows\setup-gate-runner.ps1 -RegistrationToken $t -RunnerName kalcode-win-gate-2 -Labels kalcode-gate-2"
```

Once it shows Idle under Settings → Actions → Runners, the Windows job in `gate.yml` targets `kalcode-gate-2`.

Windows release runner (as the owner, no elevation):

```powershell
powershell -ExecutionPolicy Bypass -File tooling\runners\windows\setup-release-runner.ps1 -RegistrationToken (gh api -X POST repos/kalebcampbell2305/KalCode/actions/runners/registration-token --jq .token)
```

Mac gate runner (one `sudo` run on the Mac; it logs to `/tmp/kalcode-gate-setup.log`):

```bash
sudo bash tooling/runners/macos/setup-gate-runner.sh <registration-token>
```

The Mac gate also requires the official CMake 4.4.3 universal distribution at
`/Users/Shared/KalCode-gate-tools/cmake-4.4.3-macos-universal/CMake.app`.
Provision and verify it outside PR jobs; `kalcodeci` must be able to read and
execute it, but must not be able to replace its files or ancestor directories.
The gate fails if it is missing and uses the release packager's selected-SDK
environment for the production Whisper feature. PR jobs do not install tools.

macOS release work keeps the existing path: the release runner on Windows drives the Mac over SSH (`ship.mjs` phases `bundle-mac` and `package-mac`), so the Developer ID identity and notary profile stay in the owner's Mac session. Use Windows OpenSSH (`C:\Windows\System32\OpenSSH\ssh.exe`); the release key is held by the Windows `ssh-agent`.

The guard is copied next to the runner and wired as `ACTIONS_RUNNER_HOOK_JOB_STARTED` in the runner's `.env`. A job can't change either file, and a job the guard refuses fails before any of its steps run. Re-run the setup script after changing the guard.

## Workflows

- `.github/workflows/gate.yml` runs `node tooling/release/ship.mjs gate` (the same gate agents run locally) on the gate runner. Fork PRs never run. The checkout keeps no GitHub token. The job uses dedicated ports so it never collides with an agent session on the same PC. The macOS job runs when the repository variable `KALCODE_MAC_GATE` is `true` (set on 2026-10-01, once `kalcode-mac-gate` was online).
  - The macOS job first waits (up to 120 min, then runs anyway) while a release is packaging on the same Mac, so a gate compile never slows release packaging. It treats any of these as "packaging": a marker `/Users/Shared/KalCode-release/packaging.lock` modified within the last 3 hours (a release launcher may create it at start and remove it on exit; an older marker is ignored), a `kalebcampbell` process whose arguments name `com.kalcode.release.package`, `run-production-macos-package-` or `KalCode-final-`, or `kalebcampbell` `cargo`/`rustc` processes. The argument check works from `kalcodeci` today: the first gate after this change (run 37086307393, 2026-10-03) found the running package job's processes that way. The `cargo`/`rustc` name check is a fallback in case arguments are hidden. The job's `timeout-minutes` (240) covers the wait plus the gate.
- `.github/workflows/release.yml` runs on the release runner after every push to `main` (and on `gh workflow run release.yml`). It calls `tooling/release/release-on-merge.mjs`:
  1. When `ship.mjs lifecycle status` reports unshipped desktop or docs lanes, it runs `ship.mjs run --version <X.Y.Z[+N]> --commit <sha> --phase all --execute`.
  2. The state lives in `%LOCALAPPDATA%\KalCode\release-pipeline\<version>-<sha12>`, outside the cleaned checkout.
  3. It posts the outcome as the `kalcode/release` commit status.
  4. It never approves or attests. After a person records an approval or attestation (`ship.mjs approve|attest ... --state <that dir>`), re-run the workflow to resume.
  5. It is off until the repository variable `KALCODE_AUTO_RELEASE` is `true`, so it never runs beside a release someone is driving by hand.
- `ci.yml` stays on GitHub-hosted runners and runs again whenever hosted Actions is available.
