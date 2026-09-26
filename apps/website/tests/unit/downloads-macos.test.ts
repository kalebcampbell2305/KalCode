import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getPlatformProxy } from "wrangler";
import type { ReleasePlatform } from "../../src/data/releases";
import {
  type DownloadDeps,
  handleDownload,
  MANIFEST_KEY,
  matchDownloadRoute,
  type ReleaseBucket,
  type ReleaseObjectBody,
} from "../../worker/downloads";
import type { PublishedRelease } from "../../worker/release-catalog";
import { releaseCatalog } from "../../worker/release-catalog";

const ORIGIN = "https://kalcoded.com";
const VERSION = "1.2.3";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const MAC_FILE = `KalCode_${VERSION}_arm64.dmg`;
const WINDOWS_FILE = `KalCode_${VERSION}_x64-setup.exe`;
const MAC_BYTES = new TextEncoder().encode("synthetic signed and notarized dmg bytes");
const WINDOWS_BYTES = new TextEncoder().encode("MZ synthetic signed installer bytes");
const MAC_SHA = "a".repeat(64);
const WINDOWS_SHA = "b".repeat(64);

const macDmg = (overrides: Partial<ReleasePlatform> = {}): ReleasePlatform => ({
  os: "macos",
  arch: "arm64",
  label: "macOS 14 or later, Apple silicon",
  kind: "dmg",
  file: MAC_FILE,
  url: "/download/macos-arm64",
  pinnedUrl: `/download/${VERSION}/${MAC_FILE}`,
  size: MAC_BYTES.byteLength,
  sha256: MAC_SHA,
  signed: true,
  ...overrides,
});

const windowsNsis = (): ReleasePlatform => ({
  os: "windows",
  arch: "x64",
  label: "Windows 10 (1809) or later, 64-bit",
  kind: "nsis",
  file: WINDOWS_FILE,
  url: "/download/windows-x64",
  pinnedUrl: `/download/${VERSION}/${WINDOWS_FILE}`,
  size: WINDOWS_BYTES.byteLength,
  sha256: WINDOWS_SHA,
  signed: true,
});

