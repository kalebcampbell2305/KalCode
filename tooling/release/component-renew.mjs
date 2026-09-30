#!/usr/bin/env node
// Renews a published KalVoice component catalog: re-signs every nested component manifest and the
// catalog with a higher sequence and a fresh validity window, while keeping every other signed
// field (artifact bytes, hashes, URLs, licenses, provenance, ABIs, roles) exactly as published.
//
// Signing goes through the same release signer as the original catalogs
// (tooling/component-signer via component-signing.mjs). The key store path is supplied at run time
// and is never read by this module; only the signer process touches it. This module never
// publishes: the output is a publication packet for component-publish.mjs.
//
// Runbook: docs/ops/KALVOICE-CATALOG-RENEWAL.md
import { spawnSync } from "node:child_process";
import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  COMPONENT_CATALOG_TYPE,
  COMPONENT_MANIFEST_TYPE,
  componentPublicKey,
  parseComponentPublicKey,
  signComponentCatalog,
  signComponentManifest,
  verifyComponentCatalog,
  verifyComponentManifest,
} from "./component-signing.mjs";
import { sha256File } from "./lib.mjs";
import { releaseProcessOptions } from "./signing.mjs";

export const TRACKED_COMPONENT_PUBLIC_KEY_PATH = join(import.meta.dirname, "component-public-key.json");
export const RENEWAL_LIFETIME_SECONDS = 29 * 24 * 60 * 60;
export const MAX_LIFETIME_SECONDS = 30 * 24 * 60 * 60;
export const CLOCK_SKEW_SECONDS = 5 * 60;
export const TARGETS = Object.freeze({ windows: "x86_64", macos: "aarch64" });
/** The only signed fields a renewal may change. Everything else is copied verbatim. */
export const RENEWAL_FIELDS = Object.freeze(["sequence", "issuedAt", "expiresAt"]);

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const MANIFEST_FIELDS = [
  "schemaVersion",
  "componentId",
  "kind",
  "version",
  "sequence",
  "platform",
  "arch",
  "runtimeAbi",
  "sizeBytes",
  "sha256",
  "artifactUrl",
  "licenses",
  "provenance",
  "issuedAt",
  "expiresAt",
  "keyId",
];
const CATALOG_FIELDS = [
  "schemaVersion",
  "channel",
  "sequence",
  "platform",
  "arch",
  "reasoningAbi",
  "speechModelAbi",
  "defaultSpeechComponentId",
  "entries",
  "issuedAt",
  "expiresAt",
  "keyId",
];
const MAX_TOKEN_FILE_BYTES = 192 * 1024 + 2;
const COMPONENT_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;

export class RenewalRefusal extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "RenewalRefusal";
    this.code = code;
  }
}

function refuse(code, message) {
  throw new RenewalRefusal(code, message);
}

function absolutePath(value, label) {
  if (typeof value !== "string" || !isAbsolute(value)) refuse("invalid_path", `${label} must be an absolute path`);
  return resolve(value);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameJson(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function exactFields(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse("invalid_document", `${label} is invalid`);
  if (canonicalJson(Object.keys(value).sort()) !== canonicalJson([...fields].sort())) {
    refuse("invalid_document", `${label} has an unexpected field set`);
  }
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) refuse("invalid_document", `${label} must be a positive integer`);
  return value;
}

function sha256Text(text) {
  return createHash("sha256").update(text).digest("hex");
}

function readTokenFile(path, label) {
  const absolute = absolutePath(path, label);
  const metadata = lstatSync(absolute, { throwIfNoEntry: false });
  if (!metadata?.isFile() || metadata.isSymbolicLink() || metadata.size < 3 || metadata.size > MAX_TOKEN_FILE_BYTES) {
    refuse("invalid_token", `${label} must be a small regular file`);
  }
  const text = readFileSync(absolute, "utf8");
  const token = text.replace(/\r?\n$/, "");
  if (!token || token.trim() !== token || token.includes("\n")) refuse("invalid_token", `${label} is malformed`);
  return { token, text };
}

function readJsonFile(path, label) {
  const absolute = absolutePath(path, label);
  try {
    return JSON.parse(readFileSync(absolute, "utf8"));
  } catch {
    return refuse("invalid_document", `${label} is not readable JSON`);
  }
}

function base64UrlJson(segment, label) {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) refuse("invalid_token", `${label} is not base64url`);
  const bytes = Buffer.from(segment, "base64url");
  if (bytes.toString("base64url") !== segment) refuse("invalid_token", `${label} is not canonical base64url`);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return refuse("invalid_token", `${label} is not JSON`);
  }
}

