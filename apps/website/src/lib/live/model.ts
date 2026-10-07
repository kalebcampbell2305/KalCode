/**
 * The live KalCode demo: its state, its sample workspace and every action a visitor can take.
 *
 * The demo mirrors the shipped desktop app (apps/desktop): the same shell (Command Deck top bar,
 * navigation bar, favorites, sidebar, Agents rail), the same Code panes and New agent launcher, the
 * one agent-state model every app surface uses (@kalcode/protocol agent-state: agentStateOf), the
 * same task-based names and the same plan roadmap (@kalcode/protocol/plans). It is temporary by
 * design: state lives in memory for this page view, and Reset (or a reload) returns to the sample.
 *
 * An AGENT is a real coding agent running in its own terminal pane in Code. It is never a thread.
 *
 * Pure module: no DOM. The Astro page renders the initial state at build time and the client
 * script (scripts/live/app.ts) runs the same functions in the browser.
 */
import {
  AGENT_FILTERS,
  AGENT_STATE_FILTER,
  type AgentFilter,
  type AgentState,
  agentStateOf,
  isAgentBusy,
  READY_ACTIVITY,
  type ThreadStatus,
} from "@kalcode/protocol";
import { getPlanFeature } from "@kalcode/protocol/plans";
import { type DemoMemory, initialMemory } from "./memory";

/** The four providers KalCode runs as native terminals (crates/providers/src/catalog.rs). */
export type ProviderId = "claude" | "codex" | "gemini" | "cursor";
export const PROVIDERS: readonly ProviderId[] = ["claude", "codex", "gemini", "cursor"];
export type Surface =
  | "dashboard"
  | "operations"
  | "kalvoice"
  | "code"
  | "threads"
  | "providers"
  | "memory"
  | "settings";
/** The runtime statuses the demo's agents move through (the protocol's ThreadStatus). */
export type AgentStatus = Extract<
  ThreadStatus,
  | "starting"
  | "active"
  | "testing"
  | "idle"
  | "waiting_for_permission"
  | "waiting_for_user"
  | "waiting_for_dependency"
  | "completed"
  | "failed"
  | "interrupted"
>;
export type OpsTab = "runs" | "queue" | "services" | "environments" | "activity";
export type ContextTab = "runs" | "services" | "tests";
export type FleetFilter = AgentFilter;
export type LineKind = "in" | "out" | "ok" | "tool" | "dim" | "warn" | "err" | "accent" | "head";
/** The modes a new coding agent can start in (desktop: DEFAULT_MODE_CHOICES). */
export type Mode = "bypass" | "plan";

export interface Line {
  k: LineKind;
  t: string;
}

export interface UsageWindow {
  label: string;
  left: number;
  resets: string;
}

const WEEKLY_WINDOW_LABEL = /^(weekly|7-day)$/i;
const isReportedUsage = (left: number) => Number.isFinite(left) && left >= 0 && left <= 100;

/**
 * The account's all-model weekly window. Compact demo surfaces mirror the desktop authority:
 * rolling, daily, monthly and model-scoped weekly limits never stand in for weekly remaining.
 */
export function weeklyWindow(account: Pick<Account, "windows">): UsageWindow | null {
  return (
    account.windows.find((window) => isReportedUsage(window.left) && WEEKLY_WINDOW_LABEL.test(window.label.trim())) ??
    null
  );
}

/** The tightest reported window is used only for launch recommendations, never primary usage. */
function limitingWindow(account: Pick<Account, "windows">): UsageWindow | null {
  return account.windows
    .filter((window) => isReportedUsage(window.left))
    .reduce<UsageWindow | null>((lowest, window) => (!lowest || window.left < lowest.left ? window : lowest), null);
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
  name: string;
  provider: ProviderId;
  account: string;
  model: string;
  effort: string;
  mode: Mode;
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
  /** Waits for this agent to stop working before its script continues. */
  after?: string;
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
  | "history"
  | "notifications"
  | "more"
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

/** A saved fast-access target (desktop: shell/favorites). Pins are global; favorites per workspace. */
export interface Favorite {
  key: string;
  scope: "pin" | "favorite";
  kind: "agent" | "terminal" | "browser" | "command" | "account";
  title: string;
  /** The demo action that opens it. */
  act: string;
}

export type VoiceState = "ready" | "listening" | "processing" | "executing" | "done";

export interface State {
  memory: DemoMemory;
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
  /** The pane whose close is waiting on Smart Close (Cancel / Keep Running / Stop and Close). */
  closing: string | null;
  /** The terminal-header account picker: which agent it is open for and the chosen account. */
  picker: { agent: string; choice: string | null } | null;
  mode: Mode;
  contextTab: ContextTab;
  opsTab: OpsTab;
  run: string | null;
  environment: Environment;
  fleet: FleetFilter;
  voice: { open: boolean; state: VoiceState; heard: string; reply: string };
  palette: { q: string; sel: number };
  toast: Toast | null;
  /** Everything KalCode told the visitor, newest first (the Notifications list). */
  notes: Toast[];
  unread: number;
  nudge: Nudge | null;
  nudged: string[];
  favorites: Favorite[];
  /** Back / Forward: visited locations ("dashboard", "code:<tab>") and where we are in them. */
  nav: { entries: string[]; index: number };
  preview: number;
  railOpen: boolean;
  /** Idle agents fold in the rail, as in the app. */
  idleOpen: boolean;
  mobile: boolean;
  tick: number;
  seq: number;
  tour: number | null;
  launches: number;
}

export type Environment = "Local" | "Preview" | "Staging" | "Production";
export const ENVIRONMENTS: readonly Environment[] = ["Local", "Preview", "Staging", "Production"];

export const PROVIDER_NAME: Record<ProviderId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  gemini: "Gemini CLI",
  cursor: "Cursor",
};

