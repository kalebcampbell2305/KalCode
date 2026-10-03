import { beforeAll, describe, expect, it } from "vitest";
import type { AccountStore } from "../../worker/lib/account-store";
import { depsFromEnv, type Env } from "../../worker/lib/env";
import {
  type Deps,
  ENTITLEMENT_PATH,
  handleRequest,
  INSIGHTS_DISTRIBUTION_PATH,
  INSIGHTS_REVENUE_PATH,
  KALVOICE_REQUESTS_PATH,
  KALVOICE_USAGE_PATH,
  KEYS_PATH,
  ROUTES,
} from "../../worker/lib/router";
import type {
  AccountRecord,
  ActiveGrant,
  EntitlementStore,
  RecordRequestInput,
  RecordRequestResult,
  UsageStore,
} from "../../worker/lib/store";
import type { EntitlementSigningKey } from "../../worker/lib/token";
import { verifyEntitlementToken, verifyUsageReceipt } from "../../worker/lib/token";
import { generateSigningKey, generateSigningSecret } from "../support/keys";
import { TEST_ACCOUNT_HEADER, TEST_ONLY_AUTHENTICATOR } from "../support/test-auth";

const BASE = "http://127.0.0.1";
const NOW = new Date("2026-09-24T12:00:00.000Z");
const NOW_S = NOW.getTime() / 1000;
const OWNER_ACCOUNT = "acct-owner";
const PRO_ACCOUNT = "acct-pro";
const FREE_ACCOUNT = "acct-free";
const YEARLY_ACCOUNT = "acct-max-yearly";
const CREATED = "2026-01-31T10:00:00.000Z";

type TestKey = Awaited<ReturnType<typeof generateSigningKey>>;
let signer: TestKey;

beforeAll(async () => {
  signer = await generateSigningKey("test-router");
});

interface LedgerRow {
  accountId: string;
  clientRequestId: string;
  recordedAt: string;
  source: string;
}

type FakeStore = EntitlementStore & UsageStore & { ledger: LedgerRow[] };

/** In-memory store with the same semantics as the D1 store (verified against D1 in integration). */
function fakeStore(): FakeStore {
  const grants: Record<string, ActiveGrant[]> = {
    [OWNER_ACCOUNT]: [{ tier: "owner", source: "grant", grantedAt: CREATED, expiresAt: null }],
    [PRO_ACCOUNT]: [
      { tier: "pro", source: "billing", grantedAt: "2026-09-10T08:00:00.000Z", expiresAt: "2026-10-10T08:00:00.000Z" },
    ],
    [FREE_ACCOUNT]: [],
    // A yearly MAX subscription: the grant runs a year, KalVoice cycles stay monthly.
    [YEARLY_ACCOUNT]: [
      { tier: "max", source: "billing", grantedAt: "2026-03-15T09:30:00.000Z", expiresAt: "2027-03-15T09:30:00.000Z" },
    ],
  };
  const ledger: LedgerRow[] = [];
  const count = (accountId: string, from: string, to: string) =>
    ledger.filter((row) => row.accountId === accountId && row.recordedAt >= from && row.recordedAt < to).length;
  return {
    ledger,
    async account(accountId): Promise<AccountRecord | null> {
      return accountId in grants ? { id: accountId, createdAt: CREATED } : null;
    },
    async activeGrants(accountId) {
      return grants[accountId] ?? [];
    },
    async countRequests(accountId, from, to) {
      return count(accountId, from, to);
    },
    async recordRequest(input: RecordRequestInput): Promise<RecordRequestResult> {
      const used = () => count(input.accountId, input.periodStart, input.periodEnd);
      if (ledger.some((r) => r.accountId === input.accountId && r.clientRequestId === input.clientRequestId)) {
        return { outcome: "duplicate", used: used() };
      }
      if (input.source === "online" && input.allowance !== null && used() >= input.allowance) {
        return { outcome: "denied", used: used() };
      }
      ledger.push({ ...input });
      return { outcome: "recorded", used: used() };
    },
  };
}

