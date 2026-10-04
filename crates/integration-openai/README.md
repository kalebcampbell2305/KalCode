# OpenAI integration adapter

This crate connects explicit, user-funded OpenAI Responses requests to KalCode's provider-independent integration broker. A caller supplies an account-scoped OS `SecretStore`, a broker, and account/session authority predicates. Authority is checked on every model continuation and immediately before external dispatch. There is no environment-variable credential fallback, subscription credential reuse, application-funded key, or background inference.

The current official architecture was checked on 2026-10-04:

- https://developers.openai.com/api/docs/guides/function-calling
- https://developers.openai.com/api/docs/guides/tools-tool-search
- https://developers.openai.com/api/docs/guides/tools-remote-mcp
- https://developers.openai.com/api/docs/guides/secure-mcp-tunnels

`query` starts a bounded turn for an exact workspace, surface, and real session. Supported model IDs use client-executed `tool_search`; other model IDs use a strict search function. Search loads at most eight matching capabilities per round and 32 functions per turn. Tool definitions and results do not authorize access: the broker rechecks current grants and the original JSON Schema for every call. Compatible schemas use strict function calling; optional arguments and unsupported strict-schema keywords retain their original semantics with explicit `strict: false` and mandatory broker validation.

Remote MCP and custom HTTP actions run through the broker's restricted transport. Private systems use native Responses MCP tools with `tunnel_id`, explicit `allowed_tools`, and `require_approval: "always"`. The broker automatically authorizes explicitly trusted reads; other calls return its canonical approval request. `resume` consumes the exact pending turn and arguments after the native UI approves the broker request. It neither reinfers the requested action nor retries an uncertain mutation.

Tunnel creation and the official `tunnel-client` runtime are managed in OpenAI Platform and the user's network. KalCode does not download binaries, run arbitrary local commands, or open private network ingress. A tunnel's actual `mcp_list_tools` response is required before recording discovered capabilities and healthy status. Discovery does not execute tools. If the selected model does not return discovery under `tool_choice: "none"`, KalCode reports an error rather than inventing capabilities.

Requests use `store: false` and encrypted reasoning continuation. Conversation state and pending turns live only in RAM and expire after ten minutes; canonical action approvals expire after five minutes. Expired turns are evicted when new approvals are queued, and removing the key clears all pending turns. Four concurrent HTTP requests, 16 rounds, request deadlines, response/history limits, and single-use approval turns bound resource use. Redirects and proxy inheritance are disabled. Upstream error bodies, HTTP credentials, and raw network errors are never exposed. No tool results are written into Unified Memory automatically.

Run the mocked HTTP and permission tests with `cargo test -p kalcode-integration-openai`. Tests use only synthetic credentials and loopback HTTP; no paid inference or external service actions occur.
