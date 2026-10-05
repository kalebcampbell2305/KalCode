/**
 * The one KalCode agent-state model (owner directive 2026-10-04: agent status is
 * provider-agnostic). Every agent surface — the Agents tab and Fleet, Code, What's Happening,
 * Needs You, counters, KalTidy and KalVoice — shows and filters agents through this module, for
 * every provider alike. `crates/contracts/src/agent_state.rs` is the same mapping, and a Rust test
 * keeps these tables identical to it, row for row.
 */
import type { AgentFilter, AgentState, StatusTone, ThreadStatus, ThreadSummary } from "./generated/index.ts";

/** Activity of an agent that just came up at its prompt and hasn't been given work yet. */
export const READY_ACTIVITY = "Ready for a task";
/** Activity of an idle agent whose last turn failed. */
export const LAST_TURN_FAILED_ACTIVITY = "Last turn failed";

export const AGENT_STATE_OF_STATUS = {
  starting: "starting",
  active: "working",
  thinking: "working",
  running_tool: "working",
  running_command: "working",
  editing: "working",
  testing: "testing",
  reviewing: "working",
  idle: "idle",
  waiting_for_permission: "needs_you",
  waiting_for_user: "needs_you",
  waiting_for_dependency: "waiting",
  paused: "idle",
  completed: "done",
  failed: "failed",
  interrupted: "stopped",
  recovering: "starting",
  offline: "idle",
} as const satisfies Record<ThreadStatus, AgentState>;

export const AGENT_STATE_FILTER = {
  starting: "working",
  ready: "idle",
  working: "working",
  testing: "working",
  waiting: "waiting",
  needs_you: "needs_you",
  idle: "idle",
  done: "done",
  failed: "failed",
  stopped: "done",
} as const satisfies Record<AgentState, Exclude<AgentFilter, "all">>;

export const AGENT_STATE_LABEL = {
  starting: "STARTING",
  ready: "READY",
  working: "WORKING",
  testing: "TESTING",
  waiting: "WAITING",
  needs_you: "NEEDS YOU",
  idle: "IDLE",
  done: "DONE",
  failed: "FAILED",
  stopped: "STOPPED",
} as const satisfies Record<AgentState, string>;

/** Every state, in declaration order. */
export const AGENT_STATES: readonly AgentState[] = Object.keys(AGENT_STATE_LABEL) as AgentState[];

/** The status filters every agent list offers, in order. */
export const AGENT_FILTERS: readonly AgentFilter[] = [
  "all",
  "needs_you",
  "working",
  "waiting",
  "done",
  "idle",
  "failed",
];

export const AGENT_FILTER_LABEL = {
  all: "All",
  needs_you: "Needs you",
  working: "Working",
  waiting: "Waiting",
  idle: "Idle",
  done: "Done",
  failed: "Failed",
} as const satisfies Record<AgentFilter, string>;

/** Sentence-case state words for cards and badges ("Needs you"). */
export const AGENT_STATE_TEXT = {
  starting: "Starting",
  ready: "Ready",
  working: "Working",
  testing: "Testing",
  waiting: "Waiting",
  needs_you: "Needs you",
  idle: "Idle",
  done: "Done",
  failed: "Failed",
  stopped: "Stopped",
} as const satisfies Record<AgentState, string>;

/** The per-status row: `agentStateOf` without approvals. */
export function agentStateOfStatus(status: ThreadStatus, activity: string | null = null): AgentState {
  if (status === "idle") {
    if (activity === READY_ACTIVITY) return "ready";
    if (activity === LAST_TURN_FAILED_ACTIVITY) return "failed";
  }
  return AGENT_STATE_OF_STATUS[status];
}

const TERMINAL: ReadonlySet<ThreadStatus> = new Set(["completed", "failed", "interrupted"]);

/** An agent's state from its runtime facts. Never looks at the provider. */
export function agentStateOf(
  agent: Pick<ThreadSummary, "status" | "currentActivity" | "pendingApprovals">,
): AgentState {
  if (agent.pendingApprovals > 0 && !TERMINAL.has(agent.status)) return "needs_you";
  return agentStateOfStatus(agent.status, agent.currentActivity);
}

/** The filter group an agent belongs to. */
export function agentFilterOf(agent: Pick<ThreadSummary, "status" | "currentActivity" | "pendingApprovals">) {
  return AGENT_STATE_FILTER[agentStateOf(agent)];
}

/** A launch or turn is in progress. */
export function isAgentBusy(state: AgentState): boolean {
  return state === "starting" || state === "working" || state === "testing";
}

export type AgentCounts = Record<AgentFilter, number>;

/** Counts per filter over agents of every provider. */
export function agentCounts(
  agents: readonly Pick<ThreadSummary, "status" | "currentActivity" | "pendingApprovals">[],
): AgentCounts {
  const counts: AgentCounts = { all: 0, needs_you: 0, working: 0, waiting: 0, idle: 0, done: 0, failed: 0 };
  for (const agent of agents) {
    counts.all += 1;
    counts[agentFilterOf(agent)] += 1;
  }
  return counts;
}

/** "3 agents working" — provider-neutral; identity belongs on the individual agents. */
export function agentCountText(count: number, words: string): string {
  return `${count} ${count === 1 ? "agent" : "agents"} ${words}`;
}

/** The contract tone of each state (status is always tone + glyph + word, never colour alone). */
export const AGENT_STATE_TONE = {
  starting: "muted",
  ready: "recovering",
  working: "working",
  testing: "working",
  waiting: "muted",
  needs_you: "waiting",
  idle: "muted",
  done: "done",
  failed: "failed",
  stopped: "muted",
} as const satisfies Record<AgentState, StatusTone>;
