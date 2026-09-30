// Unit tests for the catalog renewal policy. They use a throwaway Ed25519 keypair generated in
// this process only; no release key, key store, or network is touched. The end-to-end test that
// signs through the real release signer and verifies with the kalvoice crate is
// component-renew.native.mjs (Windows, DPAPI).
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  assertArtifactsUnchanged,
  assertOnlyRenewalFieldsChanged,
  parseRenewArgs,
  planRenewal,
  readPreviousCatalog,
  RENEWAL_LIFETIME_SECONDS,
  RenewalRefusal,
  renewComponentCatalog,
  resolveArtifacts,
  verifyPinnedJws,
} from "./component-renew.mjs";
import { COMPONENT_CATALOG_TYPE, COMPONENT_MANIFEST_TYPE } from "./component-signing.mjs";

const ROOT = resolve(import.meta.dirname, "..", "..");
const NOW = 1_800_000_000;
const DAY = 86_400;
const SPEECH_IDS = [
  "kalvoice.speech.whisper.tiny-en",
  "kalvoice.speech.whisper.base-en",
  "kalvoice.speech.whisper.small-en",
  "kalvoice.speech.whisper.base",
  "kalvoice.speech.whisper.small",
];

function throwawayKey(kid = "component-test-1") {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKey, document: { schemaVersion: 1, alg: "EdDSA", kid, x: publicKey.export({ format: "jwk" }).x } };
}

function jws(payload, typ, key, kid = key.document.kid) {
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ, kid })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = sign(null, Buffer.from(`${header}.${body}`), key.privateKey).toString("base64url");
  return `${header}.${body}.${signature}`;
}

function manifest(componentId, kind, abi, file, digest, { issuedAt, expiresAt, kid }) {
  return {
    schemaVersion: 1,
    componentId,
    kind,
    version: "1.0.0",
    sequence: 1,
    platform: "windows",
    arch: "x86_64",
    runtimeAbi: abi,
    sizeBytes: 5,
    sha256: digest,
    artifactUrl: `https://kalcoded.com/components/v1/${kind}/${componentId}/1.0.0/${digest}/${file}`,
    licenses: [{ spdxId: "MIT", noticeSha256: "a".repeat(64) }],
    provenance: {
      sourceId: "example/source",
      sourceRevision: "abc123",
      sourceIntegritySha256: "b".repeat(64),
      buildRecipeSha256: "c".repeat(64),
    },
    issuedAt,
    expiresAt,
    keyId: kid,
  };
}

function previousCatalogToken(key, { sequence = 1, issuedAt = NOW - 10 * DAY } = {}) {
  const window = { issuedAt, expiresAt: issuedAt + 29 * DAY, kid: key.document.kid };
  const manifests = [
    [
      "reason-runtime",
      manifest("kalvoice.runtime.llama-cpp", "runtime", "kalvoice-llama-cpp.v1", "runtime.zip", "1".repeat(64), window),
    ],
    [
      "reason-model",
      manifest(
        "kalvoice.reasoner.qwen3-5-0-8b-q8",
        "model",
        "kalvoice-llama-cpp.v1",
        "reasoner.gguf",
        "2".repeat(64),
        window,
      ),
    ],
    ...SPEECH_IDS.map((id, index) => [
      "speech-model",
      manifest(id, "model", "kalvoice-whisper-ggml.v1", `ggml-${index}.bin`, String(index + 3).repeat(64), window),
    ]),
  ];
  const catalog = {
    schemaVersion: 1,
    channel: "stable",
    sequence,
    platform: "windows",
    arch: "x86_64",
    reasoningAbi: "kalvoice-llama-cpp.v1",
    speechModelAbi: "kalvoice-whisper-ggml.v1",
    defaultSpeechComponentId: SPEECH_IDS[0],
    entries: manifests.map(([role, value]) => ({ role, token: jws(value, COMPONENT_MANIFEST_TYPE, key) })),
    issuedAt: window.issuedAt,
    expiresAt: window.expiresAt,
    keyId: key.document.kid,
  };
  return jws(catalog, COMPONENT_CATALOG_TYPE, key);
}

function refusal(code) {
  return (error) => error instanceof RenewalRefusal && error.code === code;
}

