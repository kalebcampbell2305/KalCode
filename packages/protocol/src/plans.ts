/**
 * The single source of truth for KalCode plans, prices and plan limits.
 *
 * Marketing, checkout, account, settings and entitlement checks must read from here — no
 * component may hardcode a price, a plan name or a limit. Paid access is authorized by the
 * backend entitlement service (server-authoritative); this module describes the catalog.
 *
 * Business rules encoded here (owner decisions):
 * - Bring your own provider: model inference runs on the user's own Claude / Codex / Gemini
 *   account. KalCode never pays for, resells, or meters provider usage.
 * - Provider connections, every permission mode, and local KalVoice dictation are on every plan.
 * - Plans differ by KalVoice Requests and KalCode features — never by safety controls.
 */

import type { PermissionMode } from "./generated/index.ts";

export type PlanId = "free" | "pro" | "max";

/** Every entitlement tier, including the private OWNER tier (never listed publicly). */
export type EntitlementTier = PlanId | "owner";

export type BillingInterval = "month";

export interface PlanPrice {
  /** Whole US dollars per billing interval. */
  amountUsd: number;
  interval: BillingInterval;
}

/** All permission modes. Available on every plan — never paywalled. */
export const ALL_PERMISSION_MODES = [
  "plan",
  "approve",
  "auto",
  "bypass",
  "custom",
] as const satisfies readonly PermissionMode[];

export interface PlanLimits {
  /** Top-level KalVoice assistant requests per monthly cycle; `null` = unlimited. */
  kalvoiceRequestsPerMonth: number | null;
  /** Local KalVoice dictation is never metered. */
  kalvoiceDictation: "unlimited";
  /** Provider connections are never paywalled. */
  providerConnections: "unlimited";
  permissionModes: typeof ALL_PERMISSION_MODES;
  /** Maximum threads running at the same time on one device; `null` = unlimited. */
  concurrentThreads: number | null;
  persistentAgents: boolean;
  multiAgentWorkflows: boolean;
  automations: "none" | "scheduled" | "scheduled_and_event";
  advancedMissions: boolean;
}

export interface Plan {
  id: PlanId;
  name: string;
  price: PlanPrice;
  summary: string;
  /** Short, user-facing capability lines. Must describe real or clearly planned capabilities. */
  highlights: readonly string[];
  limits: PlanLimits;
}

export const PLANS: readonly Plan[] = [
  {
    id: "free",
    name: "Free",
    price: { amountUsd: 0, interval: "month" },
    summary: "Everything you need to run your coding agents from one workspace.",
    highlights: [
      "Connect Claude Code, Codex and Gemini CLI",
      "250 KalVoice Requests a month",
      "Unlimited local KalVoice dictation",
      "Every permission mode, including Bypass and Custom",
      "Dashboard, threads, Code workspace and terminals",
    ],
    limits: {
      kalvoiceRequestsPerMonth: 250,
      kalvoiceDictation: "unlimited",
      providerConnections: "unlimited",
      permissionModes: ALL_PERMISSION_MODES,
      concurrentThreads: 2,
      persistentAgents: false,
      multiAgentWorkflows: false,
      automations: "none",
      advancedMissions: false,
    },
  },
  {
    id: "pro",
    name: "Pro",
    price: { amountUsd: 10, interval: "month" },
    summary: "For daily work across several agents and projects.",
    highlights: [
      "Everything in Free",
      "2,500 KalVoice Requests a month",
      "More threads running at once",
      "Persistent agents and pair or team workflows",
      "Scheduled automations, skills and plugins",
    ],
    limits: {
      kalvoiceRequestsPerMonth: 2500,
      kalvoiceDictation: "unlimited",
      providerConnections: "unlimited",
      permissionModes: ALL_PERMISSION_MODES,
      concurrentThreads: 8,
      persistentAgents: true,
      multiAgentWorkflows: true,
      automations: "scheduled",
      advancedMissions: false,
    },
  },
  {
    id: "max",
    name: "MAX",
    price: { amountUsd: 25, interval: "month" },
    summary: "For people who hand whole objectives to KalCode.",
    highlights: [
      "Everything in Pro",
      "10,000 KalVoice Requests a month",
      "Highest concurrency",
      "Advanced missions with verification",
      "Event-triggered automations",
    ],
    limits: {
      kalvoiceRequestsPerMonth: 10000,
      kalvoiceDictation: "unlimited",
      providerConnections: "unlimited",
      permissionModes: ALL_PERMISSION_MODES,
      concurrentThreads: 20,
      persistentAgents: true,
      multiAgentWorkflows: true,
      automations: "scheduled_and_event",
      advancedMissions: true,
    },
  },
] as const;

/**
 * The private OWNER tier: non-billable, never expires, not purchasable, every current and future
 * feature, unlimited KalVoice Requests. Granted only through trusted backend state (docs/BILLING.md);
 * this constant describes its limits for evaluators and must never be rendered as a public plan.
 */
export const OWNER_LIMITS: PlanLimits = {
  kalvoiceRequestsPerMonth: null,
  kalvoiceDictation: "unlimited",
  providerConnections: "unlimited",
  permissionModes: ALL_PERMISSION_MODES,
  concurrentThreads: null,
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

/** "$0", "$10", "$25" — whole-dollar display used everywhere prices are shown. */
export function formatPrice(price: PlanPrice): string {
  return `$${price.amountUsd}`;
}

/** "/month" suffix, kept separate so layouts can style it independently. */
export function formatInterval(price: PlanPrice): string {
  return `/${price.interval}`;
}

/** "250", "2,500", "Unlimited" — KalVoice Request allowance for display. */
export function formatKalVoiceAllowance(limits: PlanLimits): string {
  return limits.kalvoiceRequestsPerMonth === null
    ? "Unlimited"
    : limits.kalvoiceRequestsPerMonth.toLocaleString("en-US");
}
