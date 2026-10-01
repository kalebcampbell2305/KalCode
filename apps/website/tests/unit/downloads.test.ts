import { beforeEach, describe, expect, it } from "vitest";
import committedManifest from "../../src/data/releases.json";
import {
  contentTypeFor,
  type DownloadDeps,
  downloadDepsFromEnv,
  handleDownload,
  isValidVersion,
  LATEST_CACHE,
  MANIFEST_KEY,
  matchDownloadRoute,
  parseRange,
  parseReleaseManifest,
  type ReleaseBucket,
  type ReleaseObjectBody,
} from "../../worker/downloads";
import { IMMUTABLE_CACHE } from "../../worker/lib/security";
import { syntheticUpdaterDescriptor } from "./fixtures/updater-descriptor";

const ORIGIN = "https://kalcoded.com";
const VERSION = "0.1.0";
const FILE = "KalCode_0.1.0_x64-setup.exe";
const KEY = `releases/${VERSION}/${FILE}`;
const INSTALLER = new TextEncoder().encode("MZ fake installer bytes for tests");
const SHA = "a".repeat(64);

function manifest(overrides: Record<string, unknown> = {}) {
  return {
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
          sha256: SHA,
          signed: false,
        },
      ],
      ...overrides,
    },
    unavailable: [
      { os: "macos", label: "macOS", reason: "Not available yet." },
      { os: "linux", label: "Linux", reason: "Not available yet." },
    ],
  };
}

interface Harness {
  deps: DownloadDeps;
  objects: Map<string, Uint8Array>;
  logs: Record<string, string>[];
  ranges: ({ offset: number; length: number } | undefined)[];
  assetRequests: string[];
  failBucket(fail: boolean): void;
}

function harness(): Harness {
  const objects = new Map<string, Uint8Array>();
  const logs: Record<string, string>[] = [];
  const ranges: ({ offset: number; length: number } | undefined)[] = [];
  const assetRequests: string[] = [];
  let fail = false;
  const uploaded = new Date("2026-09-24T12:00:00.000Z");
  const meta = (key: string, bytes: Uint8Array) => ({ size: bytes.byteLength, httpEtag: `"etag-${key}"`, uploaded });
  const bucket: ReleaseBucket = {
    async head(key) {
      if (fail) throw new Error("R2 outage with internal detail");
      const bytes = objects.get(key);
      return bytes ? meta(key, bytes) : null;
    },
    async get(key, options) {
      if (fail) throw new Error("R2 outage with internal detail");
      const bytes = objects.get(key);
      if (!bytes) return null;
      ranges.push(options?.range);
      const slice = options?.range
        ? bytes.slice(options.range.offset, options.range.offset + options.range.length)
        : bytes;
      const body: ReleaseObjectBody = {
        ...meta(key, bytes),
        body: new Response(slice).body as ReadableStream,
        text: async () => new TextDecoder().decode(bytes),
      };
      return body;
    },
  };
  return {
    objects,
    logs,
    ranges,
    assetRequests,
    failBucket: (value) => {
      fail = value;
    },
    deps: {
      bucket,
      assets: {
        async fetch(request) {
          assetRequests.push(new URL(request.url).pathname);
          return new Response("<!doctype html><h1>This page is not here.</h1>", {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=0" },
          });
        },
      },
      log: (entry) => logs.push(entry),
    },
  };
}

function publish(h: Harness, doc: unknown = manifest()) {
  h.objects.set(KEY, INSTALLER);
  h.objects.set(MANIFEST_KEY, new TextEncoder().encode(JSON.stringify(doc)));
}

function get(path: string, init: RequestInit = {}): Request {
  return new Request(`${ORIGIN}${path}`, init);
}

async function download(h: Harness, path: string, init: RequestInit = {}): Promise<Response> {
  const response = await handleDownload(get(path, init), h.deps);
  if (!response) throw new Error(`${path} was not handled as a download`);
  return response;
}

let h: Harness;
beforeEach(() => {
  h = harness();
});

