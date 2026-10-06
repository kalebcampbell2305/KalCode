import { describe, expect, it, vi } from "vitest";
import type { AccountMailIdentity } from "../../worker/lib/account-mailer";
import type { AccountStore, EmailAttempt } from "../../worker/lib/account-store";
import { hmacSha256Base64Url, sha256Base64Url } from "../../worker/lib/crypto";
import { emailAuthService } from "../../worker/lib/email-auth";

const NOW = new Date("2026-09-25T12:00:00.000Z");
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

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
    setDisplayName: vi.fn(async () => null),
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

function attempt(overrides: Partial<EmailAttempt> = {}): EmailAttempt {
  return {
    verifyHash: "v".repeat(43),
    pollHash: "p".repeat(43),
    email: "user@example.com",
    clientKind: "desktop",
    purpose: "signin",
    codeChallenge: CHALLENGE,
    expiresAt: "2026-09-25T12:10:00.000Z",
    verifiedAt: "2026-09-25T12:00:30.000Z",
    accountId: "acct_verified",
    consumedAt: null,
    ...overrides,
  };
}

describe("passwordless email auth", () => {
  it("stores only token hashes and returns an enumeration-neutral desktop start response", async () => {
    const store = fakeStore();
    const sent = vi.fn<(email: string, verifyToken: string, identity: AccountMailIdentity) => Promise<boolean>>(
      async () => true,
    );
    const auth = emailAuthService({
      store,
      mailer: { sendSignIn: sent, sendDelete: vi.fn(async () => true) },
      rateLimitKey: "r".repeat(32),
      now: () => NOW,
    });
    const response = await auth.start(
      post("/v1/auth/email/start", { email: " User@Example.com ", client: "desktop", codeChallenge: CHALLENGE }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { pollToken: string };
    expect(body.pollToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const verifyToken = sent.mock.calls[0]?.[1];
    expect(verifyToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sent.mock.calls[0]?.[2]).toEqual({
      networkHash: await hmacSha256Base64Url("r".repeat(32), "account-mail:network:203.0.113.9"),
      recipientHash: await hmacSha256Base64Url("r".repeat(32), "account-mail:recipient:user@example.com"),
    });
    expect(JSON.stringify(sent.mock.calls[0]?.[2])).not.toMatch(/203\.0\.113\.9|user@example\.com/);
    expect(store.createEmailAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "user@example.com",
        verifyHash: await sha256Base64Url(verifyToken as string),
        pollHash: await sha256Base64Url(body.pollToken),
        codeChallenge: CHALLENGE,
      }),
    );
    expect(JSON.stringify(vi.mocked(store.createEmailAttempt).mock.calls)).not.toContain(verifyToken);
    expect(JSON.stringify(vi.mocked(store.createEmailAttempt).mock.calls)).not.toContain(body.pollToken);
  });

  it("verifies PKCE before consuming a desktop handoff", async () => {
    const consume = vi.fn(async () => ({ accountId: "acct_verified", clientKind: "desktop" as const, expiresAt: "x" }));
    const store = fakeStore({ emailAttempt: vi.fn(async () => attempt()), consumeEmailAttempt: consume });
    const auth = emailAuthService({
      store,
      mailer: { sendSignIn: vi.fn(async () => true), sendDelete: vi.fn(async () => true) },
      rateLimitKey: "r".repeat(32),
      now: () => NOW,
    });
    const response = await auth.poll(
      post("/v1/auth/email/poll", { pollToken: "p".repeat(43), codeVerifier: "x".repeat(43) }),
    );
    expect(response.status).toBe(400);
    expect(consume).not.toHaveBeenCalled();
  });

  it("issues website sessions only as secure HttpOnly cookies", async () => {
    const verified = attempt({ clientKind: "website", codeChallenge: null });
    const store = fakeStore({
      emailAttempt: vi.fn(async () => verified),
      markEmailVerified: vi.fn(async () => verified),
      consumeEmailAttempt: vi.fn(async () => ({
        accountId: "acct_verified",
        clientKind: "website" as const,
        expiresAt: "2026-10-25T12:00:00.000Z",
      })),
    });
    const auth = emailAuthService({
      store,
      mailer: { sendSignIn: vi.fn(async () => true), sendDelete: vi.fn(async () => true) },
      rateLimitKey: "r".repeat(32),
      now: () => NOW,
    });
    const response = await auth.verify(
      post("/v1/auth/email/verify", { token: "t".repeat(43) }, { origin: "https://kalcoded.com" }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toMatch(
      /^__Host-kalcode_session=kcs_[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Lax;/,
    );
    expect(JSON.stringify(await response.json())).not.toContain("kcs_");
  });

  it("refuses every untrusted browser origin before sending email", async () => {
    const sent = vi.fn<(email: string, verifyToken: string) => Promise<boolean>>(async () => true);
    const auth = emailAuthService({
      store: fakeStore(),
      mailer: { sendSignIn: sent, sendDelete: vi.fn(async () => true) },
      rateLimitKey: "r".repeat(32),
      now: () => NOW,
    });
    const response = await auth.start(
      post(
        "/v1/auth/email/start",
        { email: "user@example.com", client: "website" },
        { origin: "https://attacker.example" },
      ),
    );
    expect(response.status).toBe(403);
    expect(sent).not.toHaveBeenCalled();
  });

  it("uses the same domain-separated daily admission identities for authenticated deletion mail", async () => {
    const sent = vi.fn<(email: string, verifyToken: string, identity: AccountMailIdentity) => Promise<boolean>>(
      async () => true,
    );
    const auth = emailAuthService({
      store: fakeStore(),
      mailer: { sendSignIn: vi.fn(async () => true), sendDelete: sent },
      rateLimitKey: "r".repeat(32),
      now: () => NOW,
    });
    const response = await auth.startDelete(
      post("/v1/account/delete/start", {}, { origin: "https://kalcoded.com" }),
      "acct_1",
      "person@example.com",
    );
    expect(response.status).toBe(200);
    expect(sent.mock.calls[0]?.[2]).toEqual({
      networkHash: await hmacSha256Base64Url("r".repeat(32), "account-mail:network:203.0.113.9"),
      recipientHash: await hmacSha256Base64Url("r".repeat(32), "account-mail:recipient:person@example.com"),
    });
  });

  it("returns a desktop token after verification and consumes exactly once", async () => {
    const consume = vi.fn(async () => ({
      accountId: "acct_verified",
      clientKind: "desktop" as const,
      expiresAt: "2026-10-25T12:00:00.000Z",
    }));
    const store = fakeStore({ emailAttempt: vi.fn(async () => attempt()), consumeEmailAttempt: consume });
    const auth = emailAuthService({
      store,
      mailer: { sendSignIn: vi.fn(async () => true), sendDelete: vi.fn(async () => true) },
      rateLimitKey: "r".repeat(32),
      now: () => NOW,
    });
    const response = await auth.poll(
      post("/v1/auth/email/poll", { pollToken: "p".repeat(43), codeVerifier: VERIFIER }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "signed_in", token: expect.stringMatching(/^kcs_/) });
    expect(consume).toHaveBeenCalledTimes(1);
  });

  it("does not create token-scoped rate buckets for unknown poll or session tokens", async () => {
    const allowRateLimit = vi.fn<AccountStore["allowRateLimit"]>(async () => true);
    const store = fakeStore({
      allowRateLimit,
      emailAttempt: vi.fn(async () => null),
      sessionInfo: vi.fn(async () => null),
    });
    const auth = emailAuthService({
      store,
      mailer: { sendSignIn: vi.fn(async () => true), sendDelete: vi.fn(async () => true) },
      rateLimitKey: "r".repeat(32),
      now: () => NOW,
    });
    expect(
      (await auth.poll(post("/v1/auth/email/poll", { pollToken: "z".repeat(43), codeVerifier: VERIFIER }))).status,
    ).toBe(400);
    expect(allowRateLimit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(allowRateLimit).mock.calls[0]?.[0].action).toBe("email_poll");

    allowRateLimit.mockClear();
    const refresh = await auth.refresh(
      new Request("https://api.kalcoded.com/v1/auth/session/refresh", {
        method: "POST",
        headers: { authorization: `Bearer kcs_${"q".repeat(43)}`, "cf-connecting-ip": "203.0.113.9" },
      }),
    );
    expect(refresh.status).toBe(401);
    expect(allowRateLimit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(allowRateLimit).mock.calls[0]?.[0].action).toBe("session_refresh");
  });

  it("rate-limits and budgets sign-in mail per IPv6 /64, so rotating addresses in one prefix shares a limit", async () => {
    const allowRateLimit = vi.fn<AccountStore["allowRateLimit"]>(async () => true);
    const sent = vi.fn<(email: string, verifyToken: string, identity: AccountMailIdentity) => Promise<boolean>>(
      async () => true,
    );
    const auth = emailAuthService({
      store: fakeStore({ allowRateLimit }),
      mailer: { sendSignIn: sent, sendDelete: vi.fn(async () => true) },
      rateLimitKey: "r".repeat(32),
      now: () => NOW,
    });
    for (const [index, ip] of ["2001:db8:abcd:12::1", "2001:0DB8:abcd:0012:ffff:eeee:dddd:cccc"].entries()) {
      const response = await auth.start(
        post(
          "/v1/auth/email/start",
          { email: `user${index}@example.com`, client: "website" },
          { "cf-connecting-ip": ip },
        ),
      );
      expect(response.status).toBe(200);
    }
    const ipBuckets = vi
      .mocked(allowRateLimit)
      .mock.calls.map(([input]) => input)
      .filter((input) => input.action === "email_start")
      .map((input) => input.bucketHash);
    // Calls alternate ip bucket, email bucket for each start.
    expect(ipBuckets[0]).toBe(await hmacSha256Base64Url("r".repeat(32), "ip:2001:db8:abcd:12::/64"));
    expect(ipBuckets[2]).toBe(ipBuckets[0]);
    expect(sent.mock.calls[0]?.[2].networkHash).toBe(
      await hmacSha256Base64Url("r".repeat(32), "account-mail:network:2001:db8:abcd:12::/64"),
    );
    expect(sent.mock.calls[1]?.[2].networkHash).toBe(sent.mock.calls[0]?.[2].networkHash);
  });
});
