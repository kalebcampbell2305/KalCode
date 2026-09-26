/**
 * Signed local-component catalogs and immutable artifact bytes.
 *
 * D1 is the only publication authority. R2 contains content-addressed bytes and is never used as
 * a mutable fallback. The desktop independently verifies each compact JWS and artifact SHA-256.
 */
import type { DownloadEnv } from "./downloads";
import { parseRange } from "./downloads";
import { IMMUTABLE_CACHE, siteCsp, withSecurityHeaders } from "./lib/security";

export const COMPONENT_CATALOG_MAX_BYTES = 192 * 1024;
export const COMPONENT_ARTIFACT_MAX_BYTES = 8 * 1024 * 1024 * 1024;
const CATALOG_CACHE = "public, max-age=60, must-revalidate";
const NO_STORE = "no-store";
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

type ComponentChannel = "stable" | "beta" | "dev";
type ComponentPlatform = "windows" | "macos";
type ComponentArch = "x86_64" | "aarch64";

export interface ComponentCatalogRow {
  channel: ComponentChannel;
  platform: ComponentPlatform;
  arch: ComponentArch;
  sequence: number;
  catalog_key: string;
  catalog_sha256: string;
  catalog_size_bytes: number;
}

export interface ComponentArtifactRow {
  artifact_key: string;
  file: string;
  size_bytes: number;
  sha256: string;
}

export interface ComponentCatalogStore {
  current(channel: string, platform: string, arch: string): Promise<ComponentCatalogRow | null>;
  artifact(key: string): Promise<ComponentArtifactRow | null>;
}

interface ComponentObject {
  size: number;
  body: ReadableStream<Uint8Array>;
}

export interface ComponentBucket {
  get(key: string, options?: { range: { offset: number; length: number } }): Promise<ComponentObject | null>;
}

export interface ComponentDeps {
  catalog: ComponentCatalogStore;
  bucket: ComponentBucket | null;
  log: (entry: Record<string, string>) => void;
}

export function componentCatalog(db: D1Database): ComponentCatalogStore {
  return {
    async current(channel, platform, arch) {
      return db
        .prepare(
          "SELECT v.channel, v.platform, v.arch, v.sequence, v.catalog_key, v.catalog_sha256, v.catalog_size_bytes FROM component_catalog_pointers p JOIN component_catalog_versions v ON v.channel = p.channel AND v.platform = p.platform AND v.arch = p.arch AND v.sequence = p.sequence WHERE p.channel = ? AND p.platform = ? AND p.arch = ?",
        )
        .bind(channel, platform, arch)
        .first<ComponentCatalogRow>();
    },
    async artifact(key) {
      const result = await db
        .prepare(
          "SELECT a.artifact_key, a.file, a.size_bytes, a.sha256 FROM component_catalog_artifacts a JOIN component_catalog_publications h ON h.channel = a.channel AND h.platform = a.platform AND h.arch = a.arch AND h.sequence = a.sequence WHERE a.artifact_key = ?",
        )
        .bind(key)
        .all<ComponentArtifactRow>();
      if (result.results.length === 0) return null;
      const [first] = result.results;
      if (!first) return null;
      if (
        result.results.some(
          (row) =>
            row.artifact_key !== first.artifact_key ||
            row.file !== first.file ||
            row.size_bytes !== first.size_bytes ||
            row.sha256 !== first.sha256,
        )
      ) {
        throw new Error("Conflicting component artifact authority");
      }
      return first;
    },
  };
}

export function componentDepsFromEnv(env: Pick<DownloadEnv, "DB" | "RELEASES">): ComponentDeps {
  return {
    catalog: componentCatalog(env.DB),
    bucket: (env.RELEASES as ComponentBucket | undefined) ?? null,
    // Public component identifiers are deliberately omitted. Request metadata and client data are
    // never copied into component-serving logs.
    // biome-ignore lint/suspicious/noConsole: console is the Workers structured-logging sink.
    log: (entry) => console.log(JSON.stringify(entry)),
  };
}

type ComponentRoute =
  | {
      kind: "catalog";
      channel: ComponentChannel;
      platform: ComponentPlatform;
      arch: ComponentArch;
    }
  | { kind: "artifact"; key: string; file: string }
  | { kind: "invalid" };