test("a renewal bumps every sequence, sets a shared 29-day window, and changes nothing else", () => {
  const key = throwawayKey();
  const previous = readPreviousCatalog({
    token: previousCatalogToken(key),
    publicKey: key.document,
    platform: "windows",
  });
  const plan = planRenewal({ previous, now: NOW });
  assert.equal(plan.sequence, 2);
  assert.equal(plan.catalog.sequence, 2);
  assert.equal(plan.issuedAt, NOW);
  assert.equal(plan.expiresAt, NOW + RENEWAL_LIFETIME_SECONDS);
  assert.equal(RENEWAL_LIFETIME_SECONDS, 29 * DAY);
  assert.equal(plan.manifests.length, 7);
  for (const { previous: prior, manifest: next } of plan.manifests) {
    assert.equal(next.sequence, prior.sequence + 1);
    assert.equal(next.issuedAt, plan.catalog.issuedAt);
    assert.equal(next.expiresAt, plan.catalog.expiresAt);
    for (const field of ["sha256", "sizeBytes", "artifactUrl", "licenses", "provenance", "runtimeAbi", "keyId"]) {
      assert.deepEqual(next[field], prior[field]);
    }
  }
  for (const field of [
    "channel",
    "platform",
    "arch",
    "reasoningAbi",
    "speechModelAbi",
    "defaultSpeechComponentId",
    "keyId",
  ]) {
    assert.deepEqual(plan.catalog[field], previous.catalog[field]);
  }
});

test("anti-rollback: the sequence must rise above the published sequence and the known floor", () => {
  const key = throwawayKey();
  const previous = readPreviousCatalog({
    token: previousCatalogToken(key),
    publicKey: key.document,
    platform: "windows",
  });
  assert.throws(() => planRenewal({ previous, now: NOW, sequence: 1 }), refusal("sequence_not_increasing"));
  assert.throws(() => planRenewal({ previous, now: NOW, sequence: 0 }), refusal("invalid_sequence"));
  assert.throws(() => planRenewal({ previous, now: NOW, floorSequence: 2 }), refusal("stale_previous"));
  assert.equal(planRenewal({ previous, now: NOW, floorSequence: 1 }).sequence, 2);
  assert.equal(planRenewal({ previous, now: NOW, sequence: 5, floorSequence: 1 }).sequence, 5);
  const seqThree = readPreviousCatalog({
    token: previousCatalogToken(key, { sequence: 3 }),
    publicKey: key.document,
    platform: "windows",
  });
  assert.throws(() => planRenewal({ previous: seqThree, now: NOW, sequence: 2 }), refusal("sequence_not_increasing"));
  assert.throws(() => planRenewal({ previous: seqThree, now: NOW, sequence: 3 }), refusal("sequence_not_increasing"));
});

test("the renewed window must be current, not in the future, and extend past the old one", () => {
  const key = throwawayKey();
  const previous = readPreviousCatalog({
    token: previousCatalogToken(key),
    publicKey: key.document,
    platform: "windows",
  });
  assert.throws(() => planRenewal({ previous, now: NOW, issuedAt: NOW + 3600 }), refusal("invalid_window"));
  assert.throws(
    () => planRenewal({ previous, now: NOW, issuedAt: previous.catalog.issuedAt }),
    refusal("invalid_window"),
  );
  assert.throws(() => planRenewal({ previous, now: NOW, issuedAt: NOW - 30 * DAY }), refusal("invalid_window"));
  const shared = planRenewal({ previous, now: NOW, issuedAt: NOW - 120 });
  assert.equal(shared.issuedAt, NOW - 120);
});

test("any change to artifact identity or other signed fields is refused", () => {
  const key = throwawayKey();
  const previous = readPreviousCatalog({
    token: previousCatalogToken(key),
    publicKey: key.document,
    platform: "windows",
  });
  const prior = previous.entries[2].manifest;
  const renewed = { ...prior, sequence: 2, issuedAt: NOW, expiresAt: NOW + DAY };
  assert.doesNotThrow(() => assertOnlyRenewalFieldsChanged(prior, renewed, "m"));
  assert.throws(
    () => assertOnlyRenewalFieldsChanged(prior, { ...renewed, sha256: "f".repeat(64) }, "m"),
    refusal("artifact_changed"),
  );
  assert.throws(
    () => assertOnlyRenewalFieldsChanged(prior, { ...renewed, sizeBytes: 6 }, "m"),
    refusal("artifact_changed"),
  );
  assert.throws(
    () =>
      assertOnlyRenewalFieldsChanged(
        prior,
        { ...renewed, artifactUrl: prior.artifactUrl.replace("ggml-0", "ggml-9") },
        "m",
      ),
    refusal("artifact_changed"),
  );
  assert.throws(
    () => assertOnlyRenewalFieldsChanged(prior, { ...renewed, licenses: [] }, "m"),
    refusal("field_changed"),
  );
  assert.throws(
    () => assertOnlyRenewalFieldsChanged(prior, { ...renewed, extra: true }, "m"),
    refusal("field_changed"),
  );
});

