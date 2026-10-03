/**
 * The KalCode account display name: cosmetic, profile-level only. It never changes the account
 * id, the verified email, sign-in identities, billing, or any signed document.
 */

export const DISPLAY_NAME_MAX_CHARACTERS = 64;
/** Bound on the raw value before trimming, so validation never walks an unbounded string. */
const RAW_MAX_LENGTH = 256;

/** Control (C0, DEL, C1), line/paragraph separators and invisible formatting characters. */
function forbidden(codePoint: number): boolean {
  return (
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    (codePoint >= 0x2028 && codePoint <= 0x202e) ||
    (codePoint >= 0x2060 && codePoint <= 0x2069) ||
    codePoint === 0xfeff
  );
}

export type DisplayNameResult = { ok: true; displayName: string | null } | { ok: false };

/**
 * Normalizes a requested display name: trimmed and NFC-normalized; empty (or null) clears it.
 * Valid names have 1–64 characters with no control or invisible formatting characters.
 */
export function normalizeDisplayName(value: unknown): DisplayNameResult {
  if (value === null) return { ok: true, displayName: null };
  if (typeof value !== "string" || value.length > RAW_MAX_LENGTH) return { ok: false };
  const trimmed = value.normalize("NFC").trim();
  if (trimmed.length === 0) return { ok: true, displayName: null };
  const characters = [...trimmed];
  if (characters.length > DISPLAY_NAME_MAX_CHARACTERS) return { ok: false };
  if (characters.some((character) => forbidden(character.codePointAt(0) ?? 0))) return { ok: false };
  return { ok: true, displayName: trimmed };
}

/** `{"displayName": "<name>" | null}` and nothing else, or null for any other shape. */
export function parseProfileUpdate(value: unknown): { displayName: unknown } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { displayName, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length > 0 || displayName === undefined) return null;
  return { displayName };
}
