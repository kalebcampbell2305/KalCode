/** The account display name against a real local D1 built from the numbered migrations. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { d1AccountStore } from "../../worker/lib/account-store";
import { openDatabase } from "../support/platform";
import { createMigratedDatabase, removeDatabase } from "../support/wrangler";

let persistTo: string;
let db: D1Database;
let dispose: () => Promise<void>;
const CREATED = "2026-09-25T12:00:00.000Z";
const NOW = "2026-09-25T12:01:00.000Z";

beforeAll(async () => {
  persistTo = createMigratedDatabase();
  ({ db, dispose } = await openDatabase(persistTo));
});

afterAll(async () => {
  await dispose?.();
  await removeDatabase(persistTo);
});

async function account(id: string, subject: string) {
  const store = d1AccountStore(db);
  const accountId = `acct_${id}`;
  const email = `${id}@example.invalid`;
  expect(await store.createOrGetGitHubAccount({ accountId, subject, email, now: CREATED })).toBe(accountId);
  return { store, accountId, email };
}

describe("D1 account display name", () => {
  it("starts unset, then sets and clears only the display name", async () => {
    const { store, accountId, email } = await account("profile_set", "7001");
    const before = await db.prepare("SELECT * FROM accounts WHERE id = ?1").bind(accountId).first();
    expect(await store.accountProfile(accountId)).toEqual({
      id: accountId,
      email,
      activatedAt: null,
      displayName: null,
    });

    expect(await store.setDisplayName(accountId, "Kaleb Campbell")).toMatchObject({ displayName: "Kaleb Campbell" });
    expect(await store.setDisplayName(accountId, "Kaleb")).toEqual({
      id: accountId,
      email,
      activatedAt: null,
      displayName: "Kaleb",
    });
    expect(await store.accountProfile(accountId)).toMatchObject({ displayName: "Kaleb" });
    const after = await db.prepare("SELECT * FROM accounts WHERE id = ?1").bind(accountId).first();
    expect({ ...after, display_name: null }).toEqual(before);

    expect(await store.setDisplayName(accountId, null)).toMatchObject({ displayName: null });
  });

  it("bounds stored names in the schema itself", async () => {
    const { accountId } = await account("profile_bounds", "7002");
    const set = (value: string) =>
      db.prepare("UPDATE accounts SET display_name = ?2 WHERE id = ?1").bind(accountId, value).run();
    await expect(set("x".repeat(65))).rejects.toThrow();
    await expect(set("")).rejects.toThrow();
    await expect(set("x".repeat(64))).resolves.toBeTruthy();
  });

  it("never names a deleted or unknown account, and deletion clears the name", async () => {
    const { store, accountId, email } = await account("profile_deleted", "7003");
    await store.setDisplayName(accountId, "Kaleb");
    await store.createEmailAttempt({
      verifyHash: "p".repeat(43),
      pollHash: "P".repeat(43),
      email,
      clientKind: "website",
      purpose: "delete",
      accountId,
      codeChallenge: null,
      createdAt: CREATED,
      expiresAt: "2026-09-25T12:10:00.000Z",
    });
    expect(
      await store.softDeleteAccount({ verifyHash: "p".repeat(43), accountId, consumeNonce: "4".repeat(43), now: NOW }),
    ).toBe(true);
    const row = await db.prepare("SELECT display_name FROM accounts WHERE id = ?1").bind(accountId).first();
    expect(row).toEqual({ display_name: null });
    expect(await store.setDisplayName(accountId, "Again")).toBeNull();
    expect(await store.setDisplayName("acct_missing", "Nobody")).toBeNull();
  });
});
