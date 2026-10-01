# Release pipeline (`ship.mjs`)

One command takes a KalCode desktop release from an exact commit to public verification:

```
node tooling/release/ship.mjs --version X.Y.Z+N --commit <sha40> [--baseline-version X.Y.Z] [--phase ...] [--execute]
pnpm release:ship --version X.Y.Z+N --commit <sha40> ...
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
| `--version` | Stable release identity: plain `x.y.z` for the initial public build or `x.y.z+N` for a later internal build on the same public version. Stable refuses prereleases and other build metadata. |
| `--commit` | Full 40-hex commit. The `identity` phase proves that `tauri.conf.json`, `apps/desktop/package.json` and `Cargo.toml` all declare the public `x.y.z` portion of `--version` at that exact commit (never the working tree), and that the commit compiles the moving Stable endpoint (so a derived baseline cannot be released as the candidate). |
| `--baseline-version` | The lower release identity used for the in-app update trial. For a same-public-version build, the current public `x.y.z` build is lower than `x.y.z+N`. It must be lower than `--version`. Burned release identities stay burned, and preflight refuses a candidate that already has a D1 row. |

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
| qa | `qa-sittings` | human | automated (automated-v1): UIA rows on the installed release bytes, run outside KalCode's process tree, and a machine safeguard attestation. The Mac GUI-only rows still need a person (see People) |
| qa | `qa-records` | local | bind the records, then an automated byte-pinned contract check |
| qa | `notes` | local | automated: fill notes, commit N locally, pin N |
| stage | `preflight-prod` | prod-read | automated |
| stage | `stage-preconditions` | local | **approval** (primary acceptance), then the receipt is generated |
| stage | `stage` | **prod-write** | **approval**, named explicitly |
| stage | `readback` | prod-read | automated |
| stage | `lifecycle` | human | automated (automated-v1): LC-A installer upgrade and LC-B in-app update/restore/reupdate by UIA, run outside KalCode's process tree. The Mac Step B clicks still need a person (see People) |
| publish | `release-review` | human | automated (automated-v1): a fresh-context review agent that is neither the lead nor the author |
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

Under the owner directive of 2026-10-01 (a release needs nothing from the owner), the release agent runs every phase,
including `approve` and `attest`, with automated-v1 evidence once every automated gate is green. Signing, notarization,
signature, integrity, updater and security checks are never bypassed or waived. Only these steps still need a person. The
command prints the exact next command each time.

1. **Credentials.** Renew an expired credential when `prereqs` fails: `az login`, the Mac console login or keychain unlock
   (for example after a Mac reboot, because of FileVault), the ssh key.
2. **Mac GUI input.** No process an agent can start on the Mac has Accessibility or input-event trust, so these stay with a person:
   - Mac Step B: the in-app update, "Restore previous version" and the re-update clicks;
   - the Mac GUI-only QA rows, the Mac KalVoice takes with real speech and the Mac sleep/wake;
   - a Mac clean install (it deletes the owner's KalCode Keychain items and needs a fresh sign-in).
3. **Real OAuth and 2FA**, when a sign-in can't be avoided. An agent never holds the owner's credentials or 2FA device.

What automated-v1 means:

- **Approvals** (`approve`): the release agent records them after the dry run and every gate passes: `package-mac`,
  `stage-preconditions`, `release-preconditions`, `stage` (burns versions in D1 forever), `publish` (moves the Stable pointer),
  `deploy` and `confirm`.
- **Attestations** (`attest`) cite machine evidence bound to the artifact SHA-256:
  - clean-state verification: `.github/workflows/clean-install-verify.yml`, the pinned `verify-windows.mjs` as `kalcode-ci` on
    the gate runner (main and `workflow_dispatch` only, no secrets, no UAC). `source: public` repeats it on the public download;
  - QA sittings and lifecycle trials on Windows: UIA rows on the installed release bytes, run outside KalCode's process tree.
    No test hooks, fixtures or seeded caches, so the record's safeguards stay truthfully `false`;
  - the four QA safeguard answers on Windows: a machine attestation receipt;
  - the independent review: a fresh-context review agent that is neither the lead nor the author;
  - the website PR merge, once its gates are green.

  Clean-state checks use the gate runner's service account, a disposable data root or a VM. They never use additional
  interactive Windows accounts.

Every `approve` and `attest` record names who decided: the release agent for automated-v1 evidence, or the person for the
steps above.

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

**Deferred (GitHub-dependent).** Actions is currently unavailable because of an account billing hold. So a
`lifecycle.yml` workflow (classify on PRs into the job summary; on pushes to main, keep one "Unshipped
production changes" issue with `GITHUB_TOKEN` `issues: write`) is kept off this branch. It is on the local
branch `tooling/lifecycle-ci-deferred` until billing is restored.

The repository has no Actions secrets, so CI cannot deploy. A CI deploy of the Workers would need
`CLOUDFLARE_API_TOKEN` (Workers Scripts and D1 edit, scoped to the account) and `CLOUDFLARE_ACCOUNT_ID`,
behind a protected environment. Desktop publishing stays local: its signing keys never leave the owner's
machines.
