# Release pipeline (`ship.mjs`)

One command takes a KalCode desktop release from an exact commit to public verification:

```
node tooling/release/ship.mjs --version X.Y.Z --commit <sha40> [--baseline-version A.B.C] [--phase ...] [--execute]
pnpm release:ship --version X.Y.Z --commit <sha40> ...
```

It chains the existing, reviewed release tools (build and signing, certification, staging validators,
publish wrappers). It never re-implements them. It adds:

- resumable state;
- create-once receipts;
- hard gates between phases;
- pins derived from receipts instead of edited by hand.

**Dry run is the default.** Without `--execute` it prints the fully resolved plan for every selected phase:
exact commands, working directories, expected outputs, gate status and what a person must do. It runs
nothing and writes nothing.

[RELEASING.md](RELEASING.md) remains the reference for what each gate proves. This document covers how the
gates are chained.

## Inputs

A person supplies only three values. Everything else is read from the commit, from earlier receipts or
from the kit.

| Flag | Meaning |
| --- | --- |
| `--version` | Plain `x.y.z`. Stable refuses prereleases and build metadata. |
| `--commit` | Full 40-hex commit. The `identity` phase proves that `tauri.conf.json`, `apps/desktop/package.json` and `Cargo.toml` all declare `--version` at that exact commit (never the working tree), and that the commit compiles the moving Stable endpoint (so a derived baseline cannot be released as the candidate). |
| `--baseline-version` | The never-published lower version derived from the commit for the in-app update trial. It must be lower than `--version`. Burned versions stay burned, and preflight refuses a version that already has a D1 row. |

Optional flags:

- `--kit <manifest>`: default is the single kit in `tooling/release/ship/kits/` whose `binds` match.
- `--state <dir>`: default is `target/release-pipeline/<version>-<sha12>`.
- `--repo <dir>`: default is the main checkout, even when run from a worktree.

## Phases

The order, dependencies, effect class and approval requirement of every phase are fixed in
`tooling/release/ship/phases.mjs`. A kit cannot change them.

`--phase` accepts:

- `all` (the default);
- a phase id;
- a group, as `group:<name>` or by bare name when no phase has that id;
- a comma list of any of these.

| Group | Phase | Effect | Who |
| --- | --- | --- | --- |
| test | `identity` | read | automated (built in) |
| test | `prereqs` | read | automated. A failed credential probe means the owner renews that credential. |
| test | `branches` | local | automated: baseline derivation, T, N0, W, created locally and never pushed |
| test | `gates-windows`, `gates-mac` | local, mac | automated |
| build | `build-windows` | local | automated: build, Authenticode (Azure Artifact Signing) and updater Minisign, for candidate and baseline |
| build | `verify-windows` | local | clean-state verification: CI runner, VM or disposable data root |
| build | `bundle-mac` | mac | automated |
| build | `package-mac` | mac | **approval**, then automated: Developer ID signing, notarization and stapling in the owner's GUI session |
| certify | `certify-windows`, `certify-mac` | local, mac | automated. Mac updater signature included. |
| certify | `pins` | local | automated (built in) |
| qa | `qa-sittings` | human | person: OAuth/2FA, microphone, physical sleep, GUI-only rows |
| qa | `qa-records` | local | bind the records, then an automated byte-pinned contract check |
| qa | `notes` | local | automated: fill notes, commit N locally, pin N |
| stage | `preflight-prod` | prod-read | automated |
| stage | `stage-preconditions` | local | **approval** (primary acceptance), then the receipt is generated |
| stage | `stage` | **prod-write** | **approval**, named explicitly |
| stage | `readback` | prod-read | automated |
| stage | `lifecycle` | human | person: LC-A installer upgrade and LC-B in-app update/restore/reupdate |
| publish | `release-review` | human | independent reviewer |
| publish | `release-preconditions` | local | **approval**, then the receipt is generated |
| publish | `publish-dry-run` | prod-read | automated |
| publish | `publish` | **prod-write** | **approval** (business go/no-go), named explicitly |
| feed | `website-assemble` | local | automated |
| feed | `website-merge` | human | push, PR, review and merge (never push to main) |
| feed | `deploy`, `confirm` | **prod-write** | **approval**, each named explicitly |
| verify | `live-verify` | prod-read | automated |
| verify | `live-human` | human | download and install from the public site on a clean state |

Signing happens inside the phases that need it:

