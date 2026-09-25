/**
 * Desktop release downloads, served from the RELEASES R2 bucket.
 *
 * Object layout (written by tooling/release/publish.mjs):
 *   releases/latest.json          the release manifest (same shape as src/data/releases.json)
 *   releases/<version>/<file>     installers; a published file is never overwritten
 *
 * Routes:
 *   GET|HEAD /download/windows-x64          the latest Windows x64 installer
 *   GET|HEAD /download/<version>/<file>     one pinned release file
 *   GET|HEAD /releases/latest.json          the manifest
 *
 * A missing release answers with the site's styled 404 page, never a broken response.
 */
import type { Release, ReleaseManifest, ReleasePlatform } from "../src/data/releases";
import { apiError, json } from "./lib/http";
import { canonicalRedirect } from "./lib/router";
import { IMMUTABLE_CACHE, siteCsp, withSecurityHeaders } from "./lib/security";

export interface DownloadEnv {
  ASSETS: Fetcher;
  /** Optional so a deployment without the bucket still serves the site (downloads then 404). */
  RELEASES?: R2Bucket;
}

/** Metadata of a stored release object. */
export interface ReleaseObject {
  size: number;
  httpEtag: string;
  uploaded: Date;
}

export interface ReleaseObjectBody extends ReleaseObject {
  body: ReadableStream;
  text(): Promise<string>;
}

/** The subset of the R2 binding this module uses; unit tests pass an in-memory fake. */
export interface ReleaseBucket {
  head(key: string): Promise<ReleaseObject | null>;
  get(key: string, options?: { range: ByteRange }): Promise<ReleaseObjectBody | null>;
}

export interface DownloadDeps {
  bucket: ReleaseBucket | null;
  assets: { fetch(request: Request): Promise<Response> };
  log: (entry: Record<string, string>) => void;
}

export interface ByteRange {
  offset: number;
  length: number;
}

export const WINDOWS_X64_PATH = "/download/windows-x64";
export const MANIFEST_PATH = "/releases/latest.json";
export const MANIFEST_KEY = "releases/latest.json";

/** The moving "latest" link may change on the next release, so caches must revalidate soon. */
export const LATEST_CACHE = "public, max-age=300, must-revalidate";
export const MANIFEST_CACHE = "public, max-age=60, must-revalidate";
const NO_STORE = "no-store";

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;
/** Conservative file-name charset: safe as an R2 key segment and inside a quoted header value. */
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PINNED = /^\/download\/([^/]+)\/([^/]+)$/;
const SHA256 = /^[0-9a-f]{64}$/;

const CONTENT_TYPES: ReadonlyArray<readonly [string, string]> = [
  [".exe", "application/vnd.microsoft.portable-executable"],
  [".msi", "application/x-msi"],
  [".json", "application/json; charset=utf-8"],
];

export function downloadDepsFromEnv(env: DownloadEnv): DownloadDeps {
  return {
    bucket: env.RELEASES ?? null,
    assets: env.ASSETS,
    // Structured logs only. Never pass IP addresses or request headers here.
    // biome-ignore lint/suspicious/noConsole: console is the Workers structured-logging sink.
    log: (entry) => console.log(JSON.stringify(entry)),
  };
}

export function isValidVersion(value: string): boolean {
  return VERSION.test(value);
}

export function isValidFileName(value: string): boolean {
  return FILE_NAME.test(value) && !value.includes("..");
}

export function releaseKey(version: string, file: string): string {
  return `releases/${version}/${file}`;
}

export function contentTypeFor(file: string): string {
  const lower = file.toLowerCase();
  for (const [extension, type] of CONTENT_TYPES) {
    if (lower.endsWith(extension)) return type;
  }
  return "application/octet-stream";
}

type Route =
  | { kind: "latest-installer"; os: "windows"; arch: "x64" }
  | { kind: "pinned"; version: string; file: string }
  | { kind: "manifest" }
  | { kind: "invalid-pinned" };

