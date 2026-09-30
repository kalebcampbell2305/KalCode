// Tests for the Definition of Done enforcement (tooling/release/lifecycle/*, `ship.mjs classify|lifecycle|gate`).
// Everything runs against throwaway git repositories and injected observations: no network, no production.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { classifyChanges, classifyRange, dependentsOf, renderClassify, workspaceGraph } from "./lifecycle/classify.mjs";
import { gateForWorktree, recordGate, runGates, selectGates } from "./lifecycle/gate.mjs";
import { makeGit, parseNameStatus } from "./lifecycle/git.mjs";
import { evaluateStop } from "./lifecycle/hook.mjs";
import { changedImporters, LockfileError, parsePnpmLock } from "./lifecycle/lockfile.mjs";
import { globToRegExp, loadPolicy, matchGlob, POLICY_PATH, pipelineFor, validatePolicy } from "./lifecycle/policy.mjs";
import {
  compareVersions,
  computeStatus,
  observeProduction,
  publishedDesktop,
  renderStatus,
  stateDir,
  writeJsonAtomic,
} from "./lifecycle/status.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const SHIP = join(HERE, "ship.mjs");
const policy = loadPolicy();
const clone = (v) => JSON.parse(JSON.stringify(v));

// ------------------------------------------------------------------ fixtures

