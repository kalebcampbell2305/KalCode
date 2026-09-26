import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  disposeComponentPublication,
  parseComponentPublishArgs,
  prepareComponentPublication,
  publishPreparedComponents,
} from "./component-publish.mjs";
import { initializeComponentKey, signComponentCatalog, signComponentManifest } from "./component-signing.mjs";

const KID = "component-2026-1";
const SIGNATURE = Buffer.alloc(64).toString("base64url");
const ISSUED = 1_795_000_000;
const EXPIRES = ISSUED + 86_400;
const NOTICE = "b".repeat(64);
const SPEECH_COMPONENTS = [
  ["kalvoice.speech.whisper.tiny-en", "ggml-tiny.en.bin"],
  ["kalvoice.speech.whisper.base-en", "ggml-base.en.bin"],
  ["kalvoice.speech.whisper.small-en", "ggml-small.en.bin"],
  ["kalvoice.speech.whisper.base", "ggml-base.bin"],
  ["kalvoice.speech.whisper.small", "ggml-small.bin"],
];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function compact(type, payload) {
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: type, kid: KID })).toString("base64url");
  return `${header}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${SIGNATURE}`;
}

function manifest({ componentId, kind, version, runtimeAbi, file, bytes, sourceId, sourceRevision, license = "MIT" }) {
  const digest = sha256(bytes);
  return compact("kalcode-local-component.v1", {
    schemaVersion: 1,
    componentId,
    kind,
    version,
    sequence: 1,
    platform: "windows",
    arch: "x86_64",
    runtimeAbi,
    sizeBytes: bytes.length,
    sha256: digest,
    artifactUrl: `https://kalcoded.com/components/v1/${kind}/${componentId}/${version}/${digest}/${file}`,
    licenses: [{ spdxId: license, noticeSha256: NOTICE }],
    provenance: {
      sourceId,
      sourceRevision,
      sourceIntegritySha256: digest,
      buildRecipeSha256: "d".repeat(64),
    },
    issuedAt: ISSUED - 60,
    expiresAt: EXPIRES + 60,
    keyId: KID,
  });
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "kalcode-component-publisher-test-"));
  const items = [
    {
      role: "reason-runtime",
      componentId: "kalvoice.runtime.llama-cpp",
      kind: "runtime",
      version: "runtime-1",
      runtimeAbi: "kalvoice-llama-cpp.v1",
      file: "runtime.zip",
      bytes: Buffer.from("curated-runtime"),
      sourceId: "ggml-org/llama.cpp",
      sourceRevision: "runtime-revision",
    },
    {
      role: "reason-model",
      componentId: "kalvoice.reasoner.qwen3-5-0-8b-q8",
      kind: "model",
      version: "reasoner-1",
      runtimeAbi: "kalvoice-llama-cpp.v1",
      file: "reasoner.gguf",
      bytes: Buffer.from("reasoner-model"),
      sourceId: "ggml-org/Qwen3.5-0.8B-GGUF",
      sourceRevision: "reasoner-revision",
      license: "Apache-2.0",
    },
    ...SPEECH_COMPONENTS.map(([componentId, file], index) => ({
      role: "speech-model",
      componentId,
      kind: "model",
      version: "speech-1",
      runtimeAbi: "kalvoice-whisper-ggml.v1",
      file,
      bytes: Buffer.from(`speech-model-${index}`),
      sourceId: "ggerganov/whisper.cpp",
      sourceRevision: "speech-revision",
    })),
  ];
  const entries = items.map((item) => ({ role: item.role, token: manifest(item) }));
  const catalogToken = compact("kalcode-local-component-catalog.v1", {
    schemaVersion: 1,
    channel: "stable",
    sequence: 7,
    platform: "windows",
    arch: "x86_64",
    reasoningAbi: "kalvoice-llama-cpp.v1",
    speechModelAbi: "kalvoice-whisper-ggml.v1",
    entries,
    defaultSpeechComponentId: "kalvoice.speech.whisper.tiny-en",
    issuedAt: ISSUED,
    expiresAt: EXPIRES,
    keyId: KID,
  });
  const catalogPath = join(directory, "catalog.jws");
  const publicKeyPath = join(directory, "component-public.json");
  const evidencePath = join(directory, "runtime-build.json");
  writeFileSync(catalogPath, `${catalogToken}\n`);
  writeFileSync(
    publicKeyPath,
    JSON.stringify({ schemaVersion: 1, alg: "EdDSA", kid: KID, x: Buffer.alloc(32).toString("base64url") }),
  );
  const artifactEntries = items.map((item) => {
    const path = join(directory, item.file);
    writeFileSync(path, item.bytes);
    return { componentId: item.componentId, path, evidencePath: item.role === "reason-runtime" ? evidencePath : null };
  });
  writeFileSync(
    evidencePath,
    JSON.stringify({
      schemaVersion: 1,
      componentId: items[0].componentId,
      kind: "runtime",
      version: items[0].version,
      platform: "windows",
      arch: "x86_64",
      runtimeAbi: "kalvoice-llama-cpp.v1",
      source: {
        id: items[0].sourceId,
        revision: items[0].sourceRevision,
        file: "upstream.zip",
        size: items[0].bytes.length,
        sha256: sha256(items[0].bytes),
      },
      artifact: { file: items[0].file, size: items[0].bytes.length, sha256: sha256(items[0].bytes) },
      recipeSha256: "d".repeat(64),
      licenses: [{ spdxId: "MIT", noticeSha256: NOTICE }],
      memberCount: 2,
      codeMemberCount: 1,
      signing: {
        provider: "azure-artifact-signing",
        allCodeSigned: true,
        timestamped: true,
        publisherIdentityBound: true,
      },
      createdAt: new Date((ISSUED - 120) * 1000).toISOString(),
    }),
  );
  const packetPath = join(directory, "packet.json");
  writeFileSync(
    packetPath,
    JSON.stringify({ schemaVersion: 1, catalogPath, publicKeyPath, artifacts: artifactEntries }),
  );
  const contract = {
    runtime: {
      componentId: items[0].componentId,
      kind: "runtime",
      version: items[0].version,
      runtimeAbi: items[0].runtimeAbi,
      windowsX86_64: {
        source: {
          id: items[0].sourceId,
          revision: items[0].sourceRevision,
          file: "upstream.zip",
          sizeBytes: items[0].bytes.length,
          sha256: sha256(items[0].bytes),
        },
        licenses: [{ spdxId: "MIT", noticeSha256: NOTICE }],
        extractEntries: ["runtime.exe", "runtime.dll"],
        codeEntries: ["runtime.exe"],
      },
    },
    reasoningModel: {
      componentId: items[1].componentId,
      version: items[1].version,
      artifactFile: items[1].file,
      source: {
        id: items[1].sourceId,
        revision: items[1].sourceRevision,
        sizeBytes: items[1].bytes.length,
        sha256: sha256(items[1].bytes),
      },
      licenses: [{ spdxId: "Apache-2.0", noticeSha256: NOTICE }],
    },
    speechModels: {
      sourceId: items[2].sourceId,
      sourceRevision: items[2].sourceRevision,
      defaultComponentId: items[2].componentId,
      license: { spdxId: "MIT", noticeSha256: NOTICE },
      components: items.slice(2).map((item) => ({
        componentId: item.componentId,
        file: item.file,
        sizeBytes: item.bytes.length,
        sha256: sha256(item.bytes),
      })),
    },
  };
  return { directory, packetPath, catalogToken, items, contract };
}

