/**
 * The complete API surface (tests/unit/router.test.ts pins this table).
 *
 * Account/session writes stay in AccountStore, billing reconciliation writes stay in BillingStore,
 * and KalVoice Request writes stay in UsageStore. Public paid grants can change only after a
 * verified live-mode Stripe webhook; OWNER remains operator-only.
 */

import type { AccountStore } from "./account-store";
import type { Authenticator, AuthResult } from "./auth";
import type { AccountAuthService } from "./auth-routes";
import type { BillingService } from "./billing-routes";
import { readJsonBody } from "./body";
import type { EmailAuthService } from "./email-auth";
import { buildEntitlement, resolveEntitlement } from "./entitlement";
import type { GameService } from "./game-routes";
import { apiError, json } from "./http";
import type { InsightsService } from "./insights";
import { type PublicKeyEntry, publishedKeySet } from "./keys";
import type { OpenIdAuthService } from "./openid-auth-routes";
import { normalizeDisplayName, parseProfileUpdate } from "./profile";
import type { AccountRecord, EntitlementStore, RequestSource, UsageStore } from "./store";
import { type EntitlementSigningKey, signEntitlement, signUsageReceipt } from "./token";
import { buildUsageReceipt, CLIENT_REQUEST_ID, type UsageContext, usageContext, usageSummary } from "./usage";

export interface Deps {
  store: EntitlementStore & UsageStore;
  auth: Authenticator;
  accountStore?: AccountStore;
  accountAuth?: AccountAuthService | null;
  openIdAuth?: OpenIdAuthService | null;
  emailAuth?: EmailAuthService | null;
  billing?: BillingService | null;
  /** Private owner dashboard data; served only to an account holding an active OWNER grant. */
  insights?: InsightsService | null;
  /** KalCode games: ownership, perks, the game's device sign-in and signed license (game-routes.ts). */
  games?: GameService | null;
  /** The current signing key, or null when none is configured (signed documents unavailable). */
  signingKey: () => Promise<EntitlementSigningKey | null>;
  previousPublicKeys: () => readonly PublicKeyEntry[];
  now: () => Date;
  log: (entry: Record<string, string>) => void;
}

type Handler = (request: Request, deps: Deps) => Promise<Response>;

export interface Route {
  method: "GET" | "POST";
  path: string;
  /**
   * `account`: the caller must be an authenticated account. `owner`: an authenticated account with
   * an active OWNER operator grant (read-only owner reporting). `public`: anyone.
   */
  access: "account" | "owner" | "public";
  handler: Handler;
}

export const ENTITLEMENT_PATH = "/v1/entitlement";
export const KEYS_PATH = "/v1/entitlement/keys";
export const KALVOICE_USAGE_PATH = "/v1/kalvoice/usage";
export const KALVOICE_REQUESTS_PATH = "/v1/kalvoice/requests";
export const ACCOUNT_PATH = "/v1/account";
export const ACCOUNT_PROFILE_PATH = "/v1/account/profile";
export const AUTH_GITHUB_START_PATH = "/v1/auth/github/start";
export const AUTH_GITHUB_CALLBACK_PATH = "/v1/auth/github/callback";
export const AUTH_GITHUB_COMPLETE_PATH = "/v1/auth/github/complete";
export const AUTH_GOOGLE_START_PATH = "/v1/auth/google/start";
export const AUTH_GOOGLE_CALLBACK_PATH = "/v1/auth/google/callback";
export const AUTH_GOOGLE_COMPLETE_PATH = "/v1/auth/google/complete";
export const AUTH_MICROSOFT_START_PATH = "/v1/auth/microsoft/start";
export const AUTH_MICROSOFT_CALLBACK_PATH = "/v1/auth/microsoft/callback";
export const AUTH_MICROSOFT_COMPLETE_PATH = "/v1/auth/microsoft/complete";
export const AUTH_LOGOUT_PATH = "/v1/auth/logout";
export const AUTH_EMAIL_START_PATH = "/v1/auth/email/start";
export const AUTH_EMAIL_VERIFY_PATH = "/v1/auth/email/verify";
export const AUTH_EMAIL_POLL_PATH = "/v1/auth/email/poll";
export const AUTH_REFRESH_PATH = "/v1/auth/session/refresh";
export const ACCOUNT_ACTIVATE_FREE_PATH = "/v1/account/activate-free";
export const ACCOUNT_DELETE_START_PATH = "/v1/account/delete/start";
export const BILLING_CHECKOUT_PATH = "/v1/billing/checkout";
export const BILLING_PORTAL_PATH = "/v1/billing/portal";
export const BILLING_STATUS_PATH = "/v1/billing/status";
export const BILLING_WEBHOOK_PATH = "/v1/billing/webhook";
export const INSIGHTS_DISTRIBUTION_PATH = "/v1/insights/distribution";
export const INSIGHTS_REVENUE_PATH = "/v1/insights/revenue";
export const GAMES_LIBRARY_PATH = "/v1/games/library";
export const GAMES_DEVICE_APPROVE_PATH = "/v1/games/device/approve";
export const GAMES_CHECKOUT_PATH = "/v1/games/checkout";
export const GAMES_DOWNLOADS_PATH = "/v1/games/downloads";
export const GAMES_DEVICE_START_PATH = "/v1/games/device/start";
export const GAMES_DEVICE_TOKEN_PATH = "/v1/games/device/token";
export const GAMES_LICENSE_REFRESH_PATH = "/v1/games/license/refresh";
export const GAMES_LICENSE_SIGN_OUT_PATH = "/v1/games/license/sign-out";
export const GAMES_LICENSE_KEYS_PATH = "/v1/games/license/keys";
export const GAMES_DOWNLOAD_PATH = "/v1/games/download";
export const GAMES_WEBHOOK_PATH = "/v1/games/webhook";

