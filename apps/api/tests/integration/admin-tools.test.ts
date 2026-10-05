/**
 * The trusted operator tools (`tooling/admin/*.mjs`) against a real local D1 (`--local
 * --persist-to <temp dir>`). They are the only way to grant or revoke OWNER.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMigratedDatabase, execSql, REPO_ROOT, removeDatabase } from "../support/wrangler";

const GRANT = join(REPO_ROOT, "tooling", "admin", "grant-owner.mjs");
const REVOKE = join(REPO_ROOT, "tooling", "admin", "revoke-owner.mjs");
const ACCOUNT = "3f0e9d5c-2b7a-4c1e-8f6d-9a0b1c2d3e4f";
const OTHER = "7a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d";
const GENERATED_ACCOUNT = "acct_abCD_ef-GH0123456789abcd";

let persistTo: string;

function tool(script: string, args: readonly string[]) {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: process.env,
    windowsHide: true,
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

const local = () => ["--local", "--persist-to", persistTo];

function ownerGrants(accountId: string) {
  return execSql(
    persistTo,
    `SELECT id, tier, source, granted_by, reason, expires_at, revoked_at, revoked_by FROM entitlement_grants WHERE account_id = '${accountId}' AND tier = 'owner' ORDER BY id`,
  )[0] as Record<string, unknown>[];
}

function audit(accountId: string) {
  return execSql(
    persistTo,
    `SELECT actor, action, details FROM audit_log WHERE account_id = '${accountId}' ORDER BY id`,
  )[0] as {
    actor: string;
    action: string;
    details: string;
  }[];
}

function activatedAt(accountId: string) {
  const row = execSql(persistTo, `SELECT activated_at FROM accounts WHERE id = '${accountId}'`)[0]?.[0] as
    | { activated_at: string | null }
    | undefined;
  return row?.activated_at ?? null;
}

beforeAll(() => {
  persistTo = createMigratedDatabase();
  execSql(
    persistTo,
    "INSERT INTO accounts (id, email, email_verified_at, created_at) VALUES " +
      `('${ACCOUNT}', 'owner-test@example.com', '2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z'), ` +
      `('${OTHER}', 'someone@example.com', '2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z'), ` +
      `('${GENERATED_ACCOUNT}', 'generated@example.com', '2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z')`,
  );
});

afterAll(async () => {
  await removeDatabase(persistTo);
});

// Each case drives several real `wrangler d1 execute` processes: 15-27 s locally with four workers,
// near the default 60 s on the slower gate machine.
describe("grant-owner", { timeout: 180_000 }, () => {
  it("requires a target, a reason and an explicit database", () => {
    expect(tool(GRANT, ["--reason", "x", ...local()]).status).toBe(64);
    expect(tool(GRANT, ["--account", ACCOUNT, ...local()]).status).toBe(64);
    expect(tool(GRANT, ["--account", ACCOUNT, "--reason", "x"]).status).toBe(64);
    expect(tool(GRANT, ["--account", ACCOUNT, "--reason", "x", "--local", "--remote"]).status).toBe(64);
    expect(tool(GRANT, ["--account", ACCOUNT, "--email", "a@example.com", "--reason", "x", ...local()]).status).toBe(
      64,
    );
  });

  it("rejects values that could escape the SQL literal", () => {
    const injected = tool(GRANT, ["--email", "x'); DROP TABLE accounts;--@example.com", "--reason", "x", ...local()]);
    expect(injected.status).toBe(64);
    const reason = tool(GRANT, ["--account", ACCOUNT, "--reason", "line one\nline two", ...local()]);
    expect(reason.status).toBe(64);
    expect(execSql(persistTo, "SELECT COUNT(*) AS n FROM accounts")[0]?.[0]).toEqual({ n: 3 });
  });

  it("accepts the canonical acct_ base64url id used by every authentication path", () => {
    for (const malformed of [
      "_acct_missing_prefix",
      "acct whitespace",
      "acct/path",
      "acct'quote",
      `a${"b".repeat(64)}`,
    ]) {
      const rejected = tool(GRANT, ["--account", malformed, "--reason", "generated id", ...local()]);
      expect(rejected.status, rejected.out).toBe(64);
    }

    const dryRun = tool(GRANT, ["--account", GENERATED_ACCOUNT, "--reason", "generated id", ...local()]);
    expect(dryRun.status, dryRun.out).toBe(2);
    expect(ownerGrants(GENERATED_ACCOUNT)).toEqual([]);

    const grant = tool(GRANT, ["--account", GENERATED_ACCOUNT, "--reason", "generated id", "--confirm", ...local()]);
    expect(grant.status, grant.out).toBe(0);
    expect(ownerGrants(GENERATED_ACCOUNT)).toEqual([
      expect.objectContaining({ tier: "owner", source: "grant", revoked_at: null }),
    ]);

    const revokeDryRun = tool(REVOKE, ["--account", GENERATED_ACCOUNT, "--reason", "generated id", ...local()]);
    expect(revokeDryRun.status, revokeDryRun.out).toBe(2);
    const revoke = tool(REVOKE, ["--account", GENERATED_ACCOUNT, "--reason", "generated id", "--confirm", ...local()]);
    expect(revoke.status, revoke.out).toBe(0);
    expect(ownerGrants(GENERATED_ACCOUNT)[0]).toEqual(expect.objectContaining({ revoked_at: expect.any(String) }));
  });

  it("refuses accounts that have not signed up", () => {
    const result = tool(GRANT, ["--email", "nobody@example.com", "--reason", "x", "--confirm", ...local()]);
    expect(result.status).toBe(64);
    expect(result.out).toMatch(/No KalCode account/);
  });

  it("changes nothing without --confirm", () => {
    const result = tool(GRANT, ["--account", ACCOUNT, "--reason", "Owner of KalCode", ...local()]);
    expect(result.status).toBe(2);
    expect(result.out).toMatch(/Nothing was changed/);
    expect(ownerGrants(ACCOUNT)).toEqual([]);
    expect(audit(ACCOUNT)).toEqual([]);
  });

  it("grants OWNER by verified email (case-insensitive) and writes an audit row", () => {
    const result = tool(GRANT, [
      "--email",
      "Owner-Test@Example.com",
      "--reason",
      "Owner of KalCode",
      "--operator",
      "operator:test",
      "--confirm",
      ...local(),
    ]);
    expect(result.status, result.out).toBe(0);
    expect(result.out).toMatch(/Granted OWNER/);
    expect(ownerGrants(ACCOUNT)).toEqual([
      expect.objectContaining({
        tier: "owner",
        source: "grant",
        granted_by: "operator:test",
        reason: "Owner of KalCode",
        expires_at: null,
        revoked_at: null,
      }),
    ]);
    const rows = audit(ACCOUNT);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: "operator:test", action: "entitlement.granted" });
    expect(JSON.parse(rows[0]?.details ?? "{}")).toMatchObject({
      tier: "owner",
      source: "grant",
      reason: "Owner of KalCode",
    });
    expect(ownerGrants(OTHER)).toEqual([]);
    expect(activatedAt(ACCOUNT)).toEqual(expect.any(String));
    expect(activatedAt(OTHER)).toBeNull();
  });

  it("is idempotent", () => {
    const result = tool(GRANT, ["--account", ACCOUNT, "--reason", "again", "--confirm", ...local()]);
    expect(result.status).toBe(0);
    expect(result.out).toMatch(/already holds an active OWNER grant/);
    expect(ownerGrants(ACCOUNT)).toHaveLength(1);
    expect(audit(ACCOUNT)).toHaveLength(1);
  });

  it("refuses OWNER while a paid subscription is unsettled and allows it after cancellation", () => {
    execSql(
      persistTo,
      `INSERT INTO billing_customers
         (account_id, stripe_customer_id, create_idempotency_key, created_at, updated_at)
       VALUES
         ('${OTHER}', 'cus_owner_guard', 'owner_guard_customer_key',
          '2026-09-25T12:00:00.000Z', '2026-09-25T12:00:00.000Z');
       INSERT INTO billing_subscriptions
         (stripe_subscription_id, account_id, stripe_customer_id, tier, status,
          period_start, period_end, reconciled_at)
       VALUES
         ('sub_owner_guard', '${OTHER}', 'cus_owner_guard', 'pro', 'active',
          '2026-09-25T12:00:00.000Z', '2026-10-25T12:00:00.000Z', '2026-09-25T12:00:00.000Z');`,
    );

    expect(() =>
      execSql(
        persistTo,
        `INSERT INTO entitlement_grants (account_id, tier, source, granted_by, reason, granted_at)
         VALUES ('${OTHER}', 'owner', 'grant', 'operator:test', 'must fail', '2026-09-25T12:00:01.000Z')`,
      ),
    ).toThrow();
    expect(ownerGrants(OTHER)).toEqual([]);
    const blocked = tool(GRANT, ["--account", OTHER, "--reason", "must settle billing", "--confirm", ...local()]);
    expect(blocked.status).toBe(64);
    expect(blocked.out).toMatch(/paid subscription.*settled/i);
    expect(ownerGrants(OTHER)).toEqual([]);
    expect(audit(OTHER)).toEqual([]);

    execSql(persistTo, `UPDATE billing_subscriptions SET status = 'canceled' WHERE account_id = '${OTHER}'`);
    const allowed = tool(GRANT, ["--account", OTHER, "--reason", "billing settled", "--confirm", ...local()]);
    expect(allowed.status, allowed.out).toBe(0);
    expect(ownerGrants(OTHER)).toEqual([expect.objectContaining({ tier: "owner", source: "grant" })]);
  });
});

describe("revoke-owner", () => {
  it("changes nothing without --confirm", () => {
    expect(tool(REVOKE, ["--account", ACCOUNT, "--reason", "test", ...local()]).status).toBe(2);
    expect(ownerGrants(ACCOUNT)[0]).toMatchObject({ revoked_at: null });
  });

  it("revokes, keeps the history and writes an audit row", () => {
    const result = tool(REVOKE, [
      "--account",
      ACCOUNT,
      "--reason",
      "Test revocation",
      "--operator",
      "operator:test",
      "--confirm",
      ...local(),
    ]);
    expect(result.status, result.out).toBe(0);
    const [grant] = ownerGrants(ACCOUNT);
    expect(grant).toMatchObject({ revoked_by: "operator:test" });
    expect(grant?.revoked_at).toEqual(expect.any(String));
    expect(audit(ACCOUNT).map((row) => row.action)).toEqual(["entitlement.granted", "entitlement.revoked"]);
    expect(tool(REVOKE, ["--account", ACCOUNT, "--reason", "again", "--confirm", ...local()]).out).toMatch(
      /no active OWNER grant/,
    );
  });

  it("allows a fresh grant after revocation, storing quotes in the reason literally", () => {
    const reason = "Owner's grant restored'); DELETE FROM audit_log; --";
    expect(tool(GRANT, ["--account", ACCOUNT, "--reason", reason, "--confirm", ...local()]).status).toBe(0);
    const active = ownerGrants(ACCOUNT).filter((grant) => grant.revoked_at === null);
    expect(active).toEqual([expect.objectContaining({ reason })]);
    expect(audit(ACCOUNT)).toHaveLength(3);
  });
});
