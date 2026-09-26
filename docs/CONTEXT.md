# Universal Context Drop and Context Firewall

Status: **thread-composer integration implemented; broader egress adoption remains staged.** The
crate `crates/context` (`kalcode_context`) implements context packages, the Context Firewall,
folder analysis, provider-safe translation, the decision log and schema v8. The desktop thread
composer now exposes an explicit Context Drop tray for workspace files, pasted text, selections,
log excerpts and URL references. Native IPC resolves opaque file handles, shows the firewall
preview, pins its content hash and sends only after the user submits to the exact selected thread,
provider, account and workspace. Campaign report and evidence: `docs/campaigns/CTX.md`. Plan and
acceptance criteria: `docs/campaigns/ADVANCED.md` §7.8; contract types, events, IPC and tables:
`docs/CONTRACTS_ADVANCED.md`.

System code **CTX / FW** · Phase **P0 (library, built) · P2 (UI)**

Typed context packages that the user previews and edits before anything is sent to a provider,
and the firewall every KalCode-originated provider send passes through.

## Context packages

Items: file, file range (lines), folder, image or screenshot, document, diff, log or error output,
terminal excerpt, test report, Git commit, mission artifact, link, selection, text, memory record,
thread excerpt and event range. Paths are resolved natively from file handles; the WebView never
supplies them. Each item carries its source, size, sensitivity (public, internal, confidential,
secret), firewall verdict with reasons, and a translation plan.

**Preview.** The preview lists every item with its size, sensitivity, verdict, the rules that
fired, a redacted excerpt (at most 4 KiB), and how it will be sent. Any item can be removed.
Overridable items (confidential content, ignored paths, images and documents) are sent only after
the user confirms that item.

**Hash pinning.** The package hash covers exactly what would be sent. At send time every source is
read again and checked again; if the hash differs from the previewed one, nothing is sent and the
updated preview is shown instead.