function sqliteRemote() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(
    readFileSync(new URL("../../apps/website/migrations/0006_component_publication.sql", import.meta.url), "utf8"),
  );
  const objects = new Map();
  const puts = [];
  return {
    db,
    objects,
    puts,
    bucketAvailable: () => true,
    executeD1(statement) {
      return db.prepare(statement).all();
    },
    getR2Object(key, destination) {
      const bytes = objects.get(key);
      if (!bytes) return false;
      writeFileSync(destination, bytes);
      return true;
    },
    putR2Object(upload) {
      puts.push(upload.key);
      objects.set(upload.key, readFileSync(upload.path));
    },
    fetch: null,
  };
}

function verification(value) {
  const packet = JSON.parse(readFileSync(value.packetPath, "utf8"));
  return {
    contract: value.contract,
    trustedPublicKeyPath: packet.publicKeyPath,
    verifyCatalog() {},
    verifyManifest() {},
  };
}

test("the publisher uses both real verification boundaries before it creates a plan", async (t) => {
  const value = fixture();
  t.after(() => rmSync(value.directory, { recursive: true, force: true }));
  const calls = [];
  const publication = await prepareComponentPublication(value.packetPath, {
    ...verification(value),
    verifyCatalog: (options) => calls.push(["catalog", options]),
    verifyManifest: (options) => calls.push(["manifest", options]),
  });
  t.after(() => disposeComponentPublication(publication));
  assert.equal(calls.filter(([kind]) => kind === "catalog").length, 1);
  assert.equal(calls.filter(([kind]) => kind === "manifest").length, 7);
  assert.equal(publication.uploads.length, 8);
  assert.equal(publication.publishedAt, new Date(ISSUED * 1000).toISOString());
  assert.ok(publication.uploads.every(({ key }) => key.startsWith("components/v1/")));
  const packet = JSON.parse(readFileSync(value.packetPath, "utf8"));
  assert.notEqual(publication.catalogPath, packet.catalogPath);
  assert.notEqual(publication.artifacts[0].path, packet.artifacts[0].path);
  assert.equal(basename(publication.artifacts[0].path), publication.artifacts[0].file);
  const artifactSnapshot = readFileSync(publication.artifacts[0].path);
  writeFileSync(packet.catalogPath, "changed-after-verification\n");
  writeFileSync(packet.artifacts[0].path, "changed-after-verification");
  assert.equal(readFileSync(publication.catalogPath, "utf8"), value.catalogToken);
  assert.deepEqual(readFileSync(publication.artifacts[0].path), artifactSnapshot);
});

