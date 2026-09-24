/**
 * The KalVoice Request ledger against a real local D1: idempotency, the atomic allowance check,
 * offline replays and append-only storage.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { d1Store, type RecordRequestInput } from "../../worker/lib/store";
import { openDatabase } from "../support/platform";
import { createMigratedDatabase, removeDatabase } from "../support/wrangler";

let persistTo: string;
let db: D1Database;
let dispose: () => Promise<void>;
let seq = 0;

const PERIOD = { periodStart: "2026-09-01T00:00:00.000Z", periodEnd: "2026-10-01T00:00:00.000Z" };

async function account(): Promise<string> {
  const id = `acct-usage-${++seq}`;
  await db
    .prepare("INSERT INTO accounts (id, email, email_verified_at, created_at) VALUES (?1, ?2, ?3, ?3)")
    .bind(id, `usage${seq}@example.com`, "2026-01-01T00:00:00.000Z")
    .run();
  return id;
}

const input = (accountId: string, n: number, overrides: Partial<RecordRequestInput> = {}): RecordRequestInput => ({
  accountId,
  clientRequestId: `req-${String(n).padStart(8, "0")}`,
  recordedAt: `2026-09-${String(10 + (n % 15)).padStart(2, "0")}T12:00:00.000Z`,
  source: "online",
  allowance: 3,
  ...PERIOD,
  ...overrides,
});

beforeAll(async () => {
  persistTo = createMigratedDatabase();
  ({ db, dispose } = await openDatabase(persistTo));
});

afterAll(async () => {
  await dispose?.();
  await removeDatabase(persistTo);
});

describe("kalvoice_requests ledger", () => {
  it("counts each client request id at most once", async () => {
    const store = d1Store(db);
    const id = await account();
    expect(await store.recordRequest(input(id, 1))).toEqual({ outcome: "recorded", used: 1 });
    expect(await store.recordRequest(input(id, 1))).toEqual({ outcome: "duplicate", used: 1 });
    expect(await store.recordRequest(input(id, 1, { source: "offline_replay" }))).toEqual({
      outcome: "duplicate",
      used: 1,
    });
    expect(await store.countRequests(id, PERIOD.periodStart, PERIOD.periodEnd)).toBe(1);
  });

  it("denies online requests beyond the allowance and records nothing for them", async () => {
    const store = d1Store(db);
    const id = await account();
    for (const n of [1, 2, 3]) expect((await store.recordRequest(input(id, n))).outcome).toBe("recorded");
    expect(await store.recordRequest(input(id, 4))).toEqual({ outcome: "denied", used: 3 });
    expect(await store.countRequests(id, PERIOD.periodStart, PERIOD.periodEnd)).toBe(3);
    // The same id is allowed once the next cycle starts.
    const next = { periodStart: "2026-10-01T00:00:00.000Z", periodEnd: "2026-11-01T00:00:00.000Z" };
    expect(await store.recordRequest(input(id, 4, { ...next, recordedAt: "2026-10-02T00:00:00.000Z" }))).toEqual({
      outcome: "recorded",
      used: 1,
    });
  });

  it("never denies an unlimited allowance (OWNER)", async () => {
    const store = d1Store(db);
    const id = await account();
    for (let n = 1; n <= 25; n++) {
      expect((await store.recordRequest(input(id, n, { allowance: null }))).outcome).toBe("recorded");
    }
    expect(await store.countRequests(id, PERIOD.periodStart, PERIOD.periodEnd)).toBe(25);
  });

  it("records offline replays even beyond the allowance, flagged", async () => {
    const store = d1Store(db);
    const id = await account();
    for (const n of [1, 2, 3]) await store.recordRequest(input(id, n));
    expect(await store.recordRequest(input(id, 9, { source: "offline_replay" }))).toEqual({
      outcome: "recorded",
      used: 4,
    });
    const { results } = await db
      .prepare("SELECT source, over_allowance FROM kalvoice_requests WHERE account_id = ?1 ORDER BY id")
      .bind(id)
      .all();
    expect(results.at(-1)).toEqual({ source: "offline_replay", over_allowance: 1 });
    expect(results.slice(0, 3).every((row) => row.over_allowance === 0)).toBe(true);
  });

  it("cannot be raced past the allowance: concurrent requests take at most the remaining units", async () => {
    const store = d1Store(db);
    const id = await account();
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, n) => store.recordRequest(input(id, 100 + n, { allowance: 5 }))),
    );
    expect(results.filter((r) => r.outcome === "recorded")).toHaveLength(5);
    expect(results.filter((r) => r.outcome === "denied")).toHaveLength(7);
    expect(await store.countRequests(id, PERIOD.periodStart, PERIOD.periodEnd)).toBe(5);
  });

  it("only counts requests inside the cycle", async () => {
    const store = d1Store(db);
    const id = await account();
    await store.recordRequest(input(id, 1, { recordedAt: "2026-08-31T23:59:59.999Z", allowance: null }));
    await store.recordRequest(input(id, 2, { recordedAt: "2026-09-01T00:00:00.000Z", allowance: null }));
    await store.recordRequest(input(id, 3, { recordedAt: "2026-10-01T00:00:00.000Z", allowance: null }));
    expect(await store.countRequests(id, PERIOD.periodStart, PERIOD.periodEnd)).toBe(1);
  });

  it("is append-only, stores no text, and rejects malformed ids", async () => {
    const store = d1Store(db);
    const id = await account();
    await store.recordRequest(input(id, 1));
    await expect(db.prepare("UPDATE kalvoice_requests SET source = 'online'").run()).rejects.toThrow(/append-only/);
    await expect(db.prepare("DELETE FROM kalvoice_requests").run()).rejects.toThrow(/append-only/);
    await expect(store.recordRequest(input(id, 2, { clientRequestId: "open four codex threads" }))).rejects.toThrow(
      /CHECK constraint failed/,
    );
    await expect(store.recordRequest(input("acct-missing", 3))).rejects.toThrow(/FOREIGN KEY/);
    const { results } = await db.prepare("PRAGMA table_info(kalvoice_requests)").all<{ name: string }>();
    expect(results.map((c) => c.name)).toEqual([
      "id",
      "account_id",
      "client_request_id",
      "recorded_at",
      "source",
      "over_allowance",
    ]);
  });
});
