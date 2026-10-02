import { CONSENT_VERSION, EARLY_ACCESS_EMAIL, SITE_ORIGIN } from "../../src/lib/site";
import { readJsonBody } from "./body";
import {
  confirmWithToken,
  type FlowDeps,
  type RemovalOutcome,
  removeWithToken,
  requestRemoval,
  requestSignup,
  type SendOutcome,
} from "./early-access";
import { apiError, json } from "./http";
import { isLoopbackHost, type MailEnv, mailerFromEnv } from "./mailer";
import { siteCsp, withSecurityHeaders } from "./security";
import { d1Store } from "./store";
import { newToken } from "./tokens";
import { validateRemoval, validateSignup, validateToken } from "./validation";

export interface Env extends MailEnv {
  ASSETS: Fetcher;
  DB: D1Database;
  EARLY_ACCESS_LIMITER: RateLimit;
  /** Site-wide cap on emails per UTC day (default EARLY_ACCESS_EMAIL.dailyTotal). */
  EMAIL_DAILY_LIMIT?: string;
  /**
   * Local development and tests only: where links in emails point (e.g. http://127.0.0.1:8787)
   * when EMAIL_TRANSPORT is capture or log. Must be a loopback address. Production ignores it:
   * Resend emails always link to SITE_ORIGIN.
   */
  EMAIL_LINK_ORIGIN?: string;
}

export interface Deps extends FlowDeps {
  assets: { fetch(request: Request): Promise<Response> };
  limiter: { limit(options: { key: string }): Promise<{ success: boolean }> };
  /** Parsed EMAIL_LINK_ORIGIN: a loopback origin, or null. */
  localLinkOrigin: string | null;
}

export const APEX_HOST = "kalcoded.com";
export const WWW_HOST = "www.kalcoded.com";
export const SIGNUP_PATH = "/api/early-access";
export const REMOVE_PATH = "/api/early-access/remove";
export const CONFIRM_PATH = "/api/early-access/confirm";
export const REMOVE_CONFIRM_PATH = "/api/early-access/remove/confirm";

const SERVER_ERROR_MESSAGE = "Something went wrong on our side. Please try again later.";

/**
 * Identical for a new, pending, confirmed, throttled and honeypot submission, so the response
 * reveals nothing about the list.
 */
export const SIGNUP_OK = {
  ok: true,
  message: `Almost there: check your inbox and open the link we sent to confirm your email. It expires in ${EARLY_ACCESS_EMAIL.linkTtlHours} hours.`,
} as const;

/** Identical whether or not the address is on the list. */
export const REMOVE_OK = {
  ok: true,
  message: "If that address is on the early-access list, we've emailed it a link to confirm the removal.",
} as const;

export const CONFIRMED_OK = {
  ok: true,
  message: "Your email is confirmed. You're on the KalCode early-access list.",
} as const;

export const REMOVED_OK = {
  ok: true,
  message: "Your email has been removed from the early-access list.",
} as const;

const EMAIL_FAILED_MESSAGE = "We couldn't send the email right now, so nothing was saved. Try again in a few minutes.";
const EMAIL_UNAVAILABLE_MESSAGE = "We can't send more emails today. Nothing was saved. Try again tomorrow.";
const INVALID_LINK_MESSAGE = `This link is no longer valid. Links work once and expire after ${EARLY_ACCESS_EMAIL.linkTtlHours} hours.`;

/** Parses EMAIL_DAILY_LIMIT; anything but a non-negative integer falls back to the default. */
export function dailyEmailLimit(value: string | undefined): number {
  const parsed = value === undefined || value.trim() === "" ? Number.NaN : Number(value.trim());
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : EARLY_ACCESS_EMAIL.dailyTotal;
}

/** A loopback http(s) origin from EMAIL_LINK_ORIGIN, or null for anything else. */
export function localLinkOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && isLoopbackHost(url.hostname) ? url.origin : null;
  } catch {
    return null;
  }
}

export function depsFromEnv(env: Env): Deps {
  // Structured logs only. Never pass emails, IP addresses, links or request bodies here.
  // biome-ignore lint/suspicious/noConsole: console is the Workers structured-logging sink.
  const log = (entry: Record<string, string>) => console.log(JSON.stringify(entry));
  return {
    assets: env.ASSETS,
    store: d1Store(env.DB),
    limiter: env.EARLY_ACCESS_LIMITER,
    now: () => new Date(),
    log,
    // biome-ignore lint/suspicious/noConsole: the local-development transport prints to the console.
    mailer: mailerFromEnv(env, (line) => console.log(line)),
    newToken,
    dailyEmailLimit: dailyEmailLimit(env.EMAIL_DAILY_LIMIT),
    localLinkOrigin: localLinkOrigin(env.EMAIL_LINK_ORIGIN),
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
  return `${action}:${networkKey(ip)}`;
}

/**
 * The unit a client controls. IPv4: the address. IPv6: the /64 prefix, since one end user
 * typically holds a whole /64 and could otherwise rotate addresses to evade the limit.
 */
export function networkKey(ip: string): string {
  if (!ip.includes(":")) return ip;
  const [head = "", tail = ""] = ip.toLowerCase().split("::");
  const headGroups = head ? head.split(":") : [];
  const tailGroups = tail ? tail.split(":") : [];
  const missing = Math.max(0, 8 - headGroups.length - tailGroups.length);
  const groups = ip.includes("::") ? [...headGroups, ...Array(missing).fill("0"), ...tailGroups] : headGroups;
  const prefix = groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "") || "0");
  return `${prefix.join(":")}::/64`;
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

