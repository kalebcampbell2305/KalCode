import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getPlatformProxy, unstable_splitSqlQuery } from "wrangler";
import { type AccountMailPurpose, d1AccountMailDispatchStore } from "../../worker/lib/account-mail-service";
import { d1Store } from "../../worker/lib/store";

type Proxy = Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>>;
let proxy: Proxy;
let db: D1Database;
let legacyAfterMigration: Record<string, unknown> | null;
let legacyMarketingAfterMigration = 0;
const NOW = new Date("2026-09-25T12:00:00.000Z");

function migrationStatements(file: string): string[] {
  const sql = readFileSync(fileURLToPath(new URL(`../../migrations/${file}`, import.meta.url)), "utf8");
  // Use the deployment parser: trigger bodies contain semicolons that are not
  // statement boundaries. A naive split never exercises the actual migration.
  return unstable_splitSqlQuery(sql);
}

async function migrate(file: string): Promise<void> {
  for (const statement of migrationStatements(file)) await db.prepare(statement).run();
}

async function budget(): Promise<number> {
  return (
    (await db.prepare("SELECT sent FROM email_send_budget WHERE day = '2026-09-25'").first<{ sent: number }>())?.sent ??
    0
  );
}

function accountClaim(index: number, purpose: AccountMailPurpose = "signin", overrides: Record<string, unknown> = {}) {
  return {
    proofHash: index.toString(16).padStart(64, "0"),
    purpose,
    networkHash: `n${index.toString(36)}`.padEnd(43, "n"),
    recipientHash: `r${index.toString(36)}`.padEnd(43, "r"),
    now: NOW,
    dailyLimit: 90,
    ...overrides,
  };
}

beforeAll(async () => {
  proxy = await getPlatformProxy<{ DB: D1Database }>({
    configPath: fileURLToPath(new URL("./fixtures/wrangler.d1.jsonc", import.meta.url)),
    persist: false,
  });
  db = proxy.env.DB;
  await migrate("0001_early_access.sql");
  await migrate("0002_double_opt_in.sql");
  await migrate("0004_account_mail_dispatch.sql");
  await db
    .prepare(
      `INSERT INTO account_email_dispatches
       (proof_hash, purpose, claimed_day, budget_limit, state, created_at, completed_at)
       VALUES (?1, 'signin', '2026-09-24', 90, 'sent', ?2, ?2)`,
    )
    .bind("f".repeat(64), "2026-09-24T12:00:00.000Z")
    .run();
  await db.prepare("UPDATE email_send_budget SET sent = 4 WHERE day = '2026-09-24'").run();
  await migrate("0005_fair_email_admission.sql");
  legacyAfterMigration = await db
    .prepare(
      `SELECT purpose, state, network_hash, recipient_hash, non_deletion_limit, network_limit, recipient_limit
       FROM account_email_dispatches WHERE proof_hash = ?1`,
    )
    .bind("f".repeat(64))
    .first<Record<string, unknown>>();
  legacyMarketingAfterMigration =
    (
      await db
        .prepare("SELECT COUNT(*) AS count FROM marketing_email_dispatches WHERE claimed_day = '2026-09-24'")
        .first<{ count: number }>()
    )?.count ?? 0;
}, 60_000);

afterAll(async () => proxy?.dispose());

beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM marketing_email_dispatches"),
    db.prepare("DELETE FROM account_email_dispatches"),
    db.prepare("DELETE FROM email_send_budget"),
  ]);
});