/** Decodes a compact JWS without trusting it. */
export function decodeCompactJws(token) {
  const segments = String(token).split(".");
  if (segments.length !== 3) refuse("invalid_token", "component JWS must have three segments");
  const [header, payload, signature] = segments;
  return {
    header: base64UrlJson(header, "JWS header"),
    payload: base64UrlJson(payload, "JWS payload"),
    signingInput: `${header}.${payload}`,
    signature: Buffer.from(signature, "base64url"),
  };
}

function publicKeyObject(publicKey) {
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKey.x }, format: "jwk" });
}

/**
 * Verifies an EdDSA compact JWS against the pinned public key and exact document type. It does
 * not check the time window: a renewal must be able to read a catalog that has already expired.
 */
export function verifyPinnedJws(token, publicKey, expectedType) {
  const decoded = decodeCompactJws(token);
  exactFields(decoded.header, ["alg", "typ", "kid"], "JWS header");
  if (decoded.header.alg !== "EdDSA" || decoded.header.typ !== expectedType) {
    refuse("wrong_document_type", `JWS is not a ${expectedType} document`);
  }
  if (decoded.header.kid !== publicKey.kid) refuse("wrong_key", "JWS was not signed by the pinned component key id");
  if (
    decoded.signature.length !== 64 ||
    !verifySignature(null, Buffer.from(decoded.signingInput), publicKeyObject(publicKey), decoded.signature)
  ) {
    refuse("wrong_key", "JWS signature does not verify against the pinned component public key");
  }
  if (decoded.payload?.keyId !== publicKey.kid) refuse("wrong_key", "signed document keyId is not the pinned key id");
  return decoded.payload;
}

/** Reads and authenticates the currently published catalog and every nested manifest. */
export function readPreviousCatalog({ token, publicKey, platform }) {
  const catalog = verifyPinnedJws(token, publicKey, COMPONENT_CATALOG_TYPE);
  exactFields(catalog, CATALOG_FIELDS, "previous catalog");
  positiveInteger(catalog.sequence, "previous catalog sequence");
  if (!(platform in TARGETS)) refuse("invalid_target", "platform must be windows or macos");
  if (catalog.platform !== platform || catalog.arch !== TARGETS[platform]) {
    refuse(
      "wrong_target",
      `previous catalog is ${catalog.platform}/${catalog.arch}, not ${platform}/${TARGETS[platform]}`,
    );
  }
  if (!Array.isArray(catalog.entries) || catalog.entries.length < 3 || catalog.entries.length > 7) {
    refuse("invalid_document", "previous catalog entries are invalid");
  }
  const ids = new Set();
  const entries = catalog.entries.map((entry, index) => {
    exactFields(entry, ["role", "token"], `previous catalog entry ${index}`);
    const manifest = verifyPinnedJws(entry.token, publicKey, COMPONENT_MANIFEST_TYPE);
    exactFields(manifest, MANIFEST_FIELDS, `previous manifest ${index}`);
    positiveInteger(manifest.sequence, `previous manifest ${index} sequence`);
    if (!COMPONENT_ID.test(manifest.componentId) || ids.has(manifest.componentId)) {
      refuse("invalid_document", "previous manifest component IDs must be safe and unique");
    }
    ids.add(manifest.componentId);
    if (manifest.platform !== catalog.platform || manifest.arch !== catalog.arch) {
      refuse("wrong_target", `previous manifest ${manifest.componentId} targets a different platform`);
    }
    return { role: entry.role, token: entry.token, manifest };
  });
  return { catalog, entries, tokenSha256: sha256Text(token) };
}

