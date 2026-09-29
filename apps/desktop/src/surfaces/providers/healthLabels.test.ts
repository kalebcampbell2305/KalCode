import type { ProviderHealth, ProviderStatus } from "@kalcode/protocol";
import { describe, expect, it } from "vitest";
import { providerCatalog } from "../../ipc/memoryProviders.ts";
import {
  failuresText,
  formatMs,
  healthStateLabel,
  healthSummary,
  historySummary,
  hourSlots,
  latencyText,
  processText,
  rateLimitText,
  recoveryHint,
  signInText,
  trendLabel,
  versionText,
} from "./healthLabels.ts";

const [claude, codex, gemini] = providerCatalog() as [ProviderStatus, ProviderStatus, ProviderStatus];
const NOW = Date.parse("2026-09-25T12:30:00Z");

function health(partial: Partial<ProviderHealth> = {}): ProviderHealth {
  return {
    providerId: "codex",
    displayName: "Codex",
    state: "healthy",
    detection: "installed",
    auth: "authenticated",
    accountLabel: null,
    version: "0.155.1",
    minimumVersion: "0.155.0",
    models: [],
    processRunning: false,
    activeSessions: 0,
    latencyP50Ms: null,
    latencyP95Ms: null,
    latencySamples: 0,
    recentFailures: 0,
    lastFailure: null,
    capacity: "available",
    backoffUntil: null,
    trend: "stable",
    recoverability: "none",
    reasonCode: null,
    reason: null,
    checkedAt: "2026-09-25T12:00:00Z",
    observedAt: "2026-09-25T12:30:00Z",
    ...partial,
  };
}

