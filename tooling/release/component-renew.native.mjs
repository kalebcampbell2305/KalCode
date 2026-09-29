// End-to-end catalog renewal test on Windows.
//
// It signs through the real release signer (tooling/component-signer via component-signing.mjs)
// and verifies with the application's own kalvoice verifier (crates/kalvoice example
// component_catalog_check). Every key is a throwaway TEST key minted by `signer init` into a
// per-test temporary DPAPI store and deleted afterwards. It never reads the release key store.
//
//   node --test tooling/release/component-renew.native.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import {
  RenewalRefusal,
  renewComponentCatalog,
  runAppCatalogVerifier,
  TRACKED_COMPONENT_PUBLIC_KEY_PATH,
} from "./component-renew.mjs";
import {
  initializeComponentKey,
  signComponentCatalog,
  signComponentManifest,
  verifyComponentCatalog,
} from "./component-signing.mjs";

const skip = process.platform !== "win32" ? "DPAPI key custody is Windows-only" : false;
const DAY = 86_400;
const KID = "component-test-1";
const SPEECH = [
  ["kalvoice.speech.whisper.tiny-en", "ggml-tiny.en.bin"],
  ["kalvoice.speech.whisper.base-en", "ggml-base.en.bin"],
  ["kalvoice.speech.whisper.small-en", "ggml-small.en.bin"],
  ["kalvoice.speech.whisper.base", "ggml-base.bin"],
  ["kalvoice.speech.whisper.small", "ggml-small.bin"],
];

let dir;
let fixture;

const decode = (token) => JSON.parse(Buffer.from(token.split(".")[1], "base64url"));
const readToken = (path) => readFileSync(path, "utf8").trim();
const refusal = (code) => (error) => error instanceof RenewalRefusal && error.code === code;

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
}

