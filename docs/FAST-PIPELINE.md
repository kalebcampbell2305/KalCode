# Fast release pipeline: measured bottlenecks and fixes

Owner rule (AGENTS.md, 2026-10-02): KalCode takes the fastest truthful path from main to users, and a slow release is a pipeline bug. This page records what slowed the first fast-lane releases (0.1.8+1037 and 0.1.9+1038, 2026-10-02), what this change fixes, and what is still open. The broader pipeline is described in `docs/RELEASE-PIPELINE.md`.

## Measured (2026-10-02, release kit `target/recovery-B19-fast/TIMINGS.md`)

| Step | Time | Cause |
|---|---|---|
| Windows build + sign (warm cache) | ~10 min each | Fine; two builds ran side by side |
| Windows build attempts 1–2 for 1037 | lost ~15 min | (1) fresh worktree without `node_modules`; (2) cargo reused a guardian exe from attempt 1 (its uplifted copy keeps the old timestamp) and `build-windows.mjs` refused it as stale |
| Mac package job for 1037 | ~75–100 min | The warm source tree sat on an old certified base (`ecc2591`), so nearly everything compiled cold. Every kalcode-* crate recompiles whenever the workspace version changes (`[workspace.package] version` feeds `CARGO_PKG_VERSION`). `kalcode_desktop_lib` then compiles on one core for 17+ min because `[profile.release]` uses `codegen-units = 1` and fat `lto = true` |
| Mac notarization | 5–15 min | Apple; it runs inside the package job |
| CI update-from-live check | 3 failed runs before a pass | New script: a log file read under lock, a cleanup that couldn't close the app in the runner's service session, a digest that assumed `rowid`, and a data-kept rule that rejected normal launch writes. All fixed (#94, #96, #97) |

## Implemented in this change

1. **The guardian is never stale.** `clearStaleGuardian()` (`guardian-packaging.mjs`) removes only the guardian bin's link outputs (its `deps` executable and fingerprint), so cargo relinks it from the current tree. It never recompiles `kalcode-providers` or the desktop crate. `build-windows.mjs` calls it before building the guardian, which replaces the old `rmSync` that cargo defeated by re-uplifting the old file.
2. **The Windows release tree stays warm.** `release.yml` gains a `warm` job, and the `release` job now runs after it. After every push to main, the job runs `warm-release-tree.mjs` on the guarded release runner:
   - it moves `<owner repo>/.worktrees/release-warm-windows` to the pushed commit (refusing if the tree is dirty);
   - runs `pnpm install --frozen-lockfile`;
   - runs `warm-windows.mjs`, a compile-only build with the exact release environment and version overlay that signs nothing.

   The job is off until the repository variables `KALCODE_RELEASE_WARM=true` and `KALCODE_RELEASE_REPO=<owner repo path>` are set. Set them only after the in-flight release is live. The runner's job guard already allows only `release.yml` from main.
3. **Per-release timings.** `release-timings.mjs mark|report` keeps one JSON file per release version, with the standard steps merge, build-windows, build-mac, sign-windows, package-mac, notarize-mac, ci-clean-install, update-from-live-*, stage, publish, website-deploy, feed-live and user-receivable. Warm passes are recorded per commit under `<state root>/warm/`.
4. **Release kit** (`target/recovery-B19-fast/windows/WINDOWS-REBUILD.ps1`, not in git):
   - the build now always runs `pnpm install --frozen-lockfile` and re-checks that no tracked file changed;
   - `-UseWarmTree` builds in the warm worktree, checked out at the release commit when it is clean.

## Still to do, in order of payoff

1. **Mac warm tree.** The Mac packaging launcher (`mac-release-next.sh`, on the Mac, outside git) only builds in a source tree that sits on an *independently certified base* (`CERTIFIED_BASES`). Two ways to keep it warm:
   - **Continuous shipping (no rule change).** Each release's certified candidate becomes the next warm base, so with frequent releases the gap stays a few merges and the build stays incremental. Today's cold build came from a warm base weeks behind.
   - **Small rule change.** Also admit as a warm base any `origin/main` commit that a main-only warm job compiled on the trusted Mac, with a recorded receipt (commit, clean tree, toolchain). Then add a Mac step to the `warm` job, driven over SSH the way `ship.mjs` already drives the Mac. Main is gated, so this is the same trust as a certified base for incremental compilation. The candidate is still built, signed, notarized and certified from its exact commit.
2. **Release profile** (needs a measured A/B before adoption, because it changes the shipped binary). Try `codegen-units = 16` and `lto = "thin"` in `[profile.release]`, or a `release-fast` profile used only for packaging after an A/B on binary size, startup and KalVoice latency. On the Mac's 4 performance cores this should cut the `kalcode_desktop_lib` compile from 17+ min to about 4–6 min, and the final link from minutes to well under a minute. Expected cost: a few percent larger binary and similar runtime (opt-level `"s"` stays).
3. **Version decoupling.** Give workspace crates a fixed internal version and inject the release version only where it's used: `env!("CARGO_PKG_VERSION")` appears only in `crates/providers/src/account_auth.rs` (clientInfo) and `apps/desktop/src-tauri/src/updater_commands.rs` (User-Agent). Read a `KALCODE_PUBLIC_VERSION` build-time env in those two places, which cargo tracks per crate. A version change then recompiles 2 crates instead of every kalcode-* crate. This touches the version authorities (`Cargo.toml`/`Cargo.lock`, the version-truth tests), so do it as its own reviewed PR.
4. **Automatic merge → ship.** `release.yml` → `release-on-merge.mjs` → `ship.mjs run` is the B12-era pipeline. Point it at the fast lane instead:
   - T0 identity (`t0-fast.sh`);
   - Windows `WINDOWS-REBUILD.ps1 -UseWarmTree` and the Mac launcher in parallel;
   - the `clean-install-verify` and `update-from-live-verify` workflows;
   - `make-qa-v3.mjs` records;
   - `run-publish.mjs`, which covers stage, publish, website, deploy and verify.

   Promote those scripts from `target/recovery-B19-fast/` into `tooling/release/fast/` with tests, then set `KALCODE_AUTO_RELEASE=true`.

## Expected time from merge to users

| | Today (cold Mac) | After 1 (+ continuous shipping) | After 1–3 |
|---|---|---|---|
| Windows build + sign | ~10 min | ~5–8 min | ~5 min |
| Mac package + notarize | 75–100 min | ~35–45 min (single-threaded app crate) | ~15–20 min |
| CI clean install + update-from-live (parallel with the Mac build) | ~15 min | ~15 min | ~15 min |
| Mac update check + publish + website + verify | ~40 min | ~30 min | ~25 min |
| **Merge → live** | **~2.5–3 h** | **~75 min** | **~45–60 min** |
