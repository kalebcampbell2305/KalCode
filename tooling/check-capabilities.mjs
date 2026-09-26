// Verifies the desktop WebView's permissions.
// - Every file under capabilities/ (Tauri loads them all) must be on an explicit allow-list;
//   today that is only main.json. A second capability file fails until it is added here and
//   checked like main.json.
// - main.json grants exactly the commands declared in build.rs `COMMANDS` plus an explicit
//   allow-list of core permissions, to the main webview only, with no remote URLs.
// - Test hooks (`TEST_HOOK_COMMANDS` in build.rs) are never granted by capabilities/. Their grant
//   lives in test-capabilities/test-hooks.json, which the app adds at runtime only in debug and
//   `e2e` builds; it may grant exactly the test hooks, to the main webview, nothing else.
// Usage: node tooling/check-capabilities.mjs
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const ALLOWED_CORE = ["core:event:default", "core:window:allow-set-theme"];
/** Capability files allowed under capabilities/ (paths relative to it, forward slashes). */
export const ALLOWED_CAPABILITY_FILES = ["main.json"];
export const TEST_CAPABILITY_FILE = "test-capabilities/test-hooks.json";

const permissionFor = (command) => `allow-${command.replaceAll("_", "-")}`;

function listFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

function commandList(buildRs, name) {
  const block = buildRs.match(new RegExp(`const ${name}: &\\[&str\\] = &\\[([\\s\\S]*?)\\];`));
  if (!block) return null;
  // Strip line comments so a commented-out command doesn't count.
  const body = block[1].replace(/\/\/.*$/gm, "");
  return [...body.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
}

function parseJson(path, problems, label) {
  try {
    const capability = JSON.parse(readFileSync(path, "utf8"));
    if (capability === null || typeof capability !== "object" || Array.isArray(capability)) {
      problems.push(`${label}: must be a JSON object`);
      return null;
    }
    return capability;
  } catch (error) {
    problems.push(`${label}: not valid JSON (${error.message})`);
    return null;
  }
}

/** Checks the common shape every capability must have: main webview only, local only. */
function checkShape(capability, label, problems) {
  const webviews = JSON.stringify(capability.webviews);
  if (webviews !== '["main"]') problems.push(`${label}: must target only the main webview, got ${webviews}`);
  // Window selectors also grant every child webview; never combine them with webview selectors.
  if (capability.windows !== undefined) problems.push(`${label}: must not target windows`);
  if (capability.remote !== undefined) problems.push(`${label}: must not grant remote URLs`);
  if (capability.local === false) problems.push(`${label}: must apply to local content`);
  if (!Array.isArray(capability.permissions)) {
    problems.push(`${label}: permissions must be a list`);
    return new Set();
  }
  const objects = capability.permissions.filter((p) => typeof p !== "string");
  if (objects.length) problems.push(`${label}: scoped permission objects are not allowed`);
  return new Set(capability.permissions.filter((p) => typeof p === "string"));
}

function compare(label, granted, expected, problems) {
  const extra = [...granted].filter((p) => !expected.has(p));
  const missing = [...expected].filter((p) => !granted.has(p));
  if (extra.length) problems.push(`${label}: unexpected permissions: ${extra.join(", ")}`);
  if (missing.length) problems.push(`${label}: commands without a grant: ${missing.join(", ")}`);
}

/**
 * Runs every check against the Tauri app at `root` (the src-tauri folder).
 * Returns `{ problems, commands, testCommands }`; no problems means the check passed.
 */
export function checkCapabilities(root) {
  const problems = [];
  const buildRs = readFileSync(join(root, "build.rs"), "utf8");
  const commandSource = buildRs.includes('include!("src/command_registry.rs")')
    ? readFileSync(join(root, "src", "command_registry.rs"), "utf8")
    : buildRs;
  const commands = commandList(commandSource, "COMMANDS");
  const testCommands = commandList(buildRs, "TEST_HOOK_COMMANDS") ?? [];
  if (!commands) return { problems: ["COMMANDS list not found in build.rs"], commands: [], testCommands };

  const overlap = commands.filter((c) => testCommands.includes(c));
  if (overlap.length) problems.push(`test hooks listed in COMMANDS (would ship): ${overlap.join(", ")}`);
  const testPermissions = new Set(testCommands.map(permissionFor));

  // Every file Tauri would load from capabilities/ must be allow-listed and checked.
  const capabilityDir = join(root, "capabilities");
  const files = listFiles(capabilityDir).map((p) => relative(capabilityDir, p).split(sep).join("/"));
  for (const file of files) {
    if (!ALLOWED_CAPABILITY_FILES.includes(file)) {
      problems.push(
        `capabilities/${file}: not an allowed capability file (only ${ALLOWED_CAPABILITY_FILES.join(", ")}); ` +
          "add it to tooling/check-capabilities.mjs with its own checks",
      );
    }
  }
  if (!files.includes("main.json")) problems.push("capabilities/main.json is missing");

  const main = files.includes("main.json")
    ? parseJson(join(capabilityDir, "main.json"), problems, "capabilities/main.json")
    : null;
  if (main) {
    const granted = checkShape(main, "capabilities/main.json", problems);
    const hooks = [...granted].filter((p) => testPermissions.has(p));
    if (hooks.length) problems.push(`capabilities/main.json: grants test hooks: ${hooks.join(", ")}`);
    compare("capabilities/main.json", granted, new Set([...ALLOWED_CORE, ...commands.map(permissionFor)]), problems);
  }

  // The test-hook grant, added at runtime only in debug and e2e builds.
  const testFile = join(root, TEST_CAPABILITY_FILE);
  const hasTestFile = listFiles(join(root, "test-capabilities")).length > 0;
  if (testCommands.length || hasTestFile) {
    const others = listFiles(join(root, "test-capabilities"))
      .map((p) => relative(root, p).split(sep).join("/"))
      .filter((p) => p !== TEST_CAPABILITY_FILE);
    if (others.length) problems.push(`unexpected test capability files: ${others.join(", ")}`);
    let test = null;
    try {
      statSync(testFile);
      test = parseJson(testFile, problems, TEST_CAPABILITY_FILE);
    } catch {
      problems.push(`${TEST_CAPABILITY_FILE} is missing`);
    }
    if (test)
      compare(TEST_CAPABILITY_FILE, checkShape(test, TEST_CAPABILITY_FILE, problems), testPermissions, problems);
  }

  // Release builds must not register test hooks: each registration carries the test-hook cfg.
  if (testCommands.length) {
    const lib = readFileSync(join(root, "src", "lib.rs"), "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim());
    for (const command of testCommands) {
      const lines = lib
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => new RegExp(`(^|::)${command},?$`).test(line));
      if (!lines.length) problems.push(`src/lib.rs: test hook ${command} is not registered`);
      for (const { index } of lines) {
        if (lib[index - 1] !== TEST_HOOK_CFG) {
          problems.push(`src/lib.rs: test hook ${command} is registered without ${TEST_HOOK_CFG}`);
        }
      }
    }
  }

  return { problems, commands, testCommands };
}

export const TEST_HOOK_CFG = '#[cfg(any(debug_assertions, feature = "e2e"))]';

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = fileURLToPath(new URL("../apps/desktop/src-tauri/", import.meta.url));
  const { problems, commands, testCommands } = checkCapabilities(root);
  if (problems.length) {
    console.error(`Capability check failed:\n- ${problems.join("\n- ")}`);
    process.exit(1);
  }
  console.log(
    `Capability check passed: ${commands.length} commands, ${testCommands.length} test hooks (debug/e2e only), ` +
      `${ALLOWED_CORE.length} core permissions.`,
  );
}
