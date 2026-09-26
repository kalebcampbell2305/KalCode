#!/usr/bin/env node
import { spawnSync } from "node:child_process";
// Publishes one already-signed local-component catalog through the existing KalCode D1/R2
// authority. This module never signs, downloads from upstream, or reads a private key.
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { loadComponentContract } from "./component-contract.mjs";
import { validateMacRuntimePublicationEvidence } from "./component-curate-macos.mjs";
import {
  buildComponentArtifactClaimStatement,
  buildComponentArtifactsReadStatement,
  buildComponentPointerAdvanceStatement,
  buildComponentPointerReadStatement,
  buildComponentPublishPlan,
  buildComponentVersionClaimStatement,
  buildComponentVersionReadStatement,
  componentArtifactRowsProblems,
  componentPublicationExactProblems,
  componentPublicationRowProblems,
  parseVerifiedComponentCatalog,
} from "./component-publish-plan.mjs";
import {
  assertExistingRegularFile,
  parseComponentPublicKey,
  verifyComponentCatalog,
  verifyComponentManifest,
} from "./component-signing.mjs";
import { assertCleanTree, R2_BUCKET, sha256File, WEBSITE_DIR } from "./lib.mjs";
import { parseD1Rows } from "./publication-safety.mjs";
import { isMissingR2Object } from "./publish-plan.mjs";
import { releaseProcessOptions } from "./signing.mjs";

