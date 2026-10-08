/**
 * KalCode games against a real local D1 (migration 0012) and the production game service, with
 * Stripe replaced by an in-memory fake at the HTTP boundary (`fetcher`). Covers the ownership
 * policy (ENTITLEMENTS.md §2), perk claims, the device sign-in, licenses and downloads.
 */
import { GAME_LICENSE_TTL_SECONDS } from "@kalcode/protocol/games";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hmacSha256Hex } from "../../worker/lib/crypto";
import { verifyGameLicense } from "../../worker/lib/game-license";
import { type GameBilling, type GameBuildsBucket, type GameService, gameService } from "../../worker/lib/game-routes";
import { d1GameStore } from "../../worker/lib/game-store";
import { d1Store } from "../../worker/lib/store";
import { gameStripeClient } from "../../worker/lib/stripe";
import { generateSigningKey } from "../support/keys";
import { openDatabase } from "../support/platform";
import { createMigratedDatabase, removeDatabase } from "../support/wrangler";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-10-08T12:00:00.000Z");
const SITE = "https://kalcoded.com";
const WEBHOOK_SECRET = "whsec_test_games";
const PRICE_GAME = "price_game_ku";
const PRICE_PRO = "price_pro_month";
const PRICE_MAX = "price_max_month";
const PRICE_MAX2X = "price_max2x_year";

let persistTo: string;
let db: D1Database;
let dispose: () => Promise<void>;
let signer: Awaited<ReturnType<typeof generateSigningKey>>;
let clock = T0;
let eventSeq = 0;

// ---------------------------------------------------------------------------------- fake Stripe

interface FakeStripe {
  invoices: Record<string, Record<string, unknown>>;
  sessions: Record<string, Record<string, unknown>>;
  charges: Record<string, Record<string, unknown>[]>;
  disputes: Record<string, Record<string, unknown>[]>;
  refunds: { paymentIntent: string; key: string }[];
  checkouts: Record<string, string>[];
  calls: string[];
}

const stripe: FakeStripe = { invoices: {}, sessions: {}, charges: {}, disputes: {}, refunds: [], checkouts: [], calls: [] };

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

const fakeFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  stripe.calls.push(`${method} ${url.pathname}`);
  const pi = url.searchParams.get("payment_intent") ?? "";
  if (method === "GET" && url.pathname.startsWith("/v1/invoices/")) {
    const invoice = stripe.invoices[decodeURIComponent(url.pathname.slice("/v1/invoices/".length))];
    return invoice ? jsonResponse(invoice) : jsonResponse({ error: {} }, 404);
  }
  if (method === "GET" && url.pathname.startsWith("/v1/checkout/sessions/")) {
    const session = stripe.sessions[decodeURIComponent(url.pathname.slice("/v1/checkout/sessions/".length))];
    return session ? jsonResponse(session) : jsonResponse({ error: {} }, 404);
  }
  if (method === "GET" && url.pathname === "/v1/charges") {
    return jsonResponse({ object: "list", data: stripe.charges[pi] ?? [], has_more: false });
  }
  if (method === "GET" && url.pathname === "/v1/disputes") {
    return jsonResponse({ object: "list", data: stripe.disputes[pi] ?? [], has_more: false });
  }
  if (method === "POST" && url.pathname === "/v1/checkout/sessions") {
    const params = Object.fromEntries(new URLSearchParams(String(init?.body)));
    stripe.checkouts.push(params);
    return jsonResponse({ id: "cs_test_created", url: "https://checkout.stripe.com/c/pay/cs_test_created", livemode: false });
  }
  if (method === "POST" && url.pathname === "/v1/refunds") {
    const params = Object.fromEntries(new URLSearchParams(String(init?.body)));
    stripe.refunds.push({
      paymentIntent: params.payment_intent ?? "",
      key: (init?.headers as Record<string, string>)["Idempotency-Key"] ?? "",
    });
    return jsonResponse({ id: "re_test_1", livemode: false });
  }
  return jsonResponse({ error: { message: "unexpected" } }, 400);
};

const unix = (ms: number) => Math.floor(ms / 1000);

function paidCharge(pi: string, extra: Record<string, unknown> = {}) {
  stripe.charges[pi] = [
    { id: `ch_${pi.slice(3)}`, livemode: false, status: "succeeded", refunded: false, refunds: { data: [] }, ...extra },
  ];
}

