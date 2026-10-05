# Self-hosted runners

KalCode's gates and releases run on the owner's own machines, so merging and shipping never depend on GitHub-hosted minutes (AGENTS.md, "Permanent release infrastructure rule"). GitHub only coordinates: it dispatches jobs to these runners. Self-hosted jobs run even while hosted Actions is on a billing hold (verified 2026-10-01).

A personal-account repository has no runner groups, so a runner label is not access control. Any branch's workflow can ask for any label. Isolation therefore comes from the operating-system account each runner uses, plus a runner-side guard:

| Runner | Machine / account | Labels | Runs | Credentials it can reach |
|---|---|---|---|---|
| `kalcode-win-gate` | Windows PC, local account `kalcode-ci`, Windows service | `kalcode-gate` | `gate.yml` for PRs (same repo only) and `main` | None. It has its own toolchain and caches under `C:\kalcode-ci` and can't read the owner's profile. |
| `kalcode-win-gate-w1`…`-w5` | The same Windows PC and `kalcode-ci` account, one Windows service each (`C:\kalcode-ci\runner-w<n>`) | `kalcode-gate` | The gate worker pool: any `gate.yml` job, side by side with `kalcode-win-gate` | None, same as `kalcode-win-gate`. |
| `kalcode-win-release` | Windows PC, the owner (`Kaleb`), starts at sign-in | `kalcode-release` | Only `release.yml` from `main`, enforced by `release-job-guard.ps1` as the runner's pre-job hook | Azure Artifact Signing login, DPAPI updater key, Wrangler |
| `kalcode-mac-gate` | Mac, hidden standard account `kalcodeci` (not an admin), LaunchDaemon | `kalcode-gate` (macOS) | The macOS Rust job in `gate.yml` | None. It can't read the owner's home folder or login Keychain (Developer ID, notary profile). |
| `kalcode-win-desktop-qa` | Second Windows PC, standard account `kalcode-qa`, a normal app in that account's signed-in desktop (Startup shortcut to `run.cmd`, not a service) | `kalcode-desktop-qa` | Only `desktop-update-verify.yml` from `main`: Windows update delivery from the live Stable feed with a real, visible KalCode window | None. A dedicated test profile; the check uninstalls KalCode and removes its data after each run. |

`kalcode-win-desktop-qa` exists because a service runs in session 0, where KalCode's window stays hidden, so a normal close and reopen can't be proven there. Its desktop must stay signed in: after the second PC restarts, sign in to `kalcode-qa` once and switch back to your own account without signing out.

## Install

Windows gate runner (one elevated step):

```powershell
$t = gh api -X POST repos/kalebcampbell2305/KalCode/actions/runners/registration-token --jq .token
Start-Process powershell -Verb RunAs -ArgumentList "-ExecutionPolicy Bypass -File $PWD\tooling\runners\windows\setup-gate-runner.ps1 -RegistrationToken $t"
```

Gate worker pool (owner directives 2026-10-04: a parallel gate worker pool on the 64 GB build PC, at least 6 coding agents finishing at once; the second Windows machine is no longer used for gates). One elevated run adds five workers next to `kalcode-win-gate`, so six changes validate concurrently:

```powershell
$t = gh api -X POST repos/kalebcampbell2305/KalCode/actions/runners/registration-token --jq .token
Start-Process powershell -Verb RunAs -ArgumentList "-ExecutionPolicy Bypass -File $PWD\tooling\runners\windows\add-gate-workers.ps1 -RegistrationToken $t"
```

- Every worker runs as `kalcode-ci` with its own `_work` checkout and Cargo `target/` (about 30–60 GB each on disk). The script gives `kalcode-ci` one new password and updates every `kalcode-ci` runner service to it, the existing one included.
- Each runner's `.env` sets `KALCODE_GATE_SLOT` (0 for `kalcode-win-gate`). `gate.yml` moves every gate port by 10 × slot, so slots 0–9 never share a port.
- Gates run below normal priority, so the owner's KalCode and coding agents win the CPU. Heavy Rust gates take one of `KALCODE_GATE_HEAVY_SLOTS` machine-wide tokens (default 3) and start only with `KALCODE_GATE_MIN_FREE_GB` free memory (default 10). Light gates never wait.
- Inside one gate, independent checks run `KALCODE_GATE_CONCURRENCY` at a time (default 3). Checks that share a build (`exclusive` in `tooling/release/lifecycle/policy.json`) never overlap.
- `KALCODE_GATE_EVIDENCE_DIR` holds pass evidence keyed by exact tree, commands and gate env. Rerunning an identical tree reruns only the gates that didn't pass.
- Train evidence (`tooling/merge-train/github.mjs`, `MAIN_PC_GATE_RUNNER`) accepts exactly `kalcode-win-gate` and `kalcode-win-gate-w1`…`-w9`, and never `kalcode-win-gate-2`.

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