const D1_DATABASE = "kalcode-web";
const CONTRACT_PATH = join(import.meta.dirname, "components", "kalvoice-local-reasoning-v1.json");
export const COMPONENT_PUBLIC_KEY_PATH = join(import.meta.dirname, "component-public-key.json");
const wranglerBin = join(WEBSITE_DIR, "node_modules", "wrangler", "bin", "wrangler.js");
const MAX_PACKET_BYTES = 64 * 1024;
const MAX_PUBLIC_KEY_BYTES = 4 * 1024;
const MAX_CATALOG_BYTES = 192 * 1024;
const PUBLIC_SAMPLE_BYTES = 64 * 1024;
const PUBLIC_REQUEST_TIMEOUT_MS = 15_000;
const SHA256 = /^[0-9a-f]{64}$/;

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${label} has an invalid field set`);
  }
}

function canonicalFile(path, label) {
  if (typeof path !== "string" || !isAbsolute(path)) throw new Error(`${label} must be absolute`);
  assertExistingRegularFile(path, label);
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || resolve(realpathSync(path)) !== resolve(path)) {
    throw new Error(`${label} must not traverse a link`);
  }
  return path;
}

function samePath(left, right) {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function readBoundedFile(path, label, minimum, maximum) {
  canonicalFile(path, label);
  const descriptor = openSync(path, "r");
  try {
    const metadata = fstatSync(descriptor);
    if (
      !metadata.isFile() ||
      !Number.isSafeInteger(metadata.size) ||
      metadata.size < minimum ||
      metadata.size > maximum
    ) {
      throw new Error(`${label} has an invalid size`);
    }
    const bytes = Buffer.alloc(metadata.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    const extra = Buffer.alloc(1);
    if (offset !== bytes.length || readSync(descriptor, extra, 0, 1, offset) !== 0) {
      throw new Error(`${label} changed while it was being read`);
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function readSmallJson(path, label, maximum = MAX_PACKET_BYTES) {
  const text = readBoundedFile(path, label, 2, maximum).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function exactLicenseSet(actual, expected, label) {
  const selected = expected.map(({ spdxId, noticeSha256 }) => ({ spdxId, noticeSha256 }));
  if (!sameJson(actual, selected)) throw new Error(`${label} does not match the approved component contract`);
}

function assertProvenance(artifact, expectedSource, label) {
  if (
    artifact.provenance.sourceId !== expectedSource.id ||
    artifact.provenance.sourceRevision !== expectedSource.revision ||
    artifact.provenance.sourceIntegritySha256 !== expectedSource.sha256
  ) {
    throw new Error(`${label} provenance does not match the approved component contract`);
  }
}

function validateWindowsRuntimeEvidence(record, artifact, catalog, contract) {
  exactKeys(
    record,
    [
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
      "createdAt",
    ],
    "Windows runtime curation evidence",
  );
  const policy = contract.runtime.windowsX86_64;
  exactKeys(record.source, ["id", "revision", "file", "size", "sha256"], "Windows runtime source evidence");
  exactKeys(record.artifact, ["file", "size", "sha256"], "Windows runtime artifact evidence");
  exactKeys(
    record.signing,
    ["provider", "allCodeSigned", "timestamped", "publisherIdentityBound"],
    "Windows runtime signing evidence",
  );
  const createdAt = new Date(record.createdAt);
  if (
    record.schemaVersion !== 1 ||
    record.componentId !== artifact.componentId ||
    record.kind !== artifact.kind ||
    record.version !== artifact.version ||
    record.platform !== catalog.platform ||
    record.arch !== catalog.arch ||
    record.runtimeAbi !== artifact.runtimeAbi ||
    !sameJson(record.source, {
      id: policy.source.id,
      revision: policy.source.revision,
      file: policy.source.file,
      size: policy.source.sizeBytes,
      sha256: policy.source.sha256,
    }) ||
    !sameJson(record.artifact, {
      file: artifact.file,
      size: artifact.sizeBytes,
      sha256: artifact.sha256,
    }) ||
    record.recipeSha256 !== artifact.provenance.buildRecipeSha256 ||
    !SHA256.test(record.recipeSha256 ?? "") ||
    record.memberCount !== policy.extractEntries.length ||
    record.codeMemberCount !== policy.codeEntries.length ||
    !sameJson(record.signing, {
      provider: "azure-artifact-signing",
      allCodeSigned: true,
      timestamped: true,
      publisherIdentityBound: true,
    }) ||
    Number.isNaN(createdAt.valueOf()) ||
    createdAt.toISOString() !== record.createdAt ||
    Math.floor(createdAt.valueOf() / 1000) > catalog.issuedAt
  ) {
    throw new Error("Windows runtime curation evidence does not match the signed component");
  }
  exactLicenseSet(record.licenses, policy.licenses, "Windows runtime curation licenses");
  exactLicenseSet(artifact.licenses, policy.licenses, "Windows runtime manifest licenses");
  assertProvenance(artifact, policy.source, "Windows runtime");
}

function validateArtifactPolicy(artifact, entry, catalog, contract) {
  if (artifact.role === "reason-runtime") {
    if (catalog.platform === "macos" && catalog.arch === "aarch64") {
      if (typeof entry.evidencePath !== "string") throw Error("Mac runtime curation evidence is required");
      validateMacRuntimePublicationEvidence(
        readSmallJson(entry.evidencePath, "Mac runtime curation evidence"),
        artifact,
        catalog,
        contract,
      );
      return;
    }
    if (catalog.platform !== "windows" || catalog.arch !== "x86_64") {
      throw new Error("this release packet has no approved runtime curation policy for the target");
    }
    if (typeof entry.evidencePath !== "string") throw new Error("Windows runtime curation evidence is required");
    validateWindowsRuntimeEvidence(
      readSmallJson(entry.evidencePath, "Windows runtime curation evidence"),
      artifact,
      catalog,
      contract,
    );
    return;
  }
  if (entry.evidencePath !== null) throw new Error("data component entries must not claim runtime curation evidence");
  if (artifact.role === "reason-model") {
    const policy = contract.reasoningModel;
    if (
      artifact.componentId !== policy.componentId ||
      artifact.version !== policy.version ||
      artifact.file !== policy.artifactFile ||
      artifact.sizeBytes !== policy.source.sizeBytes ||
      artifact.sha256 !== policy.source.sha256
    ) {
      throw new Error("reasoning model does not match the approved component contract");
    }
    exactLicenseSet(artifact.licenses, policy.licenses, "reasoning model licenses");
    assertProvenance(artifact, policy.source, "reasoning model");
    return;
  }
  const policy = contract.speechModels.components.find((candidate) => candidate.componentId === artifact.componentId);
  if (
    !policy ||
    artifact.file !== policy.file ||
    artifact.sizeBytes !== policy.sizeBytes ||
    artifact.sha256 !== policy.sha256 ||
    artifact.provenance.sourceId !== contract.speechModels.sourceId ||
    artifact.provenance.sourceRevision !== contract.speechModels.sourceRevision ||
    artifact.provenance.sourceIntegritySha256 !== policy.sha256
  ) {
    throw new Error("speech model does not match the approved component contract");
  }
  exactLicenseSet(artifact.licenses, [contract.speechModels.license], "speech model licenses");
}

function validateCatalogPolicy(catalog, contract) {
  const expectedSpeechIds = contract.speechModels.components.map(({ componentId }) => componentId);
  const actualSpeechIds = catalog.artifacts
    .filter(({ role }) => role === "speech-model")
    .map(({ componentId }) => componentId);
  if (
    actualSpeechIds.length !== expectedSpeechIds.length ||
    expectedSpeechIds.some((componentId) => !actualSpeechIds.includes(componentId))
  ) {
    throw new Error("component catalog does not contain the complete approved speech model set");
  }
  if (catalog.defaultSpeechComponentId !== contract.speechModels.defaultComponentId) {
    throw new Error("component catalog default speech model does not match the approved component contract");
  }
}

function packetEntries(packet) {
  exactKeys(packet, ["schemaVersion", "catalogPath", "publicKeyPath", "artifacts"], "component publication packet");
  if (packet.schemaVersion !== 1 || !Array.isArray(packet.artifacts)) {
    throw new Error("component publication packet is invalid");
  }
  canonicalFile(packet.catalogPath, "component catalog token");
  canonicalFile(packet.publicKeyPath, "component public key");
  const ids = new Set();
  return packet.artifacts.map((entry, index) => {
    exactKeys(entry, ["componentId", "path", "evidencePath"], `component publication entry ${index}`);
    if (typeof entry.componentId !== "string" || ids.has(entry.componentId)) {
      throw new Error("component publication entry IDs must be unique");
    }
    ids.add(entry.componentId);
    canonicalFile(entry.path, `component artifact ${entry.componentId}`);
    if (entry.evidencePath !== null) canonicalFile(entry.evidencePath, `component evidence ${entry.componentId}`);
    return entry;
  });
}

function writeNestedToken(directory, index, token) {
  const path = join(directory, `component-${index}.jws`);
  writeFileSync(path, token, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return path;
}

function canonicalSignerToken(text, label) {
  if (!text.endsWith("\n") || text.endsWith("\n\n") || text.includes("\r")) {
    throw new Error(`${label} is not the canonical signer output`);
  }
  const token = text.slice(0, -1);
  if (!token || token.trim() !== token || token.includes("\n")) {
    throw new Error(`${label} is not the canonical signer output`);
  }
  return token;
}

export async function prepareComponentPublication(
  packetPath,
  {
    verifyCatalog = verifyComponentCatalog,
    verifyManifest = verifyComponentManifest,
    hashFile = sha256File,
    contract = loadComponentContract(CONTRACT_PATH),
    trustedPublicKeyPath = COMPONENT_PUBLIC_KEY_PATH,
  } = {},
) {
  const packet = readSmallJson(packetPath, "component publication packet");
  const entries = packetEntries(packet);
  canonicalFile(trustedPublicKeyPath, "tracked component public key");
  if (!samePath(packet.publicKeyPath, trustedPublicKeyPath)) {
    throw new Error("component publication packet does not use the tracked component public key");
  }
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "kalcode-component-publication-"));
  try {
    const publicKeyText = readBoundedFile(
      packet.publicKeyPath,
      "component public key",
      2,
      MAX_PUBLIC_KEY_BYTES,
    ).toString("utf8");
    const catalogBytes = readBoundedFile(packet.catalogPath, "component catalog token", 2, MAX_CATALOG_BYTES + 1);
    const signerCatalogText = catalogBytes.toString("utf8");
    const catalogToken = canonicalSignerToken(signerCatalogText, "component catalog token");
    const publicKeyPath = join(temporaryDirectory, "public-key.json");
    const signerCatalogPath = join(temporaryDirectory, "catalog-signer-output.jws");
    const catalogPath = join(temporaryDirectory, "catalog.jws");
    writeFileSync(publicKeyPath, publicKeyText, { encoding: "utf8", flag: "wx", mode: 0o600 });
    writeFileSync(signerCatalogPath, signerCatalogText, { encoding: "utf8", flag: "wx", mode: 0o600 });
    writeFileSync(catalogPath, catalogToken, { encoding: "utf8", flag: "wx", mode: 0o600 });
    const publicKey = parseComponentPublicKey(publicKeyText);
    if (Buffer.byteLength(catalogToken) > MAX_CATALOG_BYTES) throw new Error("component catalog token is too large");
    verifyCatalog({ publicKeyPath, tokenPath: signerCatalogPath });
    const catalog = parseVerifiedComponentCatalog(catalogToken);
    if (catalog.keyId !== publicKey.kid)
      throw new Error("component catalog key does not match the supplied public key");
    validateCatalogPolicy(catalog, contract);
    if (entries.length !== catalog.artifacts.length)
      throw new Error("component publication artifact set is incomplete");
    const supplied = new Map(entries.map((entry) => [entry.componentId, entry]));
    const verifiedArtifacts = [];
    for (const [index, artifact] of catalog.artifacts.entries()) {
      const entry = supplied.get(artifact.componentId);
      if (!entry) throw new Error(`component publication artifact is missing: ${artifact.componentId}`);
      const artifactDirectory = join(temporaryDirectory, `artifact-${index}`);
      mkdirSync(artifactDirectory, { mode: 0o700 });
      const artifactPath = join(artifactDirectory, artifact.file);
      copyFileSync(entry.path, artifactPath, constants.COPYFILE_EXCL);
      const metadata = statSync(artifactPath);
      if (metadata.size !== artifact.sizeBytes || (await hashFile(artifactPath)) !== artifact.sha256) {
        throw new Error(`component artifact does not match its signed manifest: ${artifact.componentId}`);
      }
      const tokenPath = writeNestedToken(temporaryDirectory, index, artifact.token);
      verifyManifest({ publicKeyPath, tokenPath, artifactPath });
      validateArtifactPolicy(artifact, entry, catalog, contract);
      chmodSync(artifactPath, 0o400);
      verifiedArtifacts.push({ ...artifact, path: artifactPath });
    }
    const catalogSha256 = await hashFile(catalogPath);
    return {
      packetPath,
      temporaryDirectory,
      publicKeyPath,
      catalogPath,
      catalogToken,
      catalog,
      catalogSha256,
      catalogSizeBytes: Buffer.byteLength(catalogToken),
      publishedAt: new Date(catalog.issuedAt * 1000).toISOString(),
      artifacts: verifiedArtifacts,
      uploads: buildComponentPublishPlan({
        bucket: R2_BUCKET,
        catalog,
        catalogPath,
        catalogSha256,
        artifacts: verifiedArtifacts,
      }),
    };
  } catch (error) {
    rmSync(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
}

export function disposeComponentPublication(publication) {
  if (publication?.temporaryDirectory) {
    rmSync(publication.temporaryDirectory, { recursive: true, force: true });
  }
}

function executeD1(statement) {
  const result = spawnSync(
    process.execPath,
    [wranglerBin, "d1", "execute", D1_DATABASE, "--remote", "--json", "--command", statement],
    releaseProcessOptions({ cwd: WEBSITE_DIR, encoding: "utf8", timeout: 30_000, maxBuffer: 256 * 1024 }),
  );
  if (result.status !== 0) throw new Error("authoritative D1 component operation failed");
  return parseD1Rows(result.stdout);
}

function getR2Object(key, destination) {
  const result = spawnSync(
    process.execPath,
    [wranglerBin, "r2", "object", "get", `${R2_BUCKET}/${key}`, "--file", destination, "--remote"],
    releaseProcessOptions({ cwd: WEBSITE_DIR, encoding: "utf8", maxBuffer: 128 * 1024 }),
  );
  if (result.status === 0) return true;
  if (isMissingR2Object(`${result.stdout ?? ""}\n${result.stderr ?? ""}`)) return false;
  throw new Error("component object readback failed");
}

function putR2Object(upload) {
  const result = spawnSync(process.execPath, [wranglerBin, ...upload.argv, "--remote"], {
    ...releaseProcessOptions({ cwd: WEBSITE_DIR, stdio: "inherit" }),
  });
  if (result.status !== 0) throw new Error(`component object upload failed: ${upload.kind}`);
}

function bucketAvailable() {
  const result = spawnSync(process.execPath, [wranglerBin, "r2", "bucket", "list"], {
    ...releaseProcessOptions({ cwd: WEBSITE_DIR, encoding: "utf8", maxBuffer: 128 * 1024 }),
  });
  return result.status === 0 && String(result.stdout).includes(R2_BUCKET);
}

function defaultRemote() {
  return { executeD1, getR2Object, putR2Object, bucketAvailable, fetch: globalThis.fetch };
}

function waitWithSignal(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("public component request timed out"));
  return new Promise((resolvePromise, rejectPromise) => {
    const aborted = () => rejectPromise(signal.reason ?? new Error("public component request timed out"));
    signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        resolvePromise(value);
      },
      (error) => {
        signal.removeEventListener("abort", aborted);
        rejectPromise(error);
      },
    );
  });
}

async function boundedResponseBytes(response, maximum, signal) {
  const declared = Number(response.headers.get("content-length"));
  if (!Number.isSafeInteger(declared) || declared < 0 || declared > maximum) {
    throw new Error("public component response has an invalid length");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("public component response has no body");
  const parts = [];
  let length = 0;
  try {
    for (;;) {
      const part = await waitWithSignal(reader.read(), signal);
      if (part.done) break;
      length += part.value.byteLength;
      if (length > declared || length > maximum) throw new Error("public component response exceeded its bound");
      parts.push(part.value);
    }
  } catch (error) {
    await waitWithSignal(reader.cancel(), AbortSignal.timeout(1_000)).catch(() => undefined);
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Cancellation owns the pending read until the stream acknowledges it.
    }
  }
  if (length !== declared) throw new Error("public component response was incomplete");
  return Buffer.concat(
    parts.map((part) => Buffer.from(part)),
    length,
  );
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function readPrefix(path, length) {
  const bytes = Buffer.alloc(length);
  const descriptor = openSync(path, "r");
  try {
    const read = readSync(descriptor, bytes, 0, length, 0);
    if (read !== length) throw new Error("verified component artifact became incomplete");
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

async function verifyPublicRoutes(publication, fetcher, timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error("public component request timeout is invalid");
  }
  const { catalog, catalogSha256, catalogToken } = publication;
  const catalogUrl = `https://kalcoded.com/components/v1/catalog/${catalog.channel}/${catalog.platform}/${catalog.arch}.jws`;
  const catalogSignal = AbortSignal.timeout(timeoutMs);
  const response = await waitWithSignal(
    fetcher(catalogUrl, { headers: { "cache-control": "no-cache" }, redirect: "error", signal: catalogSignal }),
    catalogSignal,
  );
  if (
    response.status !== 200 ||
    response.headers.get("x-kalcode-component-authority") !== "d1-v1" ||
    response.headers.get("content-type") !== "application/jose"
  ) {
    throw new Error("public component catalog is not backed by the D1 authority");
  }
  const catalogBytes = await boundedResponseBytes(response, MAX_CATALOG_BYTES, catalogSignal);
  if (sha256Bytes(catalogBytes) !== catalogSha256 || catalogBytes.toString("utf8") !== catalogToken) {
    throw new Error("public component catalog readback differs from the signed catalog");
  }
  for (const artifact of publication.artifacts) {
    const length = Math.min(PUBLIC_SAMPLE_BYTES, artifact.sizeBytes);
    const sample = readPrefix(artifact.path, length);
    const artifactSignal = AbortSignal.timeout(timeoutMs);
    const artifactResponse = await waitWithSignal(
      fetcher(`https://kalcoded.com/${artifact.artifactKey}`, {
        headers: { range: `bytes=0-${length - 1}` },
        redirect: "error",
        signal: artifactSignal,
      }),
      artifactSignal,
    );
    if (
      artifactResponse.status !== 206 ||
      artifactResponse.headers.get("x-kalcode-component-authority") !== "d1-v1" ||
      artifactResponse.headers.get("content-range") !== `bytes 0-${length - 1}/${artifact.sizeBytes}` ||
      artifactResponse.headers.get("etag") !== `"${artifact.sha256}"`
    ) {
      throw new Error(`public component range is not authoritative: ${artifact.componentId}`);
    }
    const actual = await boundedResponseBytes(artifactResponse, PUBLIC_SAMPLE_BYTES, artifactSignal);
    if (!actual.equals(sample))
      throw new Error(`public component range differs from the verified artifact: ${artifact.componentId}`);
  }
}

