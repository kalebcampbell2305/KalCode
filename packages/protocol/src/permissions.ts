/**
 * Permission contract (defined in Z0, enforced from Z4). See docs/PERMISSIONS.md.
 * JARVIS, agents, automations and plugins are all subject to these rules.
 */

export type PermissionMode = "plan" | "approve" | "auto" | "bypass" | "custom";

export type PermissionProfileId = string;

export type PermissionScope =
  | "filesystem.read"
  | "filesystem.write"
  | "filesystem.outside_workspace"
  | "terminal.read_only"
  | "terminal.execute"
  | "package.install"
  | "git.read"
  | "git.commit"
  | "git.push"
  | "network.docs"
  | "network.other"
  | "browser.navigate"
  | "browser.interact"
  | "credentials.access"
  | "messaging.send"
  | "deploy.production"
  | "cloud.modify"
  | "billing.spend"
  | "destructive"
  | `plugin.${string}.${string}`;

/** Scopes whose consequences leave the machine. Never implied by Bypass. */
export const REMOTE_CONSEQUENTIAL_SCOPES = [
  "git.push",
  "messaging.send",
  "deploy.production",
  "cloud.modify",
  "billing.spend",
] as const satisfies readonly PermissionScope[];

export type RuleEffect = "allow" | "ask" | "deny" | "never";

export interface PermissionRule {
  scope: PermissionScope;
  effect: RuleEffect;
  /** Optional matcher, e.g. a command prefix or a domain. Interpreted per scope. */
  match?: string;
}

export interface PermissionProfile {
  id: PermissionProfileId;
  name: string;
  mode: PermissionMode;
  rules: readonly PermissionRule[];
  builtin: boolean;
}

export type ApprovalDecision =
  | "deny"
  | "approve_once"
  | "approve_for_thread"
  | "approve_for_workspace"
  | "allow_via_rule";

export interface ApprovalScope {
  scope: PermissionScope;
  decision: Exclude<ApprovalDecision, "deny">;
}

export type MappingFidelity = "exact" | "approximate_stricter" | "unsupported";

/** How a provider realizes each KalCode mode. Adapters must never map to broader authority. */
export type PermissionMapping = Record<
  Exclude<PermissionMode, "custom">,
  { fidelity: MappingFidelity; providerSetting: string; notes: string }
>;