/** Refuses any change to a signed document other than the renewal fields. */
export function assertOnlyRenewalFieldsChanged(previous, next, label) {
  const strip = (value) => Object.fromEntries(Object.entries(value).filter(([key]) => !RENEWAL_FIELDS.includes(key)));
  if (!sameJson(Object.keys(previous).sort(), Object.keys(next).sort()) || !sameJson(strip(previous), strip(next))) {
    const changed = [...new Set([...Object.keys(previous), ...Object.keys(next)])].filter(
      (key) => !RENEWAL_FIELDS.includes(key) && !sameJson(previous[key], next[key]),
    );
    refuse(
      changed.some((key) => ["sha256", "sizeBytes", "artifactUrl"].includes(key))
        ? "artifact_changed"
        : "field_changed",
      `${label} would change signed field(s) other than ${RENEWAL_FIELDS.join("/")}: ${changed.join(", ") || "field set"}`,
    );
  }
}

/**
 * Computes the renewal window and sequences. Pure: it performs no I/O.
 *
 * Anti-rollback: the new catalog sequence must exceed the previous catalog sequence and any known
 * published floor (the D1 pointer or a client floor); every manifest sequence rises by one.
 */
export function planRenewal({ previous, issuedAt, sequence, floorSequence, now }) {
  const prev = previous.catalog;
  if (!Number.isSafeInteger(now) || now < 0) refuse("invalid_clock", "current time is invalid");
  const newIssuedAt = issuedAt ?? now;
  if (!Number.isSafeInteger(newIssuedAt) || newIssuedAt < 0) refuse("invalid_window", "issuedAt must be unix seconds");
  const newSequence = sequence ?? prev.sequence + 1;
  if (!Number.isSafeInteger(newSequence) || newSequence < 1)
    refuse("invalid_sequence", "sequence must be a positive integer");
  if (newSequence <= prev.sequence) {
    refuse(
      "sequence_not_increasing",
      `new catalog sequence ${newSequence} must be greater than the published sequence ${prev.sequence} (equal is a ConflictingSequence, lower is a RollbackDenied)`,
    );
  }
  if (floorSequence !== undefined && floorSequence !== null) {
    if (!Number.isSafeInteger(floorSequence) || floorSequence < 1) refuse("invalid_floor", "floor sequence is invalid");
    if (floorSequence > prev.sequence) {
      refuse(
        "stale_previous",
        `the known floor ${floorSequence} is above the supplied previous catalog sequence ${prev.sequence}; renew from the current catalog`,
      );
    }
    if (newSequence <= floorSequence) {
      refuse("below_floor", `new catalog sequence ${newSequence} does not exceed the known floor ${floorSequence}`);
    }
  }
  if (newIssuedAt <= prev.issuedAt)
    refuse("invalid_window", "issuedAt must be later than the previous catalog issuedAt");
  if (newIssuedAt > now + CLOCK_SKEW_SECONDS)
    refuse("invalid_window", "issuedAt is in the future; the signer would refuse it");
  const expiresAt = newIssuedAt + RENEWAL_LIFETIME_SECONDS;
  if (expiresAt - newIssuedAt > MAX_LIFETIME_SECONDS) refuse("invalid_window", "lifetime exceeds 30 days");
  if (expiresAt <= now) refuse("invalid_window", "the renewed window would already be expired");
  if (expiresAt <= prev.expiresAt) refuse("invalid_window", "the renewed window must end after the previous window");

  const manifests = previous.entries.map(({ role, manifest }) => {
    const next = { ...manifest, sequence: manifest.sequence + 1, issuedAt: newIssuedAt, expiresAt };
    if (next.sequence <= manifest.sequence) refuse("sequence_not_increasing", "manifest sequence must increase");
    assertOnlyRenewalFieldsChanged(manifest, next, `manifest ${manifest.componentId}`);
    return { role, previous: manifest, manifest: next };
  });
  const catalog = { ...prev, sequence: newSequence, issuedAt: newIssuedAt, expiresAt };
  return { issuedAt: newIssuedAt, expiresAt, sequence: newSequence, manifests, catalog };
}

