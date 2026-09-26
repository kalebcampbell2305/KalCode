import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getPlatformProxy } from "wrangler";
import { type ComponentBucket, type ComponentDeps, componentCatalog, handleComponent } from "../../worker/components";

// Executes against workerd's local D1 and R2 simulations only. No production bindings are used.
type Proxy = Awaited<ReturnType<typeof getPlatformProxy<{ RELEASES: R2Bucket; DB: D1Database }>>>;
let proxy: Proxy;
let deps: ComponentDeps;

const ARTIFACT = new Uint8Array(256 * 1024).map((_, index) => index % 251);

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

beforeAll(async () => {
  proxy = await getPlatformProxy<{ RELEASES: R2Bucket; DB: D1Database }>({
    configPath: fileURLToPath(new URL("./fixtures/wrangler.r2.jsonc", import.meta.url)),
    persist: false,
  });
  const migration = await readFile(new URL("../../migrations/0006_component_publication.sql", import.meta.url), "utf8");
  await proxy.env.DB.exec(migration.replace(/^--.*$/gm, "").replace(/\r?\n/g, " "));
  deps = {
    catalog: componentCatalog(proxy.env.DB),
    bucket: proxy.env.RELEASES as unknown as ComponentBucket,
    log: () => undefined,
  };
}, 60_000);

afterAll(async () => {
  await proxy?.dispose();
});

async function serve(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await handleComponent(new Request(`https://kalcoded.com${path}`, init), deps);
  if (!response) throw new Error("component route was not handled");
  return response;
}

async function insertVersion(channel: string, sequence: number, token: Uint8Array) {
  const digest = await sha256(token);
  const key = `components/v1/catalog/${channel}/windows/x86_64/${sequence}/${digest}.jws`;
  await proxy.env.RELEASES.put(key, token);
  await proxy.env.DB.prepare(
    "INSERT INTO component_catalog_versions (channel, platform, arch, sequence, catalog_key, catalog_sha256, catalog_size_bytes, issued_at, expires_at, published_at) VALUES (?, 'windows', 'x86_64', ?, ?, ?, ?, 1, 1000, '2026-09-25T12:00:00.000Z')",
  )
    .bind(channel, sequence, key, digest, token.byteLength)
    .run();
  return { digest, key };
}

async function insertArtifact(
  channel: string,
  sequence: number,
  role: "reason-runtime" | "reason-model" | "speech-model",
  componentId: string,
  kind: "runtime" | "model",
  bytes: Uint8Array,
  isDefault = false,
) {
  const digest = await sha256(bytes);
  const file = kind === "runtime" ? `${componentId}.zip` : `${componentId}.gguf`;
  const key = `components/v1/${kind}/${componentId}/1.0.0/${digest}/${file}`;
  await proxy.env.RELEASES.put(key, bytes);
  await proxy.env.DB.prepare(
    "INSERT INTO component_catalog_artifacts (channel, platform, arch, sequence, role, component_id, kind, version, file, size_bytes, sha256, artifact_key, is_default) VALUES (?, 'windows', 'x86_64', ?, ?, ?, ?, '1.0.0', ?, ?, ?, ?, ?)",
  )
    .bind(channel, sequence, role, componentId, kind, file, bytes.byteLength, digest, key, isDefault ? 1 : 0)
    .run();
  return { digest, key, file };
}

async function completeCatalog(channel: string, sequence: number) {
  const runtime = await insertArtifact(
    channel,
    sequence,
    "reason-runtime",
    `kalvoice.runtime.test-${channel}-${sequence}`,
    "runtime",
    ARTIFACT,
  );
  await insertArtifact(
    channel,
    sequence,
    "reason-model",
    `kalvoice.reasoner.test-${channel}-${sequence}`,
    "model",
    ARTIFACT,
  );
  await insertArtifact(
    channel,
    sequence,
    "speech-model",
    `kalvoice.speech.test-${channel}-${sequence}`,
    "model",
    ARTIFACT,
    true,
  );
  return runtime;
}

