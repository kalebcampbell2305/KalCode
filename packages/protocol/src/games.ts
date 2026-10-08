/**
 * KalCode games: ownership, perks and the signed game license. The single source of truth.
 *
 * Owner direction (KAL University, Update 3, 2026-10-08):
 * - Prices: a standalone one-time purchase, or included with KalCode Pro, MAX and MAX 2X. The
 *   KalCode subscription prices are unchanged (`plans.ts` owns them; this module only reads them).
 * - Lifetime ownership comes from the standalone purchase or from the first successful qualifying
 *   subscription payment. Cancelling or downgrading never removes it. Refunds, chargebacks and
 *   fraud follow the server's entitlement policy (apps/api `game-store.ts`).
 * - Perks by tier (standalone < Pro < MAX < MAX 2X) are cosmetic and convenience first, with a
 *   modest starting-cash bonus. Never pay-to-win: every perk item can also be earned or bought in
 *   the game, and every achievement stays reachable on standalone.
 * - Claims are tracked per account on the server: perks are claimed once per item, persist after
 *   cancellation, and an upgrade claims only the higher tiers' unclaimed items.
 *
 * The website renders this catalog, the API signs the claimed items into the license, and the game
 * applies exactly what the license lists. The game ships no catalog of its own.
 */

import type { PlanId } from "./plans.ts";

export type GameId = "kal_university";

/** Perk tiers, lowest first. `standalone` is every owner, however they got the game. */
export const GAME_PERK_TIERS = ["standalone", "pro", "max", "max2x"] as const;
export type GamePerkTier = (typeof GAME_PERK_TIERS)[number];

/** How an account came to own a game. `owner` is the private OWNER operator account. */
export const GAME_OWNERSHIP_SOURCES = ["standalone", "pro", "max", "max2x", "owner"] as const;
export type GameOwnershipSource = (typeof GAME_OWNERSHIP_SOURCES)[number];

export type GameAvailability = "coming_soon" | "available";

export interface GameDefinition {
  id: GameId;
  name: string;
  tagline: string;
  /** Website path of the game's page. */
  path: string;
  /** Standalone one-time price, whole US dollars. */
  standalonePriceUsd: number;
  /** KalCode plans whose first successful paid invoice grants lifetime ownership. */
  includedWithPlans: readonly Exclude<PlanId, "free">[];
  /** `available` only once a tested build can be bought and downloaded. */
  status: GameAvailability;
  platforms: readonly GamePlatform[];
}

export type GamePlatformId = "windows-x64" | "macos-arm64";

export interface GamePlatform {
  id: GamePlatformId;
  name: string;
  status: GameAvailability;
}

export const KAL_UNIVERSITY: GameDefinition = {
  id: "kal_university",
  name: "KAL University",
  tagline: "Build your future.",
  path: "/games/kal-university",
  standalonePriceUsd: 5,
  includedWithPlans: ["pro", "max", "max2x"],
  status: "coming_soon",
  platforms: [
    { id: "windows-x64", name: "Windows", status: "coming_soon" },
    { id: "macos-arm64", name: "macOS", status: "coming_soon" },
  ],
};

export const GAMES: readonly GameDefinition[] = [KAL_UNIVERSITY];

export function getGame(id: string): GameDefinition | undefined {
  return GAMES.find((game) => game.id === id);
}

export function isGameId(value: unknown): value is GameId {
  return typeof value === "string" && GAMES.some((game) => game.id === value);
}

/**
 * What a perk does in the game. `wardrobe` / `decor` unlock an existing catalog item (by its game
 * content id); `wallet` adds starting cash once per new game.
 */
export type GamePerkKind = "wardrobe" | "decor" | "wallet";

export interface GamePerk {
  /** Stable claim id. Never reuse an id for a different item. */
  id: string;
  gameId: GameId;
  tier: Exclude<GamePerkTier, "standalone">;
  kind: GamePerkKind;
  /** Game content id for `wardrobe` / `decor`; empty for `wallet`. */
  ref: string;
  /** Cents of starting cash for `wallet`; 0 otherwise. */
  amountCents: number;
  name: string;
}

/**
 * The perk catalog (owner approval pending, ENTITLEMENTS.md decision E8). Every item already exists
 * in the game and can be bought or earned there, so perks save time and look good, never more.
 * Starting cash is cumulative: +$50 per tier, $150 at MAX 2X on top of everyone's $200.
 */
