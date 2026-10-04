/**
 * The live KalCode demo: its state, its sample workspace and every action a visitor can take.
 *
 * The demo mirrors the shipped desktop app (apps/desktop): the same shell (Command Deck top bar,
 * sidebar, Agents rail), the same Code panes and New agent launcher, the same status vocabulary
 * (@kalcode/protocol/display-status), the same call signs ("Claude A", "Codex A") and the same
 * plan roadmap (@kalcode/protocol/plans). It is temporary by design: state lives in memory for
 * this page view, and Reset (or a reload) returns to the sample workspace.
 *
 * An AGENT is a real coding agent running in its own terminal pane in Code. It is never a thread.
 *
 * Pure module: no DOM. The Astro page renders the initial state at build time and the client
 * script (scripts/live/app.ts) runs the same functions in the browser.
 */
import { DISPLAY_STATUS_LABEL, DISPLAY_STATUS_TONE } from "@kalcode/protocol/display-status";
import { getPlanFeature } from "@kalcode/protocol/plans";

export type ProviderId = "claude" | "codex";
export type Surface = "dashboard" | "operations" | "kalvoice" | "code" | "threads" | "providers" | "settings";
/** The display statuses the demo uses (a subset of the protocol's twelve). */
export type AgentStatus =
  | "starting"
  | "working"
  | "testing"
  | "reviewing"
  | "permission_required"
  | "waiting_for_you"
  | "idle"
  | "done";
export type OpsTab = "runs" | "queue" | "services" | "environments" | "activity";
export type ContextTab = "runs" | "services" | "tests";
export type FleetFilter = "all" | "needs" | "working" | "done" | "idle";
export type LineKind = "in" | "out" | "ok" | "tool" | "dim" | "warn" | "err" | "accent" | "head";

export interface Line {
  k: LineKind;
  t: string;
}

export interface UsageWindow {
  label: string;
  left: number;
  resets: string;
}

export interface Account {
  id: string;
  provider: ProviderId;
  name: string;
  plan: string;
  isDefault: boolean;
  windows: UsageWindow[];
}

/** One beat of an agent's simulated work, played one per tick. */
export interface Beat {
  line?: Line;
  status?: AgentStatus;
  activity?: string;
  /** Advance the sample app shown in Live Browser to this version. */
  preview?: number;
  /** Ask for approval (the agent stops until the visitor answers). */
  approval?: Approval;
  /** Announce completion (KalCode's completion callback). */
  finished?: string;
  files?: number;
}

export interface Approval {
  title: string;
  command: string;
  reason: string;
}

export interface Agent {
  id: string;
  sign: string;
  provider: ProviderId;
  account: string;
  model: string;
  effort: string;
  task: string;
  status: AgentStatus;
  activity: string;
  branch: string;
  minutes: number;
  files: number;
  lines: Line[];
  script: Beat[];
  cursor: number;
  approval: Approval | null;
  /** A fresh agent waits at its prompt for the visitor to type. */
  prompt: boolean;
}

export type TabKind = "agent" | "terminal" | "browser" | "widget";
export interface Tab {
  id: string;
  kind: TabKind;
  agent?: string;
  title: string;
  lines?: Line[];
  /** A terminal that is not running anything (KalTidy stops these). */
  idle?: boolean;
  url?: string;
  widget?: "approvals" | "agents" | "operations";
}

export interface Frame {
  id: string;
  tabs: string[];
  active: string;
}

export interface Launcher {
  provider: ProviderId;
  account: string;
  model: string;
  effort: string;
  count: number;
}

export type Menu =
  | null
  | "accounts"
  | "context"
  | "layout"
  | "tidy"
  | "palette"
  | "mode"
  | "environment"
  | `plus:${string}`;

export interface Nudge {
  id: "first-agent" | "big-workspace" | "voice" | "accounts";
  title: string;
  body: string;
  cta: "get" | "download" | "account";
}

export interface Toast {
  id: number;
  text: string;
  tone: "done" | "info" | "waiting";
  agent?: string;
}

export type VoiceState = "ready" | "listening" | "processing" | "executing" | "done";

export interface State {
  surface: Surface;
  frames: Frame[];
  tabs: Record<string, Tab>;
  agents: Record<string, Agent>;
  order: string[];
  accounts: Account[];
  focus: string;
  maximized: boolean;
  layout: "auto" | "2" | "3" | "4";
  menu: Menu;
  launcher: Launcher | null;
  contextTab: ContextTab;
  opsTab: OpsTab;
  run: string | null;
  environment: Environment;
  fleet: FleetFilter;
  voice: { open: boolean; state: VoiceState; heard: string; reply: string };
  palette: { q: string; sel: number };
  toast: Toast | null;
  nudge: Nudge | null;
  nudged: string[];
  preview: number;
  railOpen: boolean;
  mobile: boolean;
  tick: number;
  seq: number;
  tour: number | null;
  launches: number;
}