test("artifact bytes that no longer match the published hash are refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kalcode-renew-unit-"));
  try {
    const path = join(dir, "runtime.zip");
    writeFileSync(path, "bytes");
    const manifests = [{ manifest: { componentId: "x", sizeBytes: 5, sha256: "1".repeat(64) } }];
    await assert.rejects(
      assertArtifactsUnchanged(manifests, [{ path }], { hashFile: async () => "2".repeat(64) }),
      refusal("artifact_changed"),
    );
    await assert.doesNotReject(
      assertArtifactsUnchanged(manifests, [{ path }], { hashFile: async () => "1".repeat(64) }),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a previous catalog signed by another key, or with a substituted nested manifest, is refused", () => {
  const key = throwawayKey();
  const impostor = throwawayKey();
  const token = previousCatalogToken(impostor);
  assert.throws(
    () => readPreviousCatalog({ token, publicKey: key.document, platform: "windows" }),
    refusal("wrong_key"),
  );
  const otherKid = throwawayKey("component-other-1");
  assert.throws(
    () => readPreviousCatalog({ token: previousCatalogToken(otherKid), publicKey: key.document, platform: "windows" }),
    refusal("wrong_key"),
  );
  assert.throws(
    () => readPreviousCatalog({ token: previousCatalogToken(key), publicKey: key.document, platform: "macos" }),
    refusal("wrong_target"),
  );
  const manifestToken = JSON.parse(Buffer.from(token.split(".")[1], "base64url")).entries[0].token;
  assert.throws(() => verifyPinnedJws(manifestToken, key.document, COMPONENT_MANIFEST_TYPE), refusal("wrong_key"));
  assert.throws(
    () => verifyPinnedJws(previousCatalogToken(key), key.document, COMPONENT_MANIFEST_TYPE),
    refusal("wrong_document_type"),
  );
});

