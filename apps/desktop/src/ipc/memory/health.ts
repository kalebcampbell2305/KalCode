/**
 * Provider Health (PH, PROVIDERS-2) for the in-memory runtime: unit tests and the `ui-test` build
 * ONLY (see ../memoryTransport.ts). Mirrors `apps/desktop/src-tauri/src/provider_health_commands.rs`
 * and the assessment in `crates/providers/src/health/mod.rs`: health is derived from the mock
 * detection plus labelled mock session observations, and transitions are recorded as
 * `provider.health_changed` / `provider.capacity_changed`, like the native driver.
 *
 * Mock observations (clearly test data; nothing here is measured):
 *   Claude Code  healthy: 2 active sessions, latency samples, no failures, stable trend.
 *   Codex        degraded: 2 recent failures (last `turn_failed`), capacity available.
 *   Gemini CLI   healthy with sign-in unknown (`auth_unknown`), one hour of data.
 * Observations apply only to a provider detection found usable; a provider that isn't installed
 * is unavailable/install, never "healthy". A rate limit appears ONLY in the explicit
 * `providers-backoff` scenario (Codex, `backoffUntil: null`): KalCode never invents one.
 *
 * `?health=error` makes the health commands fail (the UI must not block on them).
 */
import type {
  CapacityState,
  EventPayload,
  HealthRollup,
  HealthState,
  HealthTrend,
  IpcError,
  ProviderHealth,
  ProviderStatus,
  Recoverability,
} from "@kalcode/protocol";

type Handler = (args: Record<string, unknown>) => unknown;
export type HealthCommand = "provider_health_list" | "provider_health_get" | "provider_health_trend";

/** What KalCode "observed" from a provider's sessions (mock values). */
export interface HealthObservation {
  activeSessions: number;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  latencySamples: number;
  recentFailures: number;
  /** Failures since the last successful turn (two or more degrade the provider). */
  failuresSinceSuccess: number;
  lastFailure: { code: string; minutesAgo: number } | null;
  /** A structured rate-limit report (`rate_limited` or `quota_exhausted`). */
  backoff: { code: "rate_limited" | "quota_exhausted" } | null;
  trend: HealthTrend;
  /** Hourly sessions / failures, oldest first, ending with the current hour. */
  hours: readonly (readonly [sessions: number, failures: number])[];
}

export interface HealthControls {
  /** Changes a provider's observations and records any transition (tests). */
  observe(providerId: string, patch: Partial<HealthObservation>): void;
  /** `failing: true` makes every health command fail. */
  configure(options: { failing?: boolean }): void;
}

export interface HealthMemory {
  handlers: Record<HealthCommand, Handler>;
  /** Re-assesses after detection (or an observation) and records transitions. */
  evaluate(): void;
  controls: HealthControls;
}

const ROLLUP_HOURS = 720;
const DEGRADED_AFTER_FAILURES = 2;
const HOUR_MS = 3_600_000;

const NONE: HealthObservation = {
  activeSessions: 0,
  latencyP50Ms: null,
  latencyP95Ms: null,
  latencySamples: 0,
  recentFailures: 0,
  failuresSinceSuccess: 0,
  lastFailure: null,
  backoff: null,
  trend: "insufficient_data",
  hours: [],
};

// Mock hourly series (sessions, failures), oldest first; the last entry is the current hour.
const CLAUDE_HOURS: [number, number][] = [
  [0, 0],
  [0, 0],
  [0, 0],
  [0, 0],
  [0, 0],
  [0, 0],
  [0, 0],
  [0, 0],
  [0, 0],
  [1, 0],
  [3, 0],
  [4, 1],
  [2, 0],
  [5, 0],
  [3, 0],
  [0, 0],
  [2, 0],
  [4, 0],
  [3, 0],
  [2, 0],
  [1, 0],
  [3, 0],
  [2, 0],
  [2, 0],
];
const CODEX_HOURS: [number, number][] = [
  ...Array.from({ length: 18 }, () => [0, 0] as [number, number]),
  [1, 0],
  [2, 0],
  [0, 0],
  [1, 0],
  [1, 0],
  [2, 2],
];

