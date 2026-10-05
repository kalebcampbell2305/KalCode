import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gateEnvironment, runGates, selectGates } from "./lifecycle/gate.mjs";
import {
  captureToolchain,
  checkFingerprint,
  evidenceEnvironment,
  isCheckOutput,
  prepareCheckEvidence,
} from "./lifecycle/gate-evidence.mjs";
import { runGatePool } from "./lifecycle/gate-pool.mjs";
import { createGateCapacity } from "./lifecycle/gate-pressure.mjs";
import { createGateReport } from "./lifecycle/gate-report.mjs";
import { loadPolicy } from "./lifecycle/policy.mjs";

const gate = (id) => ({
  id,
  run: [id],
  env: {},
  unsetEnv: [],
  requires: [],
  state: "selected",
  scheduling: { resources: { workspace: "read" } },
});
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("assigned worker ports override checkout defaults and native CDP ranges are isolated", () => {
  const policy = loadPolicy();
  const checkout = selectGates(
    policy,
    { files: [{ path: "apps/website/a.ts" }], targets: ["website"], lanes: ["website"] },
    { only: ["website-checkout-e2e"] },
  )[0];
  const ports = new Set();
  for (let worker = 1; worker <= 6; worker++) {
    const base = {
      KALCODE_GATE_SLOT: String(worker - 1),
      KALCODE_E2E_PORT: String(4491 + (worker - 1) * 20),
      KALCODE_E2E_MAIL_PORT: String(4492 + (worker - 1) * 20),
      KALCODE_E2E_INSPECTOR_PORT: String(9501 + (worker - 1) * 20),
    };
    const env = gateEnvironment(checkout, base);
    for (const key of Object.keys(base)) assert.equal(env[key], base[key]);
    for (let offset = 0; offset < 200; offset++) {
      const port = Number(env.KALCODE_E2E_CDP_PORT) + offset;
      assert.equal(ports.has(port), false);
      ports.add(port);
    }
    assert.equal(env.PUBLIC_CHECKOUT_ENABLED, "true");
  }
  assert.equal(gateEnvironment(checkout, {}).KALCODE_E2E_PORT, "8898");
  assert.equal(gateEnvironment(checkout, { KALCODE_E2E_CDP_PORT: "12345" }).KALCODE_E2E_CDP_PORT, "12345");
});

test("runner cleanup identity does not invalidate inputs while actual tool environment does", () => {
  assert.deepEqual(
    evidenceEnvironment({ PATH: "tools", RUNNER_TRACKING_ID: "a" }),
    evidenceEnvironment({ PATH: "tools", RUNNER_TRACKING_ID: "b" }),
  );
  assert.notDeepEqual(evidenceEnvironment({ PATH: "a" }), evidenceEnvironment({ PATH: "b" }));
});

test("recovered capacity starts queued checks before a long active check finishes", async () => {
  let budget = 1;
  let wake;
  const started = [];
  const resolve = new Map();
  const result = runGatePool(
    [gate("long"), gate("next")],
    async ({ id }) => {
      started.push(id);
      await new Promise((done) => resolve.set(id, done));
      return { id, state: "pass" };
    },
    {
      jobs: 2,
      capacity: () => budget,
      pause: () =>
        new Promise((done) => {
          wake = done;
        }),
    },
  );
  await tick();
  assert.deepEqual(started, ["long"]);
  budget = 2;
  wake();
  await tick();
  assert.deepEqual(started, ["long", "next"]);
  for (const done of resolve.values()) done();
  assert.equal((await result).status, "PASS");
});

test("six ready checks use four bounded workers and a failure never cancels independent work", async () => {
  const pending = new Map();
  let active = 0;
  let peak = 0;
  const started = [];
  const result = runGatePool(
    Array.from({ length: 6 }, (_, id) => gate(String(id))),
    async ({ id }) => {
      started.push(id);
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => pending.set(id, resolve));
      active--;
      return { id, state: id === "1" ? "fail" : "pass" };
    },
  );
  await tick();
  assert.deepEqual(started, ["0", "1", "2", "3"]);
  pending.get("1")();
  await tick();
  assert.equal(started.at(-1), "4");
  pending.get("0")();
  await tick();
  assert.equal(started.at(-1), "5");
  for (const resolve of pending.values()) resolve();
  const outcome = await result;
  assert.equal(peak, 4);
  assert.equal(outcome.status, "FAIL");
  assert.equal(outcome.results.filter((entry) => entry.state === "pass").length, 5);
});

test("workspace writers never race readers and failed prerequisites skip dependents only", async () => {
  let active = 0;
  const plan = [
    gate("a"),
    { ...gate("rust"), scheduling: { resources: { workspace: "write" } } },
    gate("b"),
    { ...gate("dependent"), scheduling: { dependsOn: ["rust"], resources: { workspace: "read" } } },
  ];
  const started = [];
  const outcome = await runGatePool(plan, async ({ id }) => {
    if (id === "rust") assert.equal(active, 0);
    active++;
    started.push(id);
    await tick();
    active--;
    return { id, state: id === "rust" ? "fail" : "pass" };
  });
  assert.equal(outcome.status, "FAIL");
  assert.ok(started.includes("a") && started.includes("b"));
  assert.ok(!started.includes("dependent"));
  assert.match(outcome.results.at(-1).why, /dependency failed/);
});

