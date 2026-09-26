import type { AccountStore } from "./account-store";
import { readJsonBody } from "./body";
import { constantTimeEqual, hmacSha256Base64Url, randomBase64Url, sha256Base64Url } from "./crypto";
import { isPkceChallenge, isPkceVerifier, verifyPkce } from "./github-oauth";
import { apiError, json } from "./http";
import {
  buildOpenIdAuthorizeUrl,
  exchangeOpenIdIdentity,
  type OpenIdClientConfig,
  type OpenIdIdentity,
  type OpenIdProvider,
} from "./openid-connect";

const TEN_MINUTES_MS = 10 * 60 * 1000;
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const AUTHORIZATION_CODE = /^[\x21-\x7e]{1,2048}$/;
const FLOW_VALUE = /^[A-Za-z0-9_-]{43}$/;
const GENERIC_SIGN_IN = "Sign-in could not be completed. Start again.";

type ExchangeIdentity = (
  fetcher: typeof fetch,
  config: OpenIdClientConfig,
  code: string,
  verifier: string,
  nonce: string,
  now: Date,
) => Promise<OpenIdIdentity>;

export interface OpenIdAuthService {
  start(request: Request, provider: OpenIdProvider): Promise<Response>;
  callback(request: Request, provider: OpenIdProvider): Promise<Response>;
  complete(request: Request, provider: OpenIdProvider): Promise<Response>;
  logout(request: Request): Promise<Response>;
}

interface Options {
  store: AccountStore;
  clients: Partial<Record<OpenIdProvider, OpenIdClientConfig>>;
  rateLimitKey: string;
  now: () => Date;
  fetcher?: typeof fetch;
  exchangeIdentity?: ExchangeIdentity;
}

function noBrowserWrite(request: Request): Response | null {
  const origin = request.headers.get("origin");
  return origin !== null && origin !== "https://kalcoded.com"
    ? apiError(403, "forbidden", "This request origin is not allowed.")
    : null;
}

