/**
 * Browser helpers for the private game account pages (/games/library, /games/activate) and the
 * account page's "continue" notice. Pure functions; the pages own the DOM.
 *
 * Nothing here decides ownership: the pages only display what api.kalcoded.com returns for the
 * signed-in session cookie (docs/BILLING.md §13).
 */

import type { GameOwnershipSource } from "@kalcode/protocol/games";

export const GAMES_API = "https://api.kalcoded.com";

/** Where a signed-out visitor should return after signing in on /account (same browser). */
export const GAMES_RETURN_KEY = "kalcode:games-return";
const RETURN_TTL_MS = 30 * 60 * 1000;
const RETURN_PATHS = ["/games/activate", "/games/library"] as const;
export type GamesReturnPath = (typeof RETURN_PATHS)[number];

/** RFC 8628 user-code alphabet used by the API (no vowels, no look-alikes). */
export const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";

/** Live formatting while typing: keeps alphabet letters only, upper-cases, inserts "-" after four. */
export function formatUserCode(input: string): string {
  const letters = [...input.toUpperCase()].filter((char) => USER_CODE_ALPHABET.includes(char)).slice(0, 8);
  return letters.length > 4 ? `${letters.slice(0, 4).join("")}-${letters.slice(4).join("")}` : letters.join("");
}

export function isCompleteUserCode(code: string): boolean {
  return /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/.test(code);
}

const SOURCE_LABELS: Readonly<Record<GameOwnershipSource, string>> = {
  standalone: "Bought on its own",
  pro: "Included with KalCode Pro",
  max: "Included with KalCode MAX",
  max2x: "Included with KalCode MAX 2X",
  owner: "Included with your OWNER access",
};

export function ownershipLabel(source: GameOwnershipSource): string {
  return SOURCE_LABELS[source];
}

const TIER_LABELS: Readonly<Record<string, string>> = {
  standalone: "Standalone",
  pro: "Pro",
  max: "MAX",
  max2x: "MAX 2X",
};

export function perkTierLabel(tier: string | null): string {
  return tier ? (TIER_LABELS[tier] ?? tier) : "None";
}

/** "1.2 GB", "640 MB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const units = ["bytes", "KB", "MB", "GB"] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

/** "October 8, 2026" in the visitor's locale, or "" for a bad date. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

export function serializeReturn(path: GamesReturnPath, code: string | null, nowMs: number): string {
  return JSON.stringify({ path, code: code && isCompleteUserCode(code) ? code : null, at: nowMs });
}

/** A stored return target, only if well-formed, known and fresh. */
export function parseReturn(raw: string | null, nowMs: number): { path: GamesReturnPath; code: string | null } | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { path?: unknown; code?: unknown; at?: unknown };
    if (!RETURN_PATHS.includes(value.path as GamesReturnPath)) return null;
    if (typeof value.at !== "number" || nowMs - value.at > RETURN_TTL_MS || value.at > nowMs + 60_000) return null;
    const code = typeof value.code === "string" && isCompleteUserCode(value.code) ? value.code : null;
    return { path: value.path as GamesReturnPath, code };
  } catch {
    return null;
  }
}

/** The URL to continue to (the code travels in the query, the way the game's own link sends it). */
export function returnUrl(target: { path: GamesReturnPath; code: string | null }): string {
  return target.path === "/games/activate" && target.code ? `${target.path}?code=${target.code}` : target.path;
}
