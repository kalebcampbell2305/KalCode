import { beforeAll, describe, expect, it } from "vitest";
import { depsFromEnv, type Env } from "../../worker/lib/env";
import { type Deps, ENTITLEMENT_PATH, handleRequest, KEYS_PATH, ROUTES } from "../../worker/lib/router";
import type { ActiveGrant, EntitlementStore } from "../../worker/lib/store";
import type { EntitlementSigningKey } from "../../worker/lib/token";
import { verifyEntitlementToken } from "../../worker/lib/token";
import { generateSigningKey, generateSigningSecret } from "../support/keys";
import { TEST_ACCOUNT_HEADER, TEST_ONLY_AUTHENTICATOR } from "../support/test-auth";

const BASE = "http://127.0.0.1";
const NOW = new Date("2026-09-24T12:00:00.000Z");
const OWNER_ACCOUNT = "acct-owner";
const PRO_ACCOUNT = "acct-pro";
const FREE_ACCOUNT = "acct-free";

type TestKey = Awaited<ReturnType<typeof generateSigningKey>>;
let signer: TestKey;

beforeAll(async () => {
  signer = await generateSigningKey("test-router");
});

function fakeStore(): EntitlementStore & { calls: string[] } {
  const grants: Record<string, ActiveGrant[]> = {
    [OWNER_ACCOUNT]: [{ tier: "owner", source: "grant", expiresAt: null }],
    [PRO_ACCOUNT]: [{ tier: "pro", source: "billing", expiresAt: "2026-10-24T12:00:00.000Z" }],
    [FREE_ACCOUNT]: [],
  };
  const calls: string[] = [];
  return {
    calls,
    async accountExists(accountId) {
      calls.push(`exists:${accountId}`);
      return accountId in grants;
    },
    async activeGrants(accountId) {
      calls.push(`grants:${accountId}`);
      return grants[accountId] ?? [];
    },
  };
}

function deps(overrides: Partial<Deps> = {}): Deps & { logs: Record<string, string>[] } {
  const logs: Record<string, string>[] = [];
  return {
    logs,
    store: fakeStore(),
    auth: TEST_ONLY_AUTHENTICATOR,
    signingKey: async (): Promise<EntitlementSigningKey> => signer.key,
    previousPublicKeys: () => [],
    now: () => NOW,
    log: (entry) => logs.push(entry),
    ...overrides,
  };
}

const asAccount = (accountId: string, init: RequestInit = {}) =>
  new Request(`${BASE}${ENTITLEMENT_PATH}`, { ...init, headers: { [TEST_ACCOUNT_HEADER]: accountId } });

describe("route table", () => {
  it("is exactly the two read-only entitlement routes", () => {
    expect(ROUTES.map(({ method, path, access }) => ({ method, path, access }))).toEqual([
      { method: "GET", path: "/v1/entitlement", access: "account" },
      { method: "GET", path: "/v1/entitlement/keys", access: "public" },
    ]);
  });

  it("has no endpoint that could grant, change or revoke a tier", () => {
    for (const route of ROUTES) {
      expect(route.method).toBe("GET");
      expect(route.path).not.toMatch(/grant|revoke|tier|owner|admin|upgrade|plan|billing|checkout|webhook/i);
    }
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])(
    "answers %s with 405 on every route and 404 elsewhere",
    async (method) => {
      const d = deps();
      for (const route of ROUTES) {
        const response = await handleRequest(
          new Request(`${BASE}${route.path}`, {
            method,
            headers: { [TEST_ACCOUNT_HEADER]: OWNER_ACCOUNT, "content-type": "application/json" },
            body: JSON.stringify({ tier: "owner", accountId: FREE_ACCOUNT }),
          }),
          d,
        );
        expect(response.status).toBe(405);
        expect(response.headers.get("allow")).toBe("GET");
      }
      for (const path of ["/v1/entitlement/grant", "/v1/admin/grant-owner", "/v1/tier", "/v1/owner", "/"]) {
        const response = await handleRequest(new Request(`${BASE}${path}`, { method, body: "{}" }), d);
        expect(response.status).toBe(404);
      }
    },
  );
});

