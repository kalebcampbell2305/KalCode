import type { AccountStore } from "./account-store";
import { clearSessionCookie, sessionCookie, sessionToken } from "./auth";
import { readJsonBody } from "./body";
import { constantTimeEqual, hmacSha256Base64Url, randomBase64Url, sha256Base64Url } from "./crypto";
import { isPkceChallenge, isPkceVerifier, verifyPkce } from "./github-oauth";
import { apiError, json } from "./http";
import { nativeAuthHandoff } from "./native-auth-handoff";
import {
  buildOpenIdAuthorizeUrl,
  exchangeOpenIdIdentity,
  type OpenIdClientConfig,
  OpenIdExchangeError,
  type OpenIdFailureStage,
  type OpenIdIdentity,
  type OpenIdProvider,
} from "./openid-connect";

const TEN_MINUTES_MS = 10 * 60 * 1000;
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const AUTHORIZATION_CODE = /^[\x21-\x7e]{1,2048}$/;
const FLOW_VALUE = /^[A-Za-z0-9_-]{43}$/;
const GENERIC_SIGN_IN = "Sign-in could not be completed. Start again.";
const WEBSITE_ORIGIN = "https://kalcoded.com";
const WEBSITE_ACCOUNT = "https://kalcoded.com/account";

type AuthClientKind = "desktop" | "website";

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
  log?: (entry: Record<string, string>) => void;
}

function exchangeFailureStage(error: unknown): OpenIdFailureStage {
  if (error instanceof OpenIdExchangeError) {
    switch (error.stage) {
      case "discovery":
      case "token_exchange":
      case "token_parse":
      case "signature":
      case "claims":
      case "claims_email":
      case "claims_email_verification_missing":
      case "claims_email_verification_type":
      case "claims_email_verification_affirmative_text":
      case "claims_email_verification_denied":
        return error.stage;
    }
  }
  return "token_exchange";
}

function originAllowed(request: Request, clientKind: AuthClientKind): boolean {
  const origin = request.headers.get("origin");
  return clientKind === "website" ? origin === WEBSITE_ORIGIN : origin === null;
}

