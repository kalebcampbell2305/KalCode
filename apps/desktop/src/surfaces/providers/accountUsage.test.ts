import { describe, expect, it } from "vitest";
import {
  type AccountUsageState,
  limitingWindow,
  notChecked,
  primaryUsageLabel,
  resetsIn,
  type UsageWindow,
  usageAbsenceLabel,
  usageFill,
  usagePercent,
  usageSummary,
  weeklyWindow,
  windowAppliesToModel,
} from "./accountUsage.ts";

const NOW = Date.parse("2026-10-03T17:00:00.000Z");

function state(status: AccountUsageState["status"], remaining: number[] = []): AccountUsageState {
  return {
    accountId: "claude-a",
    status,
    windows: remaining.map((remainingPercent, index) => ({
      id: index === 0 ? "five_hour" : "weekly",
      label: index === 0 ? "5-hour" : "Weekly",
      remainingPercent,
      resetsAt: null,
    })),
    checkedAt: status === "fresh" || status === "stale" ? "2026-10-03T16:59:00.000Z" : null,
    reason: null,
  };
}

function win(id: string, label: string, remainingPercent: number): UsageWindow {
  return { id, label, remainingPercent, resetsAt: null };
}

function withWindows(accountId: string, windows: UsageWindow[], status: AccountUsageState["status"] = "fresh") {
  return { accountId, status, windows, checkedAt: "2026-10-03T16:59:00.000Z", reason: null } as AccountUsageState;
}

