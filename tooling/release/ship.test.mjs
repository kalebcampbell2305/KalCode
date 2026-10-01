// Tests for the release orchestrator (tooling/release/ship.mjs + ship/*). Everything runs in a throwaway git
// repository with a fake kit; nothing here touches production, signing keys or the real release folders.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  canonicalJson,
  identityVars,
  references,
  resolveDeep,
  resolveString,
  ShipError,
  validateIdentity,
} from "./ship/context.mjs";
import { Pipeline } from "./ship/engine.mjs";
import { assertBinds, bindsProblems, kitCoverage, loadKit, validateKit, verifyScripts } from "./ship/kit.mjs";
import { PHASES, selectPhases, validateRegistry } from "./ship/phases.mjs";
import { ReleaseState, writeCreateOnce } from "./ship/state.mjs";
import { parseArgs } from "./ship.mjs";

const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const refused = (fn, re) => assert.throws(fn, (e) => e instanceof ShipError && re.test(e.message));
const refusedAsync = (p, re) => assert.rejects(p, (e) => e instanceof ShipError && re.test(e.message));

// ------------------------------------------------------------------ fixture repository

function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function makeRepo(version = "1.2.3", endpoint = 'Self::Stable => "https://kalcoded.com/releases/updater/stable.json"') {
  const repo = mkdtempSync(join(tmpdir(), "ship-test-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@example.invalid");
  git(repo, "config", "user.name", "ship test");
  git(repo, "config", "core.autocrlf", "false");
  const w = (rel, text) => {
    mkdirSync(join(repo, rel, ".."), { recursive: true });
    writeFileSync(join(repo, rel), text);
  };
  w("apps/desktop/src-tauri/tauri.conf.json", JSON.stringify({ productName: "KalCode", version }));
  w("apps/desktop/package.json", JSON.stringify({ name: "@kalcode/desktop", version }));
  w("Cargo.toml", `[workspace]\nmembers = []\n\n[workspace.package]\nversion = "${version}"\nedition = "2024"\n`);
  w("crates/updater/src/lib.rs", `match c {\n  ${endpoint},\n}\n`);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "fixture");
  const commit = git(repo, "rev-parse", "HEAD");
  // Kit scripts live outside git history, like the real target/ recovery folders.
  w(
    "kit/build.mjs",
    `import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
const [commit, version, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const bytes = Buffer.from("installer " + version + " " + commit);
writeFileSync(out + "/app-" + version + ".bin", bytes);
writeFileSync(out + "/build.json", JSON.stringify({ commit, version, signed: true, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length }));
console.log("built " + version);
`,
  );
  w(
    "kit/stage.mjs",
    `import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
const args = process.argv.slice(2);
const execute = args.includes("--execute");
appendFileSync("stage-calls.log", (execute ? "EXECUTE " : "DRYRUN ") + args.join(" ") + "\\n");
if (!execute) { console.log("dry run ok"); process.exit(0); }
mkdirSync("receipts", { recursive: true });
const path = "receipts/02-stage-" + Date.now() + ".json";
const text = JSON.stringify({ schema: "stage/v1", status: "PASS", productCommit: args[0] });
writeFileSync(path, text);
console.log("receipt: " + process.cwd().replaceAll("\\\\", "/") + "/" + path + "  sha256 " + createHash("sha256").update(text).digest("hex"));
`,
  );
  w(
    "kit/poll.mjs",
    `import { existsSync, readFileSync, writeFileSync } from "node:fs";
const f = "poll-count.txt";
const n = existsSync(f) ? Number(readFileSync(f, "utf8")) + 1 : 1;
writeFileSync(f, String(n));
console.log(n < 3 ? "running" : "passed");
`,
  );
  w("kit/fail.mjs", `console.log("nope"); process.exit(3);\n`);
  return { repo, commit };
}