test("a production catalog missing one approved speech model fails before remote publication", async (t) => {
  const value = fixture();
  t.after(() => rmSync(value.directory, { recursive: true, force: true }));
  const packet = JSON.parse(readFileSync(value.packetPath, "utf8"));
  const omittedId = SPEECH_COMPONENTS.at(-1)[0];
  const retainedItems = value.items.filter(({ componentId }) => componentId !== omittedId);
  packet.artifacts = packet.artifacts.filter(({ componentId }) => componentId !== omittedId);
  writeFileSync(value.packetPath, JSON.stringify(packet));
  const entries = retainedItems.map((item) => ({ role: item.role, token: manifest(item) }));
  const incompleteCatalog = compact("kalcode-local-component-catalog.v1", {
    schemaVersion: 1,
    channel: "stable",
    sequence: 7,
    platform: "windows",
    arch: "x86_64",
    reasoningAbi: "kalvoice-llama-cpp.v1",
    speechModelAbi: "kalvoice-whisper-ggml.v1",
    entries,
    defaultSpeechComponentId: "kalvoice.speech.whisper.tiny-en",
    issuedAt: ISSUED,
    expiresAt: EXPIRES,
    keyId: KID,
  });
  writeFileSync(packet.catalogPath, `${incompleteCatalog}\n`);

  await assert.rejects(
    prepareComponentPublication(value.packetPath, verification(value)),
    /complete approved speech model set/,
  );
});

test("the production catalog default must match the compiled component contract", async (t) => {
  const value = fixture();
  t.after(() => rmSync(value.directory, { recursive: true, force: true }));
  const packet = JSON.parse(readFileSync(value.packetPath, "utf8"));
  const entries = value.items.map((item) => ({ role: item.role, token: manifest(item) }));
  const wrongDefaultCatalog = compact("kalcode-local-component-catalog.v1", {
    schemaVersion: 1,
    channel: "stable",
    sequence: 7,
    platform: "windows",
    arch: "x86_64",
    reasoningAbi: "kalvoice-llama-cpp.v1",
    speechModelAbi: "kalvoice-whisper-ggml.v1",
    entries,
    defaultSpeechComponentId: "kalvoice.speech.whisper.base-en",
    issuedAt: ISSUED,
    expiresAt: EXPIRES,
    keyId: KID,
  });
  writeFileSync(packet.catalogPath, `${wrongDefaultCatalog}\n`);

  await assert.rejects(
    prepareComponentPublication(value.packetPath, verification(value)),
    /default speech model does not match/,
  );
});

