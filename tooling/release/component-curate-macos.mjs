#!/usr/bin/env node
// Curates only the pinned Apple Silicon closure. Default output is a signed,
// non-publishable candidate; notarization is a separate owner-credential stage.
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { loadComponentContract, MACOS_RUNTIME_CODE_MEMBERS, MACOS_RUNTIME_POLICY } from "./component-contract.mjs";
import { writeDeterministicZip } from "./component-curate-windows.mjs";
import { sha256File } from "./lib.mjs";
import { assertProductionCodesign, validateMacSigningEnvironment } from "./macos-contract.mjs";
import { macProcessRunner } from "./macos-verify-lib.mjs";

const CONTRACT_PATH = join(import.meta.dirname, "components", "kalvoice-local-reasoning-v1.json");
const MAX_BYTES = 128 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SYSTEM_LIBRARIES = new Set([
  "/usr/lib/librdma.dylib",
  "/usr/lib/libc++.1.dylib",
  "/usr/lib/libSystem.B.dylib",
  "/usr/lib/libobjc.A.dylib",
  "/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation",
  "/System/Library/Frameworks/Security.framework/Versions/A/Security",
  "/System/Library/Frameworks/Accelerate.framework/Versions/A/Accelerate",
  "/System/Library/Frameworks/Foundation.framework/Versions/C/Foundation",
  "/System/Library/Frameworks/Metal.framework/Versions/A/Metal",
  "/System/Library/Frameworks/MetalKit.framework/Versions/A/MetalKit",
]);
function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function field(header, start, length) {
  return header
    .subarray(start, start + length)
    .toString("utf8")
    .replace(/\0.*$/s, "")
    .trim();
}
function octal(header, start, length) {
  const value = field(header, start, length);
  if (!/^[0-7]+$/.test(value)) throw Error("unsafe tar numeric field");
  const number = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(number) || number < 0 || number > MAX_BYTES) throw Error("unsafe tar size");
  return number;
}

export function readMacRuntimeTar(compressed) {
  const tar = gunzipSync(compressed, { maxOutputLength: MAX_BYTES });
  const entries = new Map();
  const names = new Set();
  let terminated = false;
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (tar.length - offset < 1024 || tar.subarray(offset).some((byte) => byte !== 0))
        throw Error("unsafe tar trailer");
      terminated = true;
      break;
    }
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : header[i];
    if (checksum !== octal(header, 148, 8)) throw Error("invalid tar checksum");
    const name = field(header, 0, 100).replace(/\/$/, "");
    const prefix = field(header, 345, 155);
    const type = field(header, 156, 1) || "0";
    const size = octal(header, 124, 12);
    const link = field(header, 157, 100);
    if (
      prefix ||
      !/^llama-b11146(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)?$/.test(name) ||
      name.includes("..") ||
      !["0", "2", "5"].includes(type)
    )
      throw Error("unsafe tar member");
    if (type !== "0" && size !== 0) throw Error("unsafe tar non-file size");
    if (offset + 512 + size > tar.length) throw Error("truncated tar member");
    const flat = name.slice("llama-b11146/".length);
    if (name === "llama-b11146") {
      if (type !== "5") throw Error("invalid tar root");
    } else {
      if (names.has(flat.toLowerCase()) || entries.size >= 100) throw Error("duplicate or excessive tar members");
      names.add(flat.toLowerCase());
      if (type === "5" || (type === "2" && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(link))) throw Error("unsafe tar alias");
      entries.set(flat, { type, link, bytes: tar.subarray(offset + 512, offset + 512 + size) });
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (!terminated || entries.size !== 60) throw Error("Mac runtime tar inventory does not match pinned archive");
  return entries;
}

export function selectMacRuntimeMembers(entries, policy = MACOS_RUNTIME_POLICY) {
  return policy.members.map(({ file, source }) => {
    const alias = entries.get(file);
    const member = entries.get(source);
    if (file !== source && (alias?.type !== "2" || alias.link !== source))
      throw Error("Mac runtime alias does not match pinned target");
    if (member?.type !== "0" || !Buffer.isBuffer(member.bytes) || member.bytes.length === 0)
      throw Error("Mac runtime member is not an ordinary nonempty file");
    return { file, bytes: member.bytes };
  });
}

