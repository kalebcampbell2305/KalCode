# Campaign Z6a — Git & workspace files core

Phase P0 of the advanced-systems plan (`docs/campaigns/ADVANCED.md` §2 Z6a, §3 D2 and D4).
Branch `z6/git-core`, worktree `.worktrees/z6-git`, from main `47aee0e`. Crate-first: no shell,
sidebar, Dashboard or thread UI. The Git/Files/Browser *panes* stay in Z6b.

Delivered:

- **`crates/git` (`kalcode_git`)** — runs the user's installed `git` by argv with a sanitized
  environment and hardened configuration; repository discovery; status (porcelain v2); diff with
  numstat and hunks; paged log; branches; worktrees with safe removal; the **checkpoint store**
  (D2); the **file index** with incremental updates and a watcher; **opaque file handles** (D4);
  migration **v7** (isolated); `git.*` event facts.
- **IPC** in `apps/desktop/src-tauri/src/git_commands.rs` and `files_commands.rs` — written, not
  wired (lines for the lead in §6). Compile- and clippy-checked against `integrate/wave2` with
  full wiring on a throw-away branch, then discarded.
- **`DiffView`** (`packages/ui/src/components/DiffView*`) — presentational, unified + split,
  virtualized, keyboard navigable, axe-clean in both themes, tokens only.

Criteria are PASS only when executed. **PENDING-INTEGRATION** means the Z6a side is done and
tested, and the rest needs a lead step (contracts, registration) listed below.

## 1. Acceptance matrix