export type Environment = "Local" | "Preview" | "Staging" | "Production";
export const ENVIRONMENTS: readonly Environment[] = ["Local", "Preview", "Staging", "Production"];

export const PROVIDER_NAME: Record<ProviderId, string> = { claude: "Claude Code", codex: "Codex" };
export const PROVIDER_SHORT: Record<ProviderId, string> = { claude: "Claude", codex: "Codex" };

/** Model and effort choices exactly as the desktop launcher lists them (crates/providers/src/catalog.rs). */
export const MODELS: Record<ProviderId, readonly string[]> = {
  claude: ["Default", "Opus", "Sonnet", "Haiku", "Fable"],
  codex: ["Default"],
};
export const EFFORTS: Record<ProviderId, readonly string[]> = {
  claude: ["Default", "Low", "Medium", "High", "Extra high", "Max"],
  codex: ["Default", "Minimal", "Low", "Medium", "High", "Extra high"],
};
export const MAX_AGENTS_PER_LAUNCH = 4;
/** Past this many panes the demo suggests building the workspace for real. */
const BIG_WORKSPACE = 6;
export const WORKSPACE = { name: "sample-app", path: "~/Projects/sample-app", branch: "main", ahead: 1, changed: 3 };
export const DEV_URL = "localhost:3000";

export const SURFACES: readonly { id: Surface; label: string; icon: string; hint: string }[] = [
  {
    id: "code",
    label: "Code",
    icon: "code",
    hint: "Where your Claude Code and Codex agents run, each in its own terminal.",
  },
  { id: "dashboard", label: "Dashboard", icon: "dashboard", hint: "Agent Fleet: see every coding agent in one place." },
  {
    id: "operations",
    label: "Operations",
    icon: "operations",
    hint: "Runs, Queue, Services, Environments and Activity.",
  },
  { id: "kalvoice", label: "KalVoice", icon: "kalvoice", hint: "Control KalCode by voice." },
  { id: "threads", label: "Threads", icon: "threads", hint: "Chat-style conversations. Agents live in Code." },
  { id: "providers", label: "Providers", icon: "providers", hint: "Connect multiple Claude Code and Codex accounts." },
];

/** Display label and tone of a status, straight from the protocol mapping every app surface uses. */
export function statusLabel(status: AgentStatus): string {
  return DISPLAY_STATUS_LABEL[status];
}
export function statusTone(status: AgentStatus): string {
  return DISPLAY_STATUS_TONE[status];
}
/** The Fleet's stage words (apps/desktop/src/surfaces/dashboard/data/board.ts). */
export function fleetStage(status: AgentStatus): string {
  switch (status) {
    case "permission_required":
      return "Needs approval";
    case "waiting_for_you":
      return "Needs your reply";
    case "working":
      return "Working";
    case "testing":
      return "Testing";
    case "reviewing":
      return "Reviewing";
    case "done":
      return "Done";
    case "starting":
      return "Starting";
    default:
      return "Idle";
  }
}
export function needsYou(agent: Agent): boolean {
  return agent.status === "permission_required" || agent.status === "waiting_for_you";
}
export function isWorking(agent: Agent): boolean {
  return (
    agent.status === "working" ||
    agent.status === "testing" ||
    agent.status === "reviewing" ||
    agent.status === "starting"
  );
}

/** Whether a roadmap feature is live today: the demo tags anything that is not as Coming soon. */
export function isAvailable(featureId: string): boolean {
  return getPlanFeature(featureId).status === "available";
}

// ── The sample workspace ────────────────────────────────────────────────────────────────────

const L = (k: LineKind, t: string): Line => ({ k, t });

function accounts(): Account[] {
  return [
    {
      id: "claude-personal",
      provider: "claude",
      name: "Personal",
      plan: "Max 20x",
      isDefault: true,
      windows: [
        { label: "5-hour", left: 64, resets: "Resets in 2h 14m" },
        { label: "Weekly", left: 81, resets: "Resets Mon 9:00" },
      ],
    },
    {
      id: "claude-work",
      provider: "claude",
      name: "Work",
      plan: "Pro",
      isDefault: false,
      windows: [
        { label: "5-hour", left: 18, resets: "Resets in 41m" },
        { label: "Weekly", left: 52, resets: "Resets Thu 9:00" },
      ],
    },
    {
      id: "codex-personal",
      provider: "codex",
      name: "Personal",
      plan: "Plus",
      isDefault: true,
      windows: [
        { label: "5-hour", left: 56, resets: "Resets in 3h 02m" },
        { label: "Weekly", left: 73, resets: "Resets Sun 18:00" },
      ],
    },
  ];
}