describe("component publication authority against local D1 and R2", () => {
  it("requires a complete immutable role set and streams authoritative catalogs and ranges", async () => {
    const token = new TextEncoder().encode("header.catalog.signature");
    const version = await insertVersion("stable", 1, token);
    await expect(
      proxy.env.DB.prepare(
        "INSERT INTO component_catalog_pointers (channel, platform, arch, sequence, updated_at) VALUES ('stable', 'windows', 'x86_64', 1, 1)",
      ).run(),
    ).rejects.toThrow(/complete role set/);
    const runtime = await completeCatalog("stable", 1);
    await proxy.env.DB.prepare(
      "INSERT INTO component_catalog_pointers (channel, platform, arch, sequence, updated_at) VALUES ('stable', 'windows', 'x86_64', 1, 1)",
    ).run();

    const catalog = await serve("/components/v1/catalog/stable/windows/x86_64.jws");
    expect(catalog.status).toBe(200);
    expect(catalog.headers.get("etag")).toBe(`"${version.digest}"`);
    expect(new Uint8Array(await catalog.arrayBuffer())).toEqual(token);

    const artifact = await serve(`/${runtime.key}`, { headers: { range: "bytes=4096-8191" } });
    expect(artifact.status).toBe(206);
    expect(artifact.headers.get("content-range")).toBe(`bytes 4096-8191/${ARTIFACT.byteLength}`);
    expect(new Uint8Array(await artifact.arrayBuffer())).toEqual(ARTIFACT.slice(4096, 8192));

    await expect(
      insertArtifact("stable", 1, "speech-model", "kalvoice.speech.late", "model", ARTIFACT),
    ).rejects.toThrow(/artifact sets are immutable/);
    await expect(
      proxy.env.DB.prepare(
        "INSERT OR REPLACE INTO component_catalog_versions (channel, platform, arch, sequence, catalog_key, catalog_sha256, catalog_size_bytes, issued_at, expires_at, published_at) VALUES ('stable', 'windows', 'x86_64', 1, ?, ?, ?, 1, 1000, '2026-09-25T12:00:00.000Z')",
      )
        .bind(version.key, "f".repeat(64), token.byteLength)
        .run(),
    ).rejects.toThrow(/versions are immutable/);
  });

  it("serves activated history but never an unselected partial publication", async () => {
    const firstToken = new TextEncoder().encode("beta.catalog.one");
    await insertVersion("beta", 1, firstToken);
    const first = await completeCatalog("beta", 1);
    await proxy.env.DB.prepare(
      "INSERT INTO component_catalog_pointers (channel, platform, arch, sequence, updated_at) VALUES ('beta', 'windows', 'x86_64', 1, 1)",
    ).run();

    const secondToken = new TextEncoder().encode("beta.catalog.two");
    await insertVersion("beta", 2, secondToken);
    await completeCatalog("beta", 2);
    await proxy.env.DB.prepare(
      "UPDATE component_catalog_pointers SET sequence = 2, updated_at = 2 WHERE channel = 'beta' AND platform = 'windows' AND arch = 'x86_64'",
    ).run();
    expect((await serve(`/${first.key}`)).status).toBe(200);
    await expect(
      proxy.env.DB.prepare(
        "INSERT OR REPLACE INTO component_catalog_publications (channel, platform, arch, sequence, activated_at) VALUES ('beta', 'windows', 'x86_64', 2, 999)",
      ).run(),
    ).rejects.toThrow(/publication history is immutable/);
    await expect(
      insertArtifact("beta", 1, "speech-model", "kalvoice.speech.historical-late", "model", ARTIFACT),
    ).rejects.toThrow(/artifact sets are immutable/);

    await insertVersion("beta", 3, new TextEncoder().encode("beta.catalog.orphan"));
    const orphan = await insertArtifact(
      "beta",
      3,
      "reason-runtime",
      "kalvoice.runtime.unpublished",
      "runtime",
      ARTIFACT,
    );
    expect((await serve(`/${orphan.key}`)).status).toBe(404);
    await expect(
      proxy.env.DB.prepare(
        "INSERT INTO component_catalog_publications (channel, platform, arch, sequence, activated_at) VALUES ('beta', 'windows', 'x86_64', 3, 3)",
      ).run(),
    ).rejects.toThrow(/activated by its pointer/);
    await expect(
      proxy.env.DB.prepare(
        "UPDATE component_catalog_pointers SET sequence = 1, updated_at = 3 WHERE channel = 'beta' AND platform = 'windows' AND arch = 'x86_64'",
      ).run(),
    ).rejects.toThrow(/cannot regress/);
  });
});
