import { CONSENT_VERSION } from "../../src/lib/site";
import { readJsonBody } from "./body";
import { apiError, json } from "./http";
import { siteCsp, withSecurityHeaders } from "./security";
import { d1Store, type EarlyAccessStore } from "./store";
import { validateRemoval, validateSignup } from "./validation";

export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  EARLY_ACCESS_LIMITER: RateLimit;
}

export interface Deps {
  assets: { fetch(request: Request): Promise<Response> };
  store: EarlyAccessStore;
  limiter: { limit(options: { key: string }): Promise<{ success: boolean }> };
  now: () => Date;
  log: (entry: Record<string, string>) => void;
}

export const APEX_HOST = "kalcoded.com";
export const WWW_HOST = "www.kalcoded.com";
export const SIGNUP_PATH = "/api/early-access";
export const REMOVE_PATH = "/api/early-access/remove";

const SERVER_ERROR_MESSAGE = "Something went wrong on our side. Please try again later.";

/** Identical for new, duplicate and honeypot submissions so the response reveals nothing. */
export const SIGNUP_OK = {
  ok: true,
  message: "You're on the early-access list. We'll email you when there is a build to try.",
} as const;

/** Identical whether or not the address was on the list. */
export const REMOVE_OK = {
  ok: true,
  message: "If that address was on the early-access list, it has been removed.",
} as const;

export function depsFromEnv(env: Env): Deps {
  return {
    assets: env.ASSETS,
    store: d1Store(env.DB),
    limiter: env.EARLY_ACCESS_LIMITER,
    now: () => new Date(),
    // Structured logs only. Never pass emails, IP addresses or request bodies here.
    // biome-ignore lint/suspicious/noConsole: console is the Workers structured-logging sink.
    log: (entry) => console.log(JSON.stringify(entry)),
  };
}

/**
 * True when Cloudflare's edge received the request over plain HTTP. The edge sets
 * `cf-visitor: {"scheme":"http"}` on real traffic; local `wrangler dev` does not send the
 * header, so development requests are never redirected.
 */
export function arrivedOverHttp(request: Request): boolean {
  const visitor = request.headers.get("cf-visitor");
  if (!visitor) return false;
  try {
    return (JSON.parse(visitor) as { scheme?: unknown }).scheme === "http";
  } catch {
    return false;
  }
}

/**
 * Canonical redirect: www → apex and HTTP → HTTPS, keeping path and query. HSTS then keeps
 * browsers on HTTPS for subsequent visits.
 */
export function canonicalRedirect(url: URL, request?: Request): string | null {
  const host = url.hostname.toLowerCase();
  const isWww = host === WWW_HOST;
  const isHttp = request ? arrivedOverHttp(request) : false;
  if (isWww || (isHttp && host === APEX_HOST)) {
    return `https://${APEX_HOST}${url.pathname}${url.search}`;
  }
  return null;
}

/** Rate-limit key: the client IP Cloudflare reports, namespaced per action. */
export function clientKey(request: Request, action: string): string {
  const ip = request.headers.get("cf-connecting-ip")?.trim() || "unknown";
  return `${action}:${ip}`;
}

/** A page on another site must not be able to submit on a visitor's behalf. */
function isCrossOrigin(request: Request, url: URL): boolean {
  const origin = request.headers.get("origin");
  return origin !== null && origin !== url.origin;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

const BODY_ERRORS = {
  unsupported_media_type: [415, "Send the request as application/json."],
  payload_too_large: [413, "The request body is too large."],
  invalid_json: [400, "The request body is not valid JSON."],
} as const;

type ApiHandler = (request: Request, url: URL, deps: Deps) => Promise<Response>;

/** Method, origin and rate-limit checks shared by both endpoints. */
async function guard(request: Request, url: URL, deps: Deps, action: string): Promise<Response | null> {
  if (request.method !== "POST") {
    return apiError(405, "method_not_allowed", "Use POST for this endpoint.", { allow: "POST" });
  }
  if (isCrossOrigin(request, url)) {
    return apiError(403, "forbidden", "Cross-origin requests are not accepted.");
  }
  try {
    const { success } = await deps.limiter.limit({ key: clientKey(request, action) });
    if (!success) {
      return apiError(429, "rate_limited", "Too many attempts from your network. Wait a minute and try again.", {
        "retry-after": "60",
      });
    }
  } catch (error) {
    // Fail open: a limiter outage should not take the form down. Logged without request data.
    deps.log({ level: "warn", event: "rate_limiter.error", error: errorName(error) });
  }
  return null;
}

async function readBody(request: Request): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  const body = await readJsonBody(request);
  if (!body.ok) {
    const [status, message] = BODY_ERRORS[body.reason];
    return { ok: false, response: apiError(status, body.reason, message) };
  }
  return body;
}

export const handleSignup: ApiHandler = async (request, url, deps) => {
  const blocked = await guard(request, url, deps, "signup");
  if (blocked) {
    return blocked;
  }
  const body = await readBody(request);
  if (!body.ok) {
    return body.response;
  }
  const input = validateSignup(body.value);
  if (!input.ok) {
    return apiError(400, input.error, input.message);
  }
  if (!input.value.isBot) {
    try {
      await deps.store.add({
        email: input.value.email,
        source: input.value.source,
        createdAt: deps.now().toISOString(),
        consentVersion: CONSENT_VERSION,
      });
    } catch (error) {
      deps.log({ level: "error", event: "early_access.store_failed", error: errorName(error) });
      return apiError(500, "server_error", SERVER_ERROR_MESSAGE);
    }
  }
  return json(SIGNUP_OK, 200);
};

export const handleRemove: ApiHandler = async (request, url, deps) => {
  const blocked = await guard(request, url, deps, "remove");
  if (blocked) {
    return blocked;
  }
  const body = await readBody(request);
  if (!body.ok) {
    return body.response;
  }
  const input = validateRemoval(body.value);
  if (!input.ok) {
    return apiError(400, input.error, input.message);
  }
  try {
    await deps.store.remove(input.value.email);
  } catch (error) {
    deps.log({ level: "error", event: "early_access.remove_failed", error: errorName(error) });
    return apiError(500, "server_error", SERVER_ERROR_MESSAGE);
  }
  return json(REMOVE_OK, 200);
};

const API_ROUTES: Readonly<Record<string, ApiHandler>> = {
  [SIGNUP_PATH]: handleSignup,
  [REMOVE_PATH]: handleRemove,
};

/** Routes one request. Security headers are applied to every response, including redirects. */
export async function handleRequest(request: Request, deps: Deps): Promise<Response> {
  const url = new URL(request.url);
  const csp = await siteCsp();

  let response: Response;
  const redirect = canonicalRedirect(url, request);
  if (redirect) {
    response = new Response(null, { status: 301, headers: { location: redirect } });
  } else if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
    const handler = API_ROUTES[url.pathname];
    if (handler) {
      try {
        response = await handler(request, url, deps);
      } catch (error) {
        deps.log({ level: "error", event: "api.unhandled", error: errorName(error) });
        response = apiError(500, "server_error", SERVER_ERROR_MESSAGE);
      }
    } else {
      response = apiError(404, "not_found", "There is no API endpoint at this address.");
    }
  } else {
    response = await deps.assets.fetch(request);
  }

  return withSecurityHeaders(response, url.pathname, csp);
}
