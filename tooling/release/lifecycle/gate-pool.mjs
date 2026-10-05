// Checks share a checkout, so parallelism follows explicit read/write resources.
// Unknown checks run exclusively; a failed dependency never lends a false PASS.
export const DEFAULT_GATE_JOBS = 4;

export function gateScheduling(id) {
  const readers = { workspace: "read" };
  if (["rust", "desktop-native-e2e"].includes(id)) return { resources: { workspace: "write" } };
  if (["website", "website-e2e", "website-checkout-e2e"].includes(id)) {
    return {
      resources: { ...readers, website: "write", ...(id !== "website" ? { browser: "write" } : {}) },
      dependsOn: id === "website" ? [] : ["website"],
    };
  }
  if (id === "desktop-ui") return { resources: { ...readers, browser: "write" } };
  if (
    [
      "biome",
      "branding",
      "capabilities",
      "zero-cost",
      "release-manifest",
      "tooling-unit",
      "packages",
      "api",
      "desktop-frontend",
      "cargo-deny",
      "pnpm-audit",
      "cargo-audit",
    ].includes(id)
  ) {
    return { resources: readers };
  }
  return { resources: { workspace: "write" } };
}

function conflicts(left, right) {
  return Object.entries(left).some(([key, mode]) => right[key] && (mode === "write" || right[key] === "write"));
}

export async function runGatePool(
  plan,
  runOne,
  {
    jobs = DEFAULT_GATE_JOBS,
    keepGoing = true,
    signal,
    capacity = () => jobs,
    pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    pressureTimeoutMs = 10 * 60_000,
    now = Date.now,
  } = {},
) {
  if (!Number.isInteger(jobs) || jobs < 1 || jobs > 4) throw new Error("gate jobs must be an integer from 1 to 4");
  const ids = new Set(plan.map((gate) => gate.id));
  if (ids.size !== plan.length) throw new Error("duplicate gate ids");
  const pending = plan.map((gate, index) => {
    const scheduling = { ...gateScheduling(gate.id), ...gate.scheduling };
    return {
      gate,
      index,
      ...scheduling,
      resources: {
        ...scheduling.resources,
        ...Object.fromEntries((gate.exclusive ?? []).map((resource) => [`policy:${resource}`, "write"])),
      },
    };
  });
  const active = new Map();
  const completed = new Map();
  const results = new Array(plan.length);
  let failed = false;
  let pressureSince = null;
  const finish = (item, result) => {
    results[item.index] = result;
    completed.set(item.gate.id, result);
    if (result.state !== "pass" && result.state !== "unavailable") failed = true;
  };
  while (pending.length || active.size) {
    let progressed = false;
    const available = Math.max(0, Math.min(jobs, Number(await capacity()) || 0));
    for (let i = 0; i < pending.length && (active.size < available || signal?.aborted); ) {
      const item = pending[i];
      const deps = (item.dependsOn ?? []).filter((id) => ids.has(id));
      const failedDeps = deps.filter((id) => completed.has(id) && completed.get(id).state !== "pass");
      if (signal?.aborted || (failed && !keepGoing) || failedDeps.length) {
        pending.splice(i, 1);
        finish(item, {
          id: item.gate.id,
          state: "not-run",
          why: signal?.aborted
            ? "cancelled"
            : failedDeps.length
              ? `dependency failed: ${failedDeps.join(", ")}`
              : "earlier gate failed",
        });
        progressed = true;
        continue;
      }
      if (
        deps.some((id) => !completed.has(id)) ||
        [...active.values()].some((other) => conflicts(item.resources, other.item.resources))
      ) {
        i++;
        continue;
      }
      pending.splice(i, 1);
      const promise = Promise.resolve()
        .then(() => runOne(item.gate))
        .catch((error) => ({ id: item.gate.id, state: "fail", why: error.message }))
        .then((result) => {
          finish(item, result);
          active.delete(item.gate.id);
        });
      active.set(item.gate.id, { item, promise });
      progressed = true;
    }
    if (active.size) {
      const wakes = [...active.values()].map(({ promise }) => promise);
      // Reconsider a reduced resource budget while a long check is still running.
      if (pending.length && active.size < jobs) wakes.push(pause(1_000));
      await Promise.race(wakes);
    } else if (pending.length && available === 0) {
      pressureSince ??= now();
      if (now() - pressureSince >= pressureTimeoutMs) {
        for (const item of pending.splice(0))
          finish(item, { id: item.gate.id, state: "not-run", why: "resource pressure did not recover" });
      } else await pause(1_000);
    } else if (pending.length && !progressed) throw new Error("gate dependency cycle");
    if (available > 0) pressureSince = null;
  }
  return { status: failed ? "FAIL" : "PASS", results };
}
