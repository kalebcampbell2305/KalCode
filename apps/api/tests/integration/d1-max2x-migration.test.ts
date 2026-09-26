/** Proves migration 0004 preserves existing grants/audit history while adding MAX 2X. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { API_DIR, execSql, removeDatabase, wrangler } from "../support/wrangler";

let persistTo: string;

function apply(file: string): void {
  wrangler([
    "d1",
    "execute",
    "kalcode-api",
    "--local",
    "--persist-to",
    persistTo,
    "--file",
    join(API_DIR, "migrations", file),
  ]);
}

beforeAll(() => {
  persistTo = mkdtempSync(join(tmpdir(), "kalcode-api-max2x-migration-"));
  for (const file of ["0001_entitlements.sql", "0002_kalvoice_requests.sql", "0003_no_replace.sql"]) apply(file);
  execSql(
    persistTo,
    `INSERT INTO accounts (id, email, email_verified_at, created_at)
       VALUES ('acct-upgrade', 'upgrade@example.com', '2026-09-24T12:00:00.000Z', '2026-09-24T12:00:00.000Z');
     INSERT INTO entitlement_grants
       (account_id, tier, source, granted_by, reason, granted_at, expires_at)
       VALUES ('acct-upgrade', 'max', 'billing', 'billing', 'pre-upgrade subscription',
         '2026-09-24T12:00:00.000Z', '2026-10-24T12:00:00.000Z');`,
  );
  apply("0004_max_2x.sql");
});

afterAll(async () => removeDatabase(persistTo));

describe("MAX 2X schema migration", () => {
  it("preserves legacy grants and their audit records exactly once", () => {
    expect(
      execSql(
        persistTo,
        "SELECT tier, source, reason, expires_at FROM entitlement_grants WHERE account_id = 'acct-upgrade' ORDER BY id",
      )[0],
    ).toEqual([
      {
        tier: "max",
        source: "billing",
        reason: "pre-upgrade subscription",
        expires_at: "2026-10-24T12:00:00.000Z",
      },
    ]);
    expect(execSql(persistTo, "SELECT action FROM audit_log WHERE account_id = 'acct-upgrade' ORDER BY id")[0]).toEqual(
      [{ action: "entitlement.granted" }],
    );
  });

  it("accepts MAX 2X and still rejects unknown or billed OWNER tiers", () => {
    execSql(
      persistTo,
      `INSERT INTO entitlement_grants
       (account_id, tier, source, granted_by, reason, granted_at, expires_at)
       VALUES ('acct-upgrade', 'max2x', 'billing', 'billing', 'upgrade',
         '2026-09-25T12:00:00.000Z', '2026-10-25T12:00:00.000Z');`,
    );
    expect(
      execSql(persistTo, "SELECT tier FROM entitlement_grants WHERE account_id = 'acct-upgrade' ORDER BY id")[0],
    ).toEqual([{ tier: "max" }, { tier: "max2x" }]);
    expect(() =>
      execSql(
        persistTo,
        `INSERT INTO entitlement_grants
         (account_id, tier, source, granted_by, reason, granted_at, expires_at)
         VALUES ('acct-upgrade', 'enterprise', 'billing', 'billing', 'bad',
           '2026-09-25T12:00:00.000Z', '2026-10-25T12:00:00.000Z');`,
      ),
    ).toThrow();
    expect(() =>
      execSql(
        persistTo,
        `INSERT INTO entitlement_grants
         (account_id, tier, source, granted_by, reason, granted_at, expires_at)
         VALUES ('acct-upgrade', 'owner', 'billing', 'billing', 'bad',
           '2026-09-25T12:00:00.000Z', '2026-10-25T12:00:00.000Z');`,
      ),
    ).toThrow();
  });
});
