import { describe, expect, it } from "vitest";
import { ARR_MILESTONES_USD, compactUsd, milestoneLadder, milestoneProgress } from "../../src/lib/owner-milestones";

describe("ARR milestones", () => {
  it("is the owner's ladder from $1K to $1M", () => {
    expect(ARR_MILESTONES_USD).toEqual([1_000, 5_000, 10_000, 25_000, 50_000, 100_000, 250_000, 500_000, 1_000_000]);
  });

  it("starts at $0 with $1K next and nothing reached", () => {
    expect(milestoneProgress(0)).toEqual({ reached: null, next: 1_000, remaining: 1_000, progress: 0, nextIndex: 0 });
    expect(milestoneProgress(Number.NaN).next).toBe(1_000);
    expect(milestoneProgress(-5).remaining).toBe(1_000);
  });

  it("measures progress from the last reached milestone", () => {
    const p = milestoneProgress(257_720);
    expect(p).toMatchObject({ reached: 250_000, next: 500_000, remaining: 242_280 });
    expect(p.progress).toBeCloseTo(7_720 / 250_000, 9);
    expect(milestoneProgress(120).progress).toBeCloseTo(0.12, 9);
  });

  it("treats an exact milestone as reached, with the next one ahead", () => {
    expect(milestoneProgress(10_000)).toMatchObject({ reached: 10_000, next: 25_000, remaining: 15_000, progress: 0 });
  });

  it("keeps climbing past $1M", () => {
    expect(milestoneProgress(1_000_000)).toMatchObject({ reached: 1_000_000, next: 2_500_000 });
    expect(milestoneProgress(12_000_000)).toMatchObject({ reached: 10_000_000, next: 25_000_000 });
    expect(milestoneLadder(0)).toHaveLength(9);
  });

  it("formats milestones compactly", () => {
    expect([1_000, 25_000, 250_000, 1_000_000, 2_500_000, 999].map(compactUsd)).toEqual([
      "$1K",
      "$25K",
      "$250K",
      "$1M",
      "$2.5M",
      "$999",
    ]);
  });
});