test("resource holds recover without losing queued checks; cancellation prevents new starts", async () => {
  let polls = 0;
  const ran = [];
  const result = await runGatePool(
    [gate("a"), gate("b")],
    async ({ id }) => {
      ran.push(id);
      return { id, state: "pass" };
    },
    { capacity: () => (++polls < 3 ? 0 : 2), pause: tick },
  );
  assert.equal(result.status, "PASS");
  assert.deepEqual(ran, ["a", "b"]);
  const abort = new AbortController();
  abort.abort();
  const cancelled = await runGatePool(
    [gate("a")],
    () => {
      throw new Error("must not run");
    },
    { signal: abort.signal },
  );
  assert.equal(cancelled.status, "FAIL");
  assert.equal(cancelled.results[0].why, "cancelled");
});

test("safe frontend-only classification avoids native rebuilds; unknown inputs retain full coverage", () => {
  const classify = (paths) => ({ files: paths.map((path) => ({ path })), targets: ["desktop"], lanes: ["desktop"] });
  const ids = (paths) => selectGates(loadPolicy(), classify(paths), { platform: "win32" }).map(({ id }) => id);
  assert.ok(!ids(["apps/desktop/src/shell/a.tsx"]).includes("rust"));
  assert.ok(ids(["apps/desktop/src/shell/a.tsx"]).includes("desktop-ui"));
  for (const path of [
    "Cargo.lock",
    "apps/desktop/package.json",
    "packages/protocol/src/generated/x.ts",
    "unknown.build",
  ])
    assert.ok(ids([path]).includes("rust"));
});

test("fingerprints bind dependencies, commands, environment and toolchain; unknown and revision-sensitive checks fail closed", () => {
  const a = "a".repeat(40),
    b = "b".repeat(40);
  const context = {
    entries: [
      { path: "apps/desktop/src/a.ts", oid: a },
      { path: "docs/a.md", oid: a },
    ],
    policy: { version: 1 },
    toolchain: { complete: true, node: "x" },
    environment: { TEST_MODE: "on" },
    head: a,
  };
  const initial = checkFingerprint(gate("desktop-frontend"), context);
  assert.equal(
    initial,
    checkFingerprint(gate("desktop-frontend"), {
      ...context,
      head: b,
      entries: [context.entries[0], { path: "docs/a.md", oid: b }],
    }),
  );
  for (const changed of [
    { entries: [{ path: "apps/desktop/src/a.ts", oid: b }] },
    { policy: { version: 2 } },
    { toolchain: { complete: true, node: "y" } },
    { environment: { TEST_MODE: "off" } },
  ])
    assert.notEqual(initial, checkFingerprint(gate("desktop-frontend"), { ...context, ...changed }));
  assert.notEqual(initial, checkFingerprint({ ...gate("desktop-frontend"), run: ["other"] }, context));
  assert.equal(checkFingerprint(gate("rust"), { ...context, toolchain: { complete: false } }), null);
  for (const id of ["rust", "website", "unknown"])
    assert.notEqual(checkFingerprint(gate(id), context), checkFingerprint(gate(id), { ...context, head: b }));
  assert.equal(checkFingerprint(gate("pnpm-audit"), context), null, "live vulnerability databases are never cached");
  assert.equal(captureToolchain({ probe: () => ({ status: 1 }) }).complete, false);
});

test("completed successes survive a sibling failure and safely rebind; dirty source and forged fingerprint cannot reuse", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "kc-gate-evidence-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let head = "a".repeat(40),
    dirty = false;
  const git = {
    commonDir: () => root,
    rev: () => head,
    diff: () => (dirty ? [{}] : []),
    untracked: () => [],
    run: () => `100644 blob ${"c".repeat(40)}\tapps/desktop/src/a.ts\0`,
  };
  const checks = [gate("desktop-frontend"), gate("api")];
  const make = () =>
    prepareCheckEvidence(
      git,
      { clean: true, head, plan: checks },
      { version: 1 },
      { toolchain: { complete: true }, environment: { KALCODE_GATE_EVIDENCE_DIR: join(root, "cache") } },
    );
  let count = 0;
  const execute = async () => {
    count++;
    return { id: "desktop-frontend", state: "pass" };
  };
  const first = make();
  const passed = await first.run(checks[0], execute);
  await first.run(checks[1], async () => ({ id: "api", state: "fail" }));
  head = "b".repeat(40);
  const reused = await make().run(checks[0], execute);
  assert.equal(count, 1);
  assert.equal(reused.reusedFrom, "a".repeat(40));
  assert.equal(reused.reboundTo, head);
  dirty = true;
  assert.equal((await make().run(checks[0], execute)).state, "fail");
  dirty = false;
  const cache = join(root, "cache", `${passed.fingerprint}.json`);
  writeFileSync(cache, JSON.stringify({ ...JSON.parse(readFileSync(cache, "utf8")), fingerprint: "forged" }));
  await make().run(checks[0], execute);
  assert.equal(count, 2, "mismatched evidence is rerun");
  const validBytes = readFileSync(cache, "utf8");
  unlinkSync(cache);
  const beforeChecksStart = make();
  writeFileSync(cache, validBytes);
  await beforeChecksStart.run(checks[0], execute);
  assert.equal(count, 3, "a receipt introduced after checks start is not trusted for this run");
  const report = createGateReport({
    directory: join(root, "reports"),
    head,
    base: "a".repeat(40),
    worker: "test",
    plan: checks,
  });
  report.start(checks[0].id);
  report.finish({ ...reused, why: "secret must not be written", environment: { TOKEN: "secret" }, exitCode: 0 });
  const text = readFileSync(report.path, "utf8");
  assert.ok(!text.includes("secret"));
  assert.equal(JSON.parse(text).checks[0].reboundTo, head);
});

