/**
 * KalCode games: lifetime ownership, perks, the game's device sign-in and its signed license
 * (docs/BILLING.md §13; requirements: KAL University direction Update 3).
 *
 *   Website (kalcoded.com, session cookie)        Game (no browser, no cookie)
 *   GET  /v1/games/library                        POST /v1/games/device/start
 *   POST /v1/games/device/approve                 POST /v1/games/device/token   → license + refresh token
 *   POST /v1/games/checkout   (standalone $5)     POST /v1/games/license/refresh
 *   POST /v1/games/downloads  (signed link)       POST /v1/games/license/sign-out
 *   Stripe: POST /v1/games/webhook (own endpoint and signing secret)
 *   Anyone: GET /v1/games/license/keys, GET /v1/games/download?t=… (signed, short-lived)
 *
 * Nothing the client sends decides ownership, tier or perks: ownership comes only from verified
 * Stripe payments recorded by the webhook (or the OWNER operator grant), the tier only from
 * `resolveEntitlement`, and perks only from the canonical catalog in `@kalcode/protocol/games`.
 */

import {
  GAME_LICENSE_TTL_SECONDS,
  GAME_LICENSE_VERSION,
  GAME_PERKS,
  type GameDefinition,
  type GameId,
  type GameLicense,
  type GameOwnershipSource,
  type GamePerkTier,
  type GamePlatformId,
  getGame,
  getPerk,
  higherPerkTier,
  isGameId,
  perksThroughTier,
  perkTierForPlan,
  toLicensedPerk,
} from "@kalcode/protocol/games";
import type { BillableTier } from "./billing-plans";
import { readJsonBody } from "./body";
import { clientNetwork } from "./client-network";
import { constantTimeEqual, hmacSha256Base64Url, randomBase64Url, sha256Base64Url } from "./crypto";
import { resolveEntitlement } from "./entitlement";
import type { GameOwnership, GamePaymentStatus, GameRateAction, GameStore, PaidSource } from "./game-store";
import { licenseSubject, signGameLicense } from "./game-license";
import { apiError, json, SECURITY_HEADERS } from "./http";
import { type PublicKeyEntry, publishedKeySet } from "./keys";
import type { EntitlementStore } from "./store";
import { type GameChargeState, type GameStripeClient, verifyStripeSignature } from "./stripe";
import type { EntitlementSigningKey } from "./token";

const SITE = "https://kalcoded.com";
export const GAME_VERIFICATION_URI = `${SITE}/games/activate`;
const CHECKOUT_SUCCESS = `${SITE}/games/library?purchase=success`;
const CHECKOUT_CANCEL = `${SITE}/games/kal-university?purchase=cancelled#own`;
const API_ORIGIN = "https://api.kalcoded.com";

/** RFC 8628 §6.1: an unambiguous consonant alphabet (no vowels, so no words; no 0/O, 1/I). */
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
const USER_CODE_LENGTH = 8;
const DEVICE_CODE = /^kgd_[A-Za-z0-9_-]{43}$/;
const REFRESH_TOKEN = /^kgr_[A-Za-z0-9_-]{43}$/;
const BEARER_REFRESH = /^Bearer (kgr_[A-Za-z0-9_-]{43})$/;
const DEVICE_HASH = /^[A-Za-z0-9_-]{43}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,128}$/;
const EVENT_ID = /^evt_[A-Za-z0-9_]+$/;
const STRIPE_OBJECT_ID = /^[a-z]{2,6}_[A-Za-z0-9_]+$/;

export const DEVICE_CODE_LIFETIME_SECONDS = 10 * 60;
export const DEVICE_POLL_INTERVAL_SECONDS = 5;
/** A signed-in game install stays signed in while it is used at least this often. */
export const LICENSE_SESSION_LIFETIME_MS = 180 * 24 * 60 * 60 * 1000;
export const DOWNLOAD_LINK_SECONDS = 10 * 60;
const MAX_WEBHOOK_BYTES = 256 * 1024;
const TEN_MINUTES = 10 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

const PLATFORMS: readonly GamePlatformId[] = ["windows-x64", "macos-arm64"];

/** The private R2 bucket holding game builds (binding `GAME_BUILDS`). */
export interface GameBuildsBucket {
  head(key: string): Promise<{ size: number; httpEtag?: string } | null>;
  get(key: string, options?: { range?: { offset: number; length?: number } | { suffix: number } }): Promise<
    | {
        body: ReadableStream;
        size: number;
        httpEtag?: string;
        range?: { offset?: number; length?: number; suffix?: number };
        text(): Promise<string>;
      }
    | null
  >;
}