describe("provider health labels", () => {
  it("shows the overall state with words and the snapshot's reason", () => {
    expect(healthStateLabel(health())).toEqual({ tone: "success", label: "Healthy", detail: null });
    expect(healthStateLabel(health({ state: "degraded", reason: "2 recent Codex sessions failed." }))).toEqual({
      tone: "waiting",
      label: "Degraded",
      detail: "2 recent Codex sessions failed.",
    });
    expect(healthStateLabel(health({ state: "unavailable" })).tone).toBe("danger");
    expect(healthStateLabel(health({ state: "unknown" })).label).toBe("Unknown");
  });

  it("reports process, version and latency without inventing values", () => {
    expect(processText(health())).toBe("Not running");
    expect(processText(health({ processRunning: true, activeSessions: 2 }))).toBe("Running · 2 active sessions");
    expect(versionText(health())).toBe("Version 0.155.1 · needs 0.155.0 or later");
    expect(versionText(health({ minimumVersion: null }))).toBe("Version 0.155.1 · no minimum declared");
    expect(versionText(health({ version: null, minimumVersion: null }))).toBe(
      "Version not detected · no minimum declared",
    );
    expect(latencyText(health())).toBe("No sessions in the last 15 minutes");
    expect(latencyText(health({ latencyP50Ms: 1800, latencyP95Ms: 4200, latencySamples: 9 }))).toBe(
      "p50 1.8 s · p95 4.2 s · 9 samples, last 15 minutes",
    );
    expect(formatMs(640)).toBe("640 ms");
    expect(formatMs(12_400)).toBe("12 s");
  });

  it("reports sign-in exactly as the provider does", () => {
    expect(signInText(health(), codex)).toMatchObject({
      label: "Signed in",
      detail: "Checked with codex login status.",
    });
    expect(signInText(health({ auth: "not_authenticated" }), codex).label).toBe("Signed out");
    expect(signInText(health({ displayName: "Gemini CLI", auth: "unknown" }), gemini).label).toBe(
      "Gemini CLI has no documented way to check sign-in",
    );
    expect(signInText(health({ detection: "not_installed" }), codex).label).toBe("Not checked");
  });

  it("lists recent failures with the last code and when", () => {
    expect(failuresText(health(), NOW)).toBe("None in the last hour");
    expect(
      failuresText(
        health({ recentFailures: 2, lastFailure: { code: "turn_failed", at: "2026-09-25T12:24:00Z" } }),
        NOW,
      ),
    ).toMatch(/^2 failures in the last hour · last: turn_failed, 6 minutes ago$/);
  });

  it("mentions a rate limit only when the provider reported one", () => {
    expect(rateLimitText(health())).toEqual({ tone: "idle", label: "None reported", detail: null });
    expect(rateLimitText(health({ capacity: "saturated" })).label).toBe("None reported");
    const limited = rateLimitText(health({ capacity: "backing_off", reasonCode: "rate_limited" }));
    expect(limited.label).toBe("Codex reported a rate limit");
    expect(limited.detail).toBe("Codex didn't say when to retry. New work waits.");
    expect(rateLimitText(health({ capacity: "backing_off", reasonCode: "quota_exhausted" })).label).toBe(
      "Codex reported that your quota is used up",
    );
    expect(limited.label).not.toMatch(/\d/);
  });

  it("names the trend", () => {
    expect(trendLabel("improving")).toBe("Improving");
    expect(trendLabel("stable")).toBe("Stable");
    expect(trendLabel("worsening")).toBe("Worsening");
    expect(trendLabel("insufficient_data")).toBe("Not enough data yet");
  });

  it("hints at the provider's own recovery commands", () => {
    expect(recoveryHint(health())).toBeNull();
    expect(recoveryHint(health({ displayName: "Gemini CLI", recoverability: "install" }), gemini)).toEqual({
      text: "Install Gemini CLI in a terminal, then choose Check again.",
      command: "npm install -g @google/gemini-cli@0.61.0",
    });
    expect(recoveryHint(health({ recoverability: "sign_in" }), codex)?.command).toBe("codex login");
    // A terminal `gemini` signs in a standalone profile that managed Gemini threads never use.
    expect(
      recoveryHint(health({ providerId: "gemini-cli", displayName: "Gemini CLI", recoverability: "sign_in" }), gemini),
    ).toEqual({
      text: "Sign in to the Gemini CLI account in Providers, Accounts, then choose Check again.",
      command: null,
    });
    expect(
      recoveryHint(health({ displayName: "Claude Code", recoverability: "update", minimumVersion: "2.1.259" }), claude)
        ?.text,
    ).toBe("Update Claude Code to version 2.1.259 or later, then choose Check again.");
    expect(recoveryHint(health({ recoverability: "restart", reasonCode: "recent_failures" }))?.text).toBe(
      "Restart the affected thread, or choose Check again.",
    );
    expect(recoveryHint(health({ recoverability: "unknown", reasonCode: "not_checked" }))?.text).toBe(
      "Choose Check again to check it.",
    );
  });

  it("summarizes each provider in one short line for the dashboard", () => {
    expect(healthSummary(health({ activeSessions: 2, processRunning: true }))).toEqual({
      text: "Healthy · 2 sessions",
      tone: "ok",
    });
    expect(healthSummary(health({ state: "degraded", recentFailures: 2, reasonCode: "recent_failures" }))).toEqual({
      text: "Degraded · 2 failures in the last hour",
      tone: "warn",
    });
    expect(healthSummary(health({ state: "degraded", capacity: "backing_off", reasonCode: "rate_limited" })).text).toBe(
      "Backing off · rate limit reported",
    );
    expect(healthSummary(health({ state: "unavailable", reasonCode: "signed_out" }))).toEqual({
      text: "Signed out",
      tone: "bad",
    });
    expect(healthSummary(health({ state: "unavailable", reasonCode: "not_installed" })).text).toBe("Not installed");
    expect(healthSummary(health({ state: "unknown", reasonCode: "not_checked" }))).toEqual({
      text: "Not checked yet",
      tone: "muted",
    });
    expect(healthSummary(health({ state: "unknown", reasonCode: "health_unavailable" })).text).toBe("Health unknown");
  });

  it("fills the last 24 hours from sparse rollups", () => {
    const slots = hourSlots(
      [
        {
          providerId: "codex",
          hourStart: "2026-09-25T12:00:00.000Z",
          sessionsStarted: 2,
          failures: 2,
          backoffs: 0,
          latencyP50Ms: 2600,
          latencyP95Ms: 7900,
          samples: 2,
        },
        {
          providerId: "codex",
          hourStart: "2026-09-25T09:00:00.000Z",
          sessionsStarted: 1,
          failures: 0,
          backoffs: 0,
          latencyP50Ms: 1500,
          latencyP95Ms: 3000,
          samples: 1,
        },
      ],
      24,
      NOW,
    );
    expect(slots).toHaveLength(24);
    expect(slots.at(-1)).toMatchObject({ hourStart: "2026-09-25T12:00:00.000Z", sessions: 2, failures: 2 });
    expect(slots.at(-4)).toMatchObject({ sessions: 1, failures: 0 });
    expect(slots[0]?.hourStart).toBe("2026-09-24T13:00:00.000Z");
    expect(historySummary(slots)).toBe("3 sessions, 2 failures in the last 24 hours");
    expect(historySummary(hourSlots([], 24, NOW))).toBe("No sessions in the last 24 hours");
  });
});
