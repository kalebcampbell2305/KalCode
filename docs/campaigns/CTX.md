# Campaign CTX/FW — Context & Context Firewall library (P0)

Branch `adv/context` (worktree `adv-context`, from main `47aee0e`) · Crate `crates/context`
(`kalcode_context`) · Schema **v8** (isolated, not registered) · Plan: `docs/campaigns/ADVANCED.md`
§7.8, §9, §10 · Contracts: `docs/CONTRACTS_ADVANCED.md` §3.3, §5.2, §9 · Design: `docs/CONTEXT.md`.

Scope of P0 is the **library only**: no IPC, no UI, no event emission, no edits to
`crates/contracts`, `EventPayload` or `native-core`. Criteria marked **PASS (library)** are verified
by tests in this crate; **PENDING-INTEGRATION** means the library side is done and the remaining step
belongs to the lead (contracts, IPC, event mapping) or to the P2 UI campaign.

## Acceptance matrix — plan criteria (ADVANCED.md §7.8)

| # | Criterion | Result | Evidence |
| --- | --- | --- | --- |
| CTX-01 | Typed items: file, file range, selection, terminal excerpt, diff, event range, memory record, thread excerpt, text; files referenced by handle | PASS (library) · PENDING-INTEGRATION (handles → paths are resolved by Z6a's handle table before items reach the library) | `ItemKind` covers the plan list plus the P0 brief (folder, image/screenshot, document, URL reference, test report, git commit, mission artifact, log/error output); `package_flow::every_item_kind_is_supported` |
| CTX-02 | Preview shows every item, size, verdict and redactions; any item removable; nothing sent without confirming the preview | PASS (library) · PENDING-INTEGRATION (P2 composer tray) | `ContextPackage::preview` / `set_included`; `package_flow::hash_is_pinned_until_send`, `preview_log_and_events_hold_no_secrets` (wire shape) |
| CTX-03 | Provider-safe translation to what the provider accepts; oversize packages trimmed or refused with an explanation | PASS (library) · PENDING-INTEGRATION (`ProviderCapabilities.contextLimits` from Z2) | `translate.rs`; `package_flow::images_translate_by_capability`, `budgets_trim_output_and_refuse_oversize_files`, `references_only_for_fully_allowed_files`, `defaults_never_assume_images_or_attachments` |
| CTX-04 | At send time the content hash must match the previewed hash; otherwise the preview is redone | PASS (library) | `ContextPackage::check_before_send` re-reads and re-evaluates every source; `package_flow::hash_is_pinned_until_send`, `overrides_survive_refresh_only_for_unchanged_content` |
| FW-01 | Firewall before every KalCode-originated send; user-typed prompts warn-and-confirm | PASS (library) · PENDING-INTEGRATION (callers: HS, MEM, AUT, ORG, KalVoice) | `Firewall::evaluate`, `Firewall::check_user_prompt` + `PromptCheck::log_entry`; `firewall_precedence::user_prompts_warn_but_never_block` |
| FW-02 | Blocks secrets, ignored paths, never-share globs, built-in sensitive names, out-of-scope and out-of-workspace items, binaries; *secret* never overridable, *confidential* per-item confirmation | PASS (library) | `firewall_precedence::precedence_table`, `secret_sensitivity_is_never_overridable`, `overrides_lift_only_overridable_blocks_and_keep_redactions`; `never_share_matrix` (8 tests); `firewall_props` |
| FW-03 | Every block, redaction and override logged (`context_firewall_log`, `context.blocked`) | PASS (library) · PENDING-INTEGRATION (event mapping) | `ContextPackage::log_entries`, `confirm_override` → entry, append-only table with triggers; `store_v8::decision_log_is_append_only_and_content_free`; `ContextEvent` facts |
| FW-04 | Honest limit stated; never-share globs offered as TK deny rules for `filesystem.read` | PENDING-INTEGRATION (TK / UI) | Stated in `docs/CONTEXT.md`; `NeverShareRules::patterns()` + `never_share_for_workspace` give TK the glob list; file references are only planned for fully-allowed items and are labelled as governed by the permission rules |

## Acceptance matrix — P0 library brief

| # | Criterion | Result | Evidence |
| --- | --- | --- | --- |
| L-01 | Items carry source, size, sensitivity and a translation plan (reference / inline / summary / refused) | PASS | `PackageItem` (`item.source`, `bytes`, `decision.sensitivity`, `plan`); `TranslationPlan` = Inline, Trimmed, Reference, Attachment, Summary, Refused, Omitted |
| L-02 | Capability descriptors are a trait; test double and documented defaults; images/attachments never assumed | PASS | `ProviderContextCapabilities`, `TextOnlyDefaults`, `ContextLimitsDescriptor`, `provider::testing::FakeProviderCapabilities`; `defaults_never_assume_images_or_attachments` |
| L-03 | Folder analysis never inlines blindly: `.gitignore`/`.ignore`/never-share, size and count budgets, binary detection, relevance hooks, prunable preview | PASS | `folder.rs`; `folder_budgets` (7 tests + 1 release perf test) |
| L-04 | Never-share paths: `.env*`, credentials, private keys `id_*` / `*.pem` / `*.p12` / `*.key`, cloud credential files, `.npmrc`, customer-export patterns | PASS | `never_share::builtin_match`; `never_share::tests::builtin_catalogue`; `never_share_matrix::builtin_names_under_every_spelling` |
| L-05 | Secret detection: high-signal formats + entropy heuristic with false-positive controls | PASS | `secrets.rs` (25 patterns under 18 format ids, plus the entropy heuristic: 19 detector ids); `secrets_table` (39 true-positive fixtures covering all 19 ids, 33 false-positive fixtures) |
| L-06 | Workspace permission, user exclusions, mission scope | PASS | `WorkspacePermission`, `FirewallPolicy::exclusions`, `MissionScope`; `precedence_table`, `mission_artifacts_must_belong_to_the_mission` |
| L-07 | ALLOW / ALLOW_REDACTED / BLOCK with reasons; deny wins | PASS | `FirewallVerdict`, `FirewallReason`, `verdict_of`; `firewall_props::verdict_is_the_strongest_effect`, `restrictions_are_monotonic` |
| L-08 | Redaction preserves structure | PASS | `redact.rs`; `redaction_roundtrip::round_trip_is_idempotent_structure_preserving_and_clean`, property tests |
| L-09 | Append-only decision log design | PASS | `log.rs` (design notes), v8 triggers; `store_v8::decision_log_is_append_only_and_content_free` |
| L-10 | Canonical path containment (approach of `z4/permissions` `paths.rs`, no dependency on it) | PASS | `paths.rs`; `never_share_matrix::escapes_outside_the_workspace`, `link_and_junction_escapes`, `short_names_resolve_to_their_long_names` |
| L-11 | Migration v8 isolated as a const, not in `MIGRATIONS` | PASS | `store::MIGRATION_V8`; `store_v8::migration_is_isolated_and_well_formed` applies it through the core runner with v2–v7 stand-ins |
| L-12 | Detection designed to become the shared `kalcode_core::redact` | PASS | `secrets.rs` + `redact.rs` depend on nothing else in the crate; `redact_log_line` replays every `logging.rs` test vector (`covers_every_log_redaction_vector`) |
| L-13 | Performance within §10 (≤ 50 ms per MiB scanned; 2 MiB default cap) | PASS | See Performance |

## Test evidence

`cargo test -p kalcode-context` — 73 tests at P0 (1 release-only performance test ignored in debug); 86 after SEC-LATENT (19 unit + the suites below + `sec_latent_detection` 3, `sec_latent_firewall` 8, `sec_latent_no_panic` 2):

| Suite | Tests | What it proves |
| --- | --- | --- |
| unit (`src/**`) | 19 | catalogue, folding, diff parsing, sniffing, trimming, merging, labels, URLs, ignore files |
| `secrets_table` | 4 | 39 true positives across all 19 detector ids (AI provider keys, git-host tokens, payment keys, registry tokens, cloud key ids/keys/tokens, chat tokens, email keys, commerce tokens, JWT, bearer, basic auth, URL credentials, connection strings, sensitive assignments in `.env`/JSON/YAML/code, entropy literals, PEM/OpenSSH/PGP/PuTTY/truncated/JSON-escaped private keys); 33 false-positive fixtures (UUIDs, commit ids, image digests, `Cargo.lock` checksums, npm/pnpm/yarn integrity, `go.sum`, PNG/SVG/GIF data URIs, identifiers, constants, CSS classes, calls, type annotations, env/template references, placeholders, masks, member paths, object shorthand, prose, paths, already-redacted text, 400-char blobs) |
| `redaction_roundtrip` | 6 (3 property tests × 512 cases) | idempotence, line count kept, no residue, outside-span text unchanged, log-format parity with all `logging.rs` vectors, arbitrary Unicode safety, embedded secrets never survive |
| `never_share_matrix` | 8 | case, full-width and look-alike Unicode, zero-width/bidi characters, trailing dots/spaces, `::$DATA` and named streams, device names, UNC/device namespaces, drive-relative, `~`/`$HOME`/`%VAR%`/backticks, traversal, sibling-prefix roots, **junction and symlink escapes** (to outside, to `keys/`, to `.aws/`, file symlink to `.env`, dangling), **8.3 short names**, user patterns and exclusions, finally-blocked files never read |
| `firewall_precedence` | 8 | the deny-wins table (17 rule combinations), overrides, secret sensitivity, too-many-secrets, diff section withholding, untrusted provider text + boundary nonce, mission artifacts, prompt warnings |
| `firewall_props` | 5 property tests × 256 cases | monotonicity under every added restriction, verdict = strongest effect, secret paths always final, secrets never in non-blocked output, arbitrary paths/bytes never panic |
| `folder_budgets` | 7 (+1 `--ignored` release) | 13,020-file synthetic tree: file/byte/entry budgets, ignored trees not walked, `.git`/never-share dirs pruned with one entry, links not followed, binaries and oversize files excluded, relevance order, custom scorer, prune and prune-by-pattern, conversion to package items |
| `package_flow` | 10 | capability-driven translation, budgets, hash pinning, override carry-over, all item kinds, link checks, references, preview wire shape, log/event facts without secrets, empty packages |
| `store_v8` | 5 | migration through the core runner, references-only storage, finished-package immutability, append-only log, never-share round trip |

Workspace gates run on this branch: `cargo fmt --all -- --check`, `cargo clippy --workspace
--all-targets -- -D warnings`, `cargo test --workspace`, `pnpm check` (format, lint, typecheck, tests,
branding, capabilities, zero-cost), `cargo deny check` — all pass. During one `pnpm check` run the
pre-existing `kalcode-providers` test `interrupt_uses_the_control_protocol_when_advertised` failed
once under heavy parallel build load; it passed 3/3 in isolation and in the following full
`cargo test --workspace` run (timing flake outside this crate, reported to the lead).

Fixtures never contain a literal credential: secret-shaped values are assembled at run time from a
prefix and a deterministic pseudo-random body (`tests/common/mod.rs`).

## Performance (ADVANCED.md §10: ≤ 50 ms per MiB scanned; default package cap 2 MiB)

Release build, Windows 11, measured by `cargo test --release -p kalcode-context --test
folder_budgets -- --ignored --nocapture`:

| Measurement | Result | Budget |
| --- | --- | --- |
| Secret scan + redaction, 4 MiB of code-like text (≈ 2,500 secrets) | 16–23 ms → **4.1–5.9 ms/MiB**; after SEC-LATENT **34 ms → 8.6 ms/MiB** | ≤ 50 ms/MiB |
| Package build (32 files, 1.94 MiB sent: resolve, read, firewall, translate, render, hash), warm | 32 ms → **16.7 ms/MiB** (cold first run 34 ms); after SEC-LATENT **39 ms → 20.2 ms/MiB** (open-then-verify adds one identity check per file) | ≤ 50 ms/MiB |
| Folder analysis, 10,000 files + 3,000 ignored + never-share/binary/link fixtures | median **67–108 ms**; after SEC-LATENT **63–65 ms** | — (bounded by `max_entries_scanned`) |
| Crafted 8 MiB entropy/data-URI input (review DoS case) | before **~18 s**; after SEC-LATENT **78 ms** release, 3.6 s debug | "well under a second" |
| Debug build, 2 MiB scan | 580 ms (informational) | — |

The SEC-LATENT detector patterns carry their sensitive-word alternation in the regex itself
(one linear pass, matches only near candidate names); a first version that captured every
`name:`/`name=` in the text measured 61 ms/MiB and was reworked before merge.

An early version resolved paths from the filesystem root four times per item (≈ 97 ms/MiB). It now
walks only below the canonical root, canonicalizes once per path and resolves each item once plus
one time-of-use re-check.

## SEC-LATENT hardening (2026-09-24 review of 1bce77f)

Findings from the independent review (`docs/campaigns/ADVANCED.md` §14b), fixed before the
firewall is wired to any provider path. Every PoC from the review snapshot was ported to a real
regression test; each test was run against the unfixed code first and failed.

| Finding | Fix | Evidence (fail before → pass after) |
| --- | --- | --- |
| **M4** file-range items scanned only within the slice; a range that skips the `BEGIN` line leaked the whole PEM body | `Firewall::evaluate_excerpt`: the range is cut from the whole decoded file, secrets are detected in the whole text and clipped to the range (a key, YAML block or other multi-line secret intersecting the range is redacted inside it) | `sec_latent_firewall::m4_range_without_pem_header_does_not_leak_key_body` (8/8 body lines leaked → 0 across five ranges), `m4_range_of_assignment_value_on_later_line_is_redacted` |
| **M5** 25 of the review's 37 common formats undetected | A firewall detector layer over the shared catalogue (`src/detectors.rs`, 18 patterns + procedural value readers): AWS console key pairs, Slack/Discord/Teams webhook URLs, RFC 4716 (SSH2) and age private keys, base64-encoded PEM private keys (kubeconfig `client-key-data`, Kubernetes secrets), short names (`DB_PASS`, `SMTP_PW`), carrier suffixes (`SECRET_KEY_BASE`, `client-key-data`), XML elements and `key`/`value` attributes, `name`/`value` pairs (Kubernetes env, JSON), quoted call arguments (`define('DB_PASSWORD', …)`), `curl -u`, `mysql -p…`, `--password <value>`, Dockerfile `ENV NAME value`, `Authorization: Token/Digest/…`, YAML block scalars, URL credentials with an empty user or `/` in the password | `sec_latent_detection::every_review_format_is_fully_redacted` (25/37 leaked → 0/37), `name_value_pairs_are_redacted` (2/3 → 0/3), `new_detectors_keep_common_text_clean` (16 false-positive fixtures); the 33 existing false-positive fixtures in `secrets_table` stay clean |
| **M6** partial redaction (`Tr0ub4dor[…]&3xyzQ`, first word of a quoted password, suffix after a fixed-length match) | Quoted values are redacted to the closing quote (spaces included), unquoted values to the end of the token (`&`, `(`, `$` kept inside); fixed-length format matches are extended over the rest of the token (and alphanumeric prefixes); multi-line values (YAML blocks, SSH2 bodies) are one span; `$…` in single quotes and dotted values in config files count as literals | same matrix (each case asserts no fragment survives and the line count is kept) |
| **M7** dropped files skipped never-share name rules (`document(".env")` was sent redacted) | `Firewall::evaluate*` applies never-share (built-in and user) and exclusion rules to the candidate's `file_name` whenever it is not the checked workspace path — drops, pastes, images, documents; Windows and POSIX paths both | `sec_latent_firewall::m7_dropped_documents_apply_never_share_names` |
| Hard links bypassed never-share names (a workspace name linked to `~/.env` or an in-workspace `.env`) | The opened handle's link count is read (Unix `nlink`, Windows `GetFileInformationByHandle` via `winapi-util`, fail-closed); a file with more than one name is an overridable block with an explanation | `sec_latent_firewall::hard_links_are_not_shared_silently` |
| Combined diffs (`diff --cc`) and plain sections after Git sections bypassed withholding; diffs pasted as log output were never withheld | `split_sections` recognises every header (`diff --git/--cc/--combined/-…`, `Index:`, `Binary files`, rename/copy lines) and plain `---`/`+++` pairs in mixed text; withholding runs for every text item | `sec_latent_firewall::combined_and_mixed_diffs_withhold_never_share_sections` (4 diff shapes × 5 item kinds), `diff::tests::splits_combined_and_mixed_diffs` |
| Quadratic entropy pass (every candidate × every `data:` URI) | Linear pass in the firewall layer: sorted URI ranges walked with a cursor; value-position look-back bounded by the previous token | `sec_latent_firewall::entropy_pass_is_linear_on_crafted_input`: crafted 8 MiB **~18 s → 78 ms** (release), 3.6 s debug |
| Never-share list gaps | Backup/copy decorations stripped before matching; kubeconfigs, `.yarnrc`, `.my.cnf`, `auth.json`, Maven, Terraform, hub, rclone, Databricks, sops age keys, Azure/gcloud token caches, Firebase admin JSON, `accessKeys.csv`, keytabs, keyrings, browser and password-manager stores/exports, `.gradle/gradle.properties`, `env.production` | `sec_latent_firewall::never_share_name_gaps_are_closed` (57 names blocked, 10 ordinary names still allowed) |
| Read-time TOCTOU | Open-then-verify: the item is read through the handle opened on the checked canonical path; afterwards the name must resolve to the same canonical path **and** the same file identity (`same_file::Handle`: volume serial + file index / device + inode). The canonical path of the handle itself (`GetFinalPathNameByHandleW`, `F_GETPATH`) needs `unsafe` FFI, which the workspace denies; identity comparison gives the same guarantee for the read | `read_checked_file` in `package.rs`; covered by every package test; documented in `docs/CONTEXT.md` |

Panics: `sec_latent_no_panic` (ported `secrev_panics`, extended with the new header and detector
atoms, 40,000 inputs in release / 15,000 in debug, plus 300 random file ranges).

**Shared redactor not changed.** The detection extensions live in this crate
(`secrets::scan_with` = shared catalogue + firewall layer); `kalcode_core::redact` and
`redact_log_line` are untouched (outside this campaign's scope). Recommended follow-up: move
`detectors.rs` into `kalcode_core::redact` so log lines get the same coverage; the shared entropy
pass is still quadratic but only reachable when entropy is enabled, which log redaction never does.

## Decisions

1. **Local mirrors of proposed contract types.** `model.rs` mirrors `contracts::context` (§5.2)
   with the same wire names so the lead can replace them with re-exports. Additions are marked in
   the source and listed below.
2. **Verdict naming.** `FirewallVerdict::AllowRedacted { spans }` is the proposal's
   `Redact { spans }` (ALLOW_REDACTED in the brief). Its `as_str()` is `"redact"` to match the v8
   `verdict` CHECK.
3. **Secret content is redacted, not blocked, by default.** Blocking is available per workspace
   (`SecretAction::Block`); an item with more than 256 findings is blocked as "mostly secrets".
   No override ever removes a redaction; *secret* sensitivity from a path is a final block.
4. **Ignored paths are overridable.** A `.gitignore`d file needs a per-item confirmation
   (confidential), unless another rule blocks it finally. Ignore rules apply even outside Git
   repositories, and any ignoring level wins over a deeper `!rule` (stricter than Git).
5. **Images, PDFs and office files are "unscannable"**: overridable block, then an attachment only
   when the provider declares the modality, format and size; otherwise a description.
6. **Customer-export and `.git/` rules are confidential**, key and credential rules are secret.
   `id_*` matches only names without an extension (so `id_generator.rs` is not blocked).
7. **Look-alike folding** (full-width forms, one-dot leaders, small full stops, dash and low-line
   variants) is applied before matching; invisible, bidi and control characters make a path unsafe.
   Trailing dots and spaces are refused on every platform.
8. **Diff sections for never-share files are withheld**, not the whole diff; the notice keeps the
   file header. The rest is scanned normally.
9. **Provider output is labelled, never blocked**, and every item is framed with a boundary nonce
   derived from the payload hash, so content cannot forge an end-of-item marker. Labels are
   redacted and stripped of brackets and control characters.
10. **File references are opt-in** (`prefer_references`) and only for fully-allowed files, because a
    referenced file reaches the provider under the Trust Kernel, not the firewall, and is not
    hash-pinned.
11. **No content is persisted.** `context_items.source` holds kind, canonical path, line range,
    redacted label, content hash and size. The decision log holds rule codes, counts, paths and
    hashes. Finished packages and the log are protected by triggers.
12. **Deny-wins at the entry-level too**: a finally blocked file is never opened.

## Requests to the lead

### Contract types (`crates/contracts::context`, CA-0)

From `docs/CONTRACTS_ADVANCED.md` §5.2, as implemented here (move or re-export):
`ContextPurpose`, `Sensitivity`, `IgnoreSource`, `FirewallRule`, `FirewallVerdict`,
`ContextItemPreview`, `ContextPreview`, `ContextItemSource`. Changes and additions requested:

- `FirewallRule` additions: `WorkspacePermissionDenied`, `UnsafePath`, `UserExclusion { pattern }`,
  `UnscannableContent`; `SecretDetected` gains `count`; `IgnoredPath` gains `rule` (the built-in id,
  user pattern or ignore file).
- `FirewallVerdict::Redact` → wire name `allow_redacted` (or keep `redact`; the crate adapts).
- New: `RuleEffect`, `FirewallReason { rule, effect, message }`, `ItemKind` (16 kinds),
  `ItemOrigin`, `TranslationPlan`, `RefusalReason`, `Modality`, `LineRange`.
- `ContextItemPreview` additions: `kind`, `sensitivity`, `overridable`, `overrideConfirmed`,
  `translation`, `note`, `unavailable`; `rules` becomes `Vec<FirewallReason>`.
- `ContextPreview.target_provider_id` is a plain provider id string here (`ProviderId` in contracts).
- `ContextLimits { maxInputBytes, acceptsImages }` (§10) is enough for P0 via
  `ContextLimitsDescriptor`; richer descriptors (documents, file references, attachment size,
  image formats) map onto `ProviderContextCapabilities` when Z2 needs them.

### Events (`EventPayload`, all `version: 1`)

`context.package_created { packageId, purpose, items, bytes }`, `context.blocked { packageId, rule,
items }`, `context.redacted { packageId, items, spans }`, `context.shared { packageId, threadId,
providerId, items, bytes, redactions }`, `context.discarded { packageId }` — as proposed; plus
**`context.override_confirmed { packageId, position, rule }`** (new: FW-03 logs overrides). The
crate produces these as `events::ContextEvent` (serde tag = event type) for one-to-one mapping.

### Integration steps

1. Move `crates/context/migrations/0008_context.sql` to `crates/native-core/migrations/` and
   register `Migration { version: 8, name: "context", … }` in `MIGRATIONS` (or reference
   `kalcode_context::MIGRATION_V8` from the desktop crate). Checksum is over the SQL text, so the file
   must move unchanged.
2. Extract `secrets.rs` + `redact.rs` into `kalcode_core::redact`; point `logging.rs` at
   `redact_log_line` (drop-in: same placeholder, borrowed when clean, all existing vectors pass) and
   re-export from this crate.
3. IPC (`CONTRACTS_ADVANCED.md` §7): `context_package_create` → `ContextPackage::build` +
   `store::save_preview` + `log_entries` + `created_events`; `context_package_update` →
   `set_included` / `confirm_override` (+ log entry, `context.override_confirmed`);
   `context_package_send` → `check_before_send(contentSha256)`; on `Stale` return the new preview;
   on `Ready` send the `RenderedPackage`, `finish_package(Sent)`, `context.shared`;
   `context_package_discard` → `finish_package(Discarded)`; `context_never_share_list/_set` →
   `store::never_share_*`.
4. Resolve Z6a file handles to workspace paths natively before building `ContextItem`s (the WebView
   never supplies paths). Build `FirewallPolicy` from settings + `never_share_for_workspace` + the
   TK decision for `context.share` (non-user origins) as `WorkspacePermission`.
5. Offer never-share patterns to TK as `filesystem.read` deny rules (FW-04).

## Security findings and residual risks

- **Found and fixed during this campaign:** item labels (for example a link carrying credentials)
  were rendered unredacted in item headers; labels now pass the redactor
  (`package_flow::links_are_checked_and_credentials_redacted`). Tokens glued to a preceding word
  (`aghp_…`) escaped `\b`-anchored patterns (found by `firewall_props::secrets_never_reach_output`);
  distinctive prefixes no longer require a word boundary.
- **TOCTOU:** containment is checked before opening; the file is read through the opened handle
  and afterwards the name must resolve to the same canonical path and the same file identity
  (volume serial + file index / device + inode, SEC-LATENT). A local process that can rewrite the
  workspace can still change content after that check; the send-time hash check catches it
  before anything is sent, and the OS account is trusted in the threat model (`SECURITY.md` §1).
- **Hard links:** other names of a multi-linked file cannot be listed portably without `unsafe`
  FFI (`FindFirstFileNameW`), so every such file needs a per-item confirmation.
- **Detection is heuristic.** Unknown credential formats without a sensitive key name and below the
  entropy threshold (or pure hex) are not detected. Pure-hex secrets are only caught in assignments
  with a sensitive name. The preview is the user's final check.
- **Images and PDFs cannot be inspected**; they require a per-item confirmation and are never sent
  to a provider that has not declared the modality.
- **Folder budgets bound work, not risk:** files beyond the budget are left out and listed with a
  reason; they are never silently inlined.
- **The firewall governs what KalCode sends** (FW-04). A provider reading files with its own tools
  is governed by the Trust Kernel and the provider permission mapping.
