import { describe, expect, it, vi } from "vitest";
import { encodeBase64Url, encodeBase64UrlText } from "../../worker/lib/base64url";
import {
  buildOpenIdAuthorizeUrl,
  exchangeOpenIdIdentity,
  type OpenIdClientConfig,
  OpenIdExchangeError,
  type OpenIdFailureStage,
} from "../../worker/lib/openid-connect";

const NOW = new Date("2026-09-25T12:00:00.000Z");
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const NONCE = "n".repeat(43);
const STATE = "s".repeat(43);

const GOOGLE: OpenIdClientConfig = {
  provider: "google",
  clientId: "google-client.apps.googleusercontent.com",
  clientSecret: "google-client-secret-for-tests",
  callbackUrl: "https://api.kalcoded.com/v1/auth/google/callback",
};

const MICROSOFT: OpenIdClientConfig = {
  provider: "microsoft",
  clientId: "00001111-aaaa-2222-bbbb-3333cccc4444",
  clientSecret: "microsoft-client-secret-for-tests",
  callbackUrl: "https://api.kalcoded.com/v1/auth/microsoft/callback",
};

type PublicJwk = JsonWebKey & { kid: string; alg: string; use: string; issuer?: string };

interface KeyPair {
  kid: string;
  publicJwk: PublicJwk;
  privateKey: CryptoKey;
}

async function keyPair(kid = "test-key"): Promise<KeyPair> {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return {
    kid,
    publicJwk: { ...publicJwk, kid, alg: "RS256", use: "sig" } as PublicJwk,
    privateKey: pair.privateKey,
  };
}

