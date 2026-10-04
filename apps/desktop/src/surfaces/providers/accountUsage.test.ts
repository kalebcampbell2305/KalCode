import { describe, expect, it } from "vitest";
import { type AccountUsageState, limitingWindow, notChecked, resetsIn, usageSummary } from "./accountUsage.ts";

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

describe("account usage helpers", () => {
  it("picks the most constrained window as the limiting one", () => {
    expect(limitingWindow(state("fresh", [64, 42]))?.id).toBe("weekly");
    expect(limitingWindow(state("fresh", [8, 42]))?.id).toBe("five_hour");
    expect(limitingWindow(notChecked("claude-a"))).toBeNull();
  });

  it("summarises real numbers, low usage and every non-numeric state truthfully", () => {
    expect(usageSummary(state("fresh", [64, 42]))).toEqual({ short: "42% left", low: false, tone: "ok" });
    expect(usageSummary(state("stale", [0]))).toEqual({ short: "Usage unavailable", low: false, tone: "muted" });
    expect(usageSummary(state("fresh", [19.4, 70]))).toEqual({ short: "19% left", low: true, tone: "low" });
    expect(usageSummary(state("fresh", [0]))).toMatchObject({ short: "0% left", low: true });
    expect(usageSummary(state("fresh", [0.1]))).toMatchObject({ short: "<1% left", low: true });
    expect(usageSummary(state("checking")).short).toBe("Checking usage…");
    expect(usageSummary(state("unavailable"))).toEqual({ short: "Usage unavailable", low: false, tone: "muted" });
    expect(usageSummary(notChecked("claude-a", "Signed out")).short).toBe("Usage unavailable");
    // Numbers are never shown for a state that doesn't carry them.
    expect(usageSummary({ ...state("not_checked"), windows: state("fresh", [50]).windows }).short).toBe(
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
      expect(limitingWindow(state("fresh", [value as number, 62]))?.remainingPercent).toBe(62);
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
});
