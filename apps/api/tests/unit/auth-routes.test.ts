import { describe, expect, it, vi } from "vitest";
import type { AccountStore } from "../../worker/lib/account-store";
import { accountAuthService } from "../../worker/lib/auth-routes";
import { sha256Base64Url } from "../../worker/lib/crypto";

const NOW = new Date("2026-09-25T12:00:00.000Z");
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const GITHUB = {
  clientId: "Iv1.testclient",
  clientSecret: "test-secret-with-enough-length",
  callbackUrl: "https://api.kalcoded.com/v1/auth/github/callback",
};

function fakeStore(overrides: Partial<AccountStore> = {}): AccountStore {
  return {
    allowRateLimit: vi.fn(async () => true),
    createOAuthAttempt: vi.fn(async () => undefined),
    oauthAttempt: vi.fn(async () => null),
    consumeOAuthAttempt: vi.fn(async () => false),
    identityAccount: vi.fn(async () => null),
    createOrGetGitHubAccount: vi.fn(async () => null),
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

describe("account auth routes", () => {
  it("creates a bounded OAuth attempt without persisting raw state", async () => {
    const store = fakeStore();
    const auth = accountAuthService({ store, github: GITHUB, rateLimitKey: "r".repeat(32), now: () => NOW });
    const response = await auth.start(post("/v1/auth/github/start", { codeChallenge: CHALLENGE }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { authorizeUrl: string; expiresAt: string };
    const state = new URL(body.authorizeUrl).searchParams.get("state");
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(store.createOAuthAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        stateHash: await sha256Base64Url(state as string),
        codeChallenge: CHALLENGE,
        expiresAt: "2026-09-25T12:10:00.000Z",
      }),
    );
    expect(JSON.stringify(vi.mocked(store.createOAuthAttempt).mock.calls)).not.toContain(state);
  });

  it("verifies PKCE before consuming the one-use attempt", async () => {
    const consume = vi.fn(async () => true);
    const fetcher = vi.fn<typeof fetch>();
    const store = fakeStore({
      oauthAttempt: vi.fn(async () => ({
        stateHash: await sha256Base64Url("state"),
        codeChallenge: CHALLENGE,
        expiresAt: "2026-09-25T12:10:00.000Z",
        consumedAt: null,
      })),
      consumeOAuthAttempt: consume,
    });
    const auth = accountAuthService({ store, github: GITHUB, rateLimitKey: "r".repeat(32), now: () => NOW, fetcher });
    const response = await auth.complete(
      post("/v1/auth/github/complete", { state: "state", code: "code", codeVerifier: "x".repeat(43) }),
    );
    expect(response.status).toBe(400);
    expect(consume).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("consumes once, requires verified provider identity, and stores only a hash of the issued session", async () => {
    const createSession = vi.fn(async () => true);
    const store = fakeStore({
      oauthAttempt: vi.fn(async () => ({
        stateHash: await sha256Base64Url("state"),
        codeChallenge: CHALLENGE,
        expiresAt: "2026-09-25T12:10:00.000Z",
        consumedAt: null,
      })),
      consumeOAuthAttempt: vi.fn(async () => true),
      createOrGetGitHubAccount: vi.fn(async () => "acct_verified"),
      createSession,
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "github-provider-token" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 101 }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ email: "verified@example.com", primary: true, verified: true }]), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const auth = accountAuthService({ store, github: GITHUB, rateLimitKey: "r".repeat(32), now: () => NOW, fetcher });
    const response = await auth.complete(
      post("/v1/auth/github/complete", { state: "state", code: "code", codeVerifier: VERIFIER }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { token: string; accountId: string };
    expect(body.accountId).toBe("acct_verified");
    expect(body.token).toMatch(/^kcs_[A-Za-z0-9_-]{43}$/);
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ tokenHash: await sha256Base64Url(body.token) }),
    );
    expect(JSON.stringify(createSession.mock.calls)).not.toContain(body.token);
    expect(fetcher.mock.calls[3]?.[0]).toBe("https://api.github.com/applications/Iv1.testclient/token");
  });

  it("does not issue a session unless the provider token is revoked", async () => {
    const createSession = vi.fn(async () => true);
    const store = fakeStore({
      oauthAttempt: vi.fn(async () => ({
        stateHash: await sha256Base64Url("state"),
        codeChallenge: CHALLENGE,
        expiresAt: "2026-09-25T12:10:00.000Z",
        consumedAt: null,
      })),
      consumeOAuthAttempt: vi.fn(async () => true),
      createOrGetGitHubAccount: vi.fn(async () => "acct_verified"),
      createSession,
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "github-provider-token" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 101 }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ email: "verified@example.com", primary: true, verified: true }]), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    const auth = accountAuthService({ store, github: GITHUB, rateLimitKey: "r".repeat(32), now: () => NOW, fetcher });
    const response = await auth.complete(
      post("/v1/auth/github/complete", { state: "state", code: "code", codeVerifier: VERIFIER }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      error: "sign_in_failed",
      message: "Sign-in could not be completed. Start again.",
    });
    expect(createSession).not.toHaveBeenCalled();
  });

  it("uses enumeration-neutral errors and refuses browser-originated writes", async () => {
    const auth = accountAuthService({
      store: fakeStore(),
      github: GITHUB,
      rateLimitKey: "r".repeat(32),
      now: () => NOW,
    });
    const invalid = await auth.complete(post("/v1/auth/github/complete", { state: "missing" }));
    expect(await invalid.json()).toMatchObject({ message: "Sign-in could not be completed. Start again." });
    const browser = await auth.start(
      post("/v1/auth/github/start", { codeChallenge: CHALLENGE }, { origin: "https://attacker.example" }),
    );
    expect(browser.status).toBe(403);
  });

  it("returns the same public failure for invalid PKCE, replay, provider, identity, and account failures", async () => {
    const expected = {
      ok: false,
      error: "sign_in_failed",
      message: "Sign-in could not be completed. Start again.",
    };
    const cases: Array<{ store: AccountStore; fetcher?: typeof fetch }> = [
      {
        store: fakeStore({
          oauthAttempt: vi.fn(async () => ({
            stateHash: await sha256Base64Url("state"),
            codeChallenge: CHALLENGE,
            expiresAt: "2026-09-25T12:10:00.000Z",
            consumedAt: null,
          })),
        }),
      },
      {
        store: fakeStore({
          oauthAttempt: vi.fn(async () => ({
            stateHash: await sha256Base64Url("state"),
            codeChallenge: CHALLENGE,
            expiresAt: "2026-09-25T12:10:00.000Z",
            consumedAt: null,
          })),
          consumeOAuthAttempt: vi.fn(async () => true),
        }),
        fetcher: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 502 })),
      },
      {
        store: fakeStore({
          oauthAttempt: vi.fn(async () => ({
            stateHash: await sha256Base64Url("state"),
            codeChallenge: CHALLENGE,
            expiresAt: "2026-09-25T12:10:00.000Z",
            consumedAt: null,
          })),
          consumeOAuthAttempt: vi.fn(async () => true),
          createOrGetGitHubAccount: vi.fn(async () => null),
        }),
        fetcher: vi
          .fn<typeof fetch>()
          .mockResolvedValueOnce(
            new Response(JSON.stringify({ access_token: "github-provider-token" }), { status: 200 }),
          )
          .mockResolvedValueOnce(new Response(JSON.stringify({ id: 101 }), { status: 200 }))
          .mockResolvedValueOnce(
            new Response(JSON.stringify([{ email: "verified@example.com", primary: true, verified: true }]), {
              status: 200,
            }),
          )
          .mockResolvedValueOnce(new Response(null, { status: 204 })),
      },
    ];
    for (const [index, testCase] of cases.entries()) {
      const auth = accountAuthService({
        store: testCase.store,
        github: GITHUB,
        rateLimitKey: "r".repeat(32),
        now: () => NOW,
        ...(testCase.fetcher ? { fetcher: testCase.fetcher } : {}),
      });
      const codeVerifier = index === 0 ? "x".repeat(43) : VERIFIER;
      const response = await auth.complete(
        post("/v1/auth/github/complete", { state: "state", code: "code", codeVerifier }),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual(expected);
    }
  });

  it("redirects callbacks only to the registered native URI", async () => {
    const auth = accountAuthService({
      store: fakeStore(),
      github: GITHUB,
      rateLimitKey: "r".repeat(32),
      now: () => NOW,
    });
    const response = await auth.callback(
      new Request("https://api.kalcoded.com/v1/auth/github/callback?code=oauth-code&state=oauth-state"),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("kalcode://auth/github?code=oauth-code&state=oauth-state");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });
});
