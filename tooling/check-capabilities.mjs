// Verifies the desktop WebView's permissions: the capability file must grant exactly the
// commands declared in build.rs plus an explicit allow-list of core permissions — nothing else.
// Usage: node tooling/check-capabilities.mjs
import { readFileSync } from "node:fs";

const root = new URL("../apps/desktop/src-tauri/", import.meta.url);
const buildRs = readFileSync(new URL("build.rs", root), "utf8");
const capability = JSON.parse(readFileSync(new URL("capabilities/main.json", root), "utf8"));

const block = buildRs.match(/const COMMANDS: &\[&str\] = &\[([\s\S]*?)\];/);
if (!block) throw new Error("COMMANDS list not found in build.rs");
const commands = [...block[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);

const ALLOWED_CORE = ["core:event:default", "core:window:allow-set-theme"];
const expected = new Set([...ALLOWED_CORE, ...commands.map((c) => `allow-${c.replaceAll("_", "-")}`)]);
const granted = new Set(capability.permissions);

const extra = [...granted].filter((p) => !expected.has(p));
const missing = [...expected].filter((p) => !granted.has(p));
const windows = JSON.stringify(capability.windows);

const problems = [];
if (extra.length) problems.push(`unexpected permissions: ${extra.join(", ")}`);
if (missing.length) problems.push(`commands without a grant: ${missing.join(", ")}`);
if (windows !== '["main"]') problems.push(`capability must target only the main window, got ${windows}`);
if (capability.remote) problems.push("capability must not grant remote URLs");

if (problems.length) {
  console.error(`Capability check failed:\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
console.log(`Capability check passed: ${commands.length} commands, ${ALLOWED_CORE.length} core permissions.`);