function refundCharge(pi: string, atMs: number, reason: string | null = null) {
  paidCharge(pi, {
    refunded: true,
    refunds: { data: [{ id: `re_${pi.slice(3)}`, status: "succeeded", created: unix(atMs), reason }] },
  });
}

function invoice(id: string, input: { customer: string; price: string; amount: number; pi: string | null; paidAtMs: number }) {
  stripe.invoices[id] = {
    id,
    object: "invoice",
    livemode: false,
    status: "paid",
    amount_paid: input.amount,
    currency: "usd",
    customer: input.customer,
    parent: { type: "subscription_details", subscription_details: { subscription: "sub_x" } },
    lines: {
      data: [{ amount: input.amount, quantity: 1, pricing: { type: "price_details", price_details: { price: input.price } } }],
    },
    payments: {
      data: input.pi ? [{ status: "paid", amount_paid: input.amount, payment: { type: "payment_intent", payment_intent: input.pi } }] : [],
    },
    status_transitions: { paid_at: unix(input.paidAtMs) },
  };
  if (input.pi && !stripe.charges[input.pi]) paidCharge(input.pi);
}

function session(id: string, input: { account: string; pi: string; country?: string; price?: string; game?: string }) {
  stripe.sessions[id] = {
    id,
    object: "checkout.session",
    livemode: false,
    mode: "payment",
    status: "complete",
    payment_status: "paid",
    client_reference_id: input.account,
    metadata: { kalcode_game: input.game ?? "kal_university", kalcode_account_id: input.account },
    line_items: { data: [{ quantity: 1, price: { id: input.price ?? PRICE_GAME } }] },
    amount_total: 500,
    currency: "usd",
    payment_intent: input.pi,
    customer_details: { address: { country: input.country ?? "US" } },
  };
  if (!stripe.charges[input.pi]) paidCharge(input.pi);
}

// ---------------------------------------------------------------------------------- harness

const memoryBuilds: Record<string, Uint8Array> = {};
const builds: GameBuildsBucket = {
  async head(key) {
    const bytes = memoryBuilds[key];
    return bytes ? { size: bytes.byteLength, httpEtag: '"etag"' } : null;
  },
  async get(key, options) {
    const bytes = memoryBuilds[key];
    if (!bytes) return null;
    const range = options?.range as { offset: number; length?: number } | undefined;
    const slice = range ? bytes.slice(range.offset, range.offset + (range.length ?? bytes.byteLength)) : bytes;
    return {
      body: new Response(slice).body as ReadableStream,
      size: bytes.byteLength,
      text: async () => new TextDecoder().decode(bytes),
    };
  },
};

function billing(overrides: Partial<GameBilling> = {}): GameBilling {
  return {
    stripe: gameStripeClient({ secretKey: "rk_test_games", mode: "test", fetcher: fakeFetch }),
    webhookSecret: WEBHOOK_SECRET,
    standalonePrices: { kal_university: PRICE_GAME },
    planPrices: { [PRICE_PRO]: "pro", [PRICE_MAX]: "max", [PRICE_MAX2X]: "max2x" },
    checkoutEnabled: true,
    refundRevokeDays: 30,
    usOnly: true,
    ...overrides,
  };
}

function service(overrides: Partial<Parameters<typeof gameService>[0]> = {}): GameService {
  return gameService({
    store: d1GameStore(db),
    entitlements: d1Store(db),
    signingKey: async () => signer.key,
    previousPublicKeys: () => [],
    billing: billing(),
    builds,
    downloadSecret: "d".repeat(40),
    rateLimitKey: "r".repeat(40),
    now: () => new Date(clock),
    log: () => {},
    ...overrides,
  });
}

