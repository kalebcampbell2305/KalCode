/**
 * End to end in the real Workers runtime: `wrangler dev` (workerd) with a local D1 that the
 * operator tool wrote the OWNER grant into. Covers WebCrypto Ed25519 signing inside workerd and
 * verification of the result outside it.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { importPublicKey, verifyEntitlementToken, verifyUsageReceipt } from "../../worker/lib/token";
import { type DevServer, startDevServer } from "../support/dev-server";
import { generateSigningSecret } from "../support/keys";
import { TEST_ACCOUNT_HEADER } from "../support/test-auth";
import { createMigratedDatabase, execSql, REPO_ROOT, removeDatabase } from "../support/wrangler";

// Ports reserved for the owner worktree's API integration tests (docs/DEVELOPMENT.md); override
// with KALCODE_API_TEST_PORT when another checkout runs these tests at the same time.
const BASE_PORT = Number(process.env.KALCODE_API_TEST_PORT ?? 18433);
const PORTS = {
  production: BASE_PORT,
  testEntry: BASE_PORT + 1,
  inspector: [BASE_PORT + 1000, BASE_PORT + 1001] as const,
};
const OWNER = "5d7c1f0a-3e2b-4a9c-8d6e-1f2a3b4c5d6e";
const FREE = "9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b";
const REVOKED = "2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f";

let persistTo: string;
let secret: string;

function operatorTool(script: "grant-owner" | "revoke-owner", accountId: string) {
  const result = spawnSync(
    process.execPath,
    [
      join(REPO_ROOT, "tooling", "admin", `${script}.mjs`),
      "--account",
      accountId,
      "--reason",
      "integration test",
      "--local",
      "--persist-to",
      persistTo,
      "--confirm",
    ],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.status !== 0)
    throw new Error(`${script} failed:
${result.stdout}${result.stderr}`);
}

// All database writes happen before a dev server starts: a second local workerd must not open
// the same SQLite files while one is serving.
beforeAll(async () => {
  persistTo = createMigratedDatabase();
  secret = await generateSigningSecret("dev-integration");
  execSql(
    persistTo,
    "INSERT INTO accounts (id, email, email_verified_at, created_at, activated_at) VALUES " +
      `('${OWNER}', 'owner-e2e@example.com', '2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z'), ` +
      `('${REVOKED}', 'revoked-e2e@example.com', '2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z'), ` +
      `('${FREE}', 'free-e2e@example.com', '2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z')`,
  );
  operatorTool("grant-owner", OWNER);
  operatorTool("grant-owner", REVOKED);
  operatorTool("revoke-owner", REVOKED);
});

afterAll(async () => {
  await removeDatabase(persistTo);
});

describe("production entry point (worker/index.ts)", () => {
  let server: DevServer;
  beforeAll(async () => {
    server = await startDevServer({
      port: PORTS.production,
      inspectorPort: PORTS.inspector[0],
      persistTo,
      vars: { ENTITLEMENT_SIGNING_KEY: secret },
    });
  });
  afterAll(async () => {
    await server?.stop();
  });

  it("never trusts identity claims when sign-in configuration is absent", async () => {
    for (const headers of [{}, { [TEST_ACCOUNT_HEADER]: OWNER }, { authorization: `Bearer ${OWNER}` }]) {
      expect((await fetch(`${server.origin}/v1/entitlement`, { headers })).status).toBe(401);
      expect((await fetch(`${server.origin}/v1/kalvoice/usage`, { headers })).status).toBe(401);
      const post = await fetch(`${server.origin}/v1/kalvoice/requests`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ requestId: "req-prod-0001" }),
      });
      expect(post.status).toBe(401);
    }
  });

  it("fails closed on auth and billing routes when their external configuration is absent", async () => {
    for (const provider of ["github", "google", "microsoft"]) {
      const auth = await fetch(`${server.origin}/v1/auth/${provider}/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM" }),
      });
      expect(auth.status).toBe(503);
      if (provider !== "github") {
        expect(await auth.json()).toMatchObject({ ok: false, error: "sign_in_unavailable" });
      }
    }
    const webhook = await fetch(`${server.origin}/v1/billing/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(webhook.status).toBe(503);
  });

  it("publishes the signing key's public half", async () => {
    const response = await fetch(`${server.origin}/v1/entitlement/keys`);
    const body = (await response.json()) as { keys: { kid: string; x: string }[] };
    expect(body.keys).toEqual([
      { kty: "OKP", crv: "Ed25519", alg: "EdDSA", use: "sig", kid: "dev-integration", x: JSON.parse(secret).x },
    ]);
    expect(JSON.stringify(body)).not.toContain(JSON.parse(secret).d);
  });

  it("offers no way to change a tier", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const response = await fetch(`${server.origin}/v1/entitlement`, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountId: FREE, tier: "owner" }),
      });
      expect(response.status).toBe(405);
    }
    const tiers = execSql(persistTo, `SELECT COUNT(*) AS n FROM entitlement_grants WHERE account_id = '${FREE}'`);
    expect(tiers[0]?.[0]).toEqual({ n: 0 });
  });
});

describe("test entry point (test authenticator, otherwise production code)", () => {
  let server: DevServer;
  beforeAll(async () => {
    server = await startDevServer({
      script: "tests/support/test-worker.ts",
      port: PORTS.testEntry,
      inspectorPort: PORTS.inspector[1],
      persistTo,
      vars: { ENTITLEMENT_SIGNING_KEY: secret },
    });
  });
  afterAll(async () => {
    await server?.stop();
  });

  async function fetchEntitlement(accountId: string) {
    const response = await fetch(`${server.origin}/v1/entitlement`, { headers: { [TEST_ACCOUNT_HEADER]: accountId } });
    expect(response.status).toBe(200);
    return (await response.json()) as { token: string; entitlement: Record<string, unknown> };
  }

  it("signs the operator-granted OWNER entitlement in workerd; it verifies outside", async () => {
    const { token, entitlement } = await fetchEntitlement(OWNER);
    expect(entitlement).toMatchObject({
      tier: "owner",
      unrestricted: true,
      accountId: OWNER,
      keyId: "dev-integration",
    });
    const key = await importPublicKey(JSON.parse(secret).x);
    if (!key) throw new Error("key import failed");
    const verified = await verifyEntitlementToken(
      token,
      new Map([["dev-integration", key]]),
      Math.floor(Date.now() / 1000),
    );
    expect(verified).toEqual({ ok: true, entitlement });
  });

  it("gives an account without grants Free", async () => {
    const { entitlement } = await fetchEntitlement(FREE);
    expect(entitlement).toMatchObject({ tier: "free", unrestricted: false });
  });

  it("serves Free once the operator has revoked OWNER", async () => {
    const { entitlement } = await fetchEntitlement(REVOKED);
    expect(entitlement).toMatchObject({ tier: "free", unrestricted: false });
  });

  async function kalvoice(accountId: string, requestId: string) {
    const response = await fetch(`${server.origin}/v1/kalvoice/requests`, {
      method: "POST",
      headers: { [TEST_ACCOUNT_HEADER]: accountId, "content-type": "application/json" },
      body: JSON.stringify({ requestId }),
    });
    expect(response.status).toBe(200);
    return (await response.json()) as {
      allowed: boolean;
      outcome: string;
      usage: { used: number; allowance: number | null };
      receipt: string;
    };
  }

  it("meters KalVoice Requests in the ledger: idempotent, OWNER unlimited, signed receipts", async () => {
    const key = await importPublicKey(JSON.parse(secret).x);
    if (!key) throw new Error("key import failed");
    const keys = new Map([["dev-integration", key]]);
    const now = Math.floor(Date.now() / 1000);

    const owner = await kalvoice(OWNER, "req-owner-e2e-1");
    expect(owner).toMatchObject({ allowed: true, outcome: "recorded", usage: { used: 1, allowance: null } });
    expect(await verifyUsageReceipt(owner.receipt, keys, now)).toMatchObject({
      ok: true,
      receipt: { accountId: OWNER, tier: "owner", used: 1, allowance: null },
    });

    const free = await kalvoice(FREE, "req-free-e2e-1");
    expect(free).toMatchObject({ allowed: true, outcome: "recorded", usage: { used: 1, allowance: 25 } });
    const again = await kalvoice(FREE, "req-free-e2e-1");
    expect(again).toMatchObject({ allowed: true, outcome: "duplicate", usage: { used: 1 } });

    const usage = await fetch(`${server.origin}/v1/kalvoice/usage`, { headers: { [TEST_ACCOUNT_HEADER]: FREE } });
    expect(await usage.json()).toMatchObject({ usage: { used: 1, allowance: 25 } });
  });
});
