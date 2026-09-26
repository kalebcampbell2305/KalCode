#!/usr/bin/env node
// Publishes one immutable KalCode release assembled from independently verified platform packets.
// All platforms share one version, commit, channel, descriptor pair, and atomic D1 pointer.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";

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
import { expectedMacDmgFile } from "./macos-contract.mjs";
import { buildManifest, validateManifest } from "./manifest.mjs";
import {
  boundedJsonFetch,
  buildInitialPointerStatement,
  buildPointerAdvanceStatement,
  buildPointerReadStatement,
  buildVersionClaimStatement,
  buildVersionReadStatement,
  parseD1Rows,
  pointerAdvanceProblems,
  publicationRowProblems,
  resolvePlatformPublicationState,
  resolvePublicationState,
} from "./publication-safety.mjs";
import {
  buildPublishPlan,
  downloadKeys,
  isMissingR2Object,
  parsePublishMode,
  publishedUpdaterProblems,
  updaterKeys,
  windowsUpdaterV2Problems,
} from "./publish-plan.mjs";
import {
  expectedWindowsInstallerFile,
  publicSigningProblems,
  publicVerificationProblems,
  releaseProcessOptions,
} from "./signing.mjs";
import { createPlatformUpdaterManifest, createUpdaterManifest } from "./updater-manifest.mjs";
import { readUpdaterPublicKey } from "./updater-signing.mjs";