export function validateMacRuntimeMachO({ archs, loadCommands, dependencies }) {
  if (archs.trim() !== "arm64") throw Error("Mac runtime architecture must be exactly arm64");
  const minimum = [...loadCommands.matchAll(/^\s*minos (\d+)\.(\d+)(?:\.\d+)?\s*$/gm)];
  if (minimum.length !== 1 || Number(minimum[0][1]) > 14 || (Number(minimum[0][1]) === 14 && Number(minimum[0][2]) > 0))
    throw Error("Mac runtime minimum OS exceeds desktop support");
  const paths = [...loadCommands.matchAll(/cmd LC_RPATH\s+[\s\S]*?path (\S+) \(offset \d+\)/g)].map(
    (match) => match[1],
  );
  if (paths.length !== 1 || paths[0] !== "@loader_path")
    throw Error("Mac runtime rpath is not confined to its loader directory");
  const linked = dependencies
    .split(/\r?\n/)
    .slice(1)
    .filter((line) => line.trim())
    .map((line) => line.trim().split(" (")[0]);
  if (
    linked.length === 0 ||
    linked.some(
      (path) => !SYSTEM_LIBRARIES.has(path) && !MACOS_RUNTIME_CODE_MEMBERS.some((file) => path === `@rpath/${file}`),
    )
  )
    throw Error("Mac runtime dependency closure is incomplete or external");
  return true;
}
export function macRuntimeIdentifier(file) {
  return `com.kalcode.kalvoice.runtime.${file}`;
}

export function verifyMacRuntimeDirectory(directory, { runner = macProcessRunner, requireNotarized = false } = {}) {
  for (const file of MACOS_RUNTIME_CODE_MEMBERS) {
    const path = join(directory, file);
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
      throw Error("Mac runtime contains a non-regular code member");
    validateMacRuntimeMachO({
      archs: runner.capture("lipo", ["-archs", path]),
      loadCommands: runner.capture("otool", ["-l", path]),
      dependencies: runner.capture("otool", ["-L", path]),
    });
    runner.run("codesign", ["--verify", "--strict", "--verbose=2", path]);
    assertProductionCodesign(
      runner.capture("codesign", ["--display", "--verbose=4", path], { output: "stderr" }),
      MACOS_RUNTIME_POLICY.expectedTeamId,
      macRuntimeIdentifier(file),
    );
    const entitlements = runner.capture("codesign", ["--display", "--entitlements", ":-", path]);
    if (entitlements.trim()) {
      const parsed = JSON.parse(
        runner.capture("plutil", ["-convert", "json", "-o", "-", "-"], { input: entitlements }),
      );
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length !== 0)
        throw Error("Mac runtime must not carry entitlement exceptions");
    }
    if (requireNotarized) runner.run("codesign", ["--verify", "--strict", "-R=notarized", path]);
  }
}

export function validateMacRuntimeNotaryEvidence(value, artifactSha256) {
  if (
    !value ||
    Object.keys(value).sort().join(",") !== "allCodeNotarized,artifactSha256,logIssueFree,status,submissionId" ||
    value.status !== "accepted" ||
    !UUID.test(value.submissionId ?? "") ||
    value.artifactSha256 !== artifactSha256 ||
    !SHA256.test(artifactSha256) ||
    value.logIssueFree !== true ||
    value.allCodeNotarized !== true
  )
    throw Error("Mac runtime notarization evidence is incomplete or mismatched");
  return true;
}

