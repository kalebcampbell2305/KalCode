import { describe, expect, it } from "vitest";
import { addMonthsClamped, periodContaining } from "../../worker/lib/period";

const d = (iso: string) => new Date(iso);
const iso = (p: { start: Date; end: Date }) => [p.start.toISOString(), p.end.toISOString()];

describe("addMonthsClamped", () => {
  it("clamps to the month's last day without drifting", () => {
    const anchor = d("2026-01-31T10:20:30.400Z");
    expect([1, 2, 3, 12, 13, 25].map((m) => addMonthsClamped(anchor, m).toISOString())).toEqual([
      "2026-02-28T10:20:30.400Z",
      "2026-03-31T10:20:30.400Z",
      "2026-04-30T10:20:30.400Z",
      "2027-01-31T10:20:30.400Z",
      "2027-02-28T10:20:30.400Z",
      "2028-02-29T10:20:30.400Z",
    ]);
  });
});

describe("periodContaining", () => {
  const anchor = d("2026-01-31T10:00:00.000Z");

  it("finds the monthly cycle containing now", () => {
    expect(iso(periodContaining(anchor, d("2026-01-31T10:00:00.000Z")))).toEqual([
      "2026-01-31T10:00:00.000Z",
      "2026-02-28T10:00:00.000Z",
    ]);
    expect(iso(periodContaining(anchor, d("2026-02-28T09:59:59.999Z")))).toEqual([
      "2026-01-31T10:00:00.000Z",
      "2026-02-28T10:00:00.000Z",
    ]);
    expect(iso(periodContaining(anchor, d("2026-02-28T10:00:00.000Z")))).toEqual([
      "2026-02-28T10:00:00.000Z",
      "2026-03-31T10:00:00.000Z",
    ]);
    expect(iso(periodContaining(anchor, d("2026-03-15T00:00:00.000Z")))).toEqual([
      "2026-02-28T10:00:00.000Z",
      "2026-03-31T10:00:00.000Z",
    ]);
    expect(iso(periodContaining(anchor, d("2030-12-31T23:00:00.000Z")))).toEqual([
      "2030-12-31T10:00:00.000Z",
      "2031-01-31T10:00:00.000Z",
    ]);
  });

  it("puts times before the anchor in the first cycle", () => {
    expect(iso(periodContaining(anchor, d("2025-12-01T00:00:00.000Z")))).toEqual([
      "2026-01-31T10:00:00.000Z",
      "2026-02-28T10:00:00.000Z",
    ]);
  });

  it("always contains now and is at most one month long", () => {
    const start = d("2026-05-31T23:59:59.999Z");
    for (let t = start.getTime(); t < start.getTime() + 800 * 86_400_000; t += 86_400_000 * 0.37) {
      const now = new Date(t);
      const period = periodContaining(start, now);
      expect(period.start.getTime()).toBeLessThanOrEqual(t);
      expect(period.end.getTime()).toBeGreaterThan(t);
      expect(period.end.getTime() - period.start.getTime()).toBeLessThanOrEqual(31 * 86_400_000);
    }
  });
});
