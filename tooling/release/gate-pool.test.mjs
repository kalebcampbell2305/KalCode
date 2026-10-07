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
import { makeGit } from "./lifecycle/git.mjs";
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
    `import {writeFileSync,existsSync} from 'node:fs';import {join} from 'node:path';\nconst [root,id]=process.argv.slice(2);if(!existsSync(join(root,id+'.start')))writeFileSync(join(root,id+'.start'),String(Date.now()));\nif(Number(id)<4){const until=Date.now()+10000;while(![0,1,2,3].every(i=>existsSync(join(root,i+'.start')))){if(Date.now()>until)throw Error('four workers did not overlap');await new Promise(r=>setTimeout(r,20));}}\nawait new Promise(r=>setTimeout(r,150));writeFileSync(join(root,id+'.end'),String(Date.now()));process.exit(id==='1'?7:0);`,
  );
  const plan = Array.from({ length: 6 }, (_, id) => ({
    ...gate(String(id)),
    run: [`"${process.execPath}" "${fixture}" "${root}" ${id}`],
  }));
  const outcome = await runGates(plan, { repo: root, jobs: 4 });
  assert.equal(outcome.status, "FAIL");
  assert.equal(outcome.results.filter(({ state }) => state === "pass").length, 5);
  assert.equal(outcome.results[1].exitCode, 7);
  assert.equal(outcome.results[1].rerun, true, "the real failure failed its one rerun too");
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

test("a gate whose checks refreshed tracked QA screenshots still gets its receipt", async () => {
  const { receiptDrift } = await import("./lifecycle/gate.mjs");
  const head = "a".repeat(40);
  const git = (diff) => ({ rev: () => head, diff: () => diff, untracked: () => ["test-results/report.json"] });
  const g = { head };
  // Gate 37374586446: every check passed, then the receipt was refused over refreshed screenshots.
  assert.equal(receiptDrift(git([{ path: "apps/desktop/qa/screenshots/w0/dashboard-dark.png" }]), g), null);
  assert.match(
    receiptDrift(git([{ path: "apps/desktop/src/App.tsx" }]), g),
    /tracked source changed: apps\/desktop\/src\/App\.tsx/,
  );
  assert.equal(receiptDrift({ ...git([]), rev: () => "b".repeat(40) }, g), "HEAD moved");
});

// A load-sensitive flake must not cost a whole gate cycle: a failed check runs once more, alone.
const check = (id, extra = {}) => ({
  id,
  run: [`${id}-cmd`],
  env: {},
  unsetEnv: [],
  requires: [],
  state: "selected",
  ...extra,
});

test("only a check whose own commands ran and failed is rerun", async () => {
  const { shouldRerun } = await import("./lifecycle/gate.mjs");
  assert.equal(shouldRerun({ state: "fail", ran: true }), true);
  assert.equal(shouldRerun({ state: "fail", ran: true }, { aborted: true }), false, "a cancelled gate");
  assert.equal(shouldRerun({ state: "fail", ran: true, timedOut: true }), false, "a hang would spend its budget again");
  assert.equal(shouldRerun({ state: "fail", why: "source changed before check: x" }), false, "a refusal never ran");
  assert.equal(shouldRerun({ state: "fail", why: "missing tool: cargo deny --version" }), false);
  assert.equal(shouldRerun({ state: "pass", ran: true }), false);
});

test("a failure signature names the verdict and the first failing test, and notices cannot inject commands", async () => {
  const { failureSignature, githubNotice } = await import("./lifecycle/gate.mjs");
  const why = "node apps/desktop/scripts/cargo.mjs test --workspace exited 101";
  const output =
    "running 3 tests\ntest result: ok. 3 passed; 0 failed\ntest threads::usage_waits ... FAILED\nthread 'x' panicked at src/a.rs:1\n";
  assert.equal(failureSignature({ why }, output), `${why}; first failure: test threads::usage_waits ... FAILED`);
  assert.equal(
    failureSignature(
      { why: "pnpm test:ui exited 1" },
      "\u001b[31m  ✘  3 [chromium] › home.spec.ts:9:3 › demo opens\u001b[39m",
    ),
    "pnpm test:ui exited 1; first failure: ✘  3 [chromium] › home.spec.ts:9:3 › demo opens",
  );
  assert.equal(failureSignature({ why }, ""), why);
  assert.equal(
    githubNotice("Flaky gate check: rust", "50% failed\n::error::forged"),
    "::notice title=Flaky gate check%3A rust::50%25 failed%0A::error::forged",
  );
});