function nativeTarget(platform: string, arch: string): platform is ComponentPlatform {
  return (platform === "windows" && arch === "x86_64") || (platform === "macos" && arch === "aarch64");
}

function safeSegment(value: string, max: number): boolean {
  return value.length <= max && SAFE_TOKEN.test(value) && !value.includes("..");
}

export function matchComponentRoute(pathname: string, search = ""): ComponentRoute | null {
  if (!pathname.startsWith("/components/v1/")) return null;
  if (search || pathname.includes("%") || pathname.includes("\\") || pathname.includes("//")) {
    return { kind: "invalid" };
  }
  const catalog = /^\/components\/v1\/catalog\/(stable|beta|dev)\/(windows|macos)\/(x86_64|aarch64)\.jws$/.exec(
    pathname,
  );
  if (catalog) {
    const [, channel, platform, arch] = catalog;
    if (channel && platform && arch && nativeTarget(platform, arch)) {
      return {
        kind: "catalog",
        channel: channel as ComponentChannel,
        platform,
        arch: arch as ComponentArch,
      };
    }
    return { kind: "invalid" };
  }
  const artifact = /^\/components\/v1\/(runtime|model)\/([^/]+)\/([^/]+)\/([0-9a-f]{64})\/([^/]+)$/.exec(pathname);
  if (!artifact) return { kind: "invalid" };
  const [, , componentId = "", version = "", , file = ""] = artifact;
  if (!safeSegment(componentId, 128) || !safeSegment(version, 64) || !safeSegment(file, 160)) {
    return { kind: "invalid" };
  }
  return { kind: "artifact", key: pathname.slice(1), file };
}

function exactCatalogRow(
  row: ComponentCatalogRow,
  channel: ComponentChannel,
  platform: ComponentPlatform,
  arch: ComponentArch,
): boolean {
  return (
    row.channel === channel &&
    row.platform === platform &&
    row.arch === arch &&
    Number.isSafeInteger(row.sequence) &&
    row.sequence > 0 &&
    SHA256.test(row.catalog_sha256) &&
    Number.isSafeInteger(row.catalog_size_bytes) &&
    row.catalog_size_bytes > 0 &&
    row.catalog_size_bytes <= COMPONENT_CATALOG_MAX_BYTES &&
    row.catalog_key === `components/v1/catalog/${channel}/${platform}/${arch}/${row.sequence}/${row.catalog_sha256}.jws`
  );
}

function exactArtifactRow(row: ComponentArtifactRow, key: string, file: string): boolean {
  return (
    row.artifact_key === key &&
    row.file === file &&
    SHA256.test(row.sha256) &&
    key.includes(`/${row.sha256}/`) &&
    Number.isSafeInteger(row.size_bytes) &&
    row.size_bytes > 0 &&
    row.size_bytes <= COMPONENT_ARTIFACT_MAX_BYTES
  );
}

function etag(hash: string): string {
  return `"${hash}"`;
}

function etagMatches(header: string | null, expected: string): boolean {
  if (!header) return false;
  if (header.trim() === "*") return true;
  return header.split(",").some((value) => value.trim() === expected);
}

async function boundedBytes(body: ReadableStream<Uint8Array>, expected: number, maximum: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(expected) || expected <= 0 || expected > maximum) throw new Error("Invalid bounded size");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > expected || length > maximum) throw new Error("Bounded object is too large");
      chunks.push(part.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (length !== expected) throw new Error("Bounded object is incomplete");
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function missing(request: Request): Response {
  return new Response(request.method === "HEAD" ? null : "Component not found.", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": NO_STORE },
  });
}

function unavailable(request: Request): Response {
  return new Response(request.method === "HEAD" ? null : "Components are temporarily unavailable.", {
    status: 503,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": NO_STORE,
      "retry-after": "60",
    },
  });
}