export interface GameBuild {
  key: string;
  version: string;
  fileName: string;
  size: number;
  sha256: string;
}

export interface GameBilling {
  stripe: GameStripeClient;
  webhookSecret: string;
  /** Standalone one-time Price per game. */
  standalonePrices: Readonly<Partial<Record<GameId, string>>>;
  /** The KalCode subscription Prices whose paid invoices qualify (price id → tier). */
  planPrices: Readonly<Record<string, BillableTier>>;
  checkoutEnabled: boolean;
  refundRevokeDays: number;
  usOnly: boolean;
}

export interface GameServiceOptions {
  store: GameStore;
  entitlements: EntitlementStore;
  signingKey: () => Promise<EntitlementSigningKey | null>;
  previousPublicKeys: () => readonly PublicKeyEntry[];
  billing: GameBilling | null;
  builds: GameBuildsBucket | null;
  downloadSecret: string | null;
  rateLimitKey: string | null;
  now: () => Date;
  log: (entry: Record<string, string>) => void;
}

export interface GameService {
  library(accountId: string): Promise<Response>;
  approveDevice(request: Request, accountId: string): Promise<Response>;
  checkout(request: Request, accountId: string): Promise<Response>;
  downloadLink(request: Request, accountId: string): Promise<Response>;
  startDevice(request: Request): Promise<Response>;
  deviceToken(request: Request): Promise<Response>;
  refreshLicense(request: Request): Promise<Response>;
  signOut(request: Request): Promise<Response>;
  download(request: Request): Promise<Response>;
  keys(): Promise<Response>;
  webhook(request: Request): Promise<Response>;
}

// --------------------------------------------------------------------------------------------- helpers

function browserForbidden(request: Request): Response | null {
  return request.headers.has("origin") ? apiError(403, "forbidden", "Browser requests are not accepted.") : null;
}

function websiteOnly(request: Request): Response | null {
  const origin = request.headers.get("origin");
  return origin !== null && origin !== SITE ? apiError(403, "forbidden", "This request origin is not allowed.") : null;
}

async function body(request: Request): Promise<Record<string, unknown> | Response> {
  const read = await readJsonBody(request);
  if (!read.ok) {
    const status = read.reason === "unsupported_media_type" ? 415 : read.reason === "payload_too_large" ? 413 : 400;
    return apiError(status, read.reason, "The request is not valid.");
  }
  const value = read.value;
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : apiError(400, "invalid_request", "The request is not valid.");
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function rateLimited(seconds: number): Response {
  return apiError(429, "rate_limited", "Please wait before trying again.", { "retry-after": String(seconds) });
}

/** A fresh user code like "BCDF-GHJK" (8 letters from a 20-letter alphabet, unbiased). */
export function newUserCode(): string {
  const out: string[] = [];
  const bytes = new Uint8Array(32);
  while (out.length < USER_CODE_LENGTH) {
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte >= 240) continue; // 240 = 12 × 20: reject to stay uniform
      out.push(USER_CODE_ALPHABET[byte % 20] as string);
      if (out.length === USER_CODE_LENGTH) break;
    }
  }
  return `${out.slice(0, 4).join("")}-${out.slice(4).join("")}`;
}

/** "bcdf ghjk", "BCDF-GHJK" → "BCDFGHJK"; null if it cannot be a user code. */
export function normalizeUserCode(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 32) return null;
  const letters = value.toUpperCase().replace(/[\s-]/g, "");
  if (letters.length !== USER_CODE_LENGTH) return null;
  for (const char of letters) if (!USER_CODE_ALPHABET.includes(char)) return null;
  return letters;
}

const userCodeHash = (code: string) => sha256Base64Url(`kalcode-game-user-code:v1:${code}`);

function isoFromUnix(value: unknown): string | null {
  return Number.isSafeInteger(value) && (value as number) > 0 ? new Date((value as number) * 1000).toISOString() : null;
}

function idOf(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && typeof (value as { id?: unknown }).id === "string") {
    return (value as { id: string }).id;
  }
  return null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const TIER_RANK: Readonly<Record<BillableTier, number>> = { pro: 1, max: 2, max2x: 3 };

/** Payment status from current Stripe facts and the policy window (ENTITLEMENTS.md §2). */
export function paymentStatus(state: GameChargeState, paidAt: string, refundRevokeDays: number): GamePaymentStatus {
  if (state.disputeLost) return "dispute_lost";
  if (!state.refunded) return "paid";
  if (state.fraudulent) return "fraud";
  if (state.refundedAt === null) return "refunded";
  return Date.parse(state.refundedAt) - Date.parse(paidAt) <= refundRevokeDays * DAY ? "refunded" : "refunded_late";
}