const SERVER_ERROR_MESSAGE = "Something went wrong on our side. Please try again later.";

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

function unauthenticated(): Response {
  return apiError(401, "unauthenticated", "Sign in to KalCode to use this endpoint.", {
    "www-authenticate": 'Bearer realm="kalcode"',
  });
}

function signingUnavailable(deps: Deps): Response {
  deps.log({ level: "error", event: "api.signing_key_unavailable" });
  return apiError(503, "signing_unavailable", "This service is temporarily unavailable.");
}

/** The caller's account, established only by `deps.auth` — never by anything in the request body. */
async function authenticatedAccount(request: Request, deps: Deps): Promise<AccountRecord | null> {
  const auth: AuthResult = await deps.auth.authenticate(request);
  if (!auth.ok) return null;
  return deps.store.account(auth.accountId);
}

function unavailable(): Response {
  return apiError(503, "service_unavailable", "This service is temporarily unavailable.");
}

function signInUnavailable(): Response {
  return apiError(503, "sign_in_unavailable", "This sign-in provider is not configured.");
}

const BODY_ERRORS = {
  unsupported_media_type: [415, "Send the request as application/json."],
  payload_too_large: [413, "The request body is too large."],
  invalid_json: [400, "The request body is not valid JSON."],
} as const;

const getAccount: Handler = async (request, deps) => {
  const account = await authenticatedAccount(request, deps);
  if (!account) return unauthenticated();
  if (!deps.accountStore) return unavailable();
  const profile = await deps.accountStore.accountProfile(account.id);
  if (!profile) return unauthenticated();
  // Exactly the fields every shipped client accepts: installed desktop builds parse this body with
  // `deny_unknown_fields`, so new account fields are served only by ACCOUNT_PROFILE_PATH.
  const { id, email, activatedAt } = profile;
  return json({ ok: true, account: { id, email, activatedAt } }, 200);
};

/** The caller's account including its profile (display name). */
const getAccountProfile: Handler = async (request, deps) => {
  const account = await authenticatedAccount(request, deps);
  if (!account) return unauthenticated();
  if (!deps.accountStore) return unavailable();
  const profile = await deps.accountStore.accountProfile(account.id);
  return profile ? json({ ok: true, account: profile }, 200) : unauthenticated();
};

/**
 * Sets or clears the caller's display name (`{"displayName": "<name>" | null}`; empty clears).
 * Cosmetic only: the account id, email, sign-in identities, billing and signed documents are
 * never touched. Same-site browser writes come only from kalcoded.com; a JSON body forces a CORS
 * preflight, which only kalcoded.com passes.
 */
