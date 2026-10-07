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
- Each admitted job holds `leases\slot-N.json` (owner `Runner.Worker.exe` pid + start time). A slot runs one job at a time, so a new job's Before hook replaces any other lease for its own slot and stops that previous job's leftover tree only when it is provably the slot's own `Runner.Worker.exe` under the slot's account. A lease whose owner started before the last OS boot is stale for every slot. Other slots' live leases are never removed; After removes only its own job's lease. The hooks run from copies in `C:\ProgramData\KalCodeGatePool`: after changing `gate-worker-hook.ps1` or `gate-worker-pool.psm1`, redeploy with the elevated `install-gate-pool-hooks.ps1` while w1..w5 are idle.
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

A second PC2 runner, `kalcode-win-gate-2b` (account `kalcode-ci-2b`, root `C:\kalcode-ci-2b`), lets two lanes' PC2
halves gate at once. `windows/add-gate-runner-pc2.ps1` (one elevated run on that PC, next to
`setup-gate-runner.ps1`) creates it with the holding label `kalcode-gate-pc2-pending`. Once gate.yml and the
merge train accept it on main (each PC2 runner has its own port block: slot 1 adds 20), activate it with
`gh api -X PUT repos/kalebcampbell2305/KalCode/actions/runners/<id>/labels -f "labels[]=kalcode-gate-pc2"`.

On the second PC a machine lock keeps the Windows update proof (`kalcode-win-desktop-qa`) from overlapping any
gate half: `.github/scripts/pc2-machine-lock.ps1`, a reader/writer lock of OS file-sharing modes in
`C:\ProgramData\KalCodePC2\locks`. Gate halves hold it shared (both runners at once), the proof holds it
exclusively and has priority, waits are bounded, and a killed holder can never leave it stale.

The second PC started processes ~10x slower than the build PC (each git ~1.3 s vs ~0.14 s, gate
37410227962), so git- and process-heavy checks ran 3-8x slower there. `windows/tune-gate-pc2.ps1` (one
elevated run on that PC, no gate job running) measures git start and `git init` times, adds Defender path
exclusions for `C:\kalcode-ci` and the gate account's `%TEMP%`, switches to the High performance power
plan, measures again and writes a receipt to `C:\kalcode-ci`. `-MeasureOnly` only measures; `-Undo`
reverts.

## Build PC stability (nonpaged-pool leak)

Measured 2026-10-06 (two independent methods): the build PC's nonpaged pool reached 9.25 GB after
~44 h and only cleared on reboot. The top pool tags were `NtFC` (15.2M outstanding, 4.1 GB) and `File`
(5.6M, 2.2 GB), with the Filter Manager stream-context tags (`FMsl`/`FMsc`) tracking them. `NtFC` is
NTFS's own File-Control-Block tag (present only in `ntfs.sys`) and `File` is the I/O manager's
FILE_OBJECT tag: ~15M NTFS FCBs and ~5.6M file objects were being **pinned** in kernel pool, not
leaked by any one process (process handles came to only ~246k). The pin scales with build file churn -
`cargo`/`rustc`/`node` open and close millions of files per gate under `C:\kalcode-ci` and the `kc-*`
worktrees - and Windows Defender's on-access scanner (`WdFilter`) holds a reference to each through its
stream context. That exhausted pool is what produced `net::ERR_NO_BUFFER_SPACE` (WSAENOBUFS) and
`Tcpip 4231` (ephemeral ports exhausted) during lane gates. `gameflt` is **not** the cause (it does not
allocate `NtFC`); do not chase it.

`windows/tune-build-pc.ps1` (one elevated run on the build PC, no gate job running) fixes this at the
root by stopping the scan that pins the file objects, and widens the TCP ephemeral range the gates
exhaust:

- Defender **process** exclusions for the build toolchain (`rustc`, `cargo`, `rust-analyzer`, `link`,
  `cl`, `mspdbsrv`, `node`). Process exclusions are location-independent, so they cover every
  per-worktree `target\` and `node_modules` without naming the ~200 `kc-*` worktrees.
- Defender **path** exclusions for the persistent build trees (the gate runner work roots, the Cargo
  and rustup homes for the interactive user and each gate account, and each gate account's `%TEMP%`).
- TCP: the IPv4/IPv6 dynamic port range to 20000-65534 and `TcpTimedWaitDelay=30` (both persist and
  apply on the next reboot - the receipt reports `rebootRequired`).
- The High performance power plan.

It refuses while a gate or release job runs (changing Defender preferences mid-gate thrashes the scan
cache), measures nonpaged pool before and after, and writes a receipt to `C:\kc-handoff\pool-trace`.
`-MeasureOnly` only measures; `-Undo` reverts the exclusions, the TCP settings and the power plan. The
same trade-off `tune-gate-pc2.ps1` makes on PC2 applies here: only build and gate work writes under the
excluded paths, the gate account is low-privilege and only same-repository branches are gated.

## Resource-aware scheduling across machines

Many coding agents run alongside gates, releases and QA across three machines (the 64 GB build PC, the
second Windows PC, and the Mac). Order of precedence, from the Resource Governor rule (AGENTS.md) and
owner directives:

1. **UI and user-requested coding agents first.** Never blocked or killed for high CPU alone; the
   Resource Governor throttles optional background work first and only delays a user agent for genuine
   hard resource pressure, showing the real reason.
2. **Gates/builds distributed across machines.** The build PC runs `Gate (Windows)` + `Gate (Windows,
   native)` on the BelowNormal worker pool (heavy native work also holds one of three file locks and
   needs >=10 GiB free RAM); PC2 runs `Gate (Windows, PC2)` (JS/web) as `gate-split.mjs` assigns. Both
   halves gate the exact SHA in parallel and both must be green to land.
3. **Release QA.** PC2's desktop-QA runs the Windows update proofs (never while its gate half runs); the
   Mac runs Mac release builds and notarization over SSH. One coordinator lands and releases.
4. **Background maintenance lowest.**

During a lane gate the box can still be starved by **other sessions'** heavy non-gate builds (e.g. a
Codex `cargo test` compiling the same crate as the native job). The coordinator freezes those trees with
`windows/freeze.ps1 suspend -Roots <pid>...` and resumes them (`freeze.ps1 resume`) once the gate's
required jobs are green. Suspend is resumable (`NtSuspendProcess`) and never touches KalCode or the
runner, so it honours the never-kill rule. Measured 2026-10-06: freezing a Codex cargo-test tree during a
gate dropped the nonpaged-pool leak from ~90 to ~37 MB/min and CPU from 100% to 82%, and the native job
then ran in a clean environment. Local agent builds already run BelowNormal (`tooling/local-priority.mjs`).

## Workflows

- `.github/workflows/gate.yml` runs `node tooling/release/ship.mjs gate` (the same gate agents run locally) on the gate runner. Fork PRs never run. The checkout keeps no GitHub token. The job uses dedicated ports so it never collides with an agent session on the same PC. The legacy macOS job stays disabled under the current owner policy.
- `.github/workflows/release.yml` runs on the release runner after every push to `main` (and on `gh workflow run release.yml`). It calls `tooling/release/release-on-merge.mjs`:
  1. When `ship.mjs lifecycle status` reports unshipped desktop or docs lanes, it runs `ship.mjs run --version <X.Y.Z[+N]> --commit <sha> --phase all --execute`.
  2. The state lives in `%LOCALAPPDATA%\KalCode\release-pipeline\<version>-<sha12>`, outside the cleaned checkout.
  3. It posts the outcome as the `kalcode/release` commit status.
  4. It never approves or attests. After a person records an approval or attestation (`ship.mjs approve|attest ... --state <that dir>`), re-run the workflow to resume.
  5. It is off until the repository variable `KALCODE_AUTO_RELEASE` is `true`, so it never runs beside a release someone is driving by hand.
- `ci.yml` stays on GitHub-hosted runners and runs again whenever hosted Actions is available.