function deps(overrides: Partial<Deps> = {}): Deps & { logs: Record<string, string>[] } {
  const logs: Record<string, string>[] = [];
  return {
    logs,
    store: fakeStore(),
    accountStore: {
      accountProfile: async (accountId: string) => ({
        id: accountId,
        email: "user@example.com",
        activatedAt: CREATED,
        displayName: null,
      }),
      activateFree: async () => true,
    } as unknown as AccountStore,
    auth: TEST_ONLY_AUTHENTICATOR,
    signingKey: async (): Promise<EntitlementSigningKey> => signer.key,
    previousPublicKeys: () => [],
    now: () => NOW,
    log: (entry) => logs.push(entry),
    ...overrides,
  };
}

const ledgerOf = (d: Deps) => (d.store as FakeStore).ledger;

function seed(d: Deps, accountId: string, count: number) {
  for (let i = 0; i < count; i++) {
    ledgerOf(d).push({
      accountId,
      clientRequestId: `seed-${i}`,
      recordedAt: "2026-09-12T00:00:00.000Z",
      source: "online",
    });
  }
}

const asAccount = (accountId: string, path = ENTITLEMENT_PATH, init: RequestInit = {}) =>
  new Request(`${BASE}${path}`, {
    ...init,
    headers: { [TEST_ACCOUNT_HEADER]: accountId, ...(init.headers as Record<string, string> | undefined) },
  });

interface UsageBody {
  ok: boolean;
  error?: string;
  allowed?: boolean;
  outcome?: string;
  usage: { used: number; allowance: number | null; periodStart: string; resetsAt: string };
  receipt: string;
}

