import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  buildComponentArtifactClaimStatement,
  buildComponentPointerAdvanceStatement,
  buildComponentPointerReadStatement,
  buildComponentPublishPlan,
  buildComponentVersionClaimStatement,
  componentCatalogKey,
  componentPublicationRowProblems,
  parseVerifiedComponentCatalog,
} from "./component-publish-plan.mjs";

const ZERO_SIGNATURE = Buffer.alloc(64).toString("base64url");
const KID = "component-2026-1";
const ISSUED = 1_795_000_000;
const EXPIRES = ISSUED + 7 * 24 * 60 * 60;

function compact(type, payload) {
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: type, kid: KID })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.${ZERO_SIGNATURE}`;
}

function manifest({
  componentId,
  kind,
  runtimeAbi,
  file,
  platform = "windows",
  arch = "x86_64",
  digest = "a".repeat(64),
  sizeBytes = 41,
}) {
  return compact("kalcode-local-component.v1", {
    schemaVersion: 1,
    componentId,
    kind,
    version: "1.0.0",
    sequence: 1,
    platform,
    arch,
    runtimeAbi,
    sizeBytes,
    sha256: digest,
    artifactUrl: `https://kalcoded.com/components/v1/${kind}/${componentId}/1.0.0/${digest}/${file}`,
    licenses: [{ spdxId: "MIT", noticeSha256: "b".repeat(64) }],
    provenance: {
      sourceId: "owner/project",
      sourceRevision: "revision-1",
      sourceIntegritySha256: "c".repeat(64),
      buildRecipeSha256: "d".repeat(64),
    },
    issuedAt: ISSUED - 60,
    expiresAt: EXPIRES + 60,
    keyId: KID,
  });
}

function catalogPayload(entries) {
  return {
    schemaVersion: 1,
    channel: "stable",
    sequence: 9,
    platform: "windows",
    arch: "x86_64",
    reasoningAbi: "kalvoice-llama-cpp.v1",
    speechModelAbi: "kalvoice-whisper-ggml.v1",
    entries,
    defaultSpeechComponentId: "kalvoice.speech.whisper.tiny-en",
    issuedAt: ISSUED,
    expiresAt: EXPIRES,
    keyId: KID,
  };
}

function fixture() {
  const entries = [
    {
      role: "reason-runtime",
      token: manifest({
        componentId: "kalvoice.runtime.llama-cpp",
        kind: "runtime",
        runtimeAbi: "kalvoice-llama-cpp.v1",
        file: "runtime.zip",
        digest: "1".repeat(64),
      }),
    },
    {
      role: "reason-model",
      token: manifest({
        componentId: "kalvoice.reasoner.qwen3-5-0-8b-q8",
        kind: "model",
        runtimeAbi: "kalvoice-llama-cpp.v1",
        file: "reasoner.gguf",
        digest: "2".repeat(64),
      }),
    },
    {
      role: "speech-model",
      token: manifest({
        componentId: "kalvoice.speech.whisper.tiny-en",
        kind: "model",
        runtimeAbi: "kalvoice-whisper-ggml.v1",
        file: "ggml-tiny.en.bin",
        digest: "3".repeat(64),
      }),
    },
  ];
  const token = compact("kalcode-local-component-catalog.v1", catalogPayload(entries));
  return { entries, token, catalog: parseVerifiedComponentCatalog(token) };
}

test("verified catalog parsing binds the exact roles, target, ABIs, nested identities, and URLs", () => {
  const { catalog } = fixture();
  assert.equal(catalog.channel, "stable");
  assert.equal(catalog.sequence, 9);
  assert.deepEqual(
    catalog.artifacts.map(({ role, componentId, kind }) => ({ role, componentId, kind })),
    [
      { role: "reason-runtime", componentId: "kalvoice.runtime.llama-cpp", kind: "runtime" },
      { role: "reason-model", componentId: "kalvoice.reasoner.qwen3-5-0-8b-q8", kind: "model" },
      { role: "speech-model", componentId: "kalvoice.speech.whisper.tiny-en", kind: "model" },
    ],
  );
  assert.equal(catalog.artifacts[0].artifactKey.startsWith("components/v1/runtime/"), true);
});

test("catalog metadata rejects widening, role substitution, wrong targets, and validity escape", () => {
  const { entries } = fixture();
  const invalid = [
    { ...catalogPayload(entries), privateKey: "forbidden" },
    { ...catalogPayload(entries), arch: "aarch64" },
    { ...catalogPayload(entries), reasoningAbi: "other.v1" },
    { ...catalogPayload(entries), entries: [entries[0], entries[0], entries[2]] },
    { ...catalogPayload(entries), defaultSpeechComponentId: "kalvoice.speech.whisper.base-en" },
  ];
  for (const payload of invalid) {
    assert.throws(
      () => parseVerifiedComponentCatalog(compact("kalcode-local-component-catalog.v1", payload)),
      /component/,
    );
  }
  const escaped = structuredClone(entries);
  const decoded = JSON.parse(Buffer.from(escaped[0].token.split(".")[1], "base64url"));
  decoded.expiresAt = EXPIRES - 1;
  escaped[0].token = compact("kalcode-local-component.v1", decoded);
  assert.throws(
    () => parseVerifiedComponentCatalog(compact("kalcode-local-component-catalog.v1", catalogPayload(escaped))),
    /validity/,
  );
});

