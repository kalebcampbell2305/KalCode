# Codex `codex exec --json` fixtures

Hand-written from the official event and item definitions, not captured from real traffic (no
AI quota was used):

- `ThreadEvent` (`thread.started`, `turn.started`, `turn.completed` with `usage`, `turn.failed`,
  `item.started` / `item.updated` / `item.completed`, `error`) —
  https://github.com/openai/codex/blob/main/sdk/typescript/src/events.ts
- `ThreadItem` (`agent_message`, `reasoning`, `command_execution`, `file_change`,
  `mcp_tool_call`, `web_search`, `todo_list`, `error`) —
  https://github.com/openai/codex/blob/main/sdk/typescript/src/items.ts
- Non-interactive mode — https://developers.openai.com/codex/noninteractive

Placeholders: `{SESSION_ID}` becomes the thread id (the fake's own UUID, or the id passed to
`resume`), `{CWD}` its working directory (JSON-escaped).

| File | Scenario |
| --- | --- |
| `turn_text.jsonl` | reasoning, a reply, usage |
| `turn_tools.jsonl` | a command, a plan update (ignored), a file change, a reply |
| `turn_failed.jsonl` | a reconnect notice and a failed turn |