export const GAME_PERKS: readonly GamePerk[] = [
  { id: "ku_pro_headphones", gameId: "kal_university", tier: "pro", kind: "wardrobe", ref: "acc_headphones", amountCents: 0, name: "Studio headphones" },
  { id: "ku_pro_retro_poster", gameId: "kal_university", tier: "pro", kind: "decor", ref: "poster_retro_terminal", amountCents: 0, name: "Retro terminal poster" },
  { id: "ku_pro_start_cash", gameId: "kal_university", tier: "pro", kind: "wallet", ref: "", amountCents: 5_000, name: "+$50 starting cash" },
  { id: "ku_max_watch", gameId: "kal_university", tier: "max", kind: "wardrobe", ref: "acc_watch", amountCents: 0, name: "Minimal watch" },
  { id: "ku_max_denim_jacket", gameId: "kal_university", tier: "max", kind: "wardrobe", ref: "top_denim_jacket", amountCents: 0, name: "Denim jacket" },
  { id: "ku_max_start_cash", gameId: "kal_university", tier: "max", kind: "wallet", ref: "", amountCents: 5_000, name: "+$50 starting cash" },
  { id: "ku_max2x_hightops", gameId: "kal_university", tier: "max2x", kind: "wardrobe", ref: "shoes_hightops", amountCents: 0, name: "High-tops" },
  { id: "ku_max2x_turtleneck", gameId: "kal_university", tier: "max2x", kind: "wardrobe", ref: "top_turtleneck", amountCents: 0, name: "Fine-knit turtleneck" },
  { id: "ku_max2x_start_cash", gameId: "kal_university", tier: "max2x", kind: "wallet", ref: "", amountCents: 5_000, name: "+$50 starting cash" },
];

/** Upper bound the game accepts for all starting cash in one license (defence against a bad catalog). */
export const GAME_PERK_MAX_TOTAL_CENTS = 50_000;

export function perkTierRank(tier: GamePerkTier): number {
  return GAME_PERK_TIERS.indexOf(tier);
}

export function higherPerkTier(a: GamePerkTier, b: GamePerkTier): GamePerkTier {
  return perkTierRank(a) >= perkTierRank(b) ? a : b;
}

export function isGamePerkTier(value: unknown): value is GamePerkTier {
  return typeof value === "string" && (GAME_PERK_TIERS as readonly string[]).includes(value);
}

/** Every perk of `gameId` at or below `tier` (standalone has none: it is the complete game). */
export function perksThroughTier(gameId: GameId, tier: GamePerkTier): GamePerk[] {
  const rank = perkTierRank(tier);
  return GAME_PERKS.filter((perk) => perk.gameId === gameId && perkTierRank(perk.tier) <= rank);
}

/** Perks a tier adds over the tier below it. */
export function perksAddedAt(gameId: GameId, tier: GamePerkTier): GamePerk[] {
  return GAME_PERKS.filter((perk) => perk.gameId === gameId && perk.tier === tier);
}

export function getPerk(id: string): GamePerk | undefined {
  return GAME_PERKS.find((perk) => perk.id === id);
}

/** The perk tier a KalCode plan entitles while it is active. OWNER counts as MAX 2X. */
export function perkTierForPlan(plan: PlanId | "owner"): GamePerkTier {
  if (plan === "owner") return "max2x";
  return plan === "free" ? "standalone" : plan;
}

// ---------------------------------------------------------------------------------------------
// The signed game license (compact JWS, EdDSA, `typ` kalcode-game-license.v1)

export const GAME_LICENSE_TOKEN_TYPE = "kalcode-game-license.v1";
export const GAME_LICENSE_VERSION = 1;
/** A license is valid offline for 30 days; the game refreshes it silently when online. */
export const GAME_LICENSE_TTL_SECONDS = 30 * 24 * 60 * 60;
/** The game asks for a fresh license once the cached one is older than this (and it is online). */
export const GAME_LICENSE_REFRESH_AFTER_SECONDS = 24 * 60 * 60;
/** Verifiers refuse any license claiming a longer lifetime. */
export const GAME_LICENSE_MAX_LIFETIME_SECONDS = 45 * 24 * 60 * 60;
export const GAME_LICENSE_CLOCK_SKEW_SECONDS = 5 * 60;

/** One perk as signed into a license: exactly what the game applies. */
export interface LicensedPerk {
  id: string;
  kind: GamePerkKind;
  ref: string;
  amountCents: number;
}