const temps = [];
after(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

function sh(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/** Minimal pnpm lockfile v9 text. importers: { path: { name: version } }; snapshots: { key: { deps, integrity } }. */
function lockText({ importers, snapshots, settings = "autoInstallPeers: true" }) {
  const out = ["lockfileVersion: '9.0'", "", "settings:", `  ${settings}`, "", "importers:", ""];
  for (const [path, deps] of Object.entries(importers)) {
    out.push(`  ${path}:`);
    const entries = Object.entries(deps);
    if (entries.length) out.push("    dependencies:");
    for (const [name, version] of entries) {
      const q = name.startsWith("@") ? `'${name}'` : name;
      out.push(`      ${q}:`, `        specifier: ${version.startsWith("link:") ? "workspace:*" : version}`);
      out.push(`        version: ${version}`);
    }
    out.push("");
  }
  out.push("packages:", "");
  for (const [key, s] of Object.entries(snapshots)) {
    out.push(`  ${key.replace(/\(.*$/, "")}:`, `    resolution: {integrity: ${s.integrity ?? "sha512-x"}}`, "");
  }
  out.push("snapshots:", "");
  for (const [key, s] of Object.entries(snapshots)) {
    const deps = Object.entries(s.deps ?? {});
    if (!deps.length) out.push(`  ${key}: {}`, "");
    else {
      out.push(`  ${key}:`, "    dependencies:");
      for (const [n, v] of deps) out.push(`      ${n}: ${v}`);
      out.push("");
    }
  }
  return out.join("\n");
}

const BASE_LOCK = {
  importers: {
    ".": { typescript: "1.0.0" },
    "apps/api": { "@kalcode/protocol": "link:../../packages/protocol", wrangler: "1.0.0" },
    "apps/desktop": {
      "@kalcode/protocol": "link:../../packages/protocol",
      "@kalcode/ui": "link:../../packages/ui",
      react: "1.0.0",
    },
    "apps/website": {
      "@kalcode/protocol": "link:../../packages/protocol",
      "@kalcode/ui": "link:../../packages/ui",
      astro: "1.0.0",
    },
    "packages/protocol": {},
    "packages/testing": { "@kalcode/protocol": "link:../protocol", vitest: "1.0.0" },
    "packages/ui": { "@kalcode/protocol": "link:../protocol", radix: "1.0.0" },
    tooling: { sharp: "1.0.0" },
  },
  snapshots: {
    "astro@1.0.0": { deps: { vite: "2.0.0" } },
    "loose-envify@1.0.0": {},
    "radix@1.0.0": { deps: { react: "1.0.0" } },
    "react@1.0.0": { deps: { "loose-envify": "1.0.0" } },
    "sharp@1.0.0": {},
    "typescript@1.0.0": {},
    "vite@2.0.0": {},
    "vitest@1.0.0": { deps: { vite: "2.0.0" } },
    "wrangler@1.0.0": {},
  },
};

function makeFixture({ version = "1.2.0" } = {}) {
  const repo = mkdtempSync(join(tmpdir(), "lifecycle-test-"));
  temps.push(repo);
  sh(repo, "init", "-q", "-b", "main");
  sh(repo, "config", "user.email", "t@example.invalid");
  sh(repo, "config", "user.name", "lifecycle test");
  sh(repo, "config", "core.autocrlf", "false");
  const f = {
    repo,
    write(rel, text) {
      mkdirSync(dirname(join(repo, rel)), { recursive: true });
      writeFileSync(join(repo, rel), text);
    },
    rm: (rel) => sh(repo, "rm", "-q", rel),
    mv: (a, b) => sh(repo, "mv", a, b),
    commit(msg) {
      sh(repo, "add", "-A");
      sh(repo, "commit", "-q", "--allow-empty", "-m", msg);
      return sh(repo, "rev-parse", "HEAD");
    },
    git: makeGit(repo),
    setOriginMain: (sha) => sh(repo, "update-ref", "refs/remotes/origin/main", sha),
  };
  const pkg = (name, deps = []) =>
    JSON.stringify({ name, dependencies: Object.fromEntries(deps.map((d) => [d, "workspace:*"])) });
  f.write("apps/desktop/package.json", pkg("@kalcode/desktop", ["@kalcode/ui", "@kalcode/protocol"]));
  f.write("apps/desktop/src-tauri/tauri.conf.json", JSON.stringify({ productName: "KalCode", version }));
  f.write("apps/desktop/src/main.tsx", "export {};\n");
  f.write("apps/website/package.json", pkg("@kalcode/website", ["@kalcode/ui", "@kalcode/protocol"]));
  f.write("apps/website/src/pages/index.astro", "<h1>KalCode</h1>\n");
  f.write("apps/website/src/lib/a.ts", "export const a = 1;\n");
  f.write("apps/api/package.json", pkg("@kalcode/api", ["@kalcode/protocol"]));
  f.write("apps/api/worker/index.ts", "export default {};\n");
  f.write("packages/protocol/package.json", pkg("@kalcode/protocol"));
  f.write("packages/protocol/src/index.ts", "export const p = 1;\n");
  f.write("packages/ui/package.json", pkg("@kalcode/ui", ["@kalcode/protocol"]));
  f.write("packages/ui/src/index.ts", "export const u = 1;\n");
  f.write("packages/testing/package.json", pkg("@kalcode/testing", ["@kalcode/protocol"]));
  f.write("packages/testing/src/index.ts", "export const t = 1;\n");
  f.write("tooling/package.json", pkg("@kalcode/tooling"));
  f.write("tooling/release/lifecycle/policy.json", readFileSync(POLICY_PATH, "utf8"));
  f.write("crates/updater/src/lib.rs", "pub fn x() {}\n");
  f.write("docs/ARCHITECTURE.md", "# Architecture\n");
  f.write("pnpm-lock.yaml", lockText(BASE_LOCK));
  f.base = f.commit("fixture");
  f.setOriginMain(f.base);
  return f;
}

const lanesOf = (r) => r.lanes.join(",");

// ------------------------------------------------------------------ policy

describe("policy", () => {
  test("policy.json is valid, has exactly the four lanes and a conservative fallback", () => {
    assert.deepEqual(validatePolicy(policy), []);
    assert.deepEqual(Object.keys(policy.lanes).sort(), ["desktop", "docs", "internal", "website"]);
    assert.deepEqual(policy.fallback.lanes, ["desktop", "website"]);
  });

  test("validation rejects an internal fallback, unknown lanes and targets without their lane", () => {
    const bad = clone(policy);
    bad.fallback.lanes = ["internal"];
    bad.fallback.targets = [];
    bad.rules[0].lanes = ["nowhere"];
    bad.rules.find((r) => r.id === "api").lanes = ["desktop"];
    const problems = validatePolicy(bad).join("\n");
    assert.match(problems, /fallback must never be internal/);
    assert.match(problems, /unknown lane nowhere/);
    assert.match(problems, /target api needs its lane/);
  });

  test("glob semantics: ** spans directories (and may be empty), * and ? stay in one segment", () => {
    assert.ok(matchGlob("**/*.test.ts", "a.test.ts"));
    assert.ok(matchGlob("**/*.test.ts", "apps/x/src/a.test.ts"));
    assert.ok(matchGlob("apps/*/tests/**", "apps/website/tests/e2e/a.spec.ts"));
    assert.ok(!matchGlob("apps/*/tests/**", "apps/website/src/tests.ts"));
    assert.ok(!matchGlob("crates/*/Cargo.toml", "crates/a/b/Cargo.toml"));
    assert.ok(matchGlob("a/{b,c}.json", "a/c.json"));
    assert.ok(matchGlob("?.md", "x.md") && !matchGlob("?.md", "xy.md"));
    assert.ok(!matchGlob("package.json", "apps/website/package.json"), "root-only globs are anchored");
    assert.equal(globToRegExp("a.b+c").test("aXb+c"), false, "regex metacharacters are literal");
  });

  test("every tracked file of this repository matches an explicit rule (no silent fallback)", () => {
    const files = spawnSync("git", ["-C", ROOT, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 1e8 })
      .stdout.split("\0")
      .filter(Boolean);
    assert.ok(files.length > 100);
    const unmatched = files.filter((p) => !policy.rules.some((r) => r.globs.some((g) => matchGlob(g, p))));
    assert.deepEqual(unmatched, []);
  });

  test("production endpoints match the real updater, catalog and website stamp", () => {
    const updater = readFileSync(join(ROOT, "crates/updater/src/lib.rs"), "utf8");
    assert.ok(updater.includes(`Self::Stable => "${policy.production.desktop.feedUrl}"`));
    const downloads = readFileSync(join(ROOT, "apps/website/worker/downloads.ts"), "utf8");
    assert.match(downloads, /MANIFEST_PATH = "\/releases\/latest\.json"/);
    assert.equal(policy.production.desktop.catalogUrl, "https://kalcoded.com/releases/latest.json");
    const stamp = readFileSync(join(ROOT, "apps/website/scripts/build-stamp.mjs"), "utf8");
    assert.match(stamp, /STAMP_PATH = "\.well-known\/kalcode-build\.json"/);
    assert.equal(policy.production.website.stampUrl, "https://kalcoded.com/.well-known/kalcode-build.json");
    const conf = JSON.parse(readFileSync(join(ROOT, policy.production.desktop.versionFile), "utf8"));
    assert.match(conf.version, /^\d+\.\d+\.\d+$/);
  });

  test("the lifecycle is ordered by stage, and internal-only work never deploys", () => {
    const internal = pipelineFor(policy, { lanes: ["internal"] }).map((s) => s.id);
    assert.deepEqual(internal, ["implement", "test", "review", "commit", "merge", "internal.none", "report"]);
    const both = pipelineFor(policy, { lanes: ["desktop", "website"], targets: ["desktop", "website"] });
    const stages = both.map((s) => policy.stages.indexOf(s.stage));
    assert.deepEqual(
      stages,
      [...stages].sort((a, b) => a - b),
    );
    const ids = both.map((s) => s.id);
    for (const id of ["desktop.release", "desktop.publish", "desktop.verify", "website.deploy", "website.verify"])
      assert.ok(ids.includes(id), id);
    assert.ok(ids.indexOf("merge") < ids.indexOf("website.deploy"));
    assert.ok(!ids.includes("internal.none") && !ids.includes("api.deploy") && !ids.includes("website.migrate"));
  });

  test("path-conditional steps: D1 migrations only when migrations changed, api steps only for the api", () => {
    const ids = (paths, targets) => pipelineFor(policy, { lanes: ["website"], targets, paths }).map((s) => s.id);
    assert.ok(ids(["apps/website/migrations/0009_x.sql"], ["website"]).includes("website.migrate"));
    assert.ok(!ids(["apps/website/src/a.ts"], ["website"]).includes("website.migrate"));
    const api = ids(["apps/api/migrations/0010_x.sql"], ["api"]);
    assert.ok(api.includes("api.migrate") && api.includes("api.deploy") && !api.includes("website.deploy"));
  });
});

// ------------------------------------------------------------------ classify

describe("classify", () => {
  const stubGit = { show: () => null, lsTree: () => [] };
  const one = (path) => classifyChanges(policy, stubGit, [{ status: "M", path }], { base: "a", head: "b" });

  test("static rules for the real repository layout", () => {
    const cases = {
      "apps/website/src/pages/index.astro": "website",
      "apps/website/package.json": "website",
      "apps/api/worker/index.ts": "website",
      "apps/desktop/src/App.tsx": "desktop",
      "apps/desktop/src-tauri/src/main.rs": "desktop",
      "crates/updater/src/lib.rs": "desktop",
      "Cargo.toml": "desktop",
      "Cargo.lock": "desktop",
      "third_party/portable-pty/src/lib.rs": "desktop",
      ".cargo/config.toml": "desktop",
      "docs/releases/0.1.6.md": "docs",
      "docs/ARCHITECTURE.md": "internal",
      "tooling/release/ship.mjs": "internal",
      ".github/workflows/ci.yml": "internal",
      ".claude/settings.json": "internal",
      "AGENTS.md": "internal",
      "package.json": "internal",
      "apps/website/tests/e2e/pages.spec.ts": "internal",
      "apps/desktop/src/foo.test.tsx": "internal",
      "crates/updater/tests/feed.rs": "internal",
      "tsconfig.base.json": "desktop,website",
      "patches/cmdk@1.1.1.patch": "desktop,website",
      "somewhere/new.txt": "desktop,website",
    };
    for (const [path, lanes] of Object.entries(cases)) assert.equal(lanesOf(one(path)), lanes, path);
    assert.deepEqual(one("apps/api/worker/index.ts").targets, ["api"]);
    assert.deepEqual(one("apps/website/src/a.ts").targets, ["website"]);
    assert.equal(one("somewhere/new.txt").files[0].rule, "fallback");
    assert.equal(one("docs/ARCHITECTURE.md").production, false);
    assert.equal(one("docs/releases/0.1.6.md").production, true);
  });

  test("renames count both sides and deletions count the deleted path", () => {
    const f = makeFixture();
    sh(f.repo, "checkout", "-q", "-b", "feat");
    f.mv("apps/website/src/lib/a.ts", "apps/desktop/src/a.ts");
    f.rm("crates/updater/src/lib.rs");
    f.commit("move and delete");
    const r = classifyRange(policy, f.git, { base: "main", head: "feat" });
    assert.equal(lanesOf(r), "desktop,website");
    const paths = r.files.map((x) => x.path);
    assert.ok(paths.includes("apps/website/src/lib/a.ts") && paths.includes("apps/desktop/src/a.ts"));
    assert.ok(paths.includes("crates/updater/src/lib.rs"));
    const renameOnly = parseNameStatus("R100\0apps/website/x.ts\0tooling/x.ts\0D\0crates/a/b.rs\0");
    assert.deepEqual(renameOnly, [
      { status: "R", oldPath: "apps/website/x.ts", path: "tooling/x.ts" },
      { status: "D", path: "crates/a/b.rs" },
    ]);
  });

  test("workspace packages ship wherever their dependent apps ship; an unused package is internal", () => {
    const f = makeFixture();
    const graphs = [workspaceGraph(f.git, "HEAD")];
    assert.deepEqual(dependentsOf(graphs, "packages/ui"), ["apps/desktop", "apps/website"]);
    assert.deepEqual(dependentsOf(graphs, "packages/protocol"), [
      "apps/api",
      "apps/desktop",
      "apps/website",
      "packages/testing",
      "packages/ui",
    ]);
    const change = (path) => {
      f.write(path, `export const changed = ${Math.random()};\n`);
      const sha = f.commit(`change ${path}`);
      return classifyRange(policy, f.git, { base: `${sha}^`, head: sha });
    };
    const ui = change("packages/ui/src/index.ts");
    assert.equal(lanesOf(ui), "desktop,website");
    assert.deepEqual(ui.targets, ["desktop", "website"]);
    assert.deepEqual(change("packages/protocol/src/index.ts").targets, ["desktop", "website", "api"]);
    assert.equal(lanesOf(change("packages/testing/src/index.ts")), "internal");
  });

  test("lockfile: a change ships only in the lanes whose importers' graphs changed", () => {
    const f = makeFixture();
    const bump = (mutate, msg) => {
      const lock = clone(BASE_LOCK);
      mutate(lock);
      f.write("pnpm-lock.yaml", lockText(lock));
      const sha = f.commit(msg);
      const r = classifyRange(policy, f.git, { base: `${sha}^`, head: sha });
      f.write("pnpm-lock.yaml", lockText(BASE_LOCK));
      f.commit(`revert ${msg}`);
      return r;
    };
    // astro's transitive vite bump reaches only the website.
    const website = bump((l) => {
      l.snapshots["astro@1.0.0"].deps.vite = "3.0.0";
      l.snapshots["vite@3.0.0"] = {};
    }, "vite for astro");
    assert.equal(lanesOf(website), "website");
    assert.deepEqual(website.targets, ["website"]);
    // loose-envify is reached by the desktop directly and through packages/ui (linked by desktop and website).
    const shared = bump((l) => {
      l.snapshots["loose-envify@1.0.0"].integrity = "sha512-changed";
    }, "loose-envify integrity");
    assert.equal(lanesOf(shared), "desktop,website");
    // A tooling-only dependency is internal.
    const tooling = bump((l) => {
      l.snapshots["sharp@1.0.0"].integrity = "sha512-new";
    }, "sharp");
    assert.equal(lanesOf(tooling), "internal");
    // A workspace package importer change propagates to the apps linking it.
    const uiDeps = bump((l) => {
      l.importers["packages/ui"].radix = "1.0.0";
      l.importers["packages/ui"].extra = "1.0.0";
      l.snapshots["extra@1.0.0"] = {};
    }, "ui dep");
    assert.equal(lanesOf(uiDeps), "desktop,website");
    // Anything the reader cannot attribute is conservative, never internal.
    const settings = bump((l) => l, "noop");
    assert.equal(lanesOf(settings), "", "an identical lockfile is no change at all");
    f.write("pnpm-lock.yaml", lockText({ ...BASE_LOCK, settings: "autoInstallPeers: false" }));
    const s = f.commit("settings");
    const r = classifyRange(policy, f.git, { base: `${s}^`, head: s });
    assert.equal(lanesOf(r), "desktop,website");
    assert.match(r.files[0].why, /settings changed: conservative/);
  });

  test("lockfile reader: deletion, unknown versions and garbage are conservative errors", () => {
    const text = lockText(BASE_LOCK);
    assert.throws(() => changedImporters(text, null), LockfileError);
    assert.throws(() => changedImporters(text.replace("'9.0'", "'6.0'"), text), LockfileError);
    assert.throws(() => changedImporters("{not yaml", text), LockfileError);
    assert.deepEqual(changedImporters(text, text), []);
    const parsed = parsePnpmLock(text);
    assert.deepEqual(parsed.snapshots["react@1.0.0"].deps, ["loose-envify@1.0.0"]);
    assert.deepEqual(
      parsed.importers["apps/website"].deps.map((d) => d.name),
      ["@kalcode/protocol", "@kalcode/ui", "astro"],
    );
  });

  test("the real pnpm-lock.yaml parses and every importer is known to the policy or a workspace package", () => {
    const lock = parsePnpmLock(readFileSync(join(ROOT, "pnpm-lock.yaml"), "utf8"));
    for (const imp of Object.keys(lock.importers))
      assert.ok(policy.importers[imp] || /^packages\/[^/]+$/.test(imp), `unmapped importer ${imp}`);
    assert.ok(Object.keys(lock.snapshots).length > 100);
  });

  test("merge-base semantics: main moving on does not leak into a branch's lanes", () => {
    const f = makeFixture();
    sh(f.repo, "checkout", "-q", "-b", "feat");
    f.write("docs/ARCHITECTURE.md", "# changed\n");
    f.commit("docs");
    sh(f.repo, "checkout", "-q", "main");
    f.write("crates/updater/src/lib.rs", "pub fn y() {}\n");
    f.commit("desktop on main");
    const r = classifyRange(policy, f.git, { base: "main", head: "feat" });
    assert.equal(lanesOf(r), "internal");
    assert.equal(r.production, false);
  });

  test("deterministic output and a working CLI (text, --json, --markdown, errors)", () => {
    const f = makeFixture();
    f.write("apps/website/src/pages/index.astro", "<h1>new</h1>\n");
    f.write("apps/website/migrations/0002_x.sql", "select 1;\n");
    const head = f.commit("site");
    const a = classifyRange(policy, f.git, { base: f.base, head });
    const b = classifyRange(policy, makeGit(f.repo), { base: f.base, head });
    assert.deepEqual(a, b);
    const run = (...args) => spawnSync(process.execPath, [SHIP, ...args, "--repo", f.repo], { encoding: "utf8" });
    const json = run("classify", "--base", f.base, "--head", head, "--json");
    assert.equal(json.status, 0, json.stderr);
    const parsed = JSON.parse(json.stdout);
    assert.deepEqual(parsed.lanes, ["website"]);
    assert.ok(parsed.pipeline.some((s) => s.id === "website.migrate"));
    const md = run("classify", "--base", f.base, "--head", head, "--markdown");
    assert.match(md.stdout, /\*\*Lanes:\*\* website/);
    assert.match(md.stdout, /Deploy the kalcode-website Worker/);
    assert.match(renderClassify(a), /required lifecycle:/);
    const bad = run("classify", "--base", f.base);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /classify needs --base <ref> and --head <ref>/);
    assert.match(run("classify", "--bogus", "x").stderr, /unknown argument --bogus/);
    assert.match(run("classify", "--base", "nope", "--head", head).stderr, /unknown --base ref nope/);
  });
});

// ------------------------------------------------------------------ status

const obsWith = ({ stamp = null, feed = null, catalog = null } = {}) => ({
  schema: "kalcode-lifecycle-observations/v1",
  checkedAt: new Date().toISOString(),
  website: stamp
    ? { ok: true, url: "u", commit: stamp, builtAt: "2026-09-29T00:00:00Z", dirty: false }
    : { ok: false, url: "https://kalcoded.com/.well-known/kalcode-build.json", error: "HTTP 404" },
  api: { ok: false, error: "api.kalcoded.com exposes no build stamp yet" },
  desktop: {
    feed: feed ? { ok: true, ...feed } : { ok: false, url: "f", error: "HTTP 404" },
    catalog: catalog ? { ok: true, ...catalog } : { ok: false, url: "c", error: "HTTP 503" },
  },
});

describe("lifecycle status", () => {
  test("version comparison", () => {
    assert.equal(compareVersions("0.1.6", "0.1.1"), 1);
    assert.equal(compareVersions("0.1.10", "0.1.9"), 1);
    assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
    assert.equal(compareVersions("1.0.0-beta.1", "1.0.0"), -1);
    assert.equal(compareVersions("x", "1.0.0"), null);
  });

  test("observations come from the stamp, the Stable feed and the catalog, and never throw", async () => {
    const commit = "a".repeat(40);
    const responses = {
      [policy.production.website.stampUrl]: { status: 200, body: { schema: "kalcode-build/v1", commit, dirty: false } },
      [policy.production.desktop.feedUrl]: { status: 404, body: "<html>" },
      [policy.production.desktop.catalogUrl]: {
        status: 200,
        body: { latest: { version: "0.1.1", channel: "preview", commit: "b".repeat(40) } },
      },
    };
    const seen = [];
    const fetchImpl = async (url, init) => {
      seen.push({ url, method: init?.method ?? "GET" });
      const r = responses[url.replace(/[?&]lifecycle=\d+$/, "")];
      return {
        ok: r.status < 300,
        status: r.status,
        text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body)),
      };
    };
    const obs = await observeProduction(policy, { fetchImpl });
    assert.ok(
      seen.every((s) => s.method === "GET"),
      "read-only",
    );
    assert.equal(obs.website.commit, commit);
    assert.equal(obs.desktop.feed.ok, false);
    assert.deepEqual(publishedDesktop(obs), {
      version: "0.1.1",
      commit: "b".repeat(40),
      channel: "preview",
      source: "catalog (preview channel; stable feed: HTTP 404)",
    });
    const failing = await observeProduction(policy, {
      fetchImpl: async () => {
        throw new Error("offline");
      },
    });
    assert.equal(failing.website.ok, false);
    assert.equal(publishedDesktop(failing), null);
    const hanging = await observeProduction(policy, {
      timeoutMs: 20,
      fetchImpl: (_u, { signal }) =>
        new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(Object.assign(new Error("x"), { name: "AbortError" }))),
        ),
    });
    assert.match(hanging.website.error, /timeout after 20 ms/);
    const badStamp = await observeProduction(policy, {
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ commit: "main" }) }),
    });
    assert.match(badStamp.website.error, /no valid commit/);
  });

  test("website: unknown without a stamp, unshipped with website commits after the stamp, shipped when current", () => {
    const f = makeFixture();
    const deployed = f.base;
    f.write("apps/website/src/pages/index.astro", "<h1>new copy</h1>\n");
    f.commit("feat(website): new copy");
    f.write("tooling/x.mjs", "x\n");
    const main = f.commit("chore: tooling");
    f.setOriginMain(main);
    const unknown = computeStatus(policy, f.git, obsWith());
    assert.equal(unknown.targets.website.state, "unknown");
    assert.match(unknown.targets.website.reason, /unknown deployed commit/);
    const behind = computeStatus(policy, f.git, obsWith({ stamp: deployed }));
    assert.equal(behind.targets.website.state, "unshipped");
    assert.deepEqual(
      behind.targets.website.commits.map((c) => c.subject),
      ["feat(website): new copy"],
    );
    assert.ok(behind.unshippedLanes.includes("website"));
    assert.equal(computeStatus(policy, f.git, obsWith({ stamp: main })).targets.website.state, "shipped");
    const foreign = computeStatus(policy, f.git, obsWith({ stamp: "c".repeat(40) }));
    assert.match(foreign.targets.website.reason, /not in local history/);
    assert.equal(foreign.targets.api.state, "unknown");
  });

  test("desktop: version ahead of production, desktop changes after the published build, or up to date", () => {
    const f = makeFixture({ version: "1.2.0" });
    const release = f.base;
    const ahead = computeStatus(
      policy,
      f.git,
      obsWith({ feed: { version: "1.1.0", commit: null, channel: "stable" } }),
    );
    assert.equal(ahead.targets.desktop.state, "unshipped");
    assert.match(ahead.targets.desktop.reason, /main declares 1\.2\.0; production has 1\.1\.0/);
    assert.equal(ahead.targets["release-notes"].state, "unshipped");
    assert.match(ahead.targets["release-notes"].reason, /docs\/releases\/1\.2\.0\.md is not on main yet/);

    const current = obsWith({ feed: { version: "1.2.0", commit: release, channel: "stable" } });
    assert.equal(computeStatus(policy, f.git, current).targets.desktop.state, "shipped");

    f.write("docs/ARCHITECTURE.md", "# internal only\n");
    f.setOriginMain(f.commit("docs: internal"));
    assert.equal(computeStatus(policy, f.git, current).targets.desktop.state, "shipped");

    f.write("crates/updater/src/lib.rs", "pub fn fixed() {}\n");
    f.setOriginMain(f.commit("fix(updater): after release"));
    const after = computeStatus(policy, f.git, current);
    assert.equal(after.targets.desktop.state, "unshipped");
    assert.match(after.targets.desktop.reason, /need a new version/);
    assert.deepEqual(
      after.targets.desktop.commits.map((c) => c.subject),
      ["fix(updater): after release"],
    );

    const viaCatalog = obsWith({ catalog: { version: "1.2.0", commit: release, channel: "stable" } });
    assert.equal(computeStatus(policy, f.git, viaCatalog).targets.desktop.published.version, "1.2.0");
    const dark = computeStatus(policy, f.git, obsWith());
    assert.equal(dark.targets.desktop.state, "unknown");
    assert.match(dark.targets.desktop.reason, /production feed unreachable/);
    assert.match(renderStatus(after), /unshipped desktop/);
    assert.match(renderStatus(after, { markdown: true }), /Unshipped production lanes: desktop/);
  });

  test("release notes: notes for the published or an older version are shipped; newer notes are not", () => {
    const f = makeFixture({ version: "1.2.0" });
    const current = obsWith({ feed: { version: "1.2.0", commit: f.base, channel: "stable" } });
    f.write("docs/releases/1.2.0.md", "# 1.2.0\n\nNotes bound after the release build.\n");
    f.commit("docs(release): bind 1.2.0 notes");
    f.write("docs/releases/1.1.0.md", "# 1.1.0\n\nTypo fix.\n");
    f.setOriginMain(f.commit("docs(release): fix 1.1.0 notes"));
    const published = computeStatus(policy, f.git, current);
    assert.equal(published.targets["release-notes"].state, "shipped");
    assert.ok(!published.unshippedLanes.includes("docs"));

    f.write("docs/releases/1.3.0.md", "# 1.3.0\n");
    f.setOriginMain(f.commit("docs(release): draft 1.3.0 notes"));
    const next = computeStatus(policy, f.git, current);
    assert.equal(next.targets["release-notes"].state, "unshipped");
    assert.deepEqual(
      next.targets["release-notes"].commits.map((c) => c.subject),
      ["docs(release): draft 1.3.0 notes"],
    );
    assert.ok(next.unshippedLanes.includes("docs"));
  });

  test("status CLI --offline reads the cache and --check fails while lanes are unshipped", () => {
    const f = makeFixture({ version: "1.2.0" });
    const dir = stateDir(f.git.commonDir());
    const run = (...args) =>
      spawnSync(process.execPath, [SHIP, "lifecycle", "status", ...args, "--repo", f.repo], { encoding: "utf8" });
    assert.match(run("--offline").stderr, /no cached production observations/);
    writeJsonAtomic(join(dir, "observations.json"), obsWith({ feed: { version: "1.1.0", commit: null } }));
    const r = run("--offline", "--json");
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).unshippedLanes, ["desktop", "docs"]);
    assert.equal(run("--offline", "--check").status, 1);
    assert.ok(existsSync(join(dir, "status.json")), "status is cached for the Stop hook");
  });
});

