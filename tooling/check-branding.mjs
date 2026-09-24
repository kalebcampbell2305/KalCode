// Fails if tracked files contain denied branding: competitor product names, material from the
// owner's private JARVIS system, or any previous product name. Patterns live in
// tooling/branding-denylist.txt (one regular expression per line, `#` comments).
// Usage: node tooling/check-branding.mjs
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const denylistPath = fileURLToPath(new URL("./branding-denylist.txt", import.meta.url));

const EXEMPT = new Set(["tooling/check-branding.mjs", "tooling/branding-denylist.txt"]);
const BINARY = /\.(png|jpe?g|webp|avif|ico|icns|woff2?|ttf|otf|zip|db|sqlite)$/i;

const patterns = readFileSync(denylistPath, "utf8")
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"))
  .map((source) => ({ source, re: new RegExp(source, "u") }));

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
  cwd: root,
  encoding: "utf8",
})
  .split("\n")
  .filter((file) => file && !EXEMPT.has(file) && !BINARY.test(file));

const findings = [];
for (const file of files) {
  let text;
  try {
    text = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  } catch {
    continue; // deleted in the working tree
  }
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const { source, re } of patterns) {
      if (re.test(line)) findings.push(`${file}:${index + 1}: matches /${source}/`);
    }
  });
}

if (findings.length > 0) {
  console.error(`Branding check failed (${findings.length}):\n${findings.join("\n")}`);
  process.exit(1);
}
console.log(`Branding check passed: ${files.length} files, ${patterns.length} patterns.`);
