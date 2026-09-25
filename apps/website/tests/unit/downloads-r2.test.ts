import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getPlatformProxy } from "wrangler";
import { type DownloadDeps, handleDownload, MANIFEST_KEY, type ReleaseBucket } from "../../worker/downloads";

// Runs the download handler against workerd's local R2 simulation (in memory, never the real
// bucket) to check the parts a fake cannot: real etags, ranged reads and streamed bodies.

const VERSION = "0.1.0";
const FILE = "KalCode_0.1.0_x64-setup.exe";
const KEY = `releases/${VERSION}/${FILE}`;
const INSTALLER = new Uint8Array(256 * 1024).map((_, i) => i % 251);

type Proxy = Awaited<ReturnType<typeof getPlatformProxy<{ RELEASES: R2Bucket }>>>;
let proxy: Proxy;
let deps: DownloadDeps;

beforeAll(async () => {
  proxy = await getPlatformProxy<{ RELEASES: R2Bucket }>({
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
        notesUrl: "/changelog#release-0-1-0",
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
}, 60_000);

afterAll(async () => {
  await proxy?.dispose();
});

async function download(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await handleDownload(new Request(`https://kalcoded.com${path}`, init), deps);
  if (!response) throw new Error("not handled");
  return response;
}

describe("downloads against local R2", () => {
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