describe("download representation integrity", () => {
  it("uses strong comparison for If-Range", async () => {
    publish(h);
    const first = await download(h, "/download/windows-x64", { method: "HEAD" });
    const response = await download(h, "/download/windows-x64", {
      headers: { range: "bytes=0-3", "if-range": `W/${first.headers.get("etag")}` },
    });
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(INSTALLER);
  });

  it("rejects a changed representation between metadata and stream acquisition", async () => {
    publish(h);
    const bucket = h.deps.bucket;
    if (!bucket) throw new Error("fixture bucket missing");
    const original = bucket.get.bind(bucket);
    bucket.get = async (key, options) => {
      const object = await original(key, options);
      return object && key === KEY ? { ...object, httpEtag: '"replacement"' } : object;
    };
    expect((await download(h, "/download/windows-x64")).status).toBe(503);
  });
});

async function publishCatalog(publishedVersion = VERSION) {
  const doc = manifest({ channel: "stable" });
  doc.latest.version = publishedVersion;
  doc.latest.notesUrl = `/updates#release-${publishedVersion.split("+")[0]?.replaceAll(".", "-")}`;
  for (const platform of doc.latest.platforms) {
    platform.pinnedUrl = `/download/${publishedVersion}/${platform.file}`;
    platform.signed = true;
  }
  const downloadText = JSON.stringify(doc);
  const updaterText = JSON.stringify(
    syntheticUpdaterDescriptor(publishedVersion, FILE, SHA, INSTALLER.byteLength, "stable"),
  );
  const digest = async (text: string) =>
    Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  const downloadHash = await digest(downloadText);
  const updaterHash = await digest(updaterText);
  const row = {
    channel: "stable",
    version: publishedVersion,
    download_descriptor_key: `releases/${publishedVersion}/${downloadHash}.json`,
    updater_descriptor_key: `releases/updater/stable/${publishedVersion}/${updaterHash}.json`,
    download_descriptor_sha256: downloadHash,
    updater_descriptor_sha256: updaterHash,
  };
  h.objects.set(row.download_descriptor_key, new TextEncoder().encode(downloadText));
  h.objects.set(row.updater_descriptor_key, new TextEncoder().encode(updaterText));
  h.objects.set(`releases/${publishedVersion}/${SHA}/${FILE}`, INSTALLER);
  h.deps.catalog = {
    get: async (channel, version) =>
      channel === "stable" && (version === undefined || version === publishedVersion) ? row : null,
  };
  return row;
}