function artifactFileName(manifest) {
  const name = new URL(manifest.artifactUrl).pathname.split("/").at(-1);
  if (!name || !/^[A-Za-z0-9._-]{1,160}$/.test(name) || name.includes("..")) {
    refuse("invalid_document", `artifact URL file name is unsafe for ${manifest.componentId}`);
  }
  return name;
}

function regularFile(path) {
  const metadata = lstatSync(path, { throwIfNoEntry: false });
  return Boolean(metadata?.isFile() && !metadata.isSymbolicLink() && resolve(realpathSync(path)) === resolve(path));
}

/**
 * Locates each artifact (and runtime evidence) for the renewal. The previous publication packet
 * supplies the paths; `artifactDirs`, when given, are searched in order instead so a relocated
 * backup can be used. The signer requires the local file name to equal the signed URL file name.
 */
export function resolveArtifacts({ manifests, previousPacket, artifactDirs = [] }) {
  exactFields(
    previousPacket,
    ["schemaVersion", "catalogPath", "publicKeyPath", "artifacts"],
    "previous publication packet",
  );
  if (previousPacket.schemaVersion !== 1 || !Array.isArray(previousPacket.artifacts)) {
    refuse("invalid_document", "previous publication packet is invalid");
  }
  const packetEntries = new Map(previousPacket.artifacts.map((entry) => [entry.componentId, entry]));
  if (packetEntries.size !== manifests.length)
    refuse("artifact_set_changed", "previous packet artifact set does not match the catalog");
  const dirs = artifactDirs.map((dir) => absolutePath(dir, "artifact directory"));
  const locate = (name, fallback, label) => {
    if (dirs.length) {
      for (const dir of dirs) {
        const candidate = join(dir, name);
        if (regularFile(candidate)) return candidate;
      }
      return refuse("artifact_missing", `${label} ${name} was not found in any --artifact-dir`);
    }
    const path = absolutePath(fallback, label);
    if (!regularFile(path)) refuse("artifact_missing", `${label} ${path} is missing or is a link`);
    return path;
  };
  return manifests.map(({ manifest }) => {
    const entry = packetEntries.get(manifest.componentId);
    if (!entry) refuse("artifact_set_changed", `previous packet has no entry for ${manifest.componentId}`);
    exactFields(entry, ["componentId", "path", "evidencePath"], `previous packet entry ${manifest.componentId}`);
    const name = artifactFileName(manifest);
    const path = locate(name, entry.path, `artifact for ${manifest.componentId}`);
    if (basename(path) !== name) refuse("artifact_name_mismatch", `${path} is not named ${name}`);
    const evidencePath =
      entry.evidencePath === null
        ? null
        : locate(basename(entry.evidencePath), entry.evidencePath, `evidence for ${manifest.componentId}`);
    return { componentId: manifest.componentId, path, evidencePath };
  });
}

/** Refuses any artifact whose bytes no longer match the published manifest. */
export async function assertArtifactsUnchanged(manifests, artifacts, { hashFile = sha256File } = {}) {
  for (const [index, { manifest }] of manifests.entries()) {
    const artifact = artifacts[index];
    const size = statSync(artifact.path).size;
    if (size !== manifest.sizeBytes || (await hashFile(artifact.path)) !== manifest.sha256) {
      refuse(
        "artifact_changed",
        `artifact ${artifact.path} does not match the published ${manifest.componentId} sha256/size; a renewal never changes artifact bytes`,
      );
    }
  }
}

function assertFreshOutputDirectory(path) {
  if (existsSync(path)) {
    if (!statSync(path).isDirectory() || readdirSync(path).length) {
      refuse("output_not_fresh", `output directory ${path} must not exist or must be empty`);
    }
  } else {
    mkdirSync(path, { recursive: true });
  }
}

function writeNew(path, text) {
  writeFileSync(path, text, { encoding: "utf8", flag: "wx" });
}

