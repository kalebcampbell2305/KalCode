// Publishes a verified Windows build to the R2 bucket behind kalcoded.com/download and writes the
// website manifest (apps/website/src/data/releases.json).
//
//   pnpm release:publish              real publish to the production bucket (--remote)
//   pnpm release:publish --dry-run    every check, prints the exact commands, uploads nothing
//   pnpm release:publish --local      uploads to the local R2 simulation that `wrangler dev`
//                                     in apps/website uses; leaves the committed manifest alone
//                                     (no verification or notes needed: nothing is public)
//
//   --without-install-test            publish although `pnpm release:verify` did not pass for this
//                                     exact build (for example because KalCode is installed on the
//                                     build machine, so the temp install test is skipped). The
//                                     release notes must then say the install test was not run.
//
// Upload order: the installer first, then releases/latest.json, so the manifest never points at
// a file that is not there yet. A version is never re-uploaded with different bytes: pinned
// download URLs are cached as immutable.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  appVersion,
  assertCleanTree,
  fail,
  formatBytes,
  git,
  headCommit,
  R2_BUCKET,
  RELEASE_NOTES_DIR,
  ROOT,
  readJson,
  run,
  sha256File,
  stagingDir,
  WEBSITE_DIR,
  WEBSITE_MANIFEST,
  writeJson,
} from "./lib.mjs";
import { buildManifest, validateManifest } from "./manifest.mjs";

const args = new Set(process.argv.slice(2));
const mode = args.has("--dry-run") ? "dry-run" : args.has("--local") ? "local" : "remote";
const LIVE_MANIFEST_URL = "https://kalcoded.com/releases/latest.json";

const version = appVersion();
const outDir = stagingDir(version);
const buildPath = join(outDir, "build.json");
const verifyPath = join(outDir, "verify.json");
const withoutInstallTest = args.has("--without-install-test");
if (!existsSync(buildPath)) fail(`No build record at ${buildPath}. Run pnpm release:build.`);
const build = readJson(buildPath);
const verify = existsSync(verifyPath) ? readJson(verifyPath) : null;
const installer = join(outDir, build.file);

console.log(`Publishing ${build.file} (${mode})`);

// ---- Checks -----------------------------------------------------------------------------------
const problems = [];
if (build.version !== version) problems.push(`build.json is for ${build.version}, tauri.conf.json says ${version}`);
if (!existsSync(installer)) problems.push(`staged installer missing: ${installer}`);
else {
  const sha256 = await sha256File(installer);
  if (sha256 !== build.sha256) problems.push(`staged installer SHA-256 ${sha256} does not match build.json`);
}
if (build.signed !== false && build.signatureStatus !== "Valid") problems.push("build.json claims a signature");
const verified = verify?.status === "passed" && verify.commit === build.commit && verify.sha256 === build.sha256;
const notes = join(RELEASE_NOTES_DIR, `${version}.md`);
if (mode !== "local") {
  if (!verified && !withoutInstallTest) {
    problems.push(
      verify
        ? `verify.json is "${verify.status}" for ${verify.sha256 ?? verify.commit}, not "passed" for this build; run pnpm release:verify`
        : "no verify.json for this build; run pnpm release:verify",
    );
  }
  const text = existsSync(notes) ? readFileSync(notes, "utf8") : null;
  if (text === null) problems.push(`release notes missing: ${relative(ROOT, notes)}`);
  else {
    if (!text.includes(build.sha256)) {
      problems.push(`${relative(ROOT, notes)} does not list this build's SHA-256 (${build.sha256})`);
    }
    if (!verified && !/install test.*not run/i.test(text)) {
      problems.push(`${relative(ROOT, notes)} must say the install test was not run for this build`);
    }
  }
  if (!verified && withoutInstallTest) {
    console.log("  WARNING: publishing without a passing install/uninstall test for this exact build.");
  }
}
if (mode !== "local") {
  // HEAD must be the build commit, or a descendant that only adds release notes (the notes
  // carry the build's SHA-256, so they are necessarily written after the build).
  const head = headCommit();
  if (head !== build.commit) {
    const descendant =
      spawnSync("git", ["merge-base", "--is-ancestor", build.commit, head], { cwd: ROOT }).status === 0;
    const changed = descendant ? git(["diff", "--name-only", build.commit, head]).split(/\r?\n/).filter(Boolean) : [];
    const other = changed.filter((file) => !file.startsWith("docs/releases/"));
    if (!descendant || other.length > 0) {
      problems.push(
        `HEAD ${head.slice(0, 12)} is not the build commit ${build.commit.slice(0, 12)} plus release notes only${other.length ? ` (also changed: ${other.join(", ")})` : ""}; rebuild`,
      );
    }
  }
}
if (mode === "remote") assertCleanTree("A publish");

const manifest = buildManifest({
  version,
  commit: build.commit,
  publishedAt: new Date().toISOString(),
  windows: { file: build.file, size: build.size, sha256: build.sha256, signed: build.signed },
});
problems.push(...validateManifest(manifest));

