# Gemini CLI `--output-format stream-json` fixtures

Hand-written from the event types Gemini CLI defines, not captured from real traffic (Gemini CLI
is not installed on the verification machine; no AI quota was used):

- `JsonStreamEvent` (`init`, `message`, `tool_use`, `tool_result`, `error`, `result` with
  `stats`) — https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/output/types.ts
- Headless mode — https://geminicli.com/docs/cli/headless/
- Quota error class names (`RetryableQuotaError`, `TerminalQuotaError`) reported as
  `result.error.type` —
  https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/utils/googleQuotaErrors.ts,
  `getErrorType` in `packages/core/src/utils/errors.ts`, `handleError` in
  `packages/cli/src/utils/errors.ts`

Placeholders: `{SESSION_ID}` becomes the session UUID, `{CWD}` the working directory.

| File | Scenario |
| --- | --- |
| `turn_text.jsonl` | streamed reply and success result |
| `turn_tools.jsonl` | streamed text, a successful write, a shell call that isn't available headless, more text |
| `quota.jsonl` | a `RetryableQuotaError` result |