function observations(scenario: string): Record<string, HealthObservation> {
  return {
    "claude-code": {
      ...NONE,
      activeSessions: 2,
      latencyP50Ms: 1800,
      latencyP95Ms: 4200,
      latencySamples: 9,
      trend: "stable",
      hours: CLAUDE_HOURS,
    },
    codex: {
      ...NONE,
      latencyP50Ms: 2600,
      latencyP95Ms: 7900,
      latencySamples: 3,
      recentFailures: 2,
      failuresSinceSuccess: 2,
      lastFailure: { code: "turn_failed", minutesAgo: 6 },
      backoff: scenario === "providers-backoff" ? { code: "rate_limited" } : null,
      trend: "worsening",
      hours: CODEX_HOURS,
    },
    "gemini-cli": {
      ...NONE,
      activeSessions: 1,
      latencyP50Ms: 2100,
      latencyP95Ms: 3500,
      latencySamples: 4,
      trend: "insufficient_data",
      hours: [[2, 0]],
    },
  };
}

interface Assessment {
  state: HealthState;
  capacity: CapacityState;
  recoverability: Recoverability;
  reasonCode: string | null;
  reason: string | null;
}

/** Mirrors `assess` in crates/providers/src/health/mod.rs. */
export function assessHealth(status: ProviderStatus, observed: HealthObservation): Assessment {
  const name = status.displayName;
  const unavailable = (recoverability: Recoverability, reasonCode: string, reason: string): Assessment => ({
    state: "unavailable",
    capacity: "unknown",
    recoverability,
    reasonCode,
    reason,
  });
  const detection = status.detection;
  if (!detection) {
    return {
      state: "unknown",
      capacity: "unknown",
      recoverability: "unknown",
      reasonCode: "not_checked",
      reason: `${name} hasn't been checked yet.`,
    };
  }
  switch (detection.state) {
    case "not_installed":
      return unavailable("install", "not_installed", `${name} isn't installed.`);
    case "outdated":
      return unavailable("update", "outdated", detection.message ?? `${name} needs an update.`);
    case "error":
      return unavailable("restart", "detection_failed", `KalCode couldn't check ${name}. Choose Check again.`);
    case "installed":
      break;
  }
  if (detection.auth === "not_authenticated") {
    return unavailable(
      "sign_in",
      "signed_out",
      `${name} is signed out. Sign in with its own command, then check again.`,
    );
  }
  if (observed.backoff) {
    const quota = observed.backoff.code === "quota_exhausted";
    return {
      state: "degraded",
      capacity: "backing_off",
      recoverability: quota ? "unknown" : "automatic",
      reasonCode: quota ? "quota_exhausted" : "rate_limited",
      reason: quota
        ? `${name} reported that your quota is used up.`
        : `${name} reported a rate limit. New work should wait.`,
    };
  }
  if (observed.failuresSinceSuccess >= DEGRADED_AFTER_FAILURES) {
    return {
      state: "degraded",
      capacity: "available",
      recoverability: "restart",
      reasonCode: "recent_failures",
      reason: `${observed.failuresSinceSuccess} recent ${name} sessions failed without a successful turn since.`,
    };
  }
  const authUnknown = detection.auth === "unknown";
  return {
    state: "healthy",
    capacity: "available",
    recoverability: "none",
    reasonCode: authUnknown ? "auth_unknown" : null,
    reason: authUnknown
      ? status.id === "claude-code"
        ? "Claude Code sign-in is checked when a session starts."
        : `${name} has no documented way to check sign-in, so it shows as unknown.`
      : null,
  };
}

function fail(error: IpcError): never {
  throw error;
}

function usable(status: ProviderStatus): boolean {
  return status.detection?.state === "installed" && status.detection.auth !== "not_authenticated";
}

