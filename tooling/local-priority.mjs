// Agents' local heavy builds and test runs yield the CPU to the gate (owner-approved, 2026-10-06).
//
// The self-hosted gate runs its whole process tree at below-normal priority so the owner's UI and
// agents stay responsive (.github/workflows/gate.yml). Local builds started by agents ran at normal
// priority, so on a saturated build PC Windows starved the gate's threads: timer wake-ups in
// timing-sensitive tests arrived seconds late and lane gates failed on load alone (gate 37393478801:
// a 1-2 s RPC deadline, a 6.5 s stall bound measured at 11.4 s, UI click timeouts). Local heavy work
// now lowers its own priority to match. Child processes inherit a below-normal or idle class on
// Windows and a raised niceness elsewhere, so lowering the wrapper lowers its whole tree.
//
//   KALCODE_LOCAL_PRIORITY=below-normal (default) | idle | normal (opt out)
//
// CI is left alone: the gate sets its own priority, and a hosted runner has nothing to yield to.
import { constants, setPriority } from "node:os";

const LEVELS = Object.freeze({
  "below-normal": constants.priority.PRIORITY_BELOW_NORMAL,
  idle: constants.priority.PRIORITY_LOW,
});

/** The priority local heavy work should take, or null to leave it unchanged. */
export function localPriority(env = process.env) {
  if (env.CI || env.GITHUB_ACTIONS) return null;
  const requested = (env.KALCODE_LOCAL_PRIORITY ?? "below-normal").trim().toLowerCase();
  if (requested === "normal") return null;
  const level = LEVELS[requested];
  if (level === undefined) {
    throw new Error(`KALCODE_LOCAL_PRIORITY must be below-normal, idle or normal (got "${requested}")`);
  }
  return level;
}

/**
 * Lowers this process (and so everything it starts afterwards) for local heavy work. Never raises
 * priority and never fails the build: a refused change leaves the process as it was.
 */
export function lowerLocalPriority({ env = process.env, set = setPriority } = {}) {
  const level = localPriority(env);
  if (level === null) return null;
  try {
    set(0, level);
    return level;
  } catch {
    return null;
  }
}
