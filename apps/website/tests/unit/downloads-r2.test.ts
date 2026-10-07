import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getPlatformProxy } from "wrangler";
import {
  type DownloadDeps,
  downloadDepsFromEnv,
  handleDownload,
  MANIFEST_KEY,
  type ReleaseBucket,
} from "../../worker/downloads";
import { releaseCatalog } from "../../worker/release-catalog";
import { syntheticUpdaterDescriptor } from "./fixtures/updater-descriptor";

// Runs the download handler against workerd's local R2 simulation (in memory, never the real
// bucket) to check the parts a fake cannot: real etags, ranged reads and streamed bodies.

const VERSION = "0.1.0";
const FILE = "KalCode_0.1.0_x64-setup.exe";
const KEY = `releases/${VERSION}/${FILE}`;
const INSTALLER = new Uint8Array(256 * 1024).map((_, i) => i % 251);

type Proxy = Awaited<ReturnType<typeof getPlatformProxy<{ RELEASES: R2Bucket; DB: D1Database }>>>;
let proxy: Proxy;
let deps: DownloadDeps;

beforeAll(async () => {
  proxy = await getPlatformProxy<{ RELEASES: R2Bucket; DB: D1Database }>({
    configPath: fileURLToPath(new URL("./fixtures/wrangler.r2.jsonc", import.meta.url)),
    persist: false,
  });
  const bucket = proxy.env.RELEASES;
  await bucket.put(KEY, INSTALLER, { httpMetadata: { contentType: "application/octet-stream" } });
  await bucket.put(
    MANIFEST_KEY,
    JSON.stringify({
      schemaVersion: 1,
      latest: {
        version: VERSION,
        channel: "preview",
        publishedAt: "2026-09-24T12:00:00.000Z",
        commit: "0123456789abcdef0123456789abcdef01234567",
        notesUrl: "/updates#release-0-1-0",
        platforms: [
          {
            os: "windows",
            arch: "x64",
            label: "Windows 10 (1809) or later, 64-bit",
            kind: "nsis",
            file: FILE,
            url: "/download/windows-x64",
            pinnedUrl: `/download/${VERSION}/${FILE}`,
            size: INSTALLER.byteLength,
            sha256: "b".repeat(64),
            signed: false,
          },
        ],
      },
      unavailable: [],
    }),
  );
  deps = {
    bucket: bucket as unknown as ReleaseBucket,
    assets: { fetch: async () => new Response("<h1>404</h1>", { headers: { "content-type": "text/html" } }) },
    log: () => undefined,
  };
  const migration = await readFile(
    new URL("../../migrations/0003_release_publication_pointers.sql", import.meta.url),
    "utf8",
  );
  await proxy.env.DB.exec(migration.replace(/^--.*$/gm, "").replace(/\r?\n/g, " "));
}, 60_000);

afterAll(async () => {
  await proxy?.dispose();
});

async function download(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await handleDownload(new Request(`https://kalcoded.com${path}`, init), deps);
  if (!response) throw new Error("not handled");
  return response;
}

