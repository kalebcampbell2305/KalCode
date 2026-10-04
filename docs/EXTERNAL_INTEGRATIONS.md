# External integrations

KalCode uses one native, provider-independent integration broker for connected external tools.
Integration access is available on every plan, with the user's own service credentials and,
for OpenAI requests, a separately supplied user-owned API key. KalCode never supplies inference
credits, reuses a coding-provider subscription token for API billing, or falls back to a company key.

## User paths

Open **Settings → Integrations**, connect a provider-hosted remote MCP endpoint or define a
custom API's exact tools. Check capabilities, then grant selected tools to a workspace and a
specific coding agent, KalVoice, or a supported workflow. New connections have no grants.
Connection metadata appears immediately; network discovery runs asynchronously. Health comes
from actual discovery or execution, not from saving a URL. Cached capabilities survive restart;
refreshing changed schemas revokes previous grants and approvals for review.

**Code → Tools** runs requests in the selected real coding session. Claude Code and Codex panes
also receive KalCode's scoped MCP bridge automatically when they start. It exposes only tool
search and execution, never connection administration or approval. The bridge uses an ephemeral
session bearer passed through the provider environment; external service credentials remain
inside the native broker. Ending the provider process revokes its bearer. Plan agents cannot
execute sensitive operations. Other provider adapters can use the same broker when their
documented transport supports it; they are not silently given access.

KalVoice requests naming a connected service, or explicitly asking to use integrations, route
through the same OpenAI adapter and grants. Ordinary dictation stays dictation. Both spoken and
typed requests use the same approval path. Brainstorm has a canonical scope available to its
workflow adapter; this change does not claim to ship a separate Brainstorm product surface.

For a private MCP service, select **Private / local tools**, enter the OpenAI-issued `tunnel_id`,
and keep the official `tunnel-client` running inside the private network. Tunnel setup and
organization permissions belong to OpenAI Platform. KalCode discovers and calls the tunnel
through Responses, without opening inbound firewall ports or downloading/executing a server.
Private tunnels are available through Code's OpenAI-backed Tools panel and KalVoice. The direct
provider bridge exposes remote MCP and custom HTTP tools; it does not pretend it can directly
call a private tunnel.

## Authentication and authority

Secrets are held in Windows Credential Manager or macOS Keychain, namespaced by the signed-in
KalCode account. The frontend submits a credential once and clears the input; there is no
credential-read IPC. API endpoints cannot contain credentials or query strings. Public HTTP
transport requires HTTPS, rejects private/reserved destinations, pins validated DNS addresses,
does not inherit proxies, and refuses redirects. Private access uses Secure MCP Tunnel.

OAuth uses a registered public desktop client, system-browser authorization, S256 PKCE, a
temporary loopback callback, exact state/host checks, one-use state, and a three-minute expiry.
The verifier stays in native memory. Token exchange is pinned to the configured HTTPS token
endpoint. Passwords and client secrets are never collected. Expired access tokens require
Reconnect; refresh tokens are not retained. Provider app registration and scopes are supplied
by the user or service administrator, not invented by KalCode.

Every call is checked against the current workspace, surface, session, exact tool name, and
original JSON Schema. Custom APIs pin HTTP method and path; the model supplies only validated
arguments. Non-GET custom operations and MCP tools not explicitly classified by the user as
trusted reads require approval. MCP `readOnlyHint` cannot silently weaken policy.

Sensitive approvals bind the connection revision, exact arguments, workspace, surface, and
session. A native confirmation authorizes one execution. Changing grants, changing a connection,
disconnecting, expiry, or replay invalidates the approval. Cancellation does not send the action.
Timeouts never automatically retry writes. Account and process authority are checked again at
dispatch, including after asynchronous DNS/protocol work.

## OpenAI architecture and untrusted data

The adapter uses the Responses API, strict function calling where schemas support it, and
client-executed tool search for explicitly verified compatible models. Other model IDs use a
small search function, with schema validation always enforced by the broker. Discovery loads
only a bounded relevant subset. Native tunnel tools use `tunnel_id`, `allowed_tools`, and
`require_approval: "always"`; trusted reads pass the broker policy without a user dialog.

Requests use `store: false`. Tool output stays in the tool-result channel and is marked
`untrusted_external_data`; model output cannot grant permissions or approve actions. Credentials
and common secret formats are redacted from results and previews. Network errors expose safe,
actionable messages rather than raw request headers or response bodies. Results are rendered as
text, without executing HTML, resolving result URLs, or fetching embedded images.

External results are not automatically stored in Unified Memory. Results carry source integration
and tool identifiers plus `persist_to_memory: false`. Future explicit memory references must
revalidate source access, respect deletion/disconnection and retention, and never store secrets
or bulk-copy external services. This prevents the memory system becoming an uncontrolled mirror.

Official documentation inspected on 2026-10-04:

- [Responses MCP](https://developers.openai.com/api/docs/guides/tools-remote-mcp)
- [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [Function calling](https://developers.openai.com/api/docs/guides/function-calling)
- [Tool search](https://developers.openai.com/api/docs/guides/tools-tool-search)
- [Codex MCP](https://developers.openai.com/codex/mcp)
- [Claude Code MCP](https://code.claude.com/docs/en/mcp)

The architecture must continue to follow current supported documentation. Do not replace the
canonical broker with surface-specific integration implementations, deprecated APIs, unrestricted
model-generated HTTP, blanket tool exposure, or arbitrary third-party server trust.

## Verification

Targeted tests cover schema/SSRF checks, real mocked HTTP MCP exchange, approval replay and scope
isolation, OAuth state, session revocation, Responses request shapes and approval continuations,
Hub access selection, secret input lifecycle, and KalVoice routing. Paid third-party API/OAuth
accounts and actual private tunnels require the user's provider configuration; mock tests do not
claim those accounts were connected. Windows/macOS package and update delivery are separate
release proof and must be recorded before calling this shipped.
