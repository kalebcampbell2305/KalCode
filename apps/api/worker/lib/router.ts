/**
 * The complete API surface. Every route is read-only: there is deliberately no endpoint that
 * creates, changes or revokes an entitlement (tests/unit/routes.test.ts pins this table).
 */

import type { Authenticator } from "./auth";
import { buildEntitlement, resolveEntitlement } from "./entitlement";
import { apiError, json } from "./http";
import { type PublicKeyEntry, publishedKeySet } from "./keys";
import type { EntitlementStore } from "./store";
import { type EntitlementSigningKey, signEntitlement } from "./token";

export interface Deps {
  store: EntitlementStore;
  auth: Authenticator;
  /** The current signing key, or null when none is configured (entitlements unavailable). */
  signingKey: () => Promise<EntitlementSigningKey | null>;
  previousPublicKeys: () => readonly PublicKeyEntry[];
  now: () => Date;
  log: (entry: Record<string, string>) => void;
}

type Handler = (request: Request, deps: Deps) => Promise<Response>;

export interface Route {
  method: "GET";
  path: string;
  /** `account`: the caller must be an authenticated account. `public`: anyone. */
  access: "account" | "public";
  handler: Handler;
}

export const ENTITLEMENT_PATH = "/v1/entitlement";
export const KEYS_PATH = "/v1/entitlement/keys";

const SERVER_ERROR_MESSAGE = "Something went wrong on our side. Please try again later.";

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

/** The caller's own signed entitlement. The account comes only from `deps.auth`. */
const getEntitlement: Handler = async (request, deps) => {
  const auth = await deps.auth.authenticate(request);
  if (!auth.ok || !(await deps.store.accountExists(auth.accountId))) {
    return apiError(401, "unauthenticated", "Sign in to KalCode to fetch your entitlement.", {
      "www-authenticate": 'Bearer realm="kalcode"',
    });
  }
  const key = await deps.signingKey();
  if (!key) {
    deps.log({ level: "error", event: "entitlement.signing_key_unavailable" });
    return apiError(503, "entitlement_unavailable", "Entitlements are temporarily unavailable.");
  }
  const now = deps.now();
  const resolved = await resolveEntitlement(deps.store, auth.accountId, now);
  const entitlement = buildEntitlement(auth.accountId, resolved, now, key.keyId);
  const token = await signEntitlement(entitlement, key);
  return json({ ok: true, token, entitlement }, 200);
};

/** Public verification keys, so any party can check a document's signature. */
const getKeys: Handler = async (_request, deps) => {
  const key = await deps.signingKey();
  const keys = publishedKeySet(key ? { kid: key.keyId, x: key.publicKey } : null, deps.previousPublicKeys());
  return json({ keys }, 200, { "cache-control": "public, max-age=300" });
};

export const ROUTES: readonly Route[] = [
  { method: "GET", path: ENTITLEMENT_PATH, access: "account", handler: getEntitlement },
  { method: "GET", path: KEYS_PATH, access: "public", handler: getKeys },
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
