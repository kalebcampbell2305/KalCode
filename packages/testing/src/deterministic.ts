/**
 * Deterministic ids and timestamps. Fixtures never call `Date.now()`, `Math.random()` or
 * `crypto.randomUUID()`, so the same seed always produces byte-identical data (stable snapshots,
 * reproducible failures).
 */

/** Default fixture epoch: a fixed instant, so fixture timestamps never depend on the wall clock. */
export const DEFAULT_EPOCH = "2026-09-24T12:00:00.000Z";

/** Canonical hyphenated UUID, the only id shape KalCode accepts over IPC. Mirrors Rust `is_valid_id`. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a canonical hyphenated UUID (any version). Same rule as `kalcode_contracts::is_valid_id`. */
export function isValidId(id: string): boolean {
  return UUID_PATTERN.test(id);
}

/** True for a UUIDv7 (what `new_id()` issues): version nibble 7, RFC 4122 variant. */
export function isUuidV7(id: string): boolean {
  return isValidId(id) && id[14] === "7" && /[89ab]/i.test(id[19] ?? "");
}

/** Small, fast, seedable PRNG (mulberry32). Not for anything security-related. */
export function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hex(value: number, digits: number): string {
  return value.toString(16).padStart(digits, "0");
}

export interface IdFactory {
  /** The next id. UUIDv7-shaped and strictly increasing, so ids sort in creation order. */
  next(): string;
  /** How many ids this factory has issued. */
  readonly issued: number;
}

/**
 * Deterministic UUIDv7 ids. The 48-bit timestamp is `epochMs + n` and the 12-bit `rand_a` field
 * holds `n`, so the n-th id is always the same for a given seed and sorts after the previous one.
 */
export function createIdFactory(options: { seed?: number; epoch?: string } = {}): IdFactory {
  const random = createRandom(options.seed ?? 1);
  const epochMs = Date.parse(options.epoch ?? DEFAULT_EPOCH);
  let issued = 0;
  return {
    next() {
      const n = issued;
      issued += 1;
      const ms = epochMs + n;
      const timeHigh = Math.floor(ms / 0x10000);
      const timeLow = ms % 0x10000;
      const randA = n & 0xfff;
      const variantHigh = 0x8000 | Math.floor(random() * 0x4000);
      const tailHigh = Math.floor(random() * 0x1000000);
      const tailLow = Math.floor(random() * 0x1000000);
      return [
        hex(timeHigh, 8),
        hex(timeLow, 4),
        `7${hex(randA, 3)}`,
        hex(variantHigh, 4),
        `${hex(tailHigh, 6)}${hex(tailLow, 6)}`,
      ].join("-");
    },
    get issued() {
      return issued;
    },
  };
}

export interface FixtureClock {
  /** The current fixture time as RFC 3339 with milliseconds and `Z` (the Rust `now_rfc3339` format). */
  now(): string;
  /** Advances the clock and returns the new time. Defaults to the clock's step. */
  tick(ms?: number): string;
  /** A time relative to the current one without moving the clock (negative = in the past). */
  offset(ms: number): string;
}

/** A manual clock. Starts at `start` and only moves when `tick` is called. */
export function createClock(options: { start?: string; stepMs?: number } = {}): FixtureClock {
  let current = Date.parse(options.start ?? DEFAULT_EPOCH);
  if (Number.isNaN(current)) throw new Error(`Invalid clock start: ${options.start}`);
  const step = options.stepMs ?? 1_000;
  return {
    now: () => new Date(current).toISOString(),
    tick(ms = step) {
      current += ms;
      return new Date(current).toISOString();
    },
    offset: (ms) => new Date(current + ms).toISOString(),
  };
}