describe("account usage helpers", () => {
  it("picks the most constrained window as the limiting one", () => {
    expect(limitingWindow(state("fresh", [64, 42]), null)?.id).toBe("weekly");
    expect(limitingWindow(state("fresh", [8, 42]), null)?.id).toBe("five_hour");
    expect(limitingWindow(notChecked("claude-a"), null)).toBeNull();
  });

  it("selects the account's own all-model weekly window, never a rolling or model-scoped one", () => {
    expect(weeklyWindow(state("fresh", [8, 42]))?.id).toBe("weekly");
    expect(weeklyWindow(state("stale", [8, 42]))?.id).toBe("weekly");
    expect(weeklyWindow(state("fresh", [8]))).toBeNull();
    expect(weeklyWindow(notChecked("claude-a"))).toBeNull();
    expect(weeklyWindow({ ...state("checking"), windows: state("fresh", [8, 42]).windows })).toBeNull();
    // Model-scoped weekly limits are details, not the primary number.
    const scoped = withWindows("claude-a", [win("five_hour", "5-hour", 50), win("weekly_opus", "Weekly Opus", 3)]);
    expect(weeklyWindow(scoped)).toBeNull();
    const claude = withWindows("claude-a", [
      win("weekly_opus", "Weekly Opus", 3),
      win("five_hour", "5-hour", 50),
      win("weekly", "Weekly", 73),
    ]);
    expect(weeklyWindow(claude)?.id).toBe("weekly");
    // Codex: a second 10080-minute window keeps its slot id but the "Weekly" label; a 7-day label counts.
    expect(
      weeklyWindow(withWindows("codex-a", [win("primary", "5-hour", 9), win("secondary", "Weekly", 61)]))?.id,
    ).toBe("secondary");
    expect(weeklyWindow(withWindows("codex-a", [win("secondary", "7-day", 61)]))?.remainingPercent).toBe(61);
    expect(
      weeklyWindow(withWindows("codex-a", [win("primary", "1-day", 61), win("secondary", "30-day", 2)])),
    ).toBeNull();
    // An unreported weekly value is not a weekly window.
    expect(weeklyWindow(state("fresh", [40, Number.NaN]))).toBeNull();
  });

  it("shows WEEKLY remaining as the primary number even when the 5-hour window is lower", () => {
    expect(usageSummary(state("fresh", [8, 73]))).toEqual({ short: "73% left", low: false, tone: "ok" });
    expect(primaryUsageLabel(state("fresh", [8, 73]))).toBe("73% of weekly usage left");
    // Low/tone follow the weekly window too.
    expect(usageSummary(state("fresh", [90, 12]))).toEqual({ short: "12% left", low: true, tone: "low" });
  });

  it("never falls back to the 5-hour window when no weekly window is reported", () => {
    expect(usageSummary(state("fresh", [8]))).toEqual({ short: "Weekly usage unavailable", low: false, tone: "muted" });
    expect(primaryUsageLabel(state("fresh", [8]))).toBe("No weekly limit reported for this account");
    expect(usageSummary(withWindows("claude-a", [win("weekly_opus", "Weekly Opus", 40)])).short).toBe(
      "Weekly usage unavailable",
    );
  });

  it("keeps each account's usage to itself", () => {
    const a = withWindows("claude-a", [win("five_hour", "5-hour", 30)]);
    const b = withWindows("claude-b", [win("five_hour", "5-hour", 90), win("weekly", "Weekly", 55)]);
    expect(usageSummary(a).short).toBe("Weekly usage unavailable");
    expect(usageSummary(b).short).toBe("55% left");
    expect(weeklyWindow(a)).toBeNull();
    expect(weeklyWindow(b)).toBe(b.windows[1]);
  });

  it("summarises real numbers, low usage and every non-numeric state truthfully", () => {
    expect(usageSummary(state("fresh", [64, 42]))).toEqual({ short: "42% left", low: false, tone: "ok" });
    expect(usageSummary(state("stale", [0, 50]))).toEqual({ short: "Usage unavailable", low: false, tone: "muted" });
    expect(primaryUsageLabel(state("stale", [0, 50]))).toBeNull();
    expect(usageSummary(state("fresh", [70, 19.4]))).toEqual({ short: "19% left", low: true, tone: "low" });
    expect(usageSummary(state("fresh", [50, 0]))).toMatchObject({ short: "0% left", low: true });
    expect(usageSummary(state("fresh", [50, 0.1]))).toMatchObject({ short: "<1% left", low: true });
    expect(usageSummary(state("checking")).short).toBe("Checking usage…");
    expect(usageSummary(state("unavailable"))).toEqual({ short: "Usage unavailable", low: false, tone: "muted" });
    expect(usageSummary(notChecked("claude-a", "Signed out")).short).toBe("Usage unavailable");
    // Numbers are never shown for a state that doesn't carry them.
    expect(usageSummary({ ...state("not_checked"), windows: state("fresh", [50, 50]).windows }).short).toBe(
      "Usage unavailable",
    );
  });

  it.each([null, undefined, "0", Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -3, 101])(
    "never treats invalid measurement %s as a quota",
    (value) => {
      expect(usageSummary(state("fresh", [value as number]))).toEqual({
        short: "Usage unavailable",
        low: false,
        tone: "muted",
      });
      expect(limitingWindow(state("fresh", [value as number, 62]), null)?.remainingPercent).toBe(62);
    },
  );

  it("formats reset countdowns", () => {
    const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();
    expect(resetsIn(at(2 * 60 + 14), NOW)).toBe("Resets in 2h 14m");
    expect(resetsIn(at(3 * 1440 + 5 * 60), NOW)).toBe("Resets in 3d 5h");
    expect(resetsIn(at(0.2), NOW)).toBe("Resets in 1m");
    expect(resetsIn(at(-5), NOW)).toBe("Resets now");
    expect(resetsIn(null, NOW)).toBeNull();
    expect(resetsIn("not a time", NOW)).toBeNull();
  });

  it("never renders a positive fraction under 1% as 0% or an empty bar (#284)", () => {
    expect(usagePercent(0.4)).toBe("<1");
    expect(usagePercent(0)).toBe("0");
    expect(usagePercent(99.6)).toBe("100");
    expect(usageFill(0.4)).toBeGreaterThan(0);
    expect(usageFill(0)).toBe(0);
    expect(usageFill(42.5)).toBe(42.5);
    expect(usageFill(Number.NaN)).toBe(0);
    expect(usageSummary(withWindows("a", [win("weekly", "Weekly", 0.4)])).short).toBe("<1% left");
  });

  it("applies a model-scoped weekly window only to the model it names (#284)", () => {
    const fable = win("weekly_fable", "Weekly Fable", 3);
    const usage = withWindows("a", [win("weekly", "Weekly", 70), win("five_hour", "5-hour", 60), fable]);
    for (const model of ["claude-opus-4-6", "claude-sonnet-4-6", null, ""]) {
      expect(windowAppliesToModel(fable, model)).toBe(false);
      expect(limitingWindow(usage, model)?.id).toBe("five_hour");
    }
    expect(windowAppliesToModel(fable, "claude-fable-1")).toBe(true);
    expect(limitingWindow(usage, "claude-fable-1")?.id).toBe("weekly_fable");
    // Slugs from multi-word display names ("Opus 4.1" → weekly_opus_4_1) match dotted/dashed ids.
    expect(windowAppliesToModel(win("weekly_opus_4_1", "Weekly Opus 4.1", 5), "claude-opus-4-1")).toBe(true);
    expect(windowAppliesToModel(win("weekly_opus_4_1", "Weekly Opus 4.1", 5), "claude-opus-4-6")).toBe(false);
    // Non-model-scoped windows always apply, whatever the model.
    for (const id of ["weekly", "five_hour", "primary", "secondary"])
      expect(windowAppliesToModel(win(id, id, 5), "claude-fable-1")).toBe(true);
  });

  it("says Usage unavailable for unreadable readings and not checked only before any read (#284)", () => {
    expect(usageAbsenceLabel(notChecked("a", "Provider usage is unavailable"))).toBe("Usage unavailable");
    expect(usageAbsenceLabel(notChecked("a", "Signed out"))).toBe("Usage unavailable");
    expect(usageAbsenceLabel({ ...notChecked("a", "Unreadable"), status: "unavailable" })).toBe("Usage unavailable");
    expect(usageAbsenceLabel(withWindows("a", [win("weekly", "Weekly", Number.NaN)]))).toBe("Usage unavailable");
    expect(usageAbsenceLabel(state("checking"))).toBe("Checking usage…");
    expect(usageAbsenceLabel(notChecked("a"))).toBe("Usage not checked yet");
  });
});
