/**
 * Single-use link codes for the early-access emails. A code is 32 random bytes, base64url
 * encoded (43 characters) into the link; only its SHA-256 is stored, so a copy of the database
 * cannot be turned back into working links.
 */

export const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A fresh random code from the platform CSPRNG. */
export function newToken(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
}

/** True for strings shaped like a code this module issues. Checked before any database lookup. */
export function isTokenFormat(value: unknown): value is string {
  return typeof value === "string" && TOKEN_PATTERN.test(value);
}

/** Lowercase hex SHA-256 of the code: the only form that is stored. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