test("the real Rust signer accepts every release-owned publisher snapshot basename", {
  skip: process.platform !== "win32",
}, async (t) => {
  const value = fixture();
  t.after(() => rmSync(value.directory, { recursive: true, force: true }));
  const packet = JSON.parse(readFileSync(value.packetPath, "utf8"));
  const storePath = join(value.directory, "component-test-key.dpapi");
  const publicKey = initializeComponentKey({ storePath, kid: "component-publisher-integration" });
  writeFileSync(packet.publicKeyPath, JSON.stringify(publicKey));
  const now = Math.floor(Date.now() / 1000);
  const entries = [];
  for (const [index, item] of value.items.entries()) {
    const artifactEntry = packet.artifacts.find((candidate) => candidate.componentId === item.componentId);
    assert.ok(artifactEntry);
    const digest = sha256(item.bytes);
    const inputPath = join(value.directory, `manifest-${index}.json`);
    const outputPath = join(value.directory, `manifest-${index}.jws`);
    writeFileSync(
      inputPath,
      JSON.stringify({
        schemaVersion: 1,
        componentId: item.componentId,
        kind: item.kind,
        version: item.version,
        sequence: 1,
        platform: "windows",
        arch: "x86_64",
        runtimeAbi: item.runtimeAbi,
        sizeBytes: item.bytes.length,
        sha256: digest,
        artifactUrl: `https://kalcoded.com/components/v1/${item.kind}/${item.componentId}/${item.version}/${digest}/${item.file}`,
        licenses: [{ spdxId: item.license ?? "MIT", noticeSha256: NOTICE }],
        provenance: {
          sourceId: item.sourceId,
          sourceRevision: item.sourceRevision,
          sourceIntegritySha256: digest,
          buildRecipeSha256: "d".repeat(64),
        },
        issuedAt: now - 10,
        expiresAt: now + 3600,
        keyId: publicKey.kid,
      }),
    );
    signComponentManifest({
      storePath,
      inputPath,
      artifactPath: artifactEntry.path,
      outputPath,
    });
    entries.push({ role: item.role, token: readFileSync(outputPath, "utf8").trim() });
  }
  assert.equal(entries.length, 7);
  assert.equal(entries.filter(({ role }) => role === "speech-model").length, 5);
  const catalogInputPath = join(value.directory, "catalog.json");
  rmSync(packet.catalogPath, { force: true });
  writeFileSync(
    catalogInputPath,
    JSON.stringify({
      schemaVersion: 1,
      channel: "stable",
      sequence: 7,
      platform: "windows",
      arch: "x86_64",
      reasoningAbi: "kalvoice-llama-cpp.v1",
      speechModelAbi: "kalvoice-whisper-ggml.v1",
      entries,
      defaultSpeechComponentId: "kalvoice.speech.whisper.tiny-en",
      issuedAt: now,
      expiresAt: now + 3500,
      keyId: publicKey.kid,
    }),
  );
  signComponentCatalog({ storePath, inputPath: catalogInputPath, outputPath: packet.catalogPath });
  const evidence = JSON.parse(readFileSync(packet.artifacts[0].evidencePath, "utf8"));
  evidence.createdAt = new Date((now - 120) * 1000).toISOString();
  writeFileSync(packet.artifacts[0].evidencePath, JSON.stringify(evidence));

  const publication = await prepareComponentPublication(value.packetPath, {
    contract: value.contract,
    trustedPublicKeyPath: packet.publicKeyPath,
  });
  t.after(() => disposeComponentPublication(publication));
  assert.deepEqual(
    publication.artifacts.map((artifact) => basename(artifact.path)),
    publication.artifacts.map((artifact) => artifact.file),
  );
});

test("curation, artifact, and contract mismatches fail before any remote publication", async (t) => {
  const value = fixture();
  t.after(() => rmSync(value.directory, { recursive: true, force: true }));
  const packet = JSON.parse(readFileSync(value.packetPath, "utf8"));
  await assert.rejects(
    prepareComponentPublication(value.packetPath, {
      ...verification(value),
      trustedPublicKeyPath: packet.catalogPath,
    }),
    /tracked component public key/,
  );
  writeFileSync(packet.catalogPath, `${value.catalogToken}\n\n`);
  await assert.rejects(prepareComponentPublication(value.packetPath, verification(value)), /canonical signer output/);
  writeFileSync(packet.catalogPath, `${value.catalogToken}\n`);
  const evidence = JSON.parse(readFileSync(packet.artifacts[0].evidencePath, "utf8"));
  evidence.signing.timestamped = false;
  writeFileSync(packet.artifacts[0].evidencePath, JSON.stringify(evidence));
  await assert.rejects(
    prepareComponentPublication(value.packetPath, {
      ...verification(value),
    }),
    /curation evidence/,
  );
  assert.throws(() => parseComponentPublishArgs(["--packet", value.packetPath]), /usage/);
});

