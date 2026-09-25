# Universal Session Locator
Status: **planned — not built.** Nothing described here exists in KalCode yet. Plan and
acceptance criteria: `docs/campaigns/ADVANCED.md`; proposed types, events, IPC and tables:
`docs/CONTRACTS_ADVANCED.md` (PROPOSED, pending lead approval).

System code **LOC** · Phase **P1 (built in Z7-W2)**

Local search across everything KalCode knows about: threads, workspaces (local and remote),
terminals, providers and activity first; agents, missions, tasks, worktrees, automations, files
and recent commands as those systems land.

## How it works

A local SQLite FTS5 index, updated incrementally from the event bus, rebuildable, and
disposable (corruption triggers a rebuild). Filters: type, status, provider, workspace, recency,
relevance, current activity. "Semantic" ranking exists only if the user installs an on-device
embedding model; nothing is sent to a provider for search.

## Privacy

Snippets pass the shared redactor. Message content is indexed only if the user enables it per
workspace. Query text is never stored or put into events. KalVoice reads out names and statuses,
never content. *Recent commands* are only commands KalCode observed; terminal input is never
recorded.

## Events

`session.located` — emitted when a found item is opened, never for a query.
