import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir, writeJsonAtomic } from "./status.mjs";

export const GATE_EVIDENCE_SCHEMA = "kalcode-gate-check/v2";
const SHA = /^[0-9a-f]{40}$/;
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

// Deliberately broad closures: retain EVERY root config, lockfile, package, tool and
// native dependency. Only established unrelated product/documentation trees are omitted.
// Unknown checks use the entire tree. New or unusual root directories invalidate all.
/** Files the checks themselves write into the checkout: screenshots and QA captures, never source. */
export function isCheckOutput(path) {
  return /\.(png|jpe?g|webp|gif)$/i.test(path) || /(^|\/)qa\/screenshots\//.test(path);
}

export function relevantGateInput(id, path) {
  if (["rust", "cargo-deny", "cargo-audit", "desktop-native-e2e"].includes(id)) {
    return !/^(docs|marketing|apps\/website|apps\/api)\//.test(path);
  }
  if (["desktop-frontend", "desktop-ui"].includes(id)) {
    return !/^(docs|marketing|apps\/website|apps\/api)\//.test(path);
  }
  return true;
}

const TREE_ONLY = new Set([
  "biome",
  "branding",
  "capabilities",
  "zero-cost",
  "release-manifest",
  "packages",
  "api",
  "desktop-frontend",
  "cargo-deny",
]);

export function checkFingerprint(gate, { entries, policy, toolchain, environment = {}, head }) {
  if (!toolchain?.complete) return null;
  // Live vulnerability databases are not tracked inputs, so always refresh audits.
  if (["pnpm-audit", "cargo-audit", "cargo-deny"].includes(gate.id)) return null;
  return digest({
    schema: GATE_EVIDENCE_SCHEMA,
    inputs: entries.filter(({ path }) => relevantGateInput(gate.id, path)),
    policy,
    gate: {
      id: gate.id,
      run: gate.run,
      requires: gate.requires,
      builtin: gate.builtin,
      env: gate.env,
      unsetEnv: gate.unsetEnv,
      timeoutMs: gate.timeoutMs,
    },
    toolchain,
    environmentDigest: digest(environment),
    revision: TREE_ONLY.has(gate.id) ? null : head,
  });
}