/** Method, origin and rate-limit checks shared by every endpoint. */
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

/**
 * Origin for links in emails. Production (Resend) always links to the canonical site, never to
 * anything taken from the request. The test and development transports link to the local server
 * named by EMAIL_LINK_ORIGIN and refuse to run without it, so a misconfigured deployment fails
 * loudly instead of silently sending nothing.
 */
function linkOriginFor(deps: Deps): string | null {
  if (deps.mailer.transport === "resend") return SITE_ORIGIN;
  if (deps.mailer.transport === "invalid") return null;
  return deps.localLinkOrigin;
}

function emailNotPossible(deps: Deps): Response {
  deps.log({ level: "error", event: "email.transport_misconfigured", transport: deps.mailer.transport });
  return apiError(502, "email_failed", EMAIL_FAILED_MESSAGE);
}

/** Maps a failed send to its response; null for outcomes that answer with the shared success body. */
function sendFailureResponse(outcome: SendOutcome | RemovalOutcome): Response | null {
  switch (outcome) {
    case "send_failed":
      return apiError(502, "email_failed", EMAIL_FAILED_MESSAGE);
    case "budget_exhausted":
      return apiError(503, "email_unavailable", EMAIL_UNAVAILABLE_MESSAGE, { "retry-after": "3600" });
    case "store_failed":
      return apiError(500, "server_error", SERVER_ERROR_MESSAGE);
    default:
      return null;
  }
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
  if (input.value.isBot) {
    return json(SIGNUP_OK, 200);
  }
  const linkOrigin = linkOriginFor(deps);
  if (!linkOrigin) return emailNotPossible(deps);
  let outcome: SendOutcome;
  try {
    outcome = await requestSignup(
      deps,
      {
        email: input.value.email,
        source: input.value.source,
        createdAt: deps.now().toISOString(),
        consentVersion: CONSENT_VERSION,
      },
      linkOrigin,
    );
  } catch (error) {
    deps.log({ level: "error", event: "early_access.store_failed", error: errorName(error) });
    return apiError(500, "server_error", SERVER_ERROR_MESSAGE);
  }
  return sendFailureResponse(outcome) ?? json(SIGNUP_OK, 200);
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
  const linkOrigin = linkOriginFor(deps);
  if (!linkOrigin) return emailNotPossible(deps);
  let outcome: RemovalOutcome;
  try {
    outcome = await requestRemoval(deps, input.value.email, linkOrigin);
  } catch (error) {
    deps.log({ level: "error", event: "early_access.remove_failed", error: errorName(error) });
    return apiError(500, "server_error", SERVER_ERROR_MESSAGE);
  }
  return sendFailureResponse(outcome) ?? json(REMOVE_OK, 200);
};

/** Shared by the two link endpoints: POST only, so a link scanner's GET changes nothing. */
function linkHandler(
  action: string,
  use: (deps: Deps, token: string) => Promise<boolean>,
  ok: { ok: true; message: string },
): ApiHandler {
  return async (request, url, deps) => {
    const blocked = await guard(request, url, deps, action);
    if (blocked) {
      return blocked;
    }
    const body = await readBody(request);
    if (!body.ok) {
      return body.response;
    }
    const input = validateToken(body.value);
    if (!input.ok) {
      return apiError(400, input.error, input.message);
    }
    try {
      return (await use(deps, input.value.token)) ? json(ok, 200) : apiError(410, "invalid_link", INVALID_LINK_MESSAGE);
    } catch (error) {
      deps.log({ level: "error", event: `early_access.${action}_failed`, error: errorName(error) });
      return apiError(500, "server_error", SERVER_ERROR_MESSAGE);
    }
  };
}

export const handleConfirm = linkHandler("confirm", confirmWithToken, CONFIRMED_OK);
export const handleRemoveConfirm = linkHandler("remove_confirm", removeWithToken, REMOVED_OK);

const API_ROUTES: Readonly<Record<string, ApiHandler>> = {
  [SIGNUP_PATH]: handleSignup,
  [REMOVE_PATH]: handleRemove,
  [CONFIRM_PATH]: handleConfirm,
  [REMOVE_CONFIRM_PATH]: handleRemoveConfirm,
};

/** Product news replaced the public changelog. Keep old bookmarks and indexed URLs useful. */
function legacyPageRedirect(url: URL): string | null {
  return url.pathname === "/changelog" || url.pathname === "/changelog/" ? `/updates${url.search}` : null;
}

/** Routes one request. Security headers are applied to every response, including redirects. */
export async function handleRequest(request: Request, deps: Deps): Promise<Response> {
  const url = new URL(request.url);
  const csp = await siteCsp();

  let response: Response;
  // A leading `//` could be echoed into a Location header as a protocol-relative URL.
  if (url.pathname.startsWith("//")) {
    return withSecurityHeaders(new Response("Not found", { status: 404 }), url.pathname, csp);
  }
  const redirect = canonicalRedirect(url, request);
  const legacyRedirect = legacyPageRedirect(url);
  if (redirect) {
    response = new Response(null, { status: 301, headers: { location: redirect } });
  } else if (legacyRedirect) {
    response = new Response(null, { status: 301, headers: { location: legacyRedirect } });
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

  const secured = withSecurityHeaders(response, url.pathname, csp);
  // The private owner dashboard is never indexed or cached by intermediaries (docs/OWNER_ANALYTICS.md).
  if (url.pathname === "/owner" || url.pathname.startsWith("/owner/")) {
    secured.headers.set("x-robots-tag", "noindex, nofollow, noarchive");
    secured.headers.set("cache-control", "no-store");
  }
  return secured;
}