function claudeHeader(model: string, effort: string, account: string): Line[] {
  return [
    L(
      "head",
      `✻ Claude Code · ${model === "Default" ? "account default model" : model}${effort === "Default" ? "" : ` · ${effort.toLowerCase()} effort`}`,
    ),
    L("dim", `  ${WORKSPACE.path} · ${account}`),
  ];
}
function codexHeader(model: string, effort: string, account: string): Line[] {
  return [
    L(
      "head",
      `>_ Codex · ${model === "Default" ? "default model" : model}${effort === "Default" ? "" : ` · ${effort.toLowerCase()}`}`,
    ),
    L("dim", `  ${WORKSPACE.path} · ${account}`),
  ];
}

function sampleAgents(): Agent[] {
  return [
    {
      id: "a1",
      sign: "Claude A",
      provider: "claude",
      account: "claude-personal",
      model: "Opus",
      effort: "High",
      task: "Dashboard redesign",
      status: "working",
      activity: "Editing src/pages/Dashboard.tsx",
      branch: "agent/dashboard-redesign",
      minutes: 12,
      files: 4,
      cursor: 0,
      approval: null,
      prompt: false,
      lines: [
        ...claudeHeader("Opus", "High", "Personal"),
        L("in", "> Redesign the dashboard: clearer stat cards and a revenue chart"),
        L("tool", "● Read src/pages/Dashboard.tsx (182 lines)"),
        L("tool", "● Read src/components/StatCard.tsx"),
        L("out", "  I'll move the stats into a responsive grid and add a weekly chart."),
        L("ok", "● Edit src/components/StatCard.tsx  +38 −11"),
      ],
      script: [
        {
          line: L("tool", "● Edit src/pages/Dashboard.tsx  +64 −27"),
          activity: "Editing src/pages/Dashboard.tsx",
          preview: 1,
          files: 5,
        },
        { line: L("out", "  Stat cards now use the new grid. Adding the chart next.") },
        {
          line: L("tool", "● Write src/components/RevenueChart.tsx  +71"),
          activity: "Writing RevenueChart.tsx",
          files: 6,
        },
        { line: L("ok", "● Edit src/styles/dashboard.css  +22 −4"), preview: 2 },
        { line: L("tool", "● Bash pnpm typecheck"), activity: "Running pnpm typecheck" },
        { line: L("ok", "  ✓ No type errors") },
        { line: L("out", "  Polishing spacing and the empty state."), preview: 3 },
        { line: L("ok", "● Edit src/components/StatCard.tsx  +6 −2") },
        {
          line: L("accent", "  Done. The dashboard is redesigned — have a look in Live Browser."),
          status: "waiting_for_you",
          activity: "Ready for your review",
          finished: "Claude A finished Dashboard redesign",
        },
      ],
    },
    {
      id: "a2",
      sign: "Codex A",
      provider: "codex",
      account: "codex-personal",
      model: "Default",
      effort: "Medium",
      task: "Tests",
      status: "testing",
      activity: "Running pnpm test",
      branch: "agent/tests",
      minutes: 4,
      files: 3,
      cursor: 0,
      approval: null,
      prompt: false,
      lines: [
        ...codexHeader("Default", "Medium", "Personal"),
        L("in", "› Add tests for the dashboard stat cards"),
        L("tool", "• Wrote src/components/StatCard.test.tsx"),
        L("tool", "• Running pnpm test"),
        L("dim", "  RUN  v3 ~/Projects/sample-app"),
      ],
      script: [
        { line: L("ok", "  ✓ StatCard › renders the value and label") },
        { line: L("ok", "  ✓ StatCard › formats currency") },
        { line: L("err", "  ✗ StatCard › shows the trend arrow") },
        {
          line: L("tool", "• The trend arrow test expects the old markup. Updating it."),
          status: "working",
          activity: "Fixing a failing test",
        },
        { line: L("tool", "• Edited src/components/StatCard.test.tsx  +4 −3"), files: 4 },
        { line: L("tool", "• Running pnpm test"), status: "testing", activity: "Running pnpm test" },
        { line: L("ok", "  ✓ 14 passed (14)") },
        {
          line: L("accent", "  All 14 tests pass."),
          status: "done",
          activity: "14 tests passed",
          finished: "Codex A finished Tests · 14 passed",
        },
      ],
    },
    {
      id: "a3",
      sign: "Claude B",
      provider: "claude",
      account: "claude-work",
      model: "Sonnet",
      effort: "Default",
      task: "Review",
      status: "done",
      activity: "Review complete · 2 suggestions",
      branch: "agent/review",
      minutes: 18,
      files: 0,
      cursor: 0,
      approval: null,
      prompt: false,
      lines: [
        ...claudeHeader("Sonnet", "Default", "Work"),
        L("in", "> Review the open changes on agent/dashboard-redesign"),
        L("tool", "● Read 6 changed files"),
        L("out", "  Looks good. Two suggestions:"),
        L("out", "  1. StatCard: label the trend arrow for screen readers."),
        L("out", "  2. RevenueChart: memoize the weekly totals."),
        L("ok", "  ✓ Review complete"),
      ],
      script: [],
    },
    {
      id: "a4",
      sign: "Claude C",
      provider: "claude",
      account: "claude-personal",
      model: "Sonnet",
      effort: "Medium",
      task: "Login form validation",
      status: "permission_required",
      activity: "Wants to run pnpm add zod",
      branch: "agent/login-validation",
      minutes: 2,
      files: 1,
      cursor: 0,
      approval: { title: "Install zod", command: "pnpm add zod", reason: "Installing packages · Network access" },
      prompt: false,
      lines: [
        ...claudeHeader("Sonnet", "Medium", "Personal"),
        L("in", "> Validate the login form and show inline errors"),
        L("tool", "● Read src/pages/Login.tsx"),
        L("out", "  I'll use zod for the schema."),
        L("warn", "● Bash pnpm add zod — waiting for your approval"),
      ],
      script: [
        { line: L("ok", "  + zod 4.1.0"), status: "working", activity: "Installing zod" },
        { line: L("tool", "● Write src/lib/loginSchema.ts  +18"), activity: "Writing loginSchema.ts", files: 2 },
        { line: L("ok", "● Edit src/pages/Login.tsx  +29 −6"), files: 3 },
        {
          line: L("accent", "  Done. The login form validates and shows inline errors."),
          status: "done",
          activity: "Validation added",
          finished: "Claude C finished Login form validation",
        },
      ],
    },
  ];
}

