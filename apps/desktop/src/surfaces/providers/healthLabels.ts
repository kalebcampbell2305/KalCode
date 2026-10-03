import type { HealthRollup, HealthState, HealthTrend, ProviderHealth, ProviderStatus } from "@kalcode/protocol";
import { formatRelative } from "../../runtime/describeEvent.ts";
import type { Label } from "./providerLabels.ts";

/**
 * Provider Health (PH) in words. Every sentence says only what the health snapshot reports:
 * unknown stays unknown, and a rate limit is mentioned only when the provider reported one.
 */

const STATES: Record<HealthState, Omit<Label, "detail">> = {
  healthy: { tone: "success", label: "Healthy" },
  degraded: { tone: "waiting", label: "Degraded" },
  unavailable: { tone: "danger", label: "Unavailable" },
  unknown: { tone: "idle", label: "Unknown" },
};

/** Overall state: StatusIndicator tone + words, with the snapshot's own reason. */
export function healthStateLabel(health: Pick<ProviderHealth, "state" | "reason">): Label {
  return { ...STATES[health.state], detail: health.reason };
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`;
}

function plural(count: number, noun: string): string {
  return `${count.toLocaleString()} ${noun}${count === 1 ? "" : "s"}`;
}

/** Process: running or not, with the active session count. */
export function processText(health: Pick<ProviderHealth, "processRunning" | "activeSessions">): string {
  if (!health.processRunning || health.activeSessions === 0) return "Not running";
  return `Running · ${plural(health.activeSessions, "active session")}`;
}

/** The provider's connected KalCode accounts, as the canonical account state knows them. */
export interface AccountSignIns {
  total: number;
  signedIn: number;
}

/**
 * Sign-in as the provider reports it. KalCode never signs in for the user. When the provider
 * itself can't be asked safely (Claude defers to a real session), the connected accounts are
 * the one authoritative answer (AGENTS.md account-usage rule).
 */
export function signInText(
  health: Pick<ProviderHealth, "providerId" | "auth" | "displayName" | "detection">,
  status?: Pick<ProviderStatus, "authCheck"> | null,
  accounts?: AccountSignIns | null,
): Label {
  if (health.detection !== "installed" && health.detection !== "outdated") {
    return { tone: "idle", label: "Not checked", detail: null };
  }
  if (health.auth === "unknown" && accounts && accounts.total > 0) {
    return accounts.signedIn > 0
      ? {
          tone: "success",
          label: "Signed in",
          detail: `${plural(accounts.signedIn, "account")} signed in on this computer.`,
        }
      : { tone: "waiting", label: "Signed out", detail: "Sign in from Accounts." };
  }
  const checkedWith = status?.authCheck ? `Checked with ${status.authCheck}.` : null;
  switch (health.auth) {
    case "authenticated":
      return { tone: "success", label: "Signed in", detail: checkedWith };
    case "not_authenticated":
      return { tone: "waiting", label: "Signed out", detail: checkedWith };
    case "unknown":
      return status?.authCheck
        ? { tone: "idle", label: "Unknown", detail: `${status.authCheck} didn't give a clear answer.` }
        : health.providerId === "claude-code"
          ? {
              tone: "idle",
              label: "Sign-in status unknown",
              detail: "Sign-in is checked when a Claude Code session starts.",
            }
          : { tone: "idle", label: `${health.displayName} has no documented way to check sign-in`, detail: null };
  }
}

/** Version against the adapter's declared minimum. */
export function versionText(health: Pick<ProviderHealth, "version" | "minimumVersion">): string {
  const version = health.version ? `Version ${health.version}` : "Version not detected";
  return health.minimumVersion
    ? `${version} · needs ${health.minimumVersion} or later`
    : `${version} · no minimum declared`;
}

/** Time to first output over the last 15 minutes, or why there is none. */
export function latencyText(health: Pick<ProviderHealth, "latencyP50Ms" | "latencyP95Ms" | "latencySamples">): string {
  if (health.latencySamples === 0 || health.latencyP50Ms === null) return "No sessions in the last 15 minutes";
  const p95 = health.latencyP95Ms !== null ? ` · p95 ${formatMs(health.latencyP95Ms)}` : "";
  return `p50 ${formatMs(health.latencyP50Ms)}${p95} · ${plural(health.latencySamples, "sample")}, last 15 minutes`;
}

/** Session failures in the last 60 minutes, with the last failure's code and when. */
export function failuresText(
  health: Pick<ProviderHealth, "recentFailures" | "lastFailure">,
  now: number = Date.now(),
): string {
  if (health.recentFailures === 0) return "None in the last hour";
  const last = health.lastFailure
    ? ` · last: ${health.lastFailure.code}, ${formatRelative(health.lastFailure.at, now)}`
    : "";
  return `${plural(health.recentFailures, "failure")} in the last hour${last}`;
}

/** Rate limits only when the provider reported one; KalCode has no numbers of its own. */
export function rateLimitText(
  health: Pick<ProviderHealth, "capacity" | "reasonCode" | "displayName" | "backoffUntil">,
): Label {
  if (health.capacity !== "backing_off") return { tone: "idle", label: "None reported", detail: null };
  const quota = health.reasonCode === "quota_exhausted";
  return {
    tone: "waiting",
    label: quota
      ? `${health.displayName} reported that your quota is used up`
      : `${health.displayName} reported a rate limit`,
    detail: health.backoffUntil
      ? `${health.displayName} said to retry after ${new Date(health.backoffUntil).toLocaleString()}.`
      : `${health.displayName} didn't say when to retry. New work waits.`,
  };
}