describe("D1 publication authority", () => {
  it("serves an encoded same-version build from its exact immutable D1 claim", async () => {
    const buildVersion = "0.1.7+218";
    const encodedVersion = encodeURIComponent(buildVersion);
    const row = await publishCatalog(buildVersion);

    const feed = await download(h, `/releases/updater/stable/${encodedVersion}.json`);
    expect(feed.status).toBe(200);
    expect(feed.headers.get("x-kalcode-release-authority")).toBe("d1-v1");
    expect((await feed.json()).version).toBe(buildVersion);

    h.objects.set(`releases/updater/stable/${buildVersion}/${SHA}/${FILE}`, INSTALLER);
    const artifact = await download(h, `/releases/updater/stable/${encodedVersion}/${SHA}/${FILE}`);
    expect(artifact.status).toBe(200);
    expect(new Uint8Array(await artifact.arrayBuffer())).toEqual(INSTALLER);

    const latest = await download(h, "/download/windows-x64");
    expect(latest.status).toBe(200);
    expect(latest.headers.get("x-kalcode-version")).toBe(buildVersion);

    h.objects.set(row.updater_descriptor_key, new TextEncoder().encode('{"version":"0.1.7+219"}'));
    expect((await download(h, `/releases/updater/stable/${encodedVersion}.json`)).status).toBe(503);
  });

  it("keeps the verified legacy release until the catalog authority is explicitly enabled", async () => {
    publish(h);
    const emptyDb = {
      prepare: () => ({ bind: () => ({ first: async () => null }) }),
    } as unknown as D1Database;
    const baseEnv = {
      DB: emptyDb,
      ASSETS: h.deps.assets as unknown as Fetcher,
      RELEASES: h.deps.bucket as unknown as R2Bucket,
    };

    for (const value of [undefined, "false", "TRUE", "1"]) {
      const deps = downloadDepsFromEnv({ ...baseEnv, RELEASE_CATALOG_ENABLED: value });
      const response = await handleDownload(get("/releases/latest.json"), deps);
      expect(response?.status).toBe(200);
      expect((await response?.json())?.latest.version).toBe(VERSION);
      expect(response?.headers.get("x-kalcode-release-authority")).toBeNull();
    }

    const enabled = downloadDepsFromEnv({ ...baseEnv, RELEASE_CATALOG_ENABLED: "true" });
    const response = await handleDownload(get("/releases/latest.json"), enabled);
    expect(response?.status).toBe(404);
    expect(response?.headers.get("x-kalcode-release-authority")).toBe("d1-v1");
  });

  it("does not publish orphan artifacts or detached signature evidence", async () => {
    h.deps.catalog = { get: async () => null };
    for (const key of [
      `releases/updater/stable/${VERSION}/${SHA}/${FILE}`,
      `releases/updater/stable/${VERSION}/${FILE}`,
      `releases/updater/stable/${VERSION}/${SHA}/${"b".repeat(64)}/${FILE}.sig`,
    ]) {
      h.objects.set(key, INSTALLER);
      expect((await download(h, `/${key}`)).status).toBe(404);
    }
  });
  it("selects immutable descriptors instead of mutable R2 pointers", async () => {
    await publishCatalog();
    h.objects.set(MANIFEST_KEY, new TextEncoder().encode("untrusted mutable pointer"));
    h.objects.set("releases/updater/stable.json", new TextEncoder().encode('{"version":"99.0.0"}'));
    for (const path of [
      MANIFEST_PATH_FOR_TEST,
      "/releases/updater/stable.json",
      `/releases/updater/stable/${VERSION}.json`,
    ]) {
      const response = await download(h, path);
      expect(response.status).toBe(200);
      expect(response.headers.get("x-kalcode-release-authority")).toBe("d1-v1");
      const body = await response.json();
      expect(path === MANIFEST_PATH_FOR_TEST ? body.latest.version : body.version).toBe(VERSION);
    }
    expect((await download(h, "/download/windows-x64")).status).toBe(200);
  });

  it("fails closed on missing publication, outage, and descriptor replacement", async () => {
    publish(h);
    h.deps.catalog = { get: async () => null };
    const missing = await download(h, "/releases/latest.json");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("x-kalcode-release-authority")).toBe("d1-v1");
    h.deps.catalog = {
      get: async () => {
        throw new Error("catalog unavailable");
      },
    };
    expect((await download(h, "/releases/latest.json")).status).toBe(503);
    const row = await publishCatalog();
    h.objects.set(row.download_descriptor_key, new TextEncoder().encode("{}"));
    expect((await download(h, "/releases/latest.json")).status).toBe(503);
  });

  it("serves only descriptor-bound artifacts and keeps detached signature evidence private", async () => {
    await publishCatalog();
    const root = `releases/updater/stable/${VERSION}/${SHA}`;
    h.objects.set(`${root}/${FILE}`, INSTALLER);
    expect((await download(h, `/${root}/${FILE}`)).status).toBe(200);
    h.objects.set(`${root}/${"b".repeat(64)}/${FILE}.sig`, INSTALLER);
    expect((await download(h, `/${root}/${"b".repeat(64)}/${FILE}.sig`)).status).toBe(404);
    h.objects.set(`${root}/unreferenced.exe`, INSTALLER);
    expect((await download(h, `/${root}/unreferenced.exe`)).status).toBe(404);
    h.objects.set(`${root}/${FILE}`, new Uint8Array(1));
    expect((await download(h, `/${root}/${FILE}`)).status).toBe(503);
    expect((await download(h, `/releases/updater/stable/${VERSION}/not-a-hash/${FILE}`)).status).toBe(404);
  });
});

