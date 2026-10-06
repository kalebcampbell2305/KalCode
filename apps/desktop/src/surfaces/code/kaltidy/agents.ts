import { agentStateOf, type ThreadSummary } from "@kalcode/protocol";
import { toKalCodeError } from "../../../ipc/errors.ts";
import { isCodingAgent } from "../../dashboard/data/agents.ts";
import { announceClosedPane } from "./closedPanes.ts";

/**
 * KalTidy for coding agents (an agent is a real provider coding terminal, never a chat thread).
 * Only agents whose session is over are ever cleared: failed ones (FAILED in the shared agent
 * state: a failed session, or one idle after a failed turn), and finished, stopped or offline ones. Anything working, waiting, blocked, idle at its prompt or needing the person is
 * never touched by a clear (only "Close all" ends those, after its confirmation).
 */
export type AgentCleanup = "failed" | "finished";

/** Which clear action would remove this agent, or null when it is in use (never cleared). */
export function agentCleanup(thread: ThreadSummary): AgentCleanup | null {
  if (!isCodingAgent(thread) || thread.archivedAt !== null) return null;
  // The same FAILED the Fleet counts (`agentStateOf`), so "Clear failed (N)" clears all N.
  if (agentStateOf(thread) === "failed") return "failed";
  if (thread.status === "completed" || thread.status === "interrupted" || thread.status === "offline") {
    return "finished";
  }
  return null;
}

/** Whether an agent card can offer its clear (X) button. */
export function isClearableAgent(thread: ThreadSummary): boolean {
  return agentCleanup(thread) !== null;
}

/** The ports `removeAgent` needs (a `KalCodeClient` satisfies them). */
export interface AgentRemovalClient {
  archiveThread: (threadId: string) => Promise<ThreadSummary>;
  stopThread: (threadId: string) => Promise<ThreadSummary>;
}

/**
 * The canonical removal of a coding agent, shared by KalTidy and the agent cards' X: archive it
 * (native `thread_archive` ends an idle session and releases its worktree lease), so it leaves
 * Agent Fleet, Needs You and the Agents rail; its history stays in the Fleet's archived view.
 * A dead agent that still holds a session is stopped first (`thread_stop` ends the process
 * tree), so nothing is orphaned. Then its Code pane closes.
 */
export async function removeAgent(client: AgentRemovalClient, thread: ThreadSummary): Promise<ThreadSummary> {
  let archived: ThreadSummary;
  try {
    archived = await client.archiveThread(thread.id);
  } catch (error) {
    if (toKalCodeError(error).code !== "thread_running") throw error;
    try {
      await client.stopThread(thread.id);
    } catch (stopError) {
      if (toKalCodeError(stopError).code !== "thread_not_running") throw stopError;
    }
    archived = await client.archiveThread(thread.id);
  }
  announceClosedPane({ kind: "agent", id: thread.id });
  return archived;
}

export interface ClearResult {
  cleared: number;
  failed: number;
}

/** Removes the agents a clear action targets, in parallel. Never throws. */
export async function clearAgents(
  client: AgentRemovalClient,
  threads: readonly ThreadSummary[],
  which: AgentCleanup,
): Promise<ClearResult> {
  const targets = threads.filter((t) => agentCleanup(t) === which);
  const results = await Promise.allSettled(targets.map((t) => removeAgent(client, t)));
  const failed = results.filter((r) => r.status === "rejected").length;
  return { cleared: results.length - failed, failed };
}

function agentsWord(n: number, which: AgentCleanup): string {
  const kind = which === "failed" ? "failed" : "finished";
  return n === 1 ? `1 ${kind} agent` : `${n} ${kind} agents`;
}

/** The one-sentence result of a clear (toast title). */
export function clearSummary(result: ClearResult, which: AgentCleanup): string {
  if (result.cleared === 0 && result.failed === 0) {
    return which === "failed" ? "No failed agents to clear." : "No finished agents to clear.";
  }
  const parts: string[] = [];
  if (result.cleared > 0) parts.push(`Cleared ${agentsWord(result.cleared, which)}.`);
  if (result.failed > 0)
    parts.push(`${result.failed === 1 ? "1 agent" : `${result.failed} agents`} couldn't be cleared.`);
  return parts.join(" ");
}
