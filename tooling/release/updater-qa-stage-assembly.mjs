// Local packet/source assembly for stage-updater-qa.mjs. No network or release-authority access.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { ROOT, sha256File } from "./lib.mjs";
import { expectedMacDmgFile } from "./macos-contract.mjs";
import { buildManifest, validateManifest } from "./manifest.mjs";
import {
  publicationJsonBytes,
  resolvePlatformPublicationState,
  writeFrozenPublicationJson,
} from "./publication-safety.mjs";
import { buildUpdaterQaStagePlan } from "./publish-plan.mjs";
import { expectedWindowsInstallerFile } from "./signing.mjs";
import { validateBaselineSourceSnapshot } from "./stage-updater-qa.mjs";
import { baselineWaiverCandidateProblems, createPlatformUpdaterManifest } from "./updater-manifest.mjs";
import { readUpdaterPublicKey } from "./updater-signing.mjs";

function command(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${command} ${args[0] ?? ""} failed during updater QA packet assembly`);
  return (result.stdout ?? "").trim();
}

function git(source, args) {
  return command("git", ["-C", source, ...args], source);
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`${label} is missing or invalid`);
  }
}

function frozenJson(path, value, write) {
  const bytes = publicationJsonBytes(value);
  if (existsSync(path)) {
    if (!readFileSync(path).equals(bytes)) {
      throw new Error(`${basename(path)} already exists with different immutable publication bytes`);
    }
  } else if (write) {
    writeFrozenPublicationJson(path, value);
  }
  return bytes;
}

async function loadPackets(staging, version) {
  const windowsFile = expectedWindowsInstallerFile(version);
  const macFile = expectedMacDmgFile(version, "arm64");
  const specifications = [
    {
      target: "windows-x86_64",
      build: "build.json",
      verify: "verify.json",
      qa: "windows-x86_64-qa.json",
      file: windowsFile,
      signature: `${windowsFile}.windows-x86_64.sig`,
    },
    {
      target: "darwin-aarch64",
      build: "macos-arm64-build.json",
      verify: "macos-arm64-verify.json",
      qa: "macos-arm64-qa.json",
      file: macFile,
      signature: `${macFile}.sig`,
    },
  ];
  const packets = [];
  for (const specification of specifications) {
    const build = readJson(join(staging, specification.build), `${specification.target} build record`);
    const verify = readJson(join(staging, specification.verify), `${specification.target} verification record`);
    let qaBytes;
    let qa;
    try {
      qaBytes = readFileSync(join(staging, specification.qa));
      qa = JSON.parse(qaBytes.toString("utf8"));
    } catch {
      throw new Error(`${specification.target} preliminary QA record is missing or invalid`);
    }
    const artifactPath = join(staging, specification.file);
    const signaturePath = join(staging, specification.signature);
    if (build.version !== version || build.file !== specification.file || build.requestedReleaseChannel !== "stable") {
      throw new Error(`${specification.target} build record is not the exact Stable ${version} artifact`);
    }
    if (!existsSync(artifactPath) || !existsSync(signaturePath)) {
      throw new Error(`${specification.target} artifact or target-bound signature is missing`);
    }
    if (statSync(artifactPath).size !== build.size || (await sha256File(artifactPath)) !== build.sha256) {
      throw new Error(`${specification.target} artifact does not match its build record`);
    }
    packets.push({ ...specification, build, verify, qa, qaSha256: sha256Bytes(qaBytes), artifactPath, signaturePath });
  }
  return packets;
}

function sourceFiles(source, commit) {
  return Object.fromEntries(
    [
      "Cargo.lock",
      "Cargo.toml",
      "apps/desktop/package.json",
      "apps/desktop/src-tauri/tauri.conf.json",
      "crates/updater/src/lib.rs",
    ].map((path) => [path, `${git(source, ["show", `${commit}:${path}`])}\n`]),
  );
}

const APPROVED_TOOL_FILES = new Set([
  "tooling/release/updater-manifest.mjs",
  "tooling/release/updater-manifest.test.mjs",
  "tooling/release/updater-qa-stage-assembly.mjs",
  "tooling/release/updater-qa-stage-assembly.test.mjs",
  "tooling/release/stage-updater-qa.mjs",
  "tooling/release/stage-updater-qa.test.mjs",
]);

function assertAncestor(source, commit, head, label) {
  const result = spawnSync("git", ["-C", source, "merge-base", "--is-ancestor", commit, head], { windowsHide: true });
  if (result.status !== 0) throw new Error(`${label} does not contain the exact signed build commit`);
}

// toolSource is injectable for Git-backed tests only. The CLI always uses the actual module ROOT.
export function validateCandidateToolAuthority({
  candidateSource,
  candidateCommit,
  approvedToolCommit,
  toolSource = ROOT,
}) {
  const candidateHead = git(candidateSource, ["rev-parse", "HEAD"]);
  if (approvedToolCommit === undefined && resolve(candidateSource) !== resolve(toolSource)) {
    throw new Error("candidate source must be the checkout that owns the executing release tooling");
  }
  if (git(candidateSource, ["status", "--porcelain", "--untracked-files=normal"])) {
    throw new Error("candidate source must be clean before updater QA staging");
  }
  assertAncestor(candidateSource, candidateCommit, candidateHead, "candidate source");
  const candidateTail = git(candidateSource, ["diff", "--name-only", candidateCommit, candidateHead])
    .split(/\r?\n/u)
    .filter(Boolean);
  if (candidateTail.some((path) => !path.startsWith("docs/releases/"))) {
    throw new Error("candidate source changed beyond release notes after the signed build commit");
  }
  if (approvedToolCommit === undefined) return null;
  if (!/^[a-f0-9]{40}$/u.test(approvedToolCommit) || git(toolSource, ["rev-parse", "HEAD"]) !== approvedToolCommit) {
    throw new Error("executing tooling must match the exact approved tool commit");
  }
  if (git(toolSource, ["status", "--porcelain", "--untracked-files=normal"])) {
    throw new Error("executing tool source must be clean before updater QA staging");
  }
  assertAncestor(toolSource, candidateCommit, approvedToolCommit, "executing tool source");
  const toolTail = git(toolSource, ["diff", "--name-only", candidateCommit, approvedToolCommit])
    .split(/\r?\n/u)
    .filter(Boolean);
  if (toolTail.some((path) => !APPROVED_TOOL_FILES.has(path))) {
    throw new Error("executing tool source changed beyond the six reviewed release-tool files");
  }
  return { toolCommit: approvedToolCommit, productCommit: candidateCommit, candidateNotesCommit: candidateHead };
}

function validateSourceAuthority({ baselineSource, candidateSource, baseline, candidate, approvedToolCommit }) {
  const baselineHead = git(baselineSource, ["rev-parse", "HEAD"]);
  if (baselineHead !== baseline.commit || git(baselineSource, ["status", "--porcelain", "--untracked-files=normal"])) {
    throw new Error("baseline source must be a clean checkout of the exact signed build commit");
  }
  const authority = validateCandidateToolAuthority({
    candidateSource,
    candidateCommit: candidate.commit,
    approvedToolCommit,
  });
  validateBaselineSourceAuthority({ baselineSource, baseline, candidate });
  return authority;
}

export function validateBaselineSourceAuthority({ baselineSource, baseline, candidate }) {
  // The signed older baseline remains immutable as release fixes advance the candidate.
  // Bind its mechanical derivation to its original source, then require that source in
  // the candidate's history. Rebuilding the baseline would erase the older-code trial.
  const parents = git(baselineSource, ["rev-list", "--parents", "-n", "1", baseline.commit]).split(/\s+/u);
  if (parents.length !== 2 || parents[0] !== baseline.commit) {
    throw new Error("QA baseline must have exactly one parent source commit");
  }
  const sourceBase = parents[1];
  const based = spawnSync("git", ["-C", baselineSource, "merge-base", "--is-ancestor", sourceBase, candidate.commit], {
    windowsHide: true,
  });
  if (based.status !== 0) throw new Error("QA baseline source base is not an ancestor of the exact candidate commit");
  const changedFiles = git(baselineSource, ["diff", "--name-only", sourceBase, baseline.commit])
    .split(/\r?\n/u)
    .filter(Boolean);
  const metadata = JSON.parse(command("cargo", ["metadata", "--no-deps", "--format-version", "1"], baselineSource));
  const workspaceIds = new Set(metadata.workspace_members);
  const workspacePackages = metadata.packages.filter((value) => workspaceIds.has(value.id)).map((value) => value.name);
  const problems = validateBaselineSourceSnapshot({
    candidateVersion: candidate.version,
    baselineVersion: baseline.version,
    workspacePackages,
    candidateFiles: sourceFiles(baselineSource, sourceBase),
    baselineFiles: sourceFiles(baselineSource, baseline.commit),
    changedFiles,
  });
  if (problems.length > 0) throw new Error(`baseline source is not an exact QA derivation: ${problems.join("; ")}`);
}

export async function assembleRelease({ staging, source, packets, version, notes, write, role = "candidate" }) {
  if (role !== "baseline" && role !== "candidate") throw new Error("updater QA release role is invalid");
  const commit = packets[0].build.commit;
  if (packets.some((packet) => packet.build.commit !== commit)) {
    throw new Error(`${version} platform packets do not share one source commit`);
  }
  const signatureDigests = new Map(
    await Promise.all(packets.map(async (packet) => [packet.target, await sha256File(packet.signaturePath)])),
  );
  const release = {
    version,
    commit,
    requestedReleaseChannel: "stable",
    artifacts: packets.map((packet) => ({
      target: packet.target,
      file: packet.build.file,
      size: packet.build.size,
      sha256: packet.build.sha256,
      signatureSha256: signatureDigests.get(packet.target),
      builtAt: packet.build.builtAt ?? packet.build.createdAt,
    })),
  };
  const publicationPath = join(staging, "publication.json");
  const existing = existsSync(publicationPath) ? readJson(publicationPath, "publication state") : null;
  const publication = resolvePlatformPublicationState(existing, release, new Date().toISOString());
  const publicationBytes = frozenJson(publicationPath, publication, write);
  const platformInputs = packets.map((packet) => ({
    target: packet.target,
    build: packet.build,
    verify: packet.verify,
    qa: packet.qa,
    artifactPath: packet.artifactPath,
    signaturePath: packet.signaturePath,
    artifactKey: `releases/updater/stable/${version}/${packet.build.sha256}/${packet.build.file}`,
    publicKeyBase64: readUpdaterPublicKey(),
  }));
  const updater = await createPlatformUpdaterManifest({
    artifacts: platformInputs,
    requestedChannel: "stable",
    publishedAt: publication.publishedAt,
    notes,
    qaPhase: role === "baseline" ? "baseline-preliminary" : "preliminary",
  });
  const windows = packets.find((packet) => packet.target === "windows-x86_64");
  const mac = packets.find((packet) => packet.target === "darwin-aarch64");
  const download = buildManifest({
    version,
    commit,
    publishedAt: publication.publishedAt,
    channel: "stable",
    windows: { file: windows.build.file, size: windows.build.size, sha256: windows.build.sha256, signed: true },
    macosArm64: { file: mac.build.file, size: mac.build.size, sha256: mac.build.sha256, signed: true },
  });
  const manifestProblems = validateManifest(download);
  if (manifestProblems.length > 0) throw new Error(`download descriptor is invalid: ${manifestProblems.join("; ")}`);
  const updaterPath = join(staging, "stable.json");
  const downloadPath = join(staging, "latest.json");
  const updaterBytes = frozenJson(updaterPath, updater, write);
  const downloadBytes = frozenJson(downloadPath, download, write);
  const updaterDescriptorSha256 = sha256Bytes(updaterBytes);
  const downloadDescriptorSha256 = sha256Bytes(downloadBytes);
  const plan = buildUpdaterQaStagePlan({
    bucket: "kalcode-releases",
    version,
    channel: "stable",
    artifacts: packets.map((packet) => ({
      target: packet.target,
      file: packet.build.file,
      artifactPath: packet.artifactPath,
      signaturePath: packet.signaturePath,
      artifactSha256: packet.build.sha256,
      signatureSha256: signatureDigests.get(packet.target),
    })),
    downloadManifestPath: downloadPath,
    updaterManifestPath: updaterPath,
    updaterDescriptorSha256,
    downloadDescriptorSha256,
  });
  const descriptorBytes = new Map([
    [updaterPath, updaterBytes],
    [downloadPath, downloadBytes],
  ]);
  const pathDigests = new Map(
    packets.flatMap((packet) => [
      [packet.artifactPath, { sha256: packet.build.sha256, size: packet.build.size }],
      [
        packet.signaturePath,
        { sha256: signatureDigests.get(packet.target), size: statSync(packet.signaturePath).size },
      ],
    ]),
  );
  pathDigests.set(updaterPath, { sha256: updaterDescriptorSha256, size: updaterBytes.length });
  pathDigests.set(downloadPath, { sha256: downloadDescriptorSha256, size: downloadBytes.length });
  const objects = plan.map((upload) => {
    const fileIndex = upload.argv.indexOf("--file");
    const path = upload.argv[fileIndex + 1];
    const identity = pathDigests.get(path);
    if (!identity) throw new Error(`upload plan path is not bound to release evidence: ${path}`);
    return {
      key: upload.key,
      path,
      ...identity,
      ...(descriptorBytes.has(path) && { bytes: descriptorBytes.get(path) }),
    };
  });
  const first = objects.find((object) => object.key.endsWith(`/${updaterDescriptorSha256}.json`));
  const downloadObject = objects.find(
    (object) => object.key === `releases/${version}/${downloadDescriptorSha256}.json`,
  );
  if (!first || !downloadObject) throw new Error("immutable descriptor upload plan is incomplete");
  return {
    version,
    commit,
    source,
    candidate: {
      channel: "stable",
      version,
      updaterDescriptorKey: first.key,
      downloadDescriptorKey: downloadObject.key,
      updaterDescriptorSha256,
      downloadDescriptorSha256,
      publishedAt: publication.publishedAt,
    },
    publication,
    publicationSha256: sha256Bytes(publicationBytes),
    objects,
  };
}

export async function assembleUpdaterQaStage(options) {
  for (const path of [
    options.baselineSource,
    options.baselineStaging,
    options.candidateSource,
    options.candidateStaging,
  ]) {
    if (!existsSync(path)) throw new Error(`updater QA input path does not exist: ${path}`);
  }
  const baselineBuild = readJson(join(options.baselineStaging, "build.json"), "baseline Windows build record");
  const candidateBuild = readJson(join(options.candidateStaging, "build.json"), "candidate Windows build record");
  const baselineVersion = baselineBuild.version;
  const candidateVersion = candidateBuild.version;
  const baselinePackets = await loadPackets(options.baselineStaging, baselineVersion);
  const candidatePackets = await loadPackets(options.candidateStaging, candidateVersion);
  const toolAuthority = validateSourceAuthority({
    baselineSource: options.baselineSource,
    candidateSource: options.candidateSource,
    baseline: { version: baselineVersion, commit: baselineBuild.commit },
    candidate: { version: candidateVersion, commit: candidateBuild.commit },
    approvedToolCommit: options.approvedToolCommit,
  });
  // A baseline account-isolation or browser waiver defers the proof to the candidate; refuse before
  // any descriptor or publication state is assembled unless the same platform's candidate proves it.
  for (const baselinePacket of baselinePackets) {
    const candidatePacket = candidatePackets.find((packet) => packet.target === baselinePacket.target);
    const problems = baselineWaiverCandidateProblems(baselinePacket.qa, candidatePacket?.qa);
    if (problems.length > 0) throw new Error(`${baselinePacket.target} ${problems.join("; ")}`);
  }
  const sourceAuthority = toolAuthority && {
    ...toolAuthority,
    baselineQaSha256: Object.fromEntries(baselinePackets.map((packet) => [packet.target, packet.qaSha256])),
  };
  const notesPath = join(options.candidateSource, "docs", "releases", `${candidateVersion}.md`);
  if (!existsSync(notesPath)) throw new Error("candidate release notes are missing");
  const candidateNotes = readFileSync(notesPath, "utf8");
  if (candidatePackets.some((packet) => !candidateNotes.includes(packet.build.sha256))) {
    throw new Error("candidate release notes do not bind every target artifact SHA-256");
  }
  const write = options.mode === "remote";
  const baseline = await assembleRelease({
    staging: options.baselineStaging,
    source: options.baselineSource,
    packets: baselinePackets,
    version: baselineVersion,
    notes: "Private signed baseline for KalCode updater release QA.",
    write,
    role: "baseline",
  });
  const candidate = await assembleRelease({
    staging: options.candidateStaging,
    source: options.candidateSource,
    packets: candidatePackets,
    version: candidateVersion,
    notes: candidateNotes,
    write,
  });
  return { baseline, candidate, ...(sourceAuthority && { sourceAuthority }) };
}
