# Self-hosted runners

KalCode's gates and releases run on the owner's own machines, so merging and shipping never depend on GitHub-hosted minutes (AGENTS.md, "Permanent release infrastructure rule"). GitHub only coordinates: it dispatches jobs to these runners. Self-hosted jobs run even while hosted Actions is on a billing hold (verified 2026-10-01).

A personal-account repository has no runner groups, so a runner label is not access control. Any branch's workflow can ask for any label. Isolation therefore comes from the operating-system account each runner uses, plus a runner-side guard:

| Runner | Machine / account | Labels | Runs | Credentials it can reach |
|---|---|---|---|---|
| `kalcode-win-gate` | Windows PC, local account `kalcode-ci`, Windows service | `kalcode-gate` | `gate.yml` for PRs (same repo only) and `main` | None. It has its own toolchain and caches under `C:\kalcode-ci` and can't read the owner's profile. |
| `kalcode-win-gate-w1`…`-w5` | Main Windows PC, separate `kalcode-ci-w1`…`-w5` accounts and services | `kalcode-gate,kalcode-main-pc` after staged verification | Independent gate jobs alongside the preserved original runner | None; private worker profiles and administrator-owned tools. |
| `kalcode-win-release` | Windows PC, the owner (`Kaleb`), starts at sign-in | `kalcode-release` | Only `release.yml` from `main`, enforced by `release-job-guard.ps1` as the runner's pre-job hook | Azure Artifact Signing login, DPAPI updater key, Wrangler |
| `kalcode-mac-gate` | Legacy runner, disabled | Legacy labels only | No current gates; keep `KALCODE_MAC_GATE` disabled | Do not provision or activate the old hidden account. |
| `kalcode-win-desktop-qa` | Retired second-PC runner | Legacy labels only | No current builds, tests or QA | Do not submit jobs to this machine. |

Windows desktop QA runs in the isolated interactive QA session on the owner's main 64 GB PC. A Windows service runs in session 0 and cannot prove visible close/reopen behavior. Preserve the owner's account and active app; use the reviewed main-PC QA helpers. Mac release verification uses the owner's `kalebcampbell` account.

## Install

The original Windows gate runner is already installed. Preserve its account, credentials and service; use the additive pool installer below to add capacity.

Gate worker pool (main 64 GB PC only): six physical slots, `kalcode-win-gate` at slot 0 and `kalcode-win-gate-w1` through `-w5` at slots 1–5. The existing runner stays untouched. Each new service uses its own standard account (`kalcode-ci-w1` through `-w5`), private checkout, Cargo cache, browser cache and temporary directory under `C:\kalcode-ci-pool\worker-wN`.

`tooling/runners/windows/add-gate-workers.ps1` remains the entry point; without arguments it prints the read-only plan. Installation requires the reviewed `invoke-gate-worker-pool-install.ps1` wrapper, an exact four-source manifest and hash, the official runner archive hash, and a fresh JSON receipt path. Launch that wrapper hidden through normal Windows UAC. It stages verified source in an administrator-only directory and fetches a short-lived GitHub registration token inside the elevated process. Never put tokens or account passwords in launch arguments. It never resets the original account, rewrites its environment or restarts its service.

For a setup without Cargo compilation, pass `-ToolsManifest` and `-ToolsManifestSha256` for exactly the reviewed `cargo-deny.exe` 0.20.2 and `cargo-audit.exe` 0.22.2 binaries. The wrapper stages only those hash-verified executables; installation rechecks their bytes and versions. It never copies owner configuration or credentials, and an invalid supplied manifest stops setup instead of falling back to a build.

- New runners register with `kalcode-gate-pool-staging,kalcode-main-pc`. Add the production `kalcode-gate` label only after the compatible workflow and main-PC identity checks are ready. Preserve existing active gates.
- `KALCODE_GATE_SLOT` is the shared slot identity. `Get-GateWorkerPlan -Slot 0..5` assigns separate frontend ports at a 20-port offset and native CDP bands at `19333 + 1000 * slot`, including Browser child ports. All plans are bound to `DESKTOP-KOOB7VV`.
- Protected pre/post hooks admit at most six optional jobs, with real CPU, RAM, committed-memory and disk pressure checks. Jobs run BelowNormal. Unknown pressure remains queued; timeouts fail honestly. Heavy native work additionally needs one of three held-file locks under `C:\ProgramData\KalCodeGatePool\heavy` and at least 10 GiB free RAM. No timeout bypass is allowed.
- Workers start at `KALCODE_GATE_CONCURRENCY=2`, `CARGO_BUILD_JOBS=2`, `VITEST_MAX_WORKERS=2`; pressure throttling reduces optional checks before affecting user agents. Six or more coding agents may submit independent work; these are infrastructure slots, never coding-agent limits.
- Shared tools are administrator-owned and read-only to workers. Reports under `C:\ProgramData\KalCodeGatePool\reports` are readable by the owner without exposing private CI profiles. Evidence stays exact-source/toolchain bound; a cached fixture result never establishes a production candidate PASS.
- `gate-pool-probe.yml` runs six independent lightweight cases with four concurrent jobs, one deliberate real child failure and `fail-fast:false`. Its verifier requires at least 30 seconds of four distinct physical workers overlapping, exact source/run identity, and continued completion of the other five cases. Six configured/online services and this operational proof are required before calling the pool ready.
- A failed install is inspected with the separate read-only diagnostic. The only supported partial-state resume is the explicitly hash-bound, inspected pre-tool checksum failure: unchanged ACLs and source, no new accounts/services, empty worker/shared directories and the single verified rustup download. Any other partial state requires diagnosis; nothing is reset or deleted.