const TEST_PHASES = Object.freeze([
  { id: "identity", group: "test", effect: "read", needs: [], title: "identity", builtin: "identity" },
  { id: "build", group: "build", effect: "local", needs: ["identity"], title: "build" },
  { id: "verify", group: "build", effect: "local", needs: ["build"], title: "verify (operator)" },
  { id: "pins", group: "certify", effect: "local", needs: ["verify"], title: "pins", builtin: "pins" },
  { id: "qa", group: "qa", effect: "human", needs: ["pins"], title: "human qa" },
  {
    id: "stage",
    group: "stage",
    effect: "prod-write",
    needs: ["qa"],
    title: "stage",
    approval: true,
    approvalReason: "writes production",
  },
  { id: "readback", group: "stage", effect: "prod-read", needs: ["stage"], title: "readback" },
]);

function makeKit(repo, overrides = {}) {
  const scripts = {};
  for (const f of ["kit/build.mjs", "kit/stage.mjs", "kit/poll.mjs", "kit/fail.mjs"])
    scripts[f] = sha256(readFileSync(join(repo, f)));
  return {
    schema: "kalcode-release-kit/v1",
    name: "test-kit",
    binds: { version: "1.2.3" },
    vars: { outDir: "{repo}/out-{commit7}" },
    scripts,
    identity: {
      movingEndpoint: {
        file: "crates/updater/src/lib.rs",
        contains: 'Self::Stable => "https://kalcoded.com/releases/updater/stable.json"',
      },
    },
    pins: {
      PRODUCT_SHA40: "{commit}",
      INSTALLER_SHA256: "{out.build.installer.sha256}",
      BUILD_SIZE: "{out.build.build.installerSize}",
    },
    phases: {
      build: {
        steps: [
          {
            id: "build",
            run: ["node", "kit/build.mjs", "{commit}", "{version}", "{outDir}"],
            uses: ["kit/build.mjs"],
            outputs: [
              { key: "installer", type: "file", path: "{outDir}/app-{version}.bin" },
              {
                key: "build",
                type: "json",
                path: "{outDir}/build.json",
                expect: { commit: "{commit}", version: "{version}", signed: true },
                pick: { installerSize: "size" },
              },
              { key: "builtLine", type: "stdout", pattern: "^built (\\d+\\.\\d+\\.\\d+)$" },
            ],
          },
        ],
      },
      verify: {
        steps: [
          {
            id: "clean-machine",
            operator: "run verify on a clean state",
            outputs: [
              {
                key: "verifyReport",
                type: "json",
                expect: { status: "passed", sha256: "{out.build.installer.sha256}" },
              },
            ],
          },
        ],
      },
      pins: {
        steps: [
          {
            id: "show",
            run: [
              "node",
              "-e",
              "process.stdout.write(require('fs').readFileSync(process.argv[1],'utf8'))",
              "{this.pinsEnv.path}",
            ],
            outputs: [{ key: "product", type: "stdout", pattern: "^PRODUCT_SHA40=([0-9a-f]{40})$" }],
          },
        ],
      },
      qa: { instructions: "sit the QA", evidence: [{ key: "sheet", type: "json", expect: { result: "PASS" } }] },
      stage: {
        steps: [
          { id: "dry-run", run: ["node", "kit/stage.mjs", "{commit}", "{out.pins.product}"], uses: ["kit/stage.mjs"] },
          {
            id: "execute",
            run: ["node", "kit/stage.mjs", "{commit}", "{out.pins.product}", "--execute"],
            uses: ["kit/stage.mjs"],
            outputs: [{ key: "stageReceipt", type: "receipt", expect: { status: "PASS", productCommit: "{commit}" } }],
          },
        ],
      },
      readback: {
        steps: [
          {
            id: "poll",
            run: ["node", "kit/poll.mjs"],
            poll: { everySeconds: 0, timeoutMinutes: 1, doneWhen: "^(passed|failed)" },
            outputs: [{ key: "state", type: "stdout", pattern: "^(passed)$" }],
          },
        ],
      },
    },
    ...overrides,
  };
}

function makePipeline(fx, kit, extra = {}) {
  validateKit(kit, TEST_PHASES);
  const lines = [];
  const p = new Pipeline({
    repo: fx.repo,
    identity: validateIdentity({ version: "1.2.3", commit: fx.commit }),
    loadedKit: { kit, sha256: sha256(canonicalJson(kit)), path: "test-kit.json" },
    stateDir: join(fx.repo, "state"),
    phases: TEST_PHASES,
    log: (l) => lines.push(l),
    ...extra,
  });
  p.lines = lines;
  return p;
}

