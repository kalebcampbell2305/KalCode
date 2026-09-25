/**
 * Regression tests for the REPLACE delete path (security review, 0.1.1; migration 0003).
 *
 * `REPLACE` / `INSERT OR REPLACE` resolve a key conflict by deleting the existing row, and D1 runs
 * with `recursive_triggers` off, so the BEFORE DELETE triggers of 0001/0002 never fire for those
 * deletes. Before 0003 a REPLACE could re-activate a revoked OWNER grant and overwrite audit and
 * usage rows. Runs against a real local D1 migrated by wrangler (the production migrations).
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
const REVOKED_AT = "2026-09-25T00:00:00.000Z";
let seq = 0;

async function account(): Promise<string> {
  const id = `acct-replace-${++seq}`;
  await db
    .prepare("INSERT INTO accounts (id, email, email_verified_at, created_at) VALUES (?1, ?2, ?3, ?3)")
    .bind(id, `replace${seq}@example.com`, T)
    .run();
  return id;
}

/** The operator tool's grant, then its revocation. Returns the grant id. */
async function grantAndRevokeOwner(accountId: string): Promise<number> {
  await db
    .prepare(
      "INSERT INTO entitlement_grants (account_id, tier, source, granted_by, reason, granted_at) VALUES (?1, 'owner', 'grant', 'op', 'KalCode owner', ?2)",
    )
    .bind(accountId, T)
    .run();
  const row = await db
    .prepare("SELECT id FROM entitlement_grants WHERE account_id = ?1 AND tier = 'owner'")
    .bind(accountId)
    .first<{ id: number }>();
  if (!row) throw new Error("grant not stored");
  await db
    .prepare(
      "UPDATE entitlement_grants SET revoked_at = ?2, revoked_by = 'op', revoke_reason = 'compromised' WHERE id = ?1",
    )
    .bind(row.id, REVOKED_AT)
    .run();
  return row.id;
}

async function grants(accountId: string) {
  const { results } = await db
    .prepare("SELECT id, tier, reason, revoked_at FROM entitlement_grants WHERE account_id = ?1 ORDER BY id")
    .bind(accountId)
    .all();
  return results;
}

async function audit(accountId: string) {
  const { results } = await db
    .prepare("SELECT id, actor, action FROM audit_log WHERE account_id = ?1 ORDER BY id")
    .bind(accountId)
    .all<{ id: number; actor: string; action: string }>();
  return results;
}

beforeAll(async () => {
  persistTo = createMigratedDatabase();
  ({ db, dispose } = await openDatabase(persistTo));
});

afterAll(async () => {
  await dispose?.();
  await removeDatabase(persistTo);
});

describe("entitlement_grants cannot be replaced", () => {
  for (const verb of ["REPLACE INTO", "INSERT OR REPLACE INTO"]) {
    it(`refuses re-activating a revoked OWNER grant with ${verb} (review PoC)`, async () => {
      const id = await account();
      const grantId = await grantAndRevokeOwner(id);
      const before = await grants(id);
      const auditBefore = await audit(id);
      await expect(
        db
          .prepare(
            `${verb} entitlement_grants (id, account_id, tier, source, granted_by, reason, granted_at) VALUES (?1, ?2, 'owner', 'grant', 'op', 'KalCode owner', ?3)`,
          )
          .bind(grantId, id, T)
          .run(),
      ).rejects.toThrow(/cannot be replaced/);
      expect(await grants(id)).toEqual(before);
      expect(before[0]).toMatchObject({ revoked_at: REVOKED_AT });
      expect(await audit(id)).toEqual(auditBefore);
      expect((await resolveEntitlement(d1Store(db), id, new Date(T))).tier).toBe("free");
    });
  }

  it("refuses swapping the active OWNER grant through the one-active-owner index", async () => {
    const id = await account();
    await db
      .prepare(
        "INSERT INTO entitlement_grants (account_id, tier, source, granted_by, reason, granted_at) VALUES (?1, 'owner', 'grant', 'op', 'original', ?2)",
      )
      .bind(id, T)
      .run();
    const before = await grants(id);
    await expect(
      db
        .prepare(
          "INSERT OR REPLACE INTO entitlement_grants (account_id, tier, source, granted_by, reason, granted_at) VALUES (?1, 'owner', 'grant', 'op', 'swapped', ?2)",
        )
        .bind(id, T)
        .run(),
    ).rejects.toThrow(/at most one active OWNER grant/);
    expect(await grants(id)).toEqual(before);
  });

  it("refuses an upsert that rewrites a grant", async () => {
    const id = await account();
    const grantId = await grantAndRevokeOwner(id);
    await expect(
      db
        .prepare(
          "INSERT INTO entitlement_grants (id, account_id, tier, source, granted_by, reason, granted_at) VALUES (?1, ?2, 'owner', 'grant', 'op', 'x', ?3) ON CONFLICT (id) DO UPDATE SET revoked_at = NULL, revoked_by = NULL, revoke_reason = NULL",
        )
        .bind(grantId, id, T)
        .run(),
    ).rejects.toThrow(/cannot be replaced|immutable/);
    expect((await grants(id))[0]).toMatchObject({ revoked_at: REVOKED_AT });
  });

  it("still allows normal grants, a new OWNER grant after revocation, and writes their audit rows", async () => {
    const id = await account();
    await grantAndRevokeOwner(id);
    await db
      .prepare(
        "INSERT INTO entitlement_grants (account_id, tier, source, granted_by, reason, granted_at) VALUES (?1, 'owner', 'grant', 'op', 'again', ?2)",
      )
      .bind(id, "2026-09-26T00:00:00.000Z")
      .run();
    await db
      .prepare(
        "INSERT INTO entitlement_grants (account_id, tier, source, granted_by, reason, granted_at, expires_at) VALUES (?1, 'pro', 'billing', 'billing', 'subscription', ?2, ?3)",
      )
      .bind(id, T, "2026-10-24T12:00:00.000Z")
      .run();
    expect((await audit(id)).map((row) => row.action)).toEqual([
      "entitlement.granted",
      "entitlement.revoked",
      "entitlement.granted",
      "entitlement.granted",
    ]);
    expect((await resolveEntitlement(d1Store(db), id, new Date(T))).tier).toBe("owner");
  });
});