test("remote publication resumes immutable objects, exact-CASes D1, and is idempotent", async (t) => {
  const value = fixture();
  t.after(() => rmSync(value.directory, { recursive: true, force: true }));
  const verifier = verification(value);
  const publication = await prepareComponentPublication(value.packetPath, verifier);
  t.after(() => disposeComponentPublication(publication));
  const remote = sqliteRemote();
  t.after(() => remote.db.close());
  remote.objects.set(publication.uploads[0].key, readFileSync(publication.uploads[0].path));
  await publishPreparedComponents(publication, {
    remote,
    verifyCatalog() {},
    verifyManifest() {},
    verifyPublic: false,
  });
  assert.equal(remote.puts.length, publication.uploads.length - 1);
  const firstPutCount = remote.puts.length;
  await publishPreparedComponents(publication, {
    remote,
    verifyCatalog() {},
    verifyManifest() {},
    verifyPublic: false,
  });
  assert.equal(remote.puts.length, firstPutCount);
  assert.equal(remote.db.prepare("SELECT COUNT(*) AS count FROM component_catalog_publications").get().count, 1);

  remote.objects.set(publication.uploads[0].key, Buffer.from("different"));
  await assert.rejects(
    publishPreparedComponents(publication, {
      remote,
      verifyCatalog() {},
      verifyManifest() {},
      verifyPublic: false,
    }),
    /different bytes/,
  );
});

test("an exact concurrent publisher can win during claims without creating a conflicting authority", async (t) => {
  const value = fixture();
  t.after(() => rmSync(value.directory, { recursive: true, force: true }));
  const publication = await prepareComponentPublication(value.packetPath, {
    ...verification(value),
  });
  t.after(() => disposeComponentPublication(publication));
  const remote = sqliteRemote();
  t.after(() => remote.db.close());
  const execute = remote.executeD1.bind(remote);
  let raced = false;
  remote.executeD1 = (statement) => {
    if (!raced && statement.startsWith("INSERT INTO component_catalog_artifacts")) {
      raced = true;
      for (const artifact of publication.catalog.artifacts) {
        const isDefault = artifact.componentId === publication.catalog.defaultSpeechComponentId ? 1 : 0;
        remote.db
          .prepare(
            "INSERT INTO component_catalog_artifacts (channel, platform, arch, sequence, role, component_id, kind, version, file, size_bytes, sha256, artifact_key, is_default) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            publication.catalog.channel,
            publication.catalog.platform,
            publication.catalog.arch,
            publication.catalog.sequence,
            artifact.role,
            artifact.componentId,
            artifact.kind,
            artifact.version,
            artifact.file,
            artifact.sizeBytes,
            artifact.sha256,
            artifact.artifactKey,
            isDefault,
          );
      }
      remote.db
        .prepare(
          "INSERT INTO component_catalog_pointers (channel, platform, arch, sequence, updated_at) VALUES (?, ?, ?, ?, unixepoch())",
        )
        .run(
          publication.catalog.channel,
          publication.catalog.platform,
          publication.catalog.arch,
          publication.catalog.sequence,
        );
    }
    return execute(statement);
  };
  await publishPreparedComponents(publication, {
    remote,
    verifyCatalog() {},
    verifyManifest() {},
    verifyPublic: false,
  });
  assert.equal(raced, true);
  assert.equal(remote.db.prepare("SELECT COUNT(*) AS count FROM component_catalog_publications").get().count, 1);
});

