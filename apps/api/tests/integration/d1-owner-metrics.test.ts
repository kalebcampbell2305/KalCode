/**
 * The owner dashboard store against a real, fully migrated local D1: snapshot upserts never move
 * backwards, and the reporting reads are aggregate counts that respect deleted accounts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { d1OwnerMetricsStore, type MetricSnapshot } from "../../worker/lib/owner-metrics-store";
import { openDatabase } from "../support/platform";
import { createMigratedDatabase, removeDatabase } from "../support/wrangler";

let persistTo: string;
let db: D1Database;
let dispose: () => Promise<void>;

beforeAll(async () => {
  persistTo = createMigratedDatabase();
  ({ db, dispose } = await openDatabase(persistTo));
});

afterAll(async () => {
  await dispose?.();
  await removeDatabase(persistTo);
});

const plan = (pro: number) => ({
  pro: { subscribers: pro ? 1 : 0, mrrCents: pro },
  max: { subscribers: 0, mrrCents: 0 },
  max2x: { subscribers: 0, mrrCents: 0 },
});
const snap = (day: string, capturedAt: string, mrrCents: number): MetricSnapshot => ({
  day,
  capturedAt,
  paidSubscribers: mrrCents ? 1 : 0,
  mrrCents,
  byPlan: plan(mrrCents),
});

describe("owner metric snapshots", () => {
  it("upserts one row per day and never overwrites with an older capture", async () => {
    const store = d1OwnerMetricsStore(db);
    await store.saveSnapshot(snap("2026-10-02", "2026-10-02T10:00:00.000Z", 1000));
    await store.saveSnapshot(snap("2026-10-02", "2026-10-02T23:55:00.000Z", 833.3333));
    await store.saveSnapshot(snap("2026-10-02", "2026-10-02T09:00:00.000Z", 5000));
    await store.saveSnapshot(snap("2026-10-03", "2026-10-03T23:55:00.000Z", 0));
    expect(await store.snapshots(null)).toEqual([
      { ...snap("2026-10-02", "2026-10-02T23:55:00.000Z", 833), byPlan: plan(833.3333) },
      snap("2026-10-03", "2026-10-03T23:55:00.000Z", 0),
    ]);
    expect((await store.snapshots("2026-10-03")).map((s) => s.day)).toEqual(["2026-10-03"]);
  });

  it("rejects malformed rows at the database boundary", async () => {
    const store = d1OwnerMetricsStore(db);
    await expect(store.saveSnapshot(snap("not-a-day", "2026-10-02T10:00:00.000Z", 1))).rejects.toThrow();
    await expect(
      store.saveSnapshot({ ...snap("2026-10-04", "2026-10-04T10:00:00.000Z", 1), mrrCents: -5 }),
    ).rejects.toThrow();
  });
});

describe("owner reporting reads", () => {
  it("counts accounts, activation, paying accounts and first desktop sign-ins", async () => {
    const insert = (id: string, created: string, extra = "") =>
      db
        .prepare(
          `INSERT INTO accounts (id, email, email_verified_at, created_at, activated_at${extra ? ", deleted_at" : ""})
           VALUES (?1, ?2, ?3, ?3, ?3${extra ? ", ?3" : ""})`,
        )
        .bind(id, `${id}@example.com`, created)
        .run();
    await insert("acct-a", "2026-09-01T00:00:00.000Z");
    await insert("acct-b", "2026-10-02T08:00:00.000Z");
    await insert("acct-gone", "2026-10-02T09:00:00.000Z", "deleted");
    await db
      .prepare(
        "INSERT INTO billing_customers (account_id, stripe_customer_id, create_idempotency_key, created_at, updated_at) VALUES ('acct-a', 'cus_test00001', 'idem-key-0000000001', ?1, ?1)",
      )
      .bind("2026-09-01T00:00:00.000Z")
      .run();
    await db
      .prepare(
        "INSERT INTO entitlement_grants (account_id, tier, source, granted_by, reason, granted_at, expires_at, billing_subscription_id) VALUES ('acct-a', 'pro', 'billing', 'billing', 'test', ?1, ?2, 'sub_test0001')",
      )
      .bind("2026-09-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z")
      .run();
    const session = (hash: string, account: string, created: string) =>
      db
        .prepare(
          "INSERT INTO account_sessions (token_hash, account_id, created_at, expires_at, client_kind) VALUES (?1, ?2, ?3, '2027-01-01T00:00:00.000Z', 'desktop')",
        )
        .bind(hash.padEnd(43, "x"), account, created)
        .run();
    await session("a1", "acct-a", "2026-09-02T00:00:00.000Z");
    await session("a2", "acct-a", "2026-10-02T10:00:00.000Z");
    await session("b1", "acct-b", "2026-10-02T11:00:00.000Z");

    const store = d1OwnerMetricsStore(db);
    expect(await store.accountStats("2026-10-02T00:00:00.000Z", "2026-09-25T00:00:00.000Z")).toEqual({
      accounts: 2,
      activated: 2,
      newSince: 1,
      everPaid: 1,
      firstDesktopToday: 1,
      firstDesktopSince: 1,
    });
    expect((await store.accountStats("2026-10-02T00:00:00.000Z", null)).firstDesktopSince).toBe(2);
    expect(await store.billingGrants()).toEqual([
      { subscription: "sub_test0001", tier: "pro", grantedAt: "2026-09-01T00:00:00.000Z" },
    ]);
  });
});