describe("GET /v1/entitlement in the production configuration", () => {
  it("always answers 401: sign-in does not exist yet, whatever the request claims", async () => {
    const secret = await generateSigningSecret("prod-test");
    const env = { DB: {} as D1Database, ENTITLEMENT_SIGNING_KEY: secret } satisfies Env;
    const production = { ...depsFromEnv(env), store: fakeStore() };
    for (const headers of [
      {},
      { [TEST_ACCOUNT_HEADER]: OWNER_ACCOUNT },
      { authorization: `Bearer ${OWNER_ACCOUNT}` },
      { cookie: `session=${OWNER_ACCOUNT}` },
      { "x-kalcode-tier": "owner" },
    ]) {
      const response = await handleRequest(new Request(`${BASE}${ENTITLEMENT_PATH}`, { headers }), production);
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toContain("Bearer");
      expect(await response.json()).toMatchObject({ ok: false, error: "unauthenticated" });
    }
  });
});

describe("GET /v1/entitlement (authenticated)", () => {
  it("returns the caller's signed OWNER entitlement", async () => {
    const response = await handleRequest(asAccount(OWNER_ACCOUNT), deps());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as { token: string; entitlement: { tier: string; unrestricted: boolean } };
    expect(body.entitlement).toMatchObject({ tier: "owner", unrestricted: true, accountId: OWNER_ACCOUNT });
    const verified = await verifyEntitlementToken(body.token, signer.trusted, NOW.getTime() / 1000);
    expect(verified).toEqual({ ok: true, entitlement: body.entitlement });
  });

  it("returns Pro and Free for the corresponding accounts", async () => {
    const pro = (await (await handleRequest(asAccount(PRO_ACCOUNT), deps())).json()) as {
      entitlement: { tier: string; unrestricted: boolean };
    };
    expect(pro.entitlement).toMatchObject({ tier: "pro", unrestricted: false });
    const free = (await (await handleRequest(asAccount(FREE_ACCOUNT), deps())).json()) as {
      entitlement: { tier: string };
    };
    expect(free.entitlement.tier).toBe("free");
  });

  it("ignores anything the client says about its tier", async () => {
    const request = new Request(`${BASE}${ENTITLEMENT_PATH}?tier=owner&unrestricted=true`, {
      headers: { [TEST_ACCOUNT_HEADER]: FREE_ACCOUNT, "x-kalcode-tier": "owner" },
    });
    const body = (await (await handleRequest(request, deps())).json()) as { entitlement: { tier: string } };
    expect(body.entitlement.tier).toBe("free");
  });

  it("answers 401 for an unknown account and without credentials", async () => {
    expect((await handleRequest(asAccount("acct-deleted"), deps())).status).toBe(401);
    expect((await handleRequest(new Request(`${BASE}${ENTITLEMENT_PATH}`), deps())).status).toBe(401);
  });

  it("answers 503 without a signing key, and never an unsigned document", async () => {
    const d = deps({ signingKey: async () => null });
    const response = await handleRequest(asAccount(OWNER_ACCOUNT), d);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("owner");
    expect(d.logs).toEqual([{ level: "error", event: "entitlement.signing_key_unavailable" }]);
  });

  it("hides internal errors", async () => {
    const d = deps({
      store: {
        accountExists: async () => true,
        activeGrants: async () => {
          throw new Error("D1_ERROR: internal detail");
        },
      },
    });
    const response = await handleRequest(asAccount(OWNER_ACCOUNT), d);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("internal detail");
    expect(d.logs).toEqual([{ level: "error", event: "api.unhandled", error: "Error" }]);
  });
});

describe("GET /v1/entitlement/keys", () => {
  it("publishes the current and retired public keys, never private material", async () => {
    const previous = [{ kid: "k-old", x: signer.key.publicKey }];
    const response = await handleRequest(
      new Request(`${BASE}${KEYS_PATH}`),
      deps({ previousPublicKeys: () => previous }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    const text = await response.text();
    expect(text).not.toContain('"d"');
    expect(JSON.parse(text)).toEqual({
      keys: [
        { kty: "OKP", crv: "Ed25519", alg: "EdDSA", use: "sig", kid: "test-router", x: signer.key.publicKey },
        { kty: "OKP", crv: "Ed25519", alg: "EdDSA", use: "sig", kid: "k-old", x: signer.key.publicKey },
      ],
    });
  });
});

describe("responses", () => {
  it("carry restrictive security headers", async () => {
    for (const request of [new Request(`${BASE}${KEYS_PATH}`), new Request(`${BASE}/nope`), asAccount("x")]) {
      const response = await handleRequest(request, deps());
      expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'none'");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
  });
});
