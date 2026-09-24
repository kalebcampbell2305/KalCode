/**
 * Provider adapter contract (defined in Z0, implemented from Z2).
 *
 * Every AI provider is reached through this interface. Provider-specific concepts are
 * translated into these shapes at the adapter boundary and must not leak elsewhere.
 * See docs/PROVIDERS.md.
 */

import type { ApprovalScope, PermissionMapping, PermissionProfileId } from "./permissions.ts";

export type ProviderId = "claude-code" | "codex" | "gemini-cli" | (string & { readonly __provider?: never });

export type DetectionState = "installed" | "not_installed" | "outdated" | "error";

export interface ProviderDetection {
  providerId: ProviderId;
  state: DetectionState;
  /** Absolute path of the resolved executable, when installed. */
  executablePath: string | null;
  version: string | null;
  /** Minimum version KalCode supports, for "outdated" messaging. */
  minimumVersion: string | null;
  /** Authenticated state as reported by the provider's own documented status command. */
  authenticated: boolean | "unknown";
  error: string | null;
  checkedAt: string;
}

export interface ProviderModel {
  id: string;
  displayName: string;
  isDefault: boolean;
}

export interface ProviderCapabilities {
  streaming: boolean;
  interrupt: boolean;
  resume: boolean;
  /** Provider can route permission prompts to the host (KalCode) for a decision. */
  hostApprovals: boolean;
  models: readonly ProviderModel[];
  permissionMapping: PermissionMapping;
}

export type AuthKind = "cli_session" | "oauth" | "api_key" | "enterprise" | "workload_identity";

export interface ProviderAccount {
  id: string;
  providerId: ProviderId;
  /** User-facing label, e.g. "Personal" or "Work". Never a secret. */
  label: string;
  authKind: AuthKind;
  /** Opaque reference into the OS secure store; never the secret itself. */
  secretRef: string | null;
}

export interface SessionConfig {
  threadId: string;
  accountId: string | null;
  model: string | null;
  workingDirectory: string;
  permissionProfile: PermissionProfileId;
}

export interface AgentSession {
  sessionId: string;
  providerId: ProviderId;
  threadId: string;
  startedAt: string;
}

export type AgentInput =
  | { kind: "text"; text: string }
  | { kind: "text_with_attachments"; text: string; attachmentIds: readonly string[] };

/** Normalized runtime states (docs/DASHBOARD.md). Never inferred from model prose. */
export type ThreadStatus =
  | "starting"
  | "active"
  | "thinking"
  | "running_tool"
  | "running_command"
  | "editing"
  | "testing"
  | "reviewing"
  | "idle"
  | "waiting_for_permission"
  | "waiting_for_user"
  | "waiting_for_dependency"
  | "paused"
  | "completed"
  | "failed"
  | "interrupted"
  | "recovering"
  | "offline";

export type AgentEvent =
  | { kind: "status"; status: ThreadStatus; detail: string | null }
  | { kind: "message_delta"; messageId: string; text: string }
  | { kind: "message_completed"; messageId: string }
  | { kind: "tool_requested"; toolCallId: string; tool: string; summary: string }
  | { kind: "tool_started"; toolCallId: string }
  | { kind: "tool_completed"; toolCallId: string; ok: boolean }
  | { kind: "approval_requested"; requestId: string; scope: ApprovalScope; summary: string }
  | { kind: "file_changed"; path: string; change: "created" | "modified" | "deleted" }
  | { kind: "usage"; inputTokens: number | null; outputTokens: number | null }
  | { kind: "error"; code: string; message: string; recoverable: boolean }
  | { kind: "exited"; exitCode: number | null };

export interface AgentProvider {
  readonly id: ProviderId;
  readonly displayName: string;
  detect(): Promise<ProviderDetection>;
  getCapabilities(): Promise<ProviderCapabilities>;
  getAccounts(): Promise<ProviderAccount[]>;
  createSession(config: SessionConfig): Promise<AgentSession>;
  send(sessionId: string, input: AgentInput): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  resume(sessionId: string): Promise<void>;
  terminate(sessionId: string): Promise<void>;
  approve(requestId: string, scope: ApprovalScope): Promise<void>;
  deny(requestId: string): Promise<void>;
  events(sessionId: string): AsyncIterable<AgentEvent>;
}
