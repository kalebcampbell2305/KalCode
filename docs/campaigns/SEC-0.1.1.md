# Campaign SEC-0.1.1 — release-blocking security fixes

Branch `sec/fixes-0.1.1`, worktree `.worktrees/sec-fixes`, from main `f2e4831`. Scope: the
findings of the independent security review of snapshot `1bce77f` that block 0.1.1. The review's
proofs of concept were ported into real tests; each test was also run with its fix switched off
to show that it reproduces the attack.

No provider session was started and no AI quota was used. The one real-CLI check (item 2) ran
Claude Code 2.1.282 with an isolated, signed-out `CLAUDE_CONFIG_DIR` and no prompt, only to
confirm the argv parses. The owner's app data (`%APPDATA%\com.kalcode.desktop`) was not touched:
the E2E harness runs with a temporary `KALCODE_DATA_DIR`.

## 1. Findings → fixes → evidence

| # | Finding | Severity | Fix | Commit | Evidence |
| --- | --- | --- | --- | --- | --- |
| 1 | Workspace-planted interpreter runs at thread start (Windows npm `.cmd` shim: `cmd.exe` finds `node.cmd`/`node.exe` in the workspace, the session's working directory) | HIGH (live) | `env::harden`: every provider environment has `NoDefaultCurrentDirectoryInExePath=1` and a `PATH` of absolute entries only, applied when built and again at spawn. Detection searches absolute folders only and prefers a native `claude.exe` over a `.cmd`/`.bat` shim anywhere on the search path. New `launch.rs`: a shim is read (≤ 16 KiB, never executed); its single `%dp0%` target is resolved and started directly (native `bin\claude.exe`, which current npm Claude Code installs) or as `<absolute node.exe> <script>` (`node.exe` beside the shim or in an absolute `PATH` entry, never `node.cmd`). Only an unreadable shim goes through `cmd.exe` (system `cmd.exe /d`, hardened env). | `50d513c` | `crates/providers/tests/launch_hardening.rs` (Windows), workspace holds planted `node.exe`, `node.cmd`, `node.bat`, `claude.cmd`, `cmd.exe`: `an_npm_node_shim_runs_the_real_node_never_the_workspace_one`, `an_npm_shim_for_the_native_binary_starts_it_directly`, `an_unresolvable_shim_still_never_runs_workspace_programs` (with a control that shows the unhardened launch *does* run the planted program). With the fix disabled, the first and third fail (`planted programs ran: ["runs.log"]`). Unit: `launch::tests::*` (npm node/native shims, pnpm shims, ambiguous/missing/`%VAR%`/absolute targets, oversized shims, relative `PATH` never supplies node), `env::tests::{current_directory_exe_search_is_always_disabled, path_keeps_only_absolute_entries, drive_relative_path_entries_are_not_absolute}`, `detect::tests::{relative_and_empty_path_entries_are_never_searched, a_planted_launcher_in_a_relative_path_entry_is_not_found, native_executables_win_over_script_launchers_on_any_folder}` |
| 2 | Enforcement gap and docs overclaim: Claude Code threads run with `--setting-sources user`, so the user's own allow rules and hooks, not KalCode policy (Custom rules, "remote-consequential always asks"), decide | MEDIUM (live) | Sessions pass KalCode deny rules with `--disallowedTools` (one argv element per rule). Deny rules from any source beat allow rules from every source and a `PreToolUse` hook's "allow" ([permissions](https://code.claude.com/docs/en/permissions): *Settings precedence*, *Extend permissions with hooks*; [CLI reference](https://code.claude.com/docs/en/cli-reference) `--disallowedTools`; installed `claude --help` 2.1.282). Every mode: `git push` (also `git <opts> push`), `send-pack`, `http-push`, `svn dcommit`, `p4 submit`, `subtree push`, package publishes (npm/pnpm/yarn/bun/cargo/twine/poetry/uv/flit/hatch/gem/nuget/mvn deploy), `docker`/`podman push`, every use of `gh`, deploy and cloud CLIs, `ssh`/`scp`/`sftp`, for both Bash and PowerShell; `Read` of common credential files. Plan/Approve/Auto/Custom also remove `Edit`, `Write`, `NotebookEdit`, `WebFetch`, `WebSearch` (KalCode would ask; nobody can answer). Docs and UI copy now state what is and isn't enforced (below). | `2c6f5a2` | `claude::argv::tests::{every_mode_denies_remote_consequential_commands_in_both_shells, modes_that_would_ask_remove_edit_and_web_tools, mappings_state_what_is_and_is_not_enforced}` — the first checks 27 push/publish/deploy/cloud forms (incl. `git -C . push`, `npm --otp 1 publish`) against Claude Code's documented wildcard rules and that local work (`git commit`, `npm test`) is not caught. Real CLI 2.1.282 accepted the full 135-rule argv (exit 0; an unknown flag exits 1). UI: `model.test.ts` `providerModeNote` cases; vitest 203/203. |
| 3 | PTY: portable-pty panics (abort in release) when the shell no longer exists and `PATHEXT` has an empty entry; relative `PATH` entries could make a planted `pwsh.exe` the default shell | live | Pre-flight in `PtySession::spawn`: the program must be an absolute path to an existing regular file, else a clean `PtyError::Spawn`; the child's `PATHEXT` is rewritten to well-formed entries only. Root cause: `portable-pty-0.9.0/src/cmdbuilder.rs:597-598` (`expect("PATHEXT entries must be utf8")`, then `&ext[1..]`). Shell detection uses only absolute `PATH` entries and absolute `SystemRoot`/`ComSpec`/`ProgramFiles`. | `96c3da1` | `crates/pty/src/tests.rs`: `a_missing_shell_with_a_malformed_pathext_is_a_clean_error`, `portable_pty_never_sees_a_malformed_pathext` (calls portable-pty directly under `catch_unwind`), `pathext_keeps_only_well_formed_entries`, `relative_or_non_file_programs_are_refused`; `shells::tests::relative_and_empty_path_entries_are_ignored`. With the fix off, the first panicked at `cmdbuilder.rs:598:67`. |
| 4 | Capability guard validated only `capabilities/main.json`; a second capability file would ship unchecked | — | `tooling/check-capabilities.mjs` rewritten (exports `checkCapabilities(root)`): every file under `capabilities/` at any depth and with any extension must be allow-listed (only `main.json`) and fully validated (exact permission set, main window only, no webviews, remote URLs or scoped objects); no test hook in `COMMANDS` or `main.json`; `test-capabilities/test-hooks.json` may grant only test hooks; every test-hook registration in `lib.rs` must carry the debug/e2e `cfg`. | `2ec312e` | `tooling/check-capabilities.test.mjs` (12 `node:test` cases, run by `pnpm check` via `tooling` `test`): second file, nested `.toml`/`.json5`, extra permission, missing grant, test hook in `main.json` or `COMMANDS`, uncfg'd registration, widened test capability, `main.json` on a second window or with remote URLs all fail; the real app and a clean copy pass. |
| 5 | `test_permission_probe` registered (inert) in release builds | — | The command, `ProbeResult` and its `generate_handler!` entry are `#[cfg(any(debug_assertions, feature = "e2e"))]`. `build.rs` declares `TEST_HOOK_COMMANDS` only when `CARGO_CFG_DEBUG_ASSERTIONS` or `CARGO_FEATURE_E2E` is set, and deletes a stale autogenerated permission file otherwise (tauri-build loads every file in `permissions/autogenerated/`). The grant moved from `capabilities/main.json` to `test-capabilities/test-hooks.json`, added at runtime with `add_capability` under the same `cfg`. | `7246d90` | Release `acl-manifests.json`: 0 mentions of the permission; release + `e2e`: present. `cargo check -p kalcode-desktop` debug, `--release`, `--release --features e2e`; E2E `integrity.spec.ts` (uses the probe) passes. Capability checker cases above. |
| 6 | WebView2 environment strip used a fixed list | — | `environment.rs`: prefix match on `WEBVIEW2_`, `COREWEBVIEW2_` (documented, e.g. `COREWEBVIEW2_MAX_INSTANCES`) and `WEBKIT_INSPECTOR`, case-insensitive; `main.rs` keeps exactly one audited `unsafe` block with its SAFETY comment. Terminal shells use the same prefixes (plus `KALCODE_*`). | `349d93a`, `55f8990` | `environment::tests::{every_webview2_and_corewebview2_variable_matches_by_prefix, matching_ignores_case, unrelated_variables_are_kept}`; `workspaces::tests::shells_never_receive_kalcode_or_browser_runtime_variables` |
| 7 | A drive root or the home folder could be a workspace | — | `refuse_broad_root` in `canonical_folder`: any path without a parent (`C:\`, `\\?\C:\`, `\\server\share\`, `/`) and the home folder itself (canonical, component-wise, case-insensitive on Windows) are refused with `folder_too_broad` — "Choose a project folder, not a whole drive or your home folder." Subfolders open. | `0b7d6cb` | `workspaces::tests::drive_roots_and_the_home_folder_are_not_workspaces` (plain, verbatim, UNC, case and trailing-slash variants; sibling `C:\Users\me2` allowed); `tests/workspaces_and_terminals.rs::drive_roots_and_the_home_folder_are_refused` (real drive root, verbatim root, home, home via `..`; a temp project opens) |
| 8 | API D1: `REPLACE` / `INSERT OR REPLACE` bypasses the append-only and immutability triggers (`recursive_triggers` is off in D1, so the implicit delete skips DELETE triggers) | not deployed | Migration `apps/api/migrations/0003_no_replace.sql`: BEFORE INSERT guards (they run before conflict resolution for every kind of INSERT): an existing grant id (ABORT), a second active OWNER grant (ABORT), an existing `audit_log` id (ABORT), an existing `kalvoice_requests` id (ABORT), a repeated (account, client request id) → `RAISE(IGNORE)`, which is exactly the worker's `ON CONFLICT DO NOTHING` idempotency and turns REPLACE into a no-op (that table has no audit triggers, so nothing is skipped silently). The review's proposed `fix-0003.sql` was adapted: the active-OWNER guard now requires `NEW.revoked_at IS NULL`. | `9cfa30f` | `apps/api/tests/integration/d1-no-replace.test.ts` on local D1 migrated by wrangler: re-activating a revoked OWNER grant with `REPLACE INTO` and with `INSERT OR REPLACE INTO` is refused (grants, audit rows and resolved tier unchanged — the review PoC); swapping the active OWNER grant through the unique index is refused; upsert rewrite refused; revocation audit row can't be overwritten (both forms); kalvoice REPLACE by id refused and by (account, request id) is a no-op; normal grants, a new OWNER after revocation and the worker's idempotent insert still work. Without 0003: 7 of 10 fail. `d1-schema.test.ts` duplicate-OWNER expectation widened to the new guard's message. |
| 9a | CI: `pnpm audit` skipped devDependencies; cargo-deny advisories were `continue-on-error` on PRs | low | `.github/workflows/ci.yml`: `pnpm audit --audit-level high` (dev included); the advisories step blocks (fix, or add a reviewed `deny.toml` ignore in the same PR). | `422f6c7` | Local: `pnpm audit --audit-level high` — no known vulnerabilities; `cargo deny check` — advisories, bans, licenses, sources ok. |
| 9b | Provider process-tree kill via a Windows Job Object | low | **Deferred** (§3). | — | — |

## 2. What KalCode enforces for Claude Code today (item 2, stated everywhere)

`docs/PROVIDERS.md` §5 ("What KalCode enforces for Claude Code threads today"), the callout at the
top of `docs/PERMISSIONS.md` and its §8 table, `docs/SECURITY.md` ("Provider permissions" row and
assumption 3), and `docs/PROVIDER_PANES.md` now say the same thing:

- **KalCode enforces** (launch flags): a Claude Code mode never broader than the KalCode mode
  (never `auto` or `bypassPermissions`); prompts denied (`--permission-prompts none`); no
  repository settings, hooks or `.mcp.json` servers; the deny rules above, which the user's own
  Claude Code settings and hooks can't override.
- **Not enforced yet**: the permission engine does not see Claude Code tool calls
  (`hostApprovals: false`), so Custom rules, standing grants, KalCode approval prompts and
  "remote-consequential always asks" are not applied per call. Other commands follow Claude
  Code's own rules and the user's own Claude Code user settings (every mode except Plan).
  A Bash/PowerShell deny rule matches the command text, so the same program started another way
  (full path, `sh -c`, quoted subcommand) falls back to Claude Code's mode, which refuses it
  unless the user's own allow rules cover that form.
- **Arrives with** provider panes and the hook bridge (Z7): a KalCode `PreToolUse` hook puts every
  Claude Code tool call through the Trust Kernel.

UI: the New thread hint now shows the provider's own mapping note for the chosen mode (generated
natively from the flags, so it can't claim more than the launch does; Custom says it runs as
Approve). The old copy — "runs in its own most restrictive mode" — is gone. The Bypass dialog adds
what applies to Claude Code threads. The Providers page mapping table shows the deny rules
(generated from `deny_rules`).

## 3. Deferred, with reasons

| Item | Reason | Mitigation today |
| --- | --- | --- |
| 9b Job Object tree kill | Needs Win32 FFI (`CreateJobObjectW`, `AssignProcessToJobObject`, `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`). The workspace denies `unsafe_code` with a single audited exception in `main.rs`; a second exception or a new wrapper crate needs its own review and cargo-deny vetting, which doesn't fit a release-blocker branch. | `taskkill /PID <pid> /T /F` (argv, system path) on terminate, timeout and drop; tested by `terminate_kills_a_hung_process_and_its_children` and `dropping_a_session_kills_its_process_tree`. Gap: a grandchild whose parent already exited is re-parented and escapes `/T`. |
| Per-action enforcement for Claude Code (Custom rules, approvals, remote-consequential *asks*) | Needs the hook bridge (Z7). | KalCode deny rules (item 2); honest docs and UI. |
| KalCode Custom profile `never`/`deny` rules → Claude Code deny rules | `SessionConfig` carries only the mode; adding the profile touches `crates/contracts`, which another agent is changing concurrently. | Custom runs as Approve, and says so. |
| Re-checking an already saved drive-root/home workspace on activation | Only new opens are refused (item 7). No such workspace can be added from 0.1.1 on; one saved earlier keeps working. | Note for the lead: add a check in `workspace_activate` if pre-0.1.1 data matters (0.1.0 was withdrawn before public availability). |
| `accounts` table REPLACE | No documented immutability rule for accounts; a REPLACE keeping the id could rewrite an email. | Only operator tools write D1; noted for Z13. |
| Live verification that Claude Code enforces the deny rules in a session | Needs a real session (AI quota). | Argv accepted by the real CLI; semantics from official docs; add to the owner-approved smoke run. |

## 4. Gates

| Gate | Result |
| --- | --- |
| `pnpm check` (format, biome + clippy `-D warnings`, typecheck, all JS tests incl. the capability-checker tests, `cargo test --workspace`, branding, capabilities, zero-cost, releases) | PASS, exit 0 (53 Rust test binaries ok, 0 failed; desktop vitest 203/203) |
| `cargo deny check` | PASS: advisories, bans, licenses, sources ok |
| Desktop UI tests (`KALCODE_UI_TEST_PORT=1448`) | PASS, 143/143 |
| `build:e2e` + E2E (`KALCODE_E2E_CDP_PORT=9448`, temp `KALCODE_DATA_DIR`) | PASS, 9/9 (binary built from `2c6f5a2`, includes `integrity.spec.ts` using `test_permission_probe`) |
| `pnpm --filter @kalcode/api test` | PASS, 12 files, 119 tests |
| `pnpm audit --audit-level high` (dev included) | PASS, no known vulnerabilities |

## 5. Merge notes for the lead

- `apps/desktop/src-tauri/{build.rs,src/lib.rs,capabilities/main.json}` changed minimally
  (item 5): `test_permission_probe` left `COMMANDS` and `main.json` (the trailing comma moved to
  `allow-permission-settings-update`), `TEST_HOOK_COMMANDS` + a helper follow the list, a `cfg`
  line sits above the probe registration, and four lines were added at the top of `.setup`. The
  concurrent `events_query` addition should merge with at most adjacent-line conflicts.
- `apps/desktop/src-tauri/permissions/autogenerated/test_permission_probe.toml` is removed from
  git and ignored (generated only for test builds).
- No `crates/contracts` or native-core event code was touched.