function clientBucket(request: Request): string {
  return request.headers.get("cf-connecting-ip")?.trim() || "unknown";
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function readInput(request: Request): Promise<Record<string, unknown> | Response> {
  const body = await readJsonBody(request);
  if (!body.ok) {
    const status = body.reason === "unsupported_media_type" ? 415 : body.reason === "payload_too_large" ? 413 : 400;
    return apiError(status, body.reason, GENERIC_SIGN_IN);
  }
  return object(body.value) ?? apiError(400, "invalid_request", GENERIC_SIGN_IN);
}

function unavailable(): Response {
  return apiError(503, "sign_in_unavailable", "This sign-in provider is not configured.");
}

export function openIdAuthService(options: Options): OpenIdAuthService {
  const { store, clients, rateLimitKey, now, fetcher = fetch } = options;
  const exchangeIdentity = options.exchangeIdentity ?? exchangeOpenIdIdentity;

  async function rateAllowed(
    request: Request,
    action: "oauth_start" | "oauth_complete",
    limit: number,
  ): Promise<boolean> {
    const at = now();
    const bucketHash = await hmacSha256Base64Url(rateLimitKey, clientBucket(request));
    return store.allowRateLimit({
      bucketHash,
      action,
      now: at.toISOString(),
      windowStart: new Date(at.getTime() - RATE_WINDOW_MS).toISOString(),
      retentionStart: new Date(at.getTime() - 24 * 60 * 60 * 1000).toISOString(),
      limit,
    });
  }

  return {
    async start(request, provider) {
      const config = clients[provider];
      if (!config) return unavailable();
      const forbidden = noBrowserWrite(request);
      if (forbidden) return forbidden;
      if (!(await rateAllowed(request, "oauth_start", 10))) {
        return apiError(429, "rate_limited", "Please wait before trying again.", { "retry-after": "600" });
      }
      const body = await readInput(request);
      if (body instanceof Response) return body;
      if (Object.keys(body).length !== 1 || !isPkceChallenge(body.codeChallenge)) {
        return apiError(400, "invalid_request", GENERIC_SIGN_IN);
      }

      const state = randomBase64Url();
      const nonce = randomBase64Url();
      const createdAt = now();
      const expiresAt = new Date(createdAt.getTime() + TEN_MINUTES_MS);
      await store.createOpenIdAttempt({
        stateHash: await sha256Base64Url(state),
        provider,
        codeChallenge: body.codeChallenge,
        nonceHash: await sha256Base64Url(nonce),
        rateBucket: await hmacSha256Base64Url(rateLimitKey, clientBucket(request)),
        createdAt: createdAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
      });
      return json(
        {
          ok: true,
          authorizeUrl: buildOpenIdAuthorizeUrl(config, state, body.codeChallenge, nonce),
          nonce,
          expiresAt: expiresAt.toISOString(),
        },
        200,
      );
    },

    async callback(request, provider) {
      const url = new URL(request.url);
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");
      const destination = new URL(`kalcode://auth/${provider}`);
      if (error || !code || !state || !AUTHORIZATION_CODE.test(code) || !FLOW_VALUE.test(state)) {
        destination.searchParams.set("error", error === "access_denied" ? "sign_in_canceled" : "sign_in_failed");
        if (state && FLOW_VALUE.test(state)) destination.searchParams.set("state", state);
      } else {
        destination.searchParams.set("code", code);
        destination.searchParams.set("state", state);
      }
      return new Response(null, {
        status: 302,
        headers: {
          location: destination.toString(),
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
        },
      });
    },

    async complete(request, provider) {
      const config = clients[provider];
      if (!config) return unavailable();
      const forbidden = noBrowserWrite(request);
      if (forbidden) return forbidden;
      if (!(await rateAllowed(request, "oauth_complete", 20))) {
        return apiError(429, "rate_limited", "Please wait before trying again.", { "retry-after": "600" });
      }
      const body = await readInput(request);
      if (body instanceof Response) return body;
      const { state, code, codeVerifier, nonce } = body;
      if (
        Object.keys(body).length !== 4 ||
        typeof state !== "string" ||
        !FLOW_VALUE.test(state) ||
        typeof code !== "string" ||
        !AUTHORIZATION_CODE.test(code) ||
        !isPkceVerifier(codeVerifier) ||
        typeof nonce !== "string" ||
        !FLOW_VALUE.test(nonce)
      ) {
        return apiError(400, "invalid_request", GENERIC_SIGN_IN);
      }

      const stateHash = await sha256Base64Url(state);
      const nonceHash = await sha256Base64Url(nonce);
      const attempt = await store.openIdAttempt(stateHash, provider);
      const completedAt = now();
      if (
        !attempt ||
        attempt.consumedAt ||
        attempt.expiresAt <= completedAt.toISOString() ||
        !constantTimeEqual(attempt.nonceHash, nonceHash) ||
        !(await verifyPkce(codeVerifier, attempt.codeChallenge))
      ) {
        return apiError(400, "sign_in_failed", GENERIC_SIGN_IN);
      }
      if (
        !(await store.consumeOpenIdAttempt({
          stateHash,
          provider,
          codeChallenge: attempt.codeChallenge,
          nonceHash: attempt.nonceHash,
          consumedAt: completedAt.toISOString(),
        }))
      ) {
        return apiError(400, "sign_in_failed", GENERIC_SIGN_IN);
      }

      try {
        const identity = await exchangeIdentity(fetcher, config, code, codeVerifier, nonce, completedAt);
        if (identity.provider !== provider) throw new Error("provider mismatch");
        const accountId = `acct_${await sha256Base64Url(`${provider}:${identity.subject}`)}`;
        const storedAccountId = await store.createOrGetOpenIdAccount({
          accountId,
          provider,
          subject: identity.subject,
          email: identity.email,
          now: completedAt.toISOString(),
        });
        if (!storedAccountId) return apiError(400, "sign_in_failed", GENERIC_SIGN_IN);
        const token = `kcs_${randomBase64Url()}`;
        const expiresAt = new Date(completedAt.getTime() + SESSION_MS);
        if (
          !(await store.createSession({
            tokenHash: await sha256Base64Url(token),
            accountId: storedAccountId,
            createdAt: completedAt.toISOString(),
            expiresAt: expiresAt.toISOString(),
            clientKind: "desktop",
          }))
        ) {
          return apiError(400, "sign_in_failed", GENERIC_SIGN_IN);
        }
        return json({ ok: true, token, accountId: storedAccountId, expiresAt: expiresAt.toISOString() }, 200);
      } catch {
        return apiError(400, "sign_in_failed", GENERIC_SIGN_IN);
      }
    },

    async logout(request) {
      const forbidden = noBrowserWrite(request);
      if (forbidden) return forbidden;
      const match = /^Bearer (kcs_[A-Za-z0-9_-]{43})$/.exec(request.headers.get("authorization") ?? "");
      if (match?.[1]) await store.revokeSession(await sha256Base64Url(match[1]), now().toISOString());
      return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    },
  };
}
