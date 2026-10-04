import { useOptionalProviderAccountSessions } from "./ProviderAccountSessions.tsx";

/**
 * Canonical provider-quota usage for one provider account (Claude A, Codex B…). Every surface
 * that shows an account's usage (New agent launcher, agent pane headers, Provider Dock, Account
 * + Usage Center, Fleet) reads this one state; nothing keeps its own copy. Values are only ever
 * real provider data; when KalCode can't read them the state says so instead of guessing.
 */
export interface UsageWindow {
  /** Stable id: "five_hour", "weekly", "weekly_opus", "primary", "secondary"… */
  id: string;
  /** Human label: "5-hour", "Weekly". */
  label: string;
  /** 0–100, how much of the window is left. */
  remainingPercent: number;
  /** ISO time the window resets, when the provider reports it. */
  resetsAt: string | null;
}

export type AccountUsageStatus =
  /** Real numbers from the provider, recently read. */
  | "fresh"
  /** Real numbers, but older than the refresh interval (label them as such). */
  | "stale"
  /** First read in flight; nothing known yet. */
  | "checking"
  /** The provider doesn't expose usage for this account (e.g. Gemini, API-key accounts). */
  | "unavailable"
  /** Not read yet (signed out, never launched, or the read failed). */
  | "not_checked";

export interface AccountUsageState {
  accountId: string;
  status: AccountUsageStatus;
  /** Most constrained window first. Empty unless status is fresh/stale. */
  windows: readonly UsageWindow[];
  /** ISO time of the provider read the numbers came from. */
  checkedAt: string | null;
  /** Short reason when unavailable / not_checked, e.g. "Signed out". */
  reason: string | null;
  /** Provider plan label ("Max 20x", "Pro") when the provider recorded one. */
  plan?: string | null;
}

/** Below this, an account is "running low" (subtle warning, never an automatic switch). */
export const LOW_USAGE_PERCENT = 20;

export function notChecked(accountId: string, reason: string | null = null): AccountUsageState {
  return { accountId, status: "not_checked", windows: [], checkedAt: null, reason };
}

/** The window that limits the account right now (lowest remaining), if any. */
export function limitingWindow(state: AccountUsageState): UsageWindow | null {
  let best: UsageWindow | null = null;
  for (const window of state.windows) if (!best || window.remainingPercent < best.remainingPercent) best = window;
  return best;
}

export function usagePercent(value: number): string {
  return value > 0 && value < 1 ? "<1" : String(Math.round(value));
}

export interface UsageSummary {
  /** Compact text for headers/chips: "64% left", "Usage unavailable", "Not checked". */
  short: string;
  /** True when the limiting window is under LOW_USAGE_PERCENT. */
  low: boolean;
  tone: "ok" | "low" | "muted";
}

export function usageSummary(state: AccountUsageState): UsageSummary {
  const window = limitingWindow(state);
  if ((state.status === "fresh" || state.status === "stale") && window) {
    const percent = Math.max(0, Math.min(100, Math.round(window.remainingPercent)));
    const low = percent < LOW_USAGE_PERCENT;
    return { short: `${percent}% left`, low, tone: low ? "low" : "ok" };
  }
  if (state.status === "checking") return { short: "Checking usage…", low: false, tone: "muted" };
  if (state.status === "unavailable") return { short: "Usage unavailable", low: false, tone: "muted" };
  return { short: "Not checked", low: false, tone: "muted" };
}

/** "Resets in 2h 14m" from an ISO time, or null. */
export function resetsIn(resetsAt: string | null, now: number = Date.now()): string | null {
  if (!resetsAt) return null;
  const ms = Date.parse(resetsAt) - now;
  if (!Number.isFinite(ms)) return null;
  if (ms <= 0) return "Resets now";
  const minutes = Math.round(ms / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `Resets in ${days}d ${hours}h`;
  if (hours > 0) return `Resets in ${hours}h ${mins}m`;
  return `Resets in ${Math.max(1, mins)}m`;
}

/**
 * All accounts' usage, keyed by account id. Reads the shell-lifetime ProviderAccountSessions
 * state, so opening a menu never waits on a provider read: it renders what is known now and
 * updates in place when a background read lands.
 */
export function useAccountUsages(): ReadonlyMap<string, AccountUsageState> {
  return useOptionalProviderAccountSessions()?.usage ?? EMPTY;
}

/** One account's usage (not_checked when unknown or when no account is given). */
export function useAccountUsage(accountId: string | null | undefined): AccountUsageState {
  const all = useAccountUsages();
  if (!accountId) return NONE;
  return all.get(accountId) ?? notChecked(accountId);
}

const EMPTY: ReadonlyMap<string, AccountUsageState> = new Map();
const NONE: AccountUsageState = notChecked("");
