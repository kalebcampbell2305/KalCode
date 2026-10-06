// Splits one change-based gate plan across the build PC's gate jobs. Every job of a gate.yml run tests the
// same event SHA on its own pool worker and checkout; together they run exactly the selected checks, once each.
//
//   node tooling/release/lifecycle/gate-split.mjs <main|native|web> <id,id,...>   prints that job's ids
//
// Gates run only on the build PC (owner, 2026-10-06: "we need to find a faster way to ship things"). The
// second PC ran checks 3-8x slower (each git ~1.3 s vs ~0.14 s; desktop suites timed out there, trial
// 37402429693) and its single runner serialized every lane's PC2 half; it now runs release QA only. Three
// jobs on three pool workers overlap: "native" (the checks that write the checkout or need the pool's Cargo
// tools: rust, native E2E, cargo-deny/audit), "web" (the self-contained JS/web checks that ran on the
// second PC) and "main" (the desktop frontend/UI readers and any check added later).
import { fileURLToPath } from "node:url";

/** The build PC's web job: self-contained JS/web checks (they ran on the second PC until 2026-10-06). */
export const WEB_GATES = Object.freeze([
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

/** The build PC's second job: checkout writers (rust, native E2E) and the pool-only Cargo tools. */
export const NATIVE_GATES = Object.freeze(["rust", "desktop-native-e2e", "cargo-deny", "cargo-audit"]);

const WEB = new Set(WEB_GATES);
const NATIVE = new Set(NATIVE_GATES);

/** The selected ids for each job, in plan order: disjoint, and together exactly the input. */
export function splitGateIds(ids) {
  const main = [];
  const native = [];
  const web = [];
  for (const id of ids) (WEB.has(id) ? web : NATIVE.has(id) ? native : main).push(id);
  return { main, native, web };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [machine, list = ""] = process.argv.slice(2);
  if (machine !== "main" && machine !== "native" && machine !== "web") {
    console.error("usage: gate-split.mjs <main|native|web> <id,id,...>");
    process.exit(2);
  }
  const ids = list
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  process.stdout.write(splitGateIds(ids)[machine].join(","));
}
