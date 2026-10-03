import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { d1AccountStore } from "../../worker/lib/account-store";
import { openDatabase } from "../support/platform";
import { createMigratedDatabase, removeDatabase } from "../support/wrangler";

let persistTo: string;
let db: D1Database;
let dispose: () => Promise<void>;
const CREATED = "2026-09-25T12:00:00.000Z";
const NOW = "2026-09-25T12:01:00.000Z";
const EXPIRES = "2026-09-25T12:10:00.000Z";

beforeAll(async () => {
  persistTo = createMigratedDatabase();
  ({ db, dispose } = await openDatabase(persistTo));
});

afterAll(async () => {
  await dispose?.();
  await removeDatabase(persistTo);
});

/** Pause exactly before the transaction, after any application-level proof reads. */
function beforeBatch(callback: () => Promise<void>): D1Database {
  return new Proxy(db, {
    get(target, property) {
      if (property === "batch") {
        return async (...args: Parameters<D1Database["batch"]>) => {
          await callback();
          return target.batch(...args);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function setup(id: string, subject: string, proof: string) {
  const store = d1AccountStore(db);
  const accountId = `acct_${id}`;
  const email = `${id}@example.invalid`;
  expect(await store.createOrGetGitHubAccount({ accountId, subject, email, now: CREATED })).toBe(accountId);
  await store.createEmailAttempt({
    verifyHash: proof.repeat(43),
    pollHash: proof.toUpperCase().repeat(43),
    email,
    clientKind: "website",
    purpose: "delete",
    accountId,
    codeChallenge: null,
    createdAt: CREATED,
    expiresAt: EXPIRES,
  });
  return { store, accountId, email, verifyHash: proof.repeat(43) };
}

async function auditCount(accountId: string) {
  return (
    await db
      .prepare("SELECT count(*) AS n FROM audit_log WHERE account_id = ?1 AND action = 'account.deleted'")
      .bind(accountId)
      .first<{ n: number }>()
  )?.n;
}

describe("atomic D1 account deletion", () => {
  it("rejects deletion when provider reconciliation revokes the proof before the transaction", async () => {
    const { store, accountId, verifyHash } = await setup("delete_reconcile", "9001", "a");
    const delayed = d1AccountStore(
      beforeBatch(async () => {
        expect(
          await store.createOrGetGitHubAccount({
            accountId,
            subject: "9001",
            email: "changed@example.invalid",
            now: NOW,
          }),
        ).toBe(accountId);
        expect(await store.emailAttempt("verify", verifyHash)).toBeNull();
      }),
    );
    expect(await delayed.softDeleteAccount({ verifyHash, accountId, consumeNonce: "1".repeat(43), now: NOW })).toBe(
      false,
    );
    expect(await store.accountProfile(accountId)).toMatchObject({ email: "changed@example.invalid" });
    expect(await auditCount(accountId)).toBe(0);
  });

  for (const distinctProofs of [false, true]) {
    it(`writes one audit for simultaneous ${distinctProofs ? "distinct" : "identical"} proofs at the same timestamp`, async () => {
      const { store, accountId, email, verifyHash } = await setup(
        distinctProofs ? "delete_distinct" : "delete_identical",
        distinctProofs ? "9002" : "9003",
        distinctProofs ? "b" : "c",
      );
      const otherProof = distinctProofs ? "d".repeat(43) : verifyHash;
      if (distinctProofs) {
        await store.createEmailAttempt({
          verifyHash: otherProof,
          pollHash: "D".repeat(43),
          email,
          clientKind: "website",
          purpose: "delete",
          accountId,
          codeChallenge: null,
          createdAt: CREATED,
          expiresAt: EXPIRES,
        });
      }
      let arrivals = 0;
      let release!: () => void;
      const bothReady = new Promise<void>((resolve) => {
        release = resolve;
      });
      const coordinated = d1AccountStore(
        beforeBatch(async () => {
          arrivals += 1;
          if (arrivals === 2) release();
          await bothReady;
        }),
      );
      const results = await Promise.all([
        coordinated.softDeleteAccount({ verifyHash, accountId, consumeNonce: "2".repeat(43), now: NOW }),
        coordinated.softDeleteAccount({ verifyHash: otherProof, accountId, consumeNonce: "3".repeat(43), now: NOW }),
      ]);
      expect(results.sort()).toEqual([false, true]);
      expect(await auditCount(accountId)).toBe(1);
      expect(await store.accountProfile(accountId)).toBeNull();
      expect(await store.emailAttempt("verify", verifyHash)).toBeNull();
      expect(await store.emailAttempt("verify", otherProof)).toBeNull();
    });
  }

  it("rejects proof for a different current email without consuming it", async () => {
    const { store, accountId, verifyHash } = await setup("delete_wrong_email", "9004", "e");
    await db.prepare("UPDATE accounts SET email = 'different@example.invalid' WHERE id = ?1").bind(accountId).run();
    expect(await store.softDeleteAccount({ verifyHash, accountId, consumeNonce: "4".repeat(43), now: NOW })).toBe(
      false,
    );
    expect(await store.accountProfile(accountId)).not.toBeNull();
    expect((await store.emailAttempt("verify", verifyHash))?.consumedAt).toBeNull();
    expect(await auditCount(accountId)).toBe(0);
  });
});

describe("signing up again after deletion", () => {
  for (const provider of ["github", "google", "microsoft"] as const) {
    it(`gives a deleted ${provider} identity a fresh, active account`, async () => {
      const store = d1AccountStore(db);
      const subject = provider === "github" ? "9100" : `resignup-${provider}`;
      // Production derives the account id from the identity, so the second sign-in asks for the same id.
      const derivedId = `acct_resignup_${provider}`;
      const email = `resignup-${provider}@example.invalid`;
      const create = (now: string) =>
        provider === "github"
          ? store.createOrGetGitHubAccount({ accountId: derivedId, subject, email, now })
          : store.createOrGetOpenIdAccount({ accountId: derivedId, provider, subject, email, now });
      expect(await create(CREATED)).toBe(derivedId);
      const verifyHash = `${provider[0]}${"z".repeat(42)}`;
      await store.createEmailAttempt({
        verifyHash,
        pollHash: `${provider[0]}${"Z".repeat(42)}`,
        email,
        clientKind: "website",
        purpose: "delete",
        accountId: derivedId,
        codeChallenge: null,
        createdAt: CREATED,
        expiresAt: EXPIRES,
      });
      expect(
        await store.softDeleteAccount({ verifyHash, accountId: derivedId, consumeNonce: "5".repeat(43), now: NOW }),
      ).toBe(true);

      const fresh = await create("2026-09-25T12:02:00.000Z");
      expect(fresh).toMatch(/^acct_/);
      expect(fresh).not.toBe(derivedId);
      expect(await store.identityAccount(provider, subject)).toBe(fresh);
      expect(await store.accountProfile(fresh as string)).toMatchObject({ email, activatedAt: null });
      // The deleted account stays deleted and redacted; its audit history stays with it.
      expect(await store.accountProfile(derivedId)).toBeNull();
      expect(
        await db.prepare("SELECT email FROM accounts WHERE id = ?1").bind(derivedId).first<{ email: string }>(),
      ).toEqual({ email: `${derivedId}@deleted.invalid` });
      expect(await auditCount(derivedId)).toBe(1);
      // Signing in again returns the same new account.
      expect(await create("2026-09-25T12:03:00.000Z")).toBe(fresh);
    });
  }
});
