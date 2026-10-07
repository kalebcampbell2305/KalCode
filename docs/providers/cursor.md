# Cursor in KalCode

Cursor is a first-class coding provider. A Cursor agent is the official Cursor Agent CLI in a real KalCode PTY, in the selected workspace. Multiple agents are independent terminals. Existing Gemini CLI support is retained.

## Native interface

The adapter uses Cursor's documented CLI, verified against official `2026.10.01-e373342` on Windows; this is the minimum supported release. It detects `cursor-agent` (or the `agent` alias), including the native Windows installation under `%LOCALAPPDATA%/cursor-agent` and the macOS/Linux `~/.local/bin` installation. It preserves the native home, configuration, authentication, PATH, tool environment, workspace and terminal behavior. On Windows it resolves Cursor's official command shim to its adjacent PowerShell launcher with an argument vector, without interpolating user input into shell code.

- Interactive launch: `--workspace`, optional exact `--model`, and an explicit `--resume <chatId>` when the session ID is known. KalCode never uses global "continue latest" to mix independent terminals.
- Plan uses `--mode plan`; Bypass uses `--force`, retaining Cursor's explicit deny rules. Other modes retain native provider approvals.
- Authentication: official `login` browser flow and `status --format json`. Cursor owns persistence. KalCode stores only safe account metadata. Explicit connection checks also validate supported environment authentication through Cursor. Startup restores cached metadata without invoking credential-refreshing native commands. The status reports native credential presence; it does not guarantee that a cached credential will be accepted by the server.
- Models: official `models` command, fetched for the current native account. Exact identifiers and provider-returned names are retained. No vendor, model availability, context window, or separate effort control is invented. A changed catalog can invalidate a remembered selection; KalCode does not silently switch that choice.
- Lifecycle: an additive local Cursor plugin invokes KalCode's authenticated hook bridge. Native session/turn IDs correlate lifecycle events; terminal text never proves completion or readiness. If local plugins are disabled by Cursor policy, native terminal use remains available and automatic delivery waits for verified readiness.
- Usage: **Usage unavailable**. This adapter has no verified source for per-account plan limits, credits or reset times.

## Accounts and shared systems

This integration supports one native Cursor sign-in per OS user. The account can be named in KalCode and reused by multiple terminals, but KalCode does not create fictional isolated browser sessions. No verified native profile selector was found. Additional account metadata is rejected atomically; future multi-account support requires a verified isolation mechanism. Native credentials are never copied into KalCode metadata or logs.

Cursor uses the shared provider registry, account bindings, pane lifecycle, resource limits, Code launcher, Agents/Fleet, account usage, KalVoice, KalTidy, Operations queue/runs and handoff/context delivery. Queued Cursor agent tasks are durably marked as coding terminals before launch or resource admission. Handoffs respect the receiving terminal's actual readiness and partial user input.

Cursor participates in [Unified Memory](../UNIFIED-MEMORY.md), the shared workspace storage and retrieval service used across providers. Fresh terminals receive selected context through Cursor's native `sessionStart` hook without submitting an extra model turn. Accepted native user prompts and final responses can contribute explicit durable knowledge with provenance; retrieved task and handoff text is not recaptured as a new user decision. Memory remains inspectable and editable in KalCode, and account bindings and saved notes survive reopening.

Workspace instructions, files and shared context/handoff packages remain provider-neutral. Cursor can run [Agent Handoff Chain](../HANDOFF_CHAINS.md) steps, because its hooks report when a turn ends. Squads, Launch Recipes, Agent File Ownership and Stuck Agent Detector are roadmap entries, not services implemented by this adapter. Cursor uses their shared identity foundation; this change does not claim those products are shipped.

## Official references

- https://cursor.com/docs/cli/installation.md
- https://cursor.com/docs/cli/reference/parameters.md
- https://cursor.com/docs/cli/reference/authentication.md
- https://cursor.com/docs/hooks.md
- https://cursor.com/docs/plugins.md
- https://cursor.com/docs/reference/plugins.md

Test-only synthetic model listings prove that arbitrary future and custom identifiers survive the UI and native launch path. They are not a product model catalog or a claim of availability to any real account.