// Never replace a published version with different bytes.
if (mode !== "local") {
  try {
    const response = await fetch(LIVE_MANIFEST_URL, { headers: { accept: "application/json" } });
    if (response.ok) {
      const live = await response.json();
      const same = live?.latest?.version === version;
      const liveSha = live?.latest?.platforms?.find?.((p) => p.os === "windows")?.sha256;
      if (same && liveSha !== build.sha256) {
        problems.push(`${version} is already published with a different installer; bump the version first`);
      }
      console.log(`  live manifest: ${live?.latest ? `version ${live.latest.version}` : "no release"}`);
    } else {
      await response.body?.cancel();
      console.log(`  live manifest: HTTP ${response.status} (nothing published yet, or the Worker is not deployed)`);
    }
  } catch (error) {
    console.log(`  live manifest: unreachable (${error instanceof Error ? error.message : error})`);
  }
  // Let fetch's sockets finish closing: exiting mid-close aborts Node on Windows (libuv assertion).
  await new Promise((resolve) => setTimeout(resolve, 100));
}

if (problems.length > 0) fail(`refusing to publish:\n  ${problems.join("\n  ")}`);
console.log(
  mode === "local"
    ? "  ok   build and manifest checks passed (local: verification and notes not required)"
    : `  ok   build, ${verified ? "verification, " : ""}notes and manifest checks passed`,
);

// ---- Upload -----------------------------------------------------------------------------------
const latestJsonPath = join(outDir, "latest.json");
writeJson(latestJsonPath, manifest);

const wranglerBin = join(WEBSITE_DIR, "node_modules", "wrangler", "bin", "wrangler.js");
const location = mode === "local" ? "--local" : "--remote";
const installerKey = `releases/${version}/${build.file}`;
const uploads = [
  [
    "r2",
    "object",
    "put",
    `${R2_BUCKET}/${installerKey}`,
    "--file",
    installer,
    "--content-type",
    "application/vnd.microsoft.portable-executable",
    "--content-disposition",
    `attachment; filename="${build.file}"`,
    "--cache-control",
    "public, max-age=31536000, immutable",
    location,
  ],
  [
    "r2",
    "object",
    "put",
    `${R2_BUCKET}/releases/latest.json`,
    "--file",
    latestJsonPath,
    "--content-type",
    "application/json; charset=utf-8",
    "--cache-control",
    "public, max-age=60, must-revalidate",
    location,
  ],
];

const show = (argv) => `wrangler ${argv.map((a) => (/[\s"]/.test(a) ? `'${a}'` : a)).join(" ")}`;
if (mode === "dry-run") {
  console.log("\nDry run. These commands would run (from apps/website):");
  for (const argv of uploads) console.log(`  ${show(argv).replace(location, "--remote")}`);
  console.log(
    `\nManifest that would be written to ${relative(ROOT, WEBSITE_MANIFEST)} (preview: ${relative(ROOT, latestJsonPath)}):`,
  );
  console.log(JSON.stringify(manifest, null, 2));
  process.exit(0);
}

if (mode === "remote") {
  const buckets = spawnSync(process.execPath, [wranglerBin, "r2", "bucket", "list"], {
    cwd: WEBSITE_DIR,
    encoding: "utf8",
  });
  if (buckets.status !== 0 || !buckets.stdout.includes(R2_BUCKET)) {
    fail(
      `R2 bucket ${R2_BUCKET} not found or wrangler is not logged in. Create it: wrangler r2 bucket create ${R2_BUCKET}`,
    );
  }
}

for (const argv of uploads) {
  console.log(`\n> ${show(argv)}`);
  run(process.execPath, [wranglerBin, ...argv], { cwd: WEBSITE_DIR });
}

// Read the pointer back to prove the upload landed.
const readBack = spawnSync(
  process.execPath,
  [wranglerBin, "r2", "object", "get", `${R2_BUCKET}/releases/latest.json`, "--pipe", location],
  { cwd: WEBSITE_DIR, encoding: "utf8" },
);
if (readBack.status !== 0) fail(`could not read back releases/latest.json: ${readBack.stderr}`);
const stored = JSON.parse(readBack.stdout);
if (stored?.latest?.platforms?.[0]?.sha256 !== build.sha256)
  fail("releases/latest.json read back with a different SHA-256");
console.log("\n  ok   releases/latest.json read back from R2 and matches");

if (mode === "local") {
  console.log(`
Uploaded to the LOCAL R2 simulation (apps/website/.wrangler/state). The committed manifest was not changed.
Serve it: pnpm --filter @kalcode/website build && node tooling/release/smoke-local.mjs`);
  process.exit(0);
}

writeJson(WEBSITE_MANIFEST, manifest);
run("pnpm", ["exec", "biome", "format", "--write", WEBSITE_MANIFEST]);
console.log(`
Published ${build.file} to r2://${R2_BUCKET}/${installerKey}
  size    ${formatBytes(build.size)}
  sha256  ${build.sha256}
  signed  ${build.signed}

Wrote ${relative(ROOT, WEBSITE_MANIFEST)}. Now deploy the website so the download page links to it:
  git add ${relative(ROOT, WEBSITE_MANIFEST).replaceAll("\\", "/")} && git commit -m "Release ${version}: publish Windows x64 installer"
  pnpm --filter @kalcode/website build
  pnpm --filter @kalcode/website exec wrangler deploy
Then check:
  curl -sI https://kalcoded.com/download/windows-x64
  curl -s https://kalcoded.com/releases/latest.json`);