- Windows Authenticode and Minisign: `build-windows`.
- Mac Developer ID and notarization: `package-mac`.
- The Mac updater signature, made on Windows: `certify-mac`.

## Hard gates

- **Receipts are create-once.** Each phase writes `receipts/<phase>.json` once. A later run skips DONE phases, so the pipeline resumes where it stopped. `--redo --phase <id>` moves the old receipt to `receipts/superseded/`. Nothing is deleted.
- **Inputs are bound.** A receipt records the SHA-256 of each input receipt. If an input is redone, every phase after it becomes STALE and must be redone.
- **Artifacts are bound.** Before any phase runs, every artifact recorded by an upstream receipt is re-hashed. Installers, signatures, records and filled pins are all covered. A changed byte stops the pipeline with `artifact drift`.
- **Kit scripts are pinned.** Every script a step runs (`uses`) must match its SHA-256 in the kit, or the step refuses. A production-write step must pin its script. A production write can never be an operator step.
- **Outputs are gated.** Each step declares its outputs (file, JSON, the reported receipt line, stdout) with expectations such as `status: PASS`, `commit: {commit}` and hashes from earlier receipts. A mismatch fails the phase and no receipt is written. The reason goes to `failures/`.
- **Templates are strict.** `{version}`, `{commit7}`, `{out.<phase>.<key>.sha256}`, `{this.<key>}` and similar names resolve from the identity and receipts. An unresolved reference or a leftover `PLACEHOLDER` token refuses the step. `{{` and `}}` are literal braces.
- **Production writes run only when named.** A production-write phase runs only when named explicitly (`--phase stage`), never from `all` or a group. One production write runs per invocation.
- **Approvals are bound to what they approve.**
  - `approve` binds to the digest of the phase, identity, kit bytes, input receipts and every fully resolved command.
  - If any of those changes, the approval is stale.
  - Approving requires typing `--confirm <phase>:<version>:<sha7>`.
- **Attestations use the same binding.** An attestation (`attest`) is bound the same way, and its evidence files are hashed and validated against the kit's expectations.
- A state directory belongs to one `(version, commit, baseline, channel)` for life, and a lock file prevents two runs at once.

## People

Only these steps need a person. The command prints the exact next command each time.

1. **Credentials.** Renew an expired credential when `prereqs` fails: `az login`, the Mac console login or keychain unlock, the ssh key.
2. **Approvals** (`approve`). These cover the business go/no-go and anything irreversible:
   - `package-mac`: uses the Developer ID and notary identity.
   - `stage-preconditions` and `release-preconditions`: primary acceptance.
   - `stage`: burns versions in D1 forever.
   - `publish`: moves the Stable pointer.
   - `deploy` and `confirm`.
3. **Attestations** (`attest`). These cover what no machine can do:
   - clean-state verification, when not on the CI runner;
   - QA sittings: sign-ins with OAuth/2FA, the microphone, a physical sleep, GUI-only rows;
   - lifecycle trials;
   - the independent review;
   - the website PR merge;
   - the public download check.

   Clean-state checks use a disposable data root or a clean-state aside on the main account, CI or a VM. They never use additional Windows accounts.

An agent may prepare and run automated phases. It must never run `approve` or `attest` on the owner's
behalf. Those records carry a person's name and are that person's decision.

## Kits

A kit (`tooling/release/ship/kits/*.json`, schema `kalcode-release-kit/v1`) binds the phases to the proven
scripts of a release line. It holds:

- `binds`: the version, commit and baseline it is valid for;
- `vars`: machine paths and reviewed commits;
- `scripts`: the SHA-256 pins of the scripts it runs;
- `phases`: steps of kind `run`, `write`, `copy`, `check` or `operator`, each with gated outputs.

`b10-0.1.6.json` binds the B10 scripts under `target/recovery-B10*`, the Mac launcher and the publish
wrappers `00-06`.

- **Pins.** The kit replaces the hand edits in TOOLING-REPIN.md section 4. The `pins` phase derives every artifact value from receipts and calls `fill-b10-pins.mjs derive-artifacts` and then `apply`. The `notes` phase pins N the same way.
- **Adopting B10 in flight.** B10 phases already done by hand can be recorded without re-running them. `run --execute --adopt --phase <p> [--evidence key=path]` runs the phase's normal output gates against the existing files (for example `target/recovery-B10-windows/build.json`). It records the phase only if they pass.

Remaining manual parts of the B10 kit (operator steps, attested):

