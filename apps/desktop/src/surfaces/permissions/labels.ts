import type {
  ActionKind,
  ApprovalDecision,
  ApprovalView,
  PermissionMode,
  PermissionScope,
  RuleEffect,
} from "@kalcode/protocol";
import { isRemoteConsequential } from "@kalcode/protocol";
import type { PermissionScopeTone } from "@kalcode/ui/components";

/** Mirrors `scopes::label` in crates/permissions. */
export const SCOPE_LABELS: Record<PermissionScope, string> = {
  "filesystem.read": "Reading files in the workspace",
  "filesystem.write": "Changing files in the workspace",
  "filesystem.outside_workspace": "Using files outside the workspace",
  "terminal.read_only": "Running read-only commands",
  "terminal.execute": "Running commands",
  "package.install": "Installing packages",
  "git.read": "Reading Git history",
  "git.commit": "Changing the local Git repository",
  "git.push": "Pushing to a Git remote",
  "network.docs": "Reading documentation online",
  "network.other": "Network access",
  "browser.navigate": "Opening web pages",
  "browser.interact": "Interacting with web pages",
  "credentials.access": "Accessing credentials and secrets",
  "messaging.send": "Sending messages",
  "deploy.production": "Deploying or publishing",
  "cloud.modify": "Changing remote or cloud resources",
  "billing.spend": "Spending money",
  destructive: "Destructive operations",
  "process.control": "Stopping or signalling processes",
  "remote.connect": "Connecting to a remote machine",
  "context.share": "Sharing context with an AI provider",
  "memory.write": "Saving to memory",
  "automation.manage": "Creating or enabling automations",
  "agent.delegate": "Delegating work to another agent",
  "tool.unknown": "Using a tool KalCode doesn't recognize",
  "thread.start": "Starting or resuming agent threads",
};

export function scopeTone(scope: PermissionScope): PermissionScopeTone {
  if (isRemoteConsequential(scope) || scope === "destructive") return "danger";
  if (scope === "credentials.access" || scope === "filesystem.outside_workspace") return "waiting";
  return "neutral";
}

export const MODE_LABELS: Record<PermissionMode, string> = {
  plan: "Plan",
  approve: "Approve",
  auto: "Auto",
  bypass: "Bypass",
  custom: "Custom",
};

export const MODE_DESCRIPTIONS: Record<PermissionMode, string> = {
  plan: "Read and plan only. Anything that changes files, runs commands or reaches out is refused.",
  approve: "Reads in the workspace run on their own; changes and commands wait for your approval.",
  auto: "Work the policy covers runs automatically. Installs, deletions, secrets, anything outside the workspace and anything that leaves this computer still ask.",
  bypass:
    "Broad local authority: local work runs without asking. Pushes, deploys, cloud changes, messages and spending still ask, as do secrets and files outside the workspace.",
  custom: "A named rule set, such as Code Reviewer or Local Builder.",
};

export const EFFECT_LABELS: Record<RuleEffect, string> = {
  allow: "Allowed",
  ask: "Asks",
  deny: "Denied",
  never: "Never",
};

/**
 * The answers the approval prompt offers (directive §7.4), in button order: Deny first, the
 * standing grants, then Approve once (primary) last. "Allow via rule" is not offered here.
 */
export const PROMPT_DECISIONS: readonly ApprovalDecision[] = [
  "deny",
  "approve_for_workspace",
  "approve_for_thread",
  "approve_once",
];

export const DECISION_LABELS: Record<ApprovalDecision, string> = {
  deny: "Deny",
  approve_once: "Approve once",
  approve_for_thread: "Allow for thread",
  approve_for_workspace: "Allow for workspace",
  allow_via_rule: "Always allow (rule)",
};

export const RESOLVED_LABELS: Record<ApprovalDecision, string> = {
  deny: "Denied",
  approve_once: "Approved once",
  approve_for_thread: "Allowed for this thread",
  approve_for_workspace: "Allowed for this workspace",
  allow_via_rule: "Allowed by a rule",
};

const EXPIRE_REASONS: Record<string, string> = {
  thread_stopped: "the thread stopped",
  process_restarted: "KalCode restarted",
  superseded: "a newer request replaced it",
  mode_changed: "the thread's permission mode changed",
  answered_in_provider: "it was answered in the provider",
};

export function statusText(view: ApprovalView): string {
  switch (view.status) {
    case "pending":
      return "Approval needed";
    case "approved":
    case "denied":
      return view.resolvedDecision ? RESOLVED_LABELS[view.resolvedDecision] : view.status;
    case "expired":
      return `Expired: ${EXPIRE_REASONS[view.expireReason ?? ""] ?? "it can no longer be approved"}`;
  }
}

/** The exact thing the agent wants to do, shown verbatim. */
export function actionDetail(action: ActionKind): string | undefined {
  switch (action.kind) {
    case "command":
      return action.command || action.argv.join(" ");
    case "file_read":
    case "file_write":
    case "file_delete":
      return action.path;
    case "package_install":
      return `${action.manager} install ${action.packages.join(" ")}`.trim();
    case "git":
      return `git ${action.operation}${action.remote ? ` ${action.remote}` : ""}`;
    case "network":
      return action.url ?? action.host;
    case "browser":
      return `${action.action}${action.url ? ` ${action.url}` : ""}`;
    case "deploy":
      return action.target;
    case "tool":
      return `${action.tool}: ${action.inputSummary}`;
    case "process_signal":
      return `${action.signal} ${action.processName} (pid ${action.pid})`;
    case "remote_connect":
      return action.address;
    case "context_share":
      return `${action.items} context ${action.items === 1 ? "item" : "items"}, ${action.bytes} bytes`;
    case "memory_write":
      return `${action.scope.kind} memory`;
    case "delegate":
      return `agent ${action.delegateAgentId}`;
    case "restore":
      return `checkpoint ${action.checkpointId}: ${action.files} ${action.files === 1 ? "file" : "files"}${
        action.resetBranch ? ", resets the branch" : ""
      }`;
    case "automation_change":
      return `${action.change} automation ${action.automationId}`;
    case "doctor_fix":
      return `${action.fixCode}: ${action.target}`;
    case "create_threads":
      return `${action.count} ${action.providerId} ${action.count === 1 ? "thread" : "threads"}`;
    case "resume_threads":
      return action.scope.kind === "all"
        ? "all threads"
        : action.scope.kind === "workspace"
          ? `threads in workspace ${action.scope.workspaceId}`
          : `thread ${action.scope.threadId}`;
  }
}

/** A short identifier when a name is unknown ("thread 0192f3c4"). */
export function shortId(prefix: string, id: string): string {
  return `${prefix} ${id.slice(0, 8)}`;
}
