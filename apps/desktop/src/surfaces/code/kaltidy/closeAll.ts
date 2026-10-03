import type { TerminalInfo, ThreadSummary } from "@kalcode/protocol";
import { isCodingAgent } from "../../dashboard/data/agents.ts";

/**
 * KalTidy "Close all terminals and agents" (owner request): a deliberate force-close of every
 * terminal and coding agent in the current workspace, whatever it is doing. Each one ends
 * through the path its own close uses — `terminal_close` for a terminal tab (the shell and
 * everything it started end) and `removeAgent` for a coding agent (its session and process tree
 * end, then it is archived) — so Agent Fleet, Needs You and Runs follow from real state.
 */

export interface CloseAllTargets {
  terminals: readonly TerminalInfo[];
  /** The workspace's threads; only coding agents are closed. */
  threads: readonly ThreadSummary[];
}

export interface CloseAllPorts {
  /** Ends a terminal; resolves once it has ended (its pane can then close). */
  closeTerminal: (terminal: TerminalInfo) => Promise<void>;
  /** Ends and removes a coding agent, closing its pane. */
  removeAgent: (thread: ThreadSummary) => Promise<unknown>;
}

export interface CloseAllResult {
  terminals: number;
  agents: number;
  failed: number;
}

/** Closes every terminal and coding agent at once (in parallel). Never throws. */
export async function closeAllTerminals(targets: CloseAllTargets, ports: CloseAllPorts): Promise<CloseAllResult> {
  const agents = targets.threads.filter((t) => isCodingAgent(t) && t.archivedAt === null);
  const [terminalResults, agentResults] = await Promise.all([
    Promise.allSettled(targets.terminals.map((terminal) => ports.closeTerminal(terminal))),
    Promise.allSettled(agents.map((thread) => ports.removeAgent(thread))),
  ]);
  const ok = (r: PromiseSettledResult<unknown>) => r.status === "fulfilled";
  const closedTerminals = terminalResults.filter(ok).length;
  const closedAgents = agentResults.filter(ok).length;
  return {
    terminals: closedTerminals,
    agents: closedAgents,
    failed: terminalResults.length + agentResults.length - closedTerminals - closedAgents,
  };
}

function count(n: number, one: string, many: string): string {
  return n === 1 ? `1 ${one}` : `${n} ${many}`;
}

/** The one-sentence result of "Close all" (toast title). */
export function closeAllSummary({ terminals, agents, failed }: CloseAllResult): string {
  if (terminals === 0 && agents === 0 && failed === 0) return "No terminals or agents to close.";
  const closed = [
    terminals > 0 ? count(terminals, "terminal", "terminals") : null,
    agents > 0 ? count(agents, "agent", "agents") : null,
  ].filter((part) => part !== null);
  const parts: string[] = [];
  if (closed.length > 0) parts.push(`Closed ${closed.join(" and ")}.`);
  if (failed > 0) parts.push(`${failed === 1 ? "1 couldn't" : `${failed} couldn't`} be closed.`);
  return parts.join(" ");
}