- `certify-mac`: the P0-P8 chain is still a sequence of shell snippets (MAC-B10-POST-PACKAGE.md). A `check` step gates on its results.
- `pins`: the lifecycle collector fill (LW/LM executable, guardian and bundle-tree values).
- `qa-records`: binding the sittings with `fill-b10-records.mjs`. The contract validation that follows is automated.

### Next release line

The B10 scripts hard-code 0.1.6/B10 in many places:

- the certifier's foreign-candidate negatives;
- the gates `ALLOWED` list;
- `WINDOWS-REBUILD` `-ReceiptDirName`;
- the Mac `CERTIFIED_BASES`;
- the burned-row pins in `lib/authority.mjs`.

Two steps prepare a new line:

1. **Kit.** Copy the kit, change `binds` and `vars`, and re-pin `scripts`. `ship.mjs` refuses a kit whose binds do not match.
2. **Scripts.** Promote the per-release scripts into `tooling/release/` with the version and commit as parameters. Then the kit stops changing per release. Until that is done, they must be re-derived and reviewed as for B9 → B10, and the new hashes pinned in the kit.

Three fixes shrink future kits the most:

- Merge the staging-tool commits (T) into main.
- Derive the Mac `CERTIFIED_BASES` from certification receipts.
- Script the Mac post-package chain.

## State layout

```
target/release-pipeline/<version>-<sha12>/
  release.json              identity, written once
  receipts/<phase>.json     PASS/SKIPPED receipts (superseded/ keeps redone ones)
  approvals/<phase>.json    approvals bound to the inputs digest
  attestations/<phase>.json evidence hashes + validated values
  pins/pins-<UTC>/          pins.json (identity + every upstream output) and pins.env
  generated/                receipts the pipeline writes for the wrappers (stage/release preconditions)
  logs/, failures/          full command output; why a run stopped
```

Other commands:

- `status`: one line per phase.
- `pins`: prints the derived pins.
- `--json`: machine-readable plan.

The orchestration logic is tested in `tooling/release/ship.test.mjs` (a throwaway git repository with a
fake kit). The tests never touch production or signing keys.

## Definition of Done enforcement

[AGENTS.md](../AGENTS.md) defines the lifecycle every task finishes. `ship.mjs` makes it machine-checked.
Everything below runs locally, with no GitHub Actions dependency.

- **Policy.** `tooling/release/lifecycle/policy.json` maps path globs to four lanes and each lane to its
  ordered steps. The first matching rule wins. An unknown path counts as desktop and website, never internal.
  - `website`: the `kalcode-website` Worker (`apps/website/**`) and the `kalcode-api` Worker at
    api.kalcoded.com (`apps/api/**`). Both deploy with `wrangler deploy`.
  - `desktop`: `apps/desktop/**`, `crates/**`, `third_party/**`, `Cargo.*`, `.cargo/`.
  - `docs`: only `docs/releases/**`, which `publish.mjs` embeds in the signed updater descriptor. The
    website does not render `docs/*.md`; its `/docs/*` pages are sources under `apps/website`.
  - `internal`: tooling, CI, tests, agent files and other docs. These are merged only.
  - `packages/*` ship with the apps that depend on them.
  - A `pnpm-lock.yaml` change ships with the importers whose resolved dependency graph changed. If the
    change cannot be attributed, it counts as desktop and website.
- **`classify --base <ref> --head <ref> [--json|--markdown]`** lists the lanes and the required lifecycle
  for `merge-base(base, head)..head`. It handles renames (both sides) and deletions.
- **`lifecycle status [--json] [--check] [--offline]`** lists the production targets on `origin/main` that
  have merged changes not yet in production. It uses public read-only GETs only.
  - Website: `https://kalcoded.com/.well-known/kalcode-build.json`, the build stamp that
    `apps/website/scripts/build-stamp.mjs` writes on every `astro build`. The stamp holds the commit, a
    dirty flag and `builtAt`. Until a build with the stamp is deployed, the website reads as "unknown deployed
    commit". The stamp is itself a website change and ships with the next website deploy.
  - API: no stamp yet, so it reads as unknown.
  - Desktop: `version` in `tauri.conf.json` on main, compared with
    `https://kalcoded.com/releases/updater/stable.json` (`version`, `kalcode.commit`). When the Stable
    feed serves nothing yet, the comparison uses the catalog `https://kalcoded.com/releases/latest.json`.
    Desktop changes merged after the published commit also count as unshipped.
  - Results are cached under `<git common dir>/kalcode-lifecycle/`.
