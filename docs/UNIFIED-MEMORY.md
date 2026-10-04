# Unified Memory

Unified Memory is KalCode's shared, provider-independent project memory. It preserves useful
long-lived project context across agents, providers, terminals, sessions, restarts, KalVoice,
Runs, and orchestration. Memory is relevant, inspectable, editable, fast, safe, and truthful.

Open **Unified Memory** in the workspace navigation. Search project knowledge, add or edit a
note, pin essential guidance, keep a note permanently, or remove an outdated claim. Categories
cover Project, Decisions, Architecture, Conventions, Product, Recent important context, and
Known issues. Memory follows the existing Pro feature placement.

## Local ownership and controls

Records live in KalCode's SQLite database, scoped to the signed-in KalCode account and workspace.
They do not belong to a provider account and survive restarts. They are not cloud-synchronized.
Only selected context is sent to the provider doing the task. Workspace controls independently
disable automatic capture and sharing. Deleting an automatically captured fact suppresses its
rediscovery. Removing a workspace deletes its memory.

The secret detector rejects suspected credentials before storage, including user-entered notes.
It is a conservative detector, not a guarantee that arbitrary sensitive prose can be recognized;
users can inspect and delete every retained note. Terminal output and conversation transcripts
are never copied into memory wholesale.

## Capture and retrieval

Capture recognizes explicit durable labels such as `Decision:`, `Architecture:`, `Convention:`,
`Release rule:`, `Known issue:`, `Constraint:`, `Project:`, `Product decision:`, and `Remember:`.
Examples and fenced code are ignored. Automatic records retain their source. Supported inputs:

- completed structured agent replies and Claude/Codex completion hooks;
- explicit user decisions submitted through Claude's prompt hook or KalCode's prompt path;
- bounded, workspace-contained `AGENTS.md`, `CLAUDE.md`, and `GEMINI.md` instructions;
- explicit handoff outcomes and labelled Run outcomes.
- labelled merge-commit subjects observed by Operations, with the source commit hash.

Full-text indexing updates transactionally. Retrieval is limited to relevant notes and a few
explicit pins, with a 4 KB context budget. Background capture uses a bounded queue and does
not hold up terminal output. A failed optional memory lookup never prevents agent launch.
An agent without a named task receives at most two foundational project notes plus pins,
within 2 KB, so it can orient itself without receiving the entire memory store.

Claude receives native appended context and task-specific `UserPromptSubmit` context. Codex and
Gemini receive a native initial context message when matching notes or pins exist; their native
system instructions and tools remain intact. KalCode-submitted subsequent prompts retrieve
task-specific memory. Directly typed Codex/Gemini terminal input is not intercepted or rewritten.
Provider-neutral session and event-sink interfaces support future adapters, including Cursor
when its coding-agent adapter is implemented.

Handoff previews include relevant target-workspace memory inside their existing context privacy
filter. Provider launches used by Fleet, Queue, and Runs use the same provider wrapper. KalVoice
can answer questions such as “Why did we use this architecture?” or “Which file owns provider
usage?” from matching current notes, and can forward a saved rule to an agent. Missing matches
are reported honestly.

Brainstorm, Squads, and Handoff Chains are roadmap surfaces in this source revision. The shared
native service and typed source vocabulary support these workflows without a second memory
store; no unavailable workflow is claimed to be implemented by this feature.

## Truth and staleness

Notes may link to a relative project file. KalCode fingerprints the file and rechecks selected
linked notes before sharing. Changed, missing, unreadable, or unsafe links are withheld; the UI
marks them for review. Automatic instruction updates supersede the old claims. Unlinked notes
need review after 90 days (14 days for recent context). Permanent notes skip age expiry, but
linked-file changes still mark them stale. Pinning never clears a stale warning. Editing a claim
or explicitly choosing **Mark reviewed** acknowledges its current source snapshot.

Saved claims are labelled as recorded project context, with provenance and dates, rather than
presented as fresh code analysis. Contradictory unlinked claims require user review; KalCode does
not infer which claim is correct from arbitrary prose.

## Integration

- `crates/context/src/memory.rs`: storage, FTS, capture, secret checks, retrieval, and staleness.
- `crates/native-core/migrations/0023_unified_memory.sql`: atomic local schema and indexes.
- `apps/desktop/src-tauri/src/unified_memory_commands.rs`: authenticated account-bound service,
  background ingestion, IPC, and provider-neutral session integration.
- `apps/desktop/src/surfaces/memory`: workspace view and controls.

Future workflows call `MemoryService::retrieve` for task context, `recall` for matching answers,
and `capture` for conservative durable outcomes. The UI's typed `unified_memory_retrieve`
command is workspace-scoped; source provenance remains native-owned.
