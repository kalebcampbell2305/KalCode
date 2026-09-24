# Claude Code stream-JSON fixtures

Hand-written from the documented message shapes, not captured from real traffic (no AI quota
was used):

- `SDKSystemMessage` (`system/init`), `SDKAssistantMessage`, `SDKUserMessage`,
  `SDKPartialAssistantMessage` (`stream_event`), `SDKResultMessage`,
  `SDKPermissionDeniedMessage` (`system/permission_denied`) —
  https://code.claude.com/docs/en/agent-sdk/typescript#message-types
- `system/api_retry` fields and streaming usage — https://code.claude.com/docs/en/headless

Placeholders: `{SESSION_ID}` is replaced with the session id the fake provider was started with
(`--session-id` / `--resume`), `{CWD}` with its working directory (JSON-escaped). The fake
provider (`src/bin/fake_provider.rs`) replays these files over stdout.

| File | Scenario |
| --- | --- |
| `init.jsonl` | `system/init` with the `interrupt_receipt_v1` capability |
| `turn_text.jsonl` | streamed text reply, assistant message, success result |
| `turn_tools.jsonl` | Bash tool call and result, a Write denied by the permission mode, an API retry, final reply |
| `turn_malformed.jsonl` | malformed and unknown lines mixed with valid ones |
| `interrupted.jsonl` | the error result after an interrupt |