export function parseTreeEntries(text) {
  return text
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const match = /^(\d+) (blob|commit) ([0-9a-f]{40})\t(.+)$/s.exec(entry);
      if (!match) throw new Error("Unrecognized tracked input; refusing evidence reuse");
      return { mode: match[1], type: match[2], oid: match[3], path: match[4] };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** Tool versions and environment are inputs, not log output; credentials are never recorded. */
export function captureToolchain({
  native = false,
  probe = (command) => spawnSync(command, { shell: true, windowsHide: true, encoding: "utf8", timeout: 15_000 }),
  env = process.env,
} = {}) {
  const tools = {};
  let complete = true;
  const commands = [
    "node --version",
    "pnpm --version",
    "git --version",
    ...(native ? ["rustc -vV", "cargo --version", "cmake --version", "python --version"] : []),
  ];
  for (const command of commands) {
    const result = probe(command);
    if (result.status !== 0 || result.error || !(result.stdout || result.stderr)?.trim()) complete = false;
    tools[command] = digest({ status: result.status, stdout: result.stdout, stderr: result.stderr });
  }
  // MSVC/SDK are selected by the native launcher; the runner supplies its verified
  // installation fingerprint. Unknown native linker/SDK identity disables cache reuse.
  if (native && process.platform === "win32" && !/^[0-9a-f]{64}$/i.test(env.KALCODE_GATE_NATIVE_TOOLCHAIN_SHA256 ?? ""))
    complete = false;
  return {
    complete,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    tools,
    nativeToolchain: native ? (env.KALCODE_GATE_NATIVE_TOOLCHAIN_SHA256 ?? null) : null,
  };
}

export function evidenceEnvironment(env) {
  // Commit/run identity does not alter checks; all other environment values are hashed.
  // RUNNER_TRACKING_ID is only runner process-cleanup bookkeeping (no check reads it).
  // Keep PATH, tool overrides, fixture flags, ports and worker budgets authoritative.
  const ignored =
    /^(GITHUB_(SHA|REF|REF_NAME|HEAD_REF|BASE_REF|RUN_ID|RUN_NUMBER|RUN_ATTEMPT|EVENT_PATH|WORKFLOW_SHA|WORKFLOW_REF|ENV|OUTPUT|STEP_SUMMARY|STATE|PATH)|KALCODE_GATE_(CANDIDATE|BASE)|RUNNER_TRACKING_ID|_?)$/;
  return Object.fromEntries(
    Object.entries(env)
      .filter(([key]) => !ignored.test(key))
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

export function prepareCheckEvidence(
  git,
  g,
  policy,
  { toolchain, nativeToolchain = toolchain, environment = process.env } = {},
) {
  if (!g.clean || !SHA.test(g.head ?? "")) return null;
  const entries = parseTreeEntries(git.run(["ls-tree", "-r", "-z", "--full-tree", g.head]));
  if (entries.some((entry) => entry.type !== "blob" || entry.mode === "120000")) return null; // unknown submodule/symlink targets
  const dir = environment.KALCODE_GATE_EVIDENCE_DIR || join(stateDir(git.commonDir()), "check-cache-v2");
  const checks = new Map(
    g.plan
      .filter((gate) => gate.state === "selected")
      .map((gate) => [
        gate.id,
        checkFingerprint(gate, {
          entries,
          policy,
          toolchain: ["rust", "desktop-native-e2e", "cargo-deny", "cargo-audit"].includes(gate.id)
            ? nativeToolchain
            : toolchain,
          head: g.head,
          environment: evidenceEnvironment(environment),
        }),
      ]),
  );
  // The candidate is exact while HEAD is unchanged and no tracked source differs from it. Checks
  // legitimately write outputs into the checkout (the visual suite refreshes tracked QA screenshots,
  // test runs leave untracked reports), so those never invalidate a later check (gate 37323803563
  // failed rust and native e2e in 0 s with "source changed before check" after desktop-ui).
  const changedSource = () =>
    git
      .diff("HEAD", null)
      .filter(({ path }) => !isCheckOutput(path))
      .map(({ path }) => path);
  const stillExact = () => git.rev("HEAD") === g.head && changedSource().length === 0;
  // Names what changed, so a check that refuses to run can be traced to the check that wrote it.
  const drift = () => {
    if (git.rev("HEAD") !== g.head) return "HEAD moved";
    const paths = changedSource();
    return `${paths.slice(0, 8).join(", ")}${paths.length > 8 ? ` (+${paths.length - 8} more)` : ""}`;
  };
  // Snapshot trustworthy completed receipts before any code under test executes.
  const reusable = new Map();
  for (const [id, key] of checks) {
    if (!key) continue;
    try {
      const old = JSON.parse(readFileSync(join(dir, `${key}.json`), "utf8"));
      if (
        old.schema === GATE_EVIDENCE_SCHEMA &&
        old.status === "PASS" &&
        old.fingerprint === key &&
        old.gate === id &&
        SHA.test(old.head) &&
        old.toolchainComplete === true
      )
        reusable.set(id, old);
    } catch {
      /* No completed evidence: execute this check. */
    }
  }
  return {
    async run(gate, execute) {
      const key = checks.get(gate.id);
      const path = key ? join(dir, `${key}.json`) : null;
      if (!stillExact()) return { id: gate.id, state: "fail", why: `source changed before check: ${drift()}` };
      if (path) {
        try {
          const old = reusable.get(gate.id);
          if (
            old &&
            old.schema === GATE_EVIDENCE_SCHEMA &&
            old.status === "PASS" &&
            old.fingerprint === key &&
            old.gate === gate.id &&
            SHA.test(old.head) &&
            old.toolchainComplete === true
          ) {
            return {
              id: gate.id,
              state: "pass",
              exitCode: 0,
              fingerprint: key,
              reusedFrom: old.head,
              reboundTo: g.head,
            };
          }
        } catch {
          /* no trustworthy completed evidence: execute */
        }
      }
      const result = await execute();
      if (!stillExact()) return { id: gate.id, state: "fail", why: `source changed during check: ${drift()}` };
      if (result.state === "pass" && path)
        writeJsonAtomic(path, {
          schema: GATE_EVIDENCE_SCHEMA,
          status: "PASS",
          fingerprint: key,
          gate: gate.id,
          head: g.head,
          toolchainComplete: true,
          at: new Date().toISOString(),
        });
      return { ...result, fingerprint: key, reboundTo: g.head };
    },
    stillExact,
  };
}
