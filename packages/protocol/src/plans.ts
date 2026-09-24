/**
 * The single source of truth for KalCode plans and prices.
 *
 * Marketing, checkout, account, settings and entitlement checks must read from here — no
 * component may hardcode a price or a plan name. Paid access is ultimately authorized by the
 * backend entitlement service (campaign Z13); this module describes the catalog.
 */

export type PlanId = "free" | "pro" | "max";

export type BillingInterval = "month";

export interface PlanPrice {
  /** Whole US dollars per billing interval. */
  amountUsd: number;
  interval: BillingInterval;
}

/** Numeric entitlements. `provisional` values are subject to change before public launch. */
export interface PlanEntitlements {
  /** Maximum threads running at the same time on one device. */
  concurrentThreads: number;
  /** Provider connections are never paywalled. */
  providerConnections: "unlimited";
  persistentAgents: boolean;
  multiAgentWorkflows: boolean;
  automations: "none" | "scheduled" | "scheduled_and_event";
  advancedMissions: boolean;
  provisional: true;
}

export interface Plan {
  id: PlanId;
  name: string;
  price: PlanPrice;
  summary: string;
  /** Short, user-facing capability lines. Must describe real or clearly planned capabilities. */
  highlights: readonly string[];
  entitlements: PlanEntitlements;
}

export const PLANS: readonly Plan[] = [
  {
    id: "free",
    name: "Free",
    price: { amountUsd: 0, interval: "month" },
    summary: "Everything you need to see why one workspace for all your AI tools matters.",
    highlights: [
      "Connect every supported AI provider",
      "Dashboard with live thread status",
      "Threads, Code workspace and local terminal",
      "Standard permission modes",
      "Basic JARVIS interaction",
    ],
    entitlements: {
      concurrentThreads: 2,
      providerConnections: "unlimited",
      persistentAgents: false,
      multiAgentWorkflows: false,
      automations: "none",
      advancedMissions: false,
      provisional: true,
    },
  },
  {
    id: "pro",
    name: "Pro",
    price: { amountUsd: 10, interval: "month" },
    summary: "For daily work across several agents and projects.",
    highlights: [
      "Everything in Free",
      "More threads running at once",
      "Persistent agents and pair or team workflows",
      "Scheduled automations, skills and plugins",
      "Enhanced JARVIS and voice",
    ],
    entitlements: {
      concurrentThreads: 8,
      providerConnections: "unlimited",
      persistentAgents: true,
      multiAgentWorkflows: true,
      automations: "scheduled",
      advancedMissions: false,
      provisional: true,
    },
  },
  {
    id: "max",
    name: "MAX",
    price: { amountUsd: 25, interval: "month" },
    summary: "For people who hand whole objectives to KalCode.",
    highlights: [
      "Everything in Pro",
      "Highest concurrency",
      "Advanced missions with verification",
      "Event-triggered automations",
      "Advanced JARVIS orchestration and memory",
    ],
    entitlements: {
      concurrentThreads: 20,
      providerConnections: "unlimited",
      persistentAgents: true,
      multiAgentWorkflows: true,
      automations: "scheduled_and_event",
      advancedMissions: true,
      provisional: true,
    },
  },
] as const;

export function getPlan(id: PlanId): Plan {
  const plan = PLANS.find((candidate) => candidate.id === id);
  if (!plan) {
    throw new Error(`Unknown plan: ${id}`);
  }
  return plan;
}

/** "$0", "$10", "$25" — whole-dollar display used everywhere prices are shown. */
export function formatPrice(price: PlanPrice): string {
  return `$${price.amountUsd}`;
}

/** "/month" suffix, kept separate so layouts can style it independently. */
export function formatInterval(price: PlanPrice): string {
  return `/${price.interval}`;
}
