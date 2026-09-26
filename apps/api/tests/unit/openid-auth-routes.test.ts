import { describe, expect, it, vi } from "vitest";
import type { AccountStore } from "../../worker/lib/account-store";
import { sha256Base64Url } from "../../worker/lib/crypto";
import { openIdAuthService } from "../../worker/lib/openid-auth-routes";

const NOW = new Date("2026-09-25T12:00:00.000Z");
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const STATE = "s".repeat(43);
const GOOGLE = {
  provider: "google" as const,
  clientId: "google-client.apps.googleusercontent.com",
  clientSecret: "google-client-secret-for-tests",
  callbackUrl: "https://api.kalcoded.com/v1/auth/google/callback",
};

function fakeStore(overrides: Partial<AccountStore> = {}): AccountStore {
  return {
    allowRateLimit: vi.fn(async () => true),
    createOAuthAttempt: vi.fn(async () => undefined),
    oauthAttempt: vi.fn(async () => null),
    consumeOAuthAttempt: vi.fn(async () => false),
    createOpenIdAttempt: vi.fn(async () => undefined),
    openIdAttempt: vi.fn(async () => null),
    consumeOpenIdAttempt: vi.fn(async () => false),
    identityAccount: vi.fn(async () => null),
    createOrGetGitHubAccount: vi.fn(async () => null),
    createOrGetOpenIdAccount: vi.fn(async () => null),
    accountProfile: vi.fn(async () => null),
    createEmailAttempt: vi.fn(async () => undefined),
    deleteEmailAttempt: vi.fn(async () => undefined),
    emailAttempt: vi.fn(async () => null),
    markEmailVerified: vi.fn(async () => null),
    consumeEmailAttempt: vi.fn(async () => null),
    createSession: vi.fn(async () => true),
    sessionInfo: vi.fn(async () => null),
    activeSession: vi.fn(async () => null),
    rotateSession: vi.fn(async () => null),
    activateFree: vi.fn(async () => false),
    softDeleteAccount: vi.fn(async () => false),
    revokeSession: vi.fn(async () => false),
    ...overrides,
  };
}

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`https://api.kalcoded.com${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9", ...headers },
    body: JSON.stringify(body),
  });
}

describe("OpenID account auth routes", () => {
  it("creates a provider-bound, nonce-bound attempt without persisting raw state or nonce", async () => {
    const store = fakeStore();
    const auth = openIdAuthService({
      store,
      clients: { google: GOOGLE },
      rateLimitKey: "r".repeat(32),
      now: () => NOW,
    });
    const response = await auth.start(post("/v1/auth/google/start", { codeChallenge: CHALLENGE }), "google");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { authorizeUrl: string; nonce: string; expiresAt: string };
    const url = new URL(body.authorizeUrl);
    const state = url.searchParams.get("state");
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("nonce")).toBe(body.nonce);
    expect(store.createOpenIdAttempt).toHaveBeenCalledWith({
      stateHash: await sha256Base64Url(state as string),
      provider: "google",
      codeChallenge: CHALLENGE,
      nonceHash: await sha256Base64Url(body.nonce),
      rateBucket: expect.any(String),
      createdAt: NOW.toISOString(),
      expiresAt: "2026-09-25T12:10:00.000Z",
    });
    const persisted = JSON.stringify(vi.mocked(store.createOpenIdAttempt).mock.calls);
    expect(persisted).not.toContain(state);
    expect(persisted).not.toContain(body.nonce);
  });

  it("reports unavailable when a provider has no configured client", async () => {
    const auth = openIdAuthService({
      store: fakeStore(),
      clients: {},
      rateLimitKey: "r".repeat(32),
      now: () => NOW,
    });
    const response = await auth.start(post("/v1/auth/google/start", { codeChallenge: CHALLENGE }), "google");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, error: "sign_in_unavailable" });
  });

  it("verifies PKCE and nonce before atomically consuming the attempt", async () => {
    const nonce = "n".repeat(43);
    const consume = vi.fn(async () => true);
    const fetcher = vi.fn<typeof fetch>();
    const store = fakeStore({
      openIdAttempt: vi.fn(async () => ({
        stateHash: await sha256Base64Url(STATE),
        provider: "google" as const,
        codeChallenge: CHALLENGE,
        nonceHash: await sha256Base64Url(nonce),
        expiresAt: "2026-09-25T12:10:00.000Z",
        consumedAt: null,
      })),
      consumeOpenIdAttempt: consume,
    });
    const auth = openIdAuthService({
      store,
      clients: { google: GOOGLE },
      rateLimitKey: "r".repeat(32),
      now: () => NOW,
      fetcher,
    });
    const response = await auth.complete(
      post("/v1/auth/google/complete", {
        state: STATE,
        code: "code",
        codeVerifier: VERIFIER,
        nonce: "x".repeat(43),
      }),
      "google",
    );
    expect(response.status).toBe(400);
    expect(consume).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("uses a verified provider subject in the canonical account store and hashes the issued session", async () => {
    const nonce = "n".repeat(43);
    const createSession = vi.fn(async () => true);
    const store = fakeStore({
      openIdAttempt: vi.fn(async () => ({
        stateHash: await sha256Base64Url(STATE),
        provider: "google" as const,
        codeChallenge: CHALLENGE,
        nonceHash: await sha256Base64Url(nonce),
        expiresAt: "2026-09-25T12:10:00.000Z",
        consumedAt: null,
      })),
      consumeOpenIdAttempt: vi.fn(async () => true),
      createOrGetOpenIdAccount: vi.fn(async () => "acct_google"),
      createSession,
    });
    const fetcher = vi.fn<typeof fetch>();
    const exchangeIdentity = vi.fn(async () => ({
      provider: "google" as const,
      subject: "google-subject-123",
      email: "person@example.com",
    }));
    const auth = openIdAuthService({
      store,
      clients: { google: GOOGLE },
      rateLimitKey: "r".repeat(32),
      now: () => NOW,
      fetcher,
      exchangeIdentity,
    });
    const response = await auth.complete(
      post("/v1/auth/google/complete", { state: STATE, code: "code", codeVerifier: VERIFIER, nonce }),
      "google",
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { token: string; accountId: string };
    expect(body.accountId).toBe("acct_google");
    expect(store.createOrGetOpenIdAccount).toHaveBeenCalledWith({
      accountId: expect.stringMatching(/^acct_[A-Za-z0-9_-]{43}$/),
      provider: "google",
      subject: "google-subject-123",
      email: "person@example.com",
      now: NOW.toISOString(),
    });
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ tokenHash: await sha256Base64Url(body.token), accountId: "acct_google" }),
    );
    expect(JSON.stringify(createSession.mock.calls)).not.toContain(body.token);
  });

  it("does not issue a session when an email collision requires explicit identity linking", async () => {
    const nonce = "n".repeat(43);
    const store = fakeStore({
      openIdAttempt: vi.fn(async () => ({
        stateHash: await sha256Base64Url(STATE),
        provider: "google" as const,
        codeChallenge: CHALLENGE,
        nonceHash: await sha256Base64Url(nonce),
        expiresAt: "2026-09-25T12:10:00.000Z",
        consumedAt: null,
      })),
      consumeOpenIdAttempt: vi.fn(async () => true),
      createOrGetOpenIdAccount: vi.fn(async () => null),
    });
    const auth = openIdAuthService({
      store,
      clients: { google: GOOGLE },
      rateLimitKey: "r".repeat(32),
      now: () => NOW,
      exchangeIdentity: vi.fn(async () => ({
        provider: "google" as const,
        subject: "new-google-subject",
        email: "existing@example.com",
      })),
    });
    const response = await auth.complete(
      post("/v1/auth/google/complete", { state: STATE, code: "code", codeVerifier: VERIFIER, nonce }),
      "google",
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      error: "sign_in_failed",
      message: "Sign-in could not be completed. Start again.",
    });
    expect(store.createSession).not.toHaveBeenCalled();
  });

  it("redirects cancellation and success only to the provider-specific registered native URI", async () => {
    const auth = openIdAuthService({
      store: fakeStore(),
      clients: { google: GOOGLE },
      rateLimitKey: "r".repeat(32),
      now: () => NOW,
    });
    const canceled = await auth.callback(
      new Request(`https://api.kalcoded.com/v1/auth/google/callback?error=access_denied&state=${STATE}`),
      "google",
    );
    expect(canceled.headers.get("location")).toBe(`kalcode://auth/google?error=sign_in_canceled&state=${STATE}`);
    const success = await auth.callback(
      new Request(`https://api.kalcoded.com/v1/auth/google/callback?code=4%2F0AdQt8qh.opaque~code&state=${STATE}`),
      "google",
    );
    expect(success.headers.get("location")).toBe(
      `kalcode://auth/google?code=4%2F0AdQt8qh.opaque%7Ecode&state=${STATE}`,
    );
  });
});
