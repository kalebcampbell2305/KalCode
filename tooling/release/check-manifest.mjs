// Validates the committed website release manifest (part of `pnpm check`).
// A milestone uses docs/releases/<version>.md; a continuous build uses docs/builds/<identity>.md.
// Usage: node tooling/release/check-manifest.mjs
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { ROOT, readJson, WEBSITE_MANIFEST } from "./lib.mjs";
import { validateManifest } from "./manifest.mjs";
import { releaseNotesRelativePath } from "./version.mjs";

const manifest = readJson(WEBSITE_MANIFEST);
const errors = validateManifest(manifest);
if (manifest?.latest?.version) {
  const notes = join(ROOT, releaseNotesRelativePath(manifest.latest.version));
  if (!existsSync(notes)) errors.push(`missing release notes: ${relative(ROOT, notes)}`);
}

if (errors.length > 0) {
  console.error(`Release manifest check failed (${relative(ROOT, WEBSITE_MANIFEST)}):\n  ${errors.join("\n  ")}`);
  process.exit(1);
}
console.log(
  manifest.latest
    ? `Release manifest check passed: ${manifest.latest.version} (${manifest.latest.platforms.length} platform(s)).`
    : "Release manifest check passed: no published release (latest: null).",
);