const DEV_SERVER_LINES: Line[] = [
  L("dim", "PS ~/Projects/sample-app>"),
  L("in", "pnpm dev"),
  L("out", ""),
  L("accent", "  VITE v7.1  ready in 412 ms"),
  L("out", ""),
  L("ok", `  ➜  Local:   http://${DEV_URL}/`),
  L("dim", "  ➜  press h + enter to show help"),
];

export function initialState(): State {
  const agents = sampleAgents();
  const state: State = {
    surface: "code",
    frames: [
      { id: "f1", tabs: ["t-a1", "t-a3"], active: "t-a1" },
      { id: "f2", tabs: ["t-a2", "t-a4"], active: "t-a2" },
      { id: "f3", tabs: ["t-ps"], active: "t-ps" },
    ],
    tabs: {
      "t-a1": { id: "t-a1", kind: "agent", agent: "a1", title: "Claude A" },
      "t-a3": { id: "t-a3", kind: "agent", agent: "a3", title: "Claude B" },
      "t-a2": { id: "t-a2", kind: "agent", agent: "a2", title: "Codex A" },
      "t-a4": { id: "t-a4", kind: "agent", agent: "a4", title: "Claude C" },
      "t-ps": { id: "t-ps", kind: "terminal", title: "PowerShell · dev server", lines: DEV_SERVER_LINES.slice() },
    },
    agents: Object.fromEntries(agents.map((agent) => [agent.id, agent])),
    order: agents.map((agent) => agent.id),
    accounts: accounts(),
    focus: "f1",
    maximized: false,
    layout: "auto",
    menu: null,
    launcher: null,
    contextTab: "runs",
    opsTab: "runs",
    run: null,
    environment: "Local",
    fleet: "all",
    voice: { open: false, state: "ready", heard: "", reply: "" },
    palette: { q: "", sel: 0 },
    toast: null,
    nudge: null,
    nudged: [],
    preview: 0,
    railOpen: true,
    mobile: false,
    tick: 0,
    seq: 10,
    tour: null,
    launches: 0,
  };
  return state;
}

// ── Queries ─────────────────────────────────────────────────────────────────────────────────

export function agentsList(state: State): Agent[] {
  return state.order.map((id) => state.agents[id]).filter((agent): agent is Agent => Boolean(agent));
}
export function accountOf(state: State, id: string): Account | undefined {
  return state.accounts.find((account) => account.id === id);
}
export function accountLabel(state: State, id: string): string {
  return accountOf(state, id)?.name ?? "Account";
}
export function tabOfAgent(state: State, agentId: string): string | undefined {
  return Object.values(state.tabs).find((tab) => tab.agent === agentId)?.id;
}
export function frameOfTab(state: State, tabId: string): Frame | undefined {
  return state.frames.find((frame) => frame.tabs.includes(tabId));
}
export function paneCount(state: State): number {
  return Object.keys(state.tabs).length;
}
export function counts(state: State) {
  const list = agentsList(state);
  return {
    agents: list.length,
    working: list.filter(isWorking).length,
    needs: list.filter(needsYou).length,
    done: list.filter((agent) => agent.status === "done").length,
    idle: list.filter((agent) => agent.status === "idle").length,
  };
}
/** The agents a call sign letter is free for: "Claude A", "Claude B"… in creation order. */
function nextSign(state: State, provider: ProviderId): string {
  const used = new Set(agentsList(state).map((agent) => agent.sign));
  for (let i = 0; i < 26; i++) {
    const sign = `${PROVIDER_SHORT[provider]} ${String.fromCharCode(65 + i)}`;
    if (!used.has(sign)) return sign;
  }
  return `${PROVIDER_SHORT[provider]} ${state.seq}`;
}