const MANIFEST_PATH_FOR_TEST = "/releases/latest.json";

describe("signed updater object routes", () => {
  it("rejects oversized feed metadata without reading the object", async () => {
    h.objects.set("releases/updater/stable.json", new Uint8Array(65_537));
    expect((await download(h, "/releases/updater/stable.json")).status).toBe(503);
    expect(h.ranges).toHaveLength(0);
  });
  it.each(["stable", "beta", "dev"])("serves %s feed and immutable artifacts without listing", async (channel) => {
    const pointer = `releases/updater/${channel}.json`;
    const archive = `releases/updater/${channel}/${VERSION}.json`;
    const artifact = `releases/updater/${channel}/${VERSION}/${FILE}`;
    for (const key of [pointer, archive, artifact, `${artifact}.sig`]) {
      h.objects.set(key, INSTALLER);
      const response = await download(h, `/${key}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe(
        key === pointer ? "public, max-age=60, must-revalidate" : IMMUTABLE_CACHE,
      );
      expect(await response.text()).toBe(new TextDecoder().decode(INSTALLER));
      const head = await download(h, `/${key}`, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
    }
    expect((await download(h, `/releases/updater/${channel}/${VERSION}/`)).status).toBe(404);
    expect((await download(h, `/${pointer}`, { method: "POST" })).status).toBe(405);
  });

  it.each([
    "owner.json",
    "stable/01.2.3.json",
    "stable/0.1.0/file.exe%2Fsecret",
    "stable/0.1.0/secrets.txt",
    "stable/0.1.0/%2e%2e.exe",
    "stable/0.1.0/file.exe.sig.extra",
  ])("rejects invalid updater path %s", async (path) => {
    expect((await download(h, `/releases/updater/${path}`)).status).toBe(404);
  });
});

describe("route matching", () => {
  it("accepts canonical build revisions and decodes only their URL version segment", () => {
    const buildVersion = "0.1.7+218";
    const encodedVersion = encodeURIComponent(buildVersion);

    expect(isValidVersion(buildVersion)).toBe(true);
    expect(matchDownloadRoute(`/download/${encodedVersion}/${FILE}`)).toEqual({
      kind: "pinned",
      version: buildVersion,
      file: FILE,
    });
    expect(matchDownloadRoute(`/releases/updater/stable/${encodedVersion}.json`)).toEqual({
      kind: "updater",
      key: `releases/updater/stable/${buildVersion}.json`,
      file: `${buildVersion}.json`,
      mutable: false,
    });
    expect(matchDownloadRoute(`/releases/updater/stable/${encodedVersion}/${SHA}/${FILE}`)).toEqual({
      kind: "updater",
      key: `releases/updater/stable/${buildVersion}/${SHA}/${FILE}`,
      file: FILE,
      mutable: false,
    });
    const buildFile = "KalCode_0.1.7+218_x64-setup.exe";
    expect(
      matchDownloadRoute(`/releases/updater/stable/${encodedVersion}/${SHA}/${encodeURIComponent(buildFile)}`),
    ).toEqual({
      kind: "updater",
      key: `releases/updater/stable/${buildVersion}/${SHA}/${buildFile}`,
      file: buildFile,
      mutable: false,
    });
  });

  it.each(["0.1.7+0", "0.1.7+01", "0.1.7+65536", "0.1.7+build.1", "0.1.7+"])(
    "rejects non-canonical build revision %s",
    (version) => {
      expect(isValidVersion(version)).toBe(false);
      expect(matchDownloadRoute(`/download/${encodeURIComponent(version)}/${FILE}`)).toBeNull();
    },
  );

  it("claims only the download routes and leaves site pages alone", () => {
    expect(matchDownloadRoute("/download/windows-x64")).toEqual({
      kind: "latest-installer",
      os: "windows",
      arch: "x64",
    });
    expect(matchDownloadRoute("/releases/latest.json")).toEqual({ kind: "manifest" });
    expect(matchDownloadRoute(`/download/${VERSION}/${FILE}`)).toEqual({
      kind: "pinned",
      version: VERSION,
      file: FILE,
    });
    expect(matchDownloadRoute("/download/1.2.3-beta.1/KalCode.msi")).toEqual({
      kind: "pinned",
      version: "1.2.3-beta.1",
      file: "KalCode.msi",
    });
    for (const path of ["/download", "/download/", "/downloads/windows-x64", "/releases/"]) {
      expect(matchDownloadRoute(path)).toBeNull();
    }
    // Not a version: the segment is some other page under /download/.
    expect(matchDownloadRoute("/download/guide/index.html")).toBeNull();
  });

  it("rejects unsafe pinned file names", () => {
    for (const file of ["..%2F..%2Fsecret", "%2E%2E", ".hidden", "a%22b.exe", "a%0Ab.exe", "a..exe"]) {
      expect(matchDownloadRoute(`/download/0.1.0/${file}`)).toEqual({ kind: "invalid-pinned" });
    }
  });

  it("does not handle www or plain-HTTP requests, so the site router can redirect them", async () => {
    publish(h);
    expect(await handleDownload(new Request("https://www.kalcoded.com/download/windows-x64"), h.deps)).toBeNull();
    const http = new Request("http://kalcoded.com/download/windows-x64", {
      headers: { "cf-visitor": '{"scheme":"http"}' },
    });
    expect(await handleDownload(http, h.deps)).toBeNull();
    expect(await handleDownload(get("/pricing"), h.deps)).toBeNull();
  });
});

describe("GET /download/windows-x64", () => {
  it("streams the latest installer with download headers and the site security headers", async () => {
    publish(h);
    const response = await download(h, "/download/windows-x64");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/vnd.microsoft.portable-executable");
    expect(response.headers.get("content-disposition")).toBe(`attachment; filename="${FILE}"`);
    expect(response.headers.get("content-length")).toBe(String(INSTALLER.byteLength));
    expect(response.headers.get("etag")).toBe(`"etag-${KEY}"`);
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("last-modified")).toBe("Thu, 24 Sep 2026 12:00:00 GMT");
    expect(response.headers.get("cache-control")).toBe(LATEST_CACHE);
    expect(response.headers.get("x-kalcode-version")).toBe(VERSION);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("strict-transport-security")).toContain("max-age=31536000");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(INSTALLER);
  });

  it("answers HEAD with the same headers and no body", async () => {
    publish(h);
    const response = await download(h, "/download/windows-x64", { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe(String(INSTALLER.byteLength));
    expect(response.headers.get("content-disposition")).toBe(`attachment; filename="${FILE}"`);
    expect(response.body).toBeNull();
    expect(h.ranges).toEqual([undefined]); // only the manifest was read
  });

  it("serves the site's 404 page (status 404, not cached) when nothing is published", async () => {
    const response = await download(h, "/download/windows-x64");
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("no-store, no-transform");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(await response.text()).toContain("<h1>");
    expect(h.assetRequests).toEqual(["/404"]);
  });

  it("404s when the manifest has no Windows build or points at a missing file", async () => {
    publish(h, { ...manifest(), latest: null });
    expect((await download(h, "/download/windows-x64")).status).toBe(404);
    publish(h);
    h.objects.delete(KEY);
    expect((await download(h, "/download/windows-x64")).status).toBe(404);
  });

  it("404s (and logs) when the stored manifest is corrupt, instead of guessing", async () => {
    publish(h);
    h.objects.set(MANIFEST_KEY, new TextEncoder().encode("{not json"));
    expect((await download(h, "/download/windows-x64")).status).toBe(404);
    h.objects.set(MANIFEST_KEY, new TextEncoder().encode(JSON.stringify(manifest({ version: "../../x" }))));
    expect((await download(h, "/download/windows-x64")).status).toBe(404);
    expect(h.logs.map((l) => l.event)).toEqual(["download.manifest_invalid_json", "download.manifest_invalid"]);
  });

  it("falls back to a plain 404 when the 404 page cannot be fetched", async () => {
    h.deps.assets = { fetch: async () => new Response("nope", { status: 500 }) };
    const response = await download(h, "/download/windows-x64");
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("That download is not available.");
  });

  it("404s when the bucket binding is missing", async () => {
    h.deps.bucket = null;
    expect((await download(h, "/download/windows-x64")).status).toBe(404);
    expect(h.logs).toEqual([{ level: "warn", event: "download.bucket_missing" }]);
  });

  it("answers 503 without internal detail when storage fails", async () => {
    publish(h);
    h.failBucket(true);
    const response = await download(h, "/download/windows-x64");
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(await response.text()).not.toContain("internal detail");
    expect(h.logs).toEqual([{ level: "error", event: "download.error", error: "Error" }]);
  });

  it("rejects other methods", async () => {
    publish(h);
    const response = await download(h, "/download/windows-x64", { method: "POST" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });
});

describe("conditional and range requests", () => {
  it("answers If-None-Match with 304", async () => {
    publish(h);
    const response = await download(h, "/download/windows-x64", { headers: { "if-none-match": `"etag-${KEY}"` } });
    expect(response.status).toBe(304);
    expect(response.headers.get("etag")).toBe(`"etag-${KEY}"`);
    expect(response.body).toBeNull();
  });

  it("serves a single byte range with 206 so interrupted downloads can resume", async () => {
    publish(h);
    const response = await download(h, `/download/${VERSION}/${FILE}`, { headers: { range: "bytes=3-7" } });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(`bytes 3-7/${INSTALLER.byteLength}`);
    expect(response.headers.get("content-length")).toBe("5");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(INSTALLER.slice(3, 8));
    expect(h.ranges).toEqual([{ offset: 3, length: 5 }]);
  });

  it("answers 416 for a range past the end", async () => {
    publish(h);
    const response = await download(h, `/download/${VERSION}/${FILE}`, { headers: { range: "bytes=9999-" } });
    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe(`bytes */${INSTALLER.byteLength}`);
  });

  it("ignores the range when If-Range does not match the current file", async () => {
    publish(h);
    const response = await download(h, `/download/${VERSION}/${FILE}`, {
      headers: { range: "bytes=0-1", "if-range": '"stale"' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe(String(INSTALLER.byteLength));
  });

  it("parses ranges per RFC 9110", () => {
    expect(parseRange(null, 100)).toBeNull();
    expect(parseRange("bytes=0-", 100)).toEqual({ offset: 0, length: 100 });
    expect(parseRange("bytes=10-19", 100)).toEqual({ offset: 10, length: 10 });
    expect(parseRange("bytes=90-500", 100)).toEqual({ offset: 90, length: 10 });
    expect(parseRange("bytes=-30", 100)).toEqual({ offset: 70, length: 30 });
    expect(parseRange("bytes=-500", 100)).toEqual({ offset: 0, length: 100 });
    expect(parseRange("bytes=100-", 100)).toBe("unsatisfiable");
    expect(parseRange("bytes=-0", 100)).toBe("unsatisfiable");
    expect(parseRange("bytes=5-2", 100)).toBeNull();
    expect(parseRange("bytes=0-1,5-6", 100)).toBeNull();
    expect(parseRange("items=0-1", 100)).toBeNull();
  });
});

describe("pinned downloads", () => {
  it("serves an exact version with an immutable cache policy", async () => {
    publish(h);
    const response = await download(h, `/download/${VERSION}/${FILE}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(IMMUTABLE_CACHE);
    expect(response.headers.get("x-kalcode-version")).toBeNull();
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(INSTALLER);
  });

  it("404s for unknown versions and unsafe names", async () => {
    publish(h);
    expect((await download(h, `/download/9.9.9/${FILE}`)).status).toBe(404);
    expect((await download(h, "/download/0.1.0/..%2Flatest.json")).status).toBe(404);
  });

  it("uses a generic binary type for unknown extensions", () => {
    expect(contentTypeFor("KalCode.MSI")).toBe("application/x-msi");
    expect(contentTypeFor("KalCode.AppImage")).toBe("application/octet-stream");
  });
});

describe("GET /releases/latest.json", () => {
  it("returns the validated manifest", async () => {
    publish(h);
    const response = await download(h, "/releases/latest.json");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("public, max-age=60, must-revalidate");
    expect(await response.json()).toEqual(manifest());
  });

  it("returns a JSON 404 before the first release", async () => {
    const response = await download(h, "/releases/latest.json");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      ok: false,
      error: "not_found",
      message: "No release has been published yet.",
    });
  });
});