const TRENDS: Record<HealthTrend, string> = {
  improving: "Improving",
  stable: "Stable",
  worsening: "Worsening",
  insufficient_data: "Not enough data yet",
};

export function trendLabel(trend: HealthTrend): string {
  return TRENDS[trend];
}

export interface RecoveryHint {
  text: string;
  /** A command the person runs in their own terminal (never run by KalCode). */
  command: string | null;
}

/** What would make the provider healthy again, or null when nothing needs doing. */
export function recoveryHint(
  health: Pick<ProviderHealth, "recoverability" | "displayName" | "minimumVersion" | "reasonCode"> &
    Partial<Pick<ProviderHealth, "providerId">>,
  status?: Pick<ProviderStatus, "installCommand" | "signInCommand"> | null,
): RecoveryHint | null {
  const name = health.displayName;
  switch (health.recoverability) {
    case "none":
      return null;
    case "install":
      return {
        text: `Install ${name} in a terminal, then choose Check again.`,
        command: status?.installCommand ?? null,
      };
    case "update":
      return {
        text: health.minimumVersion
          ? `Update ${name} to version ${health.minimumVersion} or later, then choose Check again.`
          : `Update ${name}, then choose Check again.`,
        command: null,
      };
    case "sign_in":
      // Managed Gemini accounts sign in only from their account card; a terminal `gemini`
      // signs in a standalone profile that KalCode threads never use.
      if (health.providerId === "gemini-cli") {
        return {
          text: `Sign in to the ${name} account in Providers, Accounts, then choose Check again.`,
          command: null,
        };
      }
      return {
        text: `Sign in with ${name}'s own command in a terminal, then choose Check again.`,
        command: status?.signInCommand ?? null,
      };
    case "restart":
      return health.reasonCode === "detection_failed"
        ? { text: "Choose Check again.", command: null }
        : { text: "Restart the affected thread, or choose Check again.", command: null };
    case "automatic":
      return { text: `Expected to recover on its own once ${name}'s limit clears.`, command: null };
    case "unknown":
      if (health.reasonCode === "not_checked") return { text: "Choose Check again to check it.", command: null };
      if (health.reasonCode === "quota_exhausted") {
        return { text: `Check your ${name} plan or usage in ${name} itself.`, command: null };
      }
      return null;
  }
}

export type WidgetTone = "ok" | "warn" | "bad" | "muted";

const WIDGET_TONES: Record<HealthState, WidgetTone> = {
  healthy: "ok",
  degraded: "warn",
  unavailable: "bad",
  unknown: "muted",
};

/** One short line for compact places (the Dashboard's Provider health widget). */
export function healthSummary(health: ProviderHealth): { text: string; tone: WidgetTone } {
  const tone = WIDGET_TONES[health.state];
  switch (health.state) {
    case "unknown":
      return { text: health.reasonCode === "not_checked" ? "Not checked yet" : "Health unknown", tone };
    case "unavailable":
      switch (health.reasonCode) {
        case "not_installed":
          return { text: "Not installed", tone };
        case "signed_out":
          return { text: "Signed out", tone };
        case "outdated":
          return { text: "Update needed", tone };
        case "detection_failed":
          return { text: "Check failed", tone };
        default:
          return { text: "Unavailable", tone };
      }
    case "degraded":
      if (health.capacity === "backing_off") {
        return {
          text:
            health.reasonCode === "quota_exhausted"
              ? "Backing off · quota used up"
              : "Backing off · rate limit reported",
          tone,
        };
      }
      return health.recentFailures > 0
        ? { text: `Degraded · ${plural(health.recentFailures, "failure")} in the last hour`, tone }
        : { text: "Degraded", tone };
    case "healthy":
      return health.activeSessions > 0
        ? { text: `Healthy · ${plural(health.activeSessions, "session")}`, tone }
        : { text: "Healthy", tone };
  }
}

export interface HourSlot {
  hourStart: string;
  sessions: number;
  failures: number;
  backoffs: number;
  latencyP50Ms: number | null;
}

/**
 * The last `hours` hours as one slot per hour, oldest first, from sparse rollups (hours without
 * observations have no rollup and read as zero).
 */
export function hourSlots(rollups: readonly HealthRollup[], hours: number, now: number = Date.now()): HourSlot[] {
  const hourMs = 3_600_000;
  const current = Math.floor(now / hourMs) * hourMs;
  const byHour = new Map(rollups.map((r) => [Math.floor(new Date(r.hourStart).getTime() / hourMs) * hourMs, r]));
  return Array.from({ length: hours }, (_, index) => {
    const start = current - (hours - 1 - index) * hourMs;
    const r = byHour.get(start);
    return {
      hourStart: new Date(start).toISOString(),
      sessions: r?.sessionsStarted ?? 0,
      failures: r?.failures ?? 0,
      backoffs: r?.backoffs ?? 0,
      latencyP50Ms: r?.latencyP50Ms ?? null,
    };
  });
}

/** "14 sessions, 2 failures in the last 24 hours" (with a rate-limit count only when reported). */
export function historySummary(slots: readonly HourSlot[]): string {
  const sessions = slots.reduce((n, s) => n + s.sessions, 0);
  const failures = slots.reduce((n, s) => n + s.failures, 0);
  const backoffs = slots.reduce((n, s) => n + s.backoffs, 0);
  if (sessions === 0 && failures === 0 && backoffs === 0) return `No sessions in the last ${slots.length} hours`;
  const parts = [plural(sessions, "session"), plural(failures, "failure")];
  if (backoffs > 0) parts.push(plural(backoffs, "rate limit report"));
  return `${parts.join(", ")} in the last ${slots.length} hours`;
}
