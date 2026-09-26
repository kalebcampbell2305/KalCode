#!/usr/bin/env node
// Curates the exact pinned llama.cpp Windows runtime closure. It never downloads or publishes.
// Every retained PE must begin unsigned, receive the existing KalCode Azure Artifact Signing
// identity, and verify as timestamped before one deterministic consumer ZIP is committed.
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { deflateRawSync } from "node:zlib";

import { loadComponentContract, validateComponentContract } from "./component-contract.mjs";
import { powershellJson, psQuote, sha256File } from "./lib.mjs";
import {
  artifactSigningIdentityMatchesPinned,
  authenticodeIdentityOids,
  authenticodeStatus,
  signTarget,
} from "./signing.mjs";

const CONTRACT_PATH = join(import.meta.dirname, "components", "kalvoice-local-reasoning-v1.json");
const MAX_ENTRY_BYTES = 512 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const FIXED_DOS_DATE = 0x21; // 1980-01-01
const ZIP_UTF8 = 0x0800;
const ZIP_DEFLATE = 8;
const CRC_TABLE = buildCrcTable();

function buildCrcTable() {
  const values = new Uint32Array(256);
  for (let index = 0; index < values.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    values[index] = value >>> 0;
  }
  return values;
}

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function safeFlatFile(name) {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= 160 &&
    !name.includes("..") &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)
  );
}

function samePath(left, right) {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function fileIdentity(path) {
  if (!existsSync(path)) return null;
  const metadata = statSync(path, { bigint: true });
  return `${metadata.dev}:${metadata.ino}`;
}

function distinct(paths) {
  for (let left = 0; left < paths.length; left += 1) {
    for (let right = left + 1; right < paths.length; right += 1) {
      const leftIdentity = fileIdentity(paths[left]);
      const rightIdentity = fileIdentity(paths[right]);
      if (
        samePath(paths[left], paths[right]) ||
        (leftIdentity !== null && rightIdentity !== null && leftIdentity === rightIdentity)
      ) {
        throw new Error("component curation paths must be distinct");
      }
    }
  }
}

function safeSource(path) {
  if (!isAbsolute(path)) throw new Error("component source path must be absolute");
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("component source must be a regular file");
  return path;
}

function safeNewOutput(path, label) {
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute`);
  if (existsSync(path)) throw new Error(`${label} already exists`);
  const parent = dirname(path);
  const metadata = lstatSync(parent);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || !samePath(realpathSync(parent), resolve(parent))) {
    throw new Error(`${label} parent directory is unsafe`);
  }
  return path;
}

function safeMetadata(path) {
  if (!isAbsolute(path)) throw new Error("Artifact Signing metadata path must be absolute");
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Artifact Signing metadata must be a regular file");
  }
  return path;
}

function normalizeInventoryEntry(entry) {
  if (
    entry === null ||
    typeof entry !== "object" ||
    Array.isArray(entry) ||
    !safeFlatFile(entry.name) ||
    !Number.isSafeInteger(entry.size) ||
    entry.size < 0 ||
    entry.size > MAX_ENTRY_BYTES ||
    !Number.isSafeInteger(entry.compressedSize) ||
    entry.compressedSize < 0 ||
    entry.compressedSize > MAX_ENTRY_BYTES ||
    entry.directory === true
  ) {
    throw new Error("Windows component source inventory is unsafe");
  }
  return { name: entry.name, size: entry.size, compressedSize: entry.compressedSize, directory: false };
}

export function validateWindowsSourceInventory(entries, policy) {
  if (!Array.isArray(entries) || entries.length !== policy.sourceEntries.length) {
    throw new Error("Windows component source inventory does not match the pinned release");
  }
  const normalized = entries.map(normalizeInventoryEntry);
  const folded = normalized.map((entry) => entry.name.toLowerCase());
  if (new Set(folded).size !== folded.length)
    throw new Error("Windows component source inventory has a case collision");
  if (JSON.stringify(normalized.map((entry) => entry.name)) !== JSON.stringify(policy.sourceEntries)) {
    throw new Error("Windows component source inventory does not match the pinned release");
  }
  return normalized;
}

export function readWindowsZipInventory(sourcePath) {
  const result = powershellJson(
    "Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem; " +
      `$archive = [System.IO.Compression.ZipFile]::OpenRead(${psQuote(sourcePath)}); ` +
      "try { @($archive.Entries | ForEach-Object { [pscustomobject]@{ name = [string]$_.FullName; size = [long]$_.Length; compressedSize = [long]$_.CompressedLength; directory = [string]$_.FullName -match '/$' } }) | ConvertTo-Json -Compress } finally { $archive.Dispose() }",
  );
  return result === null ? [] : Array.isArray(result) ? result : [result];
}

function extractWindowsZip(sourcePath, destination, names) {
  const encodedNames = Buffer.from(JSON.stringify(names), "utf8").toString("base64");
  powershellJson(
    "Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem; " +
      `$names = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedNames}'))); ` +
      `$archive = [System.IO.Compression.ZipFile]::OpenRead(${psQuote(sourcePath)}); ` +
      `try { foreach ($name in @($names)) { $entry = @($archive.Entries | Where-Object { $_.FullName -ceq $name }); if ($entry.Count -ne 1) { throw 'entry mismatch' }; $out = Join-Path ${psQuote(destination)} $name; $input = $entry[0].Open(); $output = [IO.File]::Open($out, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None); try { $input.CopyTo($output); $output.Flush() } finally { $output.Dispose(); $input.Dispose() } }; [pscustomobject]@{ extracted = @($names).Count } | ConvertTo-Json -Compress } finally { $archive.Dispose() }`,
  );
}