async function webhook(games: GameService, type: string, object: Record<string, unknown>, options: { id?: string; livemode?: boolean } = {}) {
  eventSeq += 1;
  const payload = JSON.stringify({
    id: options.id ?? `evt_test_${eventSeq}`,
    type,
    livemode: options.livemode ?? false,
    created: unix(clock),
    data: { object },
  });
  const t = unix(clock);
  const signature = await hmacSha256Hex(WEBHOOK_SECRET, `${t}.${payload}`);
  const response = await games.webhook(
    new Request("https://api.kalcoded.com/v1/games/webhook", {
      method: "POST",
      headers: { "stripe-signature": `t=${t},v1=${signature}`, "content-type": "application/json" },
      body: payload,
    }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function library(games: GameService, account: string) {
  const response = await games.library(account);
  const body = (await response.json()) as { games: Record<string, unknown>[] };
  return body.games[0] as {
    owned: boolean;
    source: string | null;
    perkTier: string | null;
    perks: { id: string; claimed: boolean; tier: string }[];
    revoked: { reason: string } | null;
    checkout: { open: boolean };
    downloads: { platform: string; available: boolean }[];
  };
}

function websitePost(path: string, body: unknown, origin: string | null = SITE) {
  return new Request(`https://api.kalcoded.com${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
    body: JSON.stringify(body),
  });
}

function gamePost(path: string, body: unknown, bearer?: string) {
  return new Request(`https://api.kalcoded.com${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify(body),
  });
}

async function addAccount(id: string, options: { customer?: string; deleted?: boolean } = {}) {
  await db
    .prepare("INSERT INTO accounts (id, email, email_verified_at, created_at, activated_at, deleted_at) VALUES (?1, ?2, ?3, ?3, ?3, ?4)")
    .bind(id, `${id}@example.com`, new Date(T0 - DAY).toISOString(), options.deleted ? new Date(T0).toISOString() : null)
    .run();
  if (options.customer) {
    await db
      .prepare(
        "INSERT INTO billing_customers (account_id, stripe_customer_id, create_idempotency_key, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
      )
      .bind(id, options.customer, `customer_${id}_key_000000`, new Date(T0).toISOString())
      .run();
  }
}

async function grantTier(account: string, tier: "pro" | "max" | "max2x", subscription: string) {
  await db
    .prepare(
      `INSERT INTO entitlement_grants (account_id, tier, source, granted_by, reason, granted_at, expires_at, billing_subscription_id)
       VALUES (?1, ?2, 'billing', 'stripe', 'subscription', ?3, ?4, ?5)`,
    )
    .bind(account, tier, new Date(clock).toISOString(), new Date(clock + 30 * DAY).toISOString(), subscription)
    .run();
}

async function endTier(subscription: string) {
  await db
    .prepare(
      "UPDATE entitlement_grants SET revoked_at = ?2, revoked_by = 'stripe', revoke_reason = 'canceled' WHERE billing_subscription_id = ?1 AND revoked_at IS NULL",
    )
    .bind(subscription, new Date(clock).toISOString())
    .run();
}

const count = async (sql: string, ...binds: unknown[]) =>
  ((await db.prepare(sql).bind(...binds).first<{ n: number }>())?.n ?? 0) as number;

beforeAll(async () => {
  persistTo = createMigratedDatabase();
  ({ db, dispose } = await openDatabase(persistTo));
  signer = await generateSigningKey("g-test-1");
});

afterAll(async () => {
  await dispose?.();
  await removeDatabase(persistTo);
});

beforeEach(() => {
  clock += DAY;
});

// ---------------------------------------------------------------------------------- tests

describe("lifetime ownership from a qualifying subscription payment", () => {
  it("grants on the first paid invoice and survives cancellation", async () => {
    await addAccount("acct_sub", { customer: "cus_subscr" });
    const games = service();
    expect((await library(games, "acct_sub")).owned).toBe(false);
    invoice("in_sub_1", { customer: "cus_subscr", price: PRICE_PRO, amount: 1000, pi: "pi_sub_1", paidAtMs: clock });
    await grantTier("acct_sub", "pro", "sub_sub");
    expect((await webhook(games, "invoice.paid", { id: "in_sub_1" })).status).toBe(200);
    let lib = await library(games, "acct_sub");
    expect(lib).toMatchObject({ owned: true, source: "pro", perkTier: "pro" });
    // Cancel: the subscription grant ends; ownership does not.
    clock += 40 * DAY;
    await endTier("sub_sub");
    lib = await library(games, "acct_sub");
    expect(lib.owned).toBe(true);
    expect(await count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'game.ownership_granted' AND account_id = ?1", "acct_sub")).toBe(1);
  });

  it("is idempotent for duplicate deliveries and repeated invoice events", async () => {
    const games = service();
    const first = await webhook(games, "invoice.paid", { id: "in_sub_1" }, { id: "evt_dup_1" });
    const again = await webhook(games, "invoice.paid", { id: "in_sub_1" }, { id: "evt_dup_1" });
    expect(first.status).toBe(200);
    expect(again.body).toMatchObject({ duplicate: true });
    await webhook(games, "invoice.paid", { id: "in_sub_1" });
    expect(await count("SELECT COUNT(*) AS n FROM game_payments WHERE account_id = 'acct_sub'")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM game_entitlements WHERE account_id = 'acct_sub'")).toBe(1);
  });

  it("never grants for a $0 trial invoice, a foreign Price, a credit-balance invoice or an unknown customer", async () => {
    await addAccount("acct_trial", { customer: "cus_trial" });
    const games = service();
    invoice("in_trial_0", { customer: "cus_trial", price: PRICE_PRO, amount: 0, pi: null, paidAtMs: clock });
    invoice("in_trial_foreign", { customer: "cus_trial", price: "price_other", amount: 900, pi: "pi_foreign", paidAtMs: clock });
    invoice("in_trial_balance", { customer: "cus_trial", price: PRICE_MAX, amount: 2500, pi: null, paidAtMs: clock });
    invoice("in_unknown", { customer: "cus_nobody", price: PRICE_MAX, amount: 2500, pi: "pi_unknown", paidAtMs: clock });
    for (const id of ["in_trial_0", "in_trial_foreign", "in_trial_balance", "in_unknown"]) {
      expect((await webhook(games, "invoice.paid", { id })).body).toMatchObject({ ignored: true });
    }
    expect((await library(games, "acct_trial")).owned).toBe(false);
    // The first invoice with money paid after the trial is the qualifying one.
    invoice("in_trial_1", { customer: "cus_trial", price: PRICE_PRO, amount: 1000, pi: "pi_trial_1", paidAtMs: clock });
    await webhook(games, "invoice.paid", { id: "in_trial_1" });
    expect((await library(games, "acct_trial")).owned).toBe(true);
  });

  it("counts an annual plan's first payment", async () => {
    await addAccount("acct_annual", { customer: "cus_annual" });
    const games = service();
    invoice("in_annual", { customer: "cus_annual", price: PRICE_MAX2X, amount: 50000, pi: "pi_annual", paidAtMs: clock });
    await webhook(games, "invoice.paid", { id: "in_annual" });
    expect(await library(games, "acct_annual")).toMatchObject({ owned: true, source: "max2x" });
  });
});

describe("refunds, chargebacks and fraud (pending owner approval: 30-day window)", () => {
  it("revokes on a full refund inside the window and restores on a later payment", async () => {
    await addAccount("acct_refund", { customer: "cus_refund" });
    const games = service();
    const paidAt = clock;
    invoice("in_refund_1", { customer: "cus_refund", price: PRICE_PRO, amount: 1000, pi: "pi_refund_1", paidAtMs: paidAt });
    await webhook(games, "invoice.paid", { id: "in_refund_1" });
    refundCharge("pi_refund_1", paidAt + 2 * DAY);
    clock = paidAt + 2 * DAY;
    await webhook(games, "charge.refunded", { id: "ch_refund_1", payment_intent: "pi_refund_1" });
    expect(await library(games, "acct_refund")).toMatchObject({ owned: false, revoked: { reason: "refund" } });
    invoice("in_refund_2", { customer: "cus_refund", price: PRICE_PRO, amount: 1000, pi: "pi_refund_2", paidAtMs: clock });
    await webhook(games, "invoice.paid", { id: "in_refund_2" });
    expect((await library(games, "acct_refund")).owned).toBe(true);
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM audit_log WHERE account_id = 'acct_refund' AND action IN ('game.ownership_revoked', 'game.ownership_restored')",
      ),
    ).toBe(2);
  });

  it("keeps ownership for a full refund after the window and for partial refunds", async () => {
    await addAccount("acct_late", { customer: "cus_late" });
    const games = service();
    const paidAt = clock;
    invoice("in_late", { customer: "cus_late", price: PRICE_MAX, amount: 2500, pi: "pi_late", paidAtMs: paidAt });
    await webhook(games, "invoice.paid", { id: "in_late" });
    paidCharge("pi_late", { amount_refunded: 500, refunded: false });
    await webhook(games, "charge.refunded", { id: "ch_late", payment_intent: "pi_late" });
    expect((await library(games, "acct_late")).owned).toBe(true);
    refundCharge("pi_late", paidAt + 45 * DAY);
    clock = paidAt + 45 * DAY;
    await webhook(games, "charge.refunded", { id: "ch_late", payment_intent: "pi_late" });
    expect((await library(games, "acct_late")).owned).toBe(true);
    expect(await count("SELECT COUNT(*) AS n FROM game_payments WHERE payment_intent = 'pi_late' AND status = 'refunded_late'")).toBe(1);
  });

  it("revokes on a lost dispute or a fraudulent refund at any time, never on a won dispute", async () => {
    await addAccount("acct_dispute", { customer: "cus_dispute" });
    await addAccount("acct_fraud", { customer: "cus_fraud" });
    const games = service();
    const paidAt = clock;
    invoice("in_dispute", { customer: "cus_dispute", price: PRICE_PRO, amount: 1000, pi: "pi_dispute", paidAtMs: paidAt });
    invoice("in_fraud", { customer: "cus_fraud", price: PRICE_PRO, amount: 1000, pi: "pi_fraud", paidAtMs: paidAt });
    await webhook(games, "invoice.paid", { id: "in_dispute" });
    await webhook(games, "invoice.paid", { id: "in_fraud" });
    clock = paidAt + 90 * DAY;
    stripe.disputes.pi_dispute = [{ id: "dp_1", livemode: false, status: "won" }];
    await webhook(games, "charge.dispute.closed", { id: "dp_1", payment_intent: "pi_dispute" });
    expect((await library(games, "acct_dispute")).owned).toBe(true);
    stripe.disputes.pi_dispute = [{ id: "dp_1", livemode: false, status: "lost" }];
    await webhook(games, "charge.dispute.closed", { id: "dp_1", payment_intent: "pi_dispute" });
    expect(await library(games, "acct_dispute")).toMatchObject({ owned: false, revoked: { reason: "dispute_lost" } });
    refundCharge("pi_fraud", clock, "fraudulent");
    await webhook(games, "charge.refunded", { id: "ch_fraud", payment_intent: "pi_fraud" });
    expect(await library(games, "acct_fraud")).toMatchObject({ owned: false, revoked: { reason: "fraud" } });
  });

  it("keeps ownership while another counting payment remains", async () => {
    await addAccount("acct_two", { customer: "cus_twopay" });
    const games = service();
    const paidAt = clock;
    invoice("in_two_1", { customer: "cus_twopay", price: PRICE_PRO, amount: 1000, pi: "pi_two_1", paidAtMs: paidAt });
    invoice("in_two_2", { customer: "cus_twopay", price: PRICE_PRO, amount: 1000, pi: "pi_two_2", paidAtMs: paidAt + DAY });
    await webhook(games, "invoice.paid", { id: "in_two_1" });
    await webhook(games, "invoice.paid", { id: "in_two_2" });
    refundCharge("pi_two_1", paidAt + 2 * DAY);
    await webhook(games, "charge.refunded", { id: "ch_two_1", payment_intent: "pi_two_1" });
    expect((await library(games, "acct_two")).owned).toBe(true);
  });

  it("does not lose a refund that Stripe delivers before the paid event", async () => {
    await addAccount("acct_order", { customer: "cus_order" });
    const games = service();
    invoice("in_order", { customer: "cus_order", price: PRICE_PRO, amount: 1000, pi: "pi_order", paidAtMs: clock });
    refundCharge("pi_order", clock + 60_000);
    expect((await webhook(games, "charge.refunded", { id: "ch_order", payment_intent: "pi_order" })).body).toMatchObject({
      ignored: true,
    });
    await webhook(games, "invoice.paid", { id: "in_order" });
    expect((await library(games, "acct_order")).owned).toBe(false);
    expect(await count("SELECT COUNT(*) AS n FROM game_payments WHERE payment_intent = 'pi_order' AND status = 'refunded'")).toBe(1);
  });
});

describe("the database refuses policy violations", () => {
  it("never revokes while a counting payment remains, never grants without one, never deletes", async () => {
    const now = new Date(clock).toISOString();
    await expect(
      db
        .prepare(
          "UPDATE game_entitlements SET status = 'revoked', revoked_at = ?1, revoked_reason = 'refund', updated_at = ?1 WHERE account_id = 'acct_sub'",
        )
        .bind(now)
        .run(),
    ).rejects.toThrow(/counting payment/);
    await addAccount("acct_free_ride");
    await expect(
      db
        .prepare(
          "INSERT INTO game_entitlements (account_id, game_id, source, granted_at, granting_payment_ref, status, updated_at) VALUES ('acct_free_ride', 'kal_university', 'pro', ?1, 'in_sub_1', 'active', ?1)",
        )
        .bind(now)
        .run(),
    ).rejects.toThrow();
    await expect(db.prepare("DELETE FROM game_entitlements WHERE account_id = 'acct_sub'").run()).rejects.toThrow(/cannot be deleted/);
    await expect(db.prepare("DELETE FROM game_payments WHERE account_id = 'acct_sub'").run()).rejects.toThrow(/cannot be deleted/);
  });
});

describe("standalone purchase", () => {
  it("opens Checkout only for accounts that do not own the game, with server-owned parameters", async () => {
    await addAccount("acct_buyer", { customer: "cus_buyer" });
    const games = service();
    const response = await games.checkout(websitePost("/v1/games/checkout", { gameId: "kal_university", requestId: "req-000001" }), "acct_buyer");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ url: "https://checkout.stripe.com/c/pay/cs_test_created" });
    expect(stripe.checkouts.at(-1)).toMatchObject({
      mode: "payment",
      "line_items[0][price]": PRICE_GAME,
      client_reference_id: "acct_buyer",
      customer: "cus_buyer",
      "metadata[kalcode_game]": "kal_university",
      "metadata[kalcode_account_id]": "acct_buyer",
      billing_address_collection: "required",
    });
    const owned = await games.checkout(websitePost("/v1/games/checkout", { gameId: "kal_university", requestId: "req-000002" }), "acct_sub");
    expect(owned.status).toBe(409);
    const foreign = await games.checkout(
      websitePost("/v1/games/checkout", { gameId: "kal_university", requestId: "req-000003" }, "https://evil.example"),
      "acct_buyer",
    );
    expect(foreign.status).toBe(403);
    const closed = service({ billing: billing({ checkoutEnabled: false }) });
    expect((await closed.checkout(websitePost("/v1/games/checkout", { gameId: "kal_university", requestId: "req-000004" }), "acct_buyer")).status).toBe(503);
  });

  it("grants ownership from a paid US session and auto-refunds a non-US one", async () => {
    await addAccount("acct_abroad");
    const games = service();
    session("cs_buyer", { account: "acct_buyer", pi: "pi_buyer" });
    session("cs_abroad", { account: "acct_abroad", pi: "pi_abroad", country: "DE" });
    session("cs_wrong", { account: "acct_abroad", pi: "pi_wrong", price: PRICE_PRO });
    await webhook(games, "checkout.session.completed", { id: "cs_buyer" });
    expect(await library(games, "acct_buyer")).toMatchObject({ owned: true, source: "standalone", perkTier: "standalone" });
    expect((await webhook(games, "checkout.session.completed", { id: "cs_abroad" })).status).toBe(200);
    expect(stripe.refunds).toContainEqual({ paymentIntent: "pi_abroad", key: "kalcode-game-region-refund-cs_abroad" });
    expect((await webhook(games, "checkout.session.completed", { id: "cs_wrong" })).body).toMatchObject({ ignored: true });
    expect((await library(games, "acct_abroad")).owned).toBe(false);
  });

  it("refuses bad signatures and ignores events from the other Stripe mode", async () => {
    const games = service();
    const response = await games.webhook(
      new Request("https://api.kalcoded.com/v1/games/webhook", {
        method: "POST",
        headers: { "stripe-signature": `t=${unix(clock)},v1=${"0".repeat(64)}` },
        body: "{}",
      }),
    );
    expect(response.status).toBe(400);
    stripe.calls.length = 0;
    expect((await webhook(games, "invoice.paid", { id: "in_sub_1" }, { livemode: true })).body).toMatchObject({ ignored: true });
    expect(stripe.calls).toEqual([]);
  });
});