test("a check that fails once and passes its rerun passes as FLAKY with a notice naming its first failure", async () => {
  const lines = [];
  const calls = [];
  const exec = async (command, { output } = {}) => {
    calls.push(command);
    if (command === "rust-cmd" && calls.filter((call) => call === "rust-cmd").length === 1) {
      output?.("test threads::usage_waits ... FAILED\n");
      return 101;
    }
    return 0;
  };
  const outcome = await runGates([check("rust"), check("biome")], {
    jobs: 2,
    exec,
    log: (line) => lines.push(line),
    baseEnv: { GITHUB_ACTIONS: "true" },
  });
  assert.equal(outcome.status, "PASS");
  const rust = outcome.results.find(({ id }) => id === "rust");
  assert.equal(rust.state, "pass");
  assert.equal(rust.flaky, true);
  assert.equal(rust.firstFailure, "rust-cmd exited 101; first failure: test threads::usage_waits ... FAILED");
  assert.equal(calls.filter((command) => command === "rust-cmd").length, 2, "only the failed check ran again");
  assert.equal(calls.filter((command) => command === "biome-cmd").length, 1);
  const text = lines.join("\n");
  assert.match(text, /RERUN rust: failed once \(rust-cmd exited 101/);
  assert.match(text, /FLAKY rust: passed on its rerun/);
  assert.ok(
    lines.includes(
      "::notice title=Flaky gate check%3A rust::rust failed once, then passed on its automatic rerun. First failure: rust-cmd exited 101; first failure: test threads::usage_waits ... FAILED",
    ),
    text,
  );
});

test("a check that fails on every attempt still fails, after exactly one rerun", async () => {
  let runs = 0;
  const lines = [];
  const outcome = await runGates([check("desktop-ui")], {
    jobs: 1,
    exec: async () => {
      runs++;
      return 1;
    },
    log: (line) => lines.push(line),
    baseEnv: {},
  });
  assert.equal(outcome.status, "FAIL");
  assert.equal(runs, 2);
  assert.equal(outcome.results[0].state, "fail");
  assert.equal(outcome.results[0].rerun, true);
  assert.equal(outcome.results[0].flaky, undefined);
  assert.ok(!lines.some((line) => line.startsWith("::notice")), "no notice for a real failure");
});

test("refusals and timeouts are never rerun", async () => {
  let runs = 0;
  const refused = await runGates([check("rust")], {
    jobs: 1,
    evidence: { run: async (gate) => ({ id: gate.id, state: "fail", why: "source changed before check: a.rs" }) },
    exec: async () => {
      runs++;
      return 0;
    },
  });
  assert.equal(refused.results[0].state, "fail");
  assert.equal(runs, 0);
  let now = 0;
  const timed = await runGates([check("rust", { timeoutMs: 1000 })], {
    jobs: 1,
    now: () => now,
    exec: async () => {
      runs++;
      now += 2000;
      return "timed-out";
    },
    baseEnv: {},
  });
  assert.equal(timed.results[0].state, "fail");
  assert.match(timed.results[0].why, /timed out/);
  assert.equal(runs, 1);
});

function candidateRepo(t) {
  const root = mkdtempSync(join(tmpdir(), "kc-gate-rerun-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = makeGit(root);
  git.run(["init", "-q"]);
  git.run(["config", "core.autocrlf", "false"]);
  writeFileSync(join(root, "bindings.ts"), "export type A = 1;\n");
  writeFileSync(join(root, "lib.rs"), "fn a() {}\n");
  git.run(["add", "."]);
  git.run(["-c", "user.name=gate", "-c", "user.email=gate@example.invalid", "commit", "-q", "-m", "candidate"]);
  return { root, git, head: git.rev("HEAD") };
}

const evidenceFor = (git, root, head, plan) =>
  prepareCheckEvidence(
    git,
    { clean: true, head, plan },
    { version: 1 },
    { toolchain: { complete: true }, environment: { KALCODE_GATE_EVIDENCE_DIR: join(root, ".cache") } },
  );

test("a rerun starts from the exact candidate: tracked source the failed attempt rewrote is restored", async (t) => {
  const { root, git, head } = candidateRepo(t);
  const plan = [check("rust")];
  const evidence = evidenceFor(git, root, head, plan);
  let runs = 0;
  const lines = [];
  const outcome = await runGates(plan, {
    jobs: 1,
    evidence,
    log: (line) => lines.push(line),
    baseEnv: {},
    exec: async () => {
      runs++;
      // The first attempt fails half way and leaves regenerated bindings behind (the bindings cascade).
      if (runs === 1) {
        writeFileSync(join(root, "bindings.ts"), "export type A = 2;\n");
        return 101;
      }
      assert.equal(readFileSync(join(root, "bindings.ts"), "utf8"), "export type A = 1;\n", "rerun saw the candidate");
      return 0;
    },
  });
  assert.equal(runs, 2);
  assert.equal(outcome.status, "PASS", lines.join("\n"));
  assert.equal(outcome.results[0].flaky, true);
  assert.match(
    outcome.results[0].firstFailure,
    /source changed during check: bindings\.ts \(after rust-cmd exited 101\)/,
  );
  assert.match(lines.join("\n"), /restored 1 tracked file\(s\) the failed attempt rewrote/);
  assert.equal(evidence.stillExact(), true);
});

test("a rerun that rewrites source again still fails", async (t) => {
  const { root, git, head } = candidateRepo(t);
  const plan = [check("rust")];
  let runs = 0;
  const outcome = await runGates(plan, {
    jobs: 1,
    evidence: evidenceFor(git, root, head, plan),
    baseEnv: {},
    exec: async () => {
      runs++;
      writeFileSync(join(root, "bindings.ts"), "export type A = 2;\n");
      return 0;
    },
  });
  assert.equal(runs, 2);
  assert.equal(outcome.status, "FAIL");
  assert.match(outcome.results[0].why, /source changed during check: bindings\.ts/);
});

test("a check sharing the workspace never resets files under other checks; an uncommitted tree is never touched", async (t) => {
  const { rerunFromCandidate } = await import("./lifecycle/gate.mjs");
  const { root, git, head } = candidateRepo(t);
  const plan = [check("desktop-ui")];
  const evidence = evidenceFor(git, root, head, plan);
  writeFileSync(join(root, "lib.rs"), "fn changed() {}\n");
  const refused = rerunFromCandidate(plan[0], evidence);
  assert.equal(refused.ok, false);
  assert.match(refused.why, /other checks share it/);
  assert.equal(readFileSync(join(root, "lib.rs"), "utf8"), "fn changed() {}\n");
  // No evidence means the gate started from an uncommitted tree: those changes are the user's.
  assert.deepEqual(rerunFromCandidate(check("rust"), null), { ok: true, how: "" });
  assert.equal(readFileSync(join(root, "lib.rs"), "utf8"), "fn changed() {}\n");
});

test("the gate report marks a flaky check without recording its failure text", (t) => {
  const root = mkdtempSync(join(tmpdir(), "kc-gate-report-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const report = createGateReport({
    directory: root,
    head: "a".repeat(40),
    base: "b".repeat(40),
    plan: [check("rust")],
  });
  report.finish({ id: "rust", state: "pass", exitCode: 0, flaky: true, firstFailure: "secret output line" });
  const text = readFileSync(report.path, "utf8");
  assert.equal(JSON.parse(text).checks[0].flaky, true);
  assert.ok(!text.includes("secret output line"));
});