describe("audit_log cannot be overwritten", () => {
  for (const verb of ["REPLACE INTO", "INSERT OR REPLACE INTO"]) {
    it(`refuses overwriting the revocation record with ${verb} (review PoC)`, async () => {
      const id = await account();
      await grantAndRevokeOwner(id);
      const before = await audit(id);
      const revocation = before.find((row) => row.action === "entitlement.revoked");
      if (!revocation) throw new Error("revocation not audited");
      await expect(
        db
          .prepare(
            `${verb} audit_log (id, occurred_at, actor, action, account_id, details) VALUES (?1, ?2, 'op', 'note', ?3, '{}')`,
          )
          .bind(revocation.id, T, id)
          .run(),
      ).rejects.toThrow(/append-only/);
      expect(await audit(id)).toEqual(before);
    });
  }
});

describe("kalvoice_requests cannot be overwritten", () => {
  async function recorded(accountId: string) {
    const store = d1Store(db);
    expect(
      await store.recordRequest({
        accountId,
        clientRequestId: "req-00000001",
        recordedAt: T,
        source: "online",
        allowance: 3,
        periodStart: "2026-09-01T00:00:00.000Z",
        periodEnd: "2026-10-01T00:00:00.000Z",
      }),
    ).toEqual({ outcome: "recorded", used: 1 });
    const { results } = await db
      .prepare("SELECT id, client_request_id, recorded_at, source FROM kalvoice_requests WHERE account_id = ?1")
      .bind(accountId)
      .all<{ id: number }>();
    return results;
  }

  it("refuses REPLACE by row id", async () => {
    const id = await account();
    const before = await recorded(id);
    await expect(
      db
        .prepare(
          "REPLACE INTO kalvoice_requests (id, account_id, client_request_id, recorded_at, source) VALUES (?1, ?2, 'req-99999999', '2000-01-01T00:00:00.000Z', 'online')",
        )
        .bind(before[0]?.id, id)
        .run(),
    ).rejects.toThrow(/append-only/);
    const { results } = await db.prepare("SELECT * FROM kalvoice_requests WHERE account_id = ?1").bind(id).all();
    expect(results.map((r) => r.recorded_at)).toEqual([T]);
  });

  it("turns REPLACE on (account, client request id) into a no-op that keeps the counted row", async () => {
    const id = await account();
    const before = await recorded(id);
    const result = await db
      .prepare(
        "INSERT OR REPLACE INTO kalvoice_requests (account_id, client_request_id, recorded_at, source) VALUES (?1, 'req-00000001', '2000-01-01T00:00:00.000Z', 'offline_replay')",
      )
      .bind(id)
      .run();
    expect(result.meta.changes).toBe(0);
    const { results } = await db
      .prepare("SELECT id, client_request_id, recorded_at, source FROM kalvoice_requests WHERE account_id = ?1")
      .bind(id)
      .all();
    expect(results).toEqual(before);
  });

  it("keeps the worker's idempotent insert working", async () => {
    const id = await account();
    await recorded(id);
    const store = d1Store(db);
    expect(
      await store.recordRequest({
        accountId: id,
        clientRequestId: "req-00000001",
        recordedAt: T,
        source: "offline_replay",
        allowance: 3,
        periodStart: "2026-09-01T00:00:00.000Z",
        periodEnd: "2026-10-01T00:00:00.000Z",
      }),
    ).toEqual({ outcome: "duplicate", used: 1 });
  });
});