/** Which download route, if any, a path belongs to. Other `/download…` paths are site pages. */
export function matchDownloadRoute(pathname: string): Route | null {
  if (pathname === WINDOWS_X64_PATH) return { kind: "latest-installer", os: "windows", arch: "x64" };
  if (pathname === MANIFEST_PATH) return { kind: "manifest" };
  const pinned = PINNED.exec(pathname);
  if (pinned) {
    const [, rawVersion = "", rawFile = ""] = pinned;
    let version: string;
    let file: string;
    try {
      version = decodeURIComponent(rawVersion);
      file = decodeURIComponent(rawFile);
    } catch {
      return { kind: "invalid-pinned" };
    }
    if (!isValidVersion(version)) return null;
    if (!isValidFileName(file)) return { kind: "invalid-pinned" };
    return { kind: "pinned", version, file };
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function parsePlatform(value: unknown, version: string): ReleasePlatform | null {
  if (!isRecord(value)) return null;
  const { os, arch, label, kind, file, url, pinnedUrl, size, sha256, signed } = value;
  if (os !== "windows" && os !== "macos" && os !== "linux") return null;
  if (arch !== "x64" && arch !== "arm64" && arch !== "universal") return null;
  if (!isString(label) || !isString(kind) || !isString(url) || !isString(pinnedUrl)) return null;
  if (!["nsis", "msi", "dmg", "appimage", "deb", "rpm"].includes(kind)) return null;
  if (!isString(file) || !isValidFileName(file)) return null;
  if (pinnedUrl !== `/download/${version}/${file}`) return null;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0) return null;
  if (typeof sha256 !== "string" || !SHA256.test(sha256)) return null;
  if (typeof signed !== "boolean") return null;
  return {
    os,
    arch,
    label,
    kind: kind as ReleasePlatform["kind"],
    file,
    url,
    pinnedUrl,
    size,
    sha256,
    signed,
  };
}

function parseRelease(value: unknown): Release | null {
  if (!isRecord(value)) return null;
  const { version, channel, publishedAt, commit, notesUrl, platforms } = value;
  if (!isString(version) || !isValidVersion(version)) return null;
  if (channel !== "preview" && channel !== "stable") return null;
  if (!isString(publishedAt) || Number.isNaN(Date.parse(publishedAt))) return null;
  if (!isString(commit) || !/^[0-9a-f]{40}$/.test(commit)) return null;
  if (!isString(notesUrl) || !notesUrl.startsWith("/")) return null;
  if (!Array.isArray(platforms) || platforms.length === 0) return null;
  const parsed: ReleasePlatform[] = [];
  for (const platform of platforms) {
    const p = parsePlatform(platform, version);
    if (!p) return null;
    parsed.push(p);
  }
  return { version, channel, publishedAt, commit, notesUrl, platforms: parsed };
}

/** Strict parse of a release manifest. Anything unexpected yields `null` (treated as "no release"). */
export function parseReleaseManifest(value: unknown): ReleaseManifest | null {
  if (!isRecord(value) || value.schemaVersion !== 1) return null;
  const { latest, unavailable } = value;
  if (!Array.isArray(unavailable)) return null;
  const parsedUnavailable: ReleaseManifest["unavailable"] = [];
  for (const entry of unavailable) {
    if (!isRecord(entry)) return null;
    const { os, label, reason } = entry;
    if (os !== "windows" && os !== "macos" && os !== "linux") return null;
    if (!isString(label) || !isString(reason)) return null;
    parsedUnavailable.push({ os, label, reason });
  }
  if (latest === null) return { schemaVersion: 1, latest: null, unavailable: parsedUnavailable };
  const release = parseRelease(latest);
  if (!release) return null;
  return { schemaVersion: 1, latest: release, unavailable: parsedUnavailable };
}

/**
 * One satisfiable `bytes=` range, `"unsatisfiable"`, or `null` to serve the whole file
 * (no header, a malformed header, or several ranges — all of which RFC 9110 lets us ignore).
 */
export function parseRange(header: string | null, size: number): ByteRange | "unsatisfiable" | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, startText = "", endText = ""] = match;
  if (startText === "" && endText === "") return null;
  if (startText === "") {
    const suffix = Number(endText);
    if (suffix === 0 || size === 0) return "unsatisfiable";
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }
  const start = Number(startText);
  if (start >= size) return "unsatisfiable";
  const end = endText === "" ? size - 1 : Math.min(Number(endText), size - 1);
  if (end < start) return null;
  return { offset: start, length: end - start + 1 };
}

function etagMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === "*") return true;
  const bare = (tag: string) => tag.trim().replace(/^W\//, "");
  return header.split(",").some((tag) => bare(tag) === bare(etag));
}

async function readManifest(deps: DownloadDeps, bucket: ReleaseBucket): Promise<ReleaseManifest | null> {
  const object = await bucket.get(MANIFEST_KEY);
  if (!object) return null;
  let value: unknown;
  try {
    value = JSON.parse(await object.text());
  } catch {
    deps.log({ level: "error", event: "download.manifest_invalid_json" });
    return null;
  }
  const manifest = parseReleaseManifest(value);
  if (!manifest) deps.log({ level: "error", event: "download.manifest_invalid" });
  return manifest;
}

/** The site's own 404 page, with the status set to 404 and a download-specific heading. */
async function notFound(request: Request, url: URL, deps: DownloadDeps): Promise<Response> {
  const headers = { "cache-control": NO_STORE };
  try {
    const page = await deps.assets.fetch(new Request(new URL("/404", url), { method: "GET" }));
    if (page.ok && page.headers.get("content-type")?.includes("text/html")) {
      let response = new Response(request.method === "HEAD" ? null : page.body, {
        status: 404,
        headers: page.headers,
      });
      response.headers.set("cache-control", NO_STORE);
      if (typeof HTMLRewriter !== "undefined" && request.method !== "HEAD") {
        response = new HTMLRewriter()
          .on("h1", {
            element(element) {
              element.setInnerContent("That download is not available.");
            },
          })
          .transform(response);
      }
      return response;
    }
  } catch (error) {
    deps.log({ level: "warn", event: "download.not_found_page_error", error: errorName(error) });
  }
  return new Response(request.method === "HEAD" ? null : "That download is not available.", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", ...headers },
  });
}

