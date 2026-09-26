import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { d1AccountStore } from "../../worker/lib/account-store";
import { sha256Base64Url } from "../../worker/lib/crypto";
import { resolveEntitlement } from "../../worker/lib/entitlement";
import { openIdAuthService } from "../../worker/lib/openid-auth-routes";
import { d1Store } from "../../worker/lib/store";
import { openDatabase } from "../support/platform";
import { createMigratedDatabase, removeDatabase } from "../support/wrangler";

let persistTo: string;
let db: D1Database;
let dispose: () => Promise<void>;
const T0 = "2026-09-25T12:00:00.000Z";
const STATE = "z".repeat(43);
const NONCE = "n".repeat(43);
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

beforeAll(async () => {
  persistTo = createMigratedDatabase();
  ({ db, dispose } = await openDatabase(persistTo));
});

afterAll(async () => {
  await dispose?.();
  await removeDatabase(persistTo);
});

describe("D1 social OIDC authority", () => {
  it("stores only state and nonce hashes and consumes an attempt once for its exact provider", async () => {
    const store = d1AccountStore(db);
    await store.createOpenIdAttempt({
      stateHash: "s".repeat(43),
      provider: "google",
      codeChallenge: "c".repeat(43),
      nonceHash: "n".repeat(43),
      rateBucket: "r".repeat(43),
      createdAt: T0,
      expiresAt: "2026-09-25T12:10:00.000Z",
      clientKind: "desktop",
    });
    expect(await store.openIdAttempt("s".repeat(43), "microsoft")).toBeNull();
    expect(await store.openIdAttempt("s".repeat(43), "google")).toEqual({
      stateHash: "s".repeat(43),
      provider: "google",
      codeChallenge: "c".repeat(43),
      nonceHash: "n".repeat(43),
      clientKind: "desktop",
      expiresAt: "2026-09-25T12:10:00.000Z",
      consumedAt: null,
    });
    expect(
      await store.consumeOpenIdAttempt({
        stateHash: "s".repeat(43),
        provider: "google",
        codeChallenge: "c".repeat(43),
        nonceHash: "n".repeat(43),
        clientKind: "website",
        consumedAt: "2026-09-25T12:00:01.000Z",
      }),
    ).toBe(false);
    expect(
      await store.consumeOpenIdAttempt({
        stateHash: "s".repeat(43),
        provider: "google",
        codeChallenge: "c".repeat(43),
        nonceHash: "n".repeat(43),
        clientKind: "desktop",
        consumedAt: "2026-09-25T12:00:01.000Z",
      }),
    ).toBe(true);
    expect(
      await store.consumeOpenIdAttempt({
        stateHash: "s".repeat(43),
        provider: "google",
        codeChallenge: "c".repeat(43),
        nonceHash: "n".repeat(43),
        clientKind: "desktop",
        consumedAt: "2026-09-25T12:00:02.000Z",
      }),
    ).toBe(false);
  });

  it("creates and returns the same canonical account for a stable provider subject", async () => {
    const store = d1AccountStore(db);
    const input = {
      accountId: "acct_google_subject",
      provider: "google" as const,
      subject: "google-subject-123",
      email: "google@example.com",
      now: T0,
    };
    expect(await store.createOrGetOpenIdAccount(input)).toBe("acct_google_subject");

    await db.batch([
      db
        .prepare(
          `INSERT INTO billing_customers
             (account_id, stripe_customer_id, create_idempotency_key, created_at, updated_at)
           VALUES (?1, 'cus_social_restore', 'social-restore-customer', ?2, ?2)`,
        )
        .bind(input.accountId, T0),
      db
        .prepare(
          `INSERT INTO billing_subscriptions
             (stripe_subscription_id, account_id, stripe_customer_id, tier, status, period_start, period_end, reconciled_at)
           VALUES ('sub_social_restore', ?1, 'cus_social_restore', 'pro', 'active', ?2, ?3, ?2)`,
        )
        .bind(input.accountId, T0, "2026-10-25T12:00:00.000Z"),
      db
        .prepare(
          `INSERT INTO entitlement_grants
             (account_id, tier, source, granted_by, reason, granted_at, expires_at, billing_subscription_id)
           VALUES (?1, 'pro', 'billing', 'stripe', 'subscription reconciliation', ?2, ?3, 'sub_social_restore')`,
        )
        .bind(input.accountId, T0, "2026-10-25T12:00:00.000Z"),
      db.prepare("UPDATE accounts SET activated_at = ?2 WHERE id = ?1").bind(input.accountId, T0),
    ]);

    expect(await store.createOrGetOpenIdAccount({ ...input, accountId: "acct_wrong" })).toBe("acct_google_subject");
    expect(await store.identityAccount("google", input.subject)).toBe("acct_google_subject");
    expect(await store.accountProfile("acct_google_subject")).toMatchObject({
      email: "google@example.com",
      activatedAt: T0,
    });
    expect(await resolveEntitlement(d1Store(db), "acct_google_subject", new Date(T0))).toMatchObject({ tier: "pro" });
    expect(await db.prepare("SELECT id FROM accounts WHERE id = 'acct_wrong'").first()).toBeNull();
  });

  it("refuses implicit identity linking when a verified email already belongs to another account", async () => {
    const store = d1AccountStore(db);
    await db
      .prepare(
        `INSERT INTO accounts (id, email, email_verified_at, created_at)
         VALUES ('acct_email_owner', 'existing@example.com', ?1, ?1)`,
      )
      .bind(T0)
      .run();
    expect(
      await store.createOrGetOpenIdAccount({
        accountId: "acct_microsoft_collision",
        provider: "microsoft",
        subject: "aaaabbbb-0000-cccc-1111-dddd2222eeee:subject",
        email: "EXISTING@example.com",
        now: T0,
      }),
    ).toBeNull();
    expect(await store.identityAccount("microsoft", "aaaabbbb-0000-cccc-1111-dddd2222eeee:subject")).toBeNull();
    expect(await store.accountProfile("acct_email_owner")).toMatchObject({ email: "existing@example.com" });
    expect(await db.prepare("SELECT id FROM accounts WHERE id = 'acct_microsoft_collision'").first()).toBeNull();
  });

  it("updates email only for the same provider subject and revokes its older sessions", async () => {
    const store = d1AccountStore(db);
    await store.createSession({
      tokenHash: "t".repeat(43),
      accountId: "acct_google_subject",
      createdAt: T0,
      expiresAt: "2026-10-25T12:00:00.000Z",
      clientKind: "website",
    });
    expect(
      await store.createOrGetOpenIdAccount({
        accountId: "acct_unused",
        provider: "google",
        subject: "google-subject-123",
        email: "google-renamed@example.com",
        now: "2026-09-25T12:01:00.000Z",
      }),
    ).toBe("acct_google_subject");
    expect(await store.accountProfile("acct_google_subject")).toMatchObject({
      email: "google-renamed@example.com",
    });
    expect(await store.activeSession("t".repeat(43), "2026-09-25T12:01:01.000Z")).toBeNull();
  });

  it("converges concurrent creation of one Microsoft subject to one account", async () => {
    const store = d1AccountStore(db);
    const subject = "aaaabbbb-0000-cccc-1111-dddd2222eeee:race-subject";
    const [first, second] = await Promise.all([
      store.createOrGetOpenIdAccount({
        accountId: "acct_ms_race_one",
        provider: "microsoft",
        subject,
        email: "ms-race@example.com",
        now: "2026-09-25T12:02:00.000Z",
      }),
      store.createOrGetOpenIdAccount({
        accountId: "acct_ms_race_two",
        provider: "microsoft",
        subject,
        email: "ms-race@example.com",
        now: "2026-09-25T12:02:01.000Z",
      }),
    ]);
    expect(first).not.toBeNull();
    expect(second).toBe(first);
    expect(await store.identityAccount("microsoft", subject)).toBe(first);
    expect(
      await db
        .prepare("SELECT COUNT(*) AS count FROM account_identities WHERE provider = 'microsoft' AND subject = ?1")
        .bind(subject)
        .first<{ count: number }>(),
    ).toEqual({ count: 1 });
  });

  it("allows only one provider exchange and session when a completion is replayed concurrently", async () => {
    const store = d1AccountStore(db);
    await store.createOpenIdAttempt({
      stateHash: await sha256Base64Url(STATE),
      provider: "google",
      codeChallenge: CHALLENGE,
      nonceHash: await sha256Base64Url(NONCE),
      rateBucket: "q".repeat(43),
      createdAt: T0,
      expiresAt: "2026-09-25T12:10:00.000Z",
      clientKind: "website",
    });
    const exchangeIdentity = vi.fn(async () => ({
      provider: "google" as const,
      subject: "google-replay-subject",
      email: "google-replay@example.com",
    }));
    const auth = openIdAuthService({
      store,
      clients: {
        google: {
          provider: "google",
          clientId: "google-client.apps.googleusercontent.com",
          clientSecret: "google-client-secret-for-tests",
          callbackUrl: "https://api.kalcoded.com/v1/auth/google/callback",
        },
      },
      rateLimitKey: "r".repeat(32),
      now: () => new Date(T0),
      exchangeIdentity,
    });
    const request = () =>
      new Request("https://api.kalcoded.com/v1/auth/google/complete", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "203.0.113.10",
          origin: "https://kalcoded.com",
        },
        body: JSON.stringify({ state: STATE, code: "one-use-code", codeVerifier: VERIFIER, nonce: NONCE }),
      });

    const responses = await Promise.all([auth.complete(request(), "google"), auth.complete(request(), "google")]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 400]);
    expect(responses.filter((response) => response.ok)[0]?.headers.get("set-cookie")).toContain(
      "__Host-kalcode_session=",
    );
    expect(exchangeIdentity).toHaveBeenCalledTimes(1);
    expect(
      await db
        .prepare("SELECT COUNT(*) AS count FROM account_sessions WHERE account_id = ?1")
        .bind(`acct_${await sha256Base64Url("google:google-replay-subject")}`)
        .first<{ count: number }>(),
    ).toEqual({ count: 1 });
  });
});