test("one upload plan contains only signed content-addressed component objects", () => {
  const { catalog, token } = fixture();
  const catalogSha256 = createHash("sha256").update(token).digest("hex");
  const artifacts = catalog.artifacts.map((artifact) => ({
    ...artifact,
    path: `C:\\stage\\${artifact.file}`,
  }));
  const plan = buildComponentPublishPlan({
    bucket: "kalcode-releases",
    catalog: { ...catalog, include: true },
    catalogPath: "C:\\stage\\catalog.jws",
    catalogSha256,
    artifacts,
  });
  assert.equal(plan.filter(({ kind }) => kind === "artifact").length, 3);
  assert.equal(plan.filter(({ kind }) => kind === "catalog").length, 1);
  assert.equal(new Set(plan.map(({ key }) => key)).size, plan.length);
  assert.equal(plan.at(-1).key, componentCatalogKey(catalog, catalogSha256));
  assert.match(plan[0].argv.join(" "), /max-age=31536000/);

  const resumed = buildComponentPublishPlan({
    bucket: "kalcode-releases",
    catalog: { ...catalog, include: false },
    catalogPath: "C:\\stage\\catalog.jws",
    catalogSha256,
    artifacts: artifacts.map((artifact, index) => ({ ...artifact, include: index !== 0 })),
  });
  assert.equal(resumed.length, 2);
  assert.ok(resumed.every(({ kind }) => kind === "artifact"));
  assert.throws(
    () =>
      buildComponentPublishPlan({
        bucket: "kalcode-releases",
        catalog,
        catalogPath: "catalog.jws",
        catalogSha256,
        artifacts: artifacts.slice(1),
      }),
    /publication set/,
  );
});

test("D1 component claims are immutable and pointer advancement exact-CASes the observed sequence", () => {
  const migration = readFileSync(
    new URL("../../apps/website/migrations/0006_component_publication.sql", import.meta.url),
    "utf8",
  );
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(migration);
  const { catalog, token } = fixture();
  const publication = {
    catalog,
    catalogSha256: createHash("sha256").update(token).digest("hex"),
    catalogSizeBytes: Buffer.byteLength(token),
    publishedAt: "2026-09-25T12:00:00.000Z",
  };
  assert.equal(db.prepare(buildComponentVersionClaimStatement(publication)).all().length, 1);
  for (const artifact of catalog.artifacts) {
    assert.equal(db.prepare(buildComponentArtifactClaimStatement(catalog, artifact)).all().length, 1);
  }
  assert.equal(db.prepare(buildComponentPointerAdvanceStatement(catalog, null)).all().length, 1);
  const observed = db.prepare(buildComponentPointerReadStatement(catalog)).get();
  assert.deepEqual(componentPublicationRowProblems(observed, publication), []);

  const nextCatalog = { ...catalog, sequence: 10 };
  const next = { ...publication, catalog: nextCatalog, catalogSha256: "e".repeat(64) };
  assert.equal(db.prepare(buildComponentVersionClaimStatement(next)).all().length, 1);
  for (const artifact of nextCatalog.artifacts) {
    assert.equal(db.prepare(buildComponentArtifactClaimStatement(nextCatalog, artifact)).all().length, 1);
  }
  const racingCatalog = { ...catalog, sequence: 11 };
  const racing = { ...publication, catalog: racingCatalog, catalogSha256: "f".repeat(64) };
  assert.equal(db.prepare(buildComponentVersionClaimStatement(racing)).all().length, 1);
  for (const artifact of racingCatalog.artifacts) {
    assert.equal(db.prepare(buildComponentArtifactClaimStatement(racingCatalog, artifact)).all().length, 1);
  }
  assert.equal(db.prepare(buildComponentPointerAdvanceStatement(racingCatalog, observed)).all().length, 1);
  assert.equal(db.prepare(buildComponentPointerAdvanceStatement(nextCatalog, observed)).all().length, 0);
  assert.equal(db.prepare(buildComponentPointerReadStatement(catalog)).get().sequence, 11);
  assert.match(
    componentPublicationRowProblems(observed, { ...publication, catalog: { ...catalog, sequence: 8 } })[0],
    /newer/,
  );
  db.close();
});