function writeJson(repo, rel, value) {
  const path = join(repo, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
  return path;
}

// ------------------------------------------------------------------ pure pieces

describe("identity and templates", () => {
  test("validateIdentity refuses anything Stable cannot carry", () => {
    const c = "a".repeat(40);
    assert.equal(validateIdentity({ version: "0.1.7", commit: c, baselineVersion: "0.1.2" }).baselineVersion, "0.1.2");
    assert.equal(
      validateIdentity({ version: "0.1.7+2", commit: c, baselineVersion: "0.1.7+1" }).baselineVersion,
      "0.1.7+1",
    );
    refused(() => validateIdentity({ version: "0.1.7-rc.1", commit: c }), /x\.y\.z or x\.y\.z\+N/);
    refused(() => validateIdentity({ version: "0.1.7+build.1", commit: c }), /x\.y\.z or x\.y\.z\+N/);
    refused(() => validateIdentity({ version: "0.1.7+0", commit: c }), /x\.y\.z or x\.y\.z\+N/);
    refused(() => validateIdentity({ version: "0.1.7+65536", commit: c }), /x\.y\.z or x\.y\.z\+N/);
    refused(() => validateIdentity({ version: "0.1.5.1", commit: c }), /x\.y\.z or x\.y\.z\+N/);
    refused(() => validateIdentity({ version: "0.1.7", commit: "abc1234" }), /40-hex/);
    refused(() => validateIdentity({ version: "0.1.7", commit: c.toUpperCase() }), /40-hex/);
    refused(() => validateIdentity({ version: "0.1.7", commit: c, baselineVersion: "0.1.7" }), /must be lower/);
    refused(() => validateIdentity({ version: "0.1.7+1", commit: c, baselineVersion: "0.1.7+1" }), /must be lower/);
    refused(() => validateIdentity({ version: "0.1.7+1", commit: c, baselineVersion: "0.1.7+2" }), /must be lower/);
    refused(() => validateIdentity({ version: "0.1.7", commit: c, baselineVersion: "0.2.0" }), /must be lower/);
    refused(() => validateIdentity({ version: "0.1.7", commit: c, channel: "beta" }), /channel/);
  });

  test("templates resolve nested references strictly and refuse leftovers", () => {
    const vars = {
      ...identityVars(validateIdentity({ version: "0.1.7", commit: "b".repeat(40) })),
      out: { build: { installer: { sha256: "f".repeat(64) } } },
    };
    assert.equal(
      resolveString("{version}/{commit7}/{out.build.installer.sha256}", vars).value,
      `0.1.7/bbbbbbb/${"f".repeat(64)}`,
    );
    assert.equal(resolveString("rev^{{commit}} [0-9a-f]{40}", vars).value, "rev^{commit} [0-9a-f]{40}");
    refused(() => resolveString("{out.build.missing}", vars), /unresolved/);
    refused(() => resolveString("{out.build}", vars), /unresolved/);
    refused(() => resolveString("PLACEHOLDER_B10_X {version}", vars), /PLACEHOLDER/);
    const lenient = resolveString("{out.stage.receipt.path} {version}", vars, { lenient: true });
    assert.deepEqual(lenient.missing, ["out.stage.receipt.path"]);
    assert.equal(lenient.value, "<out.stage.receipt.path> 0.1.7");
    assert.deepEqual(resolveDeep({ a: ["{version}", true, 3] }, vars).value, { a: ["0.1.7", true, 3] });
    assert.deepEqual(references(["x^{{commit}}", "{a.b}", { k: "{c}" }]).sort(), ["a.b", "c"]);
  });

  test("the canonical registry is ordered, and every production write needs approval", () => {
    assert.equal(validateRegistry(PHASES), true);
    for (const p of PHASES.filter((x) => x.effect === "prod-write")) assert.equal(p.approval, true, p.id);
    const group = selectPhases("group:stage", PHASES);
    assert.deepEqual(
      group.phases.map((p) => p.id),
      ["preflight-prod", "stage-preconditions", "stage", "readback", "lifecycle"],
    );
    assert.equal(group.explicit.size, 0);
    assert.deepEqual(
      [...selectPhases("stage", PHASES).explicit],
      ["stage"],
      "a phase id wins over the group of the same name",
    );
    assert.deepEqual(
      selectPhases("certify", PHASES).phases.map((p) => p.id),
      ["certify-windows", "certify-mac", "pins"],
    );
    assert.deepEqual([...selectPhases("publish,identity", PHASES).explicit], ["publish", "identity"]);
    assert.throws(() => selectPhases("nope", PHASES), /unknown phase/);
  });

  test("CLI arguments: default command is run, values are required, evidence is key=path", () => {
    const o = parseArgs([
      "--version",
      "0.1.7",
      "--commit",
      "c".repeat(40),
      "--phase",
      "build",
      "--execute",
      "--evidence",
      "report=a.json",
    ]);
    assert.equal(o.command, "run");
    assert.equal(o.execute, true);
    assert.deepEqual(o.evidence, { report: "a.json" });
    assert.equal(
      parseArgs(["approve", "--by", "Kaleb", "--confirm", "stage:0.1.7:ccccccc"]).confirm,
      "stage:0.1.7:ccccccc",
    );
    assert.throws(() => parseArgs(["--version"]), /needs a value/);
    assert.throws(() => parseArgs(["--bogus", "1"]), /unknown argument/);
    assert.throws(() => parseArgs(["--evidence", "no-equals"]), /key=path/);
    assert.throws(() => parseArgs(["ship-it"]), /unknown command/);
  });

  test("create-once writes accept identical bytes and refuse different bytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "ship-once-"));
    try {
      const f = join(dir, "r.json");
      assert.equal(writeCreateOnce(f, "a"), true);
      assert.equal(writeCreateOnce(f, "a"), false);
      refused(() => writeCreateOnce(f, "b"), /create-once/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------------------------------ kits

describe("kits", () => {
  test("validation refuses unsafe kit shapes", () => {
    const fx = { repo: tmpdir() };
    const base = () => ({ schema: "kalcode-release-kit/v1", name: "k", phases: {} });
    refused(() => validateKit({ ...base(), phases: { nope: {} } }, TEST_PHASES), /not a canonical phase/);
    refused(() => validateKit({ ...base(), phases: { build: { skip: "x" } } }, TEST_PHASES), /may not be skipped/);
    refused(() => validateKit({ ...base(), vars: { commit: "x" } }, TEST_PHASES), /shadow/);
    refused(
      () =>
        validateKit({ ...base(), phases: { stage: { steps: [{ id: "x", run: ["node", "x.mjs"] }] } } }, TEST_PHASES),
      /must pin the script/,
    );
    refused(
      () =>
        validateKit({ ...base(), phases: { stage: { steps: [{ id: "x", operator: "do it by hand" }] } } }, TEST_PHASES),
      /cannot be an operator step/,
    );
    refused(
      () =>
        validateKit(
          { ...base(), phases: { build: { steps: [{ id: "x", run: ["echo", "{approval.by}"] }] } } },
          TEST_PHASES,
        ),
      /approval/,
    );
    refused(
      () =>
        validateKit(
          { ...base(), phases: { build: { steps: [{ id: "x", run: ["a"], write: { path: "p", json: {} } }] } } },
          TEST_PHASES,
        ),
      /exactly one/,
    );
    refused(() => validateKit({ ...base(), phases: { qa: { steps: [] } } }, TEST_PHASES), /human phase/);
    refused(
      () =>
        validateKit(
          {
            ...base(),
            phases: {
              build: {
                steps: [
                  { id: "a", run: ["x"], outputs: [{ key: "k", type: "stdout", pattern: "x" }] },
                  { id: "b", run: ["y"], outputs: [{ key: "k", type: "stdout", pattern: "y" }] },
                ],
              },
            },
          },
          TEST_PHASES,
        ),
      /used twice/,
    );
    assert.ok(fx);
  });

  test("binds pin a kit to its release", () => {
    const kit = { name: "k", binds: { version: "0.1.6", commit: "a".repeat(40) } };
    assert.deepEqual(bindsProblems(kit, { version: "0.1.6", commit: "a".repeat(40) }), []);
    refused(() => assertBinds(kit, { version: "0.1.7", commit: "a".repeat(40) }), /pinned to "0\.1\.6"/);
  });

  test("the B10 kit is valid, covers every scripted phase, and only defers references to receipts", () => {
    const here = fileURLToPath(new URL("./ship/kits/b10-0.1.6.json", import.meta.url));
    const { kit } = loadKit(here);
    assert.deepEqual(kitCoverage(kit), []);
    const identity = validateIdentity({
      version: kit.binds.version,
      commit: kit.binds.commit,
      baselineVersion: kit.binds.baselineVersion,
    });
    const baseVars = { ...identityVars(identity), repo: "C:/repo", state: "C:/state" };
    const kitVars = Object.fromEntries(Object.entries(kit.vars).map(([k, v]) => [k, resolveString(v, baseVars).value]));
    for (const [id, def] of Object.entries(kit.phases)) {
      const { missing } = resolveDeep(def, { ...baseVars, ...kitVars }, { lenient: true });
      const bad = missing.filter((m) => !/^(out|this|attest|approval)\./.test(m));
      assert.deepEqual(bad, [], `${id} references unknown names`);
    }
    for (const [id, def] of Object.entries(kit.phases)) {
      const p = PHASES.find((x) => x.id === id);
      if (p.effect === "prod-write")
        for (const s of def.steps) assert.ok(s.uses?.length, `${id}.${s.id} must pin its script`);
    }
  });
});

// ------------------------------------------------------------------ the state machine end to end

describe("pipeline", () => {
  let fx;
  before(() => {
    fx = makeRepo();
  });
  after(() => rmSync(fx.repo, { recursive: true, force: true }));

  test("plan is the default and executes nothing", async () => {
    const p = makePipeline(fx, makeKit(fx.repo));
    const r = await p.run("all");
    assert.equal(r.code, 0);
    assert.ok(p.lines.some((l) => l.includes("Dry run")));
    assert.ok(p.lines.some((l) => l.includes("$ node kit/build.mjs")));
    assert.equal(existsSync(join(fx.repo, "state")), false, "a plan creates no state");
    assert.equal(existsSync(join(fx.repo, `out-${fx.commit.slice(0, 7)}`)), false, "a plan runs no command");
    const rows = p.describe("all");
    assert.equal(rows.find((x) => x.id === "identity").status, "READY");
    assert.equal(rows.find((x) => x.id === "build").status, "BLOCKED");
  });

  test("full run: gates, operator attestation, pins, human QA, approval, production write, poll, resume", async () => {
    const kit = makeKit(fx.repo);
    let p = makePipeline(fx, kit);

    // Runs identity + build, stops at the operator step of verify.
    let r = await p.run("all", { execute: true });
    assert.equal(r.code, 2);
    assert.equal(r.stoppedAt, "verify");
    assert.equal(r.status, "AWAITING-OPERATOR");
    const build = p.state.receipt("build").value;
    assert.equal(build.status, "PASS");
    assert.equal(build.outputs.builtLine, "1.2.3");
    assert.equal(build.outputs.build.installerSize, build.outputs.installer.size);
    assert.equal(p.state.receipt("identity").value.outputs.version, "1.2.3");

    // Operator evidence is validated against the build receipt.
    const bad = writeJson(fx.repo, "evidence/verify-bad.json", { status: "passed", sha256: "0".repeat(64) });
    refused(() => p.attest("verify", { by: "Kaleb", evidence: { verifyReport: bad } }), /sha256 is/);
    refused(() => p.attest("verify", { by: "Kaleb", evidence: {} }), /verifyReport=<path> is required/);
    const good = writeJson(fx.repo, "evidence/verify.json", {
      status: "passed",
      sha256: build.outputs.installer.sha256,
    });
    p.attest("verify", { by: "Kaleb", evidence: { verifyReport: good } });

    // verify completes from the attestation; pins derives every pin from receipts; stops at the human QA phase.
    r = await p.run("all", { execute: true });
    assert.equal(r.stoppedAt, "qa");
    const pins = p.state.receipt("pins").value;
    const env = readFileSync(pins.outputs.pinsEnv.path, "utf8");
    assert.match(env, new RegExp(`^PRODUCT_SHA40=${fx.commit}$`, "m"));
    assert.match(env, new RegExp(`^INSTALLER_SHA256=${build.outputs.installer.sha256}$`, "m"));
    assert.match(env, new RegExp(`^BUILD_SIZE=${build.outputs.installer.size}$`, "m"));
    assert.equal(pins.outputs.product, fx.commit);

    const sheet = writeJson(fx.repo, "evidence/qa.json", { result: "PASS" });
    p.attest("qa", { by: "Kaleb", evidence: { sheet } });

    // A production write never runs from a group/all selection, and never without approval.
    r = await p.run("all", { execute: true });
    assert.equal(r.stoppedAt, "stage");
    assert.equal(existsSync(join(fx.repo, "stage-calls.log")), false);
    r = await p.run("stage", { execute: true });
    assert.equal(r.status, "AWAITING-APPROVAL");
    assert.equal(existsSync(join(fx.repo, "stage-calls.log")), false);
    refused(() => p.approve("stage", { by: "Kaleb", confirm: "stage:1.2.3:wrong" }), /--confirm must be exactly/);
    refused(() => p.approve("build", { by: "Kaleb", confirm: "x" }), /does not take an approval/);
    p.approve("stage", { by: "Kaleb", confirm: `stage:1.2.3:${fx.commit.slice(0, 7)}` });
    // The approval covers the exact commands: a kit that changes them after approval needs a new approval.
    const changed = makeKit(fx.repo);
    changed.phases.stage.steps[1].run = [...changed.phases.stage.steps[1].run, "--force"];
    const drifted = makePipeline(fx, changed).describe("stage")[0];
    assert.equal(drifted.status, "AWAITING-APPROVAL");
    assert.match(drifted.detail, /stale/);
    r = await p.run("stage", { execute: true });
    assert.equal(r.code, 0);
    const calls = readFileSync(join(fx.repo, "stage-calls.log"), "utf8").trim().split("\n");
    assert.deepEqual(
      calls.map((l) => l.split(" ")[0]),
      ["DRYRUN", "EXECUTE"],
    );
    const stage = p.state.receipt("stage").value;
    assert.equal(stage.approval.by, "Kaleb");
    assert.equal(stage.outputs.stageReceipt.sha256.length, 64);

    // Poll until done, then everything is DONE and a rerun is a no-op (resume).
    r = await p.run("readback", { execute: true });
    assert.equal(r.code, 0);
    assert.equal(p.state.receipt("readback").value.outputs.state, "passed");
    p = makePipeline(fx, kit);
    r = await p.run("all", { execute: true });
    assert.equal(r.code, 0);
    assert.ok(p.describe("all").every((x) => x.status === "DONE"));
    assert.equal(
      readFileSync(join(fx.repo, "stage-calls.log"), "utf8").trim().split("\n").length,
      2,
      "resume does not repeat the production write",
    );

    // Redo of a production write is refused; the tool's own resume path applies.
    await refusedAsync(p.run("stage", { execute: true, redo: true }), /own resume path/);
  });

  test("drift and staleness: changed artifacts, redone inputs and stale approvals all stop the pipeline", async () => {
    const kit = makeKit(fx.repo);
    const p = makePipeline(fx, kit);
    // Tampering with a certified artifact stops every downstream phase.
    const installer = p.state.receipt("build").value.outputs.installer.path;
    const original = readFileSync(installer);
    writeFileSync(installer, Buffer.concat([original, Buffer.from("x")]));
    await refusedAsync(
      p.executePhase(
        TEST_PHASES.find((x) => x.id === "readback"),
        { status: "READY" },
      ),
      /artifact drift/,
    );
    writeFileSync(installer, original);

    // Redoing an upstream phase makes everything after it STALE and its approval stale.
    rmSync(join(fx.repo, `out-${fx.commit.slice(0, 7)}`), { recursive: true, force: true });
    const r = await p.run("build", { execute: true, redo: true });
    assert.equal(r.code, 0);
    const status = Object.fromEntries(p.describe("all").map((x) => [x.id, x.status]));
    assert.equal(status.build, "DONE");
    assert.equal(status.verify, "STALE");
    assert.equal(status.stage, "STALE");
    assert.ok(
      readdirSync(p.state.path("receipts", "superseded")).some((f) => f.startsWith("build-")),
      "old receipt kept",
    );
    // verify must be redone; its old attestation is bound to the old build receipt.
    const again = await p.run("verify", { execute: true, redo: true });
    assert.equal(again.status, "AWAITING-OPERATOR");
  });

  test("kit script integrity, identity mismatches, failures and the run lock", async () => {
    const fx2 = makeRepo();
    try {
      const kit = makeKit(fx2.repo);
      kit.scripts["kit/build.mjs"] = "0".repeat(64);
      let p = makePipeline(fx2, kit);
      const blocked = await p.run("build", { execute: true });
      assert.equal(blocked.code, 1, "a phase whose inputs are not done is BLOCKED, not run");
      assert.equal(blocked.status, "BLOCKED");
      await refusedAsync(p.run("identity,build", { execute: true }), /integrity/);
      assert.ok(readdirSync(p.state.path("failures")).some((f) => f.startsWith("build-")));

      p = makePipeline(
        fx2,
        makeKit(fx2.repo, {
          phases: { build: { steps: [{ id: "x", run: ["node", "kit/fail.mjs"], uses: ["kit/fail.mjs"] }] } },
        }),
      );
      await refusedAsync(p.run("build", { execute: true }), /exited 3/);
      assert.equal(p.state.receipt("build"), null, "no receipt for a failed phase");

      const release = p.state.lock("other");
      await refusedAsync(p.run("build", { execute: true }), /holds/);
      release();

      // A state directory stays bound to one identity.
      const other = new ReleaseState(p.state.dir);
      refused(() => other.bind(validateIdentity({ version: "1.2.4", commit: fx2.commit })), /belongs to/);
    } finally {
      rmSync(fx2.repo, { recursive: true, force: true });
    }

    const wrong = makeRepo("1.2.2");
    try {
      const p = makePipeline(wrong, makeKit(wrong.repo));
      await refusedAsync(p.run("identity", { execute: true }), /declares "1\.2\.2", not 1\.2\.3/);
    } finally {
      rmSync(wrong.repo, { recursive: true, force: true });
    }
    const baseline = makeRepo("1.2.3", 'Self::Stable => "https://kalcoded.com/releases/updater/stable/1.2.4.json"');
    try {
      const p = makePipeline(baseline, makeKit(baseline.repo));
      await refusedAsync(p.run("identity", { execute: true }), /moving stable endpoint/);
    } finally {
      rmSync(baseline.repo, { recursive: true, force: true });
    }
  });

  test("adopt records work done outside the orchestrator only when its outputs pass the same gates", async () => {
    const fx3 = makeRepo();
    try {
      const kit = makeKit(fx3.repo);
      const p = makePipeline(fx3, kit);
      await p.run("identity", { execute: true });
      // Nothing built yet: adoption fails on the missing artifacts.
      await refusedAsync(p.run("build", { execute: true, adopt: true, evidence: {} }), /does not exist/);
      spawnSync(
        process.execPath,
        ["kit/build.mjs", fx3.commit, "1.2.3", join(fx3.repo, `out-${fx3.commit.slice(0, 7)}`)],
        { cwd: fx3.repo },
      );
      const line = join(fx3.repo, "evidence", "build-line.txt");
      mkdirSync(join(line, ".."), { recursive: true });
      writeFileSync(line, "built 1.2.3\n");
      const r = await p.run("build", { execute: true, adopt: true, evidence: { builtLine: line } });
      assert.equal(r.code, 0);
      const rec = p.state.receipt("build").value;
      assert.equal(rec.adopted, true);
      assert.equal(rec.steps[0].kind, "adopted");
      await refusedAsync(p.run("all", { execute: true, adopt: true }), /exactly one/);
    } finally {
      rmSync(fx3.repo, { recursive: true, force: true });
    }
  });

  test("real kit scripts are checked byte-for-byte when present", () => {
    const here = fileURLToPath(new URL("./ship/kits/b10-0.1.6.json", import.meta.url));
    const { kit } = loadKit(here);
    const problems = verifyScripts(kit, fx.repo, ["tooling/release/updater-key.mjs"]);
    assert.match(problems[0], /missing/);
  });
});
