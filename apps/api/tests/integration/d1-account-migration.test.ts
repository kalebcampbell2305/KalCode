/** Proves the account gate preserves access for accounts that predate campaign Z13. */
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
  persistTo = mkdtempSync(join(tmpdir(), "kalcode-api-account-migration-"));
  for (const file of [
    "0001_entitlements.sql",
    "0002_kalvoice_requests.sql",
    "0003_no_replace.sql",
    "0004_max_2x.sql",
  ]) {
    apply(file);
  }
  execSql(
    persistTo,
    `INSERT INTO accounts (id, email, email_verified_at, created_at) VALUES
       ('acct-existing-free', 'existing-free@example.com', '2026-09-20T12:00:00.000Z', '2026-09-20T12:00:00.000Z'),
       ('acct-existing-owner', 'existing-owner@example.com', '2026-09-21T12:00:00.000Z', '2026-09-21T12:00:00.000Z');
     INSERT INTO entitlement_grants (account_id, tier, source, granted_by, reason, granted_at)
       VALUES ('acct-existing-owner', 'owner', 'grant', 'operator:test', 'pre-Z13 owner', '2026-09-21T12:00:00.000Z');`,
  );
  apply("0005_accounts_billing.sql");
});

afterAll(async () => removeDatabase(persistTo));

describe("account and billing schema migration", () => {
  it("keeps existing Free and OWNER accounts activated across the upgrade", () => {
    expect(execSql(persistTo, "SELECT id, activated_at FROM accounts ORDER BY id")[0]).toEqual([
      { id: "acct-existing-free", activated_at: "2026-09-20T12:00:00.000Z" },
      { id: "acct-existing-owner", activated_at: "2026-09-21T12:00:00.000Z" },
    ]);
  });

  it("leaves accounts created after the migration behind the explicit plan-choice gate", () => {
    execSql(
      persistTo,
      `INSERT INTO accounts (id, email, email_verified_at, created_at)
       VALUES ('acct-new', 'new@example.com', '2026-09-25T12:00:00.000Z', '2026-09-25T12:00:00.000Z')`,
    );
    expect(execSql(persistTo, "SELECT activated_at FROM accounts WHERE id = 'acct-new'")[0]).toEqual([
      { activated_at: null },
    ]);
  });
});