describe("perks", () => {
  it("claims each tier's items once, adds only unclaimed extras on upgrade, and keeps them after cancellation", async () => {
    await addAccount("acct_perks", { customer: "cus_perks" });
    const games = service();
    invoice("in_perks", { customer: "cus_perks", price: PRICE_PRO, amount: 1000, pi: "pi_perks", paidAtMs: clock });
    await grantTier("acct_perks", "pro", "sub_perks_pro");
    await webhook(games, "invoice.paid", { id: "in_perks" });
    let lib = await library(games, "acct_perks");
    expect(lib.perkTier).toBe("pro");
    expect(lib.perks.filter((perk) => perk.claimed).map((perk) => perk.tier)).toEqual(["pro", "pro", "pro"]);
    await endTier("sub_perks_pro");
    await grantTier("acct_perks", "max", "sub_perks_max");
    lib = await library(games, "acct_perks");
    expect(lib.perkTier).toBe("max");
    expect(await count("SELECT COUNT(*) AS n FROM game_perk_claims WHERE account_id = 'acct_perks'")).toBe(6);
    // Resubscribing or viewing again claims nothing new.
    await library(games, "acct_perks");
    await endTier("sub_perks_max");
    await grantTier("acct_perks", "max", "sub_perks_max_again");
    await library(games, "acct_perks");
    expect(await count("SELECT COUNT(*) AS n FROM game_perk_claims WHERE account_id = 'acct_perks'")).toBe(6);
    // After cancellation everything granted persists.
    await endTier("sub_perks_max_again");
    lib = await library(games, "acct_perks");
    expect(lib).toMatchObject({ owned: true, perkTier: "max" });
    expect(lib.perks.filter((perk) => perk.claimed)).toHaveLength(6);
    await expect(db.prepare("DELETE FROM game_perk_claims WHERE account_id = 'acct_perks'").run()).rejects.toThrow();
  });

  it("gives the OWNER account the game with MAX 2X perks without any payment", async () => {
    await addAccount("acct_owner");
    await db
      .prepare(
        "INSERT INTO entitlement_grants (account_id, tier, source, granted_by, reason, granted_at) VALUES ('acct_owner', 'owner', 'grant', 'operator:test', 'test', ?1)",
      )
      .bind(new Date(clock).toISOString())
      .run();
    const lib = await library(service(), "acct_owner");
    expect(lib).toMatchObject({ owned: true, source: "owner", perkTier: "max2x" });
    expect(lib.perks.every((perk) => perk.claimed)).toBe(true);
  });
});

