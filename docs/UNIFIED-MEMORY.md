# Unified Memory

Unified Memory is KalCode's shared, provider-independent project memory. It preserves useful
long-lived project context across agents, providers, terminals, sessions, restarts, KalVoice,
Runs, and orchestration. Memory is relevant, inspectable, editable, fast, safe, and truthful.

Open **Unified Memory** in the workspace navigation. Search project knowledge, add or edit a
note, pin essential guidance, keep a note permanently, or remove an outdated claim. Categories
cover Project, Decisions, Architecture, Conventions, Product, Recent important context, and
Known issues. Every plan includes this basic local project memory, including search, edits,
pins, review, deletion, instruction imports, and local recall. Pro adds automatic capture from
agent/workflow outcomes and automatic project context across providers. Max adds deeper memory
use through its orchestration features as those workflows ship; Max 2X cloud-backed memory
capacity remains a roadmap capability. No arbitrary note-count allowance differentiates plans.

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

- completed structured agent replies and Claude/Codex/Cursor completion hooks;
- explicit user decisions submitted through Claude/Cursor prompt hooks or KalCode's prompt path;
- bounded, workspace-contained `AGENTS.md`, `CLAUDE.md`, and `GEMINI.md` instructions;
- explicit handoff outcomes and labelled Run outcomes.
- labelled merge-commit subjects observed by Operations, with the source commit hash.

Free imports project instruction files; automatic agent and workflow capture requires Pro or
higher. The provider integrations below require Pro or higher and recheck the current verified
plan for every lookup and capture, including after a downgrade. A provider's own native project
instructions remain available on all plans. Downgrading never deletes saved memory or disables
local browsing, edits, privacy controls, or KalVoice recall.

Full-text indexing updates transactionally. Retrieval is limited to relevant notes and a few
explicit pins, with a 4 KB context budget. Background capture uses a bounded queue and does
not hold up terminal output. A failed optional memory lookup never prevents agent launch.
An agent without a named task receives at most two foundational project notes plus pins,
within 2 KB, so it can orient itself without receiving the entire memory store.

Claude receives native appended context and task-specific `UserPromptSubmit` context. Codex
and Gemini receive a native initial context message when matching notes or pins exist;
their native system instructions and tools remain intact. KalCode-submitted subsequent prompts retrieve
task-specific memory. Directly typed Codex/Gemini terminal input is not intercepted or rewritten.
Cursor receives native `additional_context` through its authenticated `sessionStart` hook,
without creating a model turn. Accepted direct terminal and voice prompts retrieve relevant
context through `beforeSubmitPrompt`, including after session resume. These native response
fields are verified against Cursor CLI 2026.10.01. Programmatic tasks and reviewed handoffs
already receive context through the shared service and are not enriched or captured twice.
Cursor's prompt and final-response hooks capture explicit durable knowledge only for the
bound session and accepted generation; hidden reasoning and raw terminal transcripts are excluded.
Provider-neutral session and event-sink interfaces also support future adapters.

Handoff previews include relevant target-workspace memory inside their existing context privacy
filter. Provider launches used by Fleet, Queue, and Runs use the same provider wrapper. KalVoice
can answer questions such as “Why did we use this architecture?” or “Which file owns provider
usage?” from matching current notes, and can forward a saved rule to an agent. Missing matches
are reported honestly.

Agent Handoff Chains use this service directly: each step's delivery-time package includes the
canonical retrieval for the chain's goal and the step's intent, and each step report's summary is
captured with `Handoff` provenance (see `docs/HANDOFF_CHAINS.md`). Brainstorm and Squads are
roadmap surfaces in this source revision; the shared native service and typed source vocabulary
support them without a second memory store.

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
- `crates/native-core/migrations/0024_unified_memory.sql`: atomic local schema and indexes.
- `apps/desktop/src-tauri/src/unified_memory_commands.rs`: authenticated account-bound service,
  background ingestion, IPC, and provider-neutral session integration.
- `apps/desktop/src/surfaces/memory`: workspace view and controls.

Future workflows call `MemoryService::retrieve` for task context, `recall` for matching answers,
and `capture` for conservative durable outcomes. The UI's typed `unified_memory_retrieve`
command is workspace-scoped; source provenance remains native-owned.
