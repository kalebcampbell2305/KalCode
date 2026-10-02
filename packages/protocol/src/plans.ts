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
  /** KalVoice Requests per monthly cycle: each executed KalVoice command counts once. */
  kalvoiceRequestsPerMonth: number | null;
  /** Local, on-device KalVoice dictation (including voice into terminals) is never metered. */
  kalvoiceDictation: "unlimited";
  /** Terminals open at the same time across all of KalCode (shells, agents and Operations). */
  openTerminals: number | null;
  /** Coding agents (Claude Code, Codex) running at the same time. */
  parallelAgents: number | null;
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
      openTerminals: 4,
      parallelAgents: 1,
      workspaces: 2,
      providerAccounts: 2,
      runHistory: 10,
      permissionModes: ALL_PERMISSION_MODES,
      persistentAgents: false,
      multiAgentWorkflows: false,
      automations: "none",
      advancedMissions: false,
    },
    cardFeatures: ["core-code", "core-threads", "core-browser", "operations", "brainstorm"],
  },
  {
    id: "pro",
    name: "Pro",
    stage: "BUILD",
    tagline: "For developers using AI every day.",
    popular: false,
    price: { monthlyUsd: 10, yearlyUsd: 100 },
    limits: {
      kalvoiceRequestsPerMonth: 150,
      kalvoiceDictation: "unlimited",
      openTerminals: 12,
      parallelAgents: 4,
      workspaces: 10,
      providerAccounts: 6,
      runHistory: null,
      permissionModes: ALL_PERMISSION_MODES,
      persistentAgents: true,
      multiAgentWorkflows: true,
      automations: "scheduled",
      advancedMissions: false,
    },
    cardFeatures: ["operations-full", "brainstorm", "agent-fleet", "launch-recipes", "browser-studio", "advanced-code"],
  },
  {
    id: "max",
    name: "MAX",
    stage: "ORCHESTRATE",
    tagline: "Serious multi-agent development.",
    popular: true,
    price: { monthlyUsd: 25, yearlyUsd: 250 },
    limits: {
      kalvoiceRequestsPerMonth: 500,
      kalvoiceDictation: "unlimited",
      openTerminals: 18,
      parallelAgents: 10,
      workspaces: null,
      providerAccounts: 8,
      runHistory: null,
      permissionModes: ALL_PERMISSION_MODES,
      persistentAgents: true,
      multiAgentWorkflows: true,
      automations: "scheduled_and_event",
      advancedMissions: true,
    },
    cardFeatures: ["squads", "handoff-chains", "agent-files", "stuck-agents", "mission-control", "deploy", "remote"],
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
      permissionModes: ALL_PERMISSION_MODES,
      persistentAgents: true,
      multiAgentWorkflows: true,
      automations: "scheduled_and_event",
      advancedMissions: true,
    },
    cardFeatures: ["keep-working", "auto-routing", "remote", "kalvoice-live", "cloud-capacity", "early-access"],
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
  { key: "parallelAgents", one: "agent", many: "agents", label: "Parallel coding agents" },
  { key: "openTerminals", one: "terminal", many: "terminals", label: "Open terminals" },
  { key: "workspaces", one: "workspace", many: "workspaces", label: "Workspaces" },
  { key: "providerAccounts", one: "account", many: "accounts", label: "Connected provider accounts" },
  { key: "kalvoiceRequestsPerMonth", one: "KalVoice", many: "KalVoice", label: "KalVoice Requests a month" },
] as const satisfies readonly { key: keyof PlanLimits; one: string; many: string; label: string }[];

/** "1 agent", "12 terminals", "Unlimited workspaces", "1,000 KalVoice". */
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
const V019 = "0.1.9+1089";

export const PLAN_FEATURE_GROUPS: readonly PlanFeatureGroup[] = [
  {
    id: "core",
    title: "Core KalCode — every plan",
    features: [
      {
        id: "core-code",
        label: "Claude Code and Codex on your own provider accounts",
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
        id: "provider-terminals",
        label: "Real Claude Code and Codex terminals in Code",
        from: "free",
        status: "coming_soon",
      },
      { id: "account-hub", label: "Account Hub and Account + Usage Center", from: "free", status: "coming_soon" },
      {
        id: "identity",
        label: "Exact provider, account, model and effort identity",
        from: "free",
        status: "coming_soon",
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
        status: "coming_soon",
      },
      {
        id: "terminal-smart",
        label: "Automatic terminal naming and smart resume",
        from: "free",
        status: "coming_soon",
      },
      { id: "localhost", label: "Automatic localhost detection", from: "free", status: "available", verifiedIn: LIVE },
      { id: "kaltidy", label: "KalTidy", from: "free", status: "available", verifiedIn: "0.1.8+944" },
      { id: "favorites", label: "Favorites", from: "free", status: "coming_soon" },
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
        status: "coming_soon",
      },
      { id: "needs-you", label: "Needs You", from: "free", status: "available", verifiedIn: LIVE },
      { id: "actionable-errors", label: "Actionable errors everywhere", from: "free", status: "coming_soon" },
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
        label: "Run history",
        from: "free",
        status: "available",
        verifiedIn: LIVE,
        values: { free: "Recent 10", pro: "Full", max: "Full", max2x: "Full" },
      },
      {
        id: "operations-queue",
        label: "Queued tasks",
        from: "free",
        status: "available",
        verifiedIn: LIVE,
        values: { free: "Up to 3", pro: "Unlimited", max: "Unlimited", max2x: "Unlimited" },
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
        label: "AI Brainstorm to implementation brief",
        from: "free",
        status: "coming_soon",
        values: { free: "3 a month", pro: "Unlimited", max: "Unlimited", max2x: "Unlimited" },
      },
      {
        id: "brainstorm-actions",
        label: "Build This, Send to Agent, Add to Queue and Save Idea",
        from: "pro",
        status: "coming_soon",
      },
      {
        id: "launch-recipes",
        label: "Launch Recipes",
        from: "pro",
        status: "coming_soon",
        values: { pro: "Up to 10", max: "Unlimited", max2x: "Unlimited" },
      },
      {
        id: "advanced-code",
        label: "Advanced Code: quick-send output, mini diffs, duplicate terminal and Code quick bar",
        from: "pro",
        status: "coming_soon",
      },
      {
        id: "browser-studio",
        label: "Live Browser Studio",
        from: "pro",
        status: "coming_soon",
        values: { pro: "Preview", max: "Full", max2x: "Full" },
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
        from: "pro",
        status: "available",
        verifiedIn: V019,
        values: { pro: "Up to 4 agents", max: "Up to 10 agents", max2x: "Unlimited" },
      },
      { id: "squads", label: "Squads: reusable agent teams", from: "max", status: "coming_soon" },
      { id: "handoff-chains", label: "Agent Handoff Chains", from: "max", status: "coming_soon" },
      { id: "agent-files", label: "Agent File Ownership and collision warnings", from: "max", status: "coming_soon" },
      { id: "stuck-agents", label: "Stuck Agent Detector", from: "max", status: "coming_soon" },
      { id: "mission-control", label: "Mission Control and Adaptive Canvas", from: "max", status: "coming_soon" },
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
      { id: "keep-working", label: "Keep Working: automatic next steps", from: "max2x", status: "coming_soon" },
      {
        id: "auto-routing",
        label: "Automatic routing, agent selection, handoffs and recovery",
        from: "max2x",
        status: "coming_soon",
      },
      {
        id: "auto-release",
        label: "Automatic reviews, previews and release preparation",
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