export interface Run {
  id: string;
  name: string;
  kind: "agent" | "build" | "service";
  where: string;
  action: string;
  status: "Running" | "Blocked" | "Succeeded" | "Queued" | "Failed";
  duration: string;
  agent?: string;
}

/** Runs: one execution record per agent task, plus the build and the dev server. */
export function runs(state: State): Run[] {
  const fromAgents: Run[] = agentsList(state)
    .filter((agent) => !agent.prompt)
    .map((agent) => ({
      id: `run-${agent.id}`,
      name: agent.task,
      kind: "agent",
      where: `${WORKSPACE.name} · ${agent.branch} · ${PROVIDER_NAME[agent.provider]} · ${accountLabel(state, agent.account)}`,
      action: agent.activity,
      status: needsYou(agent)
        ? "Blocked"
        : agent.status === "done"
          ? "Succeeded"
          : agent.status === "idle"
            ? "Queued"
            : "Running",
      duration: `${agent.minutes}m ${String((state.tick * 7) % 60).padStart(2, "0")}s`,
      agent: agent.id,
    }));
  return [
    ...fromAgents,
    {
      id: "run-build",
      name: "Build",
      kind: "build",
      where: `${WORKSPACE.name} · main · pnpm build`,
      action: "Built in 1m 12s · 0 warnings",
      status: "Succeeded",
      duration: "1m 12s",
    },
    {
      id: "run-dev",
      name: "Frontend dev server",
      kind: "service",
      where: `${WORKSPACE.name} · main · PowerShell`,
      action: `Serving http://${DEV_URL}`,
      status: "Running",
      duration: "42m",
    },
  ];
}

// ── Actions ─────────────────────────────────────────────────────────────────────────────────

function id(state: State, prefix: string): string {
  state.seq += 1;
  return `${prefix}${state.seq}`;
}

/** The frame a new pane opens in: a new frame while there is room, else beside the focus. */
const MAX_FRAMES = 4;

function placeTab(state: State, tab: Tab, own = true) {
  state.tabs[tab.id] = tab;
  if (own && state.frames.length < MAX_FRAMES) {
    const frame: Frame = { id: id(state, "f"), tabs: [tab.id], active: tab.id };
    state.frames.push(frame);
    state.focus = frame.id;
  } else {
    const frame = state.frames.find((f) => f.id === state.focus) ?? state.frames[0];
    if (!frame) {
      state.frames.push({ id: id(state, "f"), tabs: [tab.id], active: tab.id });
    } else {
      frame.tabs.push(tab.id);
      frame.active = tab.id;
      state.focus = frame.id;
    }
  }
  state.surface = "code";
  state.maximized = false;
}

export function go(state: State, surface: Surface) {
  state.surface = surface;
  state.menu = null;
}

export function focusTab(state: State, tabId: string) {
  const frame = frameOfTab(state, tabId);
  if (!frame) return;
  frame.active = tabId;
  state.focus = frame.id;
  state.surface = "code";
}

export function focusAgent(state: State, agentId: string) {
  const tab = tabOfAgent(state, agentId);
  if (tab) focusTab(state, tab);
}

/** Needs You: jump to the first agent that is waiting on the visitor. */
export function jumpToNeeds(state: State): boolean {
  const agent = agentsList(state).find(needsYou);
  if (!agent) return false;
  focusAgent(state, agent.id);
  return true;
}

export function openLauncher(state: State, provider: ProviderId = "claude") {
  const account = state.accounts.find((a) => a.provider === provider && a.isDefault) ?? state.accounts[0];
  state.launcher = {
    provider,
    account: account?.id ?? "",
    model: provider === "claude" ? "Sonnet" : "Default",
    effort: "Default",
    count: 1,
  };
  state.menu = null;
}

export function chooseAccount(state: State, accountId: string) {
  const account = accountOf(state, accountId);
  if (!state.launcher || !account) return;
  const changed = account.provider !== state.launcher.provider;
  state.launcher.account = accountId;
  state.launcher.provider = account.provider;
  if (changed) {
    state.launcher.model = account.provider === "claude" ? "Sonnet" : "Default";
    state.launcher.effort = "Default";
  }
}

function freshAgent(state: State, provider: ProviderId, accountId: string, model: string, effort: string): Agent {
  const account = accountLabel(state, accountId);
  const agentId = id(state, "a");
  return {
    id: agentId,
    sign: nextSign(state, provider),
    provider,
    account: accountId,
    model,
    effort,
    task: "New agent",
    status: "starting",
    activity: "Starting",
    branch: `agent/${agentId}`,
    minutes: 0,
    files: 0,
    cursor: 0,
    approval: null,
    prompt: true,
    lines: provider === "claude" ? claudeHeader(model, effort, account) : codexHeader(model, effort, account),
    script: [
      { status: "idle", activity: "Ready for a prompt", line: L("dim", "  Type a prompt below and press Enter.") },
    ],
  };
}