| # | Criterion | Result | Evidence |
| --- | --- | --- | --- |
| Z6a-01 | Git is invoked by argv only (never a shell string); the user's installed git, located from absolute `PATH` entries only (no current-directory lookup, no `.cmd` shims); version ≥ 2.31 checked | PASS | `runner.rs` (`find_on_path`, `Git::with_executable`); unit tests `path_search_skips_relative_entries`, `parses_versions_from_every_platform` |
| Z6a-02 | Sanitized environment: `env_clear()` + allow-list; `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_CONFIG*` (incl. `GIT_CONFIG_PARAMETERS/COUNT/KEY/VALUE`), `GIT_SSH*`, `GIT_EXEC_PATH`, `GIT_ASKPASS`, `GIT_EXTERNAL_DIFF`, `GIT_TRACE`, alternates, namespace, ceiling, editors, pagers, `KALCODE_*`, `WEBVIEW2_*`, credentials never pass | PASS | `env.rs` unit tests `git_injection_variables_never_pass`, `pager_variables_are_overridden_not_inherited` |
| Z6a-03 | No repository code runs for KalCode's operations: hooks (`core.hooksPath` → empty KalCode folder), `core.fsmonitor`, filters (repository-scoped drivers neutralized, incl. via `include.path`), `diff.external`, `diff.<drv>.command`, textconv, pager, editor, credential helper, `core.sshCommand` (all transports but local `file` disabled), `gpg.program` + `commit.gpgSign` + `log.showSignature`, auto-gc, embedded bare repositories | PASS | `tests/hostile_config.rs::kalcode_operations_never_run_repository_code` — status, 4 diff targets, log, branches, worktree add/list/remove, checkpoint create/plan/restore/export, gc: **0 of 26 markers fired**. Control `control_plain_git_does_run_the_same_repository_code`: plain git fired `custom-post-checkout, custom-post-index-change, custom-reference-transaction, fsmonitor, filter-clean, filter-smudge, diff-external, diff-command, included-clean, included-smudge` |
| Z6a-04 | Timeouts (process killed on overrun) and output caps (truncation reported, never unbounded memory); stderr redacted, logs only | PASS | `runner.rs`; `repo_ops::diffs_have_numstat_hunks_and_line_numbers` (64-byte cap → `truncated: true`) |
| Z6a-05 | Repository discovery with canonical containment: workspace may be the top level or a subfolder (scoped by pathspec); a repository whose work tree is configured outside the workspace (`core.worktree`) is refused; plain folders are "not a repository", not an error | PASS | `repo_ops::{plain_folder_is_not_a_repository, workspace_in_a_subfolder_sees_only_its_files, hostile_core_worktree_outside_the_workspace_is_refused}` |
| Z6a-06 | Status (porcelain v2 `-z`): branch, upstream, ahead/behind, staged/unstaged, renames with score, copies, untracked, conflicts (all 7 kinds), submodules, non-UTF-8 paths skipped safely; read-only (`GIT_OPTIONAL_LOCKS=0`, user's index unchanged) | PASS | `status.rs` unit tests; `repo_ops::status_reports_staged_unstaged_renames_untracked_and_conflicts`, `status_view_issues_handles_and_leaves_the_users_index_alone` (index bytes identical, no `index.lock`) |
| Z6a-07 | Diff: working tree / staged / HEAD / base / commit range, numstat, binary detection, hunks with old/new line numbers, per-file filter by handle, revisions validated (no option injection) | PASS | `diff.rs` unit tests; `repo_ops::diffs_have_numstat_hunks_and_line_numbers` (`--output=pwned.txt` refused, no file created) |
| Z6a-08 | Log paged with a cursor pinned to the start commit (stable while new commits arrive); empty repositories give an empty page | PASS | `repo_ops::log_pages_are_stable_and_branches_track_upstreams`, `empty_repository_has_empty_history` |
| Z6a-09 | Branches: local + remote-tracking, upstream, ahead/behind, gone upstreams, current | PASS | `log.rs` unit test; `repo_ops::log_pages_are_stable_and_branches_track_upstreams` (real clone) |
| Z6a-10 | Worktrees: list (porcelain `-z` ≥ 2.36, line format below), add (new branch / existing / detached) under KalCode's data folder, **safe removal refuses dirty (modified or untracked) work**; forced removal only by an explicit `RemoveMode::ForceDiscardChanges`; main worktree and unknown folders refused; inputs validated | PASS | `tests/worktrees.rs` (3 tests), `worktree.rs` unit test |
| Z6a-11 | Checkpoint store per D2: self-contained shadow repository per workspace in app data; private refs `refs/kalcode/checkpoints/<id>` **inside the shadow repository**; the user's index, HEAD and refs are never written | PASS | `checkpoints::create_restore_round_trip_never_touches_the_users_repository` (index, HEAD, `for-each-ref` identical) |
| Z6a-12 | Snapshots respect `.gitignore`/excludes, skip files > 50 MiB (counted), store exact bytes (no EOL conversion/filters), never follow links out of the workspace, work in non-Git folders, detect "unchanged" | PASS | `checkpoints::{snapshots_keep_exact_bytes_and_skip_large_files, snapshots_never_follow_links_out_of_the_workspace, delete_added_removes_only_files_created_after_the_checkpoint}` |
| Z6a-13 | Restore never destroys uncommitted work without an explicit, separate confirmation: read-only **plan** (overwrite / create / delete / keep-untracked / keep-existing); execution needs a `RestoreConfirmation` bound to the plan digest; a **safety checkpoint is always taken first**; stale plans write nothing; deletions only when requested; ignored and oversized files never touched; HEAD never moves; not reachable from the WebView | PASS | `checkpoints::{create_restore_round_trip…, restore_requires_confirmation_of_the_exact_plan_and_detects_stale_plans, partial_restore_of_selected_paths}` (undo via safety checkpoint, tampered plan refused) |
| Z6a-14 | Branch from checkpoint: additive only (fetch objects, one new commit on the user's HEAD-at-checkpoint, new branch; refuses existing names); works for subfolder workspaces (subtree grafted in a temporary index) | PASS | `checkpoints::{export_branch_is_additive_and_leaves_the_working_tree_alone, export_from_a_subfolder_workspace_grafts_the_subtree}` |
| Z6a-15 | Quota and pruning: usage visible, oldest unpinned pruned first, pinned never pruned, space reclaimed | PASS | `checkpoints::pruning_deletes_refs_and_reclaims_space`; `store` tests (pinned never pruned, DB CHECK) |
| Z6a-16 | File handles per D4: random, session-scoped, bound to one workspace, issued only by native listings, re-validated on every use; bounded registry | PASS | `handles.rs` unit tests; `files_and_handles::handles_are_workspace_bound_and_unforgeable` |
| Z6a-17 | Path-escape attempts fail: `..`, absolute, UNC, `\\?\`, `\\.\`, drive-relative, ADS, reserved device names, trailing dots/spaces, backslashes, control/bidi characters, `.git` (incl. 8.3 short name via canonical check), symlinks, **junctions**, and a **link swapped in after the handle was issued** | PASS | `paths.rs` unit tests (Windows + POSIX rule sets); `files_and_handles::{escape_attempts…, links_to_outside_the_workspace_never_resolve, a_link_swapped_in_after_issue_is_caught_at_use, git_internals_are_unreachable_even_through_short_names}` |
| Z6a-18 | File index: Git ignore rules (also outside repositories), `.git` never entered, links never followed, folder listings with `ignored` flags and paging, incremental updates (files, folders, `.gitignore` changes), watcher | PASS | `files_and_handles::{listing_flags_ignored_entries_and_pages, incremental_updates_follow_files_folders_and_ignore_rules, watcher_keeps_the_index_current}` |
| Z6a-19 | Windows + POSIX path handling: `RelPath` rule sets for both; verbatim canonical paths de-verbatimized for git; CRLF preserved; POSIX symlinks stored as links, Windows links skipped | PASS (Windows executed) · POSIX rules unit-tested | `paths.rs` tests run both rule sets on every OS; integration suite executed on Windows 11 with Git 2.54.0.windows.1. CI runs the same suites on macOS/Linux |
| Z6a-20 | Migration v7 (`git_worktrees`, `checkpoints`) isolated as `GIT_MIGRATION`, not in `MIGRATIONS`; CHECK constraints (oid length, JSON trigger, removed ⇔ removed_at, pinned ⇒ not pruned) | PASS · PENDING-INTEGRATION (registration) | `store.rs` tests `migration_is_isolated_and_numbered_seven`, `database_refuses_inconsistent_rows`, round trips |
| Z6a-21 | IPC: ids validated, no paths from the WebView, lists paged ≤ 500, off the main thread, nothing destructive exposed | PASS (compile + clippy with full wiring on wave 2) · PENDING-INTEGRATION (registration, native E2E) | §6; throw-away branch check (`cargo clippy -p kalcode-desktop --all-targets -D warnings` clean) |
| Z6a-22 | `git.*` / `timeline.checkpoint_*` events: ids and short facts only, transitions only, `git.diff_changed` debounced ≥ 1 s | PASS (facts + wire form) · PENDING-INTEGRATION (CA-0 variants) | `events.rs` tests (exact JSON, transitions, debounce) |
| Z6a-23 | DiffView: unified + split, virtualized (20,000-line diff renders < 120 rows), keyboard navigable (↑/↓, PageUp/PageDown, Home/End, `n`/`p`, Enter), status never colour-only, text never rendered as HTML, tokens only | PASS | Vitest 11/11 (`DiffView.test.tsx`); Playwright 6/6 (`packages/ui/tests/diffview`, port 1443) |
| Z6a-24 | DiffView axe WCAG 2.2 AA clean in both themes and both layouts (with focus shown), including contrast | PASS | Playwright axe runs ×4; screenshots `docs/campaigns/z6a-evidence/diffview-{dark,light}-{unified,split}.png` |
| Z6a-25 | Performance vs §10 (checkpoint ≤ 1 s for 10k files unchanged, ≤ 5 s for 1k changed) | PASS | §8 |
| Z6a-26 | Failure isolation: Git missing/too old leaves KalCode running; Git features report `git_not_found` / `git_too_old`; the file index works without Git | PASS (by construction; `GitCore::with_git`) · fault-injection E2E PENDING (QA, X-05) | `service.rs` |
| Z6a-27 | Quality gates: `cargo fmt --check`, `cargo clippy --workspace --all-targets -D warnings`, `cargo test --workspace`, `pnpm check` (format, lint, typecheck, tests, branding, capabilities, zero-cost) | PASS | §9 |

## 2. API summary (`kalcode_git`)

| Module | Main items | Destructiveness |
| --- | --- | --- |
| `runner` | `Git::locate(hooks_dir)`, `Git::with_executable`, `find_on_path`, `MIN_VERSION` | — |
| `repo` | `Repo::discover(git, ws) -> Option<Repo>`, `prefix()`, `validate_revision`, `validate_branch_name` | read-only |
| `status` | `status(git, repo) -> Status`; `Status::{summary, view}` → `StatusView { summary, branch, files: Vec<StatusFile>, truncated }` | read-only |
| `diff` | `diff(git, repo, &DiffTarget, files, &DiffOptions, handles) -> Diff { files: Vec<FileDiff>, truncated }` | read-only |
| `log` | `log(git, repo, rev, limit, cursor) -> Page<Commit>`, `branches(git, repo) -> Vec<Branch>` | read-only |
| `worktree` | `list`, `add`, `dirty_state`, `remove(.., RemoveMode::Safe \| ForceDiscardChanges)`, `create_managed` | add: additive · Safe remove: refuses dirty · Force: **destructive** |
| `checkpoint` | `CheckpointStore::{create, plan_restore, execute_restore, diff, export_branch, delete_ref, collect_garbage, usage_bytes, prune_to_quota, remove_store}`, `RestoreConfirmation::confirmed_natively(&plan)` | see table below |
| `paths` | `WorkspaceRoot::{new, resolve, contains, relativize}`, `RelPath::{parse, parse_for}`, `plain` | — |
| `handles` | `HandleRegistry::{issue, resolve, rel_path, revoke_workspace}` | — |
| `index` / `watch` | `FileIndex::{build, list_dir, apply_changes, rebuild, find, get}`, `IndexWatcher::start(index, debounce, on_batch)` | read-only |
| `store` | `GIT_MIGRATION`; `insert_worktree`, `get_worktree`, `worktree_path`, `list_worktrees`, `set_worktree_status`; `insert_checkpoint`, `get_checkpoint`, `latest_checkpoint`, `list_checkpoints` (keyset on UUIDv7), `set_pinned`, `prune_candidates`, `mark_pruned` | KalCode DB only |
| `events` | `GitEvent` (proposed wire form), `Transitions` (branch/diff transitions, ≥ 1 s debounce), `trigger_kind` | — |
| `service` | `GitCore::{new, with_git, git, repo, index, list_files, status, diff, log, branches, handles, checkpoints, worktrees_root, forget_workspace}` | — |

Checkpoint operations:

| Operation | Effect on the user's files and repository |
| --- | --- |
| `create` | None. KalCode-private writes in the shadow repository only. |
| `plan_restore` | None (hashes current files into the shadow repository to compare). |
| `execute_restore` | **Destructive to the working tree**: overwrites/creates planned files; deletes only files the plan marks `delete` (opt-in). Always preceded by a safety checkpoint (so it is undoable), requires a `RestoreConfirmation` for the exact plan digest, refuses paths through links, never touches ignored or oversized files, the index, HEAD or refs. Not exposed over IPC (TM P2, native confirmation). |
| `export_branch` | **Additive**: objects fetched, one commit, one new branch; refuses an existing branch. Working tree, index and HEAD unchanged. |
| `diff` | None. |
| `delete_ref` / `collect_garbage` / `prune_to_quota` / `remove_store` | KalCode-private deletes (checkpoints). |

Data-folder layout: `<data>/git/no-hooks/` (empty, recreated at start; `core.hooksPath`),
`<data>/checkpoints/<workspace>.git`, `<data>/worktrees/<workspace>/<worktree>/`.

## 3. Decisions and deviations

1. **D2 seeding.** The plan suggested a temporary index seeded from the *user's* index. A
   self-contained shadow repository lacks the user's blobs (that needs `alternates`, rejected
   in D2), so `write-tree` would fail. The shadow repository keeps its own **stat manifest**
   instead (object id, mode, size, mtime per path; "racy" files within 2 s always re-read).
2. **No `git add` for snapshots.** Measured: Git for Windows **follows directory junctions** in
   `add`/`ls-files -o`, so a junction in the workspace pulled outside files into a snapshot; and
   each loose object cost ~7 ms (real-time scanning of new files), so 1k changed files took
   8.4 s and a first 20k-file snapshot 152 s. Snapshots now use KalCode's own walker (the file
   index's: Git ignore rules, links never followed) and stream new content through
   `git fast-import` into one pack per snapshot (first 20k snapshot 4.2 s; 1k changed 1.4 s).
3. **Links.** POSIX symlinks are snapshotted as links (mode 120000); Windows links and
   junctions are skipped (counted), because restoring them faithfully isn't possible without
   privileges.
4. **Repository filters.** Filter drivers defined by the *repository's* config (local/worktree
   scope, including included files) are neutralized; drivers from the user's global/system
   config (for example large-file storage) are the user's own choice and still run for status,
   diff and worktree checkout in the user's repository. Snapshots never run any filter.
5. **IPC scope.** `worktree_remove` is safe-mode only; forced removal and checkpoint restore
   need TK + a native confirmation and are not exposed. `worktree_create` accepts purpose
   `user` only from the WebView. Two commands beyond the proposal table: `git_branches`,
   `checkpoint_diff` (read-only).
6. **No generated TypeScript.** Wire types derive `serde` only (no `ts-rs`) so this branch never
   touches `packages/protocol/src/generated`; `DiffView` declares its own prop types matching
   the JSON. The lead moves the types into contracts (§7) and generates TS then.
7. **Ports.** UI tests use 1443 (brief), not the plan table's 1441.

## 4. Security findings

| # | Finding | Status |
| --- | --- | --- |
| S1 | Plain `git status` runs repository code: fsmonitor hook, clean filters (racy files), `post-index-change` hook. `worktree add` runs `post-checkout`, `reference-transaction`, smudge filters. `diff` runs `diff.external`, `diff.<drv>.command`, textconv. `log` with `log.showSignature` runs `gpg.program`. | Mitigated (hardening + per-repository neutralization); proven by hostile + control tests |
| S2 | Git for Windows follows junctions while snapshotting (`add -A`) — outside files would enter checkpoints and could be restored into the workspace. | Fixed (own walker; restore refuses link ancestors) |
| S3 | A repository's `core.worktree` can point git at a folder outside the workspace. | Refused (`repository_outside_workspace`) |
| S4 | A filter name containing `=` can't be neutralized with `-c`. | Refused (`repository_config_unsafe`) |
| S5 | `core.hooksPath=` (empty) resolves to `<drive root>/<hook>` in some builds. | Avoided: dedicated empty KalCode folder, emptied at startup |
| S6 | Git for Windows rejects `--git-dir=\\?\…` (canonical verbatim paths). | Handled (`paths::plain`) |
| S7 | Locating `git` through relative `PATH` entries or `.cmd` shims could run a planted binary. | Absolute entries and `git.exe` only |
| S8 | Handle resolution has a residual time-of-check/time-of-use window between canonicalization and a later open by a consumer. | Documented: consumers (CTX, UD) should open, then verify the opened path is still inside (recommend a `read_contained` helper in TK-1's path module) |
| S9 | Global/system filter drivers (trusted user config) still run in the user's repository. | By design (S1 note); snapshots never run filters |
| S10 | Nested repositories inside a workspace are snapshotted as plain files (their `.git` is never entered). | Documented |

## 5. Persistence — migration v7

`crates/git/migrations/0007_git.sql`, exposed as `kalcode_git::store::GIT_MIGRATION` (version 7,
name `git`), **not** in `kalcode_core::db::MIGRATIONS`. Tables `git_worktrees` and `checkpoints`
exactly as `CONTRACTS_ADVANCED.md` §9 plus CHECK constraints; no foreign key to another
campaign's tables (`workspace_id` resolved through Z1's API). Tests fill v2–v6 with placeholders
because main's runner is gap-free.

**Registration (lead):** native-core cannot depend on `kalcode_git` (the dependency points the
other way), so move the file to `crates/native-core/migrations/0007_git.sql` (byte-identical),
declare `pub const GIT_MIGRATION: Migration` in `db.rs` next to the others (or append it to
`MIGRATIONS` directly), and replace the constant in `crates/git/src/store.rs` with
`pub use kalcode_core::db::GIT_MIGRATION;` (the `include_str!` path is the only change). The
test `migration_is_isolated_and_numbered_seven` asserts v7 is *not* registered and must be
flipped at integration.

## 6. IPC — lines for the lead

`apps/desktop/src-tauri/Cargo.toml` `[dependencies]` (wave 2 already has `kalcode-contracts`):

```toml
kalcode-git = { path = "../../../crates/git" }
```

`apps/desktop/src-tauri/src/lib.rs`:

```rust
mod files_commands;
mod git_commands;
```

in `setup`, before `app.manage(state)`:

```rust
let git_state = git_commands::GitState::new(&state.paths.data_dir);
```

and after it: `app.manage(git_state);` — then in `tauri::generate_handler![…]`:

```rust
git_commands::git_status,
git_commands::git_diff,
git_commands::git_log,
git_commands::git_branches,
git_commands::worktree_list,
git_commands::worktree_create,
git_commands::worktree_remove,
git_commands::checkpoint_list,
git_commands::checkpoint_create,
git_commands::checkpoint_pin,
git_commands::checkpoint_diff,
files_commands::files_list,
```

`apps/desktop/src-tauri/build.rs` `COMMANDS`:

```rust
"git_status", "git_diff", "git_log", "git_branches",
"worktree_list", "worktree_create", "worktree_remove",
"checkpoint_list", "checkpoint_create", "checkpoint_pin", "checkpoint_diff",
"files_list",
```

`apps/desktop/src-tauri/capabilities/main.json` `permissions`:

```json
"allow-git-status", "allow-git-diff", "allow-git-log", "allow-git-branches",
"allow-worktree-list", "allow-worktree-create", "allow-worktree-remove",
"allow-checkpoint-list", "allow-checkpoint-create", "allow-checkpoint-pin", "allow-checkpoint-diff",
"allow-files-list"
```

The build then generates 12 tracked files in `permissions/autogenerated/` (commit them).
`check-capabilities` passes once both lists are added.

| Command | Input | Output |
| --- | --- | --- |
| `files_list` | `{ workspaceId, dir?: FileHandle, page }` | `Page<FileEntry>` |
| `git_status` | `{ workspaceId, worktreeId?, page }` | `{ repository, summary?, branch?, files: Page<StatusFile>, truncated }` |
| `git_diff` | `{ workspaceId, worktreeId?, target: DiffTarget, files?: FileHandle[] ≤ 500, contextLines? ≤ 20 }` | `Diff` |
| `git_log` | `{ workspaceId, worktreeId?, page }` | `Page<Commit>` |
| `git_branches` | `{ workspaceId }` | `Branch[]` |
| `worktree_list` / `worktree_create` / `worktree_remove` | `{ workspaceId }` / `{ workspaceId, branch, purpose: "user", start? }` / `{ worktreeId }` | `Worktree[]` / `Worktree` / `Worktree` |
| `checkpoint_list` / `checkpoint_create` / `checkpoint_pin` / `checkpoint_diff` | `{ workspaceId, page }` / `{ workspaceId }` / `{ checkpointId, pinned }` / `{ checkpointId, toCheckpointId? }` | `Page<Checkpoint>` / `Checkpoint` / `Checkpoint` / `Diff` |

TK-1: `worktree_create`, `worktree_remove` and `checkpoint_create` should be evaluated by the
Trust Kernel (origin `user`) once it exists; they are user-origin, non-destructive today.

## 7. Contract and event requests (CA-0)

Move from `kalcode_git::types` (same JSON) into `crates/contracts` with `TS` derives:
`FileHandle`, `FileRef`, `PageRequest`, `Page<T>` (`refs.rs`, as proposed); `FileEntry`,
`GitStatusSummary`, `Worktree`, `WorktreePurpose`, `WorktreeStatus`, `DiffFile`, `Checkpoint`,
`CheckpointTrigger` (§5.3, as proposed). New (not in the proposal): **`GitFileChange`**
(`added | modified | deleted | renamed | copied | type_changed | unmerged` — `FileChange` has no
renames), `DiffTarget` (tagged `kind`: `working_tree | staged | head | base{base} |
commits{from,to}`), `Diff`, `FileDiff` (`DiffFile` + `hunks`, `hunksTruncated`), `Hunk`,
`DiffLine`, `LineKind`, `StatusFile`, `ConflictKind`, `BranchState`, `Commit`, `Branch`,
`BranchKind`; for TM: `PlannedChange` gains **`keep_existing`** (checkpoint has the file but the
current one is ignored/oversized, so it is kept).

`EventPayload` variants (all `version: 1`), wire form tested in `events.rs`:

| Type | Payload |
| --- | --- |
| `git.branch_changed` | `{ workspaceId, from?, to }` (`to = "(detached)"` when detached) |
| `git.diff_changed` | `{ workspaceId, worktreeId?, files }` — debounced ≥ 1 s, transitions only |
| `git.commit_created` | `{ workspaceId, worktreeId?, oid, byKalCode }` — produced by branch-from-checkpoint (TM) |
| `git.worktree_created` / `git.worktree_removed` | `{ workspaceId, worktreeId, branch, purpose }` |
| `timeline.checkpoint_created` | `{ checkpointId, workspaceId, trigger, files, bytesAdded }` (`trigger` = kind string) |
| `timeline.checkpoint_pruned` | `{ checkpointId, reason }` |

`git_commands.rs::record` is the single mapping point (returns no events until the variants
exist). Also requested: `FeatureId::GitCore` (X-01) and error codes in the `Git` category:
`git_not_found`, `git_too_old`, `not_a_repository`, `unsafe_repository`, `repository_locked`,
`repository_bare`, `repository_outside_workspace`, `repository_config_unsafe`,
`unknown_revision`, `already_exists`, `worktree_dirty`, `worktree_locked`, `worktree_is_main`,
`worktree_unknown`, `checkpoint_missing`, `checkpoint_unknown`, `git_timed_out`; `Permission`:
`path_outside_workspace`, `path_git_internal`, `restore_not_confirmed`, `restore_path_unsafe`;
`Validation`: `file_handle_invalid`, `file_handle_unknown`, `invalid_revision`,
`invalid_branch_name`, `invalid_page`, `invalid_cursor`.

## 8. Performance (§10)

Windows 11, Git 2.54.0.windows.1, release build, real-time scanning on (it dominates file
creation). `cargo test -p kalcode-git --release --test perf -- --ignored --nocapture`
(`KALCODE_PERF_FILES` sets the size).

| Operation | 10,000 files | 20,000 files | Budget |
| --- | ---: | ---: | --- |
| File index: initial build | 140 ms | 29–34 ms | — (proposed ≤ 1 s at 20k) |
| File index: list root folder | 2 ms | 3 ms | — |
| File index: incremental update (1 file) | 1 ms | 1 ms | — |
| Git: discover repository | 59 ms | 205 ms | — |
| Git: status, clean (warm) | 35 ms | 60–184 ms | — |
| Git: status, 100 modified | 30 ms | 45–133 ms | — |
| Git: diff HEAD with hunks, 100 modified | 103 ms | 285–340 ms | — |
| Git: log first page (50) | 150 ms | 85–281 ms | — |
| Checkpoint: first (cold shadow repository) | 1.5 s | 4.2 s | — (was 152 s with `git add`) |
| **Checkpoint: no content changes** | **486 ms** | 1.03 s | **≤ 1 s at 10k** PASS |
| Checkpoint: no changes, skip-if-unchanged | 738 ms | 583 ms | — |
| **Checkpoint: 1,000 changed files** | **1.43 s** | 1.37 s | **≤ 5 s** PASS (was 8.4 s) |
| Checkpoint: restore plan | 542 ms | 1.32 s | — |

Ranges are two runs; the machine was shared with other builds. Process start of `git` is
~30–100 ms here, so single operations are dominated by spawn cost.

## 9. Test results

| Suite | Result |
| --- | --- |
| `kalcode_git` unit tests | 38 passed |
| `tests/checkpoints.rs` | 10 passed |
| `tests/files_and_handles.rs` | 8 passed |
| `tests/hostile_config.rs` | 3 passed |
| `tests/repo_ops.rs` | 8 passed |
| `tests/worktrees.rs` | 3 passed |
| `tests/sec_latent_store.rs` (SEC-LATENT, §11) | 7 passed |
| `tests/sec_latent_open_verified.rs` (SEC-LATENT, §11) | 5 passed |
| `tests/perf.rs` | 1 passed + 1 ignored by default (run above) |
| `packages/ui` Vitest (`DiffView.test.tsx`) | 11 passed |
| `packages/ui` Playwright (`tests/diffview`, port 1443) | 6 passed |
| `pnpm check` (format, lint, typecheck, all tests, branding, capabilities, zero-cost) | exit 0 |
| `cargo clippy -p kalcode-desktop --all-targets -D warnings` with the IPC fully wired on `integrate/wave2` (throw-away branch) | clean |

## 10. Shared-file changes (additive)

| File | Change |
| --- | --- |
| `Cargo.lock` | `ignore`, `notify` (+ transitive) for `crates/git`; SEC-LATENT: `same-file` (every OS except Linux) as a direct dependency — already in the tree through `ignore` → `walkdir`, no new crate |
| `packages/ui/package.json`, `pnpm-lock.yaml` | `test` / `test:ui` scripts; dev dependencies for Vitest and the Playwright component test (same versions as `apps/desktop`) |
| `packages/ui/src/components/index.ts` | exports `DiffView`, its model helpers and types |

Nothing in `crates/contracts`, `EventPayload`, native-core, `lib.rs`, `build.rs`,
`capabilities/main.json`, `generated/index.ts` or shell files was changed.

## 11. Security hardening (SEC-LATENT, review of 1bce77f)

Gate from `docs/campaigns/ADVANCED.md` §14b ("checkpoint store inside-workspace guard skipped on
first use: fix before Z6a IPC wiring"). Full write-up: `docs/campaigns/SEC-LATENT.md`.

| Finding | Fix | Evidence |
| --- | --- | --- |
| **Store guard skipped on first use.** `prepare` compared `canonicalize(base_dir)` with the workspace, and `canonicalize` fails while the store folder doesn't exist yet, so the first checkpoint (and `create_dir_all`) happened inside the workspace (review PoC `zz_review_store_inside.rs`). | `CheckpointStore::check_location` runs on every workspace entry point (`create`, `plan_restore`, `execute_restore`, `diff`, `export_branch` — all go through `prepare`) **before** anything is created and again right after the folder is created. The location is `paths::resolve_nearest`: nearest existing ancestor canonicalized (links, junctions, 8.3 names, letter case) plus the missing rest appended lexically; the purely lexical form (`..` popped) is checked too. Overlap is refused in **both** directions (store inside workspace, workspace inside store), component-wise, case-insensitively on Windows (`paths::is_within`). | `tests/sec_latent_store.rs`: 6 of 7 failed before the fix (`store_inside_workspace_is_refused_on_first_use`, `every_workspace_entry_point_is_guarded_on_first_use`, `dot_dot_and_missing_components_do_not_hide_the_workspace`, `other_letter_case_is_the_same_folder_on_windows`, `a_link_into_the_workspace_is_followed_on_first_use` (junction), `workspace_inside_the_store_is_refused`); all 7 pass after, including the control `store_outside_the_workspace_still_works_on_first_use`. |
| **Check-then-open race on workspace reads.** Snapshots resolved paths during the walk and opened them later; a file or folder swapped for a link/junction in between made `File::open` read outside content into a checkpoint (and a restore could write it back). Consumers reading by handle had only `resolve` (a path) and opened it themselves. | Open-then-verify: `WorkspaceRoot::open_verified(rel)` opens first, then `verify_opened` establishes where the **opened handle** is — on Linux the kernel's final path (`/proc/self/fd/N`); on Windows and other systems the path is resolved canonically again (containment-checked) and the handle must be that very file (`same_file`: volume serial + file index via `GetFileInformationByHandle` on Windows, device + inode on Unix) — and refuses it unless it is inside the workspace and not under `.git`. A handle obtained through a swap is a different file and is refused even if the link is swapped back. No `unsafe` code: `GetFinalPathNameByHandleW` would need an FFI call, and the workspace allows exactly one audited `unsafe` site. `HandleRegistry::open(ws, handle)` returns the verified `File` for consumers that read by handle. | `tests/sec_latent_open_verified.rs` (5): did not compile before (API missing); after: foreign handle refused (`path_outside_workspace`), directory link to outside refused, a handle whose folder was swapped for a junction after issue refused on `open`, directories refused, normal reads work. |

**Read sites now on the helper:** `snapshot::read_capped` (every file content read for
checkpoints; a refused file is skipped like any unreadable file and never enters the pack).
`read_link` of POSIX symlinks stores the link text and never follows it; the other `fs::read*`
calls in the crate read KalCode's own store files (`info/attributes`, manifest, marks), not
workspace content; `index.rs` lists directory names only. The desktop shell's future
file-content IPC must use `HandleRegistry::open`, not `resolve` + its own open.

**Store-only entry points** (`delete_ref`, `collect_garbage`, `usage_bytes`, `prune_to_quota`,
`remove_store`) take a workspace id, not a root, and never touch workspace files; they are not
guarded (nothing to compare against) — deferred, documented.

**Submodule-filter PoC** (`zz_review_submodule_filter.rs`, a filter defined only in a
submodule's own config running during `worktree::dirty_state`): **not reproduced** on this
machine (Git 2.54.0.windows.1) — the marker did not appear even for the PoC's own control
(plain `git status` inside the submodule), so it proves nothing either way. Not changed; kept on
the watch list in SEC-LATENT.md (a real fix would enumerate submodule configs and extend the
`-c filter.<name>.*=` overrides, which propagate to submodule children through
`GIT_CONFIG_PARAMETERS`).

**Performance.** Open-then-verify costs one extra canonical resolve + two identity queries
(the first measurement below used a final-path query of similar cost) + handle `metadata` per
file read: 2,000 files open+read took 165–199 ms plain vs 271–416 ms verified
(≈ 0.05–0.12 ms per file, release build, same process, interleaved rounds). No-change
checkpoints read no files. Full perf runs on 2026-09-24 were dominated by machine load (other
builds running; cold first snapshot 82–105 s **with and without** the change, vs 4.2 s in §8):

| Run (release, 20,000 files) | no content changes | 1,000 changed | restore plan |
| --- | ---: | ---: | ---: |
| without open-then-verify (same machine, same hour) | 645 ms | 7.69 s (budget FAIL under load) | 886 ms |
| with open-then-verify | 830–855 ms | 4.89–6.74 s | 1.27–1.86 s |

The no-change budget (≤ 2 s at 20k in `perf.rs`, ≤ 1 s at 10k in §10) holds; the 1k-changed
budget (≤ 5 s) is load-bound on this machine today (it failed without the change too); the
measured overhead of the fix for 1,000 files is ≈ 0.1 s.