const updateAccountProfile: Handler = async (request, deps) => {
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== "https://kalcoded.com") {
    return apiError(403, "forbidden", "This request origin is not allowed.");
  }
  const account = await authenticatedAccount(request, deps);
  if (!account) return unauthenticated();
  if (!deps.accountStore) return unavailable();
  const body = await readJsonBody(request);
  if (!body.ok) {
    const [status, message] = BODY_ERRORS[body.reason];
    return apiError(status, body.reason, message);
  }
  const update = parseProfileUpdate(body.value);
  if (!update) return apiError(400, "invalid_request", 'Send {"displayName": "<name>" | null}.');
  const name = normalizeDisplayName(update.displayName);
  if (!name.ok) {
    return apiError(
      400,
      "invalid_display_name",
      "Use 1–64 characters, without control or invisible formatting characters.",
    );
  }
  const profile = await deps.accountStore.setDisplayName(account.id, name.displayName);
  return profile ? json({ ok: true, account: profile }, 200) : unauthenticated();
};

const authStart: Handler = (request, deps) => deps.accountAuth?.start(request) ?? Promise.resolve(unavailable());
const authCallback: Handler = (request, deps) => deps.accountAuth?.callback(request) ?? Promise.resolve(unavailable());
const authComplete: Handler = (request, deps) => deps.accountAuth?.complete(request) ?? Promise.resolve(unavailable());
const googleAuthStart: Handler = (request, deps) =>
  deps.openIdAuth?.start(request, "google") ?? Promise.resolve(signInUnavailable());
const googleAuthCallback: Handler = (request, deps) =>
  deps.openIdAuth?.callback(request, "google") ?? Promise.resolve(signInUnavailable());
const googleAuthComplete: Handler = (request, deps) =>
  deps.openIdAuth?.complete(request, "google") ?? Promise.resolve(signInUnavailable());
const microsoftAuthStart: Handler = (request, deps) =>
  deps.openIdAuth?.start(request, "microsoft") ?? Promise.resolve(signInUnavailable());
const microsoftAuthCallback: Handler = (request, deps) =>
  deps.openIdAuth?.callback(request, "microsoft") ?? Promise.resolve(signInUnavailable());
const microsoftAuthComplete: Handler = (request, deps) =>
  deps.openIdAuth?.complete(request, "microsoft") ?? Promise.resolve(signInUnavailable());
const emailStart: Handler = (request, deps) => deps.emailAuth?.start(request) ?? Promise.resolve(unavailable());
const emailVerify: Handler = (request, deps) => deps.emailAuth?.verify(request) ?? Promise.resolve(unavailable());
const emailPoll: Handler = (request, deps) => deps.emailAuth?.poll(request) ?? Promise.resolve(unavailable());
const sessionRefresh: Handler = (request, deps) => deps.emailAuth?.refresh(request) ?? Promise.resolve(unavailable());
const sessionLogout: Handler = (request, deps) =>
  deps.emailAuth?.logout(request) ??
  deps.accountAuth?.logout(request) ??
  deps.openIdAuth?.logout(request) ??
  Promise.resolve(unavailable());

const activateFree: Handler = async (request, deps) => {
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== "https://kalcoded.com") {
    return apiError(403, "forbidden", "This request origin is not allowed.");
  }
  const account = await authenticatedAccount(request, deps);
  if (!account) return unauthenticated();
  if (!deps.accountStore) return unavailable();
  return (await deps.accountStore.activateFree(account.id, deps.now().toISOString()))
    ? json({ ok: true, tier: "free" }, 200)
    : unavailable();
};

const startAccountDelete: Handler = async (request, deps) => {
  const account = await authenticatedAccount(request, deps);
  if (!account) return unauthenticated();
  if (!deps.accountStore || !deps.emailAuth) return unavailable();
  const profile = await deps.accountStore.accountProfile(account.id);
  return profile ? deps.emailAuth.startDelete(request, account.id, profile.email) : unauthenticated();
};

async function requireActivated(accountId: string, deps: Deps): Promise<Response | null> {
  if (!deps.accountStore) return unavailable();
  const profile = await deps.accountStore.accountProfile(accountId);
  return profile?.activatedAt ? null : apiError(409, "account_not_activated", "Choose a plan to finish setup.");
}

const billingCheckout: Handler = async (request, deps) => {
  const account = await authenticatedAccount(request, deps);
  if (!account) return unauthenticated();
  return deps.billing?.checkout(request, account.id) ?? unavailable();
};

const billingPortal: Handler = async (request, deps) => {
  const account = await authenticatedAccount(request, deps);
  if (!account) return unauthenticated();
  return deps.billing?.portal(request, account.id) ?? unavailable();
};

const billingStatus: Handler = async (request, deps) => {
  const account = await authenticatedAccount(request, deps);
  if (!account) return unauthenticated();
  return deps.billing?.status(account.id) ?? unavailable();
};