// Each case drives a local R2 (Wrangler) instance; on a shared gate machine one case took over
// vitest's 5 s default (gate 37334756000), so give them the same headroom as the D1 API tests.
describe("downloads against local R2", { timeout: 60_000 }, () => {
  it.each(["stable", "beta", "dev"] as const)(
    "serves immutable %s updater claims before pointer rollout without changing the preview",
    async (channel) => {
      const version = "1.4.0";
      const file = `KalCode_${version}_x64-setup.exe`;
      const digest = "d".repeat(64);
      const body = JSON.stringify(syntheticUpdaterDescriptor(version, file, digest, INSTALLER.byteLength, channel));
      const hash = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body))),
        (n) => n.toString(16).padStart(2, "0"),
      ).join("");
      const key = `releases/updater/${channel}/${version}/${hash}.json`;
      const artifact = `releases/updater/${channel}/${version}/${digest}/${file}`;
      await proxy.env.RELEASES.put(key, body);
      await proxy.env.RELEASES.put(artifact, INSTALLER);
      await proxy.env.DB.prepare("INSERT INTO release_publication_versions VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(
          channel,
          version,
          "0000014",
          key,
          `releases/${version}/${hash}.json`,
          hash,
          hash,
          "2026-09-25T12:00:00.000Z",
        )
        .run();
      const preview = {
        ...downloadDepsFromEnv({
          DB: proxy.env.DB,
          RELEASES: proxy.env.RELEASES,
          ASSETS: deps.assets as Fetcher,
          RELEASE_CATALOG_ENABLED: "false",
        }),
        log: () => undefined,
      };
      const request = async (path: string, init: RequestInit = {}) => {
        const response = await handleDownload(new Request(`https://kalcoded.com${path}`, init), preview);
        if (!response) throw new Error("Updater QA route was not handled");
        return response;
      };
      const pointers = await proxy.env.DB.prepare(
        "SELECT channel,version FROM release_publication_pointers ORDER BY channel",
      ).all();
      const legacy = JSON.stringify({ version: "0.0.1", notes: "Existing preview feed" });
      await proxy.env.RELEASES.put(`releases/updater/${channel}.json`, legacy);
      const response = await request(`/releases/updater/${channel}/${version}.json`);
      expect(response?.status).toBe(200);
      expect(response?.headers.get("X-KalCode-Release-Authority")).toBe("d1-v1");
      expect(await response?.text()).toBe(body);
      const range = await request(`/${artifact}`, { headers: { range: "bytes=1000-1999" } });
      expect(range?.status).toBe(206);
      expect(new Uint8Array(await range.arrayBuffer())).toEqual(INSTALLER.slice(1000, 2000));
      const latest = await request(`/releases/updater/${channel}.json`);
      expect(await latest?.text()).toBe(legacy);
      expect(latest?.headers.has("X-KalCode-Release-Authority")).toBe(false);
      const download = await request("/download/windows-x64");
      expect(download?.status).toBe(200);
      expect(new Uint8Array(await download.arrayBuffer())).toEqual(INSTALLER);
      expect((await request("/download/macos-arm64"))?.status).toBe(404);
      const manifest = await request("/releases/latest.json");
      expect(await manifest.json()).toMatchObject({ latest: { channel: "preview" } });
      expect(manifest?.headers.has("X-KalCode-Release-Authority")).toBe(false);
      expect(
        await proxy.env.DB.prepare("SELECT channel,version FROM release_publication_pointers ORDER BY channel").all(),
      ).toMatchObject({ results: pointers.results });
      await proxy.env.RELEASES.put(key, "tampered");
      expect((await request(`/releases/updater/${channel}/${version}.json`))?.status).toBe(503);
      expect((await request(`/${artifact}`))?.status).toBe(503);
    },
  );

  it("never falls back to legacy version bytes when pre-rollout D1 authority is missing or unavailable", async () => {
    const path = "/releases/updater/stable/8.8.8.json";
    await proxy.env.RELEASES.put(path.slice(1), "unclaimed legacy bytes");
    const preview = {
      ...downloadDepsFromEnv({
        DB: proxy.env.DB,
        RELEASES: proxy.env.RELEASES,
        ASSETS: deps.assets as Fetcher,
        RELEASE_CATALOG_ENABLED: "false",
      }),
      log: () => undefined,
    };
    expect((await handleDownload(new Request(`https://kalcoded.com${path}`), preview))?.status).toBe(404);
    const broken = {
      ...preview,
      catalog: {
        get: async () => {
          throw new Error("synthetic D1 outage");
        },
      },
    };
    expect((await handleDownload(new Request(`https://kalcoded.com${path}`), broken))?.status).toBe(503);
  });

  it("resolves authoritative D1 publication and verifies real R2 descriptor bytes", async () => {
    const body = JSON.stringify(
      syntheticUpdaterDescriptor(VERSION, FILE, "a".repeat(64), INSTALLER.byteLength, "stable"),
    );
    const hash = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body))),
      (n) => n.toString(16).padStart(2, "0"),
    ).join("");
    const key = `releases/updater/stable/${VERSION}/${hash}.json`;
    await proxy.env.RELEASES.put(key, body);
    await proxy.env.DB.prepare("INSERT INTO release_publication_versions VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(
        "stable",
        VERSION,
        "0000001",
        key,
        `releases/${VERSION}/${hash}.json`,
        hash,
        hash,
        "2026-09-25T12:00:00.000Z",
      )
      .run();
    await proxy.env.DB.prepare("INSERT INTO release_publication_pointers VALUES (?, ?, ?, ?)")
      .bind("stable", VERSION, "0000001", 1)
      .run();
    const authoritative = { ...deps, catalog: releaseCatalog(proxy.env.DB) };
    const request = new Request("https://kalcoded.com/releases/updater/stable.json");
    const response = await handleDownload(request, authoritative);
    expect(response?.status).toBe(200);
    expect(response?.headers.get("X-KalCode-Release-Authority")).toBe("d1-v1");
    expect(await response?.text()).toBe(body);
    await proxy.env.RELEASES.put(key, "tampered");
    expect((await handleDownload(request, authoritative))?.status).toBe(503);
    // A preview channel with nothing published answers "no update" (204), which the desktop
    // client shows as up to date, never a 404 that it reports as a connection failure.
    for (const channel of ["beta", "dev"]) {
      for (const method of ["GET", "HEAD"]) {
        const empty = await handleDownload(
          new Request(`https://kalcoded.com/releases/updater/${channel}.json`, { method }),
          authoritative,
        );
        expect(empty?.status).toBe(204);
        expect(empty?.headers.get("cache-control")).toBe("public, max-age=60, must-revalidate");
        expect(empty?.headers.get("X-KalCode-Release-Authority")).toBe("d1-v1");
        expect(await empty?.text()).toBe("");
      }
    }
    // Exact versions on an empty channel are still not found.
    expect(
      (await handleDownload(new Request(`https://kalcoded.com/releases/updater/beta/${VERSION}.json`), authoritative))
        ?.status,
    ).toBe(404);
  });

  it("keeps a missing Stable publication loud instead of reporting no update", async () => {
    const nothingPublished = { ...deps, catalog: { get: async () => null } };
    expect(
      (await handleDownload(new Request("https://kalcoded.com/releases/updater/stable.json"), nothingPublished))
        ?.status,
    ).toBe(404);
    expect(
      (await handleDownload(new Request("https://kalcoded.com/releases/updater/beta.json"), nothingPublished))?.status,
    ).toBe(204);
  });

  it("refuses INSERT OR REPLACE changes to an immutable publication version", async () => {
    const original = [
      "beta",
      "9.9.9",
      "0000009",
      `releases/updater/beta/9.9.9/${"a".repeat(64)}.json`,
      `releases/9.9.9/${"b".repeat(64)}.json`,
      "a".repeat(64),
      "b".repeat(64),
      "2026-09-25T12:00:00.000Z",
    ] as const;
    const insert =
      "INSERT INTO release_publication_versions (channel, version, precedence_key, updater_descriptor_key, download_descriptor_key, updater_descriptor_sha256, download_descriptor_sha256, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)";
    await proxy.env.DB.prepare(insert)
      .bind(...original)
      .run();

    const replace = insert.replace("INSERT INTO", "INSERT OR REPLACE INTO");
    await expect(
      proxy.env.DB.prepare(replace)
        .bind(...original)
        .run(),
    ).resolves.toBeDefined();

    const changed = [...original] as string[];
    changed[4] = `releases/9.9.9/${"c".repeat(64)}.json`;
    changed[6] = "c".repeat(64);
    await expect(
      proxy.env.DB.prepare(replace)
        .bind(...changed)
        .run(),
    ).rejects.toThrow("release publication versions are immutable");
    expect(
      await proxy.env.DB.prepare(
        "SELECT channel, version, precedence_key, updater_descriptor_key, download_descriptor_key, updater_descriptor_sha256, download_descriptor_sha256, published_at FROM release_publication_versions WHERE channel = ? AND version = ?",
      )
        .bind(original[0], original[1])
        .first(),
    ).toEqual({
      channel: original[0],
      version: original[1],
      precedence_key: original[2],
      updater_descriptor_key: original[3],
      download_descriptor_key: original[4],
      updater_descriptor_sha256: original[5],
      download_descriptor_sha256: original[6],
      published_at: original[7],
    });
  });
  it("streams updater feeds, detached signatures and installer ranges from canonical keys", async () => {
    const root = `releases/updater/stable/${VERSION}`;
    const feed = JSON.stringify({ version: VERSION, notes: "Synthetic route fixture" });
    await proxy.env.RELEASES.put("releases/updater/stable.json", feed);
    await proxy.env.RELEASES.put(`${root}.json`, feed);
    await proxy.env.RELEASES.put(`${root}/${FILE}`, INSTALLER);
    await proxy.env.RELEASES.put(`${root}/${FILE}.sig`, "synthetic-signature");
    expect(await (await download("/releases/updater/stable.json")).text()).toBe(feed);
    expect(await (await download(`/${root}.json`)).text()).toBe(feed);
    const signature = await download(`/${root}/${FILE}.sig`);
    expect(signature.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await signature.text()).toBe("synthetic-signature");
    const artifact = await download(`/${root}/${FILE}`, { headers: { range: "bytes=1000-1999" } });
    expect(artifact.status).toBe(206);
    expect(new Uint8Array(await artifact.arrayBuffer())).toEqual(INSTALLER.slice(1000, 2000));
  });
  it("streams the whole installer with R2's etag", async () => {
    const head = await proxy.env.RELEASES.head(KEY);
    const response = await download("/download/windows-x64");
    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe(head?.httpEtag);
    expect(response.headers.get("content-length")).toBe(String(INSTALLER.byteLength));
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(INSTALLER);
  });

  it("serves byte ranges from R2", async () => {
    const response = await download(`/download/${VERSION}/${FILE}`, { headers: { range: "bytes=1000-1999" } });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(`bytes 1000-1999/${INSTALLER.byteLength}`);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(INSTALLER.slice(1000, 2000));
  });

  it("revalidates with the R2 etag", async () => {
    const first = await download("/download/windows-x64", { method: "HEAD" });
    const etag = first.headers.get("etag") ?? "";
    const again = await download("/download/windows-x64", { headers: { "if-none-match": etag } });
    expect(again.status).toBe(304);
  });

  it("returns the manifest and 404s for a missing pinned file", async () => {
    const manifest = await download("/releases/latest.json");
    expect(((await manifest.json()) as { latest: { version: string } }).latest.version).toBe(VERSION);
    expect((await download(`/download/0.0.9/${FILE}`)).status).toBe(404);
  });
});
