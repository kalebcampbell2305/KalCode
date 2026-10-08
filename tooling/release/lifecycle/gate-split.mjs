// Splits one change-based gate plan across gate.yml's four Windows jobs. Every job runs on the elastic gate
// pool (owner, 2026-10-08): the second Windows PC's gate runners always, the build PC's pool workers while
// it is idle. They test the same event SHA; together they run exactly the selected checks, once each.
//
//   node tooling/release/lifecycle/gate-split.mjs <main|native|e2e|pc2> <id,id,...>   prints that job's ids
//
// "pc2" takes the self-contained JS/web checks; "native" the Rust checks and the Cargo tools (rust,
// cargo-deny/audit); "e2e" the native E2E (its own release build:e2e and the real app); "main" the desktop
// readers and anything new. In one checkout, rust and native E2E's workspace writes serialized them behind
// the desktop readers (lane 7 run 37389408543: [frontend 304 s ‖ UI 677 s] → rust 286 s → native E2E
// 587 s, ~30 min); as separate jobs the chains overlap. Rust then native E2E in one job was still the
// gate's critical path (25-49 min on the build PC, ~76 min on the second PC), so each has its own job.
import { fileURLToPath } from "node:url";

export const PC2_GATES = Object.freeze([
  "biome",
  "branding",
  "capabilities",
  "zero-cost",
  "release-manifest",
  "packages",
  "tooling-unit",
  "api",
  "website",
  "website-e2e",
  "website-checkout-e2e",
  "pnpm-audit",
]);

/** The Rust job: the workspace's Rust checks and the Cargo tools. */
export const NATIVE_GATES = Object.freeze(["rust", "cargo-deny", "cargo-audit"]);

/** The native E2E job: the release build:e2e and the native suite against the real app. */
export const E2E_GATES = Object.freeze(["desktop-native-e2e"]);

const PC2 = new Set(PC2_GATES);
const NATIVE = new Set(NATIVE_GATES);
const E2E = new Set(E2E_GATES);

/** The selected ids for each job, in plan order: disjoint, and together exactly the input. */
export function splitGateIds(ids) {
  const main = [];
  const native = [];
  const e2e = [];
  const pc2 = [];
  for (const id of ids) (PC2.has(id) ? pc2 : NATIVE.has(id) ? native : E2E.has(id) ? e2e : main).push(id);
  return { main, native, e2e, pc2 };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [machine, list = ""] = process.argv.slice(2);
  if (!["main", "native", "e2e", "pc2"].includes(machine)) {
    console.error("usage: gate-split.mjs <main|native|e2e|pc2> <id,id,...>");
    process.exit(2);
  }
  const ids = list
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  process.stdout.write(splitGateIds(ids)[machine].join(","));
}