function unavailable(request: Request): Response {
  return new Response(
    request.method === "HEAD" ? null : "Downloads are temporarily unavailable. Please try again in a few minutes.",
    {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": NO_STORE, "retry-after": "60" },
    },
  );
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

interface ServeFile {
  key: string;
  file: string;
  cacheControl: string;
  extraHeaders?: Record<string, string>;
}

/** Streams one release file with download headers, conditional requests and single ranges. */
async function serveFile(request: Request, url: URL, deps: DownloadDeps, bucket: ReleaseBucket, target: ServeFile) {
  const meta = await bucket.head(target.key);
  if (!meta) return notFound(request, url, deps);

  const headers = new Headers({
    "content-type": contentTypeFor(target.file),
    "content-disposition": `attachment; filename="${target.file}"`,
    etag: meta.httpEtag,
    "last-modified": meta.uploaded.toUTCString(),
    "accept-ranges": "bytes",
    "cache-control": target.cacheControl,
    ...target.extraHeaders,
  });

  if (etagMatches(request.headers.get("if-none-match"), meta.httpEtag)) {
    headers.delete("content-type");
    headers.delete("content-disposition");
    return new Response(null, { status: 304, headers });
  }

  const ifRange = request.headers.get("if-range");
  const range =
    ifRange === null || (!ifRange.startsWith("W/") && ifRange === meta.httpEtag)
      ? parseRange(request.headers.get("range"), meta.size)
      : null;
  if (range === "unsatisfiable") {
    headers.set("content-range", `bytes */${meta.size}`);
    headers.delete("content-disposition");
    headers.set("content-length", "0");
    return new Response(null, { status: 416, headers });
  }

  const status = range ? 206 : 200;
  const length = range ? range.length : meta.size;
  headers.set("content-length", String(length));
  if (range) headers.set("content-range", `bytes ${range.offset}-${range.offset + range.length - 1}/${meta.size}`);

  if (request.method === "HEAD") return new Response(null, { status, headers });

  const object = range ? await bucket.get(target.key, { range }) : await bucket.get(target.key);
  if (!object) return notFound(request, url, deps);
  if (object.httpEtag !== meta.httpEtag || object.size !== meta.size) {
    await object.body.cancel().catch(() => undefined);
    return unavailable(request);
  }
  return new Response(object.body, { status, headers });
}

function findPlatform(release: Release, os: string, arch: string): ReleasePlatform | undefined {
  // The NSIS per-user installer is the primary Windows download.
  const matches = release.platforms.filter((p) => p.os === os && p.arch === arch);
  return matches.find((p) => p.kind === "nsis") ?? matches[0];
}

async function route(request: Request, url: URL, deps: DownloadDeps, match: Route): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405, headers: { allow: "GET, HEAD", "cache-control": NO_STORE } });
  }
  if (match.kind === "invalid-pinned") return notFound(request, url, deps);

  const bucket = deps.bucket;
  if (!bucket) {
    deps.log({ level: "warn", event: "download.bucket_missing" });
    if (match.kind === "manifest") return apiError(404, "not_found", "No release has been published yet.");
    return notFound(request, url, deps);
  }

  if (match.kind === "manifest") {
    const manifest = await readManifest(deps, bucket);
    if (!manifest) return apiError(404, "not_found", "No release has been published yet.");
    const response = json(manifest, 200, { "cache-control": MANIFEST_CACHE });
    return request.method === "HEAD" ? new Response(null, { status: 200, headers: response.headers }) : response;
  }

  if (match.kind === "pinned") {
    return serveFile(request, url, deps, bucket, {
      key: releaseKey(match.version, match.file),
      file: match.file,
      cacheControl: IMMUTABLE_CACHE,
    });
  }

  const manifest = await readManifest(deps, bucket);
  const platform = manifest?.latest ? findPlatform(manifest.latest, match.os, match.arch) : undefined;
  if (!manifest?.latest || !platform) return notFound(request, url, deps);
  return serveFile(request, url, deps, bucket, {
    key: releaseKey(manifest.latest.version, platform.file),
    file: platform.file,
    cacheControl: LATEST_CACHE,
    extraHeaders: { "x-kalcode-version": manifest.latest.version },
  });
}

/**
 * Handles download routes; returns `null` for every other request so the site router serves it.
 * Canonical redirects (www and plain HTTP) are left to the site router.
 */
export async function handleDownload(request: Request, deps: DownloadDeps): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname.startsWith("//") || canonicalRedirect(url, request)) return null;
  const match = matchDownloadRoute(url.pathname);
  if (!match) return null;

  let response: Response;
  try {
    response = await route(request, url, deps, match);
  } catch (error) {
    deps.log({ level: "error", event: "download.error", error: errorName(error) });
    response = unavailable(request);
  }
  return withSecurityHeaders(response, url.pathname, await siteCsp());
}
