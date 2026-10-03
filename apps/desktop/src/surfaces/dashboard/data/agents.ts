import type { ThreadSummary } from "@kalcode/protocol";

/**
 * In KalCode an agent is a coding agent: Claude Code, Codex or Gemini CLI running in a real
 * terminal pane in Code (`runtimeKind: "interactive_pty"`). A thread is a chat-style session and
 * never counts as an agent, even though both live in the native thread store (AGENTS.md).
 */
export function isCodingAgent(thread: ThreadSummary): boolean {
  return thread.runtimeKind === "interactive_pty" || thread.terminalId != null;
}
