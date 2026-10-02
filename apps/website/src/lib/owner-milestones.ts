/**
 * ARR milestones for the private owner dashboard (docs/OWNER_ANALYTICS.md). Pure: the dashboard
 * passes the real ARR from /v1/insights/revenue; nothing here invents a number.
 */

/** Whole-dollar ARR milestones. Past $1M the ladder continues 2.5×/2×/2× per decade. */
export const ARR_MILESTONES_USD = [1_000, 5_000, 10_000, 25_000, 50_000, 100_000, 250_000, 500_000, 1_000_000] as const;

export interface MilestoneProgress {
  /** Highest milestone reached (ARR ≥ it), or null before the first. */
  reached: number | null;
  /** The next milestone above ARR. */
  next: number;
  /** Dollars from ARR to `next` (never negative). */
  remaining: number;
  /** 0..1 progress from the previous milestone (or $0) to `next`. */
  progress: number;
  /** Index of `next` in the full ladder (milestones beyond $1M included). */
  nextIndex: number;
}

/** The ladder up to and including the first milestone above `arrUsd`. */
export function milestoneLadder(arrUsd: number): number[] {
  const ladder: number[] = [...ARR_MILESTONES_USD];
  let decade = 1_000_000;
  while ((ladder.at(-1) as number) <= arrUsd) {
    for (const factor of [2.5, 5, 10]) ladder.push(decade * factor);
    decade *= 10;
  }
  return ladder;
}

export function milestoneProgress(arrUsd: number): MilestoneProgress {
  const arr = Number.isFinite(arrUsd) && arrUsd > 0 ? arrUsd : 0;
  const ladder = milestoneLadder(arr);
  const nextIndex = ladder.findIndex((m) => m > arr);
  const next = ladder[nextIndex] as number;
  const reached = nextIndex > 0 ? (ladder[nextIndex - 1] as number) : null;
  const floor = reached ?? 0;
  return {
    reached,
    next,
    remaining: Math.max(0, next - arr),
    progress: Math.min(1, Math.max(0, (arr - floor) / (next - floor))),
    nextIndex,
  };
}

/** "$1K", "$25K", "$250K", "$1M", "$2.5M". */
export function compactUsd(value: number): string {
  if (value >= 1_000_000) return `$${trim(value / 1_000_000)}M`;
  if (value >= 1_000) return `$${trim(value / 1_000)}K`;
  return `$${Math.round(value)}`;
}

function trim(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, "");
}