async function readRawBody(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (!Number.isFinite(declared) || declared > MAX_WEBHOOK_BYTES) return null;
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_WEBHOOK_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

/** Parses a single HTTP byte range against `size`; null = whole file, "invalid" = 416. */
export function parseRange(header: string | null, size: number): { offset: number; length: number } | null | "invalid" {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null; // multiple or unknown ranges: serve the whole file
  const [, startText = "", endText = ""] = match;
  if (startText === "" && endText === "") return "invalid";
  if (startText === "") {
    const suffix = Number(endText);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return "invalid";
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }
  const start = Number(startText);
  const end = endText === "" ? size - 1 : Math.min(Number(endText), size - 1);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return "invalid";
  return { offset: start, length: end - start + 1 };
}

// --------------------------------------------------------------------------------------------- service

export function gameService(options: GameServiceOptions): GameService {
  const nowIso = () => options.now().toISOString();

  async function allow(bucket: string, action: GameRateAction, limit: number, windowMs = TEN_MINUTES) {
    const at = options.now();
    return options.store.allow({
      bucket,
      action,
      now: at.toISOString(),
      windowStart: new Date(at.getTime() - windowMs).toISOString(),
      retentionStart: new Date(at.getTime() - Math.max(windowMs, DAY)).toISOString(),
      limit,
    });
  }

  async function networkBucket(request: Request): Promise<string> {
    const network = clientNetwork(request);
    return options.rateLimitKey
      ? `net:${await hmacSha256Base64Url(options.rateLimitKey, `games:${network}`)}`
      : `net:${await sha256Base64Url(`games:${network}`)}`;
  }

  /** Ownership facts for one account and game: stored payment ownership, or the OWNER operator grant. */
  async function ownershipOf(accountId: string, game: GameDefinition) {
    const resolved = await resolveEntitlement(options.entitlements, accountId, options.now());
    const stored = await options.store.ownership(accountId, game.id);
    const active = stored?.status === "active";
    const source: GameOwnershipSource | null = active
      ? (stored as GameOwnership).source
      : resolved.tier === "owner"
        ? "owner"
        : null;
    return { tier: resolved.tier, stored, source };
  }

  /** Claims the perks the current plan allows (once each, ever) and returns the license contents. */
  async function perksFor(accountId: string, game: GameDefinition, planTier: Parameters<typeof perkTierForPlan>[0]) {
    const current = perkTierForPlan(planTier);
    const claims = await options.store.claimPerks(accountId, game.id, perksThroughTier(game.id, current), nowIso());
    let perkTier: GamePerkTier = current;
    const perks = [];
    for (const claim of claims) {
      const perk = getPerk(claim.perkId);
      if (!perk || perk.gameId !== game.id) continue; // retired catalog ids are skipped, never invented
      perkTier = higherPerkTier(perkTier, perk.tier);
      perks.push(perk);
    }
    return { perkTier, perks, claimedIds: new Set(claims.map((claim) => claim.perkId)) };
  }

  /** A signed license, or null when the account does not own the game. */
  async function issueLicense(accountId: string, game: GameDefinition, deviceHash: string | null) {
    const key = await options.signingKey();
    if (!key) return { error: "signing_unavailable" as const };
    const owned = await ownershipOf(accountId, game);
    if (!owned.source) return { error: "not_owned" as const };
    const { perkTier, perks } = await perksFor(accountId, game, owned.tier);
    const issuedAt = Math.floor(options.now().getTime() / 1000);
    const license: GameLicense = {
      version: GAME_LICENSE_VERSION,
      gameId: game.id,
      subject: await licenseSubject(accountId),
      source: owned.source,
      perkTier,
      perks: perks.map(toLicensedPerk),
      device: deviceHash,
      issuedAt,
      expiresAt: issuedAt + GAME_LICENSE_TTL_SECONDS,
      keyId: key.keyId,
    };
    return { token: await signGameLicense(license, key), license };
  }

  function signingUnavailable(): Response {
    options.log({ level: "error", event: "games.signing_key_unavailable" });
    return apiError(503, "signing_unavailable", "Licenses are temporarily unavailable.");
  }

  function notOwned(): Response {
    return apiError(403, "not_owned", "This KalCode account does not own KAL University.");
  }

  async function manifest(game: GameDefinition): Promise<Partial<Record<GamePlatformId, GameBuild>>> {
    if (!options.builds) return {};
    try {
      const object = await options.builds.get(`${game.id}/manifest.json`);
      if (!object) return {};
      const parsed = record(JSON.parse(await object.text()));
      const builds = record(parsed?.builds);
      const out: Partial<Record<GamePlatformId, GameBuild>> = {};
      for (const platform of PLATFORMS) {
        const build = record(builds?.[platform]);
        if (
          build &&
          typeof build.key === "string" &&
          build.key.startsWith(`${game.id}/`) &&
          !build.key.includes("..") &&
          typeof build.version === "string" &&
          /^[0-9A-Za-z.+-]{1,40}$/.test(build.version) &&
          typeof build.fileName === "string" &&
          /^[A-Za-z0-9._ -]{1,120}$/.test(build.fileName) &&
          Number.isSafeInteger(build.size) &&
          (build.size as number) > 0 &&
          typeof build.sha256 === "string" &&
          /^[a-f0-9]{64}$/.test(build.sha256)
        ) {
          out[platform] = {
            key: build.key,
            version: build.version,
            fileName: build.fileName,
            size: build.size as number,
            sha256: build.sha256,
          };
        }
      }
      return out;
    } catch {
      options.log({ level: "warn", event: "games.manifest_unreadable" });
      return {};
    }
  }

  async function downloadSignature(key: string, exp: number): Promise<string> {
    return hmacSha256Base64Url(options.downloadSecret as string, `kalcode-game-download:v1:${key}:${exp}`);
  }

  // ------------------------------------------------------------------------------ webhook pieces

  async function recordInvoice(invoiceId: string): Promise<string> {
    const billing = options.billing as GameBilling;
    const invoice = await billing.stripe.retrieveInvoice(invoiceId);
    if (invoice.id !== invoiceId || invoice.status !== "paid") return "invoice_not_paid";
    const amount = invoice.amount_paid;
    if (!Number.isSafeInteger(amount) || (amount as number) <= 0) return "invoice_free";
    if (record(invoice.parent)?.type !== "subscription_details") return "not_subscription";
    let tier: BillableTier | null = null;
    const lines = record(invoice.lines)?.data;
    for (const line of Array.isArray(lines) ? lines : []) {
      const price = idOf(record(record(record(line)?.pricing)?.price_details)?.price);
      const lineTier = price ? billing.planPrices[price] : undefined;
      if (lineTier && (tier === null || TIER_RANK[lineTier] > TIER_RANK[tier])) tier = lineTier;
    }
    if (!tier) return "not_qualifying_price";
    const customer = idOf(invoice.customer);
    const accountId = customer ? await options.store.accountForCustomer(customer) : null;
    if (!accountId) {
      options.log({ level: "warn", event: "games.invoice_unknown_customer" });
      return "unknown_customer";
    }
    const payments = record(invoice.payments)?.data;
    let paymentIntent: string | null = null;
    for (const entry of Array.isArray(payments) ? payments : []) {
      const payment = record(record(entry)?.payment);
      if (record(entry)?.status === "paid" && payment?.type === "payment_intent") {
        paymentIntent = idOf(payment.payment_intent);
        if (paymentIntent) break;
      }
    }
    if (!paymentIntent || !/^pi_[A-Za-z0-9_]+$/.test(paymentIntent)) return "no_payment_intent";
    const paidAt = isoFromUnix(record(invoice.status_transitions)?.paid_at) ?? nowIso();
    const state = await billing.stripe.chargeState(paymentIntent);
    const currency = typeof invoice.currency === "string" ? invoice.currency : "usd";
    const recorded = await options.store.recordPayment(
      {
        paymentRef: invoiceId,
        paymentIntent,
        accountId,
        gameId: "kal_university",
        source: tier,
        amountCents: amount as number,
        currency,
        paidAt,
      },
      paymentStatus(state, paidAt, billing.refundRevokeDays),
      nowIso(),
    );
    return recorded ? "recorded" : "account_unavailable";
  }

  async function recordSession(sessionId: string, eventCreated: string): Promise<string> {
    const billing = options.billing as GameBilling;
    const session = await billing.stripe.retrieveCheckoutSession(sessionId);
    if (session.id !== sessionId || session.mode !== "payment") return "not_game_session";
    const metadata = record(session.metadata);
    const gameId = metadata?.kalcode_game;
    if (!isGameId(gameId)) return "not_game_session";
    if (session.status !== "complete" || session.payment_status !== "paid") return "session_not_paid";
    const accountId = metadata?.kalcode_account_id;
    if (typeof accountId !== "string" || accountId.length === 0 || session.client_reference_id !== accountId) {
      return "session_account_mismatch";
    }
    const items = record(session.line_items)?.data;
    const item = Array.isArray(items) && items.length === 1 ? record(items[0]) : null;
    if (!item || item.quantity !== 1 || idOf(item.price) !== billing.standalonePrices[gameId]) return "wrong_price";
    const amount = session.amount_total;
    if (!Number.isSafeInteger(amount) || (amount as number) <= 0 || session.currency !== "usd") return "wrong_amount";
    const paymentIntent = idOf(session.payment_intent);
    if (!paymentIntent || !/^pi_[A-Za-z0-9_]+$/.test(paymentIntent)) return "no_payment_intent";
    const country = record(record(session.customer_details)?.address)?.country;
    if (billing.usOnly && country !== "US") {
      await billing.stripe.refundPayment(paymentIntent, `kalcode-game-region-refund-${sessionId}`);
      options.log({ level: "info", event: "games.region_refunded" });
      return "region_refunded";
    }
    const state = await billing.stripe.chargeState(paymentIntent);
    const recorded = await options.store.recordPayment(
      {
        paymentRef: sessionId,
        paymentIntent,
        accountId,
        gameId,
        source: "standalone" satisfies PaidSource,
        amountCents: amount as number,
        currency: "usd",
        paidAt: eventCreated,
      },
      paymentStatus(state, eventCreated, billing.refundRevokeDays),
      nowIso(),
    );
    return recorded ? "recorded" : "account_unavailable";
  }

  async function reconcileIntent(paymentIntent: string | null): Promise<string> {
    const billing = options.billing as GameBilling;
    if (!paymentIntent || !/^pi_[A-Za-z0-9_]+$/.test(paymentIntent)) return "no_payment_intent";
    const payment = await options.store.paymentByIntent(paymentIntent);
    if (!payment) return "unknown_payment"; // not a game payment, or reconciled when its paid event lands
    const state = await billing.stripe.chargeState(paymentIntent);
    await options.store.applyPaymentStatus(
      paymentIntent,
      paymentStatus(state, payment.paidAt, billing.refundRevokeDays),
      nowIso(),
    );
    return "reconciled";
  }

  // ------------------------------------------------------------------------------ routes

  return {
    async library(accountId) {
      const games = [];
      for (const game of [getGame("kal_university") as GameDefinition]) {
        const owned = await ownershipOf(accountId, game);
        const perks = owned.source ? await perksFor(accountId, game, owned.tier) : null;
        const builds = owned.source ? await manifest(game) : {};
        games.push({
          id: game.id,
          name: game.name,
          path: game.path,
          status: game.status,
          standalonePriceUsd: game.standalonePriceUsd,
          owned: owned.source !== null,
          source: owned.source,
          grantedAt: owned.source === "owner" ? null : (owned.stored?.grantedAt ?? null),
          revoked:
            owned.source === null && owned.stored?.status === "revoked"
              ? { at: owned.stored.revokedAt, reason: owned.stored.revokedReason }
              : null,
          planTier: owned.tier,
          perkTier: perks?.perkTier ?? null,
          perks: GAME_PERKS.filter((perk) => perk.gameId === game.id).map((perk) => ({
            id: perk.id,
            name: perk.name,
            tier: perk.tier,
            kind: perk.kind,
            claimed: perks?.claimedIds.has(perk.id) ?? false,
          })),
          checkout: { open: options.billing?.checkoutEnabled === true && !owned.source },
          downloads: PLATFORMS.map((platform) => {
            const build = builds[platform];
            return build
              ? { platform, available: true, version: build.version, size: build.size, sha256: build.sha256 }
              : { platform, available: false };
          }),
        });
      }
      return json({ ok: true, games }, 200);
    },

    async approveDevice(request, accountId) {
      const forbidden = websiteOnly(request);
      if (forbidden) return forbidden;
      const input = await body(request);
      if (input instanceof Response) return input;
      const code = normalizeUserCode(input.userCode);
      if (!onlyKeys(input, ["userCode"]) || !code) {
        return apiError(400, "invalid_code", "Enter the 8-letter code shown in KAL University.");
      }
      if (!(await allow(`acct:${accountId}`, "device_approve", 10))) return rateLimited(600);
      const game = getGame("kal_university") as GameDefinition;
      const owned = await ownershipOf(accountId, game);
      if (!owned.source) return notOwned();
      const result = await options.store.approveDevice(await userCodeHash(code), accountId, nowIso());
      if (result !== "approved") {
        return apiError(404, "invalid_code", "That code is not valid or has expired. Start sign-in again in the game.");
      }
      return json({ ok: true, gameId: game.id }, 200);
    },

    async checkout(request, accountId) {
      const forbidden = websiteOnly(request);
      if (forbidden) return forbidden;
      const billing = options.billing;
      if (!billing || !billing.checkoutEnabled) {
        return apiError(503, "checkout_unavailable", "KAL University is not on sale yet.");
      }
      const input = await body(request);
      if (input instanceof Response) return input;
      const { gameId, requestId } = input;
      if (
        !onlyKeys(input, ["gameId", "requestId"]) ||
        !isGameId(gameId) ||
        typeof requestId !== "string" ||
        !REQUEST_ID.test(requestId)
      ) {
        return apiError(400, "invalid_request", "Choose a game and try again.");
      }
      const priceId = billing.standalonePrices[gameId];
      if (!priceId) return apiError(503, "checkout_unavailable", "This game is not on sale yet.");
      if (!(await allow(`acct:${accountId}`, "checkout", 10))) return rateLimited(600);
      const game = getGame(gameId) as GameDefinition;
      if ((await ownershipOf(accountId, game)).source) {
        return apiError(409, "already_owned", "You already own KAL University. Find it in your Game Library.");
      }
      // A stable 10-minute bucket keeps retries of one click on one Stripe idempotency key with
      // identical parameters (Stripe needs 30 minutes to 24 hours until expiry).
      const bucket = Math.floor(options.now().getTime() / TEN_MINUTES) * TEN_MINUTES;
      const expiresAt = Math.floor((bucket + 4 * TEN_MINUTES) / 1000);
      const session = await billing.stripe.createCheckout({
        accountId,
        gameId,
        priceId,
        customerId: await options.store.customerForAccount(accountId),
        email: await options.store.accountEmail(accountId),
        successUrl: CHECKOUT_SUCCESS,
        cancelUrl: CHECKOUT_CANCEL,
        expiresAt,
        idempotencyKey: `game_checkout_${await sha256Base64Url(`${accountId}:${gameId}:${requestId}:${bucket}`)}`,
      });
      return json({ ok: true, url: session.url }, 200);
    },

    async downloadLink(request, accountId) {
      const forbidden = websiteOnly(request);
      if (forbidden) return forbidden;
      const input = await body(request);
      if (input instanceof Response) return input;
      const { gameId, platform } = input;
      if (
        !onlyKeys(input, ["gameId", "platform"]) ||
        !isGameId(gameId) ||
        !PLATFORMS.includes(platform as GamePlatformId)
      ) {
        return apiError(400, "invalid_request", "Choose a game and a platform.");
      }
      const game = getGame(gameId) as GameDefinition;
      if (!(await ownershipOf(accountId, game)).source) return notOwned();
      if (!options.downloadSecret) return apiError(503, "downloads_unavailable", "Downloads are not available yet.");
      const build = (await manifest(game))[platform as GamePlatformId];
      if (!build) return apiError(404, "build_unavailable", "This download is not available yet.");
      if (!(await allow(`acct:${accountId}`, "download", 20, DAY))) return rateLimited(3600);
      const exp = Math.floor(options.now().getTime() / 1000) + DOWNLOAD_LINK_SECONDS;
      const encodedKey = btoa(build.key).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
      const token = `${encodedKey}.${exp}.${await downloadSignature(build.key, exp)}`;
      return json(
        {
          ok: true,
          url: `${API_ORIGIN}/v1/games/download?t=${token}`,
          fileName: build.fileName,
          version: build.version,
          size: build.size,
          sha256: build.sha256,
          expiresAt: new Date(exp * 1000).toISOString(),
        },
        200,
      );
    },

    async download(request) {
      if (!options.builds || !options.downloadSecret) {
        return apiError(503, "downloads_unavailable", "Downloads are not available yet.");
      }
      const token = new URL(request.url).searchParams.get("t") ?? "";
      const match = /^([A-Za-z0-9_-]{4,400})\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(token);
      if (!match) return apiError(403, "invalid_link", "This download link is not valid.");
      const [, encodedKey = "", expText = "", signature = ""] = match;
      let key: string;
      try {
        key = atob(encodedKey.replaceAll("-", "+").replaceAll("_", "/"));
      } catch {
        return apiError(403, "invalid_link", "This download link is not valid.");
      }
      const exp = Number(expText);
      // Signature first, so a forged link learns nothing about expiry.
      if (!constantTimeEqual(signature, await downloadSignature(key, exp))) {
        return apiError(403, "invalid_link", "This download link is not valid.");
      }
      if (exp <= Math.floor(options.now().getTime() / 1000)) {
        return apiError(410, "link_expired", "This download link has expired. Start the download again from your Game Library.");
      }
      const head = await options.builds.head(key);
      if (!head) return apiError(404, "build_unavailable", "This download is not available.");
      const size = head.size;
      const range = parseRange(request.headers.get("range"), size);
      if (range === "invalid") {
        return new Response(null, { status: 416, headers: { ...SECURITY_HEADERS, "content-range": `bytes */${size}` } });
      }
      const object = await options.builds.get(key, range ? { range } : undefined);
      if (!object) return apiError(404, "build_unavailable", "This download is not available.");
      const fileName = key.split("/").pop() ?? "download";
      const headers: Record<string, string> = {
        ...SECURITY_HEADERS,
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename="${fileName.replace(/[^A-Za-z0-9._ -]/g, "_")}"`,
        "cache-control": "private, no-store",
        "accept-ranges": "bytes",
        "content-length": String(range ? range.length : size),
      };
      if (head.httpEtag) headers.etag = head.httpEtag;
      if (range) headers["content-range"] = `bytes ${range.offset}-${range.offset + range.length - 1}/${size}`;
      return new Response(object.body, { status: range ? 206 : 200, headers });
    },

    async startDevice(request) {
      const forbidden = browserForbidden(request);
      if (forbidden) return forbidden;
      const input = await body(request);
      if (input instanceof Response) return input;
      const { gameId, device } = input;
      if (
        !onlyKeys(input, ["gameId", "device"]) ||
        !isGameId(gameId) ||
        (device !== undefined && device !== null && (typeof device !== "string" || !DEVICE_HASH.test(device)))
      ) {
        return apiError(400, "invalid_request", "The sign-in request is not valid.");
      }
      if (!(await allow(await networkBucket(request), "device_start", 20))) return rateLimited(600);
      const at = options.now();
      const deviceCode = `kgd_${randomBase64Url(32)}`;
      for (let attempt = 0; attempt < 5; attempt++) {
        const userCode = newUserCode();
        const created = await options.store.createDeviceAuthorization({
          deviceCodeHash: await sha256Base64Url(deviceCode),
          userCodeHash: await userCodeHash(userCode.replace("-", "")),
          gameId,
          deviceHash: typeof device === "string" ? device : null,
          now: at.toISOString(),
          expiresAt: new Date(at.getTime() + DEVICE_CODE_LIFETIME_SECONDS * 1000).toISOString(),
        });
        if (!created) continue;
        return json(
          {
            ok: true,
            deviceCode,
            userCode,
            verificationUri: GAME_VERIFICATION_URI,
            verificationUriComplete: `${GAME_VERIFICATION_URI}?code=${userCode}`,
            expiresIn: DEVICE_CODE_LIFETIME_SECONDS,
            interval: DEVICE_POLL_INTERVAL_SECONDS,
          },
          200,
        );
      }
      return apiError(503, "service_unavailable", "Sign-in is temporarily unavailable. Please try again.");
    },

    async deviceToken(request) {
      const forbidden = browserForbidden(request);
      if (forbidden) return forbidden;
      const input = await body(request);
      if (input instanceof Response) return input;
      const { deviceCode } = input;
      if (!onlyKeys(input, ["deviceCode"]) || typeof deviceCode !== "string" || !DEVICE_CODE.test(deviceCode)) {
        return apiError(400, "invalid_request", "The sign-in request is not valid.");
      }
      if (!(await allow(await networkBucket(request), "device_poll", 400))) return rateLimited(60);
      const state = await options.store.pollDevice(
        await sha256Base64Url(deviceCode),
        nowIso(),
        DEVICE_POLL_INTERVAL_SECONDS,
      );
      switch (state.state) {
        case "pending":
          return apiError(400, "authorization_pending", "Waiting for approval on kalcoded.com.");
        case "slow_down":
          return apiError(400, "slow_down", "Polling too fast.", { "retry-after": String(DEVICE_POLL_INTERVAL_SECONDS) });
        case "expired":
          return apiError(400, "expired_token", "This sign-in code expired. Start again.");
        case "invalid":
        case "consumed":
          return apiError(400, "invalid_grant", "This sign-in code is not valid. Start again.");
        default:
          break;
      }
      const game = getGame(state.gameId) as GameDefinition;
      const issued = await issueLicense(state.accountId, game, state.deviceHash);
      if ("error" in issued) return issued.error === "not_owned" ? notOwned() : signingUnavailable();
      const refreshToken = `kgr_${randomBase64Url(32)}`;
      const at = options.now();
      const created = await options.store.createLicenseSession({
        tokenHash: await sha256Base64Url(refreshToken),
        accountId: state.accountId,
        gameId: game.id,
        deviceHash: state.deviceHash,
        now: at.toISOString(),
        expiresAt: new Date(at.getTime() + LICENSE_SESSION_LIFETIME_MS).toISOString(),
      });
      if (!created) return apiError(400, "invalid_grant", "This sign-in code is not valid. Start again.");
      return json({ ok: true, license: issued.token, document: issued.license, refreshToken }, 200);
    },

    async refreshLicense(request) {
      const forbidden = browserForbidden(request);
      if (forbidden) return forbidden;
      const token = BEARER_REFRESH.exec(request.headers.get("authorization") ?? "")?.[1];
      if (!token || !REFRESH_TOKEN.test(token)) {
        return apiError(401, "unauthenticated", "Sign in to KalCode in the game again.", {
          "www-authenticate": 'Bearer realm="kalcode-games"',
        });
      }
      const tokenHash = await sha256Base64Url(token);
      if (!(await allow(`lic:${tokenHash}`, "license_refresh", 30, 60 * 60 * 1000))) return rateLimited(3600);
      const at = options.now();
      const session = await options.store.useLicenseSession(
        tokenHash,
        at.toISOString(),
        new Date(at.getTime() + LICENSE_SESSION_LIFETIME_MS).toISOString(),
      );
      if (!session) {
        return apiError(401, "unauthenticated", "Sign in to KalCode in the game again.", {
          "www-authenticate": 'Bearer realm="kalcode-games"',
        });
      }
      const issued = await issueLicense(session.accountId, getGame(session.gameId) as GameDefinition, session.deviceHash);
      if ("error" in issued) return issued.error === "not_owned" ? notOwned() : signingUnavailable();
      return json({ ok: true, license: issued.token, document: issued.license }, 200);
    },

    async signOut(request) {
      const forbidden = browserForbidden(request);
      if (forbidden) return forbidden;
      const token = BEARER_REFRESH.exec(request.headers.get("authorization") ?? "")?.[1];
      if (token) await options.store.endLicenseSession(await sha256Base64Url(token), nowIso());
      return json({ ok: true }, 200);
    },

    async keys() {
      const key = await options.signingKey();
      const keys = publishedKeySet(key ? { kid: key.keyId, x: key.publicKey } : null, options.previousPublicKeys());
      return json({ keys }, 200, { "cache-control": "public, max-age=300" });
    },

    async webhook(request) {
      if (request.headers.has("origin")) return apiError(403, "forbidden", "Browser requests are not accepted.");
      const billing = options.billing;
      if (!billing) return apiError(503, "service_unavailable", "This service is temporarily unavailable.");
      const payload = await readRawBody(request);
      if (payload === null) return apiError(413, "payload_too_large", "The webhook payload is not valid.");
      const valid = await verifyStripeSignature(
        payload,
        request.headers.get("stripe-signature"),
        billing.webhookSecret,
        Math.floor(options.now().getTime() / 1000),
      );
      if (!valid) return apiError(400, "invalid_signature", "The webhook signature is not valid.");
      let event: Record<string, unknown> | null;
      try {
        event = record(JSON.parse(payload));
      } catch {
        return apiError(400, "invalid_event", "The webhook payload is not valid.");
      }
      const eventId = event?.id;
      const eventType = event?.type;
      const subject = record(record(event?.data)?.object);
      if (typeof eventId !== "string" || !EVENT_ID.test(eventId) || typeof eventType !== "string" || eventType.length > 100) {
        return apiError(400, "invalid_event", "The webhook payload is not valid.");
      }
      // A test deployment never acts on live events, and the reverse.
      if (event?.livemode !== (billing.stripe.mode === "live")) return json({ ok: true, ignored: true }, 200);
      if (await options.store.recordedEvent(eventId)) return json({ ok: true, duplicate: true }, 200);
      const objectId = typeof subject?.id === "string" && STRIPE_OBJECT_ID.test(subject.id) ? subject.id : null;
      let outcome: string;
      switch (eventType) {
        case "invoice.paid":
          outcome = objectId?.startsWith("in_") ? await recordInvoice(objectId) : "invalid_object";
          break;
        case "checkout.session.completed":
        case "checkout.session.async_payment_succeeded":
          outcome = objectId?.startsWith("cs_")
            ? await recordSession(objectId, isoFromUnix(event?.created) ?? nowIso())
            : "invalid_object";
          break;
        case "charge.refunded":
        case "charge.dispute.closed":
          outcome = await reconcileIntent(idOf(subject?.payment_intent));
          break;
        default:
          outcome = "unhandled_type";
      }
      const applied = outcome === "recorded" || outcome === "reconciled" || outcome === "region_refunded";
      await options.store.finishEvent(eventId, eventType, applied ? "applied" : "ignored", nowIso());
      options.log({ level: "info", event: "games.webhook", type: eventType, outcome });
      return json({ ok: true, ...(applied ? {} : { ignored: true }) }, 200);
    },
  };
}
