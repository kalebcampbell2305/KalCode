# Universal Session Locator

Status: **built in Z7-W2** (`crates/locator`, `apps/desktop/src-tauri/src/locator_commands.rs`).
Plan and acceptance: `docs/campaigns/ADVANCED.md` §7.12; as built, with evidence:
`docs/campaigns/Z7-W2.md`. Its tables are migration **v11** (an isolated constant until the lead
registers it after v10, the notification center); before that the same tables live in memory for
the session.

System code **LOC** · Phase **P1 (Z7-W2)**

Local search across what KalCode knows about: threads, workspaces, terminals, providers and
activity today; agents, missions, tasks, worktrees, automations, files and commands have entity
kinds reserved for when those systems land.

## How it works

- **Index.** `locator_entries` holds names and statuses (already redacted) and `locator_fts` is a
  contentless FTS5 table with the trigram tokenizer (`remove_diacritics 1`): it can only say which
  rows match, it stores no text. The index is derived: a full reconcile at startup, then
  incremental updates from the event bus on a background thread (batched per 40 ms, never on the
  UI thread, never while the bus holds the writer). A damaged index is dropped and rebuilt from
  Z1/Z3/Z2 without touching anything else.
- **Query language.** Deterministic and local (ADVANCED.md D9). Words that name a kind
  ("threads", "workspaces", "terminals"), a status ("waiting", "working", "failed", "done"), a
  provider ("codex", "claude") or a time ("today", "yesterday", "this week", "now") become filters;
  "what was I working on yesterday" is a recency question. The other words are search terms, each
  widened with a light stem ("tests" → "test") and a fixed alias table ("auth" → authentication,
  login, sign in, oauth, …). Quoted text is searched as typed. If filter words leave nothing, the
  search retries them as plain words ("failed login page") and then without them.
- **Ranking.** Filters run in SQL; candidates are ranked in Rust: where each word matches (whole
  title, whole word, start of a word, inside a word; titles above subtitles), a bonus when the word
  as typed is in the title (so "auth" puts *Authentication Refactor* above a synonym match),
  recency (three-day half-life), status (needs you, working, failed, idle, done) and kind. Results
  are labelled `semantic: false` — "semantic" only ever means an installed on-device model.
- **Filters.** Kind, status class, provider, workspace, recency window (in the person's calendar,
  from their UTC offset), `since`, current activity; relevance or recency order; pages of ≤ 100.
- **Budgets (LOC-06).** 100k entries: p95 20.7–26.6 ms across a mixed query set (release,
  `tests/locator_perf.rs`); a status change costs 0.03 ms per event. Optional alias widening runs
  under a 12 ms SQLite progress-handler budget; words shorter than three characters scan the
  20 000 most recent entries.

## Where it is used

- The command palette (Ctrl+K): results for the typed text above the commands, a kind filter,
  and the filters it understood as chips. Enter opens the best match unless the text names a
  command.
- The workspace rail's search box (workspaces and threads).
- KalVoice: "search for …", "find the thread about …", "what was I working on yesterday" read
  back names and statuses only and open the palette; "focus the … thread" falls back to the
  locator when no thread name matches.

## Privacy

Stored names pass the shared redactor (`kalcode_core::redact`). Message text is indexed only for a
workspace whose owner turns on "Search message text in this workspace" (off by default; ADVANCED.md
decision 6) — and a match inside it is reported as "Matched text in this thread's messages", never
the text. Query text is never stored, logged or put into events (tested by searching a marker and
scanning the database file and WAL). KalVoice reads out names and statuses, never content.

## Events

`session.located` — when a found item is opened, never for a query. Not in the event catalog yet
(a contract request in `docs/campaigns/Z7-W2.md` §7); until then the fact is logged without the
query.
