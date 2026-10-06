import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { d1AccountStore } from "../../worker/lib/account-store";
import { d1BillingStore } from "../../worker/lib/billing-store";
import { resolveEntitlement } from "../../worker/lib/entitlement";
import { d1Store } from "../../worker/lib/store";
import type { StripeSubscriptionSnapshot } from "../../worker/lib/stripe";
import { openDatabase } from "../support/platform";
import { createMigratedDatabase, removeDatabase } from "../support/wrangler";

let persistTo: string;
let db: D1Database;
let dispose: () => Promise<void>;
const T0 = "2026-09-25T12:00:00.000Z";

function coordinatedFirstIdentityMisses(database: D1Database): {
  older: D1Database;
  newer: D1Database;
} {
  let misses = 0;
  let releaseMisses!: () => void;
  let releaseOlderBatch!: () => void;
  const bothMissed = new Promise<void>((resolve) => {
    releaseMisses = resolve;
  });
  const olderBatchDone = new Promise<void>((resolve) => {
    releaseOlderBatch = resolve;
  });

  const wrap = (role: "older" | "newer"): D1Database => {
    let forceIdentityMiss = true;
    const wrapIdentityStatement = (statement: D1PreparedStatement): D1PreparedStatement =>
      new Proxy(statement, {
        get(target, property) {
          if (property === "bind") {
            return (...values: Parameters<D1PreparedStatement["bind"]>) =>
              wrapIdentityStatement(target.bind(...values));
          }
          if (property === "first") {
            return async () => {
              if (forceIdentityMiss) {
                forceIdentityMiss = false;
                misses += 1;
                if (misses === 2) releaseMisses();
                await bothMissed;
                return null;
              }
              return target.first();
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });

    return new Proxy(database, {
      get(target, property) {
        if (property === "prepare") {
          return (query: string) => {
            const statement = target.prepare(query);
            return query.includes("SELECT i.account_id FROM account_identities")
              ? wrapIdentityStatement(statement)
              : statement;
          };
        }
        if (property === "batch") {
          return async (...args: Parameters<D1Database["batch"]>) => {
            if (role === "newer") await olderBatchDone;
            try {
              return await target.batch(...args);
            } finally {
              if (role === "older") releaseOlderBatch();
            }
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };

  return { older: wrap("older"), newer: wrap("newer") };
}

beforeAll(async () => {
  persistTo = createMigratedDatabase();
  ({ db, dispose } = await openDatabase(persistTo));
});

afterAll(async () => {
  await dispose?.();
  await removeDatabase(persistTo);
});

describe("D1 account authority", () => {
  it("creates a verified email account, consumes the handoff once, rotates the session, and activates Free", async () => {
    const store = d1AccountStore(db);
    await store.createEmailAttempt({
      verifyHash: "v".repeat(43),
      pollHash: "p".repeat(43),
      email: "passwordless@example.com",
      clientKind: "desktop",
      purpose: "signin",
      accountId: null,
      codeChallenge: "c".repeat(43),
      createdAt: T0,
      expiresAt: "2026-09-25T12:10:00.000Z",
    });
    const verified = await store.markEmailVerified({
      verifyHash: "v".repeat(43),
      accountId: "acct_passwordless_101",
      now: "2026-09-25T12:00:01.000Z",
    });
    expect(verified).toMatchObject({ accountId: "acct_passwordless_101", clientKind: "desktop" });
    const session = await store.consumeEmailAttempt({
      verifyHash: "v".repeat(43),
      consumeNonce: "n".repeat(43),
      tokenHash: "h".repeat(43),
      createdAt: "2026-09-25T12:00:02.000Z",
      expiresAt: "2026-10-25T12:00:02.000Z",
    });
    expect(session).toMatchObject({ accountId: "acct_passwordless_101", clientKind: "desktop" });
    expect(
      await store.consumeEmailAttempt({
        verifyHash: "v".repeat(43),
        consumeNonce: "m".repeat(43),
        tokenHash: "j".repeat(43),
        createdAt: "2026-09-25T12:00:03.000Z",
        expiresAt: "2026-10-25T12:00:03.000Z",
      }),
    ).toBeNull();
    expect(await store.activeSession("h".repeat(43), T0)).toBe("acct_passwordless_101");
    const rotated = await store.rotateSession({
      oldTokenHash: "h".repeat(43),
      newTokenHash: "r".repeat(43),
      now: "2026-09-25T12:00:04.000Z",
      expiresAt: "2026-10-25T12:00:04.000Z",
    });
    expect(rotated).toMatchObject({ accountId: "acct_passwordless_101", clientKind: "desktop" });
    expect(await store.activeSession("h".repeat(43), "2026-09-25T12:00:05.000Z")).toBeNull();
    expect(await store.activeSession("r".repeat(43), "2026-09-25T12:00:05.000Z")).toBe("acct_passwordless_101");
    expect(await store.activateFree("acct_passwordless_101", "2026-09-25T12:00:05.000Z")).toBe(true);
    expect(await store.accountProfile("acct_passwordless_101")).toMatchObject({
      email: "passwordless@example.com",
      activatedAt: "2026-09-25T12:00:05.000Z",
    });
  });

  it("soft-deletes only after fresh email proof, revokes sessions, and preserves an audit record", async () => {
    const store = d1AccountStore(db);
    await store.createEmailAttempt({
      verifyHash: "a".repeat(43),
      pollHash: "b".repeat(43),
      email: "passwordless@example.com",
      clientKind: "desktop",
      purpose: "signin",
      accountId: null,
      codeChallenge: "c".repeat(43),
      createdAt: "2026-09-25T12:00:30.000Z",
      expiresAt: "2026-09-25T12:10:30.000Z",
    });
    await db
      .prepare(
        "INSERT INTO account_identities (provider, subject, account_id, created_at) VALUES ('github', ?1, ?2, ?3)",
      )
      .bind("909", "acct_passwordless_101", T0)
      .run();
    await store.createEmailAttempt({
      verifyHash: "d".repeat(43),
      pollHash: "e".repeat(43),
      email: "passwordless@example.com",
      clientKind: "website",
      purpose: "delete",
      accountId: "acct_passwordless_101",
      codeChallenge: null,
      createdAt: "2026-09-25T12:01:00.000Z",
      expiresAt: "2026-09-25T12:11:00.000Z",
    });
    expect(
      await store.softDeleteAccount({
        verifyHash: "d".repeat(43),
        accountId: "acct_passwordless_101",
        consumeNonce: "f".repeat(43),
        now: "2026-09-25T12:01:01.000Z",
      }),
    ).toBe(true);
    expect(await store.accountProfile("acct_passwordless_101")).toBeNull();
    expect(await store.activeSession("r".repeat(43), "2026-09-25T12:01:02.000Z")).toBeNull();
    expect(await store.emailAttempt("verify", "a".repeat(43))).toBeNull();
    expect(await store.emailAttempt("verify", "d".repeat(43))).toBeNull();
    expect(await store.identityAccount("github", "909")).toBeNull();
    // Signing up again with the same GitHub identity creates a new account; the deleted one is never restored.
    expect(
      await store.createOrGetGitHubAccount({
        accountId: "acct_replacement_909",
        subject: "909",
        email: "passwordless@example.com",
        now: "2026-09-25T12:01:03.000Z",
      }),
    ).toBe("acct_replacement_909");
    expect(await store.identityAccount("github", "909")).toBe("acct_replacement_909");
    expect(await store.accountProfile("acct_passwordless_101")).toBeNull();
    await expect(
      db
        .prepare(
          `INSERT INTO entitlement_grants
             (account_id, tier, source, granted_by, reason, granted_at)
           VALUES ('acct_passwordless_101', 'owner', 'grant', 'operator:test', 'must fail', ?1)`,
        )
        .bind("2026-09-25T12:01:04.000Z")
        .run(),
    ).rejects.toThrow(/deleted accounts cannot receive entitlement grants/);
    const audit = await db
      .prepare("SELECT action FROM audit_log WHERE account_id = ?1 AND action = 'account.deleted'")
      .bind("acct_passwordless_101")
      .first<{ action: string }>();
    expect(audit).toEqual({ action: "account.deleted" });
    const billing = d1BillingStore(db);
    expect(
      await billing.reserveCheckout({
        accountId: "acct_passwordless_101",
        tier: "pro",
        requestHash: "u".repeat(43),
        idempotencyKey: "checkout_deleted_101",
        now: "2026-09-25T12:02:00.000Z",
        expiresAt: "2026-09-25T12:37:00.000Z",
      }),
    ).toEqual({ status: "busy" });
    expect(
      await billing.reserveCustomer({
        accountId: "acct_passwordless_101",
        idempotencyKey: "customer_deleted_101",
        now: "2026-09-25T12:02:00.000Z",
      }),
    ).toBeNull();
  });

  it("blocks deletion while a nonexpired Checkout intent can create an external effect", async () => {
    await db
      .prepare("INSERT INTO accounts (id, email, email_verified_at, created_at) VALUES (?1, ?2, ?3, ?3)")
      .bind("acct_checkout_race", "checkout-race@example.com", T0)
      .run();
    const accounts = d1AccountStore(db);
    const billing = d1BillingStore(db);
    expect(
      await billing.reserveCheckout({
        accountId: "acct_checkout_race",
        tier: "pro",
        requestHash: "w".repeat(43),
        idempotencyKey: "checkout_race_101",
        now: T0,
        expiresAt: "2026-09-25T12:35:00.000Z",
      }),
    ).toEqual({ status: "reserved", idempotencyKey: "checkout_race_101" });
    await accounts.createEmailAttempt({
      verifyHash: "g".repeat(43),
      pollHash: "k".repeat(43),
      email: "checkout-race@example.com",
      clientKind: "website",
      purpose: "delete",
      accountId: "acct_checkout_race",
      codeChallenge: null,
      createdAt: T0,
      expiresAt: "2026-09-25T12:10:00.000Z",
    });
    expect(
      await accounts.softDeleteAccount({
        verifyHash: "g".repeat(43),
        accountId: "acct_checkout_race",
        consumeNonce: "l".repeat(43),
        now: "2026-09-25T12:00:01.000Z",
      }),
    ).toBe(false);
    expect(await accounts.accountProfile("acct_checkout_race")).not.toBeNull();
  });

  it("never grants a delayed subscription webhook to a deleted account", async () => {
    await db
      .prepare("INSERT INTO accounts (id, email, email_verified_at, created_at) VALUES (?1, ?2, ?3, ?3)")
      .bind("acct_delayed_606", "delayed606@example.com", T0)
      .run();
    const accounts = d1AccountStore(db);
    const billing = d1BillingStore(db);
    await billing.reserveCustomer({
      accountId: "acct_delayed_606",
      idempotencyKey: "customer_delayed_606",
      now: T0,
    });
    await billing.bindCustomer("acct_delayed_606", "cus_delayed606", T0);
    await accounts.createEmailAttempt({
      verifyHash: "o".repeat(43),
      pollHash: "q".repeat(43),
      email: "delayed606@example.com",
      clientKind: "website",
      purpose: "delete",
      accountId: "acct_delayed_606",
      codeChallenge: null,
      createdAt: T0,
      expiresAt: "2026-09-25T12:10:00.000Z",
    });
    expect(
      await accounts.softDeleteAccount({
        verifyHash: "o".repeat(43),
        accountId: "acct_delayed_606",
        consumeNonce: "s".repeat(43),
        now: "2026-09-25T12:00:01.000Z",
      }),
    ).toBe(true);
    const lease = await billing.acquireLease({
      subscriptionId: "sub_delayed606",
      token: "lease_delayed_606001",
      now: "2026-09-25T12:00:02.000Z",
      expiresAt: "2026-09-25T12:00:32.000Z",
    });
    if (!lease) throw new Error("test lease missing");
    expect(
      await billing.applySubscription(
        {
          id: "sub_delayed606",
          customerId: "cus_delayed606",
          status: "active",
          tier: "pro",
          periodStart: T0,
          periodEnd: "2026-10-25T12:00:00.000Z",
        },
        lease,
        "2026-09-25T12:00:03.000Z",
      ),
    ).toBe(false);
    expect(
      await billing.revokeInvalidSubscription("sub_delayed606", "cus_delayed606", lease, "2026-09-25T12:00:03.000Z"),
    ).toBe(true);
    const grant = await db
      .prepare("SELECT 1 AS present FROM entitlement_grants WHERE account_id = ?1 AND revoked_at IS NULL")
      .bind("acct_delayed_606")
      .first<{ present: number }>();
    expect(grant).toBeNull();
  });

  it("consumes OAuth state once and only while the expected challenge is live", async () => {
    const store = d1AccountStore(db);
    await store.createOAuthAttempt({
      stateHash: "s".repeat(43),
      codeChallenge: "c".repeat(43),
      rateBucket: "r".repeat(43),
      createdAt: T0,
      expiresAt: "2026-09-25T12:10:00.000Z",
    });
    expect(
      await store.consumeOAuthAttempt({ stateHash: "s".repeat(43), codeChallenge: "x".repeat(43), consumedAt: T0 }),
    ).toBe(false);
    expect((await store.oauthAttempt("s".repeat(43)))?.consumedAt).toBeNull();
    expect(
      await store.consumeOAuthAttempt({ stateHash: "s".repeat(43), codeChallenge: "c".repeat(43), consumedAt: T0 }),
    ).toBe(true);
    expect(
      await store.consumeOAuthAttempt({ stateHash: "s".repeat(43), codeChallenge: "c".repeat(43), consumedAt: T0 }),
    ).toBe(false);
  });

  it("reconciles a provider subject to its current verified email and retires the old recovery credential", async () => {
    const store = d1AccountStore(db);
    expect(
      await store.createOrGetGitHubAccount({
        accountId: "acct_subject_101",
        subject: "101",
        email: "previous-provider-email@example.com",
        now: T0,
      }),
    ).toBe("acct_subject_101");

    await store.createSession({
      tokenHash: "provider_email_change_session".padEnd(43, "s"),
      accountId: "acct_subject_101",
      createdAt: T0,
      expiresAt: "2026-10-25T12:00:00.000Z",
      clientKind: "website",
    });
    await store.createEmailAttempt({
      verifyHash: "old_unverified_email_proof".padEnd(43, "u"),
      pollHash: "old_unverified_email_poll".padEnd(43, "u"),
      email: "previous-provider-email@example.com",
      clientKind: "website",
      purpose: "signin",
      accountId: null,
      codeChallenge: null,
      createdAt: T0,
      expiresAt: "2026-09-25T12:10:00.000Z",
    });
    await store.createEmailAttempt({
      verifyHash: "old_verified_email_proof".padEnd(43, "v"),
      pollHash: "old_verified_email_poll".padEnd(43, "v"),
      email: "previous-provider-email@example.com",
      clientKind: "website",
      purpose: "signin",
      accountId: null,
      codeChallenge: null,
      createdAt: T0,
      expiresAt: "2026-09-25T12:10:00.000Z",
    });
    expect(
      await store.markEmailVerified({
        verifyHash: "old_verified_email_proof".padEnd(43, "v"),
        accountId: "acct_must_not_replace_subject_101",
        now: "2026-09-25T12:00:01.000Z",
      }),
    ).toMatchObject({ accountId: "acct_subject_101" });

    expect(
      await store.createOrGetGitHubAccount({
        accountId: "acct_subject_101",
        subject: "101",
        email: "current-provider-email@example.com",
        now: "2026-09-25T12:00:02.000Z",
      }),
    ).toBe("acct_subject_101");
    expect(await store.accountProfile("acct_subject_101")).toMatchObject({
      email: "current-provider-email@example.com",
    });
    expect(await store.activeSession("provider_email_change_session".padEnd(43, "s"), T0)).toBeNull();
    expect(await store.emailAttempt("verify", "old_unverified_email_proof".padEnd(43, "u"))).toBeNull();
    expect(await store.emailAttempt("verify", "old_verified_email_proof".padEnd(43, "v"))).toBeNull();

    await store.createEmailAttempt({
      verifyHash: "former_address_new_proof".padEnd(43, "f"),
      pollHash: "former_address_new_poll".padEnd(43, "f"),
      email: "previous-provider-email@example.com",
      clientKind: "website",
      purpose: "signin",
      accountId: null,
      codeChallenge: null,
      createdAt: "2026-09-25T12:00:03.000Z",
      expiresAt: "2026-09-25T12:10:00.000Z",
    });
    expect(
      await store.markEmailVerified({
        verifyHash: "former_address_new_proof".padEnd(43, "f"),
        accountId: "acct_former_address_holder",
        now: "2026-09-25T12:00:04.000Z",
      }),
    ).toMatchObject({ accountId: "acct_former_address_holder" });

    await store.createEmailAttempt({
      verifyHash: "current_address_new_proof".padEnd(43, "n"),
      pollHash: "current_address_new_poll".padEnd(43, "n"),
      email: "current-provider-email@example.com",
      clientKind: "website",
      purpose: "signin",
      accountId: null,
      codeChallenge: null,
      createdAt: "2026-09-25T12:00:05.000Z",
      expiresAt: "2026-09-25T12:10:00.000Z",
    });
    expect(
      await store.markEmailVerified({
        verifyHash: "current_address_new_proof".padEnd(43, "n"),
        accountId: "acct_must_not_replace_subject_101",
        now: "2026-09-25T12:00:06.000Z",
      }),
    ).toMatchObject({ accountId: "acct_subject_101" });
  });

  it("fails closed when a provider email change collides with another account", async () => {
    const store = d1AccountStore(db);
    await store.createEmailAttempt({
      verifyHash: "collision_account_proof".padEnd(43, "c"),
      pollHash: "collision_account_poll".padEnd(43, "c"),
      email: "linked-elsewhere@example.com",
      clientKind: "website",
      purpose: "signin",
      accountId: null,
      codeChallenge: null,
      createdAt: T0,
      expiresAt: "2026-09-25T12:10:00.000Z",
    });
    expect(
      await store.markEmailVerified({
        verifyHash: "collision_account_proof".padEnd(43, "c"),
        accountId: "acct_email_collision_owner",
        now: "2026-09-25T12:00:01.000Z",
      }),
    ).toMatchObject({ accountId: "acct_email_collision_owner" });
    expect(
      await store.createOrGetGitHubAccount({
        accountId: "acct_subject_202",
        subject: "202",
        email: "subject-202-original@example.com",
        now: "2026-09-25T12:00:02.000Z",
      }),
    ).toBe("acct_subject_202");
    await store.createSession({
      tokenHash: "email_collision_session".padEnd(43, "s"),
      accountId: "acct_subject_202",
      createdAt: "2026-09-25T12:00:02.000Z",
      expiresAt: "2026-10-25T12:00:00.000Z",
      clientKind: "website",
    });
    await store.createEmailAttempt({
      verifyHash: "email_collision_old_proof".padEnd(43, "p"),
      pollHash: "email_collision_old_poll".padEnd(43, "p"),
      email: "subject-202-original@example.com",
      clientKind: "website",
      purpose: "signin",
      accountId: null,
      codeChallenge: null,
      createdAt: "2026-09-25T12:00:02.000Z",
      expiresAt: "2026-09-25T12:10:00.000Z",
    });
    expect(
      await store.createOrGetGitHubAccount({
        accountId: "acct_subject_202",
        subject: "202",
        email: "linked-elsewhere@example.com",
        now: "2026-09-25T12:00:03.000Z",
      }),
    ).toBeNull();
    expect(await store.identityAccount("github", "202")).toBe("acct_subject_202");
    expect(await store.accountProfile("acct_subject_202")).toMatchObject({
      email: "subject-202-original@example.com",
    });
    expect(await store.accountProfile("acct_email_collision_owner")).toMatchObject({
      email: "linked-elsewhere@example.com",
    });
    expect(await store.activeSession("email_collision_session".padEnd(43, "s"), "2026-09-25T12:00:03.000Z")).toBe(
      "acct_subject_202",
    );
    expect(await store.emailAttempt("verify", "email_collision_old_proof".padEnd(43, "p"))).not.toBeNull();
  });

  it("reconciles a newer verified email when first-time provider identity creation races", async () => {
    const coordinated = coordinatedFirstIdentityMisses(db);
    const olderStore = d1AccountStore(coordinated.older);
    const newerStore = d1AccountStore(coordinated.newer);
    const [older, newer] = await Promise.all([
      olderStore.createOrGetGitHubAccount({
        accountId: "acct_subject_race_303",
        subject: "303",
        email: "race-older@example.com",
        now: "2026-09-25T12:00:01.000Z",
      }),
      newerStore.createOrGetGitHubAccount({
        accountId: "acct_subject_race_303",
        subject: "303",
        email: "race-newer@example.com",
        now: "2026-09-25T12:00:02.000Z",
      }),
    ]);

    expect(older).toBe("acct_subject_race_303");
    expect(newer).toBe("acct_subject_race_303");
    expect(await d1AccountStore(db).identityAccount("github", "303")).toBe("acct_subject_race_303");
    expect(await d1AccountStore(db).accountProfile("acct_subject_race_303")).toMatchObject({
      email: "race-newer@example.com",
    });
  });

  it("stores only session hashes and rejects expired or revoked sessions", async () => {
    const store = d1AccountStore(db);
    await store.createSession({
      tokenHash: "t".repeat(43),
      accountId: "acct_subject_101",
      createdAt: T0,
      expiresAt: "2026-10-25T12:00:00.000Z",
      clientKind: "desktop",
    });
    expect(await store.activeSession("t".repeat(43), T0)).toBe("acct_subject_101");
    expect(await store.activeSession("missing".repeat(6).slice(0, 43), T0)).toBeNull();
    expect(await store.revokeSession("t".repeat(43), "2026-09-25T12:01:00.000Z")).toBe(true);
    expect(await store.activeSession("t".repeat(43), T0)).toBeNull();
  });
});

describe("D1 billing authority", () => {
  it("keeps saturated auth and billing rate counters as deterministic denials", async () => {
    const bucketHash = "9".repeat(43);
    await db
      .prepare(
        "INSERT INTO auth_rate_limits (bucket_hash, action, window_started_at, request_count) VALUES (?1, 'email_start', ?2, 100000)",
      )
      .bind(bucketHash, T0)
      .run();
    const accounts = d1AccountStore(db);
    await expect(
      accounts.allowRateLimit({
        bucketHash,
        action: "email_start",
        now: "2026-09-25T12:00:01.000Z",
        windowStart: "2026-09-25T11:50:01.000Z",
        retentionStart: "2026-09-24T12:00:01.000Z",
        limit: 5,
      }),
    ).resolves.toBe(false);
    expect(
      await db
        .prepare("SELECT request_count FROM auth_rate_limits WHERE bucket_hash = ?1 AND action = 'email_start'")
        .bind(bucketHash)
        .first(),
    ).toEqual({ request_count: 100000 });

    await db
      .prepare("INSERT OR IGNORE INTO accounts (id, email, email_verified_at, created_at) VALUES (?1, ?2, ?3, ?3)")
      .bind("acct_rate_saturated", "rate-saturated@example.com", T0)
      .run();
    await db
      .prepare(
        "INSERT INTO billing_action_limits (account_id, action, window_started_at, request_count) VALUES (?1, 'checkout', ?2, 100000)",
      )
      .bind("acct_rate_saturated", T0)
      .run();
    const billing = d1BillingStore(db);
    await expect(
      billing.allowAction({
        accountId: "acct_rate_saturated",
        action: "checkout",
        now: "2026-09-25T12:00:01.000Z",
        windowStart: "2026-09-25T11:50:01.000Z",
        retentionStart: "2026-09-24T12:00:01.000Z",
        limit: 10,
      }),
    ).resolves.toBe(false);
    expect(
      await db
        .prepare("SELECT request_count FROM billing_action_limits WHERE account_id = ?1 AND action = 'checkout'")
        .bind("acct_rate_saturated")
        .first(),
    ).toEqual({ request_count: 100000 });
  });

  it("rate limits billing actions and binds an event id to its type and subscription", async () => {
    const store = d1BillingStore(db);
    expect(
      await store.allowAction({
        accountId: "acct_subject_101",
        action: "checkout",
        now: T0,
        windowStart: "2026-09-25T11:50:00.000Z",
        retentionStart: "2026-09-24T12:00:00.000Z",
        limit: 1,
      }),
    ).toBe(true);
    expect(
      await store.allowAction({
        accountId: "acct_subject_101",
        action: "checkout",
        now: "2026-09-25T12:00:01.000Z",
        windowStart: "2026-09-25T11:50:01.000Z",
        retentionStart: "2026-09-24T12:00:01.000Z",
        limit: 1,
      }),
    ).toBe(false);
    const event = {
      eventId: "evt_binding101",
      eventType: "customer.subscription.updated",
      eventSubject: "sub_binding101",
      token: "event_binding_00000001",
      receivedAt: T0,
      claimExpiresAt: "2026-09-25T12:01:00.000Z",
    };
    const firstClaim = await store.claimEvent(event);
    expect(firstClaim.status).toBe("claimed");
    expect((await store.claimEvent(event)).status).toBe("pending");
    expect((await store.claimEvent({ ...event, eventSubject: "sub_swapped101" })).status).toBe("mismatch");
    expect((await store.claimEvent({ ...event, eventType: "customer.subscription.deleted" })).status).toBe("mismatch");
    if (firstClaim.status !== "claimed") throw new Error("test event claim missing");
    expect(await store.finishEvent(firstClaim.claim, "applied", "2026-09-25T12:00:01.000Z")).toBe(true);
    expect((await store.claimEvent(event)).status).toBe("done");
  });

  it("reclaims an expired event lease and fences the stale worker", async () => {
    const store = d1BillingStore(db);
    const base = {
      eventId: "evt_reclaim101",
      eventType: "customer.subscription.updated",
      eventSubject: "sub_reclaim101",
      token: "event_reclaim_000001",
      receivedAt: T0,
      claimExpiresAt: "2026-09-25T12:01:00.000Z",
    };
    const first = await store.claimEvent(base);
    expect(first.status).toBe("claimed");
    const second = await store.claimEvent({
      ...base,
      token: "event_reclaim_000002",
      receivedAt: "2026-09-25T12:01:01.000Z",
      claimExpiresAt: "2026-09-25T12:02:01.000Z",
    });
    expect(second.status).toBe("claimed");
    if (first.status !== "claimed" || second.status !== "claimed") throw new Error("test event claim missing");
    expect(second.claim.version).toBe(2);
    expect(await store.finishEvent(first.claim, "applied", "2026-09-25T12:01:02.000Z")).toBe(false);
    expect(await store.finishEvent(second.claim, "applied", "2026-09-25T12:01:02.000Z")).toBe(true);
  });

  it("uses a stable customer idempotency key and refuses rebinding", async () => {
    const store = d1BillingStore(db);
    const first = await store.reserveCustomer({
      accountId: "acct_subject_101",
      idempotencyKey: "idem_customer_101",
      now: T0,
    });
    const retry = await store.reserveCustomer({
      accountId: "acct_subject_101",
      idempotencyKey: "different_key_101",
      now: T0,
    });
    expect(retry?.createIdempotencyKey).toBe(first?.createIdempotencyKey);
    expect(await store.bindCustomer("acct_subject_101", "cus_customer101", T0)).toBe(true);
    expect(await store.bindCustomer("acct_subject_101", "cus_attacker999", T0)).toBe(false);
  });

  it("serializes checkout per account and routes every nonterminal subscription to Portal", async () => {
    const store = d1BillingStore(db);
    const first = await store.reserveCheckout({
      accountId: "acct_subject_101",
      tier: "pro",
      requestHash: "q".repeat(43),
      idempotencyKey: "checkout_intent_101",
      now: T0,
      expiresAt: "2026-09-25T12:35:00.000Z",
    });
    expect(first).toEqual({ status: "reserved", idempotencyKey: "checkout_intent_101" });
    expect(
      await store.finalizeCheckout({
        accountId: "acct_subject_101",
        tier: "pro",
        requestHash: "q".repeat(43),
        stripeSessionId: "cs_checkout101",
        now: "2026-09-25T12:00:00.500Z",
      }),
    ).toBe(true);
    expect(
      await store.reserveCheckout({
        accountId: "acct_subject_101",
        tier: "max",
        requestHash: "z".repeat(43),
        idempotencyKey: "checkout_intent_102",
        now: "2026-09-25T12:00:01.000Z",
        expiresAt: "2026-09-25T12:35:01.000Z",
      }),
    ).toEqual({ status: "busy" });

    await db
      .prepare(
        "INSERT INTO billing_subscriptions (stripe_subscription_id, account_id, stripe_customer_id, tier, status, period_start, period_end, reconciled_at) VALUES (?1, ?2, ?3, 'pro', 'past_due', ?4, ?5, ?4)",
      )
      .bind("sub_existing101", "acct_subject_101", "cus_customer101", T0, "2026-10-25T12:00:00.000Z")
      .run();
    expect(
      await store.reserveCheckout({
        accountId: "acct_subject_101",
        tier: "max",
        requestHash: "x".repeat(43),
        idempotencyKey: "checkout_intent_103",
        now: "2026-09-25T12:36:00.000Z",
        expiresAt: "2026-09-25T13:11:00.000Z",
      }),
    ).toEqual({ status: "subscribed" });
  });

  it("clears finalization state when an expired intent is replaced", async () => {
    await db
      .prepare("INSERT INTO accounts (id, email, email_verified_at, created_at) VALUES (?1, ?2, ?3, ?3)")
      .bind("acct_checkout_replace", "checkout-replace@example.com", T0)
      .run();
    const store = d1BillingStore(db);
    expect(
      await store.reserveCheckout({
        accountId: "acct_checkout_replace",
        tier: "pro",
        requestHash: "a".repeat(43),
        idempotencyKey: "checkout_replace_old",
        now: T0,
        expiresAt: "2026-09-25T12:35:00.000Z",
      }),
    ).toMatchObject({ status: "reserved" });
    expect(
      await store.finalizeCheckout({
        accountId: "acct_checkout_replace",
        tier: "pro",
        requestHash: "a".repeat(43),
        stripeSessionId: "cs_replace_old",
        now: "2026-09-25T12:00:01.000Z",
      }),
    ).toBe(true);
    expect(
      await store.reserveCheckout({
        accountId: "acct_checkout_replace",
        tier: "max",
        requestHash: "b".repeat(43),
        idempotencyKey: "checkout_replace_new",
        now: "2026-09-25T12:35:01.000Z",
        expiresAt: "2026-09-25T13:10:01.000Z",
      }),
    ).toMatchObject({ status: "reserved" });
    expect(
      await store.finalizeCheckout({
        accountId: "acct_checkout_replace",
        tier: "max",
        requestHash: "b".repeat(43),
        stripeSessionId: "cs_replace_new",
        now: "2026-09-25T12:35:02.000Z",
      }),
    ).toBe(true);
    expect(
      await db
        .prepare("SELECT stripe_checkout_session_id, finalized_at FROM billing_checkout_intents WHERE account_id = ?1")
        .bind("acct_checkout_replace")
        .first(),
    ).toEqual({ stripe_checkout_session_id: "cs_replace_new", finalized_at: "2026-09-25T12:35:02.000Z" });
  });

  it("atomically activates OWNER and prevents a reserved Checkout from becoming a charge", async () => {
    await db
      .prepare("INSERT INTO accounts (id, email, email_verified_at, created_at) VALUES (?1, ?2, ?3, ?3)")
      .bind("acct_owner_checkout", "owner-checkout@example.com", T0)
      .run();
    const store = d1BillingStore(db);
    const reserved = await store.reserveCheckout({
      accountId: "acct_owner_checkout",
      tier: "pro",
      requestHash: "o".repeat(43),
      idempotencyKey: "checkout_owner_before_grant",
      now: T0,
      expiresAt: "2026-09-25T12:35:00.000Z",
    });
    expect(reserved.status).toBe("reserved");
    await db
      .prepare(
        `INSERT INTO entitlement_grants (account_id, tier, source, granted_by, reason, granted_at)
         VALUES (?1, 'owner', 'grant', 'operator:test', 'owner', ?2)`,
      )
      .bind("acct_owner_checkout", "2026-09-25T12:00:01.000Z")
      .run();
    expect(
      await store.finalizeCheckout({
        accountId: "acct_owner_checkout",
        tier: "pro",
        requestHash: "o".repeat(43),
        stripeSessionId: "cs_owner_race101",
        now: "2026-09-25T12:00:02.000Z",
      }),
    ).toBe(false);
    expect(
      await store.checkoutStillReserved({
        accountId: "acct_owner_checkout",
        tier: "pro",
        requestHash: "o".repeat(43),
        now: "2026-09-25T12:00:02.000Z",
      }),
    ).toBe(false);
    expect(
      await store.reserveCheckout({
        accountId: "acct_owner_checkout",
        tier: "max",
        requestHash: "p".repeat(43),
        idempotencyKey: "checkout_owner_after_grant",
        now: "2026-09-25T12:36:00.000Z",
        expiresAt: "2026-09-25T13:11:00.000Z",
      }),
    ).toEqual({ status: "owner" });
    expect(
      await db
        .prepare("SELECT activated_at FROM accounts WHERE id = 'acct_owner_checkout'")
        .first<{ activated_at: string | null }>(),
    ).toEqual({ activated_at: "2026-09-25T12:00:01.000Z" });
  });

  it("keeps an operator OWNER grant effective through later Stripe upgrade, downgrade, and cancellation snapshots", async () => {
    const accountId = "acct_owner_webhook";
    const customerId = "cus_owner_webhook";
    const subscriptionId = "sub_owner_webhook";
    await db
      .prepare("INSERT INTO accounts (id, email, email_verified_at, created_at) VALUES (?1, ?2, ?3, ?3)")
      .bind(accountId, "owner-webhook@example.com", T0)
      .run();
    const billing = d1BillingStore(db);
    await billing.reserveCustomer({ accountId, idempotencyKey: "owner_webhook_customer", now: T0 });
    expect(await billing.bindCustomer(accountId, customerId, T0)).toBe(true);

    async function applySnapshot(
      status: StripeSubscriptionSnapshot["status"],
      tier: StripeSubscriptionSnapshot["tier"],
      now: string,
      token: string,
    ) {
      const lease = await billing.acquireLease({
        subscriptionId,
        token,
        now,
        expiresAt: new Date(Date.parse(now) + 60_000).toISOString(),
      });
      if (!lease) throw new Error("test lease missing");
      expect(
        await billing.applySubscription(
          {
            id: subscriptionId,
            customerId,
            status,
            tier,
            periodStart: T0,
            periodEnd: "2026-10-25T12:00:00.000Z",
          },
          lease,
          now,
        ),
      ).toBe(true);
      await billing.releaseLease(lease);
    }

    await applySnapshot("canceled", "pro", "2026-09-25T12:00:01.000Z", "lease_owner_canceled_1");
    await db
      .prepare(
        `INSERT INTO entitlement_grants (account_id, tier, source, granted_by, reason, granted_at)
         VALUES (?1, 'owner', 'grant', 'operator:test', 'owner', ?2)`,
      )
      .bind(accountId, "2026-09-25T12:00:02.000Z")
      .run();

    await applySnapshot("active", "max", "2026-09-25T12:00:03.000Z", "lease_owner_upgrade_01");
    expect((await resolveEntitlement(d1Store(db), accountId, new Date("2026-09-25T12:00:04.000Z"))).tier).toBe("owner");
    await applySnapshot("active", "pro", "2026-09-25T12:00:05.000Z", "lease_owner_downgrade1");
    expect((await resolveEntitlement(d1Store(db), accountId, new Date("2026-09-25T12:00:06.000Z"))).tier).toBe("owner");
    await applySnapshot("canceled", "pro", "2026-09-25T12:00:07.000Z", "lease_owner_canceled_2");

    expect((await resolveEntitlement(d1Store(db), accountId, new Date("2026-09-25T12:00:08.000Z"))).tier).toBe("owner");
    expect(
      await db
        .prepare(
          `SELECT tier, source, expires_at, revoked_at, billing_subscription_id
           FROM entitlement_grants WHERE account_id = ?1 AND tier = 'owner'`,
        )
        .bind(accountId)
        .first(),
    ).toEqual({
      tier: "owner",
      source: "grant",
      expires_at: null,
      revoked_at: null,
      billing_subscription_id: null,
    });
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS active FROM entitlement_grants WHERE billing_subscription_id = ?1 AND revoked_at IS NULL",
        )
        .bind(subscriptionId)
        .first(),
    ).toEqual({ active: 0 });
  });

  it("refuses OWNER while a returned Checkout remains open and preserves its cleanup handle", async () => {
    await db
      .prepare("INSERT INTO accounts (id, email, email_verified_at, created_at) VALUES (?1, ?2, ?3, ?3)")
      .bind("acct_owner_open_checkout", "owner-open-checkout@example.com", T0)
      .run();
    const store = d1BillingStore(db);
    await store.reserveCheckout({
      accountId: "acct_owner_open_checkout",
      tier: "pro",
      requestHash: "h".repeat(43),
      idempotencyKey: "checkout_owner_open",
      now: T0,
      expiresAt: "2026-09-25T12:35:00.000Z",
    });
    expect(
      await store.finalizeCheckout({
        accountId: "acct_owner_open_checkout",
        tier: "pro",
        requestHash: "h".repeat(43),
        stripeSessionId: "cs_owner_open",
        now: "2026-09-25T12:00:01.000Z",
      }),
    ).toBe(true);
    await expect(
      db
        .prepare(
          `INSERT INTO entitlement_grants (account_id, tier, source, granted_by, reason, granted_at)
           VALUES (?1, 'owner', 'grant', 'operator:test', 'owner', ?2)`,
        )
        .bind("acct_owner_open_checkout", "2026-09-25T12:00:02.000Z")
        .run(),
    ).rejects.toThrow(/OWNER grant requires/);
    expect(
      await db
        .prepare("SELECT stripe_checkout_session_id FROM billing_checkout_intents WHERE account_id = ?1")
        .bind("acct_owner_open_checkout")
        .first(),
    ).toEqual({ stripe_checkout_session_id: "cs_owner_open" });
  });

  it("moves an open Checkout into a durable invalidation outbox when a subscription activates", async () => {
    await db
      .prepare("INSERT INTO accounts (id, email, email_verified_at, created_at) VALUES (?1, ?2, ?3, ?3)")
      .bind("acct_subscription_cleanup", "subscription-cleanup@example.com", T0)
      .run();
    const store = d1BillingStore(db);
    await store.reserveCustomer({
      accountId: "acct_subscription_cleanup",
      idempotencyKey: "customer_subscription_cleanup",
      now: T0,
    });
    expect(await store.bindCustomer("acct_subscription_cleanup", "cus_cleanup101", T0)).toBe(true);
    await store.reserveCheckout({
      accountId: "acct_subscription_cleanup",
      tier: "max",
      requestHash: "j".repeat(43),
      idempotencyKey: "checkout_subscription_cleanup",
      now: T0,
      expiresAt: "2026-09-25T12:35:00.000Z",
    });
    expect(
      await store.finalizeCheckout({
        accountId: "acct_subscription_cleanup",
        tier: "max",
        requestHash: "j".repeat(43),
        stripeSessionId: "cs_subscription_cleanup",
        now: "2026-09-25T12:00:01.000Z",
      }),
    ).toBe(true);
    const lease = await store.acquireLease({
      subscriptionId: "sub_cleanup101",
      token: "lease_cleanup_0000001",
      now: "2026-09-25T12:00:02.000Z",
      expiresAt: "2026-09-25T12:01:02.000Z",
    });
    if (!lease) throw new Error("test lease missing");
    expect(
      await store.applySubscription(
        {
          id: "sub_cleanup101",
          customerId: "cus_cleanup101",
          status: "active",
          tier: "max",
          periodStart: T0,
          periodEnd: "2026-10-25T12:00:00.000Z",
        },
        lease,
        "2026-09-25T12:00:03.000Z",
      ),
    ).toBe(true);
    await expect(store.pendingCheckoutInvalidations("sub_cleanup101")).resolves.toEqual(["cs_subscription_cleanup"]);
    await expect(
      store.completeCheckoutInvalidation("sub_cleanup101", "cs_subscription_cleanup", "2026-09-25T12:00:04.000Z"),
    ).resolves.toBe(true);
    await expect(store.pendingCheckoutInvalidations("sub_cleanup101")).resolves.toEqual([]);
  });

  it("fences an expired worker and applies only the newest subscription snapshot", async () => {
    const store = d1BillingStore(db);
    const oldLease = await store.acquireLease({
      subscriptionId: "sub_fencing101",
      token: "lease_old_0000000001",
      now: T0,
      expiresAt: "2026-09-25T12:00:30.000Z",
    });
    expect(oldLease?.version).toBe(1);
    expect(
      await store.acquireLease({
        subscriptionId: "sub_fencing101",
        token: "lease_early_000001",
        now: "2026-09-25T12:00:10.000Z",
        expiresAt: "2026-09-25T12:00:40.000Z",
      }),
    ).toBeNull();
    const currentLease = await store.acquireLease({
      subscriptionId: "sub_fencing101",
      token: "lease_new_0000000001",
      now: "2026-09-25T12:00:31.000Z",
      expiresAt: "2026-09-25T12:01:01.000Z",
    });
    expect(currentLease?.version).toBe(2);
    if (!oldLease || !currentLease) throw new Error("test lease missing");
    const oldSnapshot: StripeSubscriptionSnapshot = {
      id: "sub_fencing101",
      customerId: "cus_customer101",
      status: "active",
      tier: "pro",
      periodStart: T0,
      periodEnd: "2026-10-25T12:00:00.000Z",
    };
    expect(await store.applySubscription(oldSnapshot, oldLease, "2026-09-25T12:00:32.000Z")).toBe(false);
    expect(
      await store.applySubscription({ ...oldSnapshot, tier: "max" }, currentLease, "2026-09-25T12:00:32.000Z"),
    ).toBe(true);
    const row = await db
      .prepare(
        "SELECT tier, billing_subscription_id, revoked_at FROM entitlement_grants WHERE billing_subscription_id = ?1",
      )
      .bind("sub_fencing101")
      .first<{ tier: string; billing_subscription_id: string; revoked_at: string | null }>();
    expect(row).toEqual({ tier: "max", billing_subscription_id: "sub_fencing101", revoked_at: null });
    const account = await db
      .prepare("SELECT activated_at FROM accounts WHERE id = ?1")
      .bind("acct_subject_101")
      .first<{ activated_at: string | null }>();
    expect(account?.activated_at).toBe("2026-09-25T12:00:32.000Z");
  });

  it("keeps the fencing version monotonic across release and rejects an old lease", async () => {
    const store = d1BillingStore(db);
    const first = await store.acquireLease({
      subscriptionId: "sub_monotonic101",
      token: "lease_monotonic_0001",
      now: T0,
      expiresAt: "2026-09-25T12:00:30.000Z",
    });
    if (!first) throw new Error("test lease missing");
    expect(first.version).toBe(1);
    await store.releaseLease(first);
    const second = await store.acquireLease({
      subscriptionId: "sub_monotonic101",
      token: "lease_monotonic_0002",
      now: "2026-09-25T12:00:01.000Z",
      expiresAt: "2026-09-25T12:00:31.000Z",
    });
    if (!second) throw new Error("test lease missing");
    expect(second.version).toBe(2);
    const snapshot: StripeSubscriptionSnapshot = {
      id: "sub_monotonic101",
      customerId: "cus_customer101",
      status: "active",
      tier: "pro",
      periodStart: T0,
      periodEnd: "2026-10-25T12:00:00.000Z",
    };
    expect(await store.applySubscription(snapshot, first, "2026-09-25T12:00:02.000Z")).toBe(false);
    await store.releaseLease(first);
    expect(await store.applySubscription(snapshot, second, "2026-09-25T12:00:02.000Z")).toBe(true);
  });

  it("keeps a renewing subscription paid past its period end until the renewal grace runs out", async () => {
    await db
      .prepare("INSERT INTO accounts (id, email, email_verified_at, created_at) VALUES (?1, ?2, ?3, ?3)")
      .bind("acct_renewal_grace", "renewal-grace@example.com", T0)
      .run();
    const store = d1BillingStore(db);
    await store.reserveCustomer({ accountId: "acct_renewal_grace", idempotencyKey: "customer_renewal_grace", now: T0 });
    expect(await store.bindCustomer("acct_renewal_grace", "cus_renewal101", T0)).toBe(true);
    const lease = await store.acquireLease({
      subscriptionId: "sub_renewal101",
      token: "lease_renewal_0000001",
      now: "2026-09-25T12:00:01.000Z",
      expiresAt: "2026-09-25T12:00:31.000Z",
    });
    if (!lease) throw new Error("test lease missing");
    const periodEnd = "2026-10-25T12:00:00.000Z";
    expect(
      await store.applySubscription(
        {
          id: "sub_renewal101",
          customerId: "cus_renewal101",
          status: "active",
          tier: "pro",
          periodStart: T0,
          periodEnd,
        },
        lease,
        "2026-09-25T12:00:02.000Z",
      ),
    ).toBe(true);
    const at = (offsetMs: number) => new Date(Date.parse(periodEnd) + offsetMs);
    // The renewal webhook has not landed yet: the account stays paid just after period end.
    expect((await resolveEntitlement(d1Store(db), "acct_renewal_grace", at(1_000))).tier).toBe("pro");
    expect((await resolveEntitlement(d1Store(db), "acct_renewal_grace", at(71 * 3_600_000))).tier).toBe("pro");
    // A renewal that never arrives ends the grant once the 72-hour grace is over.
    expect((await resolveEntitlement(d1Store(db), "acct_renewal_grace", at(73 * 3_600_000))).tier).toBe("free");
  });

  it("revokes a subscription grant when Stripe's current snapshot is inactive", async () => {
    const store = d1BillingStore(db);
    const lease = await store.acquireLease({
      subscriptionId: "sub_fencing101",
      token: "lease_cancel_0000001",
      now: "2026-09-25T12:01:02.000Z",
      expiresAt: "2026-09-25T12:01:32.000Z",
    });
    if (!lease) throw new Error("test lease missing");
    expect(
      await store.applySubscription(
        {
          id: "sub_fencing101",
          customerId: "cus_customer101",
          status: "canceled",
          tier: "max",
          periodStart: T0,
          periodEnd: "2026-10-25T12:00:00.000Z",
        },
        lease,
        "2026-09-25T12:01:03.000Z",
      ),
    ).toBe(true);
    const row = await db
      .prepare("SELECT revoked_at FROM entitlement_grants WHERE billing_subscription_id = ?1")
      .bind("sub_fencing101")
      .first<{ revoked_at: string | null }>();
    expect(row?.revoked_at).toBe("2026-09-25T12:01:03.000Z");
  });

  it("refuses to swap an existing subscription onto another customer or account", async () => {
    await db
      .prepare("INSERT INTO accounts (id, email, email_verified_at, created_at) VALUES (?1, ?2, ?3, ?3)")
      .bind("acct_subject_303", "other@example.com", T0)
      .run();
    const store = d1BillingStore(db);
    await store.reserveCustomer({ accountId: "acct_subject_303", idempotencyKey: "idem_customer_303", now: T0 });
    await store.bindCustomer("acct_subject_303", "cus_customer303", T0);
    const lease = await store.acquireLease({
      subscriptionId: "sub_fencing101",
      token: "lease_swap_00000001",
      now: "2026-09-25T12:01:33.000Z",
      expiresAt: "2026-09-25T12:02:03.000Z",
    });
    if (!lease) throw new Error("test lease missing");
    expect(
      await store.applySubscription(
        {
          id: "sub_fencing101",
          customerId: "cus_customer303",
          status: "active",
          tier: "max2x",
          periodStart: T0,
          periodEnd: "2026-10-25T12:00:00.000Z",
        },
        lease,
        "2026-09-25T12:01:34.000Z",
      ),
    ).toBe(false);
    const row = await db
      .prepare(
        "SELECT account_id, stripe_customer_id, tier FROM billing_subscriptions WHERE stripe_subscription_id = ?1",
      )
      .bind("sub_fencing101")
      .first<{ account_id: string; stripe_customer_id: string; tier: string }>();
    expect(row).toEqual({ account_id: "acct_subject_101", stripe_customer_id: "cus_customer101", tier: "max" });
    expect(
      await store.revokeInvalidSubscription("sub_fencing101", "cus_customer303", lease, "2026-09-25T12:01:35.000Z"),
    ).toBe(true);
    const quarantined = await db
      .prepare(
        "SELECT account_id, stripe_customer_id, tier, status FROM billing_subscriptions WHERE stripe_subscription_id = ?1",
      )
      .bind("sub_fencing101")
      .first<{ account_id: string; stripe_customer_id: string; tier: string | null; status: string }>();
    expect(quarantined).toEqual({
      account_id: "acct_subject_101",
      stripe_customer_id: "cus_customer101",
      tier: null,
      status: "invalid",
    });
  });

  it("revokes and audits an active grant when a retrieved subscription snapshot is invalid", async () => {
    const store = d1BillingStore(db);
    const lease = await store.acquireLease({
      subscriptionId: "sub_invalid_snapshot",
      token: "lease_invalid_000001",
      now: "2026-09-25T12:02:04.000Z",
      expiresAt: "2026-09-25T12:02:34.000Z",
    });
    if (!lease) throw new Error("test lease missing");
    await db
      .prepare(
        "INSERT INTO entitlement_grants (account_id, tier, source, granted_by, reason, granted_at, expires_at, billing_subscription_id) VALUES (?1, 'pro', 'billing', 'billing', 'test', ?2, ?3, ?4)",
      )
      .bind("acct_subject_101", T0, "2026-10-25T12:00:00.000Z", "sub_invalid_snapshot")
      .run();
    expect(
      await store.revokeInvalidSubscription(
        "sub_invalid_snapshot",
        "cus_customer101",
        lease,
        "2026-09-25T12:02:05.000Z",
      ),
    ).toBe(true);
    const grant = await db
      .prepare(
        "SELECT revoked_at, revoke_reason FROM entitlement_grants WHERE billing_subscription_id = 'sub_invalid_snapshot'",
      )
      .first<{ revoked_at: string; revoke_reason: string }>();
    expect(grant).toEqual({
      revoked_at: "2026-09-25T12:02:05.000Z",
      revoke_reason: "subscription snapshot invalid",
    });
    const audit = await db
      .prepare(
        "SELECT action FROM audit_log WHERE account_id = 'acct_subject_101' AND action = 'entitlement.revoked' ORDER BY id DESC",
      )
      .first<{ action: string }>();
    expect(audit).toEqual({ action: "entitlement.revoked" });
  });

  it("quarantines a first invalid live subscription and blocks another Checkout", async () => {
    await db
      .prepare("INSERT INTO accounts (id, email, email_verified_at, created_at) VALUES (?1, ?2, ?3, ?3)")
      .bind("acct_invalid_404", "invalid404@example.com", T0)
      .run();
    const store = d1BillingStore(db);
    await store.reserveCustomer({
      accountId: "acct_invalid_404",
      idempotencyKey: "idem_invalid_customer_404",
      now: T0,
    });
    await store.bindCustomer("acct_invalid_404", "cus_invalid404", T0);
    const lease = await store.acquireLease({
      subscriptionId: "sub_invalid404",
      token: "lease_invalid_404001",
      now: T0,
      expiresAt: "2026-09-25T12:00:30.000Z",
    });
    if (!lease) throw new Error("test lease missing");
    expect(
      await store.revokeInvalidSubscription("sub_invalid404", "cus_invalid404", lease, "2026-09-25T12:00:01.000Z"),
    ).toBe(true);
    const row = await db
      .prepare("SELECT tier, status FROM billing_subscriptions WHERE stripe_subscription_id = ?1")
      .bind("sub_invalid404")
      .first<{ tier: string | null; status: string }>();
    expect(row).toEqual({ tier: null, status: "invalid" });
    expect(
      await store.reserveCheckout({
        accountId: "acct_invalid_404",
        tier: "pro",
        requestHash: "i".repeat(43),
        idempotencyKey: "checkout_invalid_404",
        now: "2026-09-25T12:01:00.000Z",
        expiresAt: "2026-09-25T12:36:00.000Z",
      }),
    ).toEqual({ status: "subscribed" });
  });
});
