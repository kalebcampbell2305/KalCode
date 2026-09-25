/**
 * The entitlement invariants enforced by the database itself, against a real local D1 created
 * by `wrangler d1 migrations apply --local` (the same migrations production will run).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveEntitlement } from "../../worker/lib/entitlement";
import { d1Store } from "../../worker/lib/store";
import { openDatabase } from "../support/platform";
import { createMigratedDatabase, removeDatabase } from "../support/wrangler";

let persistTo: string;
let db: D1Database;
let dispose: () => Promise<void>;

const T = "2026-09-24T12:00:00.000Z";
let seq = 0;

async function account(email = `user${++seq}@example.com`): Promise<string> {
  const id = `acct-${++seq}`;
  await db
    .prepare("INSERT INTO accounts (id, email, email_verified_at, created_at) VALUES (?1, ?2, ?3, ?3)")
    .bind(id, email, T)
    .run();
  return id;
}

interface GrantInput {
  tier: string;
  source: string;
  expiresAt?: string | null;
  grantedAt?: string;
}

function insertGrant(accountId: string, grant: GrantInput) {
  const billingSubscriptionId = grant.source === "billing" ? `sub_test_${++seq}` : null;
  return db
    .prepare(
      "INSERT INTO entitlement_grants (account_id, tier, source, granted_by, reason, granted_at, expires_at, billing_subscription_id) VALUES (?1, ?2, ?3, 'test', 'test', ?4, ?5, ?6)",
    )
    .bind(accountId, grant.tier, grant.source, grant.grantedAt ?? T, grant.expiresAt ?? null, billingSubscriptionId)
    .run();
}

function revoke(accountId: string, tier: string, at = "2026-09-25T00:00:00.000Z") {
  return db
    .prepare(
      "UPDATE entitlement_grants SET revoked_at = ?3, revoked_by = 'test', revoke_reason = 'test' WHERE account_id = ?1 AND tier = ?2 AND revoked_at IS NULL",
    )
    .bind(accountId, tier, at)
    .run();
}

async function auditFor(accountId: string) {
  const { results } = await db
    .prepare("SELECT actor, action, details FROM audit_log WHERE account_id = ?1 ORDER BY id")
    .bind(accountId)
    .all<{ actor: string; action: string; details: string }>();
  return results.map((row) => ({ ...row, details: JSON.parse(row.details) as Record<string, unknown> }));
}

beforeAll(async () => {
  persistTo = createMigratedDatabase();
  ({ db, dispose } = await openDatabase(persistTo));
});

afterAll(async () => {
  await dispose?.();
  await removeDatabase(persistTo);
});

describe("OWNER invariants (database constraints)", () => {
  it("refuses an OWNER grant from billing — no billing path can ever create OWNER", async () => {
    const id = await account();
    await expect(
      insertGrant(id, { tier: "owner", source: "billing", expiresAt: "2026-10-24T12:00:00.000Z" }),
    ).rejects.toThrow(/owner_requires_operator_grant/);
    await expect(insertGrant(id, { tier: "owner", source: "billing" })).rejects.toThrow(/CHECK constraint failed/);
    expect(await auditFor(id)).toEqual([]);
  });

  it("refuses turning an existing billing grant into OWNER", async () => {
    const id = await account();
    await insertGrant(id, { tier: "max", source: "billing", expiresAt: "2026-10-24T12:00:00.000Z" });
    await expect(
      db.prepare("UPDATE entitlement_grants SET tier = 'owner' WHERE account_id = ?1").bind(id).run(),
    ).rejects.toThrow(/CHECK constraint failed|immutable/);
    await expect(
      db
        .prepare(
          "UPDATE entitlement_grants SET tier = 'owner', expires_at = NULL, source = 'grant' WHERE account_id = ?1",
        )
        .bind(id)
        .run(),
    ).rejects.toThrow(/immutable/);
  });

  it("refuses an expiring OWNER grant", async () => {
    const id = await account();
    await expect(
      insertGrant(id, { tier: "owner", source: "grant", expiresAt: "2030-01-01T00:00:00.000Z" }),
    ).rejects.toThrow(/owner_never_expires/);
    await insertGrant(id, { tier: "owner", source: "grant" });
    await expect(
      db
        .prepare("UPDATE entitlement_grants SET expires_at = '2030-01-01T00:00:00.000Z' WHERE account_id = ?1")
        .bind(id)
        .run(),
    ).rejects.toThrow(/owner_never_expires|immutable/);
  });

  it("allows at most one active OWNER grant per account", async () => {
    const id = await account();
    await insertGrant(id, { tier: "owner", source: "grant" });
    await expect(insertGrant(id, { tier: "owner", source: "grant" })).rejects.toThrow(
      /UNIQUE constraint failed|at most one active OWNER grant/,
    );
    await revoke(id, "owner");
    await insertGrant(id, { tier: "owner", source: "grant", grantedAt: "2026-09-26T00:00:00.000Z" });
  });

  it("refuses unknown tiers, a stored Free tier, and grants for accounts that do not exist", async () => {
    const id = await account();
    await expect(insertGrant(id, { tier: "enterprise", source: "grant" })).rejects.toThrow(/CHECK constraint failed/);
    await expect(insertGrant(id, { tier: "free", source: "grant" })).rejects.toThrow(/CHECK constraint failed/);
    await expect(insertGrant("acct-missing", { tier: "pro", source: "grant" })).rejects.toThrow(/FOREIGN KEY/);
    await expect(insertGrant(id, { tier: "pro", source: "billing" })).rejects.toThrow(/billing_has_period_end/);
  });

  it("stores MAX 2X as a billable tier while keeping OWNER non-billable", async () => {
    const id = await account();
    await insertGrant(id, { tier: "max2x", source: "billing", expiresAt: "2026-10-24T12:00:00.000Z" });
    expect((await resolveEntitlement(d1Store(db), id, new Date(T))).tier).toBe("max2x");
    expect(await auditFor(id)).toEqual([
      expect.objectContaining({
        action: "entitlement.granted",
        details: expect.objectContaining({ tier: "max2x", source: "billing" }),
      }),
    ]);
  });

  it("requires every new billing grant to be subscription-owned", async () => {
    const id = await account();
    await expect(
      db
        .prepare(
          "INSERT INTO entitlement_grants (account_id, tier, source, granted_by, reason, granted_at, expires_at) VALUES (?1, 'pro', 'billing', 'test', 'test', ?2, ?3)",
        )
        .bind(id, T, "2026-10-24T12:00:00.000Z")
        .run(),
    ).rejects.toThrow(/require exactly one billing subscription/);
    await expect(
      db
        .prepare(
          "INSERT INTO entitlement_grants (account_id, tier, source, granted_by, reason, granted_at, billing_subscription_id) VALUES (?1, 'pro', 'grant', 'test', 'test', ?2, 'sub_not_billing')",
        )
        .bind(id, T)
        .run(),
    ).rejects.toThrow(/require exactly one billing subscription/);
  });

  it("keeps grants immutable, revocation final, and never deletes them", async () => {
    const id = await account();
    await insertGrant(id, { tier: "owner", source: "grant" });
    await expect(
      db.prepare("UPDATE entitlement_grants SET reason = 'edited' WHERE account_id = ?1").bind(id).run(),
    ).rejects.toThrow(/immutable/);
    await expect(db.prepare("DELETE FROM entitlement_grants WHERE account_id = ?1").bind(id).run()).rejects.toThrow(
      /cannot be deleted/,
    );
    await expect(
      db
        .prepare("UPDATE entitlement_grants SET revoked_at = ?2 WHERE account_id = ?1")
        .bind(id, "2026-09-25T00:00:00.000Z")
        .run(),
    ).rejects.toThrow(/revocation_is_complete/);
    await revoke(id, "owner");
    await expect(
      db
        .prepare(
          "UPDATE entitlement_grants SET revoked_at = NULL, revoked_by = NULL, revoke_reason = NULL WHERE account_id = ?1",
        )
        .bind(id)
        .run(),
    ).rejects.toThrow(/immutable/);
  });

  it("stores verified emails case-insensitively unique", async () => {
    await account("Case@Example.com");
    await expect(account("case@example.COM")).rejects.toThrow(/UNIQUE constraint failed: accounts.email/);
  });
});

describe("audit log", () => {
  it("records every grant, revocation and billing-period change in the same statement", async () => {
    const id = await account();
    await insertGrant(id, { tier: "owner", source: "grant" });
    await revoke(id, "owner");
    await insertGrant(id, { tier: "pro", source: "billing", expiresAt: "2026-10-24T12:00:00.000Z" });
    await db
      .prepare(
        "UPDATE entitlement_grants SET expires_at = '2026-11-24T12:00:00.000Z' WHERE account_id = ?1 AND tier = 'pro'",
      )
      .bind(id)
      .run();
    const audit = await auditFor(id);
    expect(audit.map((row) => row.action)).toEqual([
      "entitlement.granted",
      "entitlement.revoked",
      "entitlement.granted",
      "entitlement.period_changed",
    ]);
    expect(audit[0]?.details).toMatchObject({ tier: "owner", source: "grant", expires_at: null });
    expect(audit[3]?.details).toMatchObject({ from: "2026-10-24T12:00:00.000Z", to: "2026-11-24T12:00:00.000Z" });
  });

  it("is append-only", async () => {
    const id = await account();
    await insertGrant(id, { tier: "owner", source: "grant" });
    await expect(db.prepare("UPDATE audit_log SET actor = 'x' WHERE account_id = ?1").bind(id).run()).rejects.toThrow(
      /append-only/,
    );
    await expect(db.prepare("DELETE FROM audit_log WHERE account_id = ?1").bind(id).run()).rejects.toThrow(
      /append-only/,
    );
  });
});

describe("resolveEntitlement against D1", () => {
  const at = (iso: string) => new Date(iso);

  it("resolves owner > billing > free, and OWNER never expires", async () => {
    const store = d1Store(db);
    const id = await account();
    expect((await resolveEntitlement(store, id, at(T))).tier).toBe("free");
    await insertGrant(id, { tier: "pro", source: "billing", expiresAt: "2026-10-24T12:00:00.000Z" });
    expect(await resolveEntitlement(store, id, at(T))).toEqual({
      tier: "pro",
      grantExpiresAt: "2026-10-24T12:00:00.000Z",
      billingAnchor: T,
    });
    await insertGrant(id, { tier: "max", source: "billing", expiresAt: "2026-10-24T12:00:00.000Z" });
    expect((await resolveEntitlement(store, id, at(T))).tier).toBe("max");
    await insertGrant(id, { tier: "max2x", source: "billing", expiresAt: "2026-10-24T12:00:00.000Z" });
    expect((await resolveEntitlement(store, id, at(T))).tier).toBe("max2x");
    await insertGrant(id, { tier: "owner", source: "grant" });
    expect(await resolveEntitlement(store, id, at(T))).toEqual({
      tier: "owner",
      grantExpiresAt: null,
      billingAnchor: null,
    });
    // Decades later, billing has lapsed; OWNER has not.
    expect(await resolveEntitlement(store, id, at("2099-12-31T23:59:59.000Z"))).toEqual({
      tier: "owner",
      grantExpiresAt: null,
      billingAnchor: null,
    });
  });

  it("ignores revoked and expired grants", async () => {
    const store = d1Store(db);
    const id = await account();
    await insertGrant(id, { tier: "owner", source: "grant" });
    await insertGrant(id, { tier: "max", source: "billing", expiresAt: "2026-10-24T12:00:00.000Z" });
    await revoke(id, "owner");
    expect((await resolveEntitlement(store, id, at(T))).tier).toBe("max");
    expect((await resolveEntitlement(store, id, at("2026-10-24T12:00:00.000Z"))).tier).toBe("free");
    await revoke(id, "max");
    expect((await resolveEntitlement(store, id, at(T))).tier).toBe("free");
  });

  it("knows which accounts exist and when they were created", async () => {
    const store = d1Store(db);
    const id = await account();
    expect(await store.account(id)).toEqual({ id, createdAt: T });
    expect(await store.account("acct-missing")).toBeNull();
  });
});