async function defaultWithExtractedEntries(sourcePath, names, callback) {
  const staging = mkdtempSync(join(dirname(sourcePath), ".kalcode-component-curate-"));
  try {
    extractWindowsZip(sourcePath, staging, names);
    return await callback(staging, names, (name) => join(staging, name));
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function u16(value) {
  const bytes = Buffer.allocUnsafe(2);
  bytes.writeUInt16LE(value, 0);
  return bytes;
}

function u32(value) {
  const bytes = Buffer.allocUnsafe(4);
  bytes.writeUInt32LE(value >>> 0, 0);
  return bytes;
}

export function writeDeterministicZip(directory, names, outputPath) {
  if (existsSync(outputPath)) throw new Error("curated component ZIP already exists");
  const sorted = [...names].sort((left, right) => left.localeCompare(right, "en"));
  if (new Set(sorted).size !== sorted.length || sorted.some((name) => !safeFlatFile(name))) {
    throw new Error("curated component ZIP inventory is invalid");
  }
  const local = [];
  const central = [];
  let offset = 0;
  for (const name of sorted) {
    const source = join(directory, name);
    const metadata = lstatSync(source);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_ENTRY_BYTES) {
      throw new Error("curated component member is unsafe");
    }
    const data = readFileSync(source);
    const compressed = deflateRawSync(data, { level: 9 });
    const fileName = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const localHeader = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(ZIP_UTF8),
      u16(ZIP_DEFLATE),
      u16(0),
      u16(FIXED_DOS_DATE),
      u32(crc),
      u32(compressed.length),
      u32(data.length),
      u16(fileName.length),
      u16(0),
      fileName,
    ]);
    local.push(localHeader, compressed);
    central.push(
      Buffer.concat([
        u32(0x02014b50),
        u16((3 << 8) | 20),
        u16(20),
        u16(ZIP_UTF8),
        u16(ZIP_DEFLATE),
        u16(0),
        u16(FIXED_DOS_DATE),
        u32(crc),
        u32(compressed.length),
        u32(data.length),
        u16(fileName.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0o100644 << 16),
        u32(offset),
        fileName,
      ]),
    );
    offset += localHeader.length + compressed.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(sorted.length),
    u16(sorted.length),
    u32(centralBytes.length),
    u32(offset),
    u16(0),
  ]);
  const bytes = Buffer.concat([...local, centralBytes, end]);
  if (bytes.length > MAX_ARCHIVE_BYTES) throw new Error("curated component ZIP exceeds its safety limit");
  const descriptor = openSync(outputPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    writeFileSync(descriptor, bytes);
  } finally {
    closeSync(descriptor);
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function recipeSha256(contract) {
  const recipe = canonicalize({
    schemaVersion: 1,
    tool: "kalcode-component-curate-windows.v1",
    toolSha256: createHash("sha256")
      .update(readFileSync(import.meta.filename))
      .digest("hex"),
    nodeVersion: process.versions.node,
    zlibVersion: process.versions.zlib,
    runtime: contract.runtime,
  });
  return createHash("sha256").update(JSON.stringify(recipe)).digest("hex");
}

function writeJsonNew(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

export async function curateWindowsRuntime(
  { sourcePath, artifactPath, recordPath, metadataPath },
  {
    contract: rawContract = loadComponentContract(CONTRACT_PATH),
    hashFile = sha256File,
    fileSize = (path) => statSync(path).size,
    readZipInventory = readWindowsZipInventory,
    withExtractedEntries = defaultWithExtractedEntries,
    authenticodeStatus: status = authenticodeStatus,
    authenticodeIdentityOids: identityOids = authenticodeIdentityOids,
    artifactSigningIdentityMatchesPinned: identityMatches = artifactSigningIdentityMatchesPinned,
    signTarget: sign = signTarget,
    writeZip = writeDeterministicZip,
    now = () => new Date(),
  } = {},
) {
  const contract = validateComponentContract(rawContract);
  const policy = contract.runtime.windowsX86_64;
  if (
    [sourcePath, artifactPath, recordPath, metadataPath].some((path) => typeof path !== "string" || !isAbsolute(path))
  ) {
    throw new Error("component curation paths must be absolute");
  }
  distinct([sourcePath, artifactPath, recordPath, metadataPath]);
  safeSource(sourcePath);
  safeMetadata(metadataPath);
  // Fail on unsafe or pre-existing outputs before the first external signing effect.
  safeNewOutput(artifactPath, "curated component artifact");
  safeNewOutput(recordPath, "curated component record");
  if (fileSize(sourcePath) !== policy.source.sizeBytes || (await hashFile(sourcePath)) !== policy.source.sha256) {
    throw new Error("Windows component source integrity does not match the pinned release");
  }
  validateWindowsSourceInventory(readZipInventory(sourcePath), policy);

  return withExtractedEntries(sourcePath, policy.extractEntries, async (_directory, names, pathFor) => {
    const codePaths = policy.codeEntries.map(pathFor);
    // Validate the complete unsigned closure before the first external signing effect.
    for (const path of codePaths) {
      const evidence = status(path, powershellJson);
      if (evidence.status !== "NotSigned" || evidence.timestamped) {
        throw new Error("Windows component curation requires the exact unsigned upstream PE closure");
      }
    }
    for (const path of codePaths) {
      sign({ targetPath: path, metadataPath });
      const evidence = status(path, powershellJson);
      if (
        evidence.status !== "Valid" ||
        evidence.timestamped !== true ||
        !identityMatches(identityOids(path, powershellJson))
      ) {
        throw new Error("Windows component member did not verify with the approved timestamped publisher identity");
      }
    }
    writeZip(_directory, names, artifactPath);
    const artifactSize = fileSize(artifactPath);
    const artifactSha256 = await hashFile(artifactPath);
    if (!Number.isSafeInteger(artifactSize) || artifactSize <= 0 || !/^[0-9a-f]{64}$/.test(artifactSha256)) {
      throw new Error("curated component artifact evidence is invalid");
    }
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
      artifact: { file: basename(artifactPath), size: artifactSize, sha256: artifactSha256 },
      recipeSha256: recipeSha256(contract),
      licenses: policy.licenses.map(({ spdxId, noticeSha256 }) => ({ spdxId, noticeSha256 })),
      memberCount: policy.extractEntries.length,
      codeMemberCount: policy.codeEntries.length,
      signing: {
        provider: "azure-artifact-signing",
        allCodeSigned: true,
        timestamped: true,
        publisherIdentityBound: true,
      },
      createdAt: now().toISOString(),
    };
    writeJsonNew(recordPath, record);
    return record;
  });
}

function option(args, name) {
  const indexes = args.map((value, index) => (value === name ? index : -1)).filter((index) => index >= 0);
  if (indexes.length !== 1 || !args[indexes[0] + 1] || args[indexes[0] + 1].startsWith("--")) {
    throw new Error(`${name} must be specified exactly once`);
  }
  return args[indexes[0] + 1];
}

function cliOptions(args) {
  const allowed = new Set(["--source", "--artifact", "--record", "--metadata"]);
  if (args.length !== 8 || args.some((value, index) => index % 2 === 0 && !allowed.has(value))) {
    throw new Error("usage: component-curate-windows --source PATH --artifact PATH --record PATH --metadata PATH");
  }
  return {
    sourcePath: option(args, "--source"),
    artifactPath: option(args, "--artifact"),
    recordPath: option(args, "--record"),
    metadataPath: option(args, "--metadata"),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    if (process.platform !== "win32") throw new Error("Windows component curation must run on Windows");
    await curateWindowsRuntime(cliOptions(process.argv.slice(2)));
    console.log("Curated and verified the pinned Windows KalVoice runtime. No artifact was published.");
  } catch (error) {
    console.error(`component curation failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