/**
 * OWNER-only gate for read-only owner reporting. Identity comes only from the server-verified
 * session; the tier only from `resolveEntitlement` (an active OWNER grant with source `grant`).
 * Anything else is refused before any reporting code runs.
 */
async function requireOwner(request: Request, deps: Deps): Promise<Response | null> {
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== "https://kalcoded.com") {
    return apiError(403, "forbidden", "This request origin is not allowed.");
  }
  const account = await authenticatedAccount(request, deps);
  if (!account) return unauthenticated();
  const resolved = await resolveEntitlement(deps.store, account.id, deps.now());
  if (resolved.tier !== "owner") {
    deps.log({ level: "warn", event: "insights.forbidden" });
    return apiError(403, "forbidden", "This is not available for this account.");
  }
  return null;
}

const insightsDistribution: Handler = async (request, deps) =>
  (await requireOwner(request, deps)) ?? deps.insights?.distribution(request) ?? unavailable();

const insightsRevenue: Handler = async (request, deps) =>
  (await requireOwner(request, deps)) ?? deps.insights?.revenue(request) ?? unavailable();

/** Game routes for a signed-in website account: identity only from `deps.auth`. */
function accountGame(run: (games: GameService, request: Request, accountId: string) => Promise<Response>): Handler {
  return async (request, deps) => {
    const account = await authenticatedAccount(request, deps);
    if (!account) return unauthenticated();
    return deps.games ? run(deps.games, request, account.id) : unavailable();
  };
}

/** Game routes the game itself (or Stripe, or a download manager) calls; each authenticates its own way. */
function publicGame(run: (games: GameService, request: Request) => Promise<Response>): Handler {
  return async (request, deps) => (deps.games ? run(deps.games, request) : unavailable());
}

const gamesLibrary = accountGame((games, _request, accountId) => games.library(accountId));
const gamesApprove = accountGame((games, request, accountId) => games.approveDevice(request, accountId));
const gamesCheckout = accountGame((games, request, accountId) => games.checkout(request, accountId));
const gamesDownloads = accountGame((games, request, accountId) => games.downloadLink(request, accountId));
const gamesDeviceStart = publicGame((games, request) => games.startDevice(request));
const gamesDeviceToken = publicGame((games, request) => games.deviceToken(request));
const gamesRefresh = publicGame((games, request) => games.refreshLicense(request));
const gamesSignOut = publicGame((games, request) => games.signOut(request));
const gamesKeys = publicGame((games) => games.keys());
const gamesDownload = publicGame((games, request) => games.download(request));
const gamesWebhook = publicGame((games, request) => games.webhook(request));

const billingWebhook: Handler = (request, deps) => deps.billing?.webhook(request) ?? Promise.resolve(unavailable());

/** The caller's own signed entitlement. */
const getEntitlement: Handler = async (request, deps) => {
  const account = await authenticatedAccount(request, deps);
  if (!account) return unauthenticated();
  const activation = await requireActivated(account.id, deps);
  if (activation) return activation;
  const key = await deps.signingKey();
  if (!key) return signingUnavailable(deps);
  const now = deps.now();
  const resolved = await resolveEntitlement(deps.store, account.id, now);
  const entitlement = buildEntitlement(account.id, resolved, now, key.keyId);
  const token = await signEntitlement(entitlement, key);
  return json({ ok: true, token, entitlement }, 200);
};

/** Public verification keys, so any party can check a document's signature. */
const getKeys: Handler = async (_request, deps) => {
  const key = await deps.signingKey();
  const keys = publishedKeySet(key ? { kid: key.keyId, x: key.publicKey } : null, deps.previousPublicKeys());
  return json({ keys }, 200, { "cache-control": "public, max-age=300" });
};

async function usageResponse(
  context: UsageContext,
  used: number,
  key: EntitlementSigningKey,
  now: Date,
  extra: Record<string, unknown> = {},
): Promise<Response> {
  const receipt = await signUsageReceipt(buildUsageReceipt(context, used, now, key.keyId), key);
  return json({ ok: true, ...extra, usage: usageSummary(context, used), receipt }, 200);
}

/** The caller's KalVoice Request usage in the current cycle, with a signed receipt. */
const getUsage: Handler = async (request, deps) => {
  const account = await authenticatedAccount(request, deps);
  if (!account) return unauthenticated();
  const activation = await requireActivated(account.id, deps);
  if (activation) return activation;
  const key = await deps.signingKey();
  if (!key) return signingUnavailable(deps);
  const now = deps.now();
  const context = await usageContext(deps.store, account, now);
  const used = await deps.store.countRequests(
    account.id,
    context.period.start.toISOString(),
    context.period.end.toISOString(),
  );
  return usageResponse(context, used, key, now);
};