async function verifyReadback(publication, directory, remote, verifyCatalog, verifyManifest, hashFile) {
  const catalogUpload = publication.uploads.find((upload) => upload.kind === "catalog");
  if (!catalogUpload) throw new Error("component catalog upload plan is incomplete");
  const catalogPath = join(directory, "catalog.jws");
  if (
    !remote.getR2Object(catalogUpload.key, catalogPath) ||
    (await hashFile(catalogPath)) !== publication.catalogSha256
  ) {
    throw new Error("component catalog did not read back exactly from R2");
  }
  verifyCatalog({ publicKeyPath: publication.publicKeyPath, tokenPath: catalogPath });
  for (const [index, artifact] of publication.artifacts.entries()) {
    const artifactDirectory = join(directory, `artifact-${index}`);
    mkdirSync(artifactDirectory, { mode: 0o700 });
    const path = join(artifactDirectory, artifact.file);
    try {
      if (!remote.getR2Object(artifact.artifactKey, path))
        throw new Error("component artifact did not read back from R2");
      if (statSync(path).size !== artifact.sizeBytes || (await hashFile(path)) !== artifact.sha256) {
        throw new Error(`component artifact did not read back exactly from R2: ${artifact.componentId}`);
      }
      const tokenPath = writeNestedToken(directory, index, artifact.token);
      verifyManifest({ publicKeyPath: publication.publicKeyPath, tokenPath, artifactPath: path });
    } finally {
      rmSync(path, { force: true });
    }
  }
}

