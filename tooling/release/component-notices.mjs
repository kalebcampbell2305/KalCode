#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { loadComponentContract } from "./component-contract.mjs";

export const COMPONENT_NOTICE_DIRECTORY = join(import.meta.dirname, "..", "..", "third_party", "kalvoice-notices");
const CONTRACT_PATH = join(import.meta.dirname, "components", "kalvoice-local-reasoning-v1.json");
const MANIFEST_FILE = "manifest.json";
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_NOTICE_BYTES = 256 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${label} has an invalid field set`);
  }
}

function samePath(left, right) {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function canonicalDirectory(path, label) {
  if (typeof path !== "string" || !isAbsolute(path)) throw new Error(`${label} must be absolute`);
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || !samePath(realpathSync(path), path)) {
    throw new Error(`${label} must be a canonical directory`);
  }
  return resolve(path);
}

function boundedRegularFile(path, label, maximum) {
  const metadata = lstatSync(path);
  if (metadata.nlink !== 1) throw new Error(`${label} must not be a hard link`);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size < 1 ||
    metadata.size > maximum ||
    !samePath(realpathSync(path), path)
  ) {
    throw new Error(`${label} must be a bounded canonical regular file`);
  }
  return readFileSync(path);
}

function expectedManifest(contract) {
  const runtime = contract.runtime.windowsX86_64;
  const speechIds = contract.speechModels.components.map(({ componentId }) => componentId);
  return {
    schemaVersion: 1,
    notices: [
      {
        noticeId: "llama-cpp-mit",
        file: "llama.cpp-MIT.txt",
        spdxId: runtime.licenses[0].spdxId,
        sha256: runtime.licenses[0].noticeSha256,
        source: {
          type: "https",
          url: runtime.licenses[0].noticeUrl,
          revision: runtime.source.revision,
          archiveSha256: null,
          member: null,
        },
        componentIds: [contract.runtime.componentId],
      },
      {
        noticeId: "llvm-openmp-apache-2.0-with-llvm-exception",
        file: "llvm-openmp-Apache-2.0-WITH-LLVM-exception.txt",
        spdxId: runtime.licenses[1].spdxId,
        sha256: runtime.licenses[1].noticeSha256,
        source: {
          type: "archive-member",
          url: runtime.source.url,
          revision: runtime.source.revision,
          archiveSha256: runtime.source.sha256,
          member: "LICENSE-LLVM-OpenMP",
        },
        componentIds: [contract.runtime.componentId],
      },
      {
        noticeId: "openai-whisper-model-weights-mit",
        file: "openai-whisper-model-weights-MIT.txt",
        spdxId: contract.speechModels.license.spdxId,
        sha256: contract.speechModels.license.noticeSha256,
        source: {
          type: "https",
          url: contract.speechModels.license.noticeUrl,
          revision: "86098128c0b4f24f0e2aa2994de830614b474227",
          archiveSha256: null,
          member: null,
        },
        componentIds: speechIds,
      },
      {
        noticeId: "qwen3.5-0.8b-apache-2.0",
        file: "qwen3.5-0.8b-Apache-2.0.txt",
        spdxId: contract.reasoningModel.licenses[0].spdxId,
        sha256: contract.reasoningModel.licenses[0].noticeSha256,
        source: {
          type: "https",
          url: contract.reasoningModel.licenses[0].noticeUrl,
          revision: "2fc06364715b967f1860aea9cf38778875588b17",
          archiveSha256: null,
          member: null,
        },
        componentIds: [contract.reasoningModel.componentId],
      },
    ],
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalJson(value[key])]),
    );
  }
  return value;
}

function sameJson(left, right) {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

function validateManifest(value, contract) {
  exactKeys(value, ["schemaVersion", "notices"], "component notice manifest");
  if (value.schemaVersion !== 1 || !Array.isArray(value.notices) || value.notices.length !== 4) {
    throw new Error("component notice manifest is invalid");
  }
  const noticeIds = new Set();
  const files = new Set();
  for (const [index, notice] of value.notices.entries()) {
    exactKeys(notice, ["noticeId", "file", "spdxId", "sha256", "source", "componentIds"], `notice ${index}`);
    exactKeys(notice.source, ["type", "url", "revision", "archiveSha256", "member"], `notice ${index} source`);
    if (
      typeof notice.noticeId !== "string" ||
      !SAFE_ID.test(notice.noticeId) ||
      noticeIds.has(notice.noticeId) ||
      typeof notice.file !== "string" ||
      !SAFE_FILE.test(notice.file) ||
      notice.file.includes("..") ||
      files.has(notice.file) ||
      typeof notice.spdxId !== "string" ||
      notice.spdxId.length > 64 ||
      !SHA256.test(notice.sha256 ?? "") ||
      !Array.isArray(notice.componentIds) ||
      notice.componentIds.length < 1 ||
      new Set(notice.componentIds).size !== notice.componentIds.length
    ) {
      throw new Error("component notice manifest is invalid");
    }
    noticeIds.add(notice.noticeId);
    files.add(notice.file);
  }
  if (!sameJson(value, expectedManifest(contract))) {
    throw new Error("component notice manifest does not match the pinned component contract");
  }
  return value;
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function verifyComponentNotices({
  noticeDirectory = COMPONENT_NOTICE_DIRECTORY,
  contract = loadComponentContract(CONTRACT_PATH),
} = {}) {
  const root = canonicalDirectory(noticeDirectory, "component notice directory");
  const manifestBytes = boundedRegularFile(join(root, MANIFEST_FILE), "component notice manifest", MAX_MANIFEST_BYTES);
  let manifest;
  try {
    manifest = validateManifest(JSON.parse(manifestBytes.toString("utf8")), contract);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("component notice manifest is invalid JSON");
    throw error;
  }
  const expectedFiles = [MANIFEST_FILE, ...manifest.notices.map(({ file }) => file)].sort();
  const actualFiles = readdirSync(root, { withFileTypes: true })
    .map((entry) => {
      if (!entry.isFile() || entry.isSymbolicLink())
        throw new Error("component notice directory contains an unsafe entry");
      return entry.name;
    })
    .sort();
  if (!sameJson(actualFiles, expectedFiles)) throw new Error("component notice directory has an invalid file set");
  for (const notice of manifest.notices) {
    const bytes = boundedRegularFile(join(root, notice.file), `component notice ${notice.noticeId}`, MAX_NOTICE_BYTES);
    if (digest(bytes) !== notice.sha256) throw new Error(`component notice digest differs: ${notice.noticeId}`);
  }
  const componentIds = new Set(manifest.notices.flatMap(({ componentIds }) => componentIds));
  return {
    schemaVersion: 1,
    noticeCount: manifest.notices.length,
    componentCount: componentIds.size,
    files: manifest.notices.map(({ file }) => file).sort(),
  };
}

export async function stageComponentNotices({ destination, noticeDirectory = COMPONENT_NOTICE_DIRECTORY } = {}) {
  const source = canonicalDirectory(noticeDirectory, "component notice directory");
  const evidence = await verifyComponentNotices({ noticeDirectory: source });
  if (typeof destination !== "string" || !isAbsolute(destination)) {
    throw new Error("component notice destination must be absolute");
  }
  if (existsSync(destination)) throw new Error("component notice destination already exists");
  canonicalDirectory(dirname(destination), "component notice destination parent");
  const target = resolve(destination);
  const insideSource = relative(source, target);
  if (insideSource === "" || (!insideSource.startsWith("..") && !isAbsolute(insideSource))) {
    throw new Error("component notice destination must be outside the source corpus");
  }
  mkdirSync(target, { mode: 0o700 });
  for (const file of [MANIFEST_FILE, ...evidence.files]) {
    copyFileSync(join(source, file), join(target, file), constants.COPYFILE_EXCL);
  }
  return verifyComponentNotices({ noticeDirectory: target });
}

function parseArgs(args) {
  if (args.length === 1 && args[0] === "--verify") return { mode: "verify" };
  if (args.length === 2 && args[0] === "--stage" && isAbsolute(args[1])) {
    return { mode: "stage", destination: args[1] };
  }
  throw new Error("usage: component-notices (--verify|--stage ABSOLUTE_PATH)");
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const evidence =
      options.mode === "verify"
        ? await verifyComponentNotices()
        : await stageComponentNotices({ destination: options.destination });
    console.log(
      `Verified ${evidence.noticeCount} KalVoice notice files covering ${evidence.componentCount} components.`,
    );
  } catch (error) {
    console.error(`component notice verification failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