test("renewal refuses a key store whose key is not the pinned key before signing anything", async () => {
  const key = throwawayKey();
  const dir = mkdtempSync(join(tmpdir(), "kalcode-renew-unit-"));
  try {
    const publicKeyPath = join(dir, "public-key.json");
    writeFileSync(publicKeyPath, JSON.stringify(key.document));
    const catalogPath = join(dir, "catalog.jws");
    const token = previousCatalogToken(key, { issuedAt: NOW - 10 * DAY });
    writeFileSync(catalogPath, `${token}\n`);
    const previous = readPreviousCatalog({ token, publicKey: key.document, platform: "windows" });
    const artifacts = previous.entries.map(({ manifest: value }) => {
      const name = value.artifactUrl.split("/").at(-1);
      writeFileSync(join(dir, name), "bytes");
      return { componentId: value.componentId, path: join(dir, name), evidencePath: null };
    });
    const packetPath = join(dir, "publication.json");
    writeFileSync(packetPath, JSON.stringify({ schemaVersion: 1, catalogPath, publicKeyPath, artifacts }));
    const hashes = new Map(
      previous.entries.map(({ manifest: value }) => [join(dir, value.artifactUrl.split("/").at(-1)), value.sha256]),
    );
    const calls = [];
    const signer = {
      componentPublicKey: () => throwawayKey().document,
      signComponentManifest: () => calls.push("sign"),
      signComponentCatalog: () => calls.push("sign"),
      verifyComponentManifest: () => {},
      verifyComponentCatalog: () => {},
    };
    const outputDir = join(dir, "out");
    await assert.rejects(
      renewComponentCatalog(
        {
          platform: "windows",
          previousPacketPath: packetPath,
          outputDir,
          storePath: join(dir, "store.dpapi"),
          publicKeyPath,
        },
        { signer, hashFile: async (path) => hashes.get(path), now: NOW, appVerifier: () => assert.fail("not reached") },
      ),
      refusal("wrong_key"),
    );
    assert.deepEqual(calls, []);
    // The same packet with the pinned key is accepted up to signing (prepare-only writes inputs only).
    const prepared = await renewComponentCatalog(
      {
        platform: "windows",
        previousPacketPath: packetPath,
        outputDir: join(dir, "plan"),
        publicKeyPath,
        prepareOnly: true,
      },
      { signer, hashFile: async (path) => hashes.get(path), now: NOW },
    );
    assert.equal(prepared.summary.renewed.sequence, 2);
    const input = JSON.parse(readFileSync(join(dir, "plan", `${SPEECH_IDS[0]}.json`), "utf8"));
    assert.equal(input.sequence, 2);
    assert.deepEqual(calls, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("relocated artifacts are found by their signed file name and must keep that name", () => {
  const dir = mkdtempSync(join(tmpdir(), "kalcode-renew-unit-"));
  try {
    const a = join(dir, "a");
    const b = join(dir, "b");
    mkdirSync(a);
    mkdirSync(b);
    writeFileSync(join(b, "runtime.zip"), "x");
    writeFileSync(join(a, "runtime-record.json"), "{}");
    const value = {
      componentId: "kalvoice.runtime.llama-cpp",
      artifactUrl: `https://kalcoded.com/components/v1/runtime/x/1/${"1".repeat(64)}/runtime.zip`,
    };
    const packet = {
      schemaVersion: 1,
      catalogPath: join(dir, "c.jws"),
      publicKeyPath: join(dir, "k.json"),
      artifacts: [
        {
          componentId: value.componentId,
          path: join(dir, "gone", "runtime.zip"),
          evidencePath: join(dir, "gone", "runtime-record.json"),
        },
      ],
    };
    assert.deepEqual(
      resolveArtifacts({ manifests: [{ manifest: value }], previousPacket: packet, artifactDirs: [a, b] }),
      [{ componentId: value.componentId, path: join(b, "runtime.zip"), evidencePath: join(a, "runtime-record.json") }],
    );
    assert.throws(
      () => resolveArtifacts({ manifests: [{ manifest: value }], previousPacket: packet }),
      refusal("artifact_missing"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the CLI takes the key store path at run time and never defaults it", () => {
  const base = ["--platform", "windows", "--previous-packet", "C:\\p.json", "--output-dir", "C:\\out"];
  assert.throws(() => parseRenewArgs(base), /usage/);
  assert.equal(parseRenewArgs([...base, "--store", "C:\\k.dpapi"]).storePath, "C:\\k.dpapi");
  assert.equal(parseRenewArgs([...base, "--prepare-only"]).prepareOnly, true);
  assert.throws(() => parseRenewArgs([...base, "--prepare-only", "--store", "C:\\k.dpapi"]), /usage/);
  assert.throws(() => parseRenewArgs([...base, "--store", "C:\\k.dpapi", "--public-key", "C:\\x.json"]), /usage/);
  const parsed = parseRenewArgs([
    ...base,
    "--store",
    "C:\\k",
    "--sequence",
    "2",
    "--issued-at",
    "1800000000",
    "--artifact-dir",
    "C:\\a",
    "--artifact-dir",
    "C:\\b",
  ]);
  assert.equal(parsed.sequence, 2);
  assert.equal(parsed.issuedAt, 1_800_000_000);
  assert.deepEqual(parsed.artifactDirs, ["C:\\a", "C:\\b"]);
  const source = readFileSync(join(import.meta.dirname, "component-renew.mjs"), "utf8");
  assert.doesNotMatch(source, /DEFAULT_COMPONENT_KEY_STORE|ReleaseKeys|\.dpapi/);
});

test("the kalvoice verifier example uses the desktop app's exact speech component contract", () => {
  const listOf = (text, name) => {
    const match = text.match(new RegExp(`const ${name}: \\[&str; \\d+\\] = \\[([^\\]]*)\\]`));
    assert.ok(match, `${name} not found`);
    return [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]);
  };
  const app = readFileSync(join(ROOT, "apps", "desktop", "src-tauri", "src", "kalvoice_components.rs"), "utf8");
  const example = readFileSync(join(ROOT, "crates", "kalvoice", "examples", "component_catalog_check.rs"), "utf8");
  const trust = readFileSync(join(ROOT, "apps", "desktop", "src-tauri", "src", "kalvoice_component_trust.rs"), "utf8");
  assert.deepEqual(listOf(example, "SPEECH_COMPONENT_IDS"), listOf(app, "SPEECH_COMPONENT_IDS"));
  assert.deepEqual(listOf(example, "SPEECH_COMPONENT_IDS"), SPEECH_IDS);
  assert.match(app, /const DEFAULT_SPEECH_COMPONENT_ID: &str = SPEECH_COMPONENT_IDS\[0\];/);
  assert.match(example, /const DEFAULT_SPEECH_COMPONENT_ID: &str = SPEECH_COMPONENT_IDS\[0\];/);
  assert.match(trust, /\["kalcoded\.com"\]/);
  assert.deepEqual(listOf(example, "ALLOWED_HOSTS"), ["kalcoded.com"]);
});