export function validateMacRuntimePublicationEvidence(record, artifact, catalog, contract) {
  return validateMacRuntimeCurationEvidence(record, artifact, catalog, contract, false);
}
export function validateMacRuntimeCandidateEvidence(record, artifact, catalog, contract) {
  return validateMacRuntimeCurationEvidence(record, artifact, catalog, contract, true);
}
function validateMacRuntimeCurationEvidence(record, artifact, catalog, contract, candidateOnly) {
  const policy = contract.runtime.macosAarch64;
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const required = [
    "schemaVersion",
    "componentId",
    "kind",
    "version",
    "platform",
    "arch",
    "runtimeAbi",
    "source",
    "artifact",
    "recipeSha256",
    "licenses",
    "memberCount",
    "codeMemberCount",
    "signing",
    "members",
    "notarization",
    "releaseEligible",
    "createdAt",
  ];
  if (
    !policy ||
    !record ||
    Object.keys(record).sort().join(",") !== required.sort().join(",") ||
    record.schemaVersion !== 1 ||
    record.componentId !== artifact.componentId ||
    record.kind !== artifact.kind ||
    record.version !== artifact.version ||
    record.platform !== catalog.platform ||
    record.arch !== catalog.arch ||
    record.runtimeAbi !== artifact.runtimeAbi ||
    record.releaseEligible !== !candidateOnly ||
    !same(record.source, {
      id: policy.source.id,
      revision: policy.source.revision,
      file: policy.source.file,
      size: policy.source.sizeBytes,
      sha256: policy.source.sha256,
    }) ||
    !same(record.artifact, { file: artifact.file, size: artifact.sizeBytes, sha256: artifact.sha256 }) ||
    !SHA256.test(record.recipeSha256 ?? "") ||
    record.recipeSha256 !== artifact.provenance.buildRecipeSha256 ||
    record.memberCount !== policy.extractEntries.length ||
    record.codeMemberCount !== policy.codeEntries.length ||
    !same(record.signing, {
      provider: "apple-developer-id",
      teamId: policy.expectedTeamId,
      allCodeSigned: true,
      timestamped: true,
      hardenedRuntime: true,
      noEntitlementExceptions: true,
    }) ||
    !same(
      record.licenses,
      policy.licenses.map(({ spdxId, noticeSha256 }) => ({ spdxId, noticeSha256 })),
    ) ||
    !same(record.licenses, artifact.licenses) ||
    artifact.provenance.sourceId !== policy.source.id ||
    artifact.provenance.sourceRevision !== policy.source.revision ||
    artifact.provenance.sourceIntegritySha256 !== policy.source.sha256 ||
    !Array.isArray(record.members) ||
    record.members.length !== policy.codeEntries.length ||
    record.members.some(
      (member, index) =>
        Object.keys(member).sort().join(",") !== "file,sha256" ||
        member.file !== policy.codeEntries[index] ||
        !SHA256.test(member.sha256 ?? ""),
    ) ||
    !Number.isFinite(Date.parse(record.createdAt)) ||
    new Date(record.createdAt).toISOString() !== record.createdAt ||
    Math.floor(Date.parse(record.createdAt) / 1000) > catalog.issuedAt
  )
    throw Error("Mac runtime curation evidence is not eligible or does not match the signed component");
  if (candidateOnly) {
    if (!same(record.notarization, { status: "pending" }))
      throw Error("Mac runtime candidate must remain pending notarization");
  } else validateMacRuntimeNotaryEvidence(record.notarization, artifact.sha256);
}

function safeFile(path) {
  const stat = lstatSync(path);
  if (!isAbsolute(path) || !stat.isFile() || stat.isSymbolicLink() || realpathSync(path) !== resolve(path))
    throw Error("Mac component input must be an ordinary absolute file");
  return stat;
}
function safeOutput(path) {
  if (!isAbsolute(path) || existsSync(path) || realpathSync(dirname(path)) !== resolve(dirname(path)))
    throw Error("Mac component output must be new in an ordinary absolute directory");
}

