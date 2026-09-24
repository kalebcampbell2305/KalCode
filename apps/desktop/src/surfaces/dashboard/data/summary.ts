import type { ApprovalRequest, ThreadSummary } from "@kalcode/protocol";
import type { TerminalInfo } from "../../../ipc/pendingContracts.ts";
import { countThreads, type DashboardCounts, isTerminal, STATUS_META } from "./status.ts";

/**
 * Plain, UI-free summary of the runtime. The Dashboard header renders it, and KalVoice can reuse
 * it to answer "what are my threads doing?" without going through React.
 */
export interface RuntimeSummary {
  counts: DashboardCounts;
  /** Distinct workspaces with an open thread. */
  activeWorkspaces: number;
  runningTerminals: number;
  /** Open threads by what they need: working now, needing the user, and resting (blocked or idle). */
  openByGroup: { working: number; attention: number; resting: number };
  /** One line per open thread that is not idle: "<name>: <status or activity>". */
  highlights: string[];
}

export function summarizeRuntime(
  threads: readonly ThreadSummary[],
  approvals: readonly ApprovalRequest[],
  terminals: readonly TerminalInfo[] = [],
): RuntimeSummary {
  const open = threads.filter((t) => !isTerminal(t.status));
  const highlights = open
    .filter((t) => STATUS_META[t.status].group !== "idle")
    .map((t) => `${t.name}: ${t.currentActivity ?? STATUS_META[t.status].label}`);
  const openByGroup = { working: 0, attention: 0, resting: 0 };
  for (const t of open) {
    const group = STATUS_META[t.status].group;
    if (group === "working") openByGroup.working += 1;
    else if (group === "attention") openByGroup.attention += 1;
    else openByGroup.resting += 1;
  }
  return {
    counts: countThreads(threads, approvals.length),
    openByGroup,
    activeWorkspaces: new Set(open.map((t) => t.workspaceId)).size,
    runningTerminals: terminals.filter((t) => t.status === "running").length,
    highlights,
  };
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** One or two plain sentences, most urgent first. Never claims more than the data shows. */
export function describeRuntime(summary: RuntimeSummary): string {
  const { counts } = summary;
  const urgent: string[] = [];
  if (counts.approvals > 0) urgent.push(`${plural(counts.approvals, "approval needs", "approvals need")} you`);
  if (counts.waitingForUser > 0)
    urgent.push(`${plural(counts.waitingForUser, "thread is", "threads are")} waiting for your reply`);
  if (counts.failed > 0) urgent.push(`${plural(counts.failed, "thread", "threads")} failed`);

  const status: string[] = [];
  if (counts.running > 0) {
    status.push(
      `${plural(counts.running, "thread is", "threads are")} working` +
        (summary.activeWorkspaces > 1 ? ` across ${summary.activeWorkspaces} workspaces` : ""),
    );
  } else if (counts.open > 0) {
    status.push("Nothing is working right now");
  } else {
    status.push("No threads are open");
  }

  const first = urgent.length > 0 ? `${capitalize(joinClauses(urgent))}.` : "";
  const second = `${capitalize(joinClauses(status))}.`;
  return first ? `${first} ${second}` : second;
}

function joinClauses(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
