import { beforeEach, describe, expect, it } from "vitest";
import {
  type ComponentArtifactRow,
  type ComponentBucket,
  type ComponentCatalogRow,
  type ComponentCatalogStore,
  type ComponentDeps,
  handleComponent,
  matchComponentRoute,
} from "../../worker/components";

const ORIGIN = "https://kalcoded.com";
const CATALOG_TOKEN = new TextEncoder().encode("header.catalog.signature");
const ARTIFACT = new Uint8Array(256 * 1024).map((_, index) => index % 251);
const ARTIFACT_SHA = "a".repeat(64);
const ARTIFACT_KEY = `components/v1/model/kalvoice.reasoner.test/1.0.0/${ARTIFACT_SHA}/reasoner.gguf`;

async function hash(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

class FakeCatalog implements ComponentCatalogStore {
  currentRow: ComponentCatalogRow | null = null;
  artifactRow: ComponentArtifactRow | null = null;

  async current(): Promise<ComponentCatalogRow | null> {
    return this.currentRow;
  }

  async artifact(key: string): Promise<ComponentArtifactRow | null> {
    return this.artifactRow?.artifact_key === key ? this.artifactRow : null;
  }
}

class FakeBucket implements ComponentBucket {
  objects = new Map<string, Uint8Array>();
  gets: Array<{ key: string; range?: { offset: number; length: number } }> = [];

  async get(key: string, options?: { range: { offset: number; length: number } }) {
    this.gets.push(options ? { key, range: options.range } : { key });
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    const body = options ? bytes.slice(options.range.offset, options.range.offset + options.range.length) : bytes;
    return {
      size: bytes.byteLength,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(body);
          controller.close();
        },
      }),
    };
  }
}

let catalog: FakeCatalog;
let bucket: FakeBucket;
let deps: ComponentDeps;
let logs: Record<string, string>[];

beforeEach(async () => {
  catalog = new FakeCatalog();
  bucket = new FakeBucket();
  logs = [];
  const catalogSha = await hash(CATALOG_TOKEN);
  catalog.currentRow = {
    channel: "stable",
    platform: "windows",
    arch: "x86_64",
    sequence: 7,
    catalog_key: `components/v1/catalog/stable/windows/x86_64/7/${catalogSha}.jws`,
    catalog_sha256: catalogSha,
    catalog_size_bytes: CATALOG_TOKEN.byteLength,
  };
  catalog.artifactRow = {
    artifact_key: ARTIFACT_KEY,
    file: "reasoner.gguf",
    size_bytes: ARTIFACT.byteLength,
    sha256: ARTIFACT_SHA,
  };
  bucket.objects.set(catalog.currentRow.catalog_key, CATALOG_TOKEN);
  bucket.objects.set(ARTIFACT_KEY, ARTIFACT);
  deps = { catalog, bucket, log: (entry) => logs.push(entry) };
});

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await handleComponent(new Request(`${ORIGIN}${path}`, init), deps);
  if (!response) throw new Error("component route was not handled");
  return response;
}

