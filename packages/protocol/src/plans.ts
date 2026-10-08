/**
 * The single source of truth for KalCode plans, prices, plan limits and the plan roadmap.
 *
 * Website pricing, checkout, the account page, Account Hub, settings, onboarding, the signed
 * server entitlement and every native limit check derive from this module. No component may
 * hardcode a price, a plan name, a limit or a feature's plan. Native mirrors (Rust) carry a test
 * that reads this file and fails on drift. Paid access is authorized by the backend entitlement
 * service (server-authoritative); this module describes the catalog.
 *
 * Owner policy (AGENTS.md "KalCode pricing and plan roadmap"):
 * - Free = TRY, Pro = BUILD, MAX = ORCHESTRATE, MAX 2X = AUTOMATE.
 * - Prices, limits and a feature's plan change only on an explicit owner instruction.
 * - A roadmap feature is `available` only after it has shipped to users and production has been
 *   verified (`verifiedIn` names that build). Until then it is `coming_soon`.
 * - Bring your own provider: model inference runs on the user's own Claude / Codex account.
 *   KalCode never pays for, resells, or meters provider usage.
 * - Basic product quality, every permission mode and local KalVoice dictation are on every plan.
 *   Plans differ by scale, orchestration, autonomy and cloud capacity — never by safety controls.
 */

import type { PermissionMode } from "./generated/index.ts";

export type PlanId = "free" | "pro" | "max" | "max2x";

/** Every entitlement tier, including the private OWNER tier (never listed publicly). */
export type EntitlementTier = PlanId | "owner";

export type BillingInterval = "month" | "year";

export const BILLING_INTERVALS: readonly BillingInterval[] = ["month", "year"];

export interface PlanPrice {
  /** Whole US dollars charged every month on monthly billing. */
  monthlyUsd: number;
  /** Whole US dollars charged once a year on yearly billing. */
  yearlyUsd: number;
}

/** All permission modes. Available on every plan — never paywalled. */
export const ALL_PERMISSION_MODES = [
  "plan",
  "approve",
  "auto",
  "bypass",
  "custom",
] as const satisfies readonly PermissionMode[];

/**
 * A plan's numeric limits. `null` means KalCode imposes no artificial limit; hardware, operating
 * system, provider, account, API and upstream service limits may still apply (`UNLIMITED_NOTE`).
 */
export interface PlanLimits {
  /** KalVoice Requests per monthly cycle: each cloud-backed request counts once; local commands never count. */
  kalvoiceRequestsPerMonth: number | null;
  /** Local, on-device KalVoice dictation (including voice into terminals) is never metered. */
  kalvoiceDictation: "unlimited";
  /** Terminals open at the same time across all of KalCode (shells, agents and Operations). */
  openTerminals: null;
  /** Coding agents (Claude Code, Codex) running at the same time. */
  parallelAgents: null;
  /** Workspaces (project folders) added to KalCode. */
  workspaces: number | null;
  /** Connected provider accounts (sign-ins) across every provider. */
  providerAccounts: number | null;
  /**
   * Finished Operations Runs shown in Run history, most recent first. A local display limit
   * (the history is the user's own on-device data), never a signed entitlement. Active runs
   * are always shown.
   */
  runHistory: number | null;
  /** Monthly cloud Brainstorms; null means unlimited. */
  brainstormsPerMonth: number | null;
  launchRecipes: number | null;
  externalIntegrations: number | null;
  /** Local history display window; null means no age cutoff. Never deletes user data. */
  operationsHistoryDays: number | null;
  queuedTasks: number | null;
  remote: "none" | "standard" | "full";
  orchestration: "basic" | "everyday" | "advanced";
  autonomy: "manual" | "maximum";
  memory: "basic" | "project" | "advanced" | "maximum";
  permissionModes: typeof ALL_PERMISSION_MODES;
  /** Legacy signed-entitlement flags kept for document compatibility (`entitlements.ts`). */
  persistentAgents: boolean;
  multiAgentWorkflows: boolean;
  automations: "none" | "scheduled" | "scheduled_and_event";
  advancedMissions: boolean;
}

