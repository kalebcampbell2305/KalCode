import type { AccountStore } from "./account-store";
import { readJsonBody } from "./body";
import { hmacSha256Base64Url, randomBase64Url, sha256Base64Url } from "./crypto";
import {
  buildGitHubAuthorizeUrl,
  exchangeGitHubCode,
  fetchVerifiedGitHubIdentity,
  type GitHubIdentity,
  type GitHubOAuthConfig,
  isPkceChallenge,
  isPkceVerifier,
  revokeGitHubToken,
  verifyPkce,
} from "./github-oauth";
import { apiError, json } from "./http";

const TEN_MINUTES_MS = 10 * 60 * 1000;
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const NATIVE_CALLBACK = "kalcode://auth/github";
const OAUTH_VALUE = /^[A-Za-z0-9_-]{1,256}$/;
const GENERIC_SIGN_IN = "Sign-in could not be completed. Start again.";

export interface AccountAuthService {
  start(request: Request): Promise<Response>;
  callback(request: Request): Promise<Response>;
  complete(request: Request): Promise<Response>;
  logout(request: Request): Promise<Response>;
}

interface Options {
  store: AccountStore;
  github: GitHubOAuthConfig;
  rateLimitKey: string;
  now: () => Date;
  fetcher?: typeof fetch;
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

export function accountAuthService({ store, github, rateLimitKey, now, fetcher = fetch }: Options): AccountAuthService {
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
    async start(request) {
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
      const stateHash = await sha256Base64Url(state);
      const createdAt = now();
      const expiresAt = new Date(createdAt.getTime() + TEN_MINUTES_MS);
      await store.createOAuthAttempt({
        stateHash,
        codeChallenge: body.codeChallenge,
        rateBucket: await hmacSha256Base64Url(rateLimitKey, clientBucket(request)),
        createdAt: createdAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
      });
      return json(
        {
          ok: true,
          authorizeUrl: buildGitHubAuthorizeUrl(github, state, body.codeChallenge),
          expiresAt: expiresAt.toISOString(),
        },
        200,
      );
    },

    async callback(request) {
      const url = new URL(request.url);
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");
      const destination = new URL(NATIVE_CALLBACK);
      if (error || !code || !state || !OAUTH_VALUE.test(code) || !OAUTH_VALUE.test(state)) {
        destination.searchParams.set("error", "sign_in_failed");
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

    async complete(request) {
      const forbidden = noBrowserWrite(request);
      if (forbidden) return forbidden;
      if (!(await rateAllowed(request, "oauth_complete", 20))) {
        return apiError(429, "rate_limited", "Please wait before trying again.", { "retry-after": "600" });
      }
      const body = await readInput(request);
      if (body instanceof Response) return body;
      const { state, code, codeVerifier } = body;
      if (
        Object.keys(body).length !== 3 ||
        typeof state !== "string" ||
        !OAUTH_VALUE.test(state) ||
        typeof code !== "string" ||
        !OAUTH_VALUE.test(code) ||
        !isPkceVerifier(codeVerifier)
      ) {
        return apiError(400, "invalid_request", GENERIC_SIGN_IN);
      }
      const stateHash = await sha256Base64Url(state);
      const attempt = await store.oauthAttempt(stateHash);
      const completedAt = now();
      if (
        !attempt ||
        attempt.consumedAt ||
        attempt.expiresAt <= completedAt.toISOString() ||
        !(await verifyPkce(codeVerifier, attempt.codeChallenge))
      ) {
        return apiError(400, "sign_in_failed", GENERIC_SIGN_IN);
      }
      // PKCE is checked first. Only then can the one-use attempt be consumed atomically.
      if (
        !(await store.consumeOAuthAttempt({
          stateHash,
          codeChallenge: attempt.codeChallenge,
          consumedAt: completedAt.toISOString(),
        }))
      ) {
        return apiError(400, "sign_in_failed", GENERIC_SIGN_IN);
      }
      try {
        const providerToken = await exchangeGitHubCode(fetcher, github, code, codeVerifier);
        let identity: GitHubIdentity;
        try {
          identity = await fetchVerifiedGitHubIdentity(fetcher, providerToken);
        } finally {
          await revokeGitHubToken(fetcher, github, providerToken);
        }
        const accountId = `acct_${await sha256Base64Url(`github:${identity.subject}`)}`;
        const storedAccountId = await store.createOrGetGitHubAccount({
          accountId,
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