test("a lower concurrent pointer never satisfies the target publication postcondition", async (t) => {
  const value = fixture();
  t.after(() => rmSync(value.directory, { recursive: true, force: true }));
  const publication = await prepareComponentPublication(value.packetPath, verification(value));
  t.after(() => disposeComponentPublication(publication));
  const remote = sqliteRemote();
  t.after(() => remote.db.close());
  const execute = remote.executeD1.bind(remote);
  let raced = false;
  remote.executeD1 = (statement) => {
    if (!raced && statement.startsWith("INSERT INTO component_catalog_artifacts")) {
      raced = true;
      const digest = "e".repeat(64);
      remote.db
        .prepare(
          "INSERT INTO component_catalog_versions (channel, platform, arch, sequence, catalog_key, catalog_sha256, catalog_size_bytes, issued_at, expires_at, published_at) VALUES (?, ?, ?, 6, ?, ?, 1, ?, ?, ?)",
        )
        .run(
          publication.catalog.channel,
          publication.catalog.platform,
          publication.catalog.arch,
          `components/v1/catalog/${publication.catalog.channel}/${publication.catalog.platform}/${publication.catalog.arch}/6/${digest}.jws`,
          digest,
          publication.catalog.issuedAt,
          publication.catalog.expiresAt,
          publication.publishedAt,
        );
      for (const artifact of publication.catalog.artifacts) {
        remote.db
          .prepare(
            "INSERT INTO component_catalog_artifacts (channel, platform, arch, sequence, role, component_id, kind, version, file, size_bytes, sha256, artifact_key, is_default) VALUES (?, ?, ?, 6, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            publication.catalog.channel,
            publication.catalog.platform,
            publication.catalog.arch,
            artifact.role,
            artifact.componentId,
            artifact.kind,
            artifact.version,
            artifact.file,
            artifact.sizeBytes,
            artifact.sha256,
            artifact.artifactKey,
            artifact.componentId === publication.catalog.defaultSpeechComponentId ? 1 : 0,
          );
      }
      remote.db
        .prepare(
          "INSERT INTO component_catalog_pointers (channel, platform, arch, sequence, updated_at) VALUES (?, ?, ?, 6, unixepoch())",
        )
        .run(publication.catalog.channel, publication.catalog.platform, publication.catalog.arch);
    }
    return execute(statement);
  };
  await assert.rejects(
    publishPreparedComponents(publication, {
      remote,
      verifyCatalog() {},
      verifyManifest() {},
      verifyPublic: false,
    }),
    /compare-and-set/,
  );
  assert.equal(remote.db.prepare("SELECT sequence FROM component_catalog_pointers").get().sequence, 6);
});

test("public proof requires the D1 catalog and exact bounded artifact ranges", async (t) => {
  const value = fixture();
  t.after(() => rmSync(value.directory, { recursive: true, force: true }));
  const publication = await prepareComponentPublication(value.packetPath, {
    ...verification(value),
  });
  t.after(() => disposeComponentPublication(publication));
  const remote = sqliteRemote();
  t.after(() => remote.db.close());
  remote.fetch = async (url, options) => {
    if (String(url).includes("/catalog/")) {
      return new Response(value.catalogToken, {
        status: 200,
        headers: {
          "content-type": "application/jose",
          "content-length": String(Buffer.byteLength(value.catalogToken)),
          "x-kalcode-component-authority": "d1-v1",
        },
      });
    }
    const artifact = publication.artifacts.find((candidate) => String(url).endsWith(candidate.artifactKey));
    assert.ok(artifact);
    const requested = /^bytes=0-(\d+)$/.exec(options.headers.range);
    assert.ok(requested);
    const length = Number(requested[1]) + 1;
    const bytes = readFileSync(artifact.path).subarray(0, length);
    return new Response(bytes, {
      status: 206,
      headers: {
        "content-length": String(bytes.length),
        "content-range": `bytes 0-${bytes.length - 1}/${artifact.sizeBytes}`,
        etag: `"${artifact.sha256}"`,
        "x-kalcode-component-authority": "d1-v1",
      },
    });
  };
  await publishPreparedComponents(publication, { remote, verifyCatalog() {}, verifyManifest() {} });
});

test("public proof aborts a stalled route within its explicit deadline", async (t) => {
  const value = fixture();
  t.after(() => rmSync(value.directory, { recursive: true, force: true }));
  const publication = await prepareComponentPublication(value.packetPath, verification(value));
  t.after(() => disposeComponentPublication(publication));
  const remote = sqliteRemote();
  t.after(() => remote.db.close());
  remote.fetch = (_url, { signal }) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  await assert.rejects(
    publishPreparedComponents(publication, {
      remote,
      verifyCatalog() {},
      verifyManifest() {},
      publicRequestTimeoutMs: 5,
    }),
    /aborted|timeout/i,
  );
});
