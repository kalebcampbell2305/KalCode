/** Summary statistics for repeated measurements. */

export interface Stats {
  n: number;
  min: number;
  median: number;
  mean: number;
  p95: number;
  max: number;
}

/** Linear-interpolated percentile (p in [0, 100]) of an unsorted sample. */
export function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) throw new Error("percentile of an empty sample");
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  const lowValue = sorted[low] ?? 0;
  const highValue = sorted[high] ?? lowValue;
  return lowValue + (highValue - lowValue) * (rank - low);
}

export function summarize(samples: readonly number[]): Stats {
  if (samples.length === 0) throw new Error("summarize of an empty sample");
  return {
    n: samples.length,
    min: Math.min(...samples),
    median: percentile(samples, 50),
    mean: samples.reduce((sum, value) => sum + value, 0) / samples.length,
    p95: percentile(samples, 95),
    max: Math.max(...samples),
  };
}

/** Rounds for reports: 2 decimals below 10, 1 below 1000, integers above. */
export function round(value: number): number {
  if (Math.abs(value) < 10) return Math.round(value * 100) / 100;
  if (Math.abs(value) < 1000) return Math.round(value * 10) / 10;
  return Math.round(value);
}