describe("component route ownership", () => {
  it("matches only exact native catalogs and immutable artifact paths", () => {
    expect(matchComponentRoute("/pricing")).toBeNull();
    expect(matchComponentRoute("/components/v1/catalog/stable/windows/x86_64.jws")).toMatchObject({
      kind: "catalog",
      channel: "stable",
      platform: "windows",
      arch: "x86_64",
    });
    expect(matchComponentRoute("/components/v1/catalog/stable/macos/aarch64.jws")?.kind).toBe("catalog");
    for (const path of [
      "/components/v1/catalog/stable/windows/aarch64.jws",
      "/components/v1/catalog/stable/linux/x86_64.jws",
      `/components/v1/model/%2e%2e/1.0.0/${ARTIFACT_SHA}/x.gguf`,
      `/components/v1/model/id/1.0.0/${ARTIFACT_SHA}/../x.gguf`,
      `/components/v1/model/id/1.0.0/${ARTIFACT_SHA}/x.gguf?mirror=1`,
    ]) {
      const url = new URL(`${ORIGIN}${path}`);
      expect(matchComponentRoute(url.pathname, url.search)?.kind).toBe("invalid");
    }
  });

  it("allows only GET and HEAD without touching publication state", async () => {
    const response = await request("/components/v1/catalog/stable/windows/x86_64.jws", { method: "POST" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
    expect(bucket.gets).toEqual([]);
  });
});

describe("signed catalog serving", () => {
  it("hashes the bounded D1-selected bytes and supports metadata-only HEAD and revalidation", async () => {
    const path = "/components/v1/catalog/stable/windows/x86_64.jws";
    const response = await request(path);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/jose");
    expect(response.headers.get("x-kalcode-component-authority")).toBe("d1-v1");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(CATALOG_TOKEN);
    const etag = response.headers.get("etag") ?? "";

    bucket.gets.length = 0;
    const head = await request(path, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(CATALOG_TOKEN.byteLength));
    expect(bucket.gets).toEqual([]);
    const unchanged = await request(path, { headers: { "if-none-match": etag } });
    expect(unchanged.status).toBe(304);
    expect(bucket.gets).toEqual([]);
  });

  it("fails closed for absent authority, widened rows, missing bytes, and checksum substitution", async () => {
    const path = "/components/v1/catalog/stable/windows/x86_64.jws";
    catalog.currentRow = null;
    expect((await request(path)).status).toBe(404);

    catalog.currentRow = {
      channel: "stable",
      platform: "windows",
      arch: "x86_64",
      sequence: 7,
      catalog_key: "components/v1/catalog/stable/windows/x86_64/7/not-content-addressed.jws",
      catalog_sha256: "b".repeat(64),
      catalog_size_bytes: CATALOG_TOKEN.byteLength,
    };
    expect((await request(path)).status).toBe(503);

    const expectedSha = await hash(CATALOG_TOKEN);
    catalog.currentRow = {
      ...catalog.currentRow,
      catalog_key: `components/v1/catalog/stable/windows/x86_64/7/${expectedSha}.jws`,
      catalog_sha256: expectedSha,
    };
    bucket.objects.delete(catalog.currentRow.catalog_key);
    expect((await request(path)).status).toBe(503);
    bucket.objects.set(catalog.currentRow.catalog_key, new TextEncoder().encode("tampered-catalog-token!"));
    expect((await request(path)).status).toBe(503);
    expect(logs).toEqual(
      expect.arrayContaining([expect.objectContaining({ event: "component.serve_failed", error: "Error" })]),
    );
    expect(JSON.stringify(logs)).not.toContain("x86_64");
  });
});

describe("published artifact serving", () => {
  it("streams exact full and ranged bytes with a digest ETag", async () => {
    const full = await request(`/${ARTIFACT_KEY}`);
    expect(full.status).toBe(200);
    expect(full.headers.get("etag")).toBe(`"${ARTIFACT_SHA}"`);
    expect(full.headers.get("content-length")).toBe(String(ARTIFACT.byteLength));
    expect(new Uint8Array(await full.arrayBuffer())).toEqual(ARTIFACT);

    const ranged = await request(`/${ARTIFACT_KEY}`, { headers: { range: "bytes=1000-1999" } });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-range")).toBe(`bytes 1000-1999/${ARTIFACT.byteLength}`);
    expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(ARTIFACT.slice(1000, 2000));
    expect(bucket.gets.at(-1)?.range).toEqual({ offset: 1000, length: 1000 });
  });

  it("uses signed D1 bounds for HEAD, If-Range, 416, and authorization", async () => {
    bucket.gets.length = 0;
    const head = await request(`/${ARTIFACT_KEY}`, { method: "HEAD", headers: { range: "bytes=0-9" } });
    expect(head.status).toBe(206);
    expect(head.headers.get("content-length")).toBe("10");
    expect(bucket.gets).toEqual([]);

    const changed = await request(`/${ARTIFACT_KEY}`, {
      headers: { range: "bytes=0-9", "if-range": '"different"' },
    });
    expect(changed.status).toBe(200);
    expect(changed.headers.get("content-range")).toBeNull();

    expect((await request(`/${ARTIFACT_KEY}`, { headers: { range: "bytes=999999-" } })).status).toBe(416);
    catalog.artifactRow = null;
    expect((await request(`/${ARTIFACT_KEY}`)).status).toBe(404);
  });

  it("never falls back when authorized R2 bytes are absent or have the wrong size", async () => {
    bucket.objects.delete(ARTIFACT_KEY);
    expect((await request(`/${ARTIFACT_KEY}`)).status).toBe(503);
    bucket.objects.set(ARTIFACT_KEY, ARTIFACT.slice(1));
    expect((await request(`/${ARTIFACT_KEY}`)).status).toBe(503);
  });
});
