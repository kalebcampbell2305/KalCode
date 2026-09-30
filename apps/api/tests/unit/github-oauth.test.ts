import { describe, expect, it, vi } from "vitest";
import {
  buildGitHubAuthorizeUrl,
  exchangeGitHubCode,
  fetchVerifiedGitHubIdentity,
  isPkceChallenge,
  revokeGitHubToken,
  verifyPkce,
} from "../../worker/lib/github-oauth";

const CONFIG = {
  clientId: "Iv1.testclient",
  clientSecret: "test-secret",
  callbackUrl: "https://api.kalcoded.com/v1/auth/github/callback",
};

describe("GitHub OAuth", () => {
  it("accepts only an exact RFC 7636 S256 challenge", () => {
    expect(isPkceChallenge("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")).toBe(true);
    expect(isPkceChallenge("short")).toBe(false);
    expect(isPkceChallenge(`${"a".repeat(42)}+`)).toBe(false);
    expect(isPkceChallenge("a".repeat(44))).toBe(false);
  });

  it("builds only the official GitHub authorize endpoint with state and S256", () => {
    const url = new URL(buildGitHubAuthorizeUrl(CONFIG, "opaque-state", "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"));
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: CONFIG.clientId,
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
      redirect_uri: CONFIG.callbackUrl,
      scope: "user:email",
      state: "opaque-state",
    });
  });

  it("verifies a PKCE verifier and rejects a wrong verifier", async () => {
    const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    expect(await verifyPkce("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk", challenge)).toBe(true);
    expect(await verifyPkce("wrong-verifier-that-is-long-enough-0000000000000", challenge)).toBe(false);
  });

  it("accepts only the provider's primary verified email and stable numeric subject", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 123456, login: "kalcode-user" }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            { email: "other@example.com", primary: false, verified: true },
            { email: "owner@example.com", primary: true, verified: true },
          ]),
          { status: 200 },
        ),
      );
    await expect(fetchVerifiedGitHubIdentity(fetcher, "provider-token")).resolves.toEqual({
      subject: "123456",
      email: "owner@example.com",
    });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      "https://api.github.com/user",
      "https://api.github.com/user/emails",
    ]);
    for (const [, init] of fetcher.mock.calls) {
      expect(init).toMatchObject({ redirect: "manual" });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("fails closed when GitHub has no primary verified email", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 123456 }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ email: "unverified@example.com", primary: true, verified: false }]), {
          status: 200,
        }),
      );
    await expect(fetchVerifiedGitHubIdentity(fetcher, "provider-token")).rejects.toThrow("identity unavailable");
  });

  it("uses bounded redirect-denying requests for code exchange and token revocation", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "provider-token" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(exchangeGitHubCode(fetcher, CONFIG, "oauth-code", "a".repeat(43))).resolves.toBe("provider-token");
    await expect(revokeGitHubToken(fetcher, CONFIG, "provider-token")).resolves.toBeUndefined();

    const [tokenUrl, tokenInit] = fetcher.mock.calls[0] ?? [];
    expect(tokenUrl).toBe("https://github.com/login/oauth/access_token");
    expect(tokenInit).toMatchObject({ method: "POST", redirect: "manual" });
    expect(tokenInit?.signal).toBeInstanceOf(AbortSignal);
    const [revokeUrl, revokeInit] = fetcher.mock.calls[1] ?? [];
    expect(revokeUrl).toBe("https://api.github.com/applications/Iv1.testclient/token");
    expect(revokeInit).toMatchObject({ method: "DELETE", redirect: "manual" });
    expect(revokeInit?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(revokeInit?.body as string)).toEqual({ access_token: "provider-token" });
    expect(new Headers(revokeInit?.headers).get("authorization")).toMatch(/^Basic /);
  });

  it.each([301, 302, 303, 307, 308])(
    "rejects a %i redirect instead of following it at every provider endpoint",
    async (status) => {
      const redirect = () =>
        new Response(null, {
          status,
          headers: { location: "https://redirect-target.invalid/never-requested" },
        });
      const cases = [
        {
          fetcher: vi.fn<typeof fetch>().mockResolvedValueOnce(redirect()),
          run: (fetcher: typeof fetch) => exchangeGitHubCode(fetcher, CONFIG, "oauth-code", "a".repeat(43)),
          urls: ["https://github.com/login/oauth/access_token"],
        },
        {
          fetcher: vi.fn<typeof fetch>().mockResolvedValueOnce(redirect()),
          run: (fetcher: typeof fetch) => fetchVerifiedGitHubIdentity(fetcher, "provider-token"),
          urls: ["https://api.github.com/user"],
        },
        {
          fetcher: vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(new Response(JSON.stringify({ id: 123456 }), { status: 200 }))
            .mockResolvedValueOnce(redirect()),
          run: (fetcher: typeof fetch) => fetchVerifiedGitHubIdentity(fetcher, "provider-token"),
          urls: ["https://api.github.com/user", "https://api.github.com/user/emails"],
        },
        {
          fetcher: vi.fn<typeof fetch>().mockResolvedValueOnce(redirect()),
          run: (fetcher: typeof fetch) => revokeGitHubToken(fetcher, CONFIG, "provider-token"),
          urls: ["https://api.github.com/applications/Iv1.testclient/token"],
        },
      ];
      for (const { fetcher, run, urls } of cases) {
        await expect(run(fetcher)).rejects.toThrow("identity unavailable");
        expect(fetcher.mock.calls.map(([url]) => url)).toEqual(urls);
        for (const [, init] of fetcher.mock.calls) {
          expect(init).toMatchObject({ redirect: "manual" });
          expect(init?.signal).toBeInstanceOf(AbortSignal);
        }
      }
    },
  );

  it("fails closed when GitHub does not confirm token revocation", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 500 }));
    await expect(revokeGitHubToken(fetcher, CONFIG, "provider-token")).rejects.toThrow("identity unavailable");
  });
});