/** Launch: N agents = N coding terminals, exactly like the desktop's New agent launcher. */
export function launch(state: State): string[] {
  const l = state.launcher;
  if (!l) return [];
  const created: string[] = [];
  for (let i = 0; i < l.count; i++) {
    const agent = freshAgent(state, l.provider, l.account, l.model, l.effort);
    state.agents[agent.id] = agent;
    state.order.push(agent.id);
    placeTab(state, { id: `t-${agent.id}`, kind: "agent", agent: agent.id, title: agent.sign });
    created.push(agent.id);
  }
  state.launcher = null;
  state.launches += created.length;
  return created;
}

export function openTerminal(state: State) {
  state.launcher = null;
  state.menu = null;
  placeTab(state, {
    id: id(state, "t"),
    kind: "terminal",
    title: "PowerShell",
    idle: true,
    lines: [L("dim", "PowerShell 7.5 · demo shell"), L("dim", "Try: git status, pnpm test, ls, help")],
  });
}

export function openBrowser(state: State, url = DEV_URL) {
  state.launcher = null;
  state.menu = null;
  const existing = Object.values(state.tabs).find((tab) => tab.kind === "browser");
  if (existing) {
    existing.url = url;
    focusTab(state, existing.id);
    return;
  }
  // Live Browser opens on the right, beside the agent building the app.
  const tab: Tab = { id: id(state, "t"), kind: "browser", title: "Browser", url };
  state.tabs[tab.id] = tab;
  if (state.frames.length < MAX_FRAMES) {
    const frame: Frame = { id: id(state, "f"), tabs: [tab.id], active: tab.id };
    state.frames.push(frame);
    state.focus = frame.id;
  } else {
    const last = state.frames[state.frames.length - 1] as Frame;
    last.tabs.push(tab.id);
    last.active = tab.id;
    state.focus = last.id;
  }
  state.surface = "code";
  state.maximized = false;
}

/** Opens the current workspace's canonical run and service context beside its coding terminals. */
export function openOperationsContext(state: State) {
  state.menu = null;
  const existing = Object.values(state.tabs).find((tab) => tab.widget === "operations");
  if (existing) {
    focusTab(state, existing.id);
    state.maximized = false;
    return;
  }
  state.contextTab = "runs";
  placeTab(state, {
    id: id(state, "t"),
    kind: "widget",
    widget: "operations",
    title: "Runs & services",
  });
}

export function openWidget(state: State, widget: "approvals" | "agents") {
  state.menu = null;
  placeTab(
    state,
    {
      id: id(state, "t"),
      kind: "widget",
      widget,
      title: widget === "approvals" ? "Needs your approval" : "Active agents",
    },
    false,
  );
}

export function closeTab(state: State, tabId: string) {
  const tab = state.tabs[tabId];
  if (!tab) return;
  delete state.tabs[tabId];
  if (tab.agent) {
    delete state.agents[tab.agent];
    state.order = state.order.filter((agentId) => agentId !== tab.agent);
  }
  for (const frame of state.frames) {
    if (!frame.tabs.includes(tabId)) continue;
    const index = frame.tabs.indexOf(tabId);
    frame.tabs.splice(index, 1);
    if (frame.active === tabId) frame.active = frame.tabs[Math.max(0, index - 1)] ?? "";
  }
  state.frames = state.frames.filter((frame) => frame.tabs.length > 0);
  if (!state.frames.some((frame) => frame.id === state.focus)) state.focus = state.frames[0]?.id ?? "";
  if (state.frames.length <= 1) state.maximized = false;
}

/** KalTidy "Stop idle terminals": idle shells close; agents and busy terminals stay. */
export function tidyIdle(state: State): { stopped: number; kept: number } {
  const idle = Object.values(state.tabs).filter((tab) => tab.kind === "terminal" && tab.idle);
  for (const tab of idle) closeTab(state, tab.id);
  const kept = Object.values(state.tabs).filter((tab) => tab.kind === "terminal").length;
  return { stopped: idle.length, kept };
}

/** KalTidy "Clear finished": finished agents' terminals close. */
export function tidyFinished(state: State): number {
  const done = agentsList(state).filter((agent) => agent.status === "done");
  for (const agent of done) {
    const tab = tabOfAgent(state, agent.id);
    if (tab) closeTab(state, tab);
  }
  return done.length;
}