interface Harness {
  deps: DownloadDeps;
  objects: Map<string, Uint8Array>;
  headKeys: string[];
  getKeys: string[];
  descriptorKey: string;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function harness(platforms: ReleasePlatform[], withCatalog = true): Promise<Harness> {
  const objects = new Map<string, Uint8Array>();
  const headKeys: string[] = [];
  const getKeys: string[] = [];
  const uploaded = new Date("2026-09-25T12:00:00.000Z");
  const descriptorBytes = new TextEncoder().encode(
    JSON.stringify({
      schemaVersion: 1,
      latest: {
        version: VERSION,
        channel: "stable",
        publishedAt: uploaded.toISOString(),
        commit: COMMIT,
        notesUrl: `/updates#release-${VERSION.replaceAll(".", "-")}`,
        platforms,
      },
      unavailable: [],
    }),
  );
  const descriptorSha = await sha256(descriptorBytes);
  const descriptorKey = `releases/${VERSION}/${descriptorSha}.json`;
  const updaterSha = "c".repeat(64);
  const row: PublishedRelease = {
    channel: "stable",
    version: VERSION,
    download_descriptor_key: descriptorKey,
    updater_descriptor_key: `releases/updater/stable/${VERSION}/${updaterSha}.json`,
    download_descriptor_sha256: descriptorSha,
    updater_descriptor_sha256: updaterSha,
  };
  objects.set(withCatalog ? descriptorKey : MANIFEST_KEY, descriptorBytes);
  for (const platform of platforms) {
    const bytes = platform.os === "macos" ? MAC_BYTES : WINDOWS_BYTES;
    const key = withCatalog
      ? `releases/${VERSION}/${platform.sha256}/${platform.file}`
      : `releases/${VERSION}/${platform.file}`;
    objects.set(key, bytes);
  }
  const metadata = (key: string, bytes: Uint8Array) => ({
    size: bytes.byteLength,
    httpEtag: `"etag-${key}"`,
    uploaded,
  });
  const bucket: ReleaseBucket = {
    async head(key) {
      headKeys.push(key);
      const bytes = objects.get(key);
      return bytes ? metadata(key, bytes) : null;
    },
    async get(key, options) {
      getKeys.push(key);
      const bytes = objects.get(key);
      if (!bytes) return null;
      const selected = options?.range
        ? bytes.slice(options.range.offset, options.range.offset + options.range.length)
        : bytes;
      const body: ReleaseObjectBody = {
        ...metadata(key, bytes),
        body: new Response(selected).body as ReadableStream,
        text: async () => new TextDecoder().decode(bytes),
      };
      return body;
    },
  };
  const deps: DownloadDeps = {
    ...(withCatalog
      ? {
          catalog: {
            async get(channel, version) {
              return channel === "stable" && (version === undefined || version === VERSION) ? row : null;
            },
          },
        }
      : {}),
    bucket,
    assets: {
      fetch: async () => new Response("<h1>Not found</h1>", { headers: { "content-type": "text/html" } }),
    },
    log: () => undefined,
  };
  return { deps, objects, headKeys, getKeys, descriptorKey };
}

async function download(h: Harness, path: string): Promise<Response | null> {
  return handleDownload(new Request(`${ORIGIN}${path}`), h.deps);
}

describe("GET /download/macos-arm64", () => {
  it("registers a latest-installer route for Apple silicon", () => {
    expect(matchDownloadRoute("/download/macos-arm64")).toEqual({
      kind: "latest-installer",
      os: "macos",
      arch: "arm64",
    });
  });

  it("does not activate from the legacy mutable manifest", async () => {
    const h = await harness([macDmg()], false);
    const response = await download(h, "/download/macos-arm64");
    expect(response?.status).toBe(404);
    expect(h.getKeys).not.toContain(MANIFEST_KEY);
  });

  it("returns 404 when the D1-selected manifest has no Mac artifact", async () => {
    const h = await harness([windowsNsis()]);
    expect((await download(h, "/download/macos-arm64"))?.status).toBe(404);
  });

  it("serves a Mac-only published DMG with the correct representation", async () => {
    const h = await harness([macDmg()]);
    const response = await download(h, "/download/macos-arm64");
    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toBe("application/x-apple-diskimage");
    expect(response?.headers.get("content-disposition")).toBe(`attachment; filename="${MAC_FILE}"`);
    expect(response?.headers.get("x-kalcode-version")).toBe(VERSION);
    expect(new Uint8Array(await response?.arrayBuffer())).toEqual(MAC_BYTES);
  });

  it("preserves Windows routing when one stable descriptor publishes both platforms", async () => {
    const h = await harness([windowsNsis(), macDmg()]);
    const mac = await download(h, "/download/macos-arm64");
    const windows = await download(h, "/download/windows-x64");
    expect(mac?.headers.get("content-disposition")).toContain(MAC_FILE);
    expect(windows?.headers.get("content-disposition")).toContain(WINDOWS_FILE);
    expect(new Uint8Array(await windows?.arrayBuffer())).toEqual(WINDOWS_BYTES);
  });

  it("selects only a canonical DMG when other Mac formats are present", async () => {
    const wrongFormat = macDmg({
      kind: "appimage",
      file: `KalCode-${VERSION}-arm64.AppImage`,
      pinnedUrl: `/download/${VERSION}/KalCode-${VERSION}-arm64.AppImage`,
      sha256: "d".repeat(64),
    });
    const h = await harness([wrongFormat, macDmg()]);
    const response = await download(h, "/download/macos-arm64");
    expect(response?.headers.get("content-disposition")).toContain(MAC_FILE);

    const withoutDmg = await harness([wrongFormat]);
    expect((await download(withoutDmg, "/download/macos-arm64"))?.status).toBe(404);
  });

  it("dereferences the D1 manifest to the immutable SHA-addressed artifact", async () => {
    const h = await harness([macDmg()]);
    const response = await download(h, "/download/macos-arm64");
    expect(response?.status).toBe(200);
    await response?.arrayBuffer();
    const immutableKey = `releases/${VERSION}/${MAC_SHA}/${MAC_FILE}`;
    expect(h.getKeys).toContain(h.descriptorKey);
    expect(h.headKeys).toContain(immutableKey);
    expect(h.getKeys).toContain(immutableKey);
    expect(h.headKeys).not.toContain(`releases/${VERSION}/${MAC_FILE}`);
    expect(h.getKeys).not.toContain(`releases/${VERSION}/${MAC_FILE}`);
  });

  it("resolves the stable Mac descriptor through the real local D1 publication pointer", async () => {
    const proxy = await getPlatformProxy<{ RELEASES: R2Bucket; DB: D1Database }>({
      configPath: fileURLToPath(new URL("./fixtures/wrangler.r2.jsonc", import.meta.url)),
      persist: false,
    });
    try {
      const migration = await readFile(
        new URL("../../migrations/0003_release_publication_pointers.sql", import.meta.url),
        "utf8",
      );
      await proxy.env.DB.exec(migration.replace(/^--.*$/gm, "").replace(/\r?\n/g, " "));
      const descriptorBytes = new TextEncoder().encode(
        JSON.stringify({
          schemaVersion: 1,
          latest: {
            version: VERSION,
            channel: "stable",
            publishedAt: "2026-09-25T12:00:00.000Z",
            commit: COMMIT,
            notesUrl: `/updates#release-${VERSION.replaceAll(".", "-")}`,
            platforms: [macDmg()],
          },
          unavailable: [],
        }),
      );
      const descriptorSha = await sha256(descriptorBytes);
      const descriptorKey = `releases/${VERSION}/${descriptorSha}.json`;
      const updaterSha = "e".repeat(64);
      await proxy.env.RELEASES.put(descriptorKey, descriptorBytes);
      await proxy.env.RELEASES.put(`releases/${VERSION}/${MAC_SHA}/${MAC_FILE}`, MAC_BYTES);
      await proxy.env.DB.prepare(
        "INSERT INTO release_publication_versions (channel, version, precedence_key, updater_descriptor_key, download_descriptor_key, updater_descriptor_sha256, download_descriptor_sha256, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
        .bind(
          "stable",
          VERSION,
          "0000001",
          `releases/updater/stable/${VERSION}/${updaterSha}.json`,
          descriptorKey,
          updaterSha,
          descriptorSha,
          "2026-09-25T12:00:00.000Z",
        )
        .run();
      await proxy.env.DB.prepare(
        "INSERT INTO release_publication_pointers (channel, version, precedence_key, updated_at) VALUES (?, ?, ?, ?)",
      )
        .bind("stable", VERSION, "0000001", 1)
        .run();
      const response = await handleDownload(new Request(`${ORIGIN}/download/macos-arm64`), {
        bucket: proxy.env.RELEASES as unknown as ReleaseBucket,
        catalog: releaseCatalog(proxy.env.DB),
        assets: {
          fetch: async () => new Response("<h1>Not found</h1>", { headers: { "content-type": "text/html" } }),
        },
        log: () => undefined,
      });
      expect(response?.status).toBe(200);
      expect(response?.headers.get("content-type")).toBe("application/x-apple-diskimage");
      expect(new Uint8Array(await response?.arrayBuffer())).toEqual(MAC_BYTES);
    } finally {
      await proxy.dispose();
    }
  }, 60_000);
});