Windows release runner (as the owner, no elevation):

```powershell
powershell -ExecutionPolicy Bypass -File tooling\runners\windows\setup-release-runner.ps1 -RegistrationToken (gh api -X POST repos/kalebcampbell2305/KalCode/actions/runners/registration-token --jq .token)
```

The legacy Mac gate is disabled under the current main-PC validation policy. Do not install a new hidden account or activate it.

macOS release work keeps the existing path: the release runner on Windows drives the Mac over SSH (`ship.mjs` phases `bundle-mac` and `package-mac`), so the Developer ID identity and notary profile stay in the owner's Mac session. Use Windows OpenSSH (`C:\Windows\System32\OpenSSH\ssh.exe`); the release key is held by the Windows `ssh-agent`.

The guard is copied next to the runner and wired as `ACTIONS_RUNNER_HOOK_JOB_STARTED` in the runner's `.env`. A job can't change either file, and a job the guard refuses fails before any of its steps run. Re-run the setup script after changing the guard.

## Split gate: build PC + second PC

Owner, 2026-10-05: split gate work across both Windows PCs so neither pins its CPU. `gate.yml` runs two
Windows jobs on the same event SHA: `Gate (Windows)` on the build PC's pool (Rust, desktop frontend/UI,
native E2E and anything not listed for the second PC) and `Gate (Windows, PC2)` on the second PC
(`biome`, `branding`, `capabilities`, `zero-cost`, `release-manifest`, `packages`, `tooling-unit`, `api`,
`website`, `website-e2e`, `website-checkout-e2e`, `pnpm-audit`; the list lives in
`tooling/release/lifecycle/gate-split.mjs`). The merge train lands a candidate only when both jobs passed
for that exact SHA (a workflow without the PC2 job keeps single-job evidence).

The PC2 job runs on `kalcode-win-gate-2` (the second PC's gate account) without the build-PC pool hooks,
at below-normal priority, on fixed ports (pool base + 200). That account needs Git, Node.js and pnpm on
its PATH; the job installs Playwright's Chromium and the pinned portable Python itself. Activate it once
the runner is online and idle:

```powershell
gh api -X PUT repos/kalebcampbell2305/KalCode/actions/runners/25/labels -f "labels[]=kalcode-gate-pc2"
```

Until it carries `kalcode-gate-pc2`, the PC2 job stays queued and candidates do not land, so activate the
label together with landing this workflow. Removing the label later requires reverting to the single-job
workflow first.

The second PC started processes ~10x slower than the build PC (each git ~1.3 s vs ~0.14 s, gate
37410227962), so git- and process-heavy checks ran 3-8x slower there. `windows/tune-gate-pc2.ps1` (one
elevated run on that PC, no gate job running) measures git start and `git init` times, adds Defender path
exclusions for `C:\kalcode-ci` and the gate account's `%TEMP%`, switches to the High performance power
plan, measures again and writes a receipt to `C:\kalcode-ci`. `-MeasureOnly` only measures; `-Undo`
reverts.

## Workflows

- `.github/workflows/gate.yml` runs `node tooling/release/ship.mjs gate` (the same gate agents run locally) on the gate runner. Fork PRs never run. The checkout keeps no GitHub token. The job uses dedicated ports so it never collides with an agent session on the same PC. The legacy macOS job stays disabled under the current owner policy.
- `.github/workflows/release.yml` runs on the release runner after every push to `main` (and on `gh workflow run release.yml`). It calls `tooling/release/release-on-merge.mjs`:
  1. When `ship.mjs lifecycle status` reports unshipped desktop or docs lanes, it runs `ship.mjs run --version <X.Y.Z[+N]> --commit <sha> --phase all --execute`.
  2. The state lives in `%LOCALAPPDATA%\KalCode\release-pipeline\<version>-<sha12>`, outside the cleaned checkout.
  3. It posts the outcome as the `kalcode/release` commit status.
  4. It never approves or attests. After a person records an approval or attestation (`ship.mjs approve|attest ... --state <that dir>`), re-run the workflow to resume.
  5. It is off until the repository variable `KALCODE_AUTO_RELEASE` is `true`, so it never runs beside a release someone is driving by hand.
- `ci.yml` stays on GitHub-hosted runners and runs again whenever hosted Actions is available.