export type PlanStage = "TRY" | "BUILD" | "ORCHESTRATE" | "AUTOMATE";

export interface Plan {
  id: PlanId;
  name: string;
  /** One-word position in the upgrade story: TRY → BUILD → ORCHESTRATE → AUTOMATE. */
  stage: PlanStage;
  /** The plan's one-line promise. */
  tagline: string;
  /** Drawn as MOST POPULAR on the website. Exactly one plan. */
  popular: boolean;
  price: PlanPrice;
  limits: PlanLimits;
  /** Roadmap features this plan's card leads with (ids in `PLAN_FEATURE_GROUPS`). */
  cardFeatures: readonly string[];
}

/** The footnote every "Unlimited" claim carries. */
export const UNLIMITED_NOTE =
  "Unlimited means KalCode sets no limit of its own. Hardware, operating system, provider, account, API and upstream service limits may still apply.";

export const PLANS: readonly Plan[] = [
  {
    id: "free",
    name: "Free",
    stage: "TRY",
    tagline: "Try KalCode.",
    popular: false,
    price: { monthlyUsd: 0, yearlyUsd: 0 },
    limits: {
      kalvoiceRequestsPerMonth: 25,
      kalvoiceDictation: "unlimited",
      openTerminals: null,
      parallelAgents: null,
      workspaces: null,
      providerAccounts: 2,
      runHistory: 10,
      brainstormsPerMonth: 3,
      launchRecipes: 1,
      externalIntegrations: 1,
      operationsHistoryDays: null,
      queuedTasks: 3,
      remote: "none",
      orchestration: "basic",
      autonomy: "manual",
      memory: "basic",
      permissionModes: ALL_PERMISSION_MODES,
      persistentAgents: false,
      multiAgentWorkflows: false,
      automations: "none",
      advancedMissions: false,
    },
    cardFeatures: ["core-code", "agent-fleet", "unified-memory"],
  },
  {
    id: "pro",
    name: "Pro",
    stage: "BUILD",
    tagline: "Your everyday AI engineering workspace.",
    popular: false,
    price: { monthlyUsd: 10, yearlyUsd: 100 },
    limits: {
      kalvoiceRequestsPerMonth: 150,
      kalvoiceDictation: "unlimited",
      openTerminals: null,
      parallelAgents: null,
      workspaces: null,
      providerAccounts: 6,
      runHistory: null,
      brainstormsPerMonth: null,
      launchRecipes: 10,
      externalIntegrations: 5,
      operationsHistoryDays: 30,
      queuedTasks: null,
      remote: "none",
      orchestration: "everyday",
      autonomy: "manual",
      memory: "project",
      permissionModes: ALL_PERMISSION_MODES,
      persistentAgents: false,
      multiAgentWorkflows: false,
      automations: "none",
      advancedMissions: false,
    },
    cardFeatures: ["operations-history", "brainstorm", "browser-studio"],
  },
  {
    id: "max",
    name: "MAX",
    stage: "ORCHESTRATE",
    tagline: "Run serious multi-agent engineering workflows.",
    popular: true,
    price: { monthlyUsd: 25, yearlyUsd: 250 },
    limits: {
      kalvoiceRequestsPerMonth: 500,
      kalvoiceDictation: "unlimited",
      openTerminals: null,
      parallelAgents: null,
      workspaces: null,
      providerAccounts: 12,
      runHistory: null,
      brainstormsPerMonth: null,
      launchRecipes: null,
      externalIntegrations: 25,
      operationsHistoryDays: 365,
      queuedTasks: null,
      remote: "standard",
      orchestration: "advanced",
      autonomy: "manual",
      memory: "advanced",
      permissionModes: ALL_PERMISSION_MODES,
      persistentAgents: false,
      multiAgentWorkflows: true,
      automations: "none",
      advancedMissions: true,
    },
    cardFeatures: ["agent-handoff", "squads", "deploy"],
  },
  {
    id: "max2x",
    name: "MAX 2X",
    stage: "AUTOMATE",
    tagline: "Maximum KalCode. Maximum autonomy.",
    popular: false,
    price: { monthlyUsd: 50, yearlyUsd: 500 },
    limits: {
      kalvoiceRequestsPerMonth: 1000,
      kalvoiceDictation: "unlimited",
      openTerminals: null,
      parallelAgents: null,
      workspaces: null,
      providerAccounts: null,
      runHistory: null,
      brainstormsPerMonth: null,
      launchRecipes: null,
      externalIntegrations: null,
      operationsHistoryDays: null,
      queuedTasks: null,
      remote: "full",
      orchestration: "advanced",
      autonomy: "maximum",
      memory: "maximum",
      permissionModes: ALL_PERMISSION_MODES,
      persistentAgents: true,
      multiAgentWorkflows: true,
      automations: "scheduled_and_event",
      advancedMissions: true,
    },
    cardFeatures: ["keep-working", "auto-routing", "remote"],
  },
] as const;