let mode;
try {
  mode = parsePublishMode(process.argv.slice(2));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

const LIVE_MANIFEST_URL = "https://kalcoded.com/releases/latest.json";
const D1_DATABASE = "kalcode-web";
const wranglerBin = join(WEBSITE_DIR, "node_modules", "wrangler", "bin", "wrangler.js");
const initializesAuthority = mode === "bootstrap";
const publishesRemote = mode === "remote" || initializesAuthority;
const version = appVersion();
const outDir = stagingDir(version);
let expectedWindowsFile;
let expectedMacFile;
try {
  expectedWindowsFile = expectedWindowsInstallerFile(version);
  expectedMacFile = expectedMacDmgFile(version, "arm64");
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

function executeD1(statement) {
  const result = spawnSync(
    process.execPath,
    [wranglerBin, "d1", "execute", D1_DATABASE, "--remote", "--json", "--command", statement],
    releaseProcessOptions({ cwd: WEBSITE_DIR, encoding: "utf8", timeout: 30_000, maxBuffer: 256 * 1024 }),
  );
  if (result.status !== 0) throw new Error("authoritative D1 release pointer operation failed");
  return parseD1Rows(result.stdout);
}

function requiredRecord(path, label, required) {
  if (!required) return null;
  if (!existsSync(path)) throw new Error(`${label} is incomplete: missing ${relative(outDir, path)}`);
  return readJson(path);
}

const windowsPaths = { build: join(outDir, "build.json"), verify: join(outDir, "verify.json") };
const macPaths = {
  build: join(outDir, "macos-arm64-build.json"),
  verify: join(outDir, "macos-arm64-verify.json"),
  qa: join(outDir, "macos-arm64-qa.json"),
};
const windowsMentioned = [
  ...Object.values(windowsPaths),
  join(outDir, expectedWindowsFile),
  join(outDir, `${expectedWindowsFile}.sig`),
  join(outDir, `${expectedWindowsFile}.windows-x86_64.sig`),
].some(existsSync);
const macMentioned = [
  ...Object.values(macPaths),
  join(outDir, expectedMacFile),
  join(outDir, `${expectedMacFile}.sig`),
].some(existsSync);
if (!windowsMentioned && !macMentioned) {
  fail(`No platform release packet exists at ${outDir}. Build and verify at least one platform.`);
}

const packets = [];
const packetProblems = [];
if (windowsMentioned) {
  let build = null;
  let verify = null;
  try {
    build = requiredRecord(windowsPaths.build, "Windows release packet", true);
    verify = requiredRecord(
      windowsPaths.verify,
      "Windows release packet",
      mode !== "local" || existsSync(windowsPaths.verify),
    );
  } catch (error) {
    packetProblems.push(error instanceof Error ? error.message : String(error));
  }
  if (build) {
    let safeFile = null;
    try {
      safeFile = expectedWindowsFile;
      if (build.file !== safeFile) {
        packetProblems.push("Windows build record has an unsafe or version-mismatched installer file name");
      }
      if ((build.updater?.signatureFile ?? `${safeFile}.sig`) !== `${safeFile}.sig`) {
        packetProblems.push("Windows build record has an unsafe updater signature file name");
      }
    } catch (error) {
      packetProblems.push(error instanceof Error ? error.message : String(error));
    }
    packets.push({
      target: "windows-x86_64",
      build,
      verify,
      artifactPath: join(outDir, safeFile ?? "invalid-windows-artifact"),
      signaturePath: join(outDir, safeFile ? `${safeFile}${macMentioned ? ".windows-x86_64" : ""}.sig` : "invalid.sig"),
    });
  }
}

if (macMentioned) {
  let build = null;
  let verify = null;
  let qa = null;
  try {
    build = requiredRecord(macPaths.build, "macOS arm64 release packet", true);
    verify = requiredRecord(macPaths.verify, "macOS arm64 release packet", true);
    qa = requiredRecord(macPaths.qa, "macOS arm64 release packet", true);
  } catch (error) {
    packetProblems.push(error instanceof Error ? error.message : String(error));
  }
  if (build) {
    let safeFile = null;
    try {
      safeFile = expectedMacFile;
      if (build.arch !== "arm64" || build.file !== safeFile) {
        packetProblems.push("macOS build record is not the canonical arm64 DMG for this version");
      }
    } catch (error) {
      packetProblems.push(error instanceof Error ? error.message : String(error));
    }
    packets.push({
      target: "darwin-aarch64",
      build,
      verify,
      qa,
      artifactPath: join(outDir, safeFile ?? "invalid-macos-artifact"),
      signaturePath: join(outDir, build.file === safeFile ? `${safeFile}.sig` : "invalid.sig"),
    });
  }
}

if (packets.length === 0) fail(`refusing to publish:\n  ${packetProblems.join("\n  ")}`);
if (packets.some((packet) => packet.target === "darwin-aarch64") && mode === "local") {
  packetProblems.push("macOS packets require the complete public verification path; --local is Windows-only");
}
packets.sort((left, right) => left.target.localeCompare(right.target));
const releaseBuild = packets[0].build;
const channel = releaseBuild.requestedReleaseChannel;
console.log(`Publishing ${packets.map((packet) => packet.build.file).join(", ")} (${mode})`);

// ---- Checks -----------------------------------------------------------------------------------
const problems = [...packetProblems];
for (const packet of packets) {
  const { build, artifactPath } = packet;
  if (build.version !== version) problems.push(`${packet.target} build is for ${build.version}, expected ${version}`);
  if (build.commit !== releaseBuild.commit) problems.push("platform builds do not share the exact source commit");
  if (build.requestedReleaseChannel !== channel)
    problems.push("platform builds do not share the exact release channel");
  if (!existsSync(artifactPath)) problems.push(`${packet.target} staged artifact missing: ${artifactPath}`);
  else if ((await sha256File(artifactPath)) !== build.sha256) {
    problems.push(`${packet.target} staged artifact SHA-256 does not match its build record`);
  }
}

let releaseNotesText = null;
const notes = join(RELEASE_NOTES_DIR, `${version}.md`);
if (mode !== "local") {
  const windows = packets.find((packet) => packet.target === "windows-x86_64");
  if (windows) {
    problems.push(...publicSigningProblems(windows.build));
    problems.push(...publicVerificationProblems(windows.build, windows.verify));
    if (macMentioned) problems.push(...windowsUpdaterV2Problems(windows.build, windows.verify));
  }
  releaseNotesText = existsSync(notes) ? readFileSync(notes, "utf8") : null;
  if (releaseNotesText === null) problems.push(`release notes missing: ${relative(ROOT, notes)}`);
  else {
    for (const packet of packets) {
      if (!releaseNotesText.includes(packet.build.sha256)) {
        problems.push(`${relative(ROOT, notes)} does not list ${packet.target} SHA-256 (${packet.build.sha256})`);
      }
    }
  }
}

if (mode !== "local") {
  const head = headCommit();
  if (head !== releaseBuild.commit) {
    const descendant =
      spawnSync(
        "git",
        ["merge-base", "--is-ancestor", releaseBuild.commit, head],
        releaseProcessOptions({ cwd: ROOT, stdio: "ignore", timeout: 30_000 }),
      ).status === 0;
    const changed = descendant
      ? git(["diff", "--name-only", releaseBuild.commit, head]).split(/\r?\n/).filter(Boolean)
      : [];
    const other = changed.filter((file) => !file.startsWith("docs/releases/"));
    if (!descendant || other.length > 0) {
      problems.push(
        `HEAD ${head.slice(0, 12)} is not the shared build commit ${releaseBuild.commit.slice(0, 12)} plus release notes only${other.length ? ` (also changed: ${other.join(", ")})` : ""}; rebuild every platform`,
      );
    }
  }
}
if (publishesRemote) assertCleanTree(initializesAuthority ? "A release-authority bootstrap" : "A publish");

const publicationStatePath = join(outDir, "publication.json");
const existingPublicationState =
  publishesRemote && existsSync(publicationStatePath) ? readJson(publicationStatePath) : null;
let publicationState;
try {
  if (packets.length === 1 && packets[0].target === "windows-x86_64") {
    publicationState = resolvePublicationState(existingPublicationState, packets[0].build, new Date().toISOString());
  } else {
    publicationState = resolvePlatformPublicationState(
      existingPublicationState,
      {
        version,
        commit: releaseBuild.commit,
        requestedReleaseChannel: channel,
        artifacts: packets.map((packet) => ({
          target: packet.target,
          file: packet.build.file,
          size: packet.build.size,
          sha256: packet.build.sha256,
          builtAt: packet.build.builtAt ?? packet.build.createdAt,
        })),
      },
      new Date().toISOString(),
    );
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
const publishedAt = publicationState.publishedAt;
const windows = packets.find((packet) => packet.target === "windows-x86_64");
const mac = packets.find((packet) => packet.target === "darwin-aarch64");
const manifest = buildManifest({
  version,
  commit: releaseBuild.commit,
  publishedAt,
  channel: channel === "stable" ? "stable" : "preview",
  ...(windows && {
    windows: {
      file: windows.build.file,
      size: windows.build.size,
      sha256: windows.build.sha256,
      signed: windows.build.signed,
    },
  }),
  ...(mac && {
    macosArm64: { file: mac.build.file, size: mac.build.size, sha256: mac.build.sha256, signed: mac.build.signed },
  }),
});
problems.push(...validateManifest(manifest));

let updaterManifest = null;
let updaterPublicKey = null;
if (mode !== "local") {
  try {
    updaterPublicKey = readUpdaterPublicKey();
    const artifacts = packets.map((packet) => ({
      ...packet,
      artifactKey: `releases/updater/${channel}/${version}/${packet.build.sha256}/${packet.build.file}`,
      publicKeyBase64: updaterPublicKey,
    }));
    updaterManifest = mac
      ? await createPlatformUpdaterManifest({
          artifacts,
          requestedChannel: channel,
          publishedAt,
          notes: releaseNotesText,
        })
      : await createUpdaterManifest({
          ...artifacts[0],
          requestedChannel: channel,
          publishedAt,
          notes: releaseNotesText,
        });
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
}

const latestJsonPath = join(outDir, "latest.json");
writeJson(latestJsonPath, manifest);
const updaterJsonPath = join(outDir, `${channel}.json`);
if (updaterManifest) writeJson(updaterJsonPath, updaterManifest);
const downloadDescriptorSha256 = await sha256File(latestJsonPath);
const updaterDescriptorSha256 = updaterManifest ? await sha256File(updaterJsonPath) : null;
const platformObjects = new Map();
if (updaterManifest) {
  for (const packet of packets) {
    const signatureSha256 = await sha256File(packet.signaturePath);
    const updater = updaterKeys(
      channel,
      version,
      packet.build.file,
      { artifactSha256: packet.build.sha256, signatureSha256, updaterDescriptorSha256 },
      packet.target,
    );
    const downloads = downloadKeys(
      version,
      packet.build.file,
      packet.build.sha256,
      downloadDescriptorSha256,
      packet.target,
    );
    platformObjects.set(packet.target, { updater, downloads, signatureSha256 });
  }
}
const firstObjects = updaterManifest ? platformObjects.get(packets[0].target) : null;
const pointerCandidate = updaterManifest
  ? {
      channel,
      version,
      updaterDescriptorKey: firstObjects.updater.version,
      downloadDescriptorKey: firstObjects.downloads.version,
      updaterDescriptorSha256,
      downloadDescriptorSha256,
      publishedAt,
    }
  : null;

// Never replace an already-selected version with a different aggregate platform set.
if (mode !== "local" && !initializesAuthority) {
  let currentLatest = null;
  let currentUpdater = null;
  if (channel === "stable") {
    try {
      const response = await boundedJsonFetch(LIVE_MANIFEST_URL);
      if (mode === "remote" && response.releaseAuthority !== "d1-v1") {
        problems.push("live download feed is not backed by the D1 release authority");
      }
      if (response.ok) currentLatest = response.value;
    } catch (error) {
      console.log(`  live manifest: unreachable (${error instanceof Error ? error.message : error})`);
      if (mode === "remote") problems.push("live download feed could not be boundedly verified");
    }
  }
  try {
    const response = await boundedJsonFetch(`https://kalcoded.com/releases/updater/${channel}/${version}.json`);
    if (mode === "remote" && response.releaseAuthority !== "d1-v1") {
      problems.push("live updater archive is not backed by the D1 release authority");
    }
    if (response.ok) {
      currentUpdater = response.value;
      problems.push(...publishedUpdaterProblems(currentUpdater, version, updaterManifest));
    }
  } catch (error) {
    console.log(`  live updater version: unreachable (${error instanceof Error ? error.message : error})`);
    if (mode === "remote") problems.push("live updater archive could not be boundedly verified");
  }
  let currentChannelUpdater = null;
  try {
    const response = await boundedJsonFetch(`https://kalcoded.com/releases/updater/${channel}.json`);
    if (mode === "remote" && response.releaseAuthority !== "d1-v1") {
      problems.push("live updater channel is not backed by the D1 release authority");
    }
    if (response.ok) currentChannelUpdater = response.value;
  } catch (error) {
    console.log(`  live updater channel: unreachable (${error instanceof Error ? error.message : error})`);
    if (mode === "remote") problems.push("live updater channel could not be boundedly verified");
  }
  problems.push(
    ...pointerAdvanceProblems({
      version,
      expectedLatest: manifest,
      expectedUpdater: updaterManifest,
      currentLatest,
      currentUpdater: currentChannelUpdater,
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
}

const reusedDownloads = new Set();
const reusedUpdaterArtifacts = new Set();
const reusedUpdaterSignatures = new Set();
let reuseDownloadDescriptor = false;
let reuseUpdaterDescriptor = false;
let authoritativePreviousRow;

function getR2Object(key, path) {
  return spawnSync(
    process.execPath,
    [wranglerBin, "r2", "object", "get", `${R2_BUCKET}/${key}`, "--file", path, "--remote"],
    releaseProcessOptions({ cwd: WEBSITE_DIR, encoding: "utf8", maxBuffer: 128 * 1024 }),
  );
}

async function probeImmutableObject(key, path, expectedSha256, label) {
  const result = getR2Object(key, path);
  if (result.status === 0) {
    if ((await sha256File(path)) !== expectedSha256) {
      problems.push(`${label} exists with bytes that do not match its content-addressed key`);
      return false;
    }
    return true;
  }
  if (!isMissingR2Object(`${result.stdout ?? ""}\n${result.stderr ?? ""}`)) {
    problems.push(`could not prove ${label} is unpublished`);
  }
  return false;
}

if (publishesRemote) {
  try {
    const rows = executeD1(buildPointerReadStatement(channel));
    if (rows.length > 1) throw new Error("authoritative D1 pointer returned multiple rows");
    authoritativePreviousRow = rows[0] ?? null;
    if (initializesAuthority) {
      if (rows.length !== 0) problems.push("release authority bootstrap requires an empty channel");
    } else problems.push(...publicationRowProblems(rows[0] ?? null, pointerCandidate));
  } catch {
    problems.push("authoritative D1 release pointer is unavailable");
  }
  const buckets = spawnSync(process.execPath, [wranglerBin, "r2", "bucket", "list"], {
    ...releaseProcessOptions({ cwd: WEBSITE_DIR, encoding: "utf8" }),
  });
  if (buckets.status !== 0 || !buckets.stdout.includes(R2_BUCKET)) {
    problems.push(`R2 bucket ${R2_BUCKET} was not found or Wrangler is not authenticated`);
  } else {
    const readbackDir = mkdtempSync(join(tmpdir(), "kalcode-release-resume-"));
    try {
      for (const packet of packets) {
        const objects = platformObjects.get(packet.target);
        if (
          await probeImmutableObject(
            objects.downloads.installer,
            join(readbackDir, `download-${packet.build.file}`),
            packet.build.sha256,
            `${packet.target} download artifact`,
          )
        )
          reusedDownloads.add(packet.target);
        const artifactExists = await probeImmutableObject(
          objects.updater.artifact,
          join(readbackDir, `updater-${packet.build.file}`),
          packet.build.sha256,
          `${packet.target} updater artifact`,
        );
        const signatureExists = await probeImmutableObject(
          objects.updater.signature,
          join(readbackDir, `updater-${packet.build.file}.sig`),
          objects.signatureSha256,
          `${packet.target} updater signature`,
        );
        if (artifactExists) reusedUpdaterArtifacts.add(packet.target);
        if (signatureExists) reusedUpdaterSignatures.add(packet.target);
      }
      const downloadDescriptorPath = join(readbackDir, "download-descriptor.json");
      if (
        await probeImmutableObject(
          pointerCandidate.downloadDescriptorKey,
          downloadDescriptorPath,
          downloadDescriptorSha256,
          "download descriptor",
        )
      ) {
        if (JSON.stringify(readJson(downloadDescriptorPath)) === JSON.stringify(manifest))
          reuseDownloadDescriptor = true;
        else problems.push("immutable download descriptor metadata does not match the aggregate release");
      }
      const updaterDescriptorPath = join(readbackDir, "updater-descriptor.json");
      if (
        await probeImmutableObject(
          pointerCandidate.updaterDescriptorKey,
          updaterDescriptorPath,
          updaterDescriptorSha256,
          "updater descriptor",
        )
      ) {
        const immutableProblems = publishedUpdaterProblems(readJson(updaterDescriptorPath), version, updaterManifest);
        problems.push(...immutableProblems);
        reuseUpdaterDescriptor = immutableProblems.length === 0;
        if (
          reuseUpdaterDescriptor &&
          (reusedUpdaterArtifacts.size !== packets.length || reusedUpdaterSignatures.size !== packets.length)
        ) {
          problems.push("immutable updater descriptor exists but its complete artifact set does not");
        }
      }
    } finally {
      rmSync(readbackDir, { recursive: true, force: true });
    }
  }
}

if (problems.length > 0) fail(`refusing to publish:\n  ${problems.join("\n  ")}`);
if (publishesRemote && existingPublicationState === null) writeJson(publicationStatePath, publicationState);
console.log(
  mode === "local"
    ? "  ok   local Windows build and manifest checks passed"
    : `  ok   ${packets.length} verified platform packet(s), notes and aggregate manifests passed`,
);

// ---- Upload -----------------------------------------------------------------------------------
const planArtifacts = packets.map((packet) => ({
  target: packet.target,
  file: packet.build.file,
  artifactPath: packet.artifactPath,
  signaturePath: packet.signaturePath,
  artifactSha256: packet.build.sha256,
  ...(updaterManifest && { signatureSha256: platformObjects.get(packet.target).signatureSha256 }),
  includeDownloadArtifact: !reusedDownloads.has(packet.target),
  includeUpdaterArtifact: !reusedUpdaterArtifacts.has(packet.target),
  includeUpdaterSignature: !reusedUpdaterSignatures.has(packet.target),
}));
const uploads = buildPublishPlan({
  bucket: R2_BUCKET,
  version,
  channel,
  artifacts: planArtifacts,
  downloadManifestPath: latestJsonPath,
  updaterManifestPath: updaterJsonPath,
  updaterDescriptorSha256: updaterDescriptorSha256 ?? "0".repeat(64),
  downloadDescriptorSha256,
  includeDownloadDescriptor: mode !== "local" && !reuseDownloadDescriptor,
  includeUpdater: mode !== "local",
  includeImmutableUpdater: mode !== "local" && !reuseUpdaterDescriptor,
  includeLocalPointer: mode === "local",
});

const show = (argv) => `wrangler ${argv.map((arg) => (/\s|"/.test(arg) ? `'${arg}'` : arg)).join(" ")}`;
if (mode === "dry-run") {
  console.log("\nDry run. These commands would run (from apps/website):");
  for (const upload of uploads) console.log(`  ${show([...upload.argv, "--remote"])}`);
  console.log(`  wrangler d1 execute ${D1_DATABASE} --remote --json --command '<claim immutable version>'`);
  console.log(`  wrangler d1 execute ${D1_DATABASE} --remote --json --command '<advance channel pointer atomically>'`);
  console.log(JSON.stringify(manifest, null, 2));
  process.exit(0);
}

const location = mode === "local" ? "--local" : "--remote";
for (const upload of uploads) {
  const argv = [...upload.argv, location];
  console.log(`\n> ${show(argv)}`);
  run(process.execPath, [wranglerBin, ...argv], releaseProcessOptions({ cwd: WEBSITE_DIR }));
  if (upload.name === "immutable updater version descriptor") {
    console.log("  uploaded aggregate immutable updater descriptor; full readback follows");
  }
}

const getJson = (key) => {
  const result = spawnSync(
    process.execPath,
    [wranglerBin, "r2", "object", "get", `${R2_BUCKET}/${key}`, "--pipe", location],
    releaseProcessOptions({ cwd: WEBSITE_DIR, encoding: "utf8" }),
  );
  if (result.status !== 0) fail(`could not read back ${key}`);
  return JSON.parse(result.stdout);
};

if (mode === "local") {
  if (JSON.stringify(getJson("releases/latest.json")) !== JSON.stringify(manifest)) {
    fail("local releases/latest.json read back with different release metadata");
  }
  console.log("\n  ok   local releases/latest.json read back from R2 and matches");
  process.exit(0);
}

// Full final readback is the publication linearization gate before the immutable D1 claim.
const finalReadback = mkdtempSync(join(tmpdir(), "kalcode-release-readback-"));
try {
  const downloadedInputs = [];
  for (const packet of packets) {
    const objects = platformObjects.get(packet.target);
    const platformDir = join(finalReadback, packet.target);
    mkdirSync(platformDir);
    const downloadPath = join(platformDir, `download-${packet.build.file}`);
    const artifactPath = join(platformDir, packet.build.file);
    const signaturePath = join(platformDir, basename(packet.signaturePath));
    for (const [key, path] of [
      [objects.downloads.installer, downloadPath],
      [objects.updater.artifact, artifactPath],
      [objects.updater.signature, signaturePath],
    ]) {
      if (getR2Object(key, path).status !== 0) fail(`could not read back ${key}`);
    }
    if (
      (await sha256File(downloadPath)) !== packet.build.sha256 ||
      (await sha256File(artifactPath)) !== packet.build.sha256
    ) {
      fail(`${packet.target} immutable artifacts read back with different bytes`);
    }
    if ((await sha256File(signaturePath)) !== objects.signatureSha256) {
      fail(`${packet.target} immutable updater signature read back with different bytes`);
    }
    downloadedInputs.push({
      ...packet,
      artifactPath,
      signaturePath,
      artifactKey: objects.updater.artifact,
      publicKeyBase64: updaterPublicKey,
    });
  }
  const downloadDescriptorPath = join(finalReadback, "download.json");
  const updaterDescriptorPath = join(finalReadback, "updater.json");
  if (getR2Object(pointerCandidate.downloadDescriptorKey, downloadDescriptorPath).status !== 0) {
    fail("could not read back immutable download descriptor");
  }
  if (getR2Object(pointerCandidate.updaterDescriptorKey, updaterDescriptorPath).status !== 0) {
    fail("could not read back immutable updater descriptor");
  }
  if (
    (await sha256File(downloadDescriptorPath)) !== downloadDescriptorSha256 ||
    JSON.stringify(readJson(downloadDescriptorPath)) !== JSON.stringify(manifest)
  )
    fail("immutable download descriptor read back with different metadata or bytes");
  const reverified = mac
    ? await createPlatformUpdaterManifest({
        artifacts: downloadedInputs,
        requestedChannel: channel,
        publishedAt,
        notes: releaseNotesText,
      })
    : await createUpdaterManifest({
        ...downloadedInputs[0],
        requestedChannel: channel,
        publishedAt,
        notes: releaseNotesText,
      });
  if (
    (await sha256File(updaterDescriptorPath)) !== updaterDescriptorSha256 ||
    JSON.stringify(readJson(updaterDescriptorPath)) !== JSON.stringify(updaterManifest) ||
    JSON.stringify(reverified) !== JSON.stringify(updaterManifest)
  )
    fail("immutable updater descriptor did not cryptographically reverify the complete platform set");
  console.log("  ok   every immutable platform artifact, signature and aggregate descriptor read back and verified");
} finally {
  rmSync(finalReadback, { recursive: true, force: true });
}

const claimed = executeD1(buildVersionClaimStatement(pointerCandidate));
let versionRows = claimed;
if (versionRows.length === 0) {
  versionRows = executeD1(buildVersionReadStatement(pointerCandidate.channel, pointerCandidate.version));
}
if (versionRows.length !== 1) fail("authoritative D1 release version could not be claimed");
const versionProblems = publicationRowProblems(versionRows[0], pointerCandidate);
if (versionProblems.length > 0) fail(versionProblems.join("; "));

const advanced = executeD1(
  initializesAuthority
    ? buildInitialPointerStatement(pointerCandidate)
    : buildPointerAdvanceStatement(pointerCandidate, authoritativePreviousRow),
);
if (advanced.length !== 1 || advanced[0]?.channel !== pointerCandidate.channel || advanced[0]?.version !== version) {
  const current = executeD1(buildPointerReadStatement(pointerCandidate.channel));
  const reason = publicationRowProblems(current[0] ?? null, pointerCandidate);
  fail(reason[0] ?? "authoritative D1 release pointer compare-and-set was rejected");
}
const authoritative = executeD1(buildPointerReadStatement(pointerCandidate.channel));
if (authoritative.length !== 1 || publicationRowProblems(authoritative[0], pointerCandidate).length > 0) {
  fail("authoritative D1 release pointer did not read back exactly");
}

if (initializesAuthority) {
  if (channel === "stable") {
    writeJson(WEBSITE_MANIFEST, manifest);
    run("pnpm", ["exec", "biome", "format", "--write", WEBSITE_MANIFEST], releaseProcessOptions({ timeout: 60_000 }));
  }
  console.log("Initialized the empty D1 release authority from the verified aggregate release.");
  process.exit(0);
}

const verificationNonce = encodeURIComponent(updaterDescriptorSha256.slice(0, 16));
const liveUpdater = await boundedJsonFetch(
  `https://kalcoded.com/releases/updater/${channel}.json?release_verify=${verificationNonce}`,
);
if (liveUpdater.releaseAuthority !== "d1-v1" || JSON.stringify(liveUpdater.value) !== JSON.stringify(updaterManifest)) {
  fail("public updater feed did not read back from the D1 authority with exact metadata");
}
if (channel === "stable") {
  const liveDownload = await boundedJsonFetch(`${LIVE_MANIFEST_URL}?release_verify=${verificationNonce}`);
  if (liveDownload.releaseAuthority !== "d1-v1" || JSON.stringify(liveDownload.value) !== JSON.stringify(manifest)) {
    fail("public download feed did not read back from the D1 authority with exact metadata");
  }
  console.log("  ok   public download and updater feeds read back from the D1 authority");
} else {
  console.log(`  ok   public ${channel} updater feed read back from the D1 authority`);
}

if (channel === "stable") {
  writeJson(WEBSITE_MANIFEST, manifest);
  run("pnpm", ["exec", "biome", "format", "--write", WEBSITE_MANIFEST], releaseProcessOptions({ timeout: 60_000 }));
}
console.log(`\nPublished KalCode ${version} (${channel}):`);
for (const packet of packets) {
  const key = platformObjects.get(packet.target).downloads.installer;
  console.log(
    `  ${packet.target}  r2://${R2_BUCKET}/${key}  ${formatBytes(packet.build.size)}  ${packet.build.sha256}`,
  );
}
console.log(`\nWrote ${relative(ROOT, WEBSITE_MANIFEST)}. Deploy and verify the website release routes.`);