/**
 * Model and effort choices exactly as the desktop launcher lists them (crates/providers/src/catalog.rs
 * and apps/desktop/src/surfaces/code/panes/agentLaunch.ts). The first model is the account or
 * provider default; Codex and Cursor report theirs from the account, so the demo offers the default.
 * Gemini CLI and Cursor take no effort.
 */
export const MODELS: Record<ProviderId, readonly string[]> = {
  claude: ["Account default", "Opus", "Sonnet", "Haiku", "Fable"],
  codex: ["Default"],
  gemini: ["Auto (default)", "Pro", "Flash", "Flash-Lite"],
  cursor: ["Default"],
};
export const EFFORTS: Record<ProviderId, readonly string[]> = {
  claude: ["Default", "Low", "Medium", "High", "Extra high", "Max"],
  codex: ["Default", "Minimal", "Low", "Medium", "High", "Extra high"],
  gemini: [],
  cursor: [],
};
/** The most agents one launch starts (desktop agentLaunch.ts). Local agents are unlimited on every plan. */
export const MAX_AGENTS_PER_LAUNCH = 10;
/** Past this many panes the demo suggests building the workspace for real. */
const BIG_WORKSPACE = 7;
export const WORKSPACE = { name: "sample-app", path: "~/Projects/sample-app", branch: "main", ahead: 1, changed: 3 };
export const DEV_URL = "localhost:3000";

export const MODE_LABEL: Record<Mode, string> = { bypass: "Bypass", plan: "Plan" };
/** The desktop's own words (apps/desktop/src/surfaces/permissions/labels.ts MODE_DESCRIPTIONS). */
export const MODE_DESCRIPTION: Record<Mode, string> = {
  bypass:
    "Recommended. Coding agents work without approval prompts: edits, commands, tests, builds, Git, pushes and dev servers just run. Only access to credentials and secrets still asks.",
  plan: "Read and plan only. Anything that changes files, runs commands or reaches out is refused.",
};

export const SURFACES: readonly { id: Surface; label: string; icon: string; hint: string }[] = [
  {
    id: "code",
    label: "Code",
    icon: "code",
    hint: "Where your coding agents run, each in its own terminal.",
  },
  {
    id: "dashboard",
    label: "Activity",
    icon: "activity",
    hint: "Mission control: what needs you, what's working and what finished.",
  },
  {
    id: "operations",
    label: "Operations",
    icon: "operations",
    hint: "Runs, Queue, Services, Environments and Activity.",
  },
  { id: "kalvoice", label: "KalVoice", icon: "kalvoice", hint: "Control KalCode by voice." },
  {
    id: "threads",
    label: "Threads",
    icon: "threads",
    hint: "Persistent units of AI work. Coding agents run in Code.",
  },
  {
    id: "memory",
    label: "Unified Memory",
    icon: "memory",
    hint: "Useful project knowledge, shared across agents and sessions.",
  },
  {
    id: "providers",
    label: "Providers",
    icon: "providers",
    hint: "Claude Code, Codex, Gemini CLI and Cursor, on your own accounts.",
  },
];

/**
 * The sidebar's primary places, as in the app: Code and Activity, with the Projects list beneath
 * them. Every other surface sits in the footer's More menu.
 */
export const PRIMARY_SURFACES: readonly Surface[] = ["code", "dashboard"];

// ── Agent state: the one model every surface uses ───────────────────────────────────────────

/** The agent's state, from its runtime facts, exactly as the app computes it (never by provider). */
export function agentState(agent: Pick<Agent, "status" | "activity" | "approval">): AgentState {
  return agentStateOf({
    status: agent.status,
    currentActivity: agent.activity,
    pendingApprovals: agent.approval ? 1 : 0,
  });
}
/** The filter group an agent belongs to (Needs you, Working, Waiting, Idle, Done, Failed). */
export function agentFilter(agent: Agent): Exclude<AgentFilter, "all"> {
  return AGENT_STATE_FILTER[agentState(agent)];
}
export function needsYou(agent: Agent): boolean {
  return agentState(agent) === "needs_you";
}
/** A launch or turn is in progress. */
export function isWorking(agent: Agent): boolean {
  return isAgentBusy(agentState(agent));
}
export function isDone(agent: Agent): boolean {
  return agentFilter(agent) === "done";
}
/** The model a pane header and card show: the default reads as the default. */
export function modelLabel(agent: Pick<Agent, "provider" | "model">): string {
  return agent.model === MODELS[agent.provider][0] ? "Default model" : agent.model;
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
      plan: "Team",
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
    {
      id: "gemini-personal",
      provider: "gemini",
      name: "Personal",
      plan: "Google AI Pro",
      isDefault: true,
      windows: [{ label: "Daily", left: 88, resets: "Resets at midnight" }],
    },
    {
      id: "cursor-studio",
      provider: "cursor",
      name: "Studio",
      plan: "Pro",
      isDefault: true,
      windows: [{ label: "Monthly", left: 71, resets: "Resets on the 1st" }],
    },
  ];
}