export async function publishPreparedComponents(
  publication,
  {
    remote = defaultRemote(),
    verifyCatalog = verifyComponentCatalog,
    verifyManifest = verifyComponentManifest,
    hashFile = sha256File,
    verifyPublic = true,
    publicRequestTimeoutMs = PUBLIC_REQUEST_TIMEOUT_MS,
  } = {},
) {
  if (!remote.bucketAvailable()) throw new Error(`R2 bucket ${R2_BUCKET} is unavailable`);
  const currentRows = remote.executeD1(buildComponentPointerReadStatement(publication.catalog));
  if (currentRows.length > 1) throw new Error("authoritative component pointer returned multiple rows");
  const prior = currentRows[0] ?? null;
  const priorProblems = componentPublicationRowProblems(prior, publication);
  if (priorProblems.length) throw new Error(priorProblems[0]);

  const probe = mkdtempSync(join(tmpdir(), "kalcode-component-probe-"));
  try {
    for (const [index, upload] of publication.uploads.entries()) {
      const expected =
        upload.kind === "catalog"
          ? publication.catalogSha256
          : publication.artifacts.find((a) => a.artifactKey === upload.key)?.sha256;
      if (!expected) throw new Error("component upload plan has no signed digest");
      const path = join(probe, `object-${index}`);
      try {
        if (remote.getR2Object(upload.key, path)) {
          if ((await hashFile(path)) !== expected)
            throw new Error("content-addressed component object already has different bytes");
        } else {
          remote.putR2Object(upload);
        }
      } finally {
        rmSync(path, { force: true });
      }
    }
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }

  const readback = mkdtempSync(join(tmpdir(), "kalcode-component-readback-"));
  try {
    await verifyReadback(publication, readback, remote, verifyCatalog, verifyManifest, hashFile);
  } finally {
    rmSync(readback, { recursive: true, force: true });
  }

  if (prior?.sequence !== publication.catalog.sequence) {
    try {
      remote.executeD1(buildComponentVersionClaimStatement(publication));
      for (const artifact of publication.catalog.artifacts) {
        remote.executeD1(buildComponentArtifactClaimStatement(publication.catalog, artifact));
      }
    } catch (error) {
      // Another exact publisher may have activated the complete catalog between our initial read
      // and these idempotent claims. Only that exact winner makes the interrupted retry safe.
      const winner = remote.executeD1(buildComponentPointerReadStatement(publication.catalog));
      if (winner.length !== 1 || componentPublicationExactProblems(winner[0], publication).length) throw error;
    }
  }
  const versions = remote.executeD1(buildComponentVersionReadStatement(publication.catalog));
  if (versions.length !== 1 || componentPublicationRowProblems(versions[0], publication).length) {
    throw new Error("immutable component catalog version did not read back exactly");
  }
  const rows = remote.executeD1(buildComponentArtifactsReadStatement(publication.catalog));
  const artifactProblems = componentArtifactRowsProblems(rows, publication.catalog);
  if (artifactProblems.length) throw new Error(artifactProblems[0]);

  if (prior?.sequence !== publication.catalog.sequence) {
    const advanced = remote.executeD1(buildComponentPointerAdvanceStatement(publication.catalog, prior));
    if (advanced.length !== 1) {
      const winner = remote.executeD1(buildComponentPointerReadStatement(publication.catalog));
      if (winner.length !== 1 || componentPublicationExactProblems(winner[0], publication).length) {
        throw new Error("authoritative component pointer compare-and-set was rejected");
      }
    }
  }
  const authoritative = remote.executeD1(buildComponentPointerReadStatement(publication.catalog));
  if (authoritative.length !== 1 || componentPublicationExactProblems(authoritative[0], publication).length) {
    throw new Error("authoritative component pointer did not read back exactly");
  }
  if (verifyPublic) await verifyPublicRoutes(publication, remote.fetch, publicRequestTimeoutMs);
}

