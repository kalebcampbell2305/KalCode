/**
 * The complete API surface (tests/unit/router.test.ts pins this table).
 *
 * There is deliberately no endpoint that creates, changes or revokes an entitlement. The only
 * write is recording the authenticated caller's own KalVoice Requests in the usage ledger.
 */

import type { Authenticator, AuthResult } from "./auth";
import { readJsonBody } from "./body";
import { buildEntitlement, resolveEntitlement } from "./entitlement";
import { apiError, json } from "./http";
import { type PublicKeyEntry, publishedKeySet } from "./keys";
import type { AccountRecord, EntitlementStore, RequestSource, UsageStore } from "./store";
import { type EntitlementSigningKey, signEntitlement, signUsageReceipt } from "./token";
import { buildUsageReceipt, CLIENT_REQUEST_ID, type UsageContext, usageContext, usageSummary } from "./usage";

export interface Deps {
  store: EntitlementStore & UsageStore;
  auth: Authenticator;
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
  /** `account`: the caller must be an authenticated account. `public`: anyone. */
  access: "account" | "public";
  handler: Handler;
}

export const ENTITLEMENT_PATH = "/v1/entitlement";
export const KEYS_PATH = "/v1/entitlement/keys";
export const KALVOICE_USAGE_PATH = "/v1/kalvoice/usage";
export const KALVOICE_REQUESTS_PATH = "/v1/kalvoice/requests";

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

/** The caller's own signed entitlement. */
const getEntitlement: Handler = async (request, deps) => {
  const account = await authenticatedAccount(request, deps);
  if (!account) return unauthenticated();
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

const BODY_ERRORS = {
  unsupported_media_type: [415, "Send the request as application/json."],
  payload_too_large: [413, "The request body is too large."],
  invalid_json: [400, "The request body is not valid JSON."],
} as const;

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
  { method: "GET", path: ENTITLEMENT_PATH, access: "account", handler: getEntitlement },
  { method: "GET", path: KEYS_PATH, access: "public", handler: getKeys },
  { method: "GET", path: KALVOICE_USAGE_PATH, access: "account", handler: getUsage },
  { method: "POST", path: KALVOICE_REQUESTS_PATH, access: "account", handler: postRequest },
];

export async function handleRequest(request: Request, deps: Deps): Promise<Response> {
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
