# KalCode Provider Architecture

Status: contract defined in Z0 · Implementation: campaign Z2 · Contract types:
`packages/protocol/src/providers.ts`

## 1. Principles

- KalCode depends on **no single provider**. Provider-specific logic lives behind the
  `AgentProvider` contract and is translated at the adapter boundary into KalCode concepts
  (normalized events, statuses, approvals, capabilities).
- Only **legitimate, documented** integration methods are used: authenticated local CLI
  sessions, documented OAuth, API keys, enterprise credentials, workload identity. KalCode never
  scrapes browser credentials, copies hidden tokens, or reverse-engineers private auth.
- Connecting a provider is available on **every plan**.
- One provider failing never degrades other providers, terminals, workspaces or the Dashboard.
  Each adapter runs its sessions in supervised child processes with isolated failure handling.

## 2. Contract (summary)

```ts
interface AgentProvider {
  id: ProviderId; displayName: string;
  detect(): Promise<ProviderDetection>;              // read-only, never modifies the machine
  getCapabilities(): Promise<ProviderCapabilities>;
  getAccounts(): Promise<ProviderAccount[]>;
  createSession(config: SessionConfig): Promise<AgentSession>;
  send(sessionId, input: AgentInput): Promise<void>;
  interrupt(sessionId): Promise<void>;
  resume(sessionId): Promise<void>;
  terminate(sessionId): Promise<void>;
  approve(requestId, scope: ApprovalScope): Promise<void>;
  deny(requestId): Promise<void>;
  events(sessionId): AsyncIterable<AgentEvent>;     // normalized, typed
}
```

The canonical TypeScript definition, including `ProviderCapabilities`, `PermissionMapping`,
and the normalized `AgentEvent` union, is in `packages/protocol/src/providers.ts`. The runtime
side will be implemented natively (process supervision in Rust) with the same shapes exported
through the protocol package.

## 3. Initial targets

| Provider | Integration surface (to be verified against current official docs in Z2) |
| --- | --- |
| Claude Code | Local CLI with its documented non-interactive / streaming JSON modes and permission settings; the user's own authenticated session or API key. |
| Codex | Local CLI with its documented non-interactive / protocol modes and approval/sandbox policies. |
| Gemini CLI | Local CLI with documented non-interactive output modes. |
| Generic | Future providers via a documented adapter SDK. |

Z2 rule: implement **one provider end-to-end first** to prove the contract, then add others.

## 4. Detection

Detection resolves executables on `PATH` (and documented install locations), runs only
version/status commands with a timeout, and reports: installed, version, authenticated state
where the CLI exposes it, and capabilities. Installation help requires explicit user intent.