async function serveCatalog(
  request: Request,
  deps: ComponentDeps,
  route: Extract<ComponentRoute, { kind: "catalog" }>,
) {
  const row = await deps.catalog.current(route.channel, route.platform, route.arch);
  if (!row) return missing(request);
  if (!exactCatalogRow(row, route.channel, route.platform, route.arch)) throw new Error("Invalid catalog authority");
  const digestEtag = etag(row.catalog_sha256);
  const headers = new Headers({
    "content-type": "application/jose",
    "content-length": String(row.catalog_size_bytes),
    "cache-control": CATALOG_CACHE,
    etag: digestEtag,
    "x-kalcode-component-authority": "d1-v1",
  });
  if (etagMatches(request.headers.get("if-none-match"), digestEtag)) {
    headers.delete("content-type");
    headers.delete("content-length");
    return new Response(null, { status: 304, headers });
  }
  if (request.method === "HEAD") return new Response(null, { status: 200, headers });
  if (!deps.bucket) return unavailable(request);
  const object = await deps.bucket.get(row.catalog_key);
  if (!object || object.size !== row.catalog_size_bytes) return unavailable(request);
  const bytes = await boundedBytes(object.body, row.catalog_size_bytes, COMPONENT_CATALOG_MAX_BYTES);
  if ((await sha256(bytes)) !== row.catalog_sha256) throw new Error("Catalog integrity failure");
  return new Response(bytes, { status: 200, headers });
}

async function serveArtifact(
  request: Request,
  deps: ComponentDeps,
  route: Extract<ComponentRoute, { kind: "artifact" }>,
) {
  const row = await deps.catalog.artifact(route.key);
  if (!row) return missing(request);
  if (!exactArtifactRow(row, route.key, route.file)) throw new Error("Invalid artifact authority");
  const digestEtag = etag(row.sha256);
  const headers = new Headers({
    "content-type": route.file.endsWith(".zip") ? "application/zip" : "application/octet-stream",
    "content-disposition": `attachment; filename="${route.file}"`,
    "content-length": String(row.size_bytes),
    "accept-ranges": "bytes",
    "cache-control": IMMUTABLE_CACHE,
    etag: digestEtag,
    "x-kalcode-component-authority": "d1-v1",
  });
  if (etagMatches(request.headers.get("if-none-match"), digestEtag)) {
    headers.delete("content-type");
    headers.delete("content-disposition");
    headers.delete("content-length");
    return new Response(null, { status: 304, headers });
  }
  const ifRange = request.headers.get("if-range");
  const range =
    ifRange === null || ifRange === digestEtag ? parseRange(request.headers.get("range"), row.size_bytes) : null;
  if (range === "unsatisfiable") {
    headers.set("content-range", `bytes */${row.size_bytes}`);
    headers.set("content-length", "0");
    headers.delete("content-disposition");
    return new Response(null, { status: 416, headers });
  }
  const status = range ? 206 : 200;
  const length = range ? range.length : row.size_bytes;
  headers.set("content-length", String(length));
  if (range) headers.set("content-range", `bytes ${range.offset}-${range.offset + range.length - 1}/${row.size_bytes}`);
  if (request.method === "HEAD") return new Response(null, { status, headers });
  if (!deps.bucket) return unavailable(request);
  const object = range ? await deps.bucket.get(row.artifact_key, { range }) : await deps.bucket.get(row.artifact_key);
  if (!object || object.size !== row.size_bytes) {
    await object?.body.cancel().catch(() => undefined);
    return unavailable(request);
  }
  return new Response(object.body, { status, headers });
}

/** Returns null for non-component routes so the existing site and download routers keep ownership. */
export async function handleComponent(request: Request, deps: ComponentDeps): Promise<Response | null> {
  const url = new URL(request.url);
  const route = matchComponentRoute(url.pathname, url.search);
  if (!route) return null;
  let response: Response;
  try {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response = new Response(null, { status: 405, headers: { allow: "GET, HEAD", "cache-control": NO_STORE } });
    } else if (route.kind === "invalid") {
      response = missing(request);
    } else if (route.kind === "catalog") {
      response = await serveCatalog(request, deps, route);
    } else {
      response = await serveArtifact(request, deps, route);
    }
  } catch (error) {
    deps.log({
      level: "error",
      event: "component.serve_failed",
      error: error instanceof Error ? error.name : "unknown",
    });
    response = unavailable(request);
  }
  return withSecurityHeaders(response, url.pathname, await siteCsp());
}