- **`gate [--base origin/main] [--list] [--only a,b] [--keep-going]`** is the local merge gate. It runs the
  `ci.yml` equivalents for the lanes the working tree touches: committed, staged, unstaged and untracked
  changes.
  - It never skips a failing check. A check this platform cannot run is reported as unavailable, for
    example the native desktop E2E off Windows.
  - A required tool that is missing fails the gate.
  - A clean PASS writes a receipt for `HEAD`. The Stop hook reports that receipt.
- **Stop hook.** The committed `.claude/settings.json` runs `ship.mjs lifecycle hook` when a Claude Code
  session stops. `.gitignore` ignores `.claude/*` except `settings.json`. The hook blocks the stop once per
  session and state, with a short reason, when either of these is true:
  - the session's branch has commits that are not in `origin/main`;
  - the cached status shows unshipped production lanes.

  The agent then finishes the lifecycle, or states that the owner said local-only. The hook:
  - honours `stop_hook_active`;
  - makes no network calls: a stale cache starts a detached `lifecycle status` refresh for the next stop;
  - stops within about 6 s (inside the 10 s hook timeout);
  - allows the stop on any error of its own.

**Deferred (GitHub-dependent).** Actions is currently unavailable because of an account billing hold. Until
it returns, the [trusted local runner](#trusted-local-runner-no-github-hosted-minutes) runs the gate on PRs
and on main. So a `lifecycle.yml` workflow (classify on PRs into the job summary; on pushes to main, keep one "Unshipped
production changes" issue with `GITHUB_TOKEN` `issues: write`) is kept off this branch. It is on the local
branch `tooling/lifecycle-ci-deferred` until billing is restored.

The repository has no Actions secrets, so CI cannot deploy. A CI deploy of the Workers would need
`CLOUDFLARE_API_TOKEN` (Workers Scripts and D1 edit, scoped to the account) and `CLOUDFLARE_ACCOUNT_ID`,
behind a protected environment. Desktop publishing stays local: its signing keys never leave the owner's
machines.

## Trusted local runner (no GitHub-hosted minutes)

`tooling/release/trusted-runner.mjs` is KalCode's CI and release trigger when GitHub-hosted Actions cannot
run (AGENTS.md, "Permanent trusted release infrastructure"). Windows Task Scheduler runs it on the owner's
PC every 5 minutes. It reuses `ship.mjs gate`, `ship.mjs lifecycle status` and `ship.mjs run`, and it
reports results as GitHub commit statuses through `gh`. It adds no new build, signing or publish logic.

### Why a local scheduler and not a self-hosted GitHub runner

The two options were:

- **(A)** a self-hosted GitHub Actions runner on the release PC, with "main-only" release workflows;
- **(B)** a local scheduled poller that runs the existing ship tools.

We chose **B**. Option A cannot isolate the runner on this repository:

- **No runner groups.** `kalebcampbell2305/KalCode` is a private repository on a personal account. Runner
  groups, the only GitHub control that limits a runner to selected workflows or refs, exist only for
  organizations. A repository-level runner accepts every job from any workflow on any branch whose
  `runs-on` labels match.
- **Labels are not access control.** A branch that adds or edits a workflow (on `push` or `pull_request`)
  can target `[self-hosted, kalcode-release]`. This was observed on 2026-10-01: the runner
  `kalcode-win-release` (id 21) ran the job `probe` from
  `.github/workflows/probe-self-hosted.yml@refs/heads/probe/self-hosted-runner`, a push to a non-main
  branch (`C:/actions-runner-kalcode/_diag/Worker_20261001-000636-utc.log`).
- **Environments do not help.** Environment protection only gates jobs that declare the environment. A job
  that omits it still gets the runner.
- **Fork PRs are a lesser concern.** Forks of a private repository come only from collaborators, and this
  repository has one collaborator. But every agent branch is untrusted under AGENTS.md, and agents push
  branches with the owner's token.
- **Dispatch stays with GitHub.** Under A, GitHub still decides when jobs reach the release machine, so the
  release still depends on the Actions service and its account state.

Under B, the decision about what runs is made on the trusted machine by code from `origin/main`:

- release work runs only for commits on `origin/main`;
- PR checks run only for same-repository PRs by allowlisted authors, in a separate clone;
- nothing listens for inbound work;
- the Mac is reached only through the existing `ship.mjs` ssh steps for `origin/main` release phases. PR
  code never runs on the Mac, which holds the Developer ID and notary credentials.

### What one tick does

`node tooling/release/trusted-runner.mjs tick` runs from the **control checkout**. This is a dedicated
worktree of the main repository with a detached HEAD, which only ever holds `origin/main`. The runner
refuses to run from a branch or from a checkout with local changes.

1. **Main.** When `origin/main` moved, the runner:
   1. checks the new head out in the control checkout;
   2. runs `pnpm install --frozen-lockfile`, then the full `ship.mjs gate --base <previous head>`;
   3. posts `kalcode/local-gate` on the merge commit.

   If the gate passes and `ship.mjs lifecycle status` reports unshipped `desktop` or `docs` lanes, the
   runner runs the release pipeline's automated phases:

   ```
   node tooling/release/ship.mjs run --version <V> --commit <head> [--baseline-version <published>] --phase all --execute
   ```

   - `<V>` comes from the release tooling at that commit: `releaseVersion()` (X.Y.Z+N) where it exists,
     otherwise the checked-in X.Y.Z.
   - The baseline is the published Stable version, when that is lower than `<V>`.
   - The pipeline stops by itself at every approval, attestation, operator step and named production
     write.
   - The runner posts `kalcode/release` on the merge commit: `pending` with the phase it is waiting on,
     `failure` with the `ship.mjs` refusal, or `success`.
   - The runner never runs `ship.mjs approve` or `attest`, and never names a production-write phase.
     Those remain the owner's decisions.
   - When the owner records an approval or attestation, the next tick resumes the pipeline to the next
     gate.
   - A failure is not retried until the head, the identity or a person's record changes.
   - Before starting, the runner checks that the control checkout is exactly the gated head with no
     local changes. If it is not, the runner fails closed with a `kalcode/release` failure.
   - If a killed run left `ship.mjs`'s own lock behind, the runner reports it once as a failure that
     names the lock file to delete after checking its log. The release resumes once the file is gone.
     The lock counts as left behind when its PID is gone or it is older than the release limit.
     While a live run holds the lock, the runner waits quietly.
2. **PRs.** For each open PR whose head is in this repository and whose author is allowlisted (by
   default, the repository owner), the runner runs the local gate on the PR head commit once and posts
   `kalcode/local-gate` on that commit. One PR's failure never stops the others. If checking out a PR
   fails, for example on a head pushed after the tick's fetch, the runner retries on the next ticks. After
   three failed attempts it reports an `error` status. Each PR runs in a newly created
   `<state-root>/pr-clone`. That clone:
   - is deleted and recreated for every PR, so no hooks, config or files carry over from an earlier PR;
   - fetches from the local repository's object store, never from GitHub, so it holds no credential;
   - shares no `.git` with the control checkout;
   - is driven with `core.hooksPath` set to an empty directory and `core.fsmonitor=false`.

   The PR's environment, for `git`, `pnpm install` and the gate alike, is built from an **allowlist**
   (`PR_ENV_ALLOW`: `PATH`, `SystemRoot`, `ComSpec`, `PATHEXT`, processor and Program Files variables).
   Every other variable, including any token, is dropped. On top of the allowlist:
   - Runner-owned isolated directories under `<state-root>/pr-isolated/` replace these:
     - `USERPROFILE`, `HOME`, `APPDATA`, `LOCALAPPDATA`;
     - `TEMP`/`TMP`;
     - `CARGO_HOME`, `CARGO_TARGET_DIR`;
     - `npm_config_cache`;
     - the pnpm store (`--store-dir` and `npm_config_store_dir`);
     - `AZURE_CONFIG_DIR`, `GH_CONFIG_DIR`.

     A PR therefore cannot poison the pnpm store or cargo cache that release builds use. Tools that look
     under the home directory find no `~/.ssh`, `~/.azure`, gh hosts file or global git config.
   - `GIT_CONFIG_NOSYSTEM=1` drops the system git config, including the Git Credential Manager helper.
   - Two shared, read-mostly locations are passed in explicitly because the gate needs them: the rustup
     toolchains (`RUSTUP_HOME`) and the Playwright browsers (`PLAYWRIGHT_BROWSERS_PATH`).

**Timeouts.** Every command has a hard limit:

| Command | Limit |
| --- | --- |
| `pnpm install` | 15 min |
| `ship.mjs gate` | 90 min |
| `ship.mjs run` | 8 h |
| `git` | 10 min |
| `gh` | 5 min |

When a command hits its limit, the runner kills its whole process tree (`taskkill /T /F` on Windows) and
counts the command as failed. A hung gate therefore cannot wedge the runner.

**Tick lock.** Only one tick runs at a time:
- The lock file appears atomically with its content: a hard link of a fully written temp file.
- The holder refreshes it every minute.
- A lock is stale when its PID is gone or its heartbeat is older than 10 minutes, so a reused PID cannot
  hold it forever.
- A stale lock is removed only if it is still the same lock that was judged stale.

State, per-run logs and `runner.log` are kept in `%LOCALAPPDATA%\KalCode\trusted-runner\`. Release state
and evidence stay where `ship.mjs` keeps them: `<main repo>/target/release-pipeline/`.

**Trust boundary.** PR code still runs as the owner's Windows user (`Kaleb`). It is not sandboxed.
Redirecting the environment changes where tools look, not what the user can open. These all remain
readable to a PR that asks for them directly:
- absolute paths such as `C:\Users\Kaleb\.ssh` (including the Mac release ssh key), `C:\Users\Kaleb\.azure`
  and the gh config;
- the Windows Credential Manager, which holds the GitHub token;
- DPAPI-protected files;
- the release repository itself.

The real boundary is who can open a PR that the runner will check: only same-repository branches by
allowlisted authors on a private, single-collaborator repository. That is the same exposure as the owner
or an agent running `ship.mjs gate` by hand today. Hard isolation would need a separate low-privilege
Windows account for PR checks. That is optional hardening and is not required by policy.

### One-time setup (owner consent)

These steps register software on the owner's machine and change repository settings. An agent prepares
them. It does not run them without the owner's go-ahead.

1. Create the control checkout:

   ```
   git -C C:/Users/Kaleb/Downloads/KalCode worktree add --detach C:/kc-trusted origin/main
   ```

2. Dry-run it. This fetches, lists PRs and prints the plan without changing anything:

   ```
   node C:/kc-trusted/tooling/release/trusted-runner.mjs tick --dry-run
   ```

3. Schedule the tick every 5 minutes while the owner is logged on. `/IT` runs it in the owner's session,
   where `gh`, the Git Credential Manager, `az` and the Mac ssh key are available. No password is stored.
   `conhost --headless` keeps the console hidden.

   ```
   schtasks /Create /TN "KalCode\TrustedRunner" /SC MINUTE /MO 5 /IT /RL LIMITED /TR "C:\Windows\System32\conhost.exe --headless node C:\kc-trusted\tooling\release\trusted-runner.mjs tick"
   ```

4. Remove the self-hosted GitHub runner registered on 2026-10-01. It is offline today. Once online, any
   branch's workflow could run on it.

   ```
   C:\actions-runner-kalcode\config.cmd remove --token (gh api -X POST repos/kalebcampbell2305/KalCode/actions/runners/remove-token --jq .token)
   ```

   Run this in PowerShell. If the local folder is already gone, use
   `gh api -X DELETE repos/kalebcampbell2305/KalCode/actions/runners/21` instead.

### Operating it

- **Pause:** create `%LOCALAPPDATA%\KalCode\trusted-runner\PAUSED`. Delete the file to resume. Pause it
  before driving a release by hand. `ship.mjs` also holds a per-release lock. A tick that finds the lock
  held by a live run waits and retries.
- **Look:**
  - `node C:/kc-trusted/tooling/release/trusted-runner.mjs status`;
  - `runner.log`;
  - the commit statuses on GitHub;
  - `ship.mjs status --version <V> --commit <sha>` for the release itself.
- **Retry a failed gate or release on the same head:** remove the `main` or `release` entry from
  `state.json`.
- **Stop for good:** `schtasks /Delete /TN "KalCode\TrustedRunner" /F`.

### Limits

- **Release kits bind one exact version and commit.** `ship.mjs` refuses a commit that no kit in
  `tooling/release/ship/kits/` binds. Until the current release line has a kit that binds the new head,
  the runner reports that refusal as `kalcode/release: failure` on the merge commit. That makes the gap
  visible; it does not work around it.
- **Website deploys are not triggered.** The website lane keeps its existing `wrangler deploy` path.
- **Production writes stay explicit.** `stage`, `publish`, `deploy` and `confirm` run only when a person
  names them, after their approval.
