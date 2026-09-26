const CHANNELS = new Set(["stable", "beta", "dev"]);
const TARGETS = new Set(["windows/x86_64", "macos/aarch64"]);
const ROLES = new Set(["reason-runtime", "reason-model", "speech-model"]);
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_CATALOG_BYTES = 192 * 1024;
const MAX_COMPONENT_TOKEN_BYTES = 32 * 1024;
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024 * 1024;
const REASONING_RUNTIME_ID = "kalvoice.runtime.llama-cpp";
const REASONING_MODEL_ID = "kalvoice.reasoner.qwen3-5-0-8b-q8";
const REASONING_ABI = "kalvoice-llama-cpp.v1";
const SPEECH_ABI = "kalvoice-whisper-ggml.v1";
const SPEECH_IDS = new Set([
  "kalvoice.speech.whisper.tiny-en",
  "kalvoice.speech.whisper.base-en",
  "kalvoice.speech.whisper.small-en",
  "kalvoice.speech.whisper.base",
  "kalvoice.speech.whisper.small",
]);

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${label} has an invalid field set`);
  }
}

function safeToken(value, label, maximum = 128) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    !SAFE_TOKEN.test(value) ||
    value.includes("..")
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function positiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`${label} is invalid`);
  return value;
}

function timestamp(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is invalid`);
  return value;
}