describe("manifest validation", () => {
  it("preserves a stable build revision while binding release notes to the public milestone", () => {
    const buildVersion = "0.1.7+218";
    const value = manifest({
      version: buildVersion,
      channel: "stable",
      notesUrl: "/updates#release-0-1-7",
      platforms: [
        {
          ...manifest().latest.platforms[0],
          pinnedUrl: `/download/${buildVersion}/${FILE}`,
          signed: true,
        },
      ],
    });

    expect(parseReleaseManifest(value)?.latest?.version).toBe(buildVersion);
  });

  it("rejects stable prereleases and build-scoped milestone anchors", () => {
    expect(parseReleaseManifest(manifest({ version: "0.1.7-rc.1", channel: "stable" }))).toBeNull();
    expect(
      parseReleaseManifest(
        manifest({
          version: "0.1.7+218",
          channel: "stable",
          notesUrl: "/updates#release-0-1-7+218",
        }),
      ),
    ).toBeNull();
  });

  it("accepts the committed website manifest", () => {
    expect(parseReleaseManifest(committedManifest)).not.toBeNull();
  });

  it("keeps the committed manifest honest until a release is published", () => {
    const parsed = parseReleaseManifest(committedManifest);
    const listed = new Set([
      ...(parsed?.latest?.platforms.map((p) => p.os) ?? []),
      ...(parsed?.unavailable.map((p) => p.os) ?? []),
    ]);
    expect([...listed].sort()).toEqual(["linux", "macos", "windows"]);
    for (const platform of parsed?.latest?.platforms ?? []) {
      expect(platform.url.startsWith("/download/")).toBe(true);
    }
  });

  it("rejects manifests with unsafe or inconsistent fields", () => {
    expect(parseReleaseManifest(manifest())).not.toBeNull();
    expect(parseReleaseManifest({ ...manifest(), schemaVersion: 2 })).toBeNull();
    expect(parseReleaseManifest(manifest({ commit: "abc" }))).toBeNull();
    expect(parseReleaseManifest(manifest({ notesUrl: "https://elsewhere.example" }))).toBeNull();
    expect(parseReleaseManifest(manifest({ notesUrl: "//elsewhere.example" }))).toBeNull();
    expect(parseReleaseManifest(manifest({ platforms: [] }))).toBeNull();
    const [platform] = manifest().latest.platforms;
    expect(
      parseReleaseManifest(manifest({ platforms: [{ ...platform, url: "https://elsewhere.example" }] })),
    ).toBeNull();
    expect(parseReleaseManifest(manifest({ platforms: [{ ...platform, sha256: "XYZ" }] }))).toBeNull();
    expect(parseReleaseManifest(manifest({ platforms: [{ ...platform, file: "../x.exe" }] }))).toBeNull();
    expect(parseReleaseManifest(manifest({ platforms: [{ ...platform, pinnedUrl: "/download/9/x" }] }))).toBeNull();
    expect(parseReleaseManifest(manifest({ platforms: [{ ...platform, signed: "no" }] }))).toBeNull();
  });
});