export async function curateMacRuntime(
  { sourcePath, artifactPath, recordPath },
  { runner = macProcessRunner, env = process.env } = {},
) {
  const contract = loadComponentContract(CONTRACT_PATH);
  const policy = contract.runtime.macosAarch64;
  const credentials = validateMacSigningEnvironment(env);
  if (basename(artifactPath) !== policy.artifactFile) throw Error("Mac runtime artifact filename must be runtime.zip");
  if (credentials.teamId !== policy.expectedTeamId)
    throw Error("Mac runtime signing team does not match approved publisher");
  if (new Set([sourcePath, artifactPath, recordPath].map((path) => resolve(path))).size !== 3)
    throw Error("Mac component paths must be distinct");
  safeOutput(artifactPath);
  safeOutput(recordPath);
  if (safeFile(sourcePath).size !== policy.source.sizeBytes) throw Error("Mac runtime source size mismatch");
  const sourceBytes = readFileSync(sourcePath);
  if (digest(sourceBytes) !== policy.source.sha256) throw Error("Mac runtime source digest mismatch");
  const members = selectMacRuntimeMembers(readMacRuntimeTar(sourceBytes), policy);
  if (digest(members.find((member) => member.file === "LICENSE").bytes) !== policy.licenses[0].noticeSha256)
    throw Error("Mac runtime license differs from pinned MIT notice");
  const staging = mkdtempSync(join(dirname(artifactPath), ".mac-runtime-curation-"));
  try {
    for (const { file, bytes } of members)
      writeFileSync(join(staging, file), bytes, { flag: "wx", mode: file === "LICENSE" ? 0o644 : 0o755 });
    // Inspect the entire upstream closure before changing any signature.
    for (const file of policy.codeEntries) {
      const path = join(staging, file);
      validateMacRuntimeMachO({
        archs: runner.capture("lipo", ["-archs", path]),
        loadCommands: runner.capture("otool", ["-l", path]),
        dependencies: runner.capture("otool", ["-L", path]),
      });
    }
    for (const file of policy.codeEntries)
      runner.run("codesign", [
        "--force",
        "--sign",
        credentials.signingIdentity,
        "--options",
        "runtime",
        "--timestamp",
        "--identifier",
        macRuntimeIdentifier(file),
        join(staging, file),
      ]);
    verifyMacRuntimeDirectory(staging, { runner });
    const version = runner.capture(join(staging, policy.entrypoint), ["--version"], {
      output: "combined",
      env: { PATH: "/usr/bin:/bin", LANG: "C" },
      timeout: 30_000,
    });
    if (!version.includes("11146") || !version.includes("7fe450e"))
      throw Error("Signed Mac runtime does not report the pinned build identity");
    writeDeterministicZip(staging, policy.extractEntries, artifactPath);
    const record = {
      schemaVersion: 1,
      componentId: contract.runtime.componentId,
      kind: contract.runtime.kind,
      version: contract.runtime.version,
      platform: policy.platform,
      arch: policy.arch,
      runtimeAbi: contract.runtime.runtimeAbi,
      source: {
        id: policy.source.id,
        revision: policy.source.revision,
        file: policy.source.file,
        size: policy.source.sizeBytes,
        sha256: policy.source.sha256,
      },
      artifact: {
        file: basename(artifactPath),
        size: statSync(artifactPath).size,
        sha256: await sha256File(artifactPath),
      },
      recipeSha256: digest(
        Buffer.from(
          JSON.stringify({
            policy,
            tool: digest(readFileSync(import.meta.filename)),
            zipTool: digest(readFileSync(new URL("./component-curate-windows.mjs", import.meta.url))),
            node: process.versions.node,
            zlib: process.versions.zlib,
          }),
        ),
      ),
      licenses: policy.licenses.map(({ spdxId, noticeSha256 }) => ({ spdxId, noticeSha256 })),
      memberCount: policy.extractEntries.length,
      codeMemberCount: policy.codeEntries.length,
      signing: {
        provider: "apple-developer-id",
        teamId: credentials.teamId,
        allCodeSigned: true,
        timestamped: true,
        hardenedRuntime: true,
        noEntitlementExceptions: true,
      },
      members: await Promise.all(
        policy.codeEntries.map(async (file) => ({ file, sha256: await sha256File(join(staging, file)) })),
      ),
      notarization: { status: "pending" },
      releaseEligible: false,
      createdAt: new Date().toISOString(),
    };
    writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    return record;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    if (process.platform !== "darwin") throw Error("Mac runtime curation requires macOS");
    const args = process.argv.slice(2);
    if (args.length !== 6 || args[0] !== "--source" || args[2] !== "--artifact" || args[4] !== "--record")
      throw Error("usage: component-curate-macos --source PATH --artifact PATH --record PATH");
    await curateMacRuntime({
      sourcePath: resolve(args[1]),
      artifactPath: resolve(args[3]),
      recordPath: resolve(args[5]),
    });
    console.log("Signed Mac runtime candidate verified. Notarization pending; publication is blocked.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