/**
 * The private OWNER tier: non-billable, never expires, not purchasable, every current and future
 * feature, no KalCode-side limits. Granted only through trusted backend state (docs/BILLING.md);
 * this constant describes its limits for evaluators and must never be rendered as a public plan.
 */
export const OWNER_LIMITS: PlanLimits = {
  kalvoiceRequestsPerMonth: null,
  kalvoiceDictation: "unlimited",
  openTerminals: null,
  parallelAgents: null,
  workspaces: null,
  providerAccounts: null,
  runHistory: null,
  brainstormsPerMonth: null,
  launchRecipes: null,
  externalIntegrations: null,
  operationsHistoryDays: null,
  queuedTasks: null,
  remote: "full",
  orchestration: "advanced",
  autonomy: "maximum",
  memory: "maximum",
  permissionModes: ALL_PERMISSION_MODES,
  persistentAgents: true,
  multiAgentWorkflows: true,
  automations: "scheduled_and_event",
  advancedMissions: true,
};

export function getPlan(id: PlanId): Plan {
  const plan = PLANS.find((candidate) => candidate.id === id);
  if (!plan) {
    throw new Error(`Unknown plan: ${id}`);
  }
  return plan;
}

export function limitsFor(tier: EntitlementTier): PlanLimits {
  return tier === "owner" ? OWNER_LIMITS : getPlan(tier).limits;
}

/** Whole US dollars charged per `interval`. */
export function priceFor(plan: Pick<Plan, "price">, interval: BillingInterval): number {
  return interval === "year" ? plan.price.yearlyUsd : plan.price.monthlyUsd;
}

/** What yearly billing saves against twelve monthly payments: $20, $50, $100. */
export function yearlySavingsUsd(plan: Pick<Plan, "price">): number {
  return plan.price.monthlyUsd * 12 - plan.price.yearlyUsd;
}

/** "$0", "$10", "$250" — whole-dollar display used everywhere prices are shown. */
export function formatPrice(plan: Pick<Plan, "price">, interval: BillingInterval = "month"): string {
  return `$${priceFor(plan, interval).toLocaleString("en-US")}`;
}

/** "/month" or "/year", kept separate so layouts can style it independently. */
export function formatInterval(interval: BillingInterval = "month"): string {
  return `/${interval}`;
}

/** "4", "1,000", "Unlimited" — a numeric limit for display. */
export function formatLimit(value: number | null): string {
  return value === null ? "Unlimited" : value.toLocaleString("en-US");
}

/** "25", "150", "500", "1,000", "Unlimited" — KalVoice Request allowance for display. */
export function formatKalVoiceAllowance(limits: PlanLimits): string {
  return formatLimit(limits.kalvoiceRequestsPerMonth);
}

