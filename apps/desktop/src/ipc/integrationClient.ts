import { invoke, isTauri } from "@tauri-apps/api/core";

export type IntegrationSurface = "code" | "kalvoice" | "brainstorm";
export interface ToolScope {
  workspace_id: string;
  surface: IntegrationSurface;
  session_id: string;
}
export interface AccessGrant extends ToolScope {
  tool_names: string[];
}
export interface IntegrationTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  risk: "read" | "sensitive";
}
export interface CustomTool extends IntegrationTool {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
}
export interface IntegrationInput {
  id?: string;
  name: string;
  kind: "remote_mcp" | "custom_api" | "secure_mcp_tunnel";
  endpoint: string;
  tools: CustomTool[];
  trusted_read_tools: string[];
}
export interface Integration {
  id: string;
  name: string;
  kind: IntegrationInput["kind"];
  endpoint: string;
  connected: boolean;
  health: "unknown" | "healthy" | "offline" | "auth_expired" | "error";
  status_message: string;
  capabilities: IntegrationTool[];
  grants: AccessGrant[];
  revision: number;
  last_checked_ms: number | null;
}
export interface IntegrationApproval {
  id: string;
  integration_id: string;
  integration_name: string;
  tool_name: string;
  scope: ToolScope;
  arguments_preview: unknown;
  expires_at_ms: number;
}
export type IntegrationTurn =
  | { status: "completed"; text: string; tool_calls: number }
  | { status: "approval_required"; turn_id: string; approval: IntegrationApproval };

export const INTEGRATIONS_CHANGED = "kalcode:integrations-changed";
export const INTEGRATION_APPROVAL_GRANTED = "kalcode:integration-approval-granted";

/** Secrets are sent once to the native credential store. Never persist this payload in browser state or telemetry. */
export async function integrationDispatch<T>(operation: string, fields: Record<string, unknown> = {}): Promise<T> {
  if (!isTauri())
    throw new Error(
      "External tools require KalCode’s desktop runtime. Open this workspace in the desktop app to connect.",
    );
  const result = await invoke<T>("integration_dispatch", { request: { op: operation, ...fields } });
  if (operation === "approve" && typeof fields.approval_id === "string")
    window.dispatchEvent(new CustomEvent(INTEGRATION_APPROVAL_GRANTED, { detail: fields.approval_id }));
  if (["save", "disconnect", "rename", "grants", "refresh"].includes(operation))
    window.dispatchEvent(new Event(INTEGRATIONS_CHANGED));
  return result;
}

export const integrationClient = {
  list: () => integrationDispatch<Integration[]>("list"),
  configuration: (id: string) => integrationDispatch<IntegrationInput>("configuration", { id }),
  save: (input: IntegrationInput, credential?: string) =>
    integrationDispatch<Integration>("save", { input, credential: credential || null }),
  refresh: (id: string) => integrationDispatch<Integration>("refresh", { id }),
  disconnect: (id: string) => integrationDispatch<void>("disconnect", { id }),
  rename: (id: string, name: string) => integrationDispatch<Integration>("rename", { id, name }),
  grants: (id: string, grants: AccessGrant[]) => integrationDispatch<Integration>("grants", { id, grants }),
};

/** Native errors are already scrubbed; never render arbitrary serialized request/transport objects. */
export function integrationError(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string")
    return error.message;
  if (typeof error === "string") return error;
  return "The integration service could not be reached. Retry, or reopen KalCode if the problem continues.";
}
