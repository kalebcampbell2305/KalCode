/** Strict, unpadded base64url (RFC 4648 §5), as used by JWS. Non-canonical input is rejected. */

const ALPHABET = /^[A-Za-z0-9_-]*$/;

export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function encodeBase64UrlText(text: string): string {
  return encodeBase64Url(new TextEncoder().encode(text));
}

/** Returns null for anything that is not canonical unpadded base64url. */
export function decodeBase64Url(input: string): Uint8Array | null {
  if (!ALPHABET.test(input) || input.length % 4 === 1) {
    return null;
  }
  let binary: string;
  try {
    const padded = input.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (input.length % 4)) % 4);
    binary = atob(padded);
  } catch {
    return null;
  }
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  // Reject non-zero trailing bits so each byte string has exactly one encoding.
  return encodeBase64Url(bytes) === input ? bytes : null;
}