export function parseComponentPublishArgs(args) {
  const modeFlags = args.filter((arg) => arg === "--dry-run" || arg === "--remote");
  const packetIndexes = args.flatMap((arg, index) => (arg === "--packet" ? [index] : []));
  if (
    modeFlags.length !== 1 ||
    packetIndexes.length !== 1 ||
    args.length !== 3 ||
    packetIndexes[0] + 1 >= args.length ||
    !isAbsolute(args[packetIndexes[0] + 1])
  ) {
    throw new Error("usage: component-publish --packet ABSOLUTE_PATH (--dry-run|--remote)");
  }
  return { mode: modeFlags[0] === "--remote" ? "remote" : "dry-run", packetPath: args[packetIndexes[0] + 1] };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  let publication = null;
  try {
    const options = parseComponentPublishArgs(process.argv.slice(2));
    publication = await prepareComponentPublication(options.packetPath);
    if (options.mode === "dry-run") {
      console.log(
        `Verified component catalog ${publication.catalog.channel}/${publication.catalog.platform}/${publication.catalog.arch} sequence ${publication.catalog.sequence}; ${publication.uploads.length} immutable objects planned. No external effect occurred.`,
      );
    } else {
      assertCleanTree("A component publication");
      await publishPreparedComponents(publication);
      console.log(
        `Published and verified component catalog ${publication.catalog.channel}/${publication.catalog.platform}/${publication.catalog.arch} sequence ${publication.catalog.sequence}.`,
      );
    }
  } catch (error) {
    console.error(`component publication failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    disposeComponentPublication(publication);
  }
}
