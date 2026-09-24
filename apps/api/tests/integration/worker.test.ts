/**
 * End to end in the real Workers runtime: `wrangler dev` (workerd) with a local D1 that the
 * operator tool wrote the OWNER grant into. Covers WebCrypto Ed25519 signing inside workerd and
 * verification of the result outside it.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { importPublicKey, verifyEntitlementToken } from "../../worker/lib/token";
import { type DevServer, startDevServer } from "../support/dev-server";
import { generateSigningSecret } from "../support/keys";
import { TEST_ACCOUNT_HEADER } from "../support/test-auth";
import { createMigratedDatabase, execSql, REPO_ROOT, removeDatabase } from "../support/wrangler";

// Ports reserved for the owner worktree's API integration tests (docs/DEVELOPMENT.md).
const PORTS = { production: 18433, testEntry: 18434, inspector: [19433, 19434] as const };
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
    { encoding: "utf8" },
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
    "INSERT INTO accounts (id, email, email_verified_at, created_at) VALUES " +
      `('${OWNER}', 'owner-e2e@example.com', '2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z'), ` +
      `('${REVOKED}', 'revoked-e2e@example.com', '2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z'), ` +
      `('${FREE}', 'free-e2e@example.com', '2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z')`,
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

  it("never serves an entitlement: sign-in does not exist yet", async () => {
    for (const headers of [{}, { [TEST_ACCOUNT_HEADER]: OWNER }, { authorization: `Bearer ${OWNER}` }]) {
      const response = await fetch(`${server.origin}/v1/entitlement`, { headers });
      expect(response.status).toBe(401);
    }
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
});