describe("device sign-in and the signed license", () => {
  it("runs start → approve → token → refresh → sign-out", async () => {
    const games = service();
    const device = "D".repeat(43);
    const start = await games.startDevice(gamePost("/v1/games/device/start", { gameId: "kal_university", device }));
    expect(start.status).toBe(200);
    const started = (await start.json()) as { deviceCode: string; userCode: string; verificationUri: string; interval: number };
    expect(started.userCode).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    expect(started.verificationUri).toBe("https://kalcoded.com/games/activate");

    const poll = () => games.deviceToken(gamePost("/v1/games/device/token", { deviceCode: started.deviceCode }));
    expect(((await (await poll()).json()) as { error: string }).error).toBe("authorization_pending");
    expect(((await (await poll()).json()) as { error: string }).error).toBe("slow_down");

    // A non-owner cannot approve; the owner of the game can (lower-case, spaced input is fine).
    const notOwner = await games.approveDevice(websitePost("/v1/games/device/approve", { userCode: started.userCode }), "acct_abroad");
    expect(notOwner.status).toBe(403);
    const approved = await games.approveDevice(
      websitePost("/v1/games/device/approve", { userCode: started.userCode.toLowerCase().replace("-", " ") }),
      "acct_perks",
    );
    expect(approved.status).toBe(200);

    clock += 6000;
    const tokenResponse = await poll();
    expect(tokenResponse.status).toBe(200);
    const issued = (await tokenResponse.json()) as { license: string; refreshToken: string };
    const verified = await verifyGameLicense(issued.license, signer.trusted, unix(clock));
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.license).toMatchObject({ gameId: "kal_university", source: "pro", perkTier: "max", device });
    expect(verified.license.subject).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(verified.license.subject).not.toContain("acct_perks");
    expect(verified.license.expiresAt - verified.license.issuedAt).toBe(GAME_LICENSE_TTL_SECONDS);
    expect(verified.license.perks.reduce((sum, perk) => sum + perk.amountCents, 0)).toBe(10_000);

    clock += 6000;
    expect(((await (await poll()).json()) as { error: string }).error).toBe("invalid_grant");

    const refreshed = await games.refreshLicense(gamePost("/v1/games/license/refresh", {}, issued.refreshToken));
    expect(refreshed.status).toBe(200);
    const browser = await games.refreshLicense(
      new Request("https://api.kalcoded.com/v1/games/license/refresh", {
        method: "POST",
        headers: { authorization: `Bearer ${issued.refreshToken}`, origin: SITE },
      }),
    );
    expect(browser.status).toBe(403);
    await games.signOut(gamePost("/v1/games/license/sign-out", {}, issued.refreshToken));
    expect((await games.refreshLicense(gamePost("/v1/games/license/refresh", {}, issued.refreshToken))).status).toBe(401);
  });

  it("expires unused codes and stops licensing a revoked owner", async () => {
    const games = service();
    const start = (await (await games.startDevice(gamePost("/v1/games/device/start", { gameId: "kal_university" }))).json()) as {
      deviceCode: string;
      userCode: string;
    };
    await games.approveDevice(websitePost("/v1/games/device/approve", { userCode: start.userCode }), "acct_two");
    clock += 6000;
    const issued = (await (await games.deviceToken(gamePost("/v1/games/device/token", { deviceCode: start.deviceCode }))).json()) as {
      refreshToken: string;
    };
    refundCharge("pi_two_2", clock);
    await webhook(games, "charge.refunded", { id: "ch_two_2", payment_intent: "pi_two_2" });
    const refused = await games.refreshLicense(gamePost("/v1/games/license/refresh", {}, issued.refreshToken));
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toBe("not_owned");

    const late = (await (await games.startDevice(gamePost("/v1/games/device/start", { gameId: "kal_university" }))).json()) as {
      deviceCode: string;
    };
    clock += 11 * 60 * 1000;
    expect(((await (await games.deviceToken(gamePost("/v1/games/device/token", { deviceCode: late.deviceCode }))).json()) as { error: string }).error).toBe(
      "expired_token",
    );
  });

  it("refuses browsers on game endpoints and publishes only public key material", async () => {
    const games = service();
    const browser = await games.startDevice(
      new Request("https://api.kalcoded.com/v1/games/device/start", {
        method: "POST",
        headers: { "content-type": "application/json", origin: SITE },
        body: JSON.stringify({ gameId: "kal_university" }),
      }),
    );
    expect(browser.status).toBe(403);
    const keys = (await (await games.keys()).json()) as { keys: Record<string, string>[] };
    expect(keys.keys).toEqual([{ kty: "OKP", crv: "Ed25519", alg: "EdDSA", use: "sig", kid: "g-test-1", x: signer.key.publicKey }]);
  });
});