/** The five core limits every plan card and comparison leads with, in display order. */
export const CORE_LIMITS = [
  { key: "parallelAgents", one: "local agent", many: "local agents", label: "Local coding agents" },
  { key: "openTerminals", one: "local terminal", many: "local terminals", label: "Local terminals" },
  { key: "workspaces", one: "workspace", many: "workspaces", label: "Workspaces" },
  { key: "providerAccounts", one: "account", many: "accounts", label: "Connected provider accounts" },
  { key: "kalvoiceRequestsPerMonth", one: "KalVoice", many: "KalVoice", label: "KalVoice Requests a month" },
] as const satisfies readonly { key: keyof PlanLimits; one: string; many: string; label: string }[];

/** Catalog-derived plan card display, including unlimited local agents and terminals. */
export function formatCoreLimit(limits: PlanLimits, limit: (typeof CORE_LIMITS)[number]): string {
  const value = limits[limit.key] as number | null;
  return `${formatLimit(value)} ${value === 1 ? limit.one : limit.many}`;
}

// ── Plan roadmap ────────────────────────────────────────────────────────────────────────────

/**
 * `available`: shipped, user-receivable and production-verified (`verifiedIn` names the build).
 * `coming_soon`: assigned to its plan but not yet shipped. Never advertise it as available.
 */
export type FeatureStatus = "available" | "coming_soon";

export interface PlanFeature {
  /** Stable id (cards reference it). */
  id: string;
  label: string;
  /** The lowest plan that includes it; every higher plan includes it too. */
  from: PlanId;
  status: FeatureStatus;
  /** The production build this was verified live in. Required exactly when `available`. */
  verifiedIn?: string;
  /** Per-plan wording where plans differ ("Recent 10", "Unlimited"); otherwise a check mark. */
  values?: Partial<Record<PlanId, string>>;
  /** Optional one-line explanation for the comparison table. */
  detail?: string;
}

export interface PlanFeatureGroup {
  id: string;
  title: string;
  features: readonly PlanFeature[];
}

/** The live build the `available` features below were verified in. */
const LIVE = "0.1.8+923";
/**
 * The 0.1.9 build the features flipped for 0.1.9 were verified in. The release lead replaces the
 * placeholder with the production-verified build number before merge (the roadmap test rejects it).
 */
const V019 = "0.1.9+1106";
/** The Stable 0.1.9 build that shipped the New agent launcher, provider agent panes and Account Hub. */
const V019_STABLE = "0.1.9+1340";

/** Comparison quotas are formatted from the same limits signed by the API. */
function quotaValues(key: "brainstormsPerMonth" | "launchRecipes" | "externalIntegrations" | "queuedTasks") {
  return Object.fromEntries(PLANS.map((plan) => [plan.id, formatLimit(plan.limits[key])])) as Record<PlanId, string>;
}