test("host budget yields under real CPU/RAM pressure and recovers with hysteresis", () => {
  let time = 0,
    used = 0,
    idle = 0,
    memory = 32 * 1024 ** 3;
  const capacity = createGateCapacity(2, {
    now: () => time,
    free: () => memory,
    cpu: () => [{ times: { user: used, idle } }],
  });
  assert.equal(capacity(), 1);
  time += 1000;
  used += 99;
  idle += 1;
  assert.equal(capacity(), 0);
  time += 1000;
  idle += 100;
  assert.equal(capacity(), 0);
  time += 1000;
  idle += 100;
  assert.equal(capacity(), 2);
  memory = 8 * 1024 ** 3;
  time += 1000;
  assert.equal(capacity(), 0);
});

test("real six-process acceptance proves four overlapping checks on this machine with independent failure", {
  timeout: 30_000,
}, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "kc-real-gate-pool-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = join(root, "worker.mjs");
  writeFileSync(
    fixture,
    `import {writeFileSync,existsSync} from 'node:fs';import {join} from 'node:path';\nconst [root,id]=process.argv.slice(2);writeFileSync(join(root,id+'.start'),String(Date.now()));\nif(Number(id)<4){const until=Date.now()+10000;while(![0,1,2,3].every(i=>existsSync(join(root,i+'.start')))){if(Date.now()>until)throw Error('four workers did not overlap');await new Promise(r=>setTimeout(r,20));}}\nawait new Promise(r=>setTimeout(r,150));writeFileSync(join(root,id+'.end'),String(Date.now()));process.exit(id==='1'?7:0);`,
  );
  const plan = Array.from({ length: 6 }, (_, id) => ({
    ...gate(String(id)),
    run: [`"${process.execPath}" "${fixture}" "${root}" ${id}`],
  }));
  const outcome = await runGates(plan, { repo: root, jobs: 4 });
  assert.equal(outcome.status, "FAIL");
  assert.equal(outcome.results.filter(({ state }) => state === "pass").length, 5);
  assert.equal(outcome.results[1].exitCode, 7);
  const starts = [0, 1, 2, 3].map((id) => Number(readFileSync(join(root, `${id}.start`), "utf8")));
  const ends = [0, 1, 2, 3].map((id) => Number(readFileSync(join(root, `${id}.end`), "utf8")));
  assert.ok(Math.max(...starts) < Math.min(...ends), "four actual child checks overlapped");
  assert.ok([4, 5].every((id) => readFileSync(join(root, `${id}.end`), "utf8")));
});

test("check outputs written into the checkout never count as a changed candidate", () => {
  // Gate 37323803563: desktop-ui refreshed tracked QA screenshots, then rust and native e2e failed
  // in 0 s with "source changed before check".
  assert.equal(isCheckOutput("apps/desktop/qa/screenshots/w0/dashboard-dark.png"), true);
  assert.equal(isCheckOutput("docs/release/cursor-provider/pane.png"), true);
  assert.equal(isCheckOutput("apps/desktop/qa/screenshots/report.json"), true);
  assert.equal(isCheckOutput("apps/desktop/src/App.tsx"), false);
  assert.equal(isCheckOutput("crates/threads/src/runtime.rs"), false);
});

test("a check that ends before running still logs why it failed", async () => {
  const lines = [];
  const outcome = await runGates(
    [{ id: "rust", run: ["cargo test"], env: {}, unsetEnv: [], requires: [], state: "selected" }],
    {
      jobs: 2,
      log: (line) => lines.push(line),
      evidence: { run: async (gate) => ({ id: gate.id, state: "fail", why: "source changed before check" }) },
    },
  );
  assert.equal(outcome.status, "FAIL");
  assert.ok(lines.includes("FAIL rust: source changed before check"), lines.join("\n"));
});