// ------------------------------------------------------------------ Stop hook

describe("Stop hook", () => {
  const input = (f, extra = {}) =>
    JSON.stringify({
      session_id: "s1",
      transcript_path: "/tmp/t.jsonl",
      cwd: f.repo,
      hook_event_name: "Stop",
      stop_hook_active: false,
      ...extra,
    });
  const deps = { refresh: false };

  test("allows when stop_hook_active, on empty or invalid input, other events, and outside KalCode", () => {
    const f = makeFixture();
    sh(f.repo, "checkout", "-q", "-b", "feat");
    f.commit("unmerged");
    assert.equal(evaluateStop(input(f, { stop_hook_active: true }), deps).stdout, "");
    assert.equal(evaluateStop("", deps).stdout, "");
    assert.equal(evaluateStop("{not json", deps).stdout, "");
    assert.equal(evaluateStop(input(f, { hook_event_name: "SubagentStop" }), deps).stdout, "");
    const plain = mkdtempSync(join(tmpdir(), "not-git-"));
    temps.push(plain);
    assert.equal(evaluateStop(JSON.stringify({ cwd: plain, session_id: "x" }), deps).stdout, "");
    sh(f.repo, "rm", "-q", "-r", "tooling/release/lifecycle");
    f.commit("not kalcode");
    assert.equal(evaluateStop(input(f, { session_id: "other" }), deps).stdout, "", "not the KalCode repo");
  });

  test("blocks once per session and state for unmerged branch commits, with the Claude Code block schema", () => {
    const f = makeFixture();
    assert.equal(evaluateStop(input(f), deps).stdout, "", "HEAD is origin/main: nothing to finish");
    sh(f.repo, "checkout", "-q", "-b", "feat/x");
    f.write("apps/website/src/lib/a.ts", "export const a = 2;\n");
    f.commit("feat(website): a");
    const r = evaluateStop(input(f), deps);
    assert.equal(r.code, 0);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(out).sort(), ["decision", "reason"]);
    assert.equal(out.decision, "block");
    assert.match(out.reason, /Branch feat\/x has 1 commit\(s\) not merged to origin\/main/);
    assert.match(out.reason, /ship\.mjs gate --base origin\/main/);
    assert.match(out.reason, /local-only/);
    assert.equal(evaluateStop(input(f), deps).stdout, "", "same session, same state: already told once");
    assert.notEqual(evaluateStop(input(f, { session_id: "s2" }), deps).stdout, "", "another session is told");
    f.commit("more work");
    assert.notEqual(evaluateStop(input(f), deps).stdout, "", "a new state is told again");
  });

  test("merged branches are fine; a passing gate receipt for HEAD is acknowledged", () => {
    const f = makeFixture();
    sh(f.repo, "checkout", "-q", "-b", "feat");
    const head = f.commit("work");
    f.setOriginMain(head);
    assert.equal(evaluateStop(input(f), deps).stdout, "", "HEAD reached origin/main");
    const next = f.commit("more");
    writeJsonAtomic(join(stateDir(f.git.commonDir()), "gates", `${next}.json`), { status: "PASS" });
    assert.match(JSON.parse(evaluateStop(input(f, { session_id: "g" }), deps).stdout).reason, /passed for HEAD/);
  });

  test("blocks for unshipped production lanes on origin/main from the cache, without network", () => {
    const f = makeFixture({ version: "1.2.0" });
    const dir = stateDir(f.git.commonDir());
    writeJsonAtomic(join(dir, "observations.json"), obsWith({ feed: { version: "1.1.0", commit: null } }));
    const out = evaluateStop(input(f), deps);
    assert.match(JSON.parse(out.stdout).reason, /origin\/main has unshipped production lanes: desktop, docs/);
    writeJsonAtomic(join(dir, "observations.json"), obsWith({ feed: { version: "1.2.0", commit: f.base } }));
    assert.equal(evaluateStop(input(f, { session_id: "fresh" }), deps).stdout, "", "production is current");
    const stale = obsWith({ feed: { version: "1.1.0", commit: null } });
    stale.checkedAt = new Date(Date.now() - 48 * 3600e3).toISOString();
    writeJsonAtomic(join(dir, "observations.json"), stale);
    assert.equal(evaluateStop(input(f, { session_id: "stale" }), deps).stdout, "", "stale observations are ignored");
  });

  test("a stale cache starts one detached refresh; the lock prevents a storm", () => {
    const f = makeFixture();
    let calls = 0;
    const d = { spawnRefresh: () => calls++ };
    evaluateStop(input(f), d);
    evaluateStop(input(f), d);
    assert.equal(calls, 1);
    const lock = join(stateDir(f.git.commonDir()), "refresh.lock");
    const old = (Date.now() - 10 * 60e3) / 1000;
    utimesSync(lock, old, old);
    evaluateStop(input(f), d);
    assert.equal(calls, 2);
  });

  test("never fails closed: its own errors and an exhausted time budget allow the stop", () => {
    const f = makeFixture();
    sh(f.repo, "checkout", "-q", "-b", "feat");
    f.commit("unmerged");
    const broken = {
      refresh: false,
      makeGit: () => {
        throw new Error("boom");
      },
    };
    assert.equal(evaluateStop(input(f), broken).stdout, "");
    assert.equal(evaluateStop(input(f), { refresh: false, budgetMs: -1 }).stdout, "");
  });

  test("the CLI hook reads stdin, prints only the decision JSON, exits 0 and is fast", () => {
    const f = makeFixture();
    sh(f.repo, "checkout", "-q", "-b", "feat");
    f.commit("unmerged");
    const env = { ...process.env, KALCODE_LIFECYCLE_HOOK_REFRESH: "0" };
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [SHIP, "lifecycle", "hook"], {
      input: input(f, { session_id: "cli" }),
      encoding: "utf8",
      env,
    });
    const ms = Date.now() - t0;
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).decision, "block");
    assert.ok(ms < 2000, `hook took ${ms} ms`);
    const active = spawnSync(process.execPath, [SHIP, "lifecycle", "hook"], {
      input: input(f, { stop_hook_active: true }),
      encoding: "utf8",
      env,
    });
    assert.equal(active.status, 0);
    assert.equal(active.stdout, "");
  });

  test("the committed project settings register the Stop hook, and .gitignore keeps only settings.json", () => {
    const settings = JSON.parse(readFileSync(join(ROOT, ".claude", "settings.json"), "utf8"));
    const hooks = settings.hooks.Stop.flatMap((m) => m.hooks);
    assert.equal(hooks.length, 1);
    assert.equal(hooks[0].type, "command");
    assert.match(hooks[0].command, /^node "\$\{CLAUDE_PROJECT_DIR\}\/tooling\/release\/ship\.mjs" lifecycle hook$/);
    assert.ok(hooks[0].timeout >= 5);
    const ignore = readFileSync(join(ROOT, ".gitignore"), "utf8").split(/\r?\n/);
    assert.ok(ignore.includes(".claude/*") && ignore.includes("!.claude/settings.json"));
    assert.ok(!ignore.includes(".claude/"), "a directory ignore would make the exception impossible");
    const check = (p) => spawnSync("git", ["-C", ROOT, "check-ignore", "-q", p]).status === 0;
    assert.equal(check(".claude/settings.json"), false);
    assert.equal(check(".claude/worktrees/agent-x/file"), true);
    assert.equal(check(".claude/settings.local.json"), true);
  });
});