async function post(d: Deps, accountId: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await handleRequest(
    asAccount(accountId, KALVOICE_REQUESTS_PATH, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    d,
  );
  return { status: response.status, body: (await response.json()) as UsageBody };
}

describe("route table", () => {
  it("is exactly the account, auth, billing, entitlement and KalVoice routes", () => {
    expect(ROUTES.map(({ method, path, access }) => ({ method, path, access }))).toEqual([
      { method: "GET", path: "/v1/account", access: "account" },
      { method: "GET", path: "/v1/account/profile", access: "account" },
      { method: "POST", path: "/v1/account/profile", access: "account" },
      { method: "POST", path: "/v1/auth/github/start", access: "public" },
      { method: "GET", path: "/v1/auth/github/callback", access: "public" },
      { method: "POST", path: "/v1/auth/github/complete", access: "public" },
      { method: "POST", path: "/v1/auth/google/start", access: "public" },
      { method: "GET", path: "/v1/auth/google/callback", access: "public" },
      { method: "POST", path: "/v1/auth/google/complete", access: "public" },
      { method: "POST", path: "/v1/auth/microsoft/start", access: "public" },
      { method: "GET", path: "/v1/auth/microsoft/callback", access: "public" },
      { method: "POST", path: "/v1/auth/microsoft/complete", access: "public" },
      { method: "POST", path: "/v1/auth/email/start", access: "public" },
      { method: "POST", path: "/v1/auth/email/verify", access: "public" },
      { method: "POST", path: "/v1/auth/email/poll", access: "public" },
      { method: "POST", path: "/v1/auth/session/refresh", access: "public" },
      { method: "POST", path: "/v1/auth/logout", access: "public" },
      { method: "POST", path: "/v1/account/activate-free", access: "account" },
      { method: "POST", path: "/v1/account/delete/start", access: "account" },
      { method: "POST", path: "/v1/billing/checkout", access: "account" },
      { method: "POST", path: "/v1/billing/portal", access: "account" },
      { method: "POST", path: "/v1/billing/webhook", access: "public" },
      { method: "GET", path: "/v1/entitlement", access: "account" },
      { method: "GET", path: "/v1/entitlement/keys", access: "public" },
      { method: "GET", path: "/v1/kalvoice/usage", access: "account" },
      { method: "POST", path: "/v1/kalvoice/requests", access: "account" },
      { method: "GET", path: "/v1/insights/distribution", access: "owner" },
      { method: "GET", path: "/v1/insights/revenue", access: "owner" },
    ]);
  });

  it("has no direct endpoint that accepts a tier grant, owner elevation or revocation", () => {
    for (const route of ROUTES) {
      expect(route.path).not.toMatch(/grant|revoke|owner|admin|set-tier|entitlement\/update/i);
    }
    expect(ROUTES.filter((route) => route.path.startsWith("/v1/billing/")).map((route) => route.path)).toEqual([
      "/v1/billing/checkout",
      "/v1/billing/portal",
      "/v1/billing/webhook",
    ]);
  });

  it.each(["GET", "POST", "PUT", "PATCH", "DELETE"])(
    "answers %s with 405 where not routed, 404 elsewhere",
    async (method) => {
      const d = deps();
      const unrouted = ROUTES.filter((r) => !ROUTES.some((other) => other.path === r.path && other.method === method));
      for (const route of unrouted) {
        const allowed = ROUTES.filter((r) => r.path === route.path).map((r) => r.method);
        const response = await handleRequest(
          new Request(`${BASE}${route.path}`, {
            method,
            headers: { [TEST_ACCOUNT_HEADER]: OWNER_ACCOUNT, "content-type": "application/json" },
            body: method === "GET" ? null : JSON.stringify({ tier: "owner", accountId: FREE_ACCOUNT }),
          }),
          d,
        );
        expect(response.status).toBe(405);
        expect(response.headers.get("allow")).toBe(allowed.join(", "));
      }
      for (const path of ["/v1/entitlement/grant", "/v1/admin/grant-owner", "/v1/tier", "/v1/owner", "/"]) {
        const response = await handleRequest(
          new Request(`${BASE}${path}`, { method, body: method === "GET" ? null : "{}" }),
          d,
        );
        expect(response.status).toBe(404);
      }
      expect(ledgerOf(d)).toHaveLength(0);
    },
  );
});

describe("the production configuration", () => {
  it("fails closed without auth configuration and never trusts caller identity claims", async () => {
    const secret = await generateSigningSecret("prod-test");
    const env = { DB: {} as D1Database, ENTITLEMENT_SIGNING_KEY: secret } satisfies Env;
    const production = { ...depsFromEnv(env), store: fakeStore() };
    for (const route of ROUTES.filter((r) => r.access !== "public")) {
      for (const headers of [
        {},
        { [TEST_ACCOUNT_HEADER]: OWNER_ACCOUNT },
        { authorization: `Bearer ${OWNER_ACCOUNT}` },
        { cookie: `session=${OWNER_ACCOUNT}` },
        { "x-kalcode-tier": "owner" },
      ]) {
        const init: RequestInit = { method: route.method, headers: { ...headers, "content-type": "application/json" } };
        if (route.method === "POST") init.body = JSON.stringify({ requestId: "req-00000001" });
        const response = await handleRequest(new Request(`${BASE}${route.path}`, init), production);
        expect(response.status, route.path).toBe(401);
        expect(response.headers.get("www-authenticate")).toContain("Bearer");
      }
    }
    expect(ledgerOf(production)).toHaveLength(0);
  });
});

describe("account activation gate", () => {
  it("blocks entitlement, usage reads and request counting until the user chooses a plan", async () => {
    const d = deps({
      accountStore: {
        accountProfile: async (accountId: string) => ({
          id: accountId,
          email: "user@example.com",
          activatedAt: null,
          displayName: null,
        }),
      } as unknown as AccountStore,
    });
    const entitlement = await handleRequest(asAccount(FREE_ACCOUNT, ENTITLEMENT_PATH), d);
    const usage = await handleRequest(asAccount(FREE_ACCOUNT, KALVOICE_USAGE_PATH), d);
    const request = await post(d, FREE_ACCOUNT, { requestId: "req-unactivated" });
    expect([entitlement.status, usage.status, request.status]).toEqual([409, 409, 409]);
    expect(await entitlement.json()).toMatchObject({ error: "account_not_activated" });
    expect(await usage.json()).toMatchObject({ error: "account_not_activated" });
    expect(request.body).toMatchObject({ error: "account_not_activated" });
    expect(ledgerOf(d)).toHaveLength(0);
  });
});

describe("GET /v1/entitlement (authenticated)", () => {
  it("returns the caller's signed OWNER entitlement", async () => {
    const response = await handleRequest(asAccount(OWNER_ACCOUNT), deps());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as { token: string; entitlement: { tier: string; unrestricted: boolean } };
    expect(body.entitlement).toMatchObject({ tier: "owner", unrestricted: true, accountId: OWNER_ACCOUNT });
    const verified = await verifyEntitlementToken(body.token, signer.trusted, NOW_S);
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
    expect(d.logs).toEqual([{ level: "error", event: "api.signing_key_unavailable" }]);
  });

  it("hides internal errors", async () => {
    const d = deps({
      store: {
        ...fakeStore(),
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
    const retired = await generateSigningKey("k-old");
    const previous = [{ kid: "k-old", x: retired.key.publicKey }];
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
        { kty: "OKP", crv: "Ed25519", alg: "EdDSA", use: "sig", kid: "k-old", x: retired.key.publicKey },
      ],
    });
  });
  it("fails closed when a retired identity aliases the current key", async () => {
    const response = await handleRequest(
      new Request(`${BASE}${KEYS_PATH}`),
      deps({ previousPublicKeys: () => [{ kid: "k-old", x: signer.key.publicKey }] }),
    );
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(signer.key.publicKey);
  });
});

describe("KalVoice Requests", () => {
  it("counts a request once per client request id, with a signed receipt", async () => {
    const d = deps();
    const first = await post(d, FREE_ACCOUNT, { requestId: "req-00000001" });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ allowed: true, outcome: "recorded", usage: { used: 1, allowance: 25 } });
    const retry = await post(d, FREE_ACCOUNT, { requestId: "req-00000001" });
    expect(retry.body).toMatchObject({ allowed: true, outcome: "duplicate", usage: { used: 1 } });
    expect(ledgerOf(d)).toHaveLength(1);
    const receipt = await verifyUsageReceipt(retry.body.receipt, signer.trusted, NOW_S);
    expect(receipt).toMatchObject({
      ok: true,
      receipt: { accountId: FREE_ACCOUNT, tier: "free", used: 1, allowance: 25 },
    });
  });

  it("anchors Free cycles to account creation and paid cycles to the subscription start", async () => {
    const d = deps();
    const free = await post(d, FREE_ACCOUNT, { requestId: "req-free-0001" });
    expect(free.body.usage).toMatchObject({
      periodStart: "2026-08-31T10:00:00.000Z",
      resetsAt: "2026-09-30T10:00:00.000Z",
    });
    const pro = await post(d, PRO_ACCOUNT, { requestId: "req-pro-00001" });
    expect(pro.body.usage).toMatchObject({
      allowance: 150,
      periodStart: "2026-09-10T08:00:00.000Z",
      resetsAt: "2026-10-10T08:00:00.000Z",
    });
  });

  it("keeps monthly KalVoice cycles from the billing anchor on a yearly subscription", async () => {
    const d = deps();
    const yearly = await post(d, YEARLY_ACCOUNT, { requestId: "req-yearly-001" });
    expect(yearly.body).toMatchObject({ allowed: true, outcome: "recorded" });
    // Anchor 2026-03-15 09:30; now 2026-09-24 → the seventh monthly cycle, not the yearly period.
    expect(yearly.body.usage).toEqual({
      used: 1,
      allowance: 500,
      periodStart: "2026-09-15T09:30:00.000Z",
      resetsAt: "2026-10-15T09:30:00.000Z",
    });
    const receipt = await verifyUsageReceipt(yearly.body.receipt, signer.trusted, NOW_S);
    expect(receipt).toMatchObject({
      ok: true,
      receipt: { tier: "max", allowance: 500, resetsAt: "2026-10-15T09:30:00.000Z" },
    });
  });

  it("denies online requests once the allowance is used, without counting them", async () => {
    const d = deps();
    seed(d, FREE_ACCOUNT, 25);
    const denied = await post(d, FREE_ACCOUNT, { requestId: "req-00000026" });
    expect(denied.body).toMatchObject({ allowed: false, outcome: "denied", usage: { used: 25, allowance: 25 } });
    expect(ledgerOf(d)).toHaveLength(25);
    expect(d.logs).toContainEqual({ level: "info", event: "kalvoice.allowance_exhausted", tier: "free" });
    // A request already served offline (within the device's signed allowance) is still recorded.
    const replay = await post(d, FREE_ACCOUNT, { requestId: "req-offline-01", mode: "offline" });
    expect(replay.body).toMatchObject({ allowed: true, outcome: "recorded", usage: { used: 26 } });
  });

  it("never denies OWNER", async () => {
    const d = deps();
    seed(d, OWNER_ACCOUNT, 20_000);
    const result = await post(d, OWNER_ACCOUNT, { requestId: "req-owner-0001" });
    expect(result.body).toMatchObject({
      allowed: true,
      outcome: "recorded",
      usage: { used: 20_001, allowance: null },
    });
    const receipt = await verifyUsageReceipt(result.body.receipt, signer.trusted, NOW_S);
    expect(receipt).toMatchObject({ ok: true, receipt: { tier: "owner", allowance: null } });
  });

  it.each([
    ["no request id", {}],
    ["a short request id", { requestId: "short" }],
    ["request text instead of an id", { requestId: "open four codex threads" }],
    ["an unknown mode", { requestId: "req-00000001", mode: "free" }],
    ["client-claimed usage", { requestId: "req-00000001", used: 0 }],
    ["client-claimed tier", { requestId: "req-00000001", tier: "owner" }],
    ["an array", ["req-00000001"]],
  ])("rejects %s", async (_name, body) => {
    const d = deps();
    const result = await post(d, FREE_ACCOUNT, body);
    expect(result.status).toBe(400);
    expect(ledgerOf(d)).toHaveLength(0);
  });

  it("refuses browser-originated writes and non-JSON bodies", async () => {
    const d = deps();
    const browser = await post(d, FREE_ACCOUNT, { requestId: "req-00000001" }, { origin: "https://example.com" });
    expect(browser.status).toBe(403);
    const form = await handleRequest(
      asAccount(FREE_ACCOUNT, KALVOICE_REQUESTS_PATH, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: '{"requestId":"req-00000001"}',
      }),
      d,
    );
    expect(form.status).toBe(415);
    expect(ledgerOf(d)).toHaveLength(0);
  });

  it("reports usage with a signed receipt", async () => {
    const d = deps();
    await post(d, PRO_ACCOUNT, { requestId: "req-00000001" });
    await post(d, PRO_ACCOUNT, { requestId: "req-00000002" });
    const response = await handleRequest(asAccount(PRO_ACCOUNT, KALVOICE_USAGE_PATH), d);
    const body = (await response.json()) as UsageBody;
    expect(body.usage).toEqual({
      used: 2,
      allowance: 150,
      periodStart: "2026-09-10T08:00:00.000Z",
      resetsAt: "2026-10-10T08:00:00.000Z",
    });
    const receipt = await verifyUsageReceipt(body.receipt, signer.trusted, NOW_S);
    expect(receipt).toMatchObject({ ok: true, receipt: { ...body.usage, accountId: PRO_ACCOUNT, tier: "pro" } });
  });

  it("returns signed unlimited OWNER usage and full grants without a billing subscription", async () => {
    const d = deps();
    seed(d, OWNER_ACCOUNT, 20_000);
    expect(await d.store.activeGrants(OWNER_ACCOUNT, NOW.toISOString())).toEqual([
      { tier: "owner", source: "grant", grantedAt: CREATED, expiresAt: null },
    ]);

    const entitlementResponse = await handleRequest(asAccount(OWNER_ACCOUNT), d);
    expect(entitlementResponse.status).toBe(200);
    const entitlementBody = (await entitlementResponse.json()) as { token: string };
    expect(await verifyEntitlementToken(entitlementBody.token, signer.trusted, NOW_S)).toMatchObject({
      ok: true,
      entitlement: {
        accountId: OWNER_ACCOUNT,
        tier: "owner",
        unrestricted: true,
        features: [],
        limits: {},
      },
    });

    const response = await handleRequest(asAccount(OWNER_ACCOUNT, KALVOICE_USAGE_PATH), d);
    expect(response.status).toBe(200);
    const body = (await response.json()) as UsageBody;
    expect(body.usage).toEqual({
      used: 20_000,
      allowance: null,
      periodStart: "2026-08-31T10:00:00.000Z",
      resetsAt: "2026-09-30T10:00:00.000Z",
    });
    expect(await verifyUsageReceipt(body.receipt, signer.trusted, NOW_S)).toMatchObject({
      ok: true,
      receipt: { ...body.usage, accountId: OWNER_ACCOUNT, tier: "owner" },
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

describe("owner insights", () => {
  const served: string[] = [];
  const insights = {
    distribution: async () => {
      served.push("distribution");
      return new Response(JSON.stringify({ ok: true, secret: "owner-data" }), { status: 200 });
    },
    revenue: async () => {
      served.push("revenue");
      return new Response(JSON.stringify({ ok: true, secret: "owner-data" }), { status: 200 });
    },
    snapshot: async () => {},
  };

  it.each([INSIGHTS_DISTRIBUTION_PATH, INSIGHTS_REVENUE_PATH])(
    "%s is served only to an active OWNER grant",
    async (path) => {
      served.length = 0;
      const d = deps({ insights });
      const anonymous = await handleRequest(new Request(`${BASE}${path}`), d);
      expect(anonymous.status).toBe(401);
      for (const accountId of [FREE_ACCOUNT, PRO_ACCOUNT, YEARLY_ACCOUNT, "acct-unknown"]) {
        const response = await handleRequest(asAccount(accountId, path), d);
        expect(response.status, accountId).toBe(accountId === "acct-unknown" ? 401 : 403);
        expect(await response.text()).not.toContain("owner-data");
      }
      // Tier claims in the request are never trusted.
      const claimed = await handleRequest(
        asAccount(PRO_ACCOUNT, `${path}?tier=owner`, { headers: { "x-kalcode-tier": "owner" } }),
        d,
      );
      expect(claimed.status).toBe(403);
      expect(served).toEqual([]);
      const owner = await handleRequest(asAccount(OWNER_ACCOUNT, path), d);
      expect(owner.status).toBe(200);
      expect(served).toHaveLength(1);
    },
  );

  it("refuses other browser origins even for the owner, and allows kalcoded.com with credentials", async () => {
    const d = deps({ insights });
    const foreign = await handleRequest(
      asAccount(OWNER_ACCOUNT, INSIGHTS_REVENUE_PATH, { headers: { origin: "https://evil.example" } }),
      d,
    );
    expect(foreign.status).toBe(403);
    expect(foreign.headers.get("access-control-allow-origin")).toBeNull();
    const site = await handleRequest(
      asAccount(OWNER_ACCOUNT, INSIGHTS_REVENUE_PATH, { headers: { origin: "https://kalcoded.com" } }),
      d,
    );
    expect(site.status).toBe(200);
    expect(site.headers.get("access-control-allow-origin")).toBe("https://kalcoded.com");
    expect(site.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("ignores an owner row that does not come from an operator grant", async () => {
    const d = deps({ insights });
    const store = d.store;
    d.store = {
      ...store,
      activeGrants: async () => [{ tier: "owner", source: "billing", grantedAt: CREATED, expiresAt: null }],
    } as typeof store;
    const response = await handleRequest(asAccount(PRO_ACCOUNT, INSIGHTS_REVENUE_PATH), d);
    expect(response.status).toBe(403);
  });

  it("answers 503 for the owner when insights are not configured", async () => {
    const response = await handleRequest(
      asAccount(OWNER_ACCOUNT, INSIGHTS_DISTRIBUTION_PATH),
      deps({ insights: null }),
    );
    expect(response.status).toBe(503);
  });
});
