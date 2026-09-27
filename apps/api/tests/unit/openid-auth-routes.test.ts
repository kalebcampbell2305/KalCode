import { describe, expect, it, vi } from "vitest";
import type { AccountStore } from "../../worker/lib/account-store";
import { sha256Base64Url } from "../../worker/lib/crypto";
import { openIdAuthService } from "../../worker/lib/openid-auth-routes";
import { OpenIdExchangeError } from "../../worker/lib/openid-connect";

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
      clientKind: "desktop",
    });
    const persisted = JSON.stringify(vi.mocked(store.createOpenIdAttempt).mock.calls);
    expect(persisted).not.toContain(state);
    expect(persisted).not.toContain(body.nonce);
  });

  it("binds website starts to the exact website origin and persists the client kind", async () => {
    const store = fakeStore();
    const auth = openIdAuthService({
      store,
      clients: { google: GOOGLE },
      rateLimitKey: "r".repeat(32),
      now: () => NOW,
    });

    const response = await auth.start(
      post(
        "/v1/auth/google/start",
        { client: "website", codeChallenge: CHALLENGE },
        { origin: "https://kalcoded.com" },
      ),
      "google",
    );
    expect(response.status).toBe(200);
    expect(store.createOpenIdAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "google", codeChallenge: CHALLENGE, clientKind: "website" }),
    );

    const missingOrigin = await auth.start(
      post("/v1/auth/google/start", { client: "website", codeChallenge: CHALLENGE }),
      "google",
    );
    const wrongOrigin = await auth.start(
      post(
        "/v1/auth/google/start",
        { client: "website", codeChallenge: CHALLENGE },
        { origin: "https://attacker.example" },
      ),
      "google",
    );
    expect(missingOrigin.status).toBe(403);
    expect(wrongOrigin.status).toBe(403);
    const browserDesktopAttempt = await auth.start(
      post("/v1/auth/google/start", { codeChallenge: CHALLENGE }, { origin: "https://kalcoded.com" }),
      "google",
    );
    expect(browserDesktopAttempt.status).toBe(403);
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
        clientKind: "desktop" as const,
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
        clientKind: "desktop" as const,
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

  it("issues an HttpOnly host cookie without exposing a bearer for a website attempt", async () => {
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
        clientKind: "website" as const,
      })),
      consumeOpenIdAttempt: vi.fn(async () => true),
      createOrGetOpenIdAccount: vi.fn(async () => "acct_google"),
      createSession,
    });
    const auth = openIdAuthService({
      store,
      clients: { google: GOOGLE },
      rateLimitKey: "r".repeat(32),
      now: () => NOW,
      exchangeIdentity: vi.fn(async () => ({
        provider: "google" as const,
        subject: "google-web-subject",
        email: "web@example.com",
      })),
    });

    const response = await auth.complete(
      post(
        "/v1/auth/google/complete",
        { state: STATE, code: "code", codeVerifier: VERIFIER, nonce },
        { origin: "https://kalcoded.com" },
      ),
      "google",
    );
    expect(response.status).toBe(200);
    const responseBody = await response.json();
    expect(responseBody).toEqual({
      ok: true,
      status: "signed_in",
      expiresAt: "2026-10-25T12:00:00.000Z",
    });
    expect(response.headers.get("set-cookie")).toMatch(
      /^__Host-kalcode_session=kcs_[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000$/,
    );
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ clientKind: "website" }));
    expect(JSON.stringify(responseBody)).not.toContain("kcs_");
  });

  it("rejects a website completion from a missing or foreign origin before consuming state", async () => {
    const nonce = "n".repeat(43);
    const consume = vi.fn(async () => true);
    const exchangeIdentity = vi.fn();
    const store = fakeStore({
      openIdAttempt: vi.fn(async () => ({
        stateHash: await sha256Base64Url(STATE),
        provider: "google" as const,
        codeChallenge: CHALLENGE,
        nonceHash: await sha256Base64Url(nonce),
        expiresAt: "2026-09-25T12:10:00.000Z",
        consumedAt: null,
        clientKind: "website" as const,
      })),
      consumeOpenIdAttempt: consume,
    });
    const auth = openIdAuthService({
      store,
      clients: { google: GOOGLE },
      rateLimitKey: "r".repeat(32),
      now: () => NOW,
      exchangeIdentity,
    });
    const body = { state: STATE, code: "code", codeVerifier: VERIFIER, nonce };

    expect((await auth.complete(post("/v1/auth/google/complete", body), "google")).status).toBe(403);
    expect(
      (await auth.complete(post("/v1/auth/google/complete", body, { origin: "https://attacker.example" }), "google"))
        .status,
    ).toBe(403);
    expect(consume).not.toHaveBeenCalled();
    expect(exchangeIdentity).not.toHaveBeenCalled();
  });

  it("does not issue a session when an email collision requires explicit identity linking", async () => {
    const nonce = "n".repeat(43);
    const logs: Record<string, string>[] = [];
    const store = fakeStore({
      openIdAttempt: vi.fn(async () => ({
        stateHash: await sha256Base64Url(STATE),
        provider: "google" as const,
        codeChallenge: CHALLENGE,
        nonceHash: await sha256Base64Url(nonce),
        expiresAt: "2026-09-25T12:10:00.000Z",
        consumedAt: null,
        clientKind: "desktop" as const,
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
      log: (entry) => logs.push(entry),
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
    expect(logs).toEqual([
      { level: "warn", event: "api.oidc_sign_in_failed", provider: "google", stage: "identity_collision" },
    ]);
    expect(JSON.stringify(logs)).not.toContain("existing@example.com");
    expect(JSON.stringify(logs)).not.toContain("new-google-subject");
  });

  it("logs only an allowlisted stage when an exchange throws malicious provider content", async () => {
    const nonce = "n".repeat(43);
    const logs: Record<string, string>[] = [];
    const store = fakeStore({
      openIdAttempt: vi.fn(async () => ({
        stateHash: await sha256Base64Url(STATE),
        provider: "google" as const,
        codeChallenge: CHALLENGE,
        nonceHash: await sha256Base64Url(nonce),
        expiresAt: "2026-09-25T12:10:00.000Z",
        consumedAt: null,
        clientKind: "website" as const,
      })),
      consumeOpenIdAttempt: vi.fn(async () => true),
    });
    const privateValues = [
      "private-code",
      "private-token",
      "private-state",
      "private-nonce",
      "private@example.com",
      "private-subject",
      "private-client-secret",
      "private-provider-response",
    ];
    const malicious = [
      `code=${privateValues[0]}`,
      `token=${privateValues[1]}`,
      `state=${privateValues[2]}`,
      `nonce=${privateValues[3]}`,
      `email=${privateValues[4]}`,
      `subject=${privateValues[5]}`,
      `client_secret=${privateValues[6]}`,
      `raw=${privateValues[7]}`,
    ].join("&");
    const auth = openIdAuthService({
      store,
      clients: { google: GOOGLE },
      rateLimitKey: "r".repeat(32),
      now: () => NOW,
      exchangeIdentity: vi.fn(async () => {
        throw new Error(malicious);
      }),
      log: (entry) => logs.push(entry),
    });

    const response = await auth.complete(
      post(
        "/v1/auth/google/complete",
        { state: STATE, code: "code", codeVerifier: VERIFIER, nonce },
        { origin: "https://kalcoded.com" },
      ),
      "google",
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      error: "sign_in_failed",
      message: "Sign-in could not be completed. Start again.",
    });
    expect(logs).toEqual([
      { level: "warn", event: "api.oidc_sign_in_failed", provider: "google", stage: "token_exchange" },
    ]);
    for (const value of privateValues) expect(JSON.stringify(logs)).not.toContain(value);
    expect(store.createOrGetOpenIdAccount).not.toHaveBeenCalled();
    expect(store.createSession).not.toHaveBeenCalled();
  });

  it("sanitizes a corrupted stage and keeps logger failure out of the auth result", async () => {
    const nonce = "n".repeat(43);
    const store = fakeStore({
      openIdAttempt: vi.fn(async () => ({
        stateHash: await sha256Base64Url(STATE),
        provider: "google" as const,
        codeChallenge: CHALLENGE,
        nonceHash: await sha256Base64Url(nonce),
        expiresAt: "2026-09-25T12:10:00.000Z",
        consumedAt: null,
        clientKind: "website" as const,
      })),
      consumeOpenIdAttempt: vi.fn(async () => true),
    });
    const body = { state: STATE, code: "code", codeVerifier: VERIFIER, nonce };
    const headers = { origin: "https://kalcoded.com" };
    for (const stage of [
      "claims_email",
      "claims_email_verification_missing",
      "claims_email_verification_type",
      "claims_email_verification_affirmative_text",
      "claims_email_verification_one_text",
      "claims_email_verification_denied",
    ] as const) {
      const safeLogs: Record<string, string>[] = [];
      const classified = openIdAuthService({
        store,
        clients: { google: GOOGLE },
        rateLimitKey: "r".repeat(32),
        now: () => NOW,
        exchangeIdentity: vi.fn(async () => {
          throw new OpenIdExchangeError(stage);
        }),
        log: (entry) => safeLogs.push(entry),
      });
      const result = await classified.complete(post("/v1/auth/google/complete", body, headers), "google");
      expect(result.status).toBe(400);
      expect(await result.json()).toEqual({
        ok: false,
        error: "sign_in_failed",
        message: "Sign-in could not be completed. Start again.",
      });
      expect(safeLogs).toEqual([{ level: "warn", event: "api.oidc_sign_in_failed", provider: "google", stage }]);
    }
    const corrupted = Object.assign(new OpenIdExchangeError("claims"), { stage: "private-mutated-stage" });
    const logs: Record<string, string>[] = [];
    const sanitized = openIdAuthService({
      store,
      clients: { google: GOOGLE },
      rateLimitKey: "r".repeat(32),
      now: () => NOW,
      exchangeIdentity: vi.fn(async () => {
        throw corrupted;
      }),
      log: (entry) => logs.push(entry),
    });

    const sanitizedResponse = await sanitized.complete(post("/v1/auth/google/complete", body, headers), "google");
    expect(sanitizedResponse.status).toBe(400);
    expect(logs).toEqual([
      { level: "warn", event: "api.oidc_sign_in_failed", provider: "google", stage: "token_exchange" },
    ]);
    expect(JSON.stringify(logs)).not.toContain("private-mutated-stage");

    const throwingLogger = openIdAuthService({
      store,
      clients: { google: GOOGLE },
      rateLimitKey: "r".repeat(32),
      now: () => NOW,
      exchangeIdentity: vi.fn(async () => {
        throw new Error("private-provider-error");
      }),
      log: () => {
        throw new Error("private-logger-error");
      },
    });
    const loggerResponse = await throwingLogger.complete(post("/v1/auth/google/complete", body, headers), "google");
    expect(loggerResponse.status).toBe(400);
    expect(await loggerResponse.json()).toEqual({
      ok: false,
      error: "sign_in_failed",
      message: "Sign-in could not be completed. Start again.",
    });
    expect(store.createOrGetOpenIdAccount).not.toHaveBeenCalled();
    expect(store.createSession).not.toHaveBeenCalled();
  });

  it("separates account binding failures from session creation failures", async () => {
    const nonce = "n".repeat(43);
    const attempt = {
      stateHash: await sha256Base64Url(STATE),
      provider: "google" as const,
      codeChallenge: CHALLENGE,
      nonceHash: await sha256Base64Url(nonce),
      expiresAt: "2026-09-25T12:10:00.000Z",
      consumedAt: null,
      clientKind: "desktop" as const,
    };
    const identity = { provider: "google" as const, subject: "private-subject", email: "private@example.com" };

    for (const scenario of [
      {
        stage: "account_binding",
        store: fakeStore({
          openIdAttempt: vi.fn(async () => attempt),
          consumeOpenIdAttempt: vi.fn(async () => true),
          createOrGetOpenIdAccount: vi.fn(async () => {
            throw new Error("database-private-content");
          }),
        }),
      },
      {
        stage: "session_creation",
        store: fakeStore({
          openIdAttempt: vi.fn(async () => attempt),
          consumeOpenIdAttempt: vi.fn(async () => true),
          createOrGetOpenIdAccount: vi.fn(async () => "acct_google"),
          createSession: vi.fn(async () => false),
        }),
      },
    ] as const) {
      const logs: Record<string, string>[] = [];
      const auth = openIdAuthService({
        store: scenario.store,
        clients: { google: GOOGLE },
        rateLimitKey: "r".repeat(32),
        now: () => NOW,
        exchangeIdentity: vi.fn(async () => identity),
        log: (entry) => logs.push(entry),
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
      expect(logs).toEqual([
        { level: "warn", event: "api.oidc_sign_in_failed", provider: "google", stage: scenario.stage },
      ]);
      expect(JSON.stringify(logs)).not.toContain("private");
    }
  });

  it("redirects desktop cancellation and success only to the provider-specific registered native URI", async () => {
    const store = fakeStore({
      openIdAttempt: vi.fn(async () => ({
        stateHash: await sha256Base64Url(STATE),
        provider: "google" as const,
        codeChallenge: CHALLENGE,
        nonceHash: await sha256Base64Url("n".repeat(43)),
        expiresAt: "2026-09-25T12:10:00.000Z",
        consumedAt: null,
        clientKind: "desktop" as const,
      })),
    });
    const auth = openIdAuthService({
      store,
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

  it("redirects only a stored website attempt to the fixed account fragment", async () => {
    const store = fakeStore({
      openIdAttempt: vi.fn(async () => ({
        stateHash: await sha256Base64Url(STATE),
        provider: "google" as const,
        codeChallenge: CHALLENGE,
        nonceHash: await sha256Base64Url("n".repeat(43)),
        expiresAt: "2026-09-25T12:10:00.000Z",
        consumedAt: null,
        clientKind: "website" as const,
      })),
    });
    const auth = openIdAuthService({
      store,
      clients: { google: GOOGLE },
      rateLimitKey: "r".repeat(32),
      now: () => NOW,
    });
    const success = await auth.callback(
      new Request(`https://api.kalcoded.com/v1/auth/google/callback?code=opaque-code&state=${STATE}`),
      "google",
    );
    expect(success.headers.get("location")).toBe(
      `https://kalcoded.com/account#socialProvider=google&socialCode=opaque-code&socialState=${STATE}`,
    );
    expect(new URL(success.headers.get("location") as string).search).toBe("");

    const canceled = await auth.callback(
      new Request(`https://api.kalcoded.com/v1/auth/google/callback?error=access_denied&state=${STATE}`),
      "google",
    );
    expect(canceled.headers.get("location")).toBe(
      `https://kalcoded.com/account#socialProvider=google&socialError=sign_in_canceled&socialState=${STATE}`,
    );
  });

  it("rejects duplicate or mixed callback parameters before loading an attempt", async () => {
    const openIdAttempt = vi.fn(async () => null);
    const auth = openIdAuthService({
      store: fakeStore({ openIdAttempt }),
      clients: { google: GOOGLE },
      rateLimitKey: "r".repeat(32),
      now: () => NOW,
    });
    const duplicateState = await auth.callback(
      new Request(`https://api.kalcoded.com/v1/auth/google/callback?code=code&state=${STATE}&state=${"x".repeat(43)}`),
      "google",
    );
    const mixedResult = await auth.callback(
      new Request(`https://api.kalcoded.com/v1/auth/google/callback?code=code&error=access_denied&state=${STATE}`),
      "google",
    );
    expect(duplicateState.status).toBe(400);
    expect(mixedResult.status).toBe(400);
    expect(openIdAttempt).not.toHaveBeenCalled();
  });
});