// ------------------------------------------------------------------ gate

describe("gate", () => {
  const classification = (paths, lanes, targets) => ({
    files: paths.map((path) => ({ path })),
    lanes,
    targets,
  });
  const ids = (plan) => plan.map((g) => g.id);

  test("selects the ci.yml equivalents for the touched lanes only", () => {
    const always = ["biome", "branding", "capabilities", "zero-cost", "release-manifest"];
    assert.deepEqual(selectGates(policy, classification([], [], [])), []);
    assert.deepEqual(ids(selectGates(policy, classification(["docs/A.md"], ["internal"], []))), always);
    assert.deepEqual(ids(selectGates(policy, classification(["tooling/a.mjs"], ["internal"], []))), [
      ...always,
      "tooling-unit",
    ]);
    const web = ids(selectGates(policy, classification(["apps/website/a.ts"], ["website"], ["website"])));
    assert.deepEqual(web, [...always, "website", "website-e2e", "website-checkout-e2e"]);
    const api = ids(selectGates(policy, classification(["apps/api/a.ts"], ["website"], ["api"])));
    assert.deepEqual(api, [...always, "api"]);
    const desk = selectGates(policy, classification(["Cargo.lock"], ["desktop"], ["desktop"]), { platform: "linux" });
    assert.deepEqual(ids(desk), [
      ...always,
      "desktop-frontend",
      "rust",
      "cargo-deny",
      "desktop-ui",
      "desktop-native-e2e",
      "cargo-audit",
    ]);
    assert.equal(desk.find((g) => g.id === "desktop-native-e2e").state, "unavailable");
    assert.equal(desk.find((g) => g.id === "rust").env.KALCODE_SKIP_OS_KEYCHAIN_TEST, "1");
    const win = selectGates(policy, classification(["crates/a.rs"], ["desktop"], ["desktop"]), { platform: "win32" });
    assert.equal(win.find((g) => g.id === "desktop-native-e2e").state, "selected");
    assert.equal(win.find((g) => g.id === "rust").env.KALCODE_SKIP_OS_KEYCHAIN_TEST, undefined);
    assert.ok(
      ids(selectGates(policy, classification(["pnpm-lock.yaml"], ["website"], ["website"]))).includes("pnpm-audit"),
    );
    assert.deepEqual(ids(selectGates(policy, classification(["tooling/a"], ["internal"], []), { only: ["biome"] })), [
      "biome",
    ]);
  });

  test("runs every command in order, stops at the first failure, and never hides a missing tool", () => {
    const plan = selectGates(policy, classification(["apps/website/a.ts"], ["website"], ["website"]));
    const ran = [];
    const exec =
      (fail) =>
      (command, { env }) => {
        ran.push({ command, env });
        return command === fail ? 3 : 0;
      };
    const ok = runGates(plan, { repo: ".", exec: exec(null), baseEnv: { STAGE_URL: "x", PATH: "p" } });
    assert.equal(ok.status, "PASS");
    const checkout = ran.find((r) => r.command.includes("website-checkout-enabled-e2e"));
    assert.equal(checkout.env.KALCODE_CHECKOUT_ENABLED_GATE, "1");
    assert.equal(checkout.env.STAGE_URL, undefined, "unset like ci.yml");
    assert.equal(checkout.env.PATH, "p");
    ran.length = 0;
    const failed = runGates(plan, { repo: ".", exec: exec("pnpm --filter @kalcode/website build") });
    assert.equal(failed.status, "FAIL");
    assert.deepEqual(
      failed.results.map((r) => r.state),
      ["pass", "pass", "pass", "pass", "pass", "fail", "not-run", "not-run"],
    );
    assert.ok(!ran.some((r) => r.command.includes("--suite website-unit")), "later commands of a failed gate skip");
    const kept = runGates(plan, { repo: ".", exec: exec("pnpm exec biome ci ."), keepGoing: true });
    assert.equal(kept.status, "FAIL");
    assert.equal(kept.results.filter((r) => r.state === "pass").length, plan.length - 1);
    const deny = selectGates(policy, classification(["Cargo.lock"], ["desktop"], ["desktop"]), {
      only: ["cargo-deny"],
    });
    const missing = runGates(deny, { repo: ".", exec: (c) => (c === "cargo deny --version" ? 101 : 0) });
    assert.equal(missing.status, "FAIL");
    assert.match(missing.results[0].why, /missing tool: cargo deny --version/);
    const unavailable = selectGates(policy, classification(["crates/a.rs"], ["desktop"], ["desktop"]), {
      platform: "darwin",
      only: ["desktop-native-e2e"],
    });
    const u = runGates(unavailable, { repo: ".", exec: () => 1 });
    assert.equal(u.status, "PASS");
    assert.equal(u.results[0].state, "unavailable");
  });

  test("the worktree gate sees uncommitted and untracked files, and records a receipt only for a clean PASS", () => {
    const f = makeFixture();
    sh(f.repo, "checkout", "-q", "-b", "feat");
    f.write("apps/api/worker/index.ts", "export default { fetch() {} };\n");
    const dirty = gateForWorktree(policy, f.git, { base: "origin/main" });
    assert.equal(dirty.clean, false);
    assert.deepEqual(dirty.classification.targets, ["api"]);
    assert.ok(ids(dirty.plan).includes("api"));
    f.write("tooling/new-tool.mjs", "x\n");
    const untracked = gateForWorktree(policy, f.git, { base: "origin/main" });
    assert.ok(untracked.classification.files.some((x) => x.path === "tooling/new-tool.mjs"));
    assert.equal(recordGate(f.git, untracked, { status: "PASS", results: [] }), null, "no receipt for a dirty tree");
    const head = f.commit("api + tool");
    const clean = gateForWorktree(policy, f.git, { base: "origin/main" });
    assert.equal(clean.clean, true);
    assert.equal(recordGate(f.git, clean, { status: "FAIL", results: [] }), null);
    const subset = gateForWorktree(policy, f.git, { base: "origin/main", only: ["api"] });
    assert.equal(recordGate(f.git, subset, { status: "PASS", results: [] }), null, "no receipt for an --only subset");
    const receipt = recordGate(f.git, clean, { status: "PASS", results: [] });
    assert.equal(JSON.parse(readFileSync(receipt, "utf8")).head, head);
    const list = spawnSync(process.execPath, [SHIP, "gate", "--list", "--repo", f.repo], { encoding: "utf8" });
    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, /gate: lanes website, internal \(targets api\)/);
    assert.match(list.stdout, /run api/);
    const unknown = spawnSync(process.execPath, [SHIP, "gate", "--only", "nope", "--repo", f.repo], {
      encoding: "utf8",
    });
    assert.match(unknown.stderr, /unknown gate nope/);
  });
});