**Translation.** Each item becomes provider input according to what the target provider declares:
inline text, trimmed output (first and last parts of logs, test reports and excerpts), an
attachment (only when the provider declares that modality, format and size), a description (an
image or document the provider can't take, a folder listing), a workspace path reference
(optional, only for fully allowed files, when the provider declares it can read files itself), or
refused with a reason. A provider that declares nothing is treated as text-only. The budget is the
smaller of the provider's input limit and the package cap (2 MiB by default). Links are sent as
addresses only; KalCode never opens them. Provider output passed on as context is framed as
untrusted data.

**Folders.** A folder is never inlined wholesale. The analysis honours `.gitignore`, `.ignore`,
`.kalcodeignore` and Git's exclude files, skips `.git/` and never-share folders, never follows links
or junctions, detects binaries, applies file-count, byte, per-file and walk budgets, and ranks files
by relevance (project descriptions and manifests first, lockfiles and generated files last). The
result lists exactly which files would be shared and why everything else was left out; the user can
prune it before it becomes package items.

## Context Firewall

Runs before every KalCode-originated provider send: context drops, handoff capsules, memory,
automation prompts, delegation prompts and KalVoice reasoning. User-typed prompts get a
warn-and-confirm on secret patterns (a warning, never a block).

Every applicable rule fires and the strongest wins (**deny wins**):

| Rule | Result |
| --- | --- |
| Sharing from this workspace not permitted | Blocked |
| Outside the workspace, or an unsafe path (alternate data stream, device name, trailing dot or space, invisible characters) | Blocked |
| Built-in never-share names: `.env*` (not `.env.example`), private keys (`id_*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.keytab`, …), credential directories (`.ssh`, `.aws`, `.gnupg`, `.azure`, `.kube`, …), credential and token files (`.npmrc`, `.yarnrc`, `.pypirc`, `.netrc`, `.git-credentials`, `.pgpass`, `.my.cnf`, `auth.json`, `terraform.tfstate`, Terraform/Maven/hub/rclone/Databricks/sops credentials, kubeconfigs, Docker `config.json`, Azure and gcloud token caches, service-account and Firebase admin JSON, console `accessKeys.csv`), browser and password-manager stores and exports (`Login Data`, `logins.json`, `key4.db`, keychains, KeePass/1Password/Bitwarden/LastPass exports, `*password*.csv`). Backup and copy names match too (`.env~`, `.env - Copy`, `#.env#`, `id_rsa.bak`, `server.key.orig`). The rule applies to every item — a dropped or pasted file is checked by its name like a workspace file | Blocked (secret; never overridable) |
| Data exports and dumps that may hold customer data; Git's internal folder | Needs confirmation (confidential) |
| Your never-share patterns (all workspaces or one workspace) | Blocked (secret) or needs confirmation (confidential) |
| Your exclusions; outside the mission's scope | Blocked |
| Ignored by `.gitignore` / `.ignore` / `.kalcodeignore` | Needs confirmation |
| Binary files, or larger than the per-item limit | Blocked |
| Images, PDFs and office documents (can't be checked for secrets) | Needs confirmation |
| Secrets in content (known key and token formats, credentials in links, connection strings, command lines and headers, private keys including SSH2, age and base64-encoded PEM keys, webhook URLs, sensitive assignments in env/INI/YAML/JSON/XML/Dockerfiles, name/value pairs, high-entropy values) | Sent with the whole value replaced (or blocked, if the workspace chooses) |
| A never-share file inside a diff — Git, combined (`diff --cc`), plain or renamed — in any item (a diff pasted as log output or a selection too) | That file's changes withheld |
| A file with more than one name (hard link) | Needs confirmation: its other names may be never-share files or lie outside the workspace |
| Provider output | Labelled as untrusted, not blocked |

A **file range** is checked in the context of the whole file: a range that starts inside a private
key, a YAML block or any other multi-line secret is redacted exactly like the whole file.

Names are matched after case folding and look-alike folding (full-width letters and dots, for
example), on the canonical path after links, junctions and short names are resolved. Redaction
replaces only the secret value; key names, quotes and line numbers stay. No confirmation ever
removes a redaction.

Every block, redaction, override and prompt warning is written to an append-only log that holds
rule codes, counts, paths and hashes — never content. Stored packages hold references and hashes,
never content.

## Desktop send lifecycle

The Context Drop IPC is restricted to the main WebView. Package previews bind to the exact thread,
provider, managed account and workspace that the user selected. The native command rechecks that
identity, the thread's active state, every source and the pinned hash immediately before claiming a
one-shot send. Deterministic validation failures leave the package editable. Once the provider call
may have started, a failed, offline or interrupted result becomes `FailedUncertain`; KalCode does
not retry or emit `context.shared` because doing so could duplicate a provider request.

Context content is ephemeral provider input. Thread history and thread events persist the user's
typed prompt, while the context store persists only package references, hashes, sizes, verdicts and
content-free firewall facts. Provider failure follows the same rule: the provider may have seen the
context, but the raw content is not copied into durable conversation history or event payloads.
URL items are references only and KalCode does not fetch them.

This integration governs the explicit thread-composer Context Drop path. Other provider egress
paths must adopt the same canonical package/firewall boundary before they can claim Context
Firewall coverage; the library's presence alone does not make those paths protected.

## Honest limit

Files are read **open-then-verify**: KalCode opens the checked canonical path, reads through that
handle, then re-resolves the name and requires both the same canonical path and the same file
identity (volume and file index on Windows, device and inode on Unix). Swapping the file or a
parent folder between the check and the read is detected and nothing is read. A change after
that point is caught by the send-time hash check. KalCode cannot list a hard-linked file's other
names portably, so such files always need a confirmation.

The firewall governs what KalCode sends. A provider reading files with its own tools is
governed by the Trust Kernel and the provider mapping; "never share" patterns are also offered as
Trust Kernel deny rules for reads. Secret detection is pattern- and heuristic-based: it can miss an
unknown credential format, and it cannot look inside images or PDFs. The preview is the final
check.