describe("account mail D1 dispatch claims", () => {
  it("migration 0005 preserves prior dispatch evidence with safe defaults", () => {
    expect(legacyAfterMigration).toEqual({
      purpose: "signin",
      state: "sent",
      network_hash: null,
      recipient_hash: null,
      non_deletion_limit: 80,
      network_limit: 20,
      recipient_limit: 5,
    });
    expect(legacyMarketingAfterMigration).toBe(3);
  });

  it("claims each proof once under concurrency and charges the shared budget once", async () => {
    const store = d1AccountMailDispatchStore(db);
    const [a, b] = await Promise.all([store.claim(accountClaim(1)), store.claim(accountClaim(1))]);
    expect([a, b]).toContainEqual({ kind: "claimed" });
    expect([a, b]).toContainEqual({ kind: "existing", state: "claimed" });
    expect(await budget()).toBe(1);
  });

  it("enforces the daily budget atomically across distinct proofs", async () => {
    const store = d1AccountMailDispatchStore(db);
    const results = await Promise.all([
      store.claim(accountClaim(1, "delete", { dailyLimit: 1 })),
      store.claim(accountClaim(2, "delete", { dailyLimit: 1 })),
    ]);
    expect(results.filter((result) => result.kind === "claimed")).toHaveLength(1);
    expect(results.filter((result) => result.kind === "budget_exhausted")).toHaveLength(1);
    expect(await budget()).toBe(1);
  });

  it("refunds only an explicit rejection and never an ambiguous outcome", async () => {
    const store = d1AccountMailDispatchStore(db);
    const first = accountClaim(1, "delete", { dailyLimit: 1 });
    expect(await store.claim(first)).toEqual({ kind: "claimed" });
    await store.finalize(first.proofHash, "rejected", NOW);
    expect(await budget()).toBe(0);
    const second = accountClaim(2, "delete", { dailyLimit: 1 });
    expect(await store.claim(second)).toEqual({ kind: "claimed" });
    await store.finalize(second.proofHash, "ambiguous", NOW);
    expect(await budget()).toBe(1);
    expect(await store.claim(accountClaim(3, "delete", { dailyLimit: 1 }))).toEqual({ kind: "budget_exhausted" });
  });

  it("caps marketing at 60, all non-deletion mail at 80, and admits ten deletion emails up to the hard 90 ceiling", async () => {
    const marketing = d1Store(db);
    const account = d1AccountMailDispatchStore(db);
    const marketingClaims = [];
    for (let index = 0; index < 61; index += 1) marketingClaims.push(await marketing.claimMarketingSend(NOW, 90));
    expect(marketingClaims.filter(Boolean)).toHaveLength(60);

    for (let index = 1; index <= 20; index += 1) {
      expect(await account.claim(accountClaim(index))).toEqual({ kind: "claimed" });
    }
    expect(await account.claim(accountClaim(21))).toEqual({ kind: "budget_exhausted" });

    for (let index = 81; index <= 90; index += 1) {
      expect(await account.claim(accountClaim(index, "delete"))).toEqual({ kind: "claimed" });
    }
    expect(await account.claim(accountClaim(91, "delete"))).toEqual({ kind: "budget_exhausted" });
    expect(await budget()).toBe(90);
  }, 30_000);

  it("enforces daily account network and recipient ceilings across distinct proofs", async () => {
    const store = d1AccountMailDispatchStore(db);
    const sharedNetwork = "N".repeat(43);
    for (let index = 1; index <= 20; index += 1) {
      expect(await store.claim(accountClaim(index, "signin", { networkHash: sharedNetwork }))).toEqual({
        kind: "claimed",
      });
    }
    expect(await store.claim(accountClaim(21, "delete", { networkHash: sharedNetwork }))).toEqual({
      kind: "claimed",
    });
    expect(await store.claim(accountClaim(22, "signin", { networkHash: sharedNetwork }))).toEqual({
      kind: "budget_exhausted",
    });

    const victimRecipient = "V".repeat(43);
    for (let index = 100; index < 105; index += 1) {
      expect(await store.claim(accountClaim(index, "signin", { recipientHash: victimRecipient }))).toEqual({
        kind: "claimed",
      });
    }
    expect(await store.claim(accountClaim(105, "delete", { recipientHash: victimRecipient }))).toEqual({
      kind: "claimed",
    });
    expect(await store.claim(accountClaim(106, "signin", { recipientHash: victimRecipient }))).toEqual({
      kind: "budget_exhausted",
    });

    const sharedRecipient = "R".repeat(43);
    for (let index = 30; index < 35; index += 1) {
      expect(await store.claim(accountClaim(index, "delete", { recipientHash: sharedRecipient }))).toEqual({
        kind: "claimed",
      });
    }
    expect(await store.claim(accountClaim(35, "delete", { recipientHash: sharedRecipient }))).toEqual({
      kind: "budget_exhausted",
    });

    await store.finalize(accountClaim(30).proofHash, "rejected", NOW);
    expect(await store.claim(accountClaim(36, "delete", { recipientHash: sharedRecipient }))).toEqual({
      kind: "claimed",
    });
  }, 30_000);
});