export function answerApproval(state: State, agentId: string, approve: boolean) {
  const agent = state.agents[agentId];
  if (!agent?.approval) return;
  agent.approval = null;
  if (approve) {
    agent.lines.push(L("ok", "  ✓ Approved once"));
    agent.status = "working";
    agent.activity = "Installing zod";
  } else {
    agent.lines.push(L("err", "  ✗ Denied. Claude will validate without a new dependency."));
    agent.script = [
      {
        line: L("ok", "● Edit src/pages/Login.tsx  +24 −6"),
        status: "working",
        activity: "Writing validation by hand",
        files: 2,
      },
      {
        line: L("accent", "  Done, without new dependencies."),
        status: "done",
        activity: "Validation added",
        finished: "Claude C finished Login form validation",
      },
    ];
    agent.cursor = 0;
    agent.status = "working";
    agent.activity = "Writing validation by hand";
  }
}

/** A prompt typed into a fresh demo agent becomes a short, honest simulated run. */
export function promptAgent(state: State, agentId: string, text: string) {
  const agent = state.agents[agentId];
  const prompt = text.trim().slice(0, 160);
  if (!agent || !prompt) return;
  const claude = agent.provider === "claude";
  agent.prompt = false;
  agent.task = prompt.length > 42 ? `${prompt.slice(0, 40)}…` : prompt;
  agent.lines.push(L("in", `${claude ? ">" : "›"} ${prompt}`));
  agent.status = "working";
  agent.activity = "Reading the project";
  agent.cursor = 0;
  const t = claude ? "●" : "•";
  agent.script = [
    { line: L("tool", `${t} Read src/App.tsx, src/pages/Dashboard.tsx`), activity: "Reading the project" },
    { line: L("out", "  Planning the change…"), activity: "Planning" },
    { line: L("tool", `${t} Edit src/App.tsx  +12 −3`), activity: "Editing src/App.tsx", files: 1 },
    { line: L("tool", `${t} Bash pnpm test`), status: "testing", activity: "Running pnpm test" },
    { line: L("ok", "  ✓ 14 passed") },
    {
      line: L(
        "accent",
        "  Done — in this demo the work is simulated. In KalCode it's your real agent, on your own account.",
      ),
      status: "done",
      activity: "Done",
      finished: `${agent.sign} finished ${agent.task}`,
    },
  ];
}

/** The demo shell: a few honest canned commands. */
export function runShell(state: State, tabId: string, text: string) {
  const tab = state.tabs[tabId];
  const cmd = text.trim();
  if (!tab?.lines) return;
  tab.lines.push(L("dim", "PS ~/Projects/sample-app>"), L("in", cmd));
  const out = (t: string, k: LineKind = "out") => tab.lines?.push(L(k, t));
  if (!cmd) return;
  if (cmd === "clear" || cmd === "cls") {
    tab.lines = [];
  } else if (cmd === "help") {
    out("Demo shell commands: git status, git log, ls, pnpm test, pnpm build, pnpm dev, clear");
  } else if (cmd === "ls" || cmd === "dir") {
    out("node_modules  public  src  package.json  vite.config.ts  README.md");
  } else if (cmd.startsWith("git status")) {
    out("On branch main · ahead of origin/main by 1 commit");
    out("  modified:   src/pages/Dashboard.tsx", "warn");
    out("  modified:   src/components/StatCard.tsx", "warn");
    out("  new file:   src/components/RevenueChart.tsx", "ok");
  } else if (cmd.startsWith("git log")) {
    out("a41c9e2 (HEAD -> main) Add stat cards", "accent");
    out("7f20b1d Set up routing");
    out("0c33a5f Initial commit");
  } else if (cmd === "pnpm test" || cmd === "npm test") {
    out("  ✓ 14 passed (14) · 1.84s", "ok");
  } else if (cmd === "pnpm build" || cmd === "npm run build") {
    out("  ✓ built in 1.12s · dist/ 148 kB", "ok");
  } else if (cmd === "pnpm dev" || cmd === "npm run dev") {
    out(`  ➜  Local:   http://${DEV_URL}/`, "ok");
    tab.idle = false;
  } else {
    out(`demo shell: '${cmd.slice(0, 40)}' isn't available here. Try help.`, "dim");
  }
  if (cmd !== "pnpm dev") tab.idle = tab.idle ?? true;
}

export function toast(state: State, text: string, tone: Toast["tone"] = "info", agent?: string) {
  state.seq += 1;
  state.toast = { id: state.seq, text, tone, agent };
}

const NUDGES: Record<Nudge["id"], Nudge> = {
  "first-agent": {
    id: "first-agent",
    title: "Want to run this with your real Claude Code account?",
    body: "KalCode launches your own Claude Code and Codex, signed in with your accounts.",
    cta: "get",
  },
  "big-workspace": {
    id: "big-workspace",
    title: "Build this workspace for real.",
    body: "Same panes, your projects, your agents.",
    cta: "download",
  },
  voice: {
    id: "voice",
    title: "KalVoice runs on your device.",
    body: "Hold F8 in KalCode and speak. Dictation is unlimited on every plan.",
    cta: "download",
  },
  accounts: {
    id: "accounts",
    title: "Connect your own accounts.",
    body: "Sign in to Claude Code and Codex from KalCode. Your AI usage stays on your account.",
    cta: "account",
  },
};

