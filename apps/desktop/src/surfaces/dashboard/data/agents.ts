import type { ThreadSummary } from "@kalcode/protocol";

/**
 * In KalCode an agent is a coding agent: Claude Code, Codex or Gemini CLI running in a real
 * terminal pane in Code (`runtimeKind: "interactive_pty"`). A thread is a chat-style session and
 * never counts as an agent, even though both live in the native thread store (AGENTS.md).
 */
export function isCodingAgent(thread: ThreadSummary): boolean {
  return thread.runtimeKind === "interactive_pty" || thread.terminalId !== null;
}

/** "2 agents · 1 thread", "1 agent", "3 threads", or "No agents or threads": counts kept apart. */
export function agentsAndThreadsLabel(agents: number, threads: number): string {
  const parts = [
    agents > 0 ? (agents === 1 ? "1 agent" : `${agents} agents`) : null,
    threads > 0 ? (threads === 1 ? "1 thread" : `${threads} threads`) : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "No agents or threads";
}