type RequestBody = { requestId: string; source: RequestSource };

function parseRequestBody(value: unknown): RequestBody | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { requestId, mode, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length > 0) return null;
  if (typeof requestId !== "string" || !CLIENT_REQUEST_ID.test(requestId)) return null;
  if (mode !== undefined && mode !== "online" && mode !== "offline") return null;
  return { requestId, source: mode === "offline" ? "offline_replay" : "online" };
}

/**
 * Counts one top-level KalVoice request for the caller, at most once per `requestId`.
 *   - `mode: "online"` (default): allowed and counted only while the cycle's allowance remains.
 *     OWNER is never denied.
 *   - `mode: "offline"`: reports a request the desktop already served offline within its signed
 *     offline allowance; it is always recorded (flagged if over the allowance), never refused.
 */
const postRequest: Handler = async (request, deps) => {
  // The API has no browser clients; a browser-originated write is refused outright.
  if (request.headers.has("origin")) {
    return apiError(403, "forbidden", "Browser requests are not accepted.");
  }
  const account = await authenticatedAccount(request, deps);
  if (!account) return unauthenticated();
  const activation = await requireActivated(account.id, deps);
  if (activation) return activation;
  const body = await readJsonBody(request);
  if (!body.ok) {
    const [status, message] = BODY_ERRORS[body.reason];
    return apiError(status, body.reason, message);
  }
  const input = parseRequestBody(body.value);
  if (!input) {
    return apiError(
      400,
      "invalid_request",
      'Send {"requestId": "<8–128 of A-Z a-z 0-9 _ ->", "mode": "online" | "offline"}.',
    );
  }
  const key = await deps.signingKey();
  if (!key) return signingUnavailable(deps);
  const now = deps.now();
  const context = await usageContext(deps.store, account, now);
  const result = await deps.store.recordRequest({
    accountId: account.id,
    clientRequestId: input.requestId,
    recordedAt: now.toISOString(),
    source: input.source,
    allowance: context.allowance,
    periodStart: context.period.start.toISOString(),
    periodEnd: context.period.end.toISOString(),
  });
  if (result.outcome === "denied") {
    deps.log({ level: "info", event: "kalvoice.allowance_exhausted", tier: context.tier });
  }
  return usageResponse(context, result.used, key, now, {
    allowed: result.outcome !== "denied",
    outcome: result.outcome,
  });
};

