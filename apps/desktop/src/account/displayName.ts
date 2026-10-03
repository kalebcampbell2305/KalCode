import { DISPLAY_NAME_MAX } from "../ipc/account.ts";

/** Control (C0, DEL, C1), line/paragraph separators and invisible formatting characters. */
function invisible(codePoint: number): boolean {
  return (
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    (codePoint >= 0x2028 && codePoint <= 0x202e) ||
    (codePoint >= 0x2060 && codePoint <= 0x2069) ||
    codePoint === 0xfeff
  );
}

/**
 * Mirrors the API's account display-name rule: what is wrong with `raw` (trimmed), or null when
 * it can be saved. Empty is valid: it clears the name.
 */
export function accountDisplayNameProblem(raw: string): string | null {
  const characters = [...raw.trim()];
  if (characters.length > DISPLAY_NAME_MAX) return `Use at most ${DISPLAY_NAME_MAX} characters.`;
  if (characters.some((character) => invisible(character.codePointAt(0) ?? 0))) {
    return "Remove control or invisible formatting characters.";
  }
  return null;
}

/** The email's local part: the name KalCode shows while no display name is set. */
export function emailName(email: string): string {
  const at = email.lastIndexOf("@");
  return at > 0 ? email.slice(0, at) : email;
}

/**
 * The name KalCode shows for the signed-in account: its display name, else the email's local part.
 * Initials come from the first and last word of that name ("Ada Lovelace" → "AL", "ada.l" → "AL").
 */
export function kalcodeIdentity(
  displayName: string | null | undefined,
  email: string,
): {
  name: string;
  initials: string;
} {
  const name = displayName?.trim() || emailName(email);
  const words = name.split(/[\s._+-]+/u).filter((word) => /[\p{L}\p{N}]/u.test(word));
  const first = (word: string | undefined) => word?.match(/[\p{L}\p{N}]/u)?.[0] ?? "";
  const letters = words.length > 1 ? first(words[0]) + first(words[words.length - 1]) : first(words[0]);
  return { name, initials: (letters || "?").toLocaleUpperCase() };
}
