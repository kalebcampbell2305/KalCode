import { THEME_SCRIPT } from "../../src/lib/theme-script";

/** Base64 SHA-256 of an inline script, in CSP source form: `'sha256-…'`. */
export async function cspHash(source: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  let binary = "";
  for (const byte of new Uint8Array(digest)) {
    binary += String.fromCharCode(byte);
  }
  return `'sha256-${btoa(binary)}'`;
}

/**
 * Strict policy: everything from our own origin, nothing inline except the theme script
 * (allowed by hash), no framing, no plugins, no base-URI or form-target hijacking.
 */
export function buildCsp(themeScriptHash: string): string {
  return [
    "default-src 'none'",
    `script-src 'self' ${themeScriptHash}`,
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self' https://api.kalcoded.com",
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join("; ");
}

let cachedCsp: Promise<string> | undefined;

/** The site CSP, computed once per isolate from the shared theme-script source. */
export function siteCsp(): Promise<string> {
  cachedCsp ??= cspHash(THEME_SCRIPT).then(buildCsp);
  return cachedCsp;
}

export const STATIC_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
};

export const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";

/** Content-hashed build output lives under /_astro/ and never changes at a given URL. */
export function isHashedAssetPath(pathname: string): boolean {
  return pathname.startsWith("/_astro/");
}

/**
 * `no-transform` stops the Cloudflare proxy from rewriting pages — including injecting the Web
 * Analytics beacon when it is enabled for the zone. The site promises no analytics, so HTML is
 * always served as-is.
 */
export function withNoTransform(cacheControl: string | null): string {
  const directives = (cacheControl ?? "")
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);
  if (!directives.some((d) => d.toLowerCase() === "no-transform")) directives.push("no-transform");
  return directives.join(", ");
}

/** Returns a copy of `response` with the security headers (and asset caching) applied. */
export function withSecurityHeaders(response: Response, pathname: string, csp: string): Response {
  const secured = new Response(response.body, response);
  const headers = secured.headers;
  headers.set("content-security-policy", csp);
  for (const [name, value] of Object.entries(STATIC_SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  if (isHashedAssetPath(pathname) && (response.status === 200 || response.status === 304)) {
    headers.set("cache-control", IMMUTABLE_CACHE);
  } else if (headers.get("content-type")?.includes("text/html")) {
    headers.set("cache-control", withNoTransform(headers.get("cache-control")));
  }
  return secured;
}
