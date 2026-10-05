// Splits one change-based gate plan between the two Windows gate machines (owner, 2026-10-05: "some
// tests running on this computer, and some tests running on the other Windows computer"). Both jobs of
// a gate.yml run test the same event SHA; together they run exactly the selected checks, once each.
//
//   node tooling/release/lifecycle/gate-split.mjs <main|pc2> <id,id,...>   prints that machine's ids
//
// The second PC takes the self-contained JS/web checks. Everything else (Rust, the desktop frontend,
// UI and native E2E, and any check added later) stays on the build PC's pool, which has the warm
// Cargo targets, CMake/libclang and the provider CLIs those checks need.
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

const PC2 = new Set(PC2_GATES);

/** The selected ids for each machine, in plan order: disjoint, and together exactly the input. */
export function splitGateIds(ids) {
  const main = [];
  const pc2 = [];
  for (const id of ids) (PC2.has(id) ? pc2 : main).push(id);
  return { main, pc2 };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [machine, list = ""] = process.argv.slice(2);
  if (machine !== "main" && machine !== "pc2") {
    console.error("usage: gate-split.mjs <main|pc2> <id,id,...>");
    process.exit(2);
  }
  const ids = list
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  process.stdout.write(splitGateIds(ids)[machine].join(","));
}