/** Prompt and tool marks each provider's own terminal prints. */
const PROMPT_MARK: Record<ProviderId, string> = { claude: ">", codex: "›", gemini: ">", cursor: "→" };
const TOOL_MARK: Record<ProviderId, string> = { claude: "●", codex: "•", gemini: "✦", cursor: "•" };
export function promptMark(provider: ProviderId): string {
  return PROMPT_MARK[provider];
}
export function workMark(provider: ProviderId): string {
  return provider === "claude" ? "✻" : TOOL_MARK[provider];
}

function header(provider: ProviderId, model: string, effort: string, account: string): Line[] {
  const head: Record<ProviderId, string> = { claude: "✻", codex: ">_", gemini: "✦", cursor: "⬢" };
  const parts = [`${head[provider]} ${PROVIDER_NAME[provider]}`];
  parts.push(model === MODELS[provider][0] ? "default model" : model);
  if (effort && effort !== "Default") parts.push(`${effort.toLowerCase()} effort`);
  return [L("head", parts.join(" · ")), L("dim", `  ${WORKSPACE.path} · ${account}`)];
}

function sampleAgents(): Agent[] {
  return [
    {
      id: "a1",
      name: "Dashboard Redesign",
      provider: "claude",
      account: "claude-personal",
      model: "Opus",
      effort: "High",
      mode: "bypass",
      status: "active",
      activity: "Editing src/pages/Dashboard.tsx",
      branch: "agent/dashboard-redesign",
      minutes: 12,
      files: 4,
      cursor: 0,
      approval: null,
      prompt: false,
      lines: [
        ...header("claude", "Opus", "High", "Personal"),
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
          line: L("accent", "  Done. Want me to keep the old chart colours or switch to the new palette?"),
          status: "waiting_for_user",
          activity: "Asked which chart palette to keep",
          finished: "Dashboard Redesign is asking you a question",
        },
      ],
    },
    {
      id: "a2",
      name: "Dashboard Tests",
      provider: "codex",
      account: "codex-personal",
      model: "Default",
      effort: "Medium",
      mode: "bypass",
      status: "testing",
      activity: "Running pnpm test",
      branch: "agent/tests",
      minutes: 4,
      files: 3,
      cursor: 0,
      approval: null,
      prompt: false,
      lines: [
        ...header("codex", "Default", "Medium", "Personal"),
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
          status: "active",
          activity: "Fixing a failing test",
        },
        { line: L("tool", "• Edited src/components/StatCard.test.tsx  +4 −3"), files: 4 },
        { line: L("tool", "• Running pnpm test"), status: "testing", activity: "Running pnpm test" },
        { line: L("ok", "  ✓ 14 passed (14)") },
        {
          line: L("accent", "  All 14 tests pass."),
          status: "completed",
          activity: "14 tests passed",
          finished: "Dashboard Tests finished · 14 passed",
        },
      ],
    },
    {
      id: "a3",
      name: "Code Review",
      provider: "claude",
      account: "claude-work",
      model: "Sonnet",
      effort: "Default",
      mode: "plan",
      status: "completed",
      activity: "Review complete · 2 suggestions",
      branch: "agent/review",
      minutes: 18,
      files: 0,
      cursor: 0,
      approval: null,
      prompt: false,
      lines: [
        ...header("claude", "Sonnet", "Default", "Work"),
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
      name: "Payments Webhook",
      provider: "claude",
      account: "claude-personal",
      model: "Sonnet",
      effort: "Medium",
      mode: "bypass",
      status: "waiting_for_permission",
      activity: "Wants to read STRIPE_SECRET_KEY",
      branch: "agent/payments-webhook",
      minutes: 2,
      files: 1,
      cursor: 0,
      // Bypass runs edits, commands, installs and pushes without asking. Secrets still ask.
      approval: {
        title: "Read a secret",
        command: "STRIPE_SECRET_KEY · .env.local",
        reason: "Accessing credentials and secrets · always asks, even in Bypass",
      },
      prompt: false,
      lines: [
        ...header("claude", "Sonnet", "Medium", "Personal"),
        L("in", "> Verify Stripe webhooks for paid orders"),
        L("tool", "● Read src/api/orders.ts"),
        L("ok", "● Bash pnpm add stripe  + stripe 19.1.0"),
        L("out", "  I need the webhook signing secret to verify events."),
        L("warn", "● Read .env.local (STRIPE_SECRET_KEY) — waiting for you"),
      ],
      script: [
        { line: L("tool", "● Write src/api/stripeWebhook.ts  +54"), activity: "Writing stripeWebhook.ts", files: 2 },
        { line: L("tool", "● Bash pnpm test webhook"), status: "testing", activity: "Running pnpm test" },
        { line: L("ok", "  ✓ 6 passed (6)") },
        {
          line: L("accent", "  Done. Paid orders are confirmed by signed Stripe webhooks."),
          status: "completed",
          activity: "Webhook verified",
          finished: "Payments Webhook finished",
        },
      ],
    },
    {
      id: "a5",
      name: "README Screenshots",
      provider: "gemini",
      account: "gemini-personal",
      model: "Auto (default)",
      effort: "",
      mode: "bypass",
      status: "waiting_for_dependency",
      activity: "Waiting for Dashboard Redesign",
      branch: "agent/readme-shots",
      minutes: 1,
      files: 0,
      cursor: 0,
      approval: null,
      prompt: false,
      after: "a1",
      lines: [
        ...header("gemini", "Auto (default)", "", "Personal"),
        L("in", "> Refresh the README screenshots once the dashboard redesign lands"),
        L("tool", "✦ Read README.md"),
        L("dim", "  Waiting for Dashboard Redesign to finish."),
      ],
      script: [
        {
          line: L("tool", "✦ Open http://localhost:3000 in a headless browser"),
          status: "active",
          activity: "Capturing the dashboard",
          preview: 3,
        },
        { line: L("tool", "✦ Write docs/dashboard.png"), files: 1 },
        { line: L("ok", "✦ Edit README.md  +3 −3"), files: 2 },
        {
          line: L("accent", "  Updated the README screenshots."),
          status: "completed",
          activity: "Screenshots updated",
          finished: "README Screenshots finished",
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

function sampleFavorites(): Favorite[] {
  return [
    { key: "pin-browser", scope: "pin", kind: "browser", title: DEV_URL, act: "browser" },
    { key: "pin-account", scope: "pin", kind: "account", title: "Claude Code · Personal", act: "menu:accounts" },
    { key: "fav-t-a1", scope: "favorite", kind: "agent", title: "Dashboard Redesign", act: "tab:t-a1" },
    { key: "fav-t-ps", scope: "favorite", kind: "terminal", title: "dev server", act: "tab:t-ps" },
    { key: "fav-cmd-test", scope: "favorite", kind: "command", title: "pnpm test", act: "fav-run:pnpm test" },
  ];
}

export function initialState(): State {
  const agents = sampleAgents();
  const state: State = {
    surface: "code",
    frames: [
      { id: "f1", tabs: ["t-a1", "t-a3"], active: "t-a1" },
      { id: "f2", tabs: ["t-a2", "t-a4"], active: "t-a2" },
      { id: "f3", tabs: ["t-ps", "t-a5"], active: "t-ps" },
    ],
    tabs: {
      "t-a1": { id: "t-a1", kind: "agent", agent: "a1", title: "Dashboard Redesign" },
      "t-a3": { id: "t-a3", kind: "agent", agent: "a3", title: "Code Review" },
      "t-a2": { id: "t-a2", kind: "agent", agent: "a2", title: "Dashboard Tests" },
      "t-a4": { id: "t-a4", kind: "agent", agent: "a4", title: "Payments Webhook" },
      "t-ps": { id: "t-ps", kind: "terminal", title: "PowerShell · dev server", lines: DEV_SERVER_LINES.slice() },
      "t-a5": { id: "t-a5", kind: "agent", agent: "a5", title: "README Screenshots" },
    },
    agents: Object.fromEntries(agents.map((agent) => [agent.id, agent])),
    order: agents.map((agent) => agent.id),
    accounts: accounts(),
    focus: "f1",
    maximized: false,
    layout: "auto",
    menu: null,
    launcher: null,
    closing: null,
    picker: null,
    mode: "bypass",
    contextTab: "runs",
    opsTab: "runs",
    run: null,
    environment: "Local",
    fleet: "all",
    voice: { open: false, state: "ready", heard: "", reply: "" },
    palette: { q: "", sel: 0 },
    toast: null,
    notes: [
      { id: 2, text: "Code Review finished · 2 suggestions", tone: "done", agent: "a3" },
      { id: 1, text: "Payments Webhook needs you: read a secret", tone: "waiting", agent: "a4" },
    ],
    unread: 1,
    nudge: null,
    nudged: [],
    favorites: sampleFavorites(),
    nav: { entries: ["code:t-a1"], index: 0 },
    preview: 0,
    railOpen: true,
    idleOpen: false,
    mobile: false,
    tick: 0,
    seq: 10,
    tour: null,
    launches: 0,
    memory: initialMemory(),
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
/** The tab the visitor is looking at in Code. */
export function focusedTab(state: State): Tab | undefined {
  const frame = state.frames.find((f) => f.id === state.focus);
  return frame ? state.tabs[frame.active] : undefined;
}

export interface Counts {
  agents: number;
  needs: number;
  working: number;
  waiting: number;
  idle: number;
  done: number;
  failed: number;
}
/** Counts per filter, over agents of every provider (protocol agentCounts). */
export function counts(state: State): Counts {
  const c: Counts = { agents: 0, needs: 0, working: 0, waiting: 0, idle: 0, done: 0, failed: 0 };
  for (const agent of agentsList(state)) {
    c.agents += 1;
    const filter = agentFilter(agent);
    if (filter === "needs_you") c.needs += 1;
    else c[filter] += 1;
  }
  return c;
}
/** Agents in one filter group. */
export function agentsIn(state: State, filter: FleetFilter): Agent[] {
  const list = agentsList(state);
  return filter === "all" ? list : list.filter((agent) => agentFilter(agent) === filter);
}
export { AGENT_FILTERS };

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
    .map((agent) => {
      const filter = agentFilter(agent);
      return {
        id: `run-${agent.id}`,
        name: agent.name,
        kind: "agent",
        where: `${WORKSPACE.name} · ${agent.branch} · ${PROVIDER_NAME[agent.provider]} · ${accountLabel(state, agent.account)}`,
        action: agent.activity,
        status:
          filter === "needs_you"
            ? "Blocked"
            : filter === "done"
              ? "Succeeded"
              : filter === "failed"
                ? "Failed"
                : filter === "idle" || filter === "waiting"
                  ? "Queued"
                  : "Running",
        duration: `${agent.minutes}m ${String((state.tick * 7) % 60).padStart(2, "0")}s`,
        agent: agent.id,
      };
    });
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
      const fresh: Frame = { id: id(state, "f"), tabs: [tab.id], active: tab.id };
      state.frames.push(fresh);
      state.focus = fresh.id;
    } else {
      frame.tabs.push(tab.id);
      frame.active = tab.id;
      state.focus = frame.id;
    }
  }
  state.surface = "code";
  state.maximized = false;
}

/** Every floating layer at once: menus, the launcher, KalVoice, Smart Close and the account picker. */
export function closeOverlays(state: State) {
  state.menu = null;
  state.launcher = null;
  state.closing = null;
  state.picker = null;
  state.voice.open = false;
}

export function go(state: State, surface: Surface) {
  closeOverlays(state);
  state.surface = surface;
}

export function focusTab(state: State, tabId: string) {
  const frame = frameOfTab(state, tabId);
  if (!frame) return;
  frame.active = tabId;
  state.focus = frame.id;
  state.surface = "code";
}

/** Opens an agent's terminal. An agent kept running after its pane closed gets a pane again. */
export function focusAgent(state: State, agentId: string) {
  const agent = state.agents[agentId];
  if (!agent) return;
  const tab = tabOfAgent(state, agentId);
  if (tab) focusTab(state, tab);
  else placeTab(state, { id: `t-${agentId}`, kind: "agent", agent: agentId, title: agent.name });
}

/** Needs You: jump to the first agent that is waiting on the visitor. */
/** One Needs You item, exactly as the app's inbox words it: what happened, why, what next. */
export interface AttentionItem {
  agent: string;
  tone: "waiting" | "failed";
  source: string;
  what: string;
  why: string;
  action: string;
}

/** What genuinely needs the visitor: questions, approvals and failures. Ordinary progress never. */
export function attentionItems(state: State): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const agent of agentsList(state)) {
    const s = agentState(agent);
    const source = `${PROVIDER_NAME[agent.provider]} · ${agent.name}`;
    if (s === "needs_you") {
      items.push(
        agent.approval
          ? {
              agent: agent.id,
              tone: "waiting",
              source,
              what: "Needs your permission",
              why: agent.approval.title,
              action: "Open agent",
            }
          : {
              agent: agent.id,
              tone: "waiting",
              source,
              what: "Asked you a question",
              why: agent.activity,
              action: "Open agent",
            },
      );
    } else if (s === "failed") {
      items.push({
        agent: agent.id,
        tone: "failed",
        source,
        what: "Failed",
        why: agent.activity,
        action: "Open agent",
      });
    }
  }
  return items;
}

export function jumpToNeeds(state: State): boolean {
  const agent = agentsList(state).find(needsYou);
  if (!agent) return false;
  closeOverlays(state);
  focusAgent(state, agent.id);
  return true;
}

// ── Navigation: Back / Forward and the breadcrumb ──────────────────────────────────────────

/** Where the visitor is: a page, or a tab in Code. */
export function locationOf(state: State): string {
  if (state.surface !== "code") return state.surface;
  const tab = focusedTab(state);
  return tab ? `code:${tab.id}` : "code";
}

/** Records a visit after an action, dropping any forward history (like a browser). */
export function recordVisit(state: State) {
  const here = locationOf(state);
  const { entries, index } = state.nav;
  if (entries[index] === here) return;
  const next = entries.slice(0, index + 1);
  next.push(here);
  state.nav = { entries: next.slice(-30), index: Math.min(next.length, 30) - 1 };
}

function restore(state: State, location: string): boolean {
  if (location.startsWith("code:")) {
    const tabId = location.slice(5);
    if (!state.tabs[tabId]) return false;
    closeOverlays(state);
    focusTab(state, tabId);
    return true;
  }
  go(state, location as Surface);
  return true;
}

/** Back (Alt ←) or Forward (Alt →). Visits whose pane has closed are skipped. */
export function navStep(state: State, delta: -1 | 1): boolean {
  let index = state.nav.index + delta;
  while (index >= 0 && index < state.nav.entries.length) {
    if (restore(state, state.nav.entries[index] as string)) {
      state.nav.index = index;
      return true;
    }
    index += delta;
  }
  return false;
}
export function canNav(state: State, delta: -1 | 1): boolean {
  const index = state.nav.index + delta;
  return index >= 0 && index < state.nav.entries.length;
}
/** Jumps to one entry of Recent navigation. */
export function navTo(state: State, index: number) {
  const location = state.nav.entries[index];
  if (location && restore(state, location)) state.nav.index = index;
}
export function locationLabel(state: State, location: string): string {
  if (location.startsWith("code:")) {
    const tab = state.tabs[location.slice(5)];
    if (!tab) return "Closed pane";
    return tab.agent ? (state.agents[tab.agent]?.name ?? tab.title) : tab.title;
  }
  if (location === "settings") return "Settings";
  return SURFACES.find((s) => s.id === location)?.label ?? "Code";
}

// ── Launching ───────────────────────────────────────────────────────────────────────────────

function defaultAccount(state: State, provider: ProviderId): Account | undefined {
  return (
    state.accounts.find((a) => a.provider === provider && a.isDefault) ??
    state.accounts.find((a) => a.provider === provider)
  );
}

export function openLauncher(state: State, provider: ProviderId = "claude") {
  const account = defaultAccount(state, provider);
  closeOverlays(state);
  state.launcher = {
    provider,
    account: account?.id ?? "",
    model: MODELS[provider][0] as string,
    effort: EFFORTS[provider].length ? "Default" : "",
    count: 1,
  };
}

export function chooseAccount(state: State, accountId: string) {
  const account = accountOf(state, accountId);
  if (!state.launcher || !account) return;
  const changed = account.provider !== state.launcher.provider;
  state.launcher.account = accountId;
  state.launcher.provider = account.provider;
  if (changed) {
    state.launcher.model = MODELS[account.provider][0] as string;
    state.launcher.effort = EFFORTS[account.provider].length ? "Default" : "";
  }
}

/** A low account (under 20% left) and a same-provider account with more room: the app's suggestion. */
export function accountSuggestion(state: State, accountId: string): Account | null {
  const account = accountOf(state, accountId);
  const left = account ? limitingWindow(account)?.left : null;
  if (!account || left == null || left >= 20) return null;
  return (
    state.accounts
      .filter((a) => a.provider === account.provider && a.id !== account.id)
      .sort((a, b) => (limitingWindow(b)?.left ?? -1) - (limitingWindow(a)?.left ?? -1))[0] ?? null
  );
}

/** Taskless agents use the desktop runtime's clean provider name ("Gemini CLI" becomes "Gemini"). */
function providerAgentName(provider: ProviderId): string {
  return PROVIDER_NAME[provider].replace(/ CLI$/, "");
}

function freshAgent(state: State, spec: Launcher, mode: Mode): Agent {
  const account = accountLabel(state, spec.account);
  const agentId = id(state, "a");
  return {
    id: agentId,
    name: providerAgentName(spec.provider),
    provider: spec.provider,
    account: spec.account,
    model: spec.model,
    effort: spec.effort,
    mode,
    status: "starting",
    activity: "Starting",
    branch: `agent/${agentId}`,
    minutes: 0,
    files: 0,
    cursor: 0,
    approval: null,
    prompt: true,
    lines: header(spec.provider, spec.model, spec.effort, account),
    script: [{ status: "idle", activity: READY_ACTIVITY, line: L("dim", "  Type a prompt below and press Enter.") }],
  };
}

/** Launch: N agents = N coding terminals, exactly like the desktop's New agent launcher. */
export function launch(state: State): string[] {
  const l = state.launcher;
  if (!l) return [];
  const created: string[] = [];
  const count = Math.max(1, Math.min(MAX_AGENTS_PER_LAUNCH, l.count));
  for (let i = 0; i < count; i++) {
    const agent = freshAgent(state, l, state.mode);
    state.agents[agent.id] = agent;
    state.order.push(agent.id);
    placeTab(state, { id: `t-${agent.id}`, kind: "agent", agent: agent.id, title: agent.name });
    created.push(agent.id);
  }
  state.launcher = null;
  state.launches += created.length;
  return created;
}

/**
 * "New like this": a fresh coding session with the same provider, account (or the one chosen in the
 * header account picker), model, effort and permissions. The source keeps running in its pane.
 */
export function newLikeThis(state: State, agentId: string, accountId?: string): string | null {
  const source = state.agents[agentId];
  if (!source) return null;
  const sourceTab = tabOfAgent(state, agentId);
  if (sourceTab) {
    const frame = frameOfTab(state, sourceTab);
    if (frame) state.focus = frame.id;
  }
  const spec: Launcher = {
    provider: source.provider,
    account: accountId ?? source.account,
    model: source.model,
    effort: source.effort,
    count: 1,
  };
  const agent = freshAgent(state, spec, source.mode);
  state.agents[agent.id] = agent;
  state.order.push(agent.id);
  placeTab(state, { id: `t-${agent.id}`, kind: "agent", agent: agent.id, title: agent.name });
  state.launches += 1;
  return agent.id;
}

export function openTerminal(state: State) {
  closeOverlays(state);
  placeTab(state, {
    id: id(state, "t"),
    kind: "terminal",
    title: "PowerShell",
    idle: true,
    lines: [L("dim", "PowerShell 7.5 · demo shell"), L("dim", "Try: git status, pnpm test, ls, help")],
  });
}

export function openBrowser(state: State, url = DEV_URL) {
  closeOverlays(state);
  const existing = Object.values(state.tabs).find((tab) => tab.kind === "browser");
  if (existing) {
    existing.url = url;
    focusTab(state, existing.id);
    state.maximized = false;
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
  closeOverlays(state);
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
  closeOverlays(state);
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

/** Removes a pane. Its agent, if any, keeps running in the background (Smart Close: Keep Running). */
export function detachTab(state: State, tabId: string) {
  const tab = state.tabs[tabId];
  if (!tab) return;
  delete state.tabs[tabId];
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

/** Closes a pane and ends what ran in it (Smart Close: Stop and Close). */
export function closeTab(state: State, tabId: string) {
  const tab = state.tabs[tabId];
  if (!tab) return;
  detachTab(state, tabId);
  if (tab.agent) {
    delete state.agents[tab.agent];
    state.order = state.order.filter((agentId) => agentId !== tab.agent);
    state.favorites = state.favorites.filter((f) => f.act !== `tab:${tabId}`);
  }
}

/** Whether closing this pane would interrupt work: a busy or waiting agent, or a running command. */
export function hasActiveWork(state: State, tabId: string): boolean {
  const tab = state.tabs[tabId];
  if (!tab) return false;
  if (tab.agent) {
    const agent = state.agents[tab.agent];
    if (!agent) return false;
    const filter = agentFilter(agent);
    return filter === "working" || filter === "needs_you" || filter === "waiting";
  }
  return tab.kind === "terminal" && !tab.idle;
}

/** Smart Close: closing active work asks first; anything else closes at once. */
export function requestClose(state: State, tabId: string) {
  closeOverlays(state);
  if (hasActiveWork(state, tabId)) state.closing = tabId;
  else closeTab(state, tabId);
}
export function resolveClose(state: State, choice: "cancel" | "keep" | "stop") {
  const tabId = state.closing;
  state.closing = null;
  if (!tabId || choice === "cancel") return;
  const tab = state.tabs[tabId];
  if (choice === "keep") {
    detachTab(state, tabId);
    if (tab)
      toast(
        state,
        `${tab.agent ? (state.agents[tab.agent]?.name ?? tab.title) : tab.title} keeps running.`,
        "info",
        tab.agent,
      );
  } else {
    closeTab(state, tabId);
  }
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
  const done = agentsList(state).filter(isDone);
  for (const agent of done) {
    const tab = tabOfAgent(state, agent.id);
    if (tab) closeTab(state, tab);
    else {
      delete state.agents[agent.id];
      state.order = state.order.filter((agentId) => agentId !== agent.id);
    }
  }
  return done.length;
}

export function answerApproval(state: State, agentId: string, approve: boolean) {
  const agent = state.agents[agentId];
  if (!agent?.approval) return;
  agent.approval = null;
  agent.cursor = 0;
  if (approve) {
    agent.lines.push(L("ok", "  ✓ Allowed once"));
    agent.status = "active";
    agent.activity = "Verifying webhook signatures";
  } else {
    agent.lines.push(L("err", "  ✗ Denied. The secret stays private; Claude will leave a placeholder."));
    agent.script = [
      {
        line: L("ok", "● Write src/api/stripeWebhook.ts  +48 (reads process.env.STRIPE_SECRET_KEY)"),
        status: "active",
        activity: "Writing stripeWebhook.ts",
        files: 2,
      },
      {
        line: L("accent", "  Done. Add STRIPE_SECRET_KEY to .env.local and the webhook verifies events."),
        status: "completed",
        activity: "Webhook added",
        finished: "Payments Webhook finished",
      },
    ];
    agent.status = "active";
    agent.activity = "Writing without the secret";
  }
}

/** The app's task name for a first prompt: a few meaningful words, title-cased. */
export function taskName(prompt: string): string {
  const samples: Record<string, string> = {
    "add a dark mode toggle": "Dark Mode Toggle",
    "write tests for login": "Login Tests",
    "fix the failing build": "Build Repair",
  };
  const known = samples[prompt.trim().toLowerCase()];
  if (known) return known;
  const skip = new Set(["a", "an", "the", "to", "for", "of", "and", "please", "can", "you", "my", "in", "on", "with"]);
  const words = prompt
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .filter((word) => word && !skip.has(word.toLowerCase()))
    .slice(0, 4);
  if (!words.length) return "Project Update";
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(" ");
}

/** A prompt typed into a fresh demo agent becomes a short, honest simulated run. */
export function promptAgent(state: State, agentId: string, text: string) {
  const agent = state.agents[agentId];
  const prompt = text.trim().slice(0, 160);
  if (!agent || !prompt) return;
  if (agent.prompt) {
    agent.name = taskName(prompt);
    const tab = tabOfAgent(state, agent.id);
    if (tab && state.tabs[tab]) state.tabs[tab].title = agent.name;
  }
  agent.prompt = false;
  agent.lines.push(L("in", `${PROMPT_MARK[agent.provider]} ${prompt}`));
  agent.status = "active";
  agent.activity = "Reading the project";
  agent.cursor = 0;
  const t = TOOL_MARK[agent.provider];
  if (agent.mode === "plan") {
    agent.script = [
      { line: L("tool", `${t} Read src/App.tsx, src/pages/Dashboard.tsx`), activity: "Reading the project" },
      { line: L("out", "  Plan mode is read-only. Here is the plan:"), activity: "Planning" },
      { line: L("out", "  1. Add the change in src/App.tsx  2. Cover it with a test") },
      {
        line: L("accent", "  Plan ready. Switch to Bypass to let the agent make it."),
        status: "waiting_for_user",
        activity: "Plan ready for your review",
        finished: `${agent.name}: plan ready`,
      },
    ];
    return;
  }
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
      status: "completed",
      activity: "Done",
      finished: `${agent.name} finished`,
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

/** Runs a saved command in a fresh terminal (a command favorite). */
export function runCommand(state: State, command: string) {
  openTerminal(state);
  const tab = focusedTab(state);
  if (tab) runShell(state, tab.id, command);
}

export function toast(state: State, text: string, tone: Toast["tone"] = "info", agent?: string) {
  state.seq += 1;
  const entry: Toast = { id: state.seq, text, tone, agent };
  state.toast = entry;
  state.notes = [entry, ...state.notes].slice(0, 8);
  state.unread += 1;
}

// ── Favorites and pins ──────────────────────────────────────────────────────────────────────

export function favoriteKey(scope: Favorite["scope"], tabId: string): string {
  return `${scope === "pin" ? "pin" : "fav"}-${tabId}`;
}
export function isSaved(state: State, scope: Favorite["scope"], tabId: string): boolean {
  return state.favorites.some((f) => f.key === favoriteKey(scope, tabId));
}
/** Add Favorite / Pin globally, or remove it again (desktop: FavoriteActions). */
export function toggleFavorite(state: State, tabId: string, scope: Favorite["scope"]) {
  const key = favoriteKey(scope, tabId);
  if (state.favorites.some((f) => f.key === key)) {
    state.favorites = state.favorites.filter((f) => f.key !== key);
    return;
  }
  const tab = state.tabs[tabId];
  if (!tab) return;
  const title = tab.agent ? (state.agents[tab.agent]?.name ?? tab.title) : tab.title;
  const kind: Favorite["kind"] = tab.kind === "agent" ? "agent" : tab.kind === "browser" ? "browser" : "terminal";
  state.favorites.push({ key, scope, kind, title, act: `tab:${tabId}` });
}

const NUDGES: Record<Nudge["id"], Nudge> = {
  "first-agent": {
    id: "first-agent",
    title: "Run this with your real accounts.",
    body: "KalCode launches your own Claude Code, Codex, Gemini CLI and Cursor, signed in as you.",
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
    body: "Sign in to each provider from KalCode. Your AI usage stays on your account.",
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
    if (agent.cursor >= agent.script.length) continue;
    // A waiting agent starts when the agent it depends on stops working.
    const dependency = agent.after ? state.agents[agent.after] : undefined;
    if (dependency && isWorking(dependency)) continue;
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
      toast(state, beat.finished, isDone(agent) ? "done" : "waiting", agent.id);
    }
    if (agent.lines.length > 60) agent.lines.splice(2, agent.lines.length - 60);
  }
  if (state.tick % 30 === 0) for (const agent of agentsList(state)) if (isWorking(agent)) agent.minutes += 1;
  return finished;
}

// ── KalVoice ────────────────────────────────────────────────────────────────────────────────

/** Phrases the shipped KalVoice screen suggests (apps/desktop KalVoice surface). */
export const VOICE_PHRASES = ["Open Activity", "Open four Codex terminals", "What needs permission?", "Go to settings"];

const NUMBERS: Record<string, number> = {
  one: 1,
  a: 1,
  an: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

/**
 * A KalVoice command, interpreted the way the demo can honour it. Returns the spoken-style reply.
 * Free text that matches nothing gets an honest answer instead of a guess.
 */
export function runVoice(state: State, phrase: string): string {
  const p = phrase.toLowerCase().replace(/[.?!]/g, "").trim();
  const launchMatch = p.match(
    /(?:open|start|launch)\s+(\w+)?\s*(claude(?: code)?|codex|gemini(?: cli)?|cursor)\s+(?:terminals?|agents?)/,
  );
  if (launchMatch) {
    const word = launchMatch[2] ?? "";
    const provider: ProviderId = word.startsWith("codex")
      ? "codex"
      : word.startsWith("gemini")
        ? "gemini"
        : word.startsWith("cursor")
          ? "cursor"
          : "claude";
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
    return `${first.name} needs you: ${first.activity.charAt(0).toLowerCase()}${first.activity.slice(1)}.`;
  }
  if (/\bdashboard\b|mission control/.test(p)) {
    // The app's Dashboard is now Activity; the old word still gets you there.
    go(state, "dashboard");
    return "Opened Activity.";
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
  return "In this demo, try “Open Activity” or “Open four Codex terminals”.";
}