before(() => {
  if (skip) return;
  dir = mkdtempSync(join(tmpdir(), "kalcode-renew-native-"));
  const storePath = join(dir, "test-key.dpapi");
  const publicKey = initializeComponentKey({ storePath, kid: KID });
  const publicKeyPath = join(dir, "test-public-key.json");
  writeFileSync(publicKeyPath, JSON.stringify(publicKey));
  const tracked = JSON.parse(readFileSync(TRACKED_COMPONENT_PUBLIC_KEY_PATH, "utf8"));
  assert.notEqual(publicKey.x, tracked.x, "the test key must never be the production key");

  const artifactsDir = join(dir, "artifacts");
  mkdirSync(artifactsDir);
  const previousDir = join(dir, "seq1");
  mkdirSync(previousDir);
  const issuedAt = Math.floor(Date.now() / 1000) - 3600;
  const expiresAt = issuedAt + 29 * DAY;
  const items = [
    {
      role: "reason-runtime",
      componentId: "kalvoice.runtime.llama-cpp",
      kind: "runtime",
      abi: "kalvoice-llama-cpp.v1",
      file: "runtime.zip",
    },
    {
      role: "reason-model",
      componentId: "kalvoice.reasoner.qwen3-5-0-8b-q8",
      kind: "model",
      abi: "kalvoice-llama-cpp.v1",
      file: "reasoner.gguf",
    },
    ...SPEECH.map(([componentId, file]) => ({
      role: "speech-model",
      componentId,
      kind: "model",
      abi: "kalvoice-whisper-ggml.v1",
      file,
    })),
  ];
  const entries = [];
  const artifacts = [];
  for (const item of items) {
    const path = join(artifactsDir, item.file);
    const bytes = Buffer.from(`test artifact ${item.componentId}`);
    writeFileSync(path, bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const evidencePath = item.role === "reason-runtime" ? join(artifactsDir, "runtime-record.json") : null;
    if (evidencePath) writeFileSync(evidencePath, "{}\n");
    const manifest = {
      schemaVersion: 1,
      componentId: item.componentId,
      kind: item.kind,
      version: "1.0.0",
      sequence: 1,
      platform: "windows",
      arch: "x86_64",
      runtimeAbi: item.abi,
      sizeBytes: bytes.length,
      sha256,
      artifactUrl: `https://kalcoded.com/components/v1/${item.kind}/${item.componentId}/1.0.0/${sha256}/${item.file}`,
      licenses: [{ spdxId: "MIT", noticeSha256: "a".repeat(64) }],
      provenance: {
        sourceId: "example/source",
        sourceRevision: "abc123",
        sourceIntegritySha256: "b".repeat(64),
        buildRecipeSha256: "c".repeat(64),
      },
      issuedAt,
      expiresAt,
      keyId: KID,
    };
    const inputPath = join(previousDir, `${item.componentId}.json`);
    const outputPath = join(previousDir, `${item.componentId}.jws`);
    writeJson(inputPath, manifest);
    signComponentManifest({ storePath, inputPath, artifactPath: path, outputPath });
    entries.push({ role: item.role, token: readToken(outputPath) });
    artifacts.push({ componentId: item.componentId, path, evidencePath });
  }
  const catalog = {
    schemaVersion: 1,
    channel: "stable",
    sequence: 1,
    platform: "windows",
    arch: "x86_64",
    reasoningAbi: "kalvoice-llama-cpp.v1",
    speechModelAbi: "kalvoice-whisper-ggml.v1",
    defaultSpeechComponentId: SPEECH[0][0],
    entries,
    issuedAt,
    expiresAt,
    keyId: KID,
  };
  const catalogInput = join(previousDir, "catalog.json");
  const catalogPath = join(previousDir, "catalog.jws");
  writeJson(catalogInput, catalog);
  signComponentCatalog({ storePath, inputPath: catalogInput, outputPath: catalogPath });
  verifyComponentCatalog({ publicKeyPath, tokenPath: catalogPath });
  const packetPath = join(previousDir, "publication.json");
  writeJson(packetPath, { schemaVersion: 1, catalogPath, publicKeyPath, artifacts });
  fixture = { storePath, publicKeyPath, artifactsDir, catalogPath, packetPath, catalog };
});

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const options = (outputDir, extra = {}) => ({
  platform: "windows",
  previousPacketPath: fixture.packetPath,
  outputDir: join(dir, outputDir),
  storePath: fixture.storePath,
  publicKeyPath: fixture.publicKeyPath,
  ...extra,
});

test("renewal re-signs all 7 manifests and the catalog at sequence 2 and the app verifier accepts it", {
  skip,
  timeout: 1_800_000,
}, async () => {
  const result = await renewComponentCatalog(options("seq2"));
  const token = readToken(result.catalogPath);
  const catalog = decode(token);
  assert.equal(catalog.sequence, 2);
  assert.equal(catalog.expiresAt - catalog.issuedAt, 29 * DAY);
  assert.ok(catalog.issuedAt > fixture.catalog.issuedAt);
  assert.equal(catalog.entries.length, 7);
  for (const [index, entry] of catalog.entries.entries()) {
    const next = decode(entry.token);
    const prior = decode(fixture.catalog.entries[index].token);
    assert.equal(entry.role, fixture.catalog.entries[index].role);
    assert.equal(prior.sequence, 1);
    assert.equal(next.sequence, 2);
    assert.equal(next.issuedAt, catalog.issuedAt);
    assert.equal(next.expiresAt, catalog.expiresAt);
    const { sequence: _a, issuedAt: _b, expiresAt: _c, ...rest } = next;
    const { sequence: _d, issuedAt: _e, expiresAt: _f, ...priorRest } = prior;
    assert.deepEqual(rest, priorRest);
  }
  // Release signer verification against the pinned public key.
  assert.doesNotThrow(() =>
    verifyComponentCatalog({ publicKeyPath: fixture.publicKeyPath, tokenPath: result.catalogPath }),
  );
  // The application's own verifier (kalvoice verify_catalog + advance_catalog_floor + authorize_transition).
  const report = result.record.appVerifier;
  assert.equal(report.ok, true);
  assert.equal(report.verifier, "kalcode_kalvoice::component_catalog::verify_catalog");
  assert.equal(report.sequence, 2);
  assert.equal(report.entries, 7);
  assert.equal(report.transition.previousSequence, 1);
  assert.equal(report.transition.floorAdvancedTo, 2);
  assert.equal(report.transition.reverseRollbackDenied, true);
  assert.deepEqual(
    report.transition.manifests.map(({ previousSequence, sequence }) => [previousSequence, sequence]),
    Array(7).fill([1, 2]),
  );
  assert.equal(report.tokenSha256, createHash("sha256").update(token).digest("hex"));
  const packet = JSON.parse(readFileSync(result.publicationPath, "utf8"));
  assert.equal(packet.catalogPath, result.catalogPath);
  assert.equal(packet.publicKeyPath, fixture.publicKeyPath);
  assert.equal(packet.artifacts.length, 7);
  assert.equal(packet.artifacts[0].evidencePath, join(fixture.artifactsDir, "runtime-record.json"));
});

test("renewal refuses to lower or repeat the sequence and writes nothing", { skip, timeout: 600_000 }, async () => {
  for (const [name, extra, code] of [
    ["same", { sequence: 1 }, "sequence_not_increasing"],
    ["zero", { sequence: 0 }, "invalid_sequence"],
    ["floor", { floorSequence: 2 }, "stale_previous"],
  ]) {
    await assert.rejects(renewComponentCatalog(options(`refuse-${name}`, extra)), refusal(code));
    assert.equal(existsSync(join(dir, `refuse-${name}`)), false);
  }
});

test("renewal refuses artifacts whose bytes changed and signs nothing", { skip, timeout: 600_000 }, async () => {
  const swapped = join(dir, "swapped");
  mkdirSync(swapped);
  for (const name of readdirSync(fixture.artifactsDir))
    copyFileSync(join(fixture.artifactsDir, name), join(swapped, name));
  writeFileSync(join(swapped, "ggml-tiny.en.bin"), "different bytes, same name");
  await assert.rejects(
    renewComponentCatalog(options("refuse-artifact", { artifactDirs: [swapped] })),
    refusal("artifact_changed"),
  );
  assert.equal(existsSync(join(dir, "refuse-artifact")), false);
});

test("renewal refuses a key store holding a different key, even under the same key id", {
  skip,
  timeout: 600_000,
}, async () => {
  for (const [name, kid] of [
    ["same-kid", KID],
    ["other-kid", "component-test-2"],
  ]) {
    const wrongStore = join(dir, `wrong-${name}.dpapi`);
    initializeComponentKey({ storePath: wrongStore, kid });
    const outputDir = join(dir, `refuse-key-${name}`);
    await assert.rejects(
      renewComponentCatalog(options(`refuse-key-${name}`, { storePath: wrongStore })),
      refusal("wrong_key"),
    );
    assert.deepEqual(
      readdirSync(outputDir).filter((file) => file.endsWith(".jws")),
      [],
      "no token may be signed with a wrong key",
    );
  }
});

test("the kalvoice app verifier refuses rollback, a conflicting same-sequence catalog, and a foreign key", {
  skip,
  timeout: 1_800_000,
}, async () => {
  const renewed = join(dir, "seq2", "catalog.jws");
  assert.ok(existsSync(renewed), "runs after the renewal test");
  // Rollback: a client holding the sequence-2 floor is offered sequence 1.
  assert.throws(
    () =>
      runAppCatalogVerifier({
        publicKeyPath: fixture.publicKeyPath,
        tokenPath: fixture.catalogPath,
        previousTokenPath: renewed,
        platform: "windows",
      }),
    /floor_rollback_denied/,
  );
  // Same sequence with a different window: the ConflictingSequence a "renewal" without a bump causes.
  const conflictDir = join(dir, "conflict");
  mkdirSync(conflictDir);
  const conflictInput = join(conflictDir, "catalog.json");
  const conflictPath = join(conflictDir, "catalog.jws");
  writeJson(conflictInput, { ...fixture.catalog, issuedAt: fixture.catalog.issuedAt + 60 });
  signComponentCatalog({ storePath: fixture.storePath, inputPath: conflictInput, outputPath: conflictPath });
  assert.throws(
    () =>
      runAppCatalogVerifier({
        publicKeyPath: fixture.publicKeyPath,
        tokenPath: conflictPath,
        previousTokenPath: fixture.catalogPath,
        platform: "windows",
      }),
    /floor_conflicting_sequence/,
  );
  // The production trust root rejects a catalog signed by the test key.
  assert.throws(
    () =>
      runAppCatalogVerifier({
        publicKeyPath: TRACKED_COMPONENT_PUBLIC_KEY_PATH,
        tokenPath: renewed,
        platform: "windows",
      }),
    /catalog_rejected/,
  );
  // Wrong target.
  assert.throws(
    () => runAppCatalogVerifier({ publicKeyPath: fixture.publicKeyPath, tokenPath: renewed, platform: "macos" }),
    /catalog_rejected:WrongTarget/,
  );
});