function writeJson(path, value) {
  writeNew(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Runs the application's own catalog verifier (crates/kalvoice) on the renewed catalog. */
export function runAppCatalogVerifier(
  { publicKeyPath, tokenPath, previousTokenPath, platform, now },
  { root = REPO_ROOT, spawn = spawnSync } = {},
) {
  const args = [
    "run",
    "--quiet",
    "--locked",
    "-p",
    "kalcode-kalvoice",
    "--example",
    "component_catalog_check",
    "--",
    "--public-key-file",
    publicKeyPath,
    "--token",
    tokenPath,
    "--platform",
    platform,
  ];
  if (previousTokenPath) args.push("--previous-token", previousTokenPath);
  if (now !== undefined) args.push("--now", String(now));
  const result = spawn(
    "cargo",
    args,
    releaseProcessOptions({ cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 1_800_000 }),
  );
  const line = String(result.stdout ?? "")
    .trim()
    .split(/\r?\n/)
    .at(-1);
  let report;
  try {
    report = JSON.parse(line);
  } catch {
    refuse("app_verifier_failed", `the kalvoice catalog verifier did not run (exit ${result.status})`);
  }
  if (result.status !== 0 || report?.ok !== true) {
    refuse(
      "app_verifier_rejected",
      `the kalvoice catalog verifier rejected the catalog: ${report?.error ?? "unknown"}`,
    );
  }
  return report;
}

const defaultSigner = Object.freeze({
  componentPublicKey,
  signComponentManifest,
  signComponentCatalog,
  verifyComponentManifest,
  verifyComponentCatalog,
});

/**
 * Renews one platform's catalog.
 *
 * Order of refusals: previous catalog authenticity, anti-rollback and window, artifact identity,
 * output freshness, key identity (before any signature), then post-signing verification by the
 * release signer and by the application's own verifier.
 */
export async function renewComponentCatalog(
  {
    platform,
    previousCatalogPath,
    previousPacketPath,
    outputDir,
    storePath,
    issuedAt,
    sequence,
    floorSequence,
    artifactDirs = [],
    publicKeyPath = TRACKED_COMPONENT_PUBLIC_KEY_PATH,
    publicationPublicKeyPath = publicKeyPath,
    prepareOnly = false,
  },
  {
    signer = defaultSigner,
    appVerifier = runAppCatalogVerifier,
    hashFile = sha256File,
    now = Math.floor(Date.now() / 1000),
    log = () => {},
  } = {},
) {
  if (!(platform in TARGETS)) refuse("invalid_target", "--platform must be windows or macos");
  const pinnedKeyPath = absolutePath(publicKeyPath, "pinned public key");
  const publicKey = parseComponentPublicKey(readFileSync(pinnedKeyPath, "utf8"));
  const publicationKeyPath = absolutePath(publicationPublicKeyPath, "publication public key");
  if (!sameJson(parseComponentPublicKey(readFileSync(publicationKeyPath, "utf8")), publicKey)) {
    refuse("wrong_key", "the publishing checkout's component public key differs from the pinned key");
  }
  const previousPacket = readJsonFile(
    absolutePath(previousPacketPath, "previous publication packet"),
    "previous publication packet",
  );
  const previousCatalogFile = absolutePath(previousCatalogPath ?? previousPacket.catalogPath, "previous catalog");
  const { token: previousToken } = readTokenFile(previousCatalogFile, "previous catalog");
  const previous = readPreviousCatalog({ token: previousToken, publicKey, platform });
  log(`previous ${platform} catalog: sequence ${previous.catalog.sequence}, sha256 ${previous.tokenSha256}`);

  const plan = planRenewal({ previous, issuedAt, sequence, floorSequence, now });
  const artifacts = resolveArtifacts({ manifests: plan.manifests, previousPacket, artifactDirs });
  await assertArtifactsUnchanged(plan.manifests, artifacts, { hashFile });
  log(`artifacts unchanged: ${artifacts.length}`);

  const out = absolutePath(outputDir, "output directory");
  assertFreshOutputDirectory(out);
  const inputs = plan.manifests.map(({ manifest }) => {
    const inputPath = join(out, `${manifest.componentId}.json`);
    writeJson(inputPath, manifest);
    return inputPath;
  });
  const summary = {
    schemaVersion: 1,
    platform,
    arch: TARGETS[platform],
    previous: {
      catalogPath: previousCatalogFile,
      sequence: previous.catalog.sequence,
      tokenSha256: previous.tokenSha256,
      issuedAt: previous.catalog.issuedAt,
      expiresAt: previous.catalog.expiresAt,
    },
    renewed: {
      sequence: plan.sequence,
      issuedAt: plan.issuedAt,
      expiresAt: plan.expiresAt,
      issuedAtIso: new Date(plan.issuedAt * 1000).toISOString(),
      expiresAtIso: new Date(plan.expiresAt * 1000).toISOString(),
    },
    manifests: plan.manifests.map(({ role, previous: prior, manifest }) => ({
      role,
      componentId: manifest.componentId,
      previousSequence: prior.sequence,
      sequence: manifest.sequence,
      sha256: manifest.sha256,
    })),
  };
  if (prepareOnly) {
    writeJson(join(out, "renewal-plan.json"), summary);
    return { prepared: true, outputDir: out, summary };
  }

  // Key identity before any signature: the key in the supplied store must be the pinned key.
  const storeKey = signer.componentPublicKey({ storePath: absolutePath(storePath, "component key store") });
  if (!sameJson(storeKey, publicKey)) {
    refuse(
      "wrong_key",
      `the key store holds ${storeKey.kid}, which is not the pinned component public key ${publicKey.kid}`,
    );
  }

  const entries = [];
  for (const [index, { role, previous: prior, manifest }] of plan.manifests.entries()) {
    const outputPath = join(out, `${manifest.componentId}.jws`);
    signer.signComponentManifest({
      storePath,
      inputPath: inputs[index],
      artifactPath: artifacts[index].path,
      outputPath,
    });
    signer.verifyComponentManifest({
      publicKeyPath: pinnedKeyPath,
      tokenPath: outputPath,
      artifactPath: artifacts[index].path,
    });
    const { token } = readTokenFile(outputPath, `renewed ${manifest.componentId} manifest`);
    const signed = verifyPinnedJws(token, publicKey, COMPONENT_MANIFEST_TYPE);
    if (!sameJson(signed, manifest))
      refuse("signing_mismatch", `signed ${manifest.componentId} differs from its input`);
    assertOnlyRenewalFieldsChanged(prior, signed, `signed manifest ${manifest.componentId}`);
    entries.push({ role, token });
    log(`signed and verified ${manifest.componentId} sequence ${manifest.sequence}`);
  }

  const catalogInput = { ...plan.catalog, entries };
  const catalogInputPath = join(out, "catalog.json");
  const catalogPath = join(out, "catalog.jws");
  writeJson(catalogInputPath, catalogInput);
  signer.signComponentCatalog({ storePath, inputPath: catalogInputPath, outputPath: catalogPath });
  signer.verifyComponentCatalog({ publicKeyPath: pinnedKeyPath, tokenPath: catalogPath });
  const { token: catalogToken } = readTokenFile(catalogPath, "renewed catalog");
  const renewed = readPreviousCatalog({ token: catalogToken, publicKey, platform });
  if (!sameJson(renewed.catalog, catalogInput)) refuse("signing_mismatch", "signed catalog differs from its input");
  const { entries: _previousEntries, ...previousCatalogFields } = previous.catalog;
  const { entries: _renewedEntries, ...renewedCatalogFields } = renewed.catalog;
  assertOnlyRenewalFieldsChanged(previousCatalogFields, renewedCatalogFields, "signed catalog");
  if (
    !sameJson(
      renewed.entries.map(({ role, manifest }) => [role, manifest.componentId]),
      previous.entries.map(({ role, manifest }) => [role, manifest.componentId]),
    )
  ) {
    refuse("field_changed", "renewed catalog roles or component order differ from the published catalog");
  }
  log(`signed and verified catalog sequence ${plan.sequence} (release signer)`);

  const appReport = appVerifier({
    publicKeyPath: pinnedKeyPath,
    tokenPath: catalogPath,
    previousTokenPath: previousCatalogFile,
    platform,
    now,
  });
  if (
    appReport.sequence !== plan.sequence ||
    appReport.tokenSha256 !== renewed.tokenSha256 ||
    appReport.transition?.floorAdvancedTo !== plan.sequence ||
    appReport.transition?.previousSequence !== previous.catalog.sequence ||
    appReport.transition?.reverseRollbackDenied !== true
  ) {
    refuse("app_verifier_rejected", "the kalvoice catalog verifier report does not match the renewal");
  }
  log(`kalvoice verify_catalog + advance_catalog_floor accepted sequence ${plan.sequence}`);

  const publication = {
    schemaVersion: 1,
    catalogPath,
    publicKeyPath: publicationKeyPath,
    artifacts: artifacts.map(({ componentId, path, evidencePath }) => ({ componentId, path, evidencePath })),
  };
  writeJson(join(out, "publication.json"), publication);
  const record = {
    ...summary,
    renewed: { ...summary.renewed, tokenSha256: renewed.tokenSha256 },
    appVerifier: appReport,
  };
  writeJson(join(out, "renewal-record.json"), record);
  return { prepared: false, outputDir: out, catalogPath, publicationPath: join(out, "publication.json"), record };
}

const USAGE = `usage: node tooling/release/component-renew.mjs --platform windows|macos \\
  --previous-packet ABS_publication.json --output-dir ABS_NEW_DIR \\
  (--store ABS_KEY_STORE | --prepare-only) \\
  [--previous-catalog ABS_catalog.jws] [--artifact-dir ABS_DIR]... \\
  [--issued-at UNIX] [--sequence N] [--floor-sequence N] [--publish-checkout ABS_REPO]`;

export function parseRenewArgs(argv) {
  const single = new Set([
    "--platform",
    "--previous-packet",
    "--previous-catalog",
    "--output-dir",
    "--store",
    "--issued-at",
    "--sequence",
    "--floor-sequence",
    "--publish-checkout",
  ]);
  const options = { artifactDirs: [], prepareOnly: false };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--prepare-only") {
      options.prepareOnly = true;
      continue;
    }
    const value = argv[index + 1];
    if ((!single.has(name) && name !== "--artifact-dir") || value === undefined || value.startsWith("--")) {
      throw new Error(USAGE);
    }
    index += 1;
    if (name === "--artifact-dir") {
      options.artifactDirs.push(value);
      continue;
    }
    if (seen.has(name)) throw new Error(USAGE);
    seen.add(name);
    const key = name.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (["issuedAt", "sequence", "floorSequence"].includes(key)) {
      if (!/^\d{1,15}$/.test(value)) throw new Error(USAGE);
      options[key] = Number(value);
    } else {
      options[key] = value;
    }
  }
  if (!options.platform || !options.previousPacket || !options.outputDir) throw new Error(USAGE);
  if (options.prepareOnly === Boolean(options.store)) throw new Error(USAGE);
  const result = {
    platform: options.platform,
    previousPacketPath: options.previousPacket,
    previousCatalogPath: options.previousCatalog,
    outputDir: options.outputDir,
    storePath: options.store,
    issuedAt: options.issuedAt,
    sequence: options.sequence,
    floorSequence: options.floorSequence,
    artifactDirs: options.artifactDirs,
    prepareOnly: options.prepareOnly,
  };
  if (options.publishCheckout) {
    result.publicationPublicKeyPath = join(
      absolutePath(options.publishCheckout, "--publish-checkout"),
      "tooling",
      "release",
      "component-public-key.json",
    );
  }
  return result;
}

async function main() {
  const options = parseRenewArgs(process.argv.slice(2));
  const result = await renewComponentCatalog(options, { log: (line) => console.log(line) });
  if (result.prepared) {
    console.log(`Prepared unsigned renewal inputs in ${result.outputDir}; nothing was signed.`);
  } else {
    console.log(`Renewed catalog: ${result.catalogPath}`);
    console.log(`Publication packet: ${result.publicationPath}`);
    console.log("Nothing was published.");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`component-renew: ${error.message}`);
    process.exit(1);
  });
}
