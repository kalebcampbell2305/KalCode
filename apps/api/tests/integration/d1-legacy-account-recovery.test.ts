import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { API_DIR, createMigratedDatabase, execSql, REPO_ROOT, removeDatabase, wrangler } from "../support/wrangler";

const roots: string[] = [];
const repair = join(REPO_ROOT, "tooling/admin/sql/20260926-account-schema-recovery.sql");
function apply(root: string, file: string): void {
  wrangler(["d1", "execute", "kalcode-api", "--local", "--persist-to", root, "--file", file]);
}
function legacy(): string {
  const root = mkdtempSync(join(tmpdir(), "kalcode-legacy-schema-recovery-"));
  roots.push(root);
  apply(root, join(API_DIR, "tests/fixtures/legacy-production-account-schema.sql"));
  return root;
}
function schema(root: string): unknown {
  const rows = execSql(
    root,
    "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT IN ('_cf_KV', 'd1_migrations') ORDER BY type, name",
  )[0];
  if (!rows) throw new Error("Schema probe did not return a result set");
  return rows.map((row) => ({
    ...row,
    sql: String(row.sql)
      .replace(/--[^\n]*/g, "")
      .replace(/[\s"]/g, ""),
  }));
}
afterAll(async () => {
  await Promise.all(roots.map(removeDatabase));
});

describe("deployed legacy account schema recovery", () => {
  it("reproduces the numbered migration failure without changing the legacy schema", () => {
    const root = legacy();
    const before = schema(root);
    expect(() => apply(root, join(API_DIR, "migrations/0008_checkout_retry_binding.sql"))).toThrow();
    expect(schema(root)).toEqual(before);
  });

  it("preserves identity, sessions and grants while reaching the canonical schema", () => {
    const root = legacy();
    execSql(
      root,
      `
      INSERT INTO accounts VALUES ('legacy-account', 'legacy@example.invalid', '2026-09-25T12:00:00Z', '2026-09-25T12:00:00Z');
      INSERT INTO account_identities VALUES ('github', '12345', 'legacy-account', '2026-09-25T12:00:00Z');
      INSERT INTO account_sessions VALUES ('${"s".repeat(43)}', 'legacy-account', '2026-09-25T12:00:00Z', '2026-10-25T12:00:00Z', NULL);
      INSERT INTO billing_customers VALUES ('legacy-account', 'cus_legacy_fixture', 'legacy-customer-key-123456', '2026-09-25T12:00:00Z', '2026-09-25T12:00:00Z');
      INSERT INTO billing_subscriptions VALUES ('sub_legacy_fixture', 'legacy-account', 'cus_legacy_fixture', 'pro', 'active', '2026-09-25T12:00:00Z', '2026-10-25T12:00:00Z', '2026-09-25T12:00:00Z');
      INSERT INTO entitlement_grants (id, account_id, tier, source, granted_by, reason, granted_at, expires_at, billing_subscription_id)
        VALUES (42, 'legacy-account', 'pro', 'billing', 'stripe', 'synthetic recovery fixture', '2026-09-25T12:00:00Z', '2026-10-25T12:00:00Z', 'sub_legacy_fixture');
    `,
    );
    const grants = execSql(root, "SELECT * FROM entitlement_grants")[0];
    const audits = execSql(root, "SELECT * FROM audit_log")[0];
    apply(root, repair);
    apply(root, join(API_DIR, "migrations/0008_checkout_retry_binding.sql"));
    apply(root, join(API_DIR, "migrations/0009_social_oidc_browser.sql"));
    apply(root, join(API_DIR, "migrations/0010_owner_metric_snapshots.sql"));
    expect(execSql(root, "SELECT activated_at, deleted_at FROM accounts")[0]).toEqual([
      { activated_at: "2026-09-25T12:00:00Z", deleted_at: null },
    ]);
    expect(execSql(root, "SELECT provider, subject, account_id FROM account_identities")[0]).toEqual([
      { provider: "github", subject: "12345", account_id: "legacy-account" },
    ]);
    expect(execSql(root, "SELECT token_hash, client_kind, rotated_to_hash FROM account_sessions")[0]).toEqual([
      { token_hash: "s".repeat(43), client_kind: "desktop", rotated_to_hash: null },
    ]);
    expect(execSql(root, "SELECT count(*) AS receipts FROM billing_webhook_events")[0]).toEqual([{ receipts: 0 }]);
    expect(execSql(root, "SELECT * FROM entitlement_grants")[0]).toEqual(grants);
    expect(execSql(root, "SELECT * FROM audit_log")[0]).toEqual(audits);
    expect(execSql(root, "PRAGMA foreign_key_check")[0]).toEqual([]);
    expect(execSql(root, "PRAGMA quick_check")[0]).toEqual([{ quick_check: "ok" }]);
    const canonical = createMigratedDatabase();
    roots.push(canonical);
    expect(schema(root)).toEqual(schema(canonical));
    const beforeReplay = schema(root);
    expect(() => apply(root, repair)).toThrow();
    expect(schema(root)).toEqual(beforeReplay);
  });

  it.each([false, true])(
    "refuses legacy webhook receipt recovery (processed=%s) without changing records",
    (processed) => {
      const root = legacy();
      execSql(
        root,
        `INSERT INTO billing_webhook_events VALUES ('evt_legacy', 'customer.subscription.updated', '2026-09-25T12:00:00Z', ${processed ? "'2026-09-25T12:01:00Z'" : "NULL"}, ${processed ? "'applied'" : "NULL"})`,
      );
      const before = schema(root);
      const receipts = execSql(root, "SELECT * FROM billing_webhook_events")[0];
      expect(() => apply(root, repair)).toThrow();
      expect(schema(root)).toEqual(before);
      expect(execSql(root, "SELECT * FROM billing_webhook_events")[0]).toEqual(receipts);
    },
  );

  it("rejects an unknown partial schema atomically", () => {
    const root = legacy();
    execSql(root, "ALTER TABLE accounts ADD COLUMN unexpected_column TEXT");
    const before = schema(root);
    expect(() => apply(root, repair)).toThrow();
    expect(schema(root)).toEqual(before);
  });
});
