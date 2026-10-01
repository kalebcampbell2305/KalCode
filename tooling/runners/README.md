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

Windows release runner (as the owner, no elevation):

```powershell
powershell -ExecutionPolicy Bypass -File tooling\runners\windows\setup-release-runner.ps1 -RegistrationToken (gh api -X POST repos/kalebcampbell2305/KalCode/actions/runners/registration-token --jq .token)
```

Mac gate runner (one `sudo` run on the Mac; it logs to `/tmp/kalcode-gate-setup.log`):

```bash
sudo bash tooling/runners/macos/setup-gate-runner.sh <registration-token>
```

macOS release work keeps the existing path: the release runner on Windows drives the Mac over SSH (`ship.mjs` phases `bundle-mac` and `package-mac`), so the Developer ID identity and notary profile stay in the owner's Mac session. Use Windows OpenSSH (`C:\Windows\System32\OpenSSH\ssh.exe`); the release key is held by the Windows `ssh-agent`.

The guard is copied next to the runner and wired as `ACTIONS_RUNNER_HOOK_JOB_STARTED` in the runner's `.env`. A job can't change either file, and a job the guard refuses fails before any of its steps run. Re-run the setup script after changing the guard.

## Workflows

- `.github/workflows/gate.yml` runs `node tooling/release/ship.mjs gate` (the same gate agents run locally) on the gate runner. Fork PRs never run. The checkout keeps no GitHub token. The job uses dedicated ports so it never collides with an agent session on the same PC. The macOS job runs when the repository variable `KALCODE_MAC_GATE` is `true` (set on 2026-10-01, once `kalcode-mac-gate` was online).
- `ci.yml` stays on GitHub-hosted runners and runs again whenever hosted Actions is available.
