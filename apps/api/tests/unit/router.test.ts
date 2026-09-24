import { beforeAll, describe, expect, it } from "vitest";
import { depsFromEnv, type Env } from "../../worker/lib/env";
import {
  type Deps,
  ENTITLEMENT_PATH,
  handleRequest,
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
  it("is exactly the entitlement and KalVoice usage routes", () => {
    expect(ROUTES.map(({ method, path, access }) => ({ method, path, access }))).toEqual([
      { method: "GET", path: "/v1/entitlement", access: "account" },
      { method: "GET", path: "/v1/entitlement/keys", access: "public" },
      { method: "GET", path: "/v1/kalvoice/usage", access: "account" },
      { method: "POST", path: "/v1/kalvoice/requests", access: "account" },
    ]);
  });

  it("has no endpoint that could grant, change or revoke a tier", () => {
    for (const route of ROUTES) {
      expect(route.path).not.toMatch(/grant|revoke|tier|owner|admin|upgrade|plan|billing|checkout|webhook|account/i);
      if (route.method !== "GET") expect(route.path).toBe(KALVOICE_REQUESTS_PATH);
    }
  });

  it.each(["GET", "POST", "PUT", "PATCH", "DELETE"])(
    "answers %s with 405 where not routed, 404 elsewhere",
    async (method) => {
      const d = deps();
      for (const route of ROUTES.filter((r) => r.method !== method)) {
        const response = await handleRequest(
          new Request(`${BASE}${route.path}`, {
            method,
            headers: { [TEST_ACCOUNT_HEADER]: OWNER_ACCOUNT, "content-type": "application/json" },
            body: method === "GET" ? null : JSON.stringify({ tier: "owner", accountId: FREE_ACCOUNT }),
          }),
          d,
        );
        expect(response.status).toBe(405);
        expect(response.headers.get("allow")).toBe(route.method);
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
  it("answers 401 on every account route: sign-in does not exist yet, whatever the request claims", async () => {
    const secret = await generateSigningSecret("prod-test");
    const env = { DB: {} as D1Database, ENTITLEMENT_SIGNING_KEY: secret } satisfies Env;
    const production = { ...depsFromEnv(env), store: fakeStore() };
    for (const route of ROUTES.filter((r) => r.access === "account")) {
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

describe("KalVoice Requests", () => {
  it("counts a request once per client request id, with a signed receipt", async () => {
    const d = deps();
    const first = await post(d, FREE_ACCOUNT, { requestId: "req-00000001" });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ allowed: true, outcome: "recorded", usage: { used: 1, allowance: 250 } });
    const retry = await post(d, FREE_ACCOUNT, { requestId: "req-00000001" });
    expect(retry.body).toMatchObject({ allowed: true, outcome: "duplicate", usage: { used: 1 } });
    expect(ledgerOf(d)).toHaveLength(1);
    const receipt = await verifyUsageReceipt(retry.body.receipt, signer.trusted, NOW_S);
    expect(receipt).toMatchObject({
      ok: true,
      receipt: { accountId: FREE_ACCOUNT, tier: "free", used: 1, allowance: 250 },
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
      allowance: 2500,
      periodStart: "2026-09-10T08:00:00.000Z",
      resetsAt: "2026-10-10T08:00:00.000Z",
    });
  });

  it("denies online requests once the allowance is used, without counting them", async () => {
    const d = deps();
    seed(d, FREE_ACCOUNT, 250);
    const denied = await post(d, FREE_ACCOUNT, { requestId: "req-00000251" });
    expect(denied.body).toMatchObject({ allowed: false, outcome: "denied", usage: { used: 250, allowance: 250 } });
    expect(ledgerOf(d)).toHaveLength(250);
    expect(d.logs).toContainEqual({ level: "info", event: "kalvoice.allowance_exhausted", tier: "free" });
    // A request already served offline (within the device's signed allowance) is still recorded.
    const replay = await post(d, FREE_ACCOUNT, { requestId: "req-offline-01", mode: "offline" });
    expect(replay.body).toMatchObject({ allowed: true, outcome: "recorded", usage: { used: 251 } });
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
      allowance: 2500,
      periodStart: "2026-09-10T08:00:00.000Z",
      resetsAt: "2026-10-10T08:00:00.000Z",
    });
    const receipt = await verifyUsageReceipt(body.receipt, signer.trusted, NOW_S);
    expect(receipt).toMatchObject({ ok: true, receipt: { ...body.usage, accountId: PRO_ACCOUNT, tier: "pro" } });
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