export interface GameLicense {
  version: 1;
  gameId: GameId;
  /**
   * Opaque account reference: base64url SHA-256 of `kalcode-game-account:v1:<account id>`. The game
   * never learns the account id or email; it only checks the license stays with one subject.
   */
  subject: string;
  source: GameOwnershipSource;
  perkTier: GamePerkTier;
  perks: LicensedPerk[];
  /** Optional install binding (base64url SHA-256 the game derives from its install id), or null. */
  device: string | null;
  issuedAt: number;
  expiresAt: number;
  keyId: string;
}

export type GameLicenseParseResult = { ok: true; value: GameLicense } | { ok: false; reason: string };

const KEY_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const HASH = /^[A-Za-z0-9_-]{43}$/;
const PERK_ID = /^[a-z0-9_]{1,64}$/;
const CONTENT_REF = /^[a-z0-9_]{0,64}$/;
const MAX_PERKS = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parsePerk(value: unknown): LicensedPerk | null {
  if (!isRecord(value)) return null;
  const { id, kind, ref, amountCents } = value;
  if (typeof id !== "string" || !PERK_ID.test(id)) return null;
  if (kind !== "wardrobe" && kind !== "decor" && kind !== "wallet") return null;
  if (typeof ref !== "string" || !CONTENT_REF.test(ref)) return null;
  if (!isNonNegativeInteger(amountCents)) return null;
  if (kind === "wallet" ? ref !== "" || amountCents === 0 : ref === "" || amountCents !== 0) return null;
  return { id, kind, ref, amountCents };
}

/** Validates an untrusted license payload. The Unity verifier applies the same rules. */
export function parseGameLicense(value: unknown): GameLicenseParseResult {
  const fail = (reason: string): GameLicenseParseResult => ({ ok: false, reason });
  if (!isRecord(value)) return fail("not an object");
  const { version, gameId, subject, source, perkTier, perks, device, issuedAt, expiresAt, keyId } = value;
  if (version !== GAME_LICENSE_VERSION) return fail("unsupported version");
  if (!isGameId(gameId)) return fail("invalid gameId");
  if (typeof subject !== "string" || !HASH.test(subject)) return fail("invalid subject");
  if (typeof source !== "string" || !(GAME_OWNERSHIP_SOURCES as readonly string[]).includes(source)) {
    return fail("invalid source");
  }
  if (!isGamePerkTier(perkTier)) return fail("invalid perkTier");
  if (!Array.isArray(perks) || perks.length > MAX_PERKS) return fail("invalid perks");
  const parsed: LicensedPerk[] = [];
  let cash = 0;
  for (const raw of perks) {
    const perk = parsePerk(raw);
    if (!perk || parsed.some((p) => p.id === perk.id)) return fail("invalid perks");
    cash += perk.amountCents;
    parsed.push(perk);
  }
  if (cash > GAME_PERK_MAX_TOTAL_CENTS) return fail("perk cash too large");
  if (device !== null && (typeof device !== "string" || !HASH.test(device))) return fail("invalid device");
  if (!isNonNegativeInteger(issuedAt) || !isNonNegativeInteger(expiresAt)) return fail("invalid times");
  if (expiresAt <= issuedAt) return fail("expiresAt must be after issuedAt");
  if (expiresAt - issuedAt > GAME_LICENSE_MAX_LIFETIME_SECONDS) return fail("license lifetime too long");
  if (typeof keyId !== "string" || !KEY_ID.test(keyId)) return fail("invalid keyId");
  return {
    ok: true,
    value: {
      version: GAME_LICENSE_VERSION,
      gameId,
      subject,
      source: source as GameOwnershipSource,
      perkTier,
      perks: parsed,
      device: device as string | null,
      issuedAt,
      expiresAt,
      keyId,
    },
  };
}

/** The license payload with a fixed key order, exactly as it is signed. */
export function canonicalGameLicense(license: GameLicense): GameLicense {
  return {
    version: license.version,
    gameId: license.gameId,
    subject: license.subject,
    source: license.source,
    perkTier: license.perkTier,
    perks: license.perks.map(({ id, kind, ref, amountCents }) => ({ id, kind, ref, amountCents })),
    device: license.device,
    issuedAt: license.issuedAt,
    expiresAt: license.expiresAt,
    keyId: license.keyId,
  };
}

export function toLicensedPerk(perk: GamePerk): LicensedPerk {
  return { id: perk.id, kind: perk.kind, ref: perk.ref, amountCents: perk.amountCents };
}

/** "$5" */
export function formatGamePrice(game: Pick<GameDefinition, "standalonePriceUsd">): string {
  return `$${game.standalonePriceUsd}`;
}