export const ROUTES: readonly Route[] = [
  { method: "GET", path: ACCOUNT_PATH, access: "account", handler: getAccount },
  { method: "GET", path: ACCOUNT_PROFILE_PATH, access: "account", handler: getAccountProfile },
  { method: "POST", path: ACCOUNT_PROFILE_PATH, access: "account", handler: updateAccountProfile },
  { method: "POST", path: AUTH_GITHUB_START_PATH, access: "public", handler: authStart },
  { method: "GET", path: AUTH_GITHUB_CALLBACK_PATH, access: "public", handler: authCallback },
  { method: "POST", path: AUTH_GITHUB_COMPLETE_PATH, access: "public", handler: authComplete },
  { method: "POST", path: AUTH_GOOGLE_START_PATH, access: "public", handler: googleAuthStart },
  { method: "GET", path: AUTH_GOOGLE_CALLBACK_PATH, access: "public", handler: googleAuthCallback },
  { method: "POST", path: AUTH_GOOGLE_COMPLETE_PATH, access: "public", handler: googleAuthComplete },
  { method: "POST", path: AUTH_MICROSOFT_START_PATH, access: "public", handler: microsoftAuthStart },
  { method: "GET", path: AUTH_MICROSOFT_CALLBACK_PATH, access: "public", handler: microsoftAuthCallback },
  { method: "POST", path: AUTH_MICROSOFT_COMPLETE_PATH, access: "public", handler: microsoftAuthComplete },
  { method: "POST", path: AUTH_EMAIL_START_PATH, access: "public", handler: emailStart },
  { method: "POST", path: AUTH_EMAIL_VERIFY_PATH, access: "public", handler: emailVerify },
  { method: "POST", path: AUTH_EMAIL_POLL_PATH, access: "public", handler: emailPoll },
  { method: "POST", path: AUTH_REFRESH_PATH, access: "public", handler: sessionRefresh },
  { method: "POST", path: AUTH_LOGOUT_PATH, access: "public", handler: sessionLogout },
  { method: "POST", path: ACCOUNT_ACTIVATE_FREE_PATH, access: "account", handler: activateFree },
  { method: "POST", path: ACCOUNT_DELETE_START_PATH, access: "account", handler: startAccountDelete },
  { method: "POST", path: BILLING_CHECKOUT_PATH, access: "account", handler: billingCheckout },
  { method: "POST", path: BILLING_PORTAL_PATH, access: "account", handler: billingPortal },
  { method: "GET", path: BILLING_STATUS_PATH, access: "account", handler: billingStatus },
  { method: "POST", path: BILLING_WEBHOOK_PATH, access: "public", handler: billingWebhook },
  { method: "GET", path: ENTITLEMENT_PATH, access: "account", handler: getEntitlement },
  { method: "GET", path: KEYS_PATH, access: "public", handler: getKeys },
  { method: "GET", path: KALVOICE_USAGE_PATH, access: "account", handler: getUsage },
  { method: "POST", path: KALVOICE_REQUESTS_PATH, access: "account", handler: postRequest },
  { method: "GET", path: INSIGHTS_DISTRIBUTION_PATH, access: "owner", handler: insightsDistribution },
  { method: "GET", path: INSIGHTS_REVENUE_PATH, access: "owner", handler: insightsRevenue },
  { method: "GET", path: GAMES_LIBRARY_PATH, access: "account", handler: gamesLibrary },
  { method: "POST", path: GAMES_DEVICE_APPROVE_PATH, access: "account", handler: gamesApprove },
  { method: "POST", path: GAMES_CHECKOUT_PATH, access: "account", handler: gamesCheckout },
  { method: "POST", path: GAMES_DOWNLOADS_PATH, access: "account", handler: gamesDownloads },
  { method: "POST", path: GAMES_DEVICE_START_PATH, access: "public", handler: gamesDeviceStart },
  { method: "POST", path: GAMES_DEVICE_TOKEN_PATH, access: "public", handler: gamesDeviceToken },
  { method: "POST", path: GAMES_LICENSE_REFRESH_PATH, access: "public", handler: gamesRefresh },
  { method: "POST", path: GAMES_LICENSE_SIGN_OUT_PATH, access: "public", handler: gamesSignOut },
  { method: "GET", path: GAMES_LICENSE_KEYS_PATH, access: "public", handler: gamesKeys },
  { method: "GET", path: GAMES_DOWNLOAD_PATH, access: "public", handler: gamesDownload },
  { method: "POST", path: GAMES_WEBHOOK_PATH, access: "public", handler: gamesWebhook },
];

async function dispatch(request: Request, deps: Deps): Promise<Response> {
  const { pathname } = new URL(request.url);
  const matching = ROUTES.filter((route) => route.path === pathname);
  if (matching.length === 0) {
    return apiError(404, "not_found", "There is no API endpoint at this address.");
  }
  const route = matching.find((candidate) => candidate.method === request.method);
  if (!route) {
    const allow = matching.map((candidate) => candidate.method).join(", ");
    return apiError(405, "method_not_allowed", `Use ${allow} for this endpoint.`, { allow });
  }
  try {
    return await route.handler(request, deps);
  } catch (error) {
    deps.log({ level: "error", event: "api.unhandled", error: errorName(error) });
    return apiError(500, "server_error", SERVER_ERROR_MESSAGE);
  }
}

export async function handleRequest(request: Request, deps: Deps): Promise<Response> {
  const origin = request.headers.get("origin");
  if (request.method === "OPTIONS") {
    const pathKnown = ROUTES.some((route) => route.path === new URL(request.url).pathname);
    if (!pathKnown || origin !== "https://kalcoded.com") {
      return apiError(403, "forbidden", "This request origin is not allowed.");
    }
    const methods = ROUTES.filter((route) => route.path === new URL(request.url).pathname)
      .map((route) => route.method)
      .join(", ");
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": origin,
        "access-control-allow-credentials": "true",
        "access-control-allow-methods": methods,
        "access-control-allow-headers": "content-type",
        vary: "Origin",
      },
    });
  }
  const response = await dispatch(request, deps);
  if (origin !== "https://kalcoded.com") return response;
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.set("access-control-allow-credentials", "true");
  headers.append("vary", "Origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
