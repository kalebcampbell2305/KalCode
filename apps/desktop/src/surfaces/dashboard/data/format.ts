import type { ActionKind, ApprovalDecision, PermissionMode, PermissionScope, ThreadSummary } from "@kalcode/protocol";
import { KNOWN_PROVIDERS } from "@kalcode/protocol";
import { isTerminal } from "./status.ts";

function time(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/**
 * Compact elapsed time for dense rows: "under 1 min", "4 min", "1 h 12 min", "3 d 2 h".
 * Minute granularity so a 30-second clock tick is always accurate.
 */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return "under 1 min";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) return restMinutes === 0 ? `${hours} h` : `${hours} h ${restMinutes} min`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `${days} d` : `${days} d ${restHours} h`;
}

/**
 * How long a thread has run: open threads measure to `now`; finished threads measure to their
 * last activity (they stopped running then). Null when timestamps are missing or invalid.
 */
export function runDurationMs(
  thread: Pick<ThreadSummary, "createdAt" | "lastActivityAt" | "status">,
  now: number,
): number | null {
  const start = time(thread.createdAt);
  if (start === null) return null;
  const end = isTerminal(thread.status) ? time(thread.lastActivityAt) : now;
  if (end === null) return null;
  return Math.max(0, end - start);
}

export const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
  plan: "Plan",
  approve: "Approve",
  auto: "Auto",
  bypass: "Bypass",
  custom: "Custom",
};

export const PERMISSION_MODE_HINTS: Record<PermissionMode, string> = {
  plan: "Read and plan only; nothing changes without a new mode",
  approve: "Asks before changing files or running commands",
  auto: "Runs routine work; asks for anything consequential",
  bypass: "Runs without asking, except actions that leave this machine",
  custom: "Follows a custom permission profile",
};

export const SCOPE_LABELS: Record<PermissionScope, string> = {
  "filesystem.read": "Read files",
  "filesystem.write": "Write files",
  "filesystem.outside_workspace": "Files outside the workspace",
  "terminal.read_only": "Read-only command",
  "terminal.execute": "Run commands",
  "package.install": "Install packages",
  "git.read": "Read Git history",
  "git.commit": "Git commit",
  "git.push": "Git push",
  "network.docs": "Documentation sites",
  "network.other": "Network access",
  "browser.navigate": "Browser navigation",
  "browser.interact": "Browser interaction",
  "credentials.access": "Credentials",
  "messaging.send": "Send messages",
  "deploy.production": "Production deploy",
  "cloud.modify": "Change cloud resources",
  "billing.spend": "Spend money",
  destructive: "Destructive",
  "process.control": "Stop processes",
  "remote.connect": "Remote connection",
  "context.share": "Share context",
  "memory.write": "Save to memory",
  "automation.manage": "Manage automations",
  "agent.delegate": "Delegate to an agent",
  "tool.unknown": "Unrecognized tool",
  "thread.start": "Start threads",
};

const PROVIDER_NAMES: Record<string, string> = {
  [KNOWN_PROVIDERS.claudeCode]: "Claude Code",
  [KNOWN_PROVIDERS.codex]: "Codex",
  [KNOWN_PROVIDERS.geminiCli]: "Gemini CLI",
};

/** Display name for a provider id when no thread summary supplies one. */
export function providerName(providerId: string): string {
  return PROVIDER_NAMES[providerId] ?? providerId;
}

export const DECISION_LABELS: Record<ApprovalDecision, string> = {
  deny: "Denied",
  approve_once: "Approved once",
  approve_for_thread: "Allowed for this thread",
  approve_for_workspace: "Allowed for this workspace",
  allow_via_rule: "Allowed by a new rule",
};

export interface ActionDetail {
  /** What kind of thing is requested, in plain words ("Run a command"). */
  kind: string;
  /** The exact target shown in monospace (command line, path, host, packages). */
  target: string | null;
  /** Secondary context, such as the working directory. */
  context: string | null;
}

/** Plain-language breakdown of a normalized action for the approval queue. */
export function describeAction(action: ActionKind): ActionDetail {
  switch (action.kind) {
    case "file_read":
      return { kind: "Read a file", target: action.path, context: null };
    case "file_write":
      return { kind: "Write a file", target: action.path, context: null };
    case "file_delete":
      return { kind: "Delete a file", target: action.path, context: null };
    case "command":
      return { kind: "Run a command", target: action.command, context: action.cwd || null };
    case "package_install":
      return {
        kind: `Install ${action.packages.length === 1 ? "a package" : "packages"}`,
        target: `${action.manager} ${action.packages.join(" ")}`.trim(),
        context: null,
      };
    case "git":
      return {
        kind: `Git ${action.operation}`,
        target: action.remote,
        context: null,
      };
    case "network":
      return { kind: "Reach the network", target: action.url ?? action.host, context: null };
    case "browser":
      return { kind: `Browser: ${action.action}`, target: action.url, context: null };
    case "deploy":
      return { kind: "Deploy", target: action.target, context: null };
    case "tool":
      return { kind: `Use ${action.tool}`, target: action.inputSummary || null, context: null };
    case "process_signal":
      return {
        kind: action.signal === "kill" ? "Force-stop a process" : "Stop a process",
        target: action.processName,
        context: `PID ${action.pid}`,
      };
    case "remote_connect":
      return { kind: "Connect to a remote machine", target: action.address, context: null };
    case "context_share":
      return {
        kind: "Share context with a provider",
        target: `${action.items} ${action.items === 1 ? "item" : "items"}`,
        context: null,
      };
    case "memory_write":
      return { kind: "Save to memory", target: action.scope.kind, context: null };
    case "delegate":
      return { kind: "Delegate to another agent", target: action.delegateAgentId, context: null };
    case "restore":
      return {
        kind: "Restore a checkpoint",
        target: `${action.files} ${action.files === 1 ? "file" : "files"}`,
        context: action.resetBranch ? "Resets the branch" : null,
      };
    case "automation_change":
      return { kind: `Automation: ${action.change}`, target: action.automationId, context: null };
    case "doctor_fix":
      return { kind: "Apply an environment fix", target: action.target, context: action.fixCode };
    case "create_threads":
      return {
        kind: `Open ${action.count === 1 ? "a thread" : `${action.count} threads`}`,
        target: providerName(action.providerId),
        context: null,
      };
    case "resume_threads":
      return {
        kind: "Resume threads",
        target:
          action.scope.kind === "all"
            ? "All threads"
            : action.scope.kind === "workspace"
              ? "One workspace"
              : "One thread",
        context: null,
      };
  }
}