export function createHealthMemory(options: {
  scenario: string;
  providers: () => readonly ProviderStatus[];
  emit: (event: EventPayload, providerId: string) => void;
  now?: () => number;
}): HealthMemory {
  const { providers, emit } = options;
  const now = options.now ?? Date.now;
  const observed = observations(options.scenario);
  const reported = new Map<string, { state: HealthState; capacity: CapacityState }>();
  let failing = typeof location !== "undefined" && new URLSearchParams(location.search).get("health") === "error";

  const requireHealth = () => {
    if (failing) {
      fail({
        category: "internal",
        code: "health_unavailable",
        message: "Provider health isn't available right now.",
        retryable: true,
      });
    }
  };

  // Observations only count for a provider that can run sessions.
  const observationFor = (status: ProviderStatus): HealthObservation =>
    usable(status) ? (observed[status.id] ?? NONE) : NONE;

  const snapshot = (status: ProviderStatus): ProviderHealth => {
    const o = observationFor(status);
    const a = assessHealth(status, o);
    const d = status.detection;
    return {
      providerId: status.id,
      displayName: status.displayName,
      state: a.state,
      detection: d?.state ?? null,
      auth: d?.auth ?? "unknown",
      accountLabel: null,
      version: d?.version ?? null,
      minimumVersion: d?.minimumVersion ?? null,
      models: status.capabilities.models,
      processRunning: o.activeSessions > 0,
      activeSessions: o.activeSessions,
      latencyP50Ms: o.latencyP50Ms,
      latencyP95Ms: o.latencyP95Ms,
      latencySamples: o.latencySamples,
      recentFailures: o.recentFailures,
      lastFailure: o.lastFailure
        ? { code: o.lastFailure.code, at: new Date(now() - o.lastFailure.minutesAgo * 60_000).toISOString() }
        : null,
      capacity: a.capacity,
      backoffUntil: null,
      trend: o.trend,
      recoverability: a.recoverability,
      reasonCode: a.reasonCode,
      reason: a.reason,
      checkedAt: d?.checkedAt ?? null,
      observedAt: new Date(now()).toISOString(),
    };
  };

  const find = (args: Record<string, unknown>): ProviderStatus => {
    const id = args.providerId;
    const status = providers().find((p) => p.id === id);
    if (!status)
      fail({
        category: "validation",
        code: "unknown_provider",
        message: "KalCode doesn't know that provider.",
        retryable: false,
      });
    return status as ProviderStatus;
  };

  const trend = (status: ProviderStatus, hours: number): HealthRollup[] => {
    const o = observationFor(status);
    const currentHour = Math.floor(now() / HOUR_MS) * HOUR_MS;
    const out: HealthRollup[] = [];
    o.hours.forEach(([sessions, failures], index) => {
      const ago = o.hours.length - 1 - index;
      // Like native: only hours with observations have a bucket.
      if (ago > hours || (sessions === 0 && failures === 0)) return;
      const isCurrent = ago === 0;
      const latency = sessions > 0 ? (isCurrent ? o.latencyP50Ms : 1500 + ((index * 137) % 900)) : null;
      out.push({
        providerId: status.id,
        hourStart: new Date(currentHour - ago * HOUR_MS).toISOString(),
        sessionsStarted: sessions,
        failures,
        backoffs: isCurrent && o.backoff ? 1 : 0,
        latencyP50Ms: latency,
        latencyP95Ms: latency === null ? null : isCurrent ? o.latencyP95Ms : latency * 2,
        samples: sessions,
      });
    });
    return out;
  };

  const evaluate = () => {
    for (const status of providers()) {
      const current = snapshot(status);
      const previous = reported.get(status.id);
      if (previous && previous.state === current.state && previous.capacity === current.capacity) continue;
      const from = previous ?? { state: "unknown" as HealthState, capacity: "unknown" as CapacityState };
      if (!previous && current.state === "unknown") {
        reported.set(status.id, { state: current.state, capacity: current.capacity });
        continue;
      }
      if (from.state !== current.state) {
        emit(
          {
            type: "provider.health_changed",
            payload: {
              providerId: status.id,
              from: from.state,
              to: current.state,
              reason: current.reasonCode ?? "healthy",
            },
          },
          status.id,
        );
      }
      if (from.capacity !== current.capacity && current.capacity !== "unknown") {
        emit(
          {
            type: "provider.capacity_changed",
            payload: {
              providerId: status.id,
              state: current.capacity,
              activeSessions: current.activeSessions,
              limit: null,
              retryAt: null,
            },
          },
          status.id,
        );
      }
      reported.set(status.id, { state: current.state, capacity: current.capacity });
    }
  };

  const handlers: Record<HealthCommand, Handler> = {
    provider_health_list: () => {
      requireHealth();
      return providers().map(snapshot);
    },
    provider_health_get: (args) => {
      requireHealth();
      return snapshot(find(args));
    },
    provider_health_trend: (args) => {
      requireHealth();
      const status = find(args);
      const hours = args.hours;
      if (typeof hours !== "number" || !Number.isInteger(hours) || hours < 1 || hours > ROLLUP_HOURS) {
        fail({
          category: "validation",
          code: "invalid_hours",
          message: "Choose between 1 and 720 hours.",
          retryable: false,
        });
      }
      return trend(status, hours as number);
    },
  };

  return {
    handlers,
    evaluate,
    controls: {
      observe(providerId, patch) {
        observed[providerId] = { ...(observed[providerId] ?? NONE), ...patch };
        evaluate();
      },
      configure(next) {
        if (next.failing !== undefined) failing = next.failing;
      },
    },
  };
}