export const PLAN_FEATURE_GROUPS: readonly PlanFeatureGroup[] = [
  {
    id: "core",
    title: "Core KalCode and workspace tools",
    features: [
      {
        id: "core-code",
        label: "All supported coding providers on your own accounts",
        from: "free",
        status: "available",
        verifiedIn: LIVE,
      },
      { id: "core-threads", label: "Threads", from: "free", status: "available", verifiedIn: LIVE },
      {
        id: "code-workspace",
        label: "Code workspace with terminals and layout presets",
        from: "free",
        status: "available",
        verifiedIn: LIVE,
      },
      { id: "core-browser", label: "Integrated Browser", from: "free", status: "available", verifiedIn: LIVE },
      {
        id: "live-browser",
        label: "Live Browser pane beside your coding agents",
        detail:
          "Open local, preview and production pages beside an agent; send the page, an element, errors or a screenshot to it.",
        from: "free",
        status: "available",
        verifiedIn: "0.1.9+1450",
      },
      {
        id: "external-integrations",
        label: "External API / MCP integrations",
        from: "free",
        status: "available",
        verifiedIn: "0.1.9+1467",
        values: quotaValues("externalIntegrations"),
        detail: "Use your own credentials with supported providers, APIs and MCP servers.",
      },
      {
        id: "adaptive-canvas",
        label: "Adaptive Canvas: task layouts, snap and reversible Tidy",
        from: "pro",
        status: "coming_soon",
      },
      {
        id: "provider-terminals",
        label: "Real Claude Code, Codex, Cursor and Gemini CLI terminals in Code",
        from: "free",
        status: "available",
        verifiedIn: "0.1.9+1502",
      },
      {
        id: "native-parity",
        label: "Native provider tools, permissions and slash commands, unchanged",
        detail: "Web search, MCP servers, shell tools and plugins work exactly as in your own terminal.",
        from: "free",
        status: "available",
        verifiedIn: "0.1.9+1658",
      },
      {
        id: "command-deck",
        label: "Command Deck: workspace, branch, environment and mode at a glance",
        from: "free",
        status: "available",
        verifiedIn: V019,
      },
      {
        id: "account-hub",
        label: "Account Hub and Account + Usage Center",
        from: "free",
        status: "available",
        verifiedIn: V019_STABLE,
      },
      {
        id: "identity",
        label: "Exact provider, account, model and effort identity",
        from: "free",
        status: "available",
        verifiedIn: V019_STABLE,
      },
      {
        id: "terminal-status",
        label: "Terminal status and active-pane focus",
        from: "free",
        status: "available",
        verifiedIn: LIVE,
      },
      {
        id: "terminal-basics",
        label: "Terminal rename, groups, smart close and account-aware + buttons",
        from: "free",
        status: "available",
        verifiedIn: "0.1.9+1565",
      },
      {
        id: "terminal-naming",
        label: "Automatic terminal and agent naming",
        from: "free",
        status: "available",
        verifiedIn: "0.1.9+1530",
      },
      {
        id: "terminal-smart",
        label: "Smart resume",
        from: "free",
        status: "coming_soon",
      },
      { id: "localhost", label: "Automatic localhost detection", from: "free", status: "available", verifiedIn: LIVE },
      { id: "kaltidy", label: "KalTidy", from: "free", status: "available", verifiedIn: "0.1.8+944" },
      {
        id: "favorites",
        label: "Workspace favorites and global pins",
        from: "free",
        status: "available",
        verifiedIn: "0.1.9+1738",
      },
      {
        id: "navigation",
        label: "Command palette and keyboard shortcuts",
        from: "free",
        status: "available",
        verifiedIn: LIVE,
      },
      {
        id: "quick-switcher",
        label: "Back/forward navigation, universal quick switcher and context menus",
        from: "free",
        status: "available",
        verifiedIn: "0.1.9+1565",
      },
      { id: "needs-you", label: "Needs You", from: "free", status: "available", verifiedIn: LIVE },
      { id: "actionable-errors", label: "Actionable errors everywhere", from: "free", status: "coming_soon" },
      {
        id: "appearance",
        label: "Graphite design with high contrast and adjustable text size",
        from: "free",
        status: "available",
        verifiedIn: "0.1.9+1658",
      },
      {
        id: "updates",
        label: "Security fixes, accessibility and KalCode updates",
        from: "free",
        status: "available",
        verifiedIn: LIVE,
      },
    ],
  },
  {
    id: "kalvoice",
    title: "KalVoice",
    features: [
      {
        id: "kalvoice-dictation",
        label: "On-device dictation and voice into terminals",
        from: "free",
        status: "available",
        verifiedIn: LIVE,
        values: { free: "Unlimited", pro: "Unlimited", max: "Unlimited", max2x: "Unlimited" },
        detail: "Runs on your device and never uses KalVoice Requests.",
      },
      {
        id: "kalvoice-actions",
        label: "KalVoice commands for KalCode",
        from: "free",
        status: "available",
        verifiedIn: LIVE,
      },
      {
        id: "kalvoice-followups",
        label: "Contextual follow-ups and completion callbacks",
        from: "pro",
        status: "available",
        verifiedIn: V019,
      },
      {
        id: "kalvoice-agents",
        label: "Agent, Operations and Browser voice control with scene awareness",
        from: "max",
        status: "coming_soon",
      },
      {
        id: "kalvoice-live",
        label: "KalVoice Live: persistent conversation and voice-driven orchestration",
        from: "max2x",
        status: "coming_soon",
      },
    ],
  },
  {
    id: "operations",
    title: "Operations",
    features: [
      {
        id: "operations",
        label: "Runs, Queue, Services, Environments and Activity",
        from: "free",
        status: "available",
        verifiedIn: LIVE,
        values: { free: "Starter", pro: "Full", max: "Full", max2x: "Full" },
      },
      {
        id: "operations-history",
        label: "Operations history",
        from: "free",
        status: "available",
        verifiedIn: LIVE,
        values: { free: "Recent 10", pro: "30 days", max: "1 year", max2x: "Maximum" },
      },
      {
        id: "operations-queue",
        label: "Queued tasks",
        from: "free",
        status: "available",
        verifiedIn: LIVE,
        values: quotaValues("queuedTasks"),
      },
      {
        id: "operations-full",
        label: "Dependencies, priorities, service controls, logs and artifacts",
        from: "pro",
        status: "available",
        verifiedIn: LIVE,
      },
      {
        id: "operations-assign",
        label: "Assign account, provider, model and effort to tasks",
        from: "pro",
        status: "available",
        verifiedIn: LIVE,
      },
    ],
  },
  {
    id: "build",
    title: "Brainstorm and build",
    features: [
      {
        id: "brainstorm",
        label: "Brainstorms per month: idea to implementation brief",
        from: "free",
        status: "coming_soon",
        values: quotaValues("brainstormsPerMonth"),
      },
      {
        id: "brainstorm-actions",
        label: "Build This, Send to Agent, Add to Queue and Save Idea",
        from: "pro",
        status: "coming_soon",
      },
      {
        id: "unified-memory",
        label: "Unified Memory: project memory",
        from: "free",
        status: "available",
        verifiedIn: "0.1.9+1502",
        values: {
          free: "Basic project memory",
          pro: "Project and cross-provider context",
          max: "Project and cross-provider context",
          max2x: "Project and cross-provider context",
        },
      },
      {
        id: "cross-provider-memory",
        label: "Automatic project memory and cross-provider context",
        from: "pro",
        status: "available",
        verifiedIn: "0.1.9+1502",
      },
      {
        id: "orchestration-memory",
        label: "Advanced cross-provider memory integrated into orchestration",
        from: "max",
        status: "coming_soon",
      },
      {
        id: "launch-recipes",
        label: "Launch Recipes",
        from: "free",
        status: "coming_soon",
        values: quotaValues("launchRecipes"),
      },
      {
        id: "advanced-code",
        label: "Advanced Code widgets and contextual actions",
        detail: "Fix This, Debug This, Ask Agent, Quick Send and Send to Agent.",
        from: "pro",
        status: "coming_soon",
      },
      {
        id: "browser-studio",
        label: "Live Browser Studio",
        from: "pro",
        status: "coming_soon",
        values: { pro: "Full", max: "Advanced", max2x: "Advanced" },
      },
    ],
  },
  {
    id: "orchestrate",
    title: "Orchestration",
    features: [
      {
        id: "agent-fleet",
        label: "Agent Fleet",
        from: "free",
        status: "available",
        verifiedIn: V019,
        values: {
          free: "Unlimited local agents",
          pro: "Unlimited local agents",
          max: "Unlimited local agents",
          max2x: "Unlimited local agents",
        },
      },
      {
        id: "unified-orchestration",
        label: "Unified orchestration and advanced multi-agent workflows",
        from: "max",
        status: "coming_soon",
      },
      { id: "routing-suggestions", label: "Advanced account routing suggestions", from: "max", status: "coming_soon" },
      { id: "custom-integrations", label: "Custom integrations", from: "max", status: "coming_soon" },
      {
        id: "deploy-environments",
        label: "Advanced Git, environment and deployment workflows",
        from: "max",
        status: "coming_soon",
      },
      {
        id: "agent-handoff",
        label: "Agent Hand Off: pass work between coding agents with review context",
        from: "max",
        status: "available",
        verifiedIn: "0.1.9+1266",
      },
      { id: "squads", label: "Squads: reusable agent teams", from: "max", status: "coming_soon" },
      { id: "handoff-chains", label: "Agent Handoff Chains", from: "max", status: "coming_soon" },
      { id: "agent-files", label: "Agent File Ownership and collision warnings", from: "max", status: "coming_soon" },
      { id: "stuck-agents", label: "Stuck Agent Detector", from: "max", status: "coming_soon" },
      {
        id: "mission-control",
        label: "Mission Control",
        from: "pro",
        status: "coming_soon",
        values: { pro: "Richer", max: "Full", max2x: "Full" },
      },
      { id: "deploy", label: "KalCode Deploy", from: "max", status: "coming_soon" },
      {
        id: "remote",
        label: "KalCode Remote",
        from: "max",
        status: "coming_soon",
        values: { max: "Standard", max2x: "Full" },
      },
    ],
  },
  {
    id: "automate",
    title: "Autonomous engineering",
    features: [
      {
        id: "auto-context",
        label: "Automatic context, worktrees, tests and environments",
        from: "max2x",
        status: "coming_soon",
      },
      { id: "proactive-needs-you", label: "Proactive Needs You detection", from: "max2x", status: "coming_soon" },
      {
        id: "cloud-memory",
        label: "Highest Unified Memory and cloud-sync capacity",
        from: "max2x",
        status: "coming_soon",
      },
      {
        id: "full-integrations",
        label: "Full OpenAI-supported external API / MCP capacity",
        from: "max2x",
        status: "coming_soon",
      },
      { id: "keep-working", label: "Keep Working: automatic next steps", from: "max2x", status: "coming_soon" },
      {
        id: "auto-routing",
        label: "Automatic task, provider, account and agent routing",
        detail: "Automatic selection, handoffs, retries and interrupted-work recovery.",
        from: "max2x",
        status: "coming_soon",
      },
      {
        id: "auto-release",
        label: "Automatic reviews, Browser previews and release preparation",
        detail: "Review loops, preview creation and advanced deployment automation.",
        from: "max2x",
        status: "coming_soon",
      },
      {
        id: "cloud-capacity",
        label: "Highest background automation and cloud capacity",
        from: "max2x",
        status: "coming_soon",
      },
      {
        id: "early-access",
        label: "Early access to new autonomy, KalVoice and provider features",
        from: "max2x",
        status: "coming_soon",
      },
    ],
  },
];

const PLAN_ORDER: Readonly<Record<PlanId, number>> = { free: 0, pro: 1, max: 2, max2x: 3 };

/** Every roadmap feature, in display order. */
export const PLAN_FEATURES: readonly PlanFeature[] = PLAN_FEATURE_GROUPS.flatMap((group) => group.features);

export function getPlanFeature(id: string): PlanFeature {
  const feature = PLAN_FEATURES.find((candidate) => candidate.id === id);
  if (!feature) {
    throw new Error(`Unknown plan feature: ${id}`);
  }
  return feature;
}

/** Whether `plan` includes `feature` (whatever its roadmap status). */
export function planIncludes(plan: PlanId, feature: Pick<PlanFeature, "from">): boolean {
  return PLAN_ORDER[plan] >= PLAN_ORDER[feature.from];
}