async function idToken(key: KeyPair, claims: Record<string, unknown>): Promise<string> {
  const header = encodeBase64UrlText(JSON.stringify({ alg: "RS256", kid: key.kid, typ: "JWT" }));
  const payload = encodeBase64UrlText(JSON.stringify(claims));
  const signingInput = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    key.privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${encodeBase64Url(new Uint8Array(signature))}`;
}

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "cache-control": "public, max-age=300" },
  });
}

function redirect(): Response {
  return new Response(null, {
    status: 302,
    headers: { location: "https://redirect-target.invalid/never-requested" },
  });
}

function googleDiscovery() {
  return {
    issuer: "https://accounts.google.com",
    authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    token_endpoint: "https://oauth2.googleapis.com/token",
    jwks_uri: "https://www.googleapis.com/oauth2/v3/certs",
    id_token_signing_alg_values_supported: ["RS256"],
    code_challenge_methods_supported: ["S256"],
  };
}

function microsoftDiscovery() {
  return {
    issuer: "https://login.microsoftonline.com/{tenantid}/v2.0",
    authorization_endpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    token_endpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    jwks_uri: "https://login.microsoftonline.com/common/discovery/v2.0/keys",
    id_token_signing_alg_values_supported: ["RS256"],
  };
}

async function expectStage(promise: Promise<unknown>, stage: OpenIdFailureStage): Promise<void> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(OpenIdExchangeError);
  expect(error).toMatchObject({ message: "identity unavailable", stage });
  expect(Object.keys(error as object).sort()).toEqual(["name", "stage"]);
}

describe("OpenID Connect providers", () => {
  it("builds least-scope Google and Microsoft authorization URLs with state, nonce and S256 PKCE", () => {
    const google = new URL(buildOpenIdAuthorizeUrl(GOOGLE, STATE, CHALLENGE, NONCE));
    expect(google.origin + google.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(google.searchParams)).toEqual({
      client_id: GOOGLE.clientId,
      code_challenge: CHALLENGE,
      code_challenge_method: "S256",
      nonce: NONCE,
      redirect_uri: GOOGLE.callbackUrl,
      response_type: "code",
      scope: "openid email",
      state: STATE,
    });

    const microsoft = new URL(buildOpenIdAuthorizeUrl(MICROSOFT, STATE, CHALLENGE, NONCE));
    expect(microsoft.origin + microsoft.pathname).toBe(
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    );
    expect(Object.fromEntries(microsoft.searchParams)).toEqual({
      client_id: MICROSOFT.clientId,
      code_challenge: CHALLENGE,
      code_challenge_method: "S256",
      nonce: NONCE,
      redirect_uri: MICROSOFT.callbackUrl,
      response_mode: "query",
      response_type: "code",
      scope: "openid email",
      state: STATE,
    });
  });

  it("verifies Google signature, issuer, audience, lifetime, nonce and verified email", async () => {
    const key = await keyPair();
    const token = await idToken(key, {
      iss: "https://accounts.google.com",
      sub: "google-subject-123",
      aud: GOOGLE.clientId,
      iat: Math.floor(NOW.getTime() / 1000) - 5,
      exp: Math.floor(NOW.getTime() / 1000) + 300,
      nonce: NONCE,
      email: "Person@Example.com",
      email_verified: true,
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(googleDiscovery()))
      .mockResolvedValueOnce(response({ id_token: token, token_type: "Bearer", expires_in: 3600 }))
      .mockResolvedValueOnce(response({ keys: [key.publicJwk] }));

    await expect(
      exchangeOpenIdIdentity(fetcher, GOOGLE, "4/0AdQt8qh.opaque~code", VERIFIER, NONCE, NOW),
    ).resolves.toEqual({
      provider: "google",
      subject: "google-subject-123",
      email: "person@example.com",
    });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      "https://accounts.google.com/.well-known/openid-configuration",
      "https://oauth2.googleapis.com/token",
      "https://www.googleapis.com/oauth2/v3/certs",
    ]);
    for (const [, init] of fetcher.mock.calls) {
      expect(init).toMatchObject({ redirect: "manual" });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
    expect(fetcher.mock.calls[1]?.[1]?.body).toContain(`client_secret=${GOOGLE.clientSecret}`);
  });

  it("fails closed for a wrong nonce, audience, issuer, expiry, signature or unverified Google email", async () => {
    const signingKey = await keyPair("signing-key");
    const wrongKey = await keyPair("signing-key");
    const base = {
      iss: "https://accounts.google.com",
      sub: "google-subject-123",
      aud: GOOGLE.clientId,
      iat: Math.floor(NOW.getTime() / 1000) - 5,
      exp: Math.floor(NOW.getTime() / 1000) + 300,
      nonce: NONCE,
      email: "person@example.com",
      email_verified: true,
    };
    const invalidClaims = [
      { ...base, nonce: "wrong" },
      { ...base, aud: "another-client" },
      { ...base, aud: ["another-client", "third-client"], azp: GOOGLE.clientId },
      { ...base, iss: "https://attacker.example" },
      { ...base, exp: Math.floor(NOW.getTime() / 1000) - 1 },
      { ...base, email_verified: false },
    ];

    for (const claims of invalidClaims) {
      const token = await idToken(signingKey, claims);
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(response(googleDiscovery()))
        .mockResolvedValueOnce(response({ id_token: token }))
        .mockResolvedValueOnce(response({ keys: [signingKey.publicJwk] }));
      await expectStage(exchangeOpenIdIdentity(fetcher, GOOGLE, "oauth-code", VERIFIER, NONCE, NOW), "claims");
    }

    const token = await idToken(signingKey, base);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(googleDiscovery()))
      .mockResolvedValueOnce(response({ id_token: token }))
      .mockResolvedValueOnce(response({ keys: [wrongKey.publicJwk] }));
    await expectStage(exchangeOpenIdIdentity(fetcher, GOOGLE, "oauth-code", VERIFIER, NONCE, NOW), "signature");
  });

  it("binds a Microsoft identity to its tenant and validates the tenant-specific issuer", async () => {
    const key = await keyPair();
    const tenant = "aaaabbbb-0000-cccc-1111-dddd2222eeee";
    const issuer = `https://login.microsoftonline.com/${tenant}/v2.0`;
    const token = await idToken(key, {
      iss: issuer,
      tid: tenant,
      sub: "microsoft-subject-456",
      aud: MICROSOFT.clientId,
      iat: Math.floor(NOW.getTime() / 1000) - 5,
      nbf: Math.floor(NOW.getTime() / 1000) - 5,
      exp: Math.floor(NOW.getTime() / 1000) + 300,
      nonce: NONCE,
      ver: "2.0",
      email: "Person@Example.com",
      xms_edov: true,
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(microsoftDiscovery()))
      .mockResolvedValueOnce(response({ id_token: token }))
      .mockResolvedValueOnce(response({ keys: [{ ...key.publicJwk, alg: undefined, issuer }] }));

    await expect(exchangeOpenIdIdentity(fetcher, MICROSOFT, "oauth-code", VERIFIER, NONCE, NOW)).resolves.toEqual({
      provider: "microsoft",
      subject: `${tenant}:microsoft-subject-456`,
      email: "person@example.com",
    });
    const upperCaseClient = { ...MICROSOFT, clientId: MICROSOFT.clientId.toUpperCase() };
    const upperCaseFetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(microsoftDiscovery()))
      .mockResolvedValueOnce(response({ id_token: token }))
      .mockResolvedValueOnce(response({ keys: [{ ...key.publicJwk, alg: undefined, issuer }] }));
    await expect(
      exchangeOpenIdIdentity(upperCaseFetcher, upperCaseClient, "oauth-code", VERIFIER, NONCE, NOW),
    ).resolves.toEqual({
      provider: "microsoft",
      subject: `${tenant}:microsoft-subject-456`,
      email: "person@example.com",
    });
    const differentClientFetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(microsoftDiscovery()))
      .mockResolvedValueOnce(response({ id_token: token }))
      .mockResolvedValueOnce(response({ keys: [{ ...key.publicJwk, alg: undefined, issuer }] }));
    await expectStage(
      exchangeOpenIdIdentity(
        differentClientFetcher,
        { ...upperCaseClient, clientId: upperCaseClient.clientId.replace("0000", "1000") },
        "oauth-code",
        VERIFIER,
        NONCE,
        NOW,
      ),
      "claims",
    );
  });

  it("accepts the exact signed Microsoft personal-account domain verification representation", async () => {
    const key = await keyPair();
    const tenant = "9188040d-6c67-4c5b-b112-36a304b66dad";
    const issuer = `https://login.microsoftonline.com/${tenant}/v2.0`;
    const token = await idToken(key, {
      iss: issuer,
      tid: tenant,
      sub: "personal-subject",
      aud: MICROSOFT.clientId,
      iat: Math.floor(NOW.getTime() / 1000) - 5,
      nbf: Math.floor(NOW.getTime() / 1000) - 5,
      exp: Math.floor(NOW.getTime() / 1000) + 300,
      nonce: NONCE,
      ver: "2.0",
      email: "Person@Example.com",
      xms_edov: "1",
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(microsoftDiscovery()))
      .mockResolvedValueOnce(response({ id_token: token }))
      .mockResolvedValueOnce(response({ keys: [{ ...key.publicJwk, alg: undefined, issuer }] }));
    await expect(exchangeOpenIdIdentity(fetcher, MICROSOFT, "oauth-code", VERIFIER, NONCE, NOW)).resolves.toEqual({
      provider: "microsoft",
      subject: `${tenant}:personal-subject`,
      email: "person@example.com",
    });
  });

  it("rejects mutable Microsoft email and preferred_username claims without verified domain ownership", async () => {
    const key = await keyPair();
    const tenant = "aaaabbbb-0000-cccc-1111-dddd2222eeee";
    const issuer = `https://login.microsoftonline.com/${tenant}/v2.0`;
    for (const emailClaims of [
      { email: "victim@example.com" },
      { preferred_username: "victim@example.com" },
      { email: "victim@example.com", xms_edov: false },
      { email: "victim@example.com", xms_edov: "true" },
      ...["0", "false", "True", " true", "true ", " 1", "1 ", "01", 0, null, [], ["1"], {}].map((xms_edov) => ({
        email: "victim@example.com",
        xms_edov,
      })),
      { email: "victim@example.com", xms_edov: 1 },
      { xms_edov: true },
    ] as Record<string, unknown>[]) {
      const token = await idToken(key, {
        iss: issuer,
        tid: tenant,
        sub: "microsoft-subject-456",
        aud: MICROSOFT.clientId,
        iat: Math.floor(NOW.getTime() / 1000) - 5,
        nbf: Math.floor(NOW.getTime() / 1000) - 5,
        exp: Math.floor(NOW.getTime() / 1000) + 300,
        nonce: NONCE,
        ver: "2.0",
        ...emailClaims,
      });
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(response(microsoftDiscovery()))
        .mockResolvedValueOnce(response({ id_token: token }))
        .mockResolvedValueOnce(response({ keys: [{ ...key.publicJwk, alg: undefined, issuer }] }));

      await expectStage(
        exchangeOpenIdIdentity(fetcher, MICROSOFT, "oauth-code", VERIFIER, NONCE, NOW),
        emailClaims.xms_edov === undefined
          ? "claims_email_verification_missing"
          : emailClaims.xms_edov === "true"
            ? "claims_email_verification_affirmative_text"
            : typeof emailClaims.xms_edov !== "boolean"
              ? "claims_email_verification_type"
              : emailClaims.xms_edov === false
                ? "claims_email_verification_denied"
                : "claims_email",
      );
    }
  });

  it("rejects Microsoft tenant/issuer substitution and a signing key from another tenant", async () => {
    const key = await keyPair();
    const tenant = "aaaabbbb-0000-cccc-1111-dddd2222eeee";
    const otherTenant = "99999999-0000-cccc-1111-dddd2222eeee";
    const issuer = `https://login.microsoftonline.com/${tenant}/v2.0`;
    const token = await idToken(key, {
      iss: issuer,
      tid: tenant,
      sub: "microsoft-subject-456",
      aud: MICROSOFT.clientId,
      iat: Math.floor(NOW.getTime() / 1000) - 5,
      nbf: Math.floor(NOW.getTime() / 1000) - 5,
      exp: Math.floor(NOW.getTime() / 1000) + 300,
      nonce: NONCE,
      ver: "2.0",
      email: "person@example.com",
      xms_edov: true,
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(microsoftDiscovery()))
      .mockResolvedValueOnce(response({ id_token: token }))
      .mockResolvedValueOnce(
        response({ keys: [{ ...key.publicJwk, issuer: `https://login.microsoftonline.com/${otherTenant}/v2.0` }] }),
      );
    await expect(exchangeOpenIdIdentity(fetcher, MICROSOFT, "oauth-code", VERIFIER, NONCE, NOW)).rejects.toThrow(
      "identity unavailable",
    );
  });

  it("rejects discovery endpoint substitution before sending an authorization code", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ ...googleDiscovery(), token_endpoint: "https://attacker.example/token" }));
    await expectStage(exchangeOpenIdIdentity(fetcher, GOOGLE, "oauth-code", VERIFIER, NONCE, NOW), "discovery");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects redirects without contacting their destination during discovery, token exchange or JWKS lookup", async () => {
    const token = `${encodeBase64UrlText(JSON.stringify({ alg: "RS256", kid: "redirect-key" }))}.${encodeBase64UrlText(
      JSON.stringify({}),
    )}.AQ`;
    const cases = [
      {
        stage: "discovery" as const,
        fetcher: vi.fn<typeof fetch>().mockResolvedValueOnce(redirect()),
        calls: 1,
      },
      {
        stage: "token_exchange" as const,
        fetcher: vi
          .fn<typeof fetch>()
          .mockResolvedValueOnce(response(googleDiscovery()))
          .mockResolvedValueOnce(redirect()),
        calls: 2,
      },
      {
        stage: "signature" as const,
        fetcher: vi
          .fn<typeof fetch>()
          .mockResolvedValueOnce(response(googleDiscovery()))
          .mockResolvedValueOnce(response({ id_token: token }))
          .mockResolvedValueOnce(redirect()),
        calls: 3,
      },
    ];

    for (const testCase of cases) {
      await expectStage(
        exchangeOpenIdIdentity(testCase.fetcher, GOOGLE, "oauth-code", VERIFIER, NONCE, NOW),
        testCase.stage,
      );
      expect(testCase.fetcher).toHaveBeenCalledTimes(testCase.calls);
      for (const [, init] of testCase.fetcher.mock.calls) {
        expect(init).toMatchObject({ redirect: "manual" });
      }
    }
  });

  it("separates token exchange and token parsing without retaining provider error content", async () => {
    const malicious = "provider-secret-payload-must-not-survive";
    const rejectedExchange = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(googleDiscovery()))
      .mockResolvedValueOnce(response({ error: malicious }, 400));
    await expectStage(
      exchangeOpenIdIdentity(rejectedExchange, GOOGLE, "oauth-code", VERIFIER, NONCE, NOW),
      "token_exchange",
    );

    const malformedToken = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(googleDiscovery()))
      .mockResolvedValueOnce(response({ id_token: `header.${malicious}.signature` }));
    await expectStage(
      exchangeOpenIdIdentity(malformedToken, GOOGLE, "oauth-code", VERIFIER, NONCE, NOW),
      "token_parse",
    );
  });
});