/** Offer a conversion nudge once per visit, and never while the tour is running. */
export function nudge(state: State, which: Nudge["id"]) {
  if (state.tour !== null || state.nudged.includes(which) || state.nudge) return;
  state.nudged.push(which);
  state.nudge = NUDGES[which];
}

export function afterLaunch(state: State) {
  if (paneCount(state) >= BIG_WORKSPACE) nudge(state, "big-workspace");
}

// ── Simulation ──────────────────────────────────────────────────────────────────────────────

/** One tick of the live workspace: each working agent plays its next beat. */
export function tick(state: State): string[] {
  state.tick += 1;
  const finished: string[] = [];
  for (const agent of agentsList(state)) {
    if (agent.approval || (agent.prompt && agent.status !== "starting")) continue;
    if (agent.status === "done" || agent.status === "idle" || agent.status === "waiting_for_you") {
      if (agent.cursor >= agent.script.length) continue;
    }
    // Agents take turns so the workspace breathes rather than flickers.
    if ((state.tick + agent.id.length + agent.cursor) % 2 === 1 && agent.status !== "starting") continue;
    const beat = agent.script[agent.cursor];
    if (!beat) continue;
    agent.cursor += 1;
    if (beat.line) agent.lines.push(beat.line);
    if (beat.status) agent.status = beat.status;
    if (beat.activity) agent.activity = beat.activity;
    if (beat.files !== undefined) agent.files = beat.files;
    if (beat.preview !== undefined) state.preview = Math.max(state.preview, beat.preview);
    if (beat.approval) agent.approval = beat.approval;
    if (beat.finished) {
      finished.push(agent.id);
      toast(state, beat.finished, agent.status === "done" ? "done" : "waiting", agent.id);
    }
    if (agent.lines.length > 60) agent.lines.splice(2, agent.lines.length - 60);
  }
  if (state.tick % 30 === 0) for (const agent of agentsList(state)) if (isWorking(agent)) agent.minutes += 1;
  return finished;
}

// ── KalVoice ────────────────────────────────────────────────────────────────────────────────

/** Phrases the shipped KalVoice screen suggests (apps/desktop KalVoice surface). */
export const VOICE_PHRASES = [
  "Open Dashboard",
  "Open four Codex terminals",
  "What needs permission?",
  "Go to settings",
];

const NUMBERS: Record<string, number> = { one: 1, a: 1, an: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };

/**
 * A KalVoice command, interpreted the way the demo can honour it. Returns the spoken-style reply.
 * Free text that matches nothing gets an honest answer instead of a guess.
 */
export function runVoice(state: State, phrase: string): string {
  const p = phrase.toLowerCase().replace(/[.?!]/g, "").trim();
  const launchMatch = p.match(/(?:open|start|launch)\s+(\w+)?\s*(claude(?: code)?|codex)\s+(?:terminals?|agents?)/);
  if (launchMatch) {
    const provider: ProviderId = launchMatch[2]?.startsWith("codex") ? "codex" : "claude";
    const raw = launchMatch[1] ?? "one";
    const n = Math.min(MAX_AGENTS_PER_LAUNCH, NUMBERS[raw] ?? (Number(raw) || 1));
    openLauncher(state, provider);
    if (state.launcher) state.launcher.count = n;
    launch(state);
    afterLaunch(state);
    return `Opened ${n} ${PROVIDER_NAME[provider]} ${n === 1 ? "terminal" : "terminals"} in Code.`;
  }
  if (/permission|needs (me|you)|waiting/.test(p)) {
    const waiting = agentsList(state).filter(needsYou);
    if (waiting.length === 0) return "Nothing needs you right now.";
    jumpToNeeds(state);
    const first = waiting[0] as Agent;
    return `${first.sign} needs you: ${first.activity.toLowerCase()}.`;
  }
  if (/fleet|my agents|show (the )?agents/.test(p)) {
    go(state, "dashboard");
    return "Here's your Agent Fleet.";
  }
  if (/browser|preview/.test(p)) {
    openBrowser(state);
    return `Opened ${DEV_URL} in Live Browser.`;
  }
  if (/tidy|clean ?up|idle terminals/.test(p)) {
    const r = tidyIdle(state);
    return r.stopped
      ? `Stopped ${r.stopped} idle ${r.stopped === 1 ? "terminal" : "terminals"}.`
      : "No idle terminals to stop.";
  }
  for (const surface of SURFACES) {
    if (p.includes(surface.label.toLowerCase())) {
      go(state, surface.id);
      return `Opened ${surface.label}.`;
    }
  }
  if (p.includes("setting")) {
    go(state, "settings");
    return "Opened Settings.";
  }
  return "In this demo, try “Open Dashboard” or “Open four Codex terminals”.";
}