function base64urlJson(segment, label) {
  if (typeof segment !== "string" || !/^[A-Za-z0-9_-]+$/.test(segment)) throw new Error(`${label} is malformed`);
  const bytes = Buffer.from(segment, "base64url");
  if (bytes.toString("base64url") !== segment) throw new Error(`${label} is malformed`);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} is malformed`);
  }
}

function compactJws(token, type, maximum, label) {
  if (typeof token !== "string" || Buffer.byteLength(token) > maximum || token.trim() !== token) {
    throw new Error(`${label} is malformed`);
  }
  const segments = token.split(".");
  if (segments.length !== 3 || !/^[A-Za-z0-9_-]{86}$/.test(segments[2])) throw new Error(`${label} is malformed`);
  const header = base64urlJson(segments[0], `${label} header`);
  exactKeys(header, ["alg", "typ", "kid"], `${label} header`);
  safeToken(header.kid, `${label} key id`, 64);
  if (header.alg !== "EdDSA" || header.typ !== type) throw new Error(`${label} header is invalid`);
  return { header, payload: base64urlJson(segments[1], `${label} payload`) };
}

function componentPayload(token, catalog, role) {
  const { header, payload } = compactJws(
    token,
    "kalcode-local-component.v1",
    MAX_COMPONENT_TOKEN_BYTES,
    "component token",
  );
  exactKeys(
    payload,
    [
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
    ],
    "component manifest",
  );
  if (payload.schemaVersion !== 1 || payload.keyId !== header.kid || header.kid !== catalog.keyId) {
    throw new Error("component signing authority is invalid");
  }
  safeToken(payload.componentId, "component id");
  safeToken(payload.version, "component version", 64);
  positiveInteger(payload.sequence, "component sequence");
  positiveInteger(payload.sizeBytes, "component size", MAX_ARTIFACT_BYTES);
  if (!SHA256.test(payload.sha256 ?? "")) throw new Error("component digest is invalid");
  if (payload.platform !== catalog.platform || payload.arch !== catalog.arch)
    throw new Error("component target is invalid");
  const expected =
    role === "reason-runtime"
      ? { id: REASONING_RUNTIME_ID, kind: "runtime", abi: REASONING_ABI }
      : role === "reason-model"
        ? { id: REASONING_MODEL_ID, kind: "model", abi: REASONING_ABI }
        : { id: payload.componentId, kind: "model", abi: SPEECH_ABI };
  if (
    payload.componentId !== expected.id ||
    payload.kind !== expected.kind ||
    payload.runtimeAbi !== expected.abi ||
    (role === "speech-model" && !SPEECH_IDS.has(payload.componentId))
  ) {
    throw new Error(`component ${role} identity is invalid`);
  }
  timestamp(payload.issuedAt, "component issue time");
  timestamp(payload.expiresAt, "component expiry time");
  if (payload.issuedAt > catalog.issuedAt || payload.expiresAt < catalog.expiresAt) {
    throw new Error("component validity does not contain the catalog validity window");
  }
  if (!Array.isArray(payload.licenses) || payload.licenses.length < 1 || payload.licenses.length > 16) {
    throw new Error("component licenses are invalid");
  }
  for (const license of payload.licenses) {
    exactKeys(license, ["spdxId", "noticeSha256"], "component license");
    safeToken(license.spdxId, "component license id", 64);
    if (!SHA256.test(license.noticeSha256 ?? "")) throw new Error("component license digest is invalid");
  }
  exactKeys(
    payload.provenance,
    ["sourceId", "sourceRevision", "sourceIntegritySha256", "buildRecipeSha256"],
    "component provenance",
  );
  if (
    typeof payload.provenance.sourceId !== "string" ||
    payload.provenance.sourceId.length < 1 ||
    payload.provenance.sourceId.length > 256 ||
    payload.provenance.sourceId.includes("://") ||
    payload.provenance.sourceId.includes("..") ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(payload.provenance.sourceId)
  ) {
    throw new Error("component provenance source is invalid");
  }
  safeToken(payload.provenance.sourceRevision, "component provenance revision");
  if (
    !SHA256.test(payload.provenance.sourceIntegritySha256 ?? "") ||
    !SHA256.test(payload.provenance.buildRecipeSha256 ?? "")
  ) {
    throw new Error("component provenance digest is invalid");
  }
  const url = new URL(payload.artifactUrl);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "kalcoded.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    payload.artifactUrl.includes("%") ||
    payload.artifactUrl.includes("\\")
  ) {
    throw new Error("component artifact URL is invalid");
  }
  const segments = url.pathname.split("/").slice(1);
  if (segments.length !== 7 || segments[0] !== "components" || segments[1] !== "v1") {
    throw new Error("component artifact URL is invalid");
  }
  const [, , kind, componentId, version, digest, file] = segments;
  safeToken(file, "component artifact file", 160);
  if (
    kind !== payload.kind ||
    componentId !== payload.componentId ||
    version !== payload.version ||
    digest !== payload.sha256
  ) {
    throw new Error("component artifact URL does not match its signed identity");
  }
  return {
    role,
    token,
    componentId: payload.componentId,
    kind: payload.kind,
    version: payload.version,
    sequence: payload.sequence,
    sizeBytes: payload.sizeBytes,
    sha256: payload.sha256,
    runtimeAbi: payload.runtimeAbi,
    licenses: payload.licenses,
    provenance: payload.provenance,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
    file,
    artifactKey: url.pathname.slice(1),
  };
}

/** Parses metadata only after the caller has cryptographically verified the catalog token. */
export function parseVerifiedComponentCatalog(token) {
  const { header, payload } = compactJws(
    token,
    "kalcode-local-component-catalog.v1",
    MAX_CATALOG_BYTES,
    "component catalog token",
  );
  exactKeys(
    payload,
    [
      "schemaVersion",
      "channel",
      "sequence",
      "platform",
      "arch",
      "reasoningAbi",
      "speechModelAbi",
      "entries",
      "defaultSpeechComponentId",
      "issuedAt",
      "expiresAt",
      "keyId",
    ],
    "component catalog",
  );
  if (payload.schemaVersion !== 1 || !CHANNELS.has(payload.channel) || payload.keyId !== header.kid) {
    throw new Error("component catalog authority is invalid");
  }
  positiveInteger(payload.sequence, "component catalog sequence");
  if (!TARGETS.has(`${payload.platform}/${payload.arch}`)) throw new Error("component catalog target is invalid");
  if (payload.reasoningAbi !== REASONING_ABI || payload.speechModelAbi !== SPEECH_ABI) {
    throw new Error("component catalog ABI is invalid");
  }
  timestamp(payload.issuedAt, "component catalog issue time");
  timestamp(payload.expiresAt, "component catalog expiry time");
  if (payload.expiresAt <= payload.issuedAt || payload.expiresAt - payload.issuedAt > 30 * 24 * 60 * 60) {
    throw new Error("component catalog validity window is invalid");
  }
  if (!Array.isArray(payload.entries) || payload.entries.length < 3 || payload.entries.length > 7) {
    throw new Error("component catalog entries are invalid");
  }
  const catalog = {
    channel: payload.channel,
    sequence: payload.sequence,
    platform: payload.platform,
    arch: payload.arch,
    reasoningAbi: payload.reasoningAbi,
    speechModelAbi: payload.speechModelAbi,
    defaultSpeechComponentId: payload.defaultSpeechComponentId,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
    keyId: payload.keyId,
  };
  const artifacts = payload.entries.map((entry, index) => {
    exactKeys(entry, ["role", "token"], `component catalog entry ${index}`);
    if (!ROLES.has(entry.role)) throw new Error("component catalog role is invalid");
    return componentPayload(entry.token, catalog, entry.role);
  });
  const reasonRuntime = artifacts.filter((entry) => entry.role === "reason-runtime");
  const reasonModel = artifacts.filter((entry) => entry.role === "reason-model");
  const speech = artifacts.filter((entry) => entry.role === "speech-model");
  if (
    reasonRuntime.length !== 1 ||
    reasonModel.length !== 1 ||
    speech.length < 1 ||
    speech.length > 5 ||
    new Set(artifacts.map((entry) => entry.componentId)).size !== artifacts.length ||
    !speech.some((entry) => entry.componentId === payload.defaultSpeechComponentId)
  ) {
    throw new Error("component catalog role set is invalid");
  }
  return { ...catalog, token, artifacts };
}

export function componentCatalogKey(catalog, catalogSha256) {
  if (!SHA256.test(catalogSha256 ?? "")) throw new Error("component catalog digest is invalid");
  return `components/v1/catalog/${catalog.channel}/${catalog.platform}/${catalog.arch}/${catalog.sequence}/${catalogSha256}.jws`;
}

function put(bucket, key, file, contentType) {
  return [
    "r2",
    "object",
    "put",
    `${bucket}/${key}`,
    "--file",
    file,
    "--content-type",
    contentType,
    "--cache-control",
    "public, max-age=31536000, immutable",
  ];
}

export function buildComponentPublishPlan({ bucket, catalog, catalogPath, catalogSha256, artifacts }) {
  if (typeof bucket !== "string" || !bucket) throw new Error("component bucket is invalid");
  if (typeof catalogPath !== "string" || !catalogPath) throw new Error("component catalog path is invalid");
  if (!Array.isArray(artifacts) || artifacts.length !== catalog.artifacts.length) {
    throw new Error("component artifact publication set is invalid");
  }
  const supplied = new Map(artifacts.map((artifact) => [artifact.componentId, artifact]));
  if (supplied.size !== artifacts.length) throw new Error("component artifact publication IDs must be unique");
  const uploads = [];
  for (const expected of catalog.artifacts) {
    const artifact = supplied.get(expected.componentId);
    if (
      !artifact ||
      artifact.artifactKey !== expected.artifactKey ||
      artifact.sha256 !== expected.sha256 ||
      artifact.sizeBytes !== expected.sizeBytes ||
      typeof artifact.path !== "string" ||
      !artifact.path
    ) {
      throw new Error("component artifact publication does not match the signed catalog");
    }
    if (artifact.include !== false) {
      uploads.push({
        kind: "artifact",
        componentId: expected.componentId,
        key: expected.artifactKey,
        path: artifact.path,
        argv: put(
          bucket,
          expected.artifactKey,
          artifact.path,
          expected.file.endsWith(".zip") ? "application/zip" : "application/octet-stream",
        ),
      });
    }
  }
  const key = componentCatalogKey(catalog, catalogSha256);
  if (catalog.include !== false) {
    uploads.push({
      kind: "catalog",
      key,
      path: catalogPath,
      argv: put(bucket, key, catalogPath, "application/jose"),
    });
  }
  return uploads;
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function buildComponentPointerReadStatement(catalog) {
  return `SELECT v.channel, v.platform, v.arch, v.sequence, v.catalog_key, v.catalog_sha256, v.catalog_size_bytes, v.issued_at, v.expires_at, v.published_at FROM component_catalog_pointers p JOIN component_catalog_versions v ON v.channel = p.channel AND v.platform = p.platform AND v.arch = p.arch AND v.sequence = p.sequence WHERE p.channel = ${sqlLiteral(catalog.channel)} AND p.platform = ${sqlLiteral(catalog.platform)} AND p.arch = ${sqlLiteral(catalog.arch)};`;
}

export function buildComponentVersionReadStatement(catalog) {
  return `SELECT channel, platform, arch, sequence, catalog_key, catalog_sha256, catalog_size_bytes, issued_at, expires_at, published_at FROM component_catalog_versions WHERE channel = ${sqlLiteral(catalog.channel)} AND platform = ${sqlLiteral(catalog.platform)} AND arch = ${sqlLiteral(catalog.arch)} AND sequence = ${catalog.sequence};`;
}

export function buildComponentArtifactsReadStatement(catalog) {
  return `SELECT role, component_id, kind, version, file, size_bytes, sha256, artifact_key, is_default FROM component_catalog_artifacts WHERE channel = ${sqlLiteral(catalog.channel)} AND platform = ${sqlLiteral(catalog.platform)} AND arch = ${sqlLiteral(catalog.arch)} AND sequence = ${catalog.sequence} ORDER BY component_id;`;
}

export function buildComponentVersionClaimStatement(publication) {
  const key = componentCatalogKey(publication.catalog, publication.catalogSha256);
  positiveInteger(publication.catalogSizeBytes, "component catalog size", MAX_CATALOG_BYTES);
  return `INSERT INTO component_catalog_versions (channel, platform, arch, sequence, catalog_key, catalog_sha256, catalog_size_bytes, issued_at, expires_at, published_at) SELECT ${sqlLiteral(publication.catalog.channel)}, ${sqlLiteral(publication.catalog.platform)}, ${sqlLiteral(publication.catalog.arch)}, ${publication.catalog.sequence}, ${sqlLiteral(key)}, ${sqlLiteral(publication.catalogSha256)}, ${publication.catalogSizeBytes}, ${publication.catalog.issuedAt}, ${publication.catalog.expiresAt}, ${sqlLiteral(publication.publishedAt)} WHERE NOT EXISTS (SELECT 1 FROM component_catalog_pointers WHERE channel = ${sqlLiteral(publication.catalog.channel)} AND platform = ${sqlLiteral(publication.catalog.platform)} AND arch = ${sqlLiteral(publication.catalog.arch)} AND sequence > ${publication.catalog.sequence}) ON CONFLICT(channel, platform, arch, sequence) DO NOTHING RETURNING channel, platform, arch, sequence, catalog_key, catalog_sha256, catalog_size_bytes, issued_at, expires_at, published_at;`;
}

export function buildComponentArtifactClaimStatement(catalog, artifact) {
  const isDefault = artifact.componentId === catalog.defaultSpeechComponentId ? 1 : 0;
  return `INSERT INTO component_catalog_artifacts (channel, platform, arch, sequence, role, component_id, kind, version, file, size_bytes, sha256, artifact_key, is_default) VALUES (${sqlLiteral(catalog.channel)}, ${sqlLiteral(catalog.platform)}, ${sqlLiteral(catalog.arch)}, ${catalog.sequence}, ${sqlLiteral(artifact.role)}, ${sqlLiteral(artifact.componentId)}, ${sqlLiteral(artifact.kind)}, ${sqlLiteral(artifact.version)}, ${sqlLiteral(artifact.file)}, ${artifact.sizeBytes}, ${sqlLiteral(artifact.sha256)}, ${sqlLiteral(artifact.artifactKey)}, ${isDefault}) ON CONFLICT(channel, platform, arch, sequence, component_id) DO NOTHING RETURNING component_id;`;
}

export function componentPublicationRowProblems(row, publication) {
  if (row === null || row === undefined) return [];
  if (!row || typeof row !== "object" || Array.isArray(row)) return ["component publication row is invalid"];
  if (row.sequence > publication.catalog.sequence) return ["component catalog pointer already names a newer sequence"];
  if (row.sequence < publication.catalog.sequence) return [];
  const exact = {
    channel: publication.catalog.channel,
    platform: publication.catalog.platform,
    arch: publication.catalog.arch,
    sequence: publication.catalog.sequence,
    catalog_key: componentCatalogKey(publication.catalog, publication.catalogSha256),
    catalog_sha256: publication.catalogSha256,
    catalog_size_bytes: publication.catalogSizeBytes,
    issued_at: publication.catalog.issuedAt,
    expires_at: publication.catalog.expiresAt,
    published_at: publication.publishedAt,
  };
  return Object.entries(exact).every(([key, value]) => row[key] === value)
    ? []
    : ["component catalog sequence already identifies different immutable metadata"];
}

export function componentPublicationExactProblems(row, publication) {
  const problems = componentPublicationRowProblems(row, publication);
  if (problems.length) return problems;
  return row?.sequence === publication.catalog.sequence
    ? []
    : ["component catalog pointer does not identify the published sequence"];
}

export function componentArtifactRowsProblems(rows, catalog) {
  if (!Array.isArray(rows)) return ["component artifact authority rows are invalid"];
  const expected = catalog.artifacts
    .map((artifact) => ({
      role: artifact.role,
      component_id: artifact.componentId,
      kind: artifact.kind,
      version: artifact.version,
      file: artifact.file,
      size_bytes: artifact.sizeBytes,
      sha256: artifact.sha256,
      artifact_key: artifact.artifactKey,
      is_default: artifact.componentId === catalog.defaultSpeechComponentId ? 1 : 0,
    }))
    .sort((left, right) => left.component_id.localeCompare(right.component_id));
  if (rows.length !== expected.length) return ["component artifact authority set is incomplete"];
  const actual = [...rows].sort((left, right) => String(left?.component_id).localeCompare(String(right?.component_id)));
  return expected.every((entry, index) => {
    const row = actual[index];
    return row && Object.entries(entry).every(([key, value]) => row[key] === value);
  })
    ? []
    : ["component artifact authority set differs from the signed catalog"];
}

export function buildComponentPointerAdvanceStatement(catalog, expectedCurrent) {
  let prior;
  let conflict;
  if (expectedCurrent === null) {
    prior = `NOT EXISTS (SELECT 1 FROM component_catalog_pointers WHERE channel = ${sqlLiteral(catalog.channel)} AND platform = ${sqlLiteral(catalog.platform)} AND arch = ${sqlLiteral(catalog.arch)})`;
    conflict = "0";
  } else {
    if (
      !expectedCurrent ||
      expectedCurrent.channel !== catalog.channel ||
      expectedCurrent.platform !== catalog.platform ||
      expectedCurrent.arch !== catalog.arch ||
      !Number.isSafeInteger(expectedCurrent.sequence) ||
      expectedCurrent.sequence < 1 ||
      expectedCurrent.sequence > catalog.sequence
    ) {
      throw new Error("expected component pointer is invalid");
    }
    prior = `EXISTS (SELECT 1 FROM component_catalog_pointers WHERE channel = ${sqlLiteral(catalog.channel)} AND platform = ${sqlLiteral(catalog.platform)} AND arch = ${sqlLiteral(catalog.arch)} AND sequence = ${expectedCurrent.sequence})`;
    conflict = `component_catalog_pointers.sequence = ${expectedCurrent.sequence}`;
  }
  return `INSERT INTO component_catalog_pointers (channel, platform, arch, sequence, updated_at) SELECT ${sqlLiteral(catalog.channel)}, ${sqlLiteral(catalog.platform)}, ${sqlLiteral(catalog.arch)}, ${catalog.sequence}, unixepoch() WHERE ${prior} ON CONFLICT(channel, platform, arch) DO UPDATE SET sequence = excluded.sequence, updated_at = excluded.updated_at WHERE ${conflict} RETURNING channel, platform, arch, sequence;`;
}