function forbiddenOrigin(): Response {
  return apiError(403, "forbidden", "This request origin is not allowed.");
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

  function failed(provider: OpenIdProvider, stage: OpenIdFailureStage): Response {
    try {
      options.log?.({ level: "warn", event: "api.oidc_sign_in_failed", provider, stage });
    } catch {
      // Diagnostics must never change the authentication result.
    }
    return apiError(400, "sign_in_failed", GENERIC_SIGN_IN);
  }

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
      const body = await readInput(request);
      if (body instanceof Response) return body;
      const clientKind: AuthClientKind | null =
        body.client === undefined ? "desktop" : body.client === "website" ? "website" : null;
      const expectedKeys = clientKind === "website" ? 2 : 1;
      if (!clientKind || Object.keys(body).length !== expectedKeys || !isPkceChallenge(body.codeChallenge)) {
        return apiError(400, "invalid_request", GENERIC_SIGN_IN);
      }
      if (!originAllowed(request, clientKind)) return forbiddenOrigin();
      if (!(await rateAllowed(request, "oauth_start", 10))) {
        return apiError(429, "rate_limited", "Please wait before trying again.", { "retry-after": "600" });
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
        clientKind,
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
      if (!clients[provider]) return unavailable();
      const url = new URL(request.url);
      const codes = url.searchParams.getAll("code");
      const states = url.searchParams.getAll("state");
      const errors = url.searchParams.getAll("error");
      const state = states.length === 1 ? states[0] : null;
      const success = codes.length === 1 && errors.length === 0 && AUTHORIZATION_CODE.test(codes[0] ?? "");
      const failure = codes.length === 0 && errors.length === 1;
      if (!state || !FLOW_VALUE.test(state) || (!success && !failure)) {
        return apiError(400, "sign_in_failed", GENERIC_SIGN_IN);
      }
      const attempt = await store.openIdAttempt(await sha256Base64Url(state), provider);
      const callbackAt = now().toISOString();
      if (!attempt || attempt.consumedAt || attempt.expiresAt <= callbackAt) {
        return apiError(400, "sign_in_failed", GENERIC_SIGN_IN);
      }
      const error = failure ? (errors[0] === "access_denied" ? "sign_in_canceled" : "sign_in_failed") : null;
      if (attempt.clientKind === "website") {
        const destination = new URL(WEBSITE_ACCOUNT);
        const fragment = new URLSearchParams({ socialProvider: provider });
        if (error) fragment.set("socialError", error);
        else fragment.set("socialCode", codes[0] as string);
        fragment.set("socialState", state);
        destination.hash = fragment.toString();
        return new Response(null, {
          status: 302,
          headers: {
            location: destination.toString(),
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
          },
        });
      }
      return error
        ? nativeAuthHandoff(provider, { state, error })
        : nativeAuthHandoff(provider, { state, code: codes[0] as string });
    },

    async complete(request, provider) {
      const config = clients[provider];
      if (!config) return unavailable();
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
      if (!(await rateAllowed(request, "oauth_complete", 20))) {
        return apiError(429, "rate_limited", "Please wait before trying again.", { "retry-after": "600" });
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
      if (!originAllowed(request, attempt.clientKind)) return forbiddenOrigin();
      if (
        !(await store.consumeOpenIdAttempt({
          stateHash,
          provider,
          codeChallenge: attempt.codeChallenge,
          nonceHash: attempt.nonceHash,
          clientKind: attempt.clientKind,
          consumedAt: completedAt.toISOString(),
        }))
      ) {
        return apiError(400, "sign_in_failed", GENERIC_SIGN_IN);
      }

      let identity: OpenIdIdentity;
      try {
        identity = await exchangeIdentity(fetcher, config, code, codeVerifier, nonce, completedAt);
      } catch (error) {
        return failed(provider, exchangeFailureStage(error));
      }
      if (identity.provider !== provider) return failed(provider, "account_binding");

      let storedAccountId: string | null;
      try {
        const accountId = `acct_${await sha256Base64Url(`${provider}:${identity.subject}`)}`;
        storedAccountId = await store.createOrGetOpenIdAccount({
          accountId,
          provider,
          subject: identity.subject,
          email: identity.email,
          now: completedAt.toISOString(),
        });
      } catch {
        return failed(provider, "account_binding");
      }
      if (!storedAccountId) return failed(provider, "identity_collision");

      try {
        const token = `kcs_${randomBase64Url()}`;
        const expiresAt = new Date(completedAt.getTime() + SESSION_MS);
        if (
          !(await store.createSession({
            tokenHash: await sha256Base64Url(token),
            accountId: storedAccountId,
            createdAt: completedAt.toISOString(),
            expiresAt: expiresAt.toISOString(),
            clientKind: attempt.clientKind,
          }))
        ) {
          return failed(provider, "session_creation");
        }
        return attempt.clientKind === "website"
          ? json({ ok: true, status: "signed_in", expiresAt: expiresAt.toISOString() }, 200, {
              "set-cookie": sessionCookie(token, SESSION_MS / 1000),
            })
          : json({ ok: true, token, accountId: storedAccountId, expiresAt: expiresAt.toISOString() }, 200);
      } catch {
        return failed(provider, "session_creation");
      }
    },

    async logout(request) {
      const origin = request.headers.get("origin");
      if (origin !== null && origin !== WEBSITE_ORIGIN) return forbiddenOrigin();
      const token = sessionToken(request);
      if (token) await store.revokeSession(await sha256Base64Url(token), now().toISOString());
      return new Response(null, {
        status: 204,
        headers: { "cache-control": "no-store", "set-cookie": clearSessionCookie() },
      });
    },
  };
}