describe("downloads", () => {
  it("mints short-lived signed links only for owners and streams ranges", async () => {
    const bytes = new TextEncoder().encode("KAL University installer bytes");
    memoryBuilds["kal_university/builds/0.1.0/KALUniversity-0.1.0-Setup.exe"] = bytes;
    memoryBuilds["kal_university/manifest.json"] = new TextEncoder().encode(
      JSON.stringify({
        version: 1,
        builds: {
          "windows-x64": {
            key: "kal_university/builds/0.1.0/KALUniversity-0.1.0-Setup.exe",
            version: "0.1.0",
            fileName: "KALUniversity-0.1.0-Setup.exe",
            size: bytes.byteLength,
            sha256: "a".repeat(64),
          },
        },
      }),
    );
    const games = service();
    const lib = await library(games, "acct_buyer");
    expect(lib.downloads).toEqual([
      { platform: "windows-x64", available: true, version: "0.1.0", size: bytes.byteLength, sha256: "a".repeat(64) },
      { platform: "macos-arm64", available: false },
    ]);
    expect((await games.downloadLink(websitePost("/v1/games/downloads", { gameId: "kal_university", platform: "windows-x64" }), "acct_abroad")).status).toBe(403);
    const link = (await (
      await games.downloadLink(websitePost("/v1/games/downloads", { gameId: "kal_university", platform: "windows-x64" }), "acct_buyer")
    ).json()) as { url: string };
    expect(link.url).toMatch(/^https:\/\/api\.kalcoded\.com\/v1\/games\/download\?t=/);
    const full = await games.download(new Request(link.url));
    expect(full.status).toBe(200);
    expect(new Uint8Array(await full.arrayBuffer())).toEqual(bytes);
    const partial = await games.download(new Request(link.url, { headers: { range: "bytes=0-2" } }));
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-range")).toBe(`bytes 0-2/${bytes.byteLength}`);
    expect(await partial.text()).toBe("KAL");
    const forged = await games.download(new Request(`${link.url.slice(0, -2)}xx`));
    expect(forged.status).toBe(403);
    clock += 11 * 60 * 1000;
    expect((await games.download(new Request(link.url))).status).toBe(410);
  });
});
