import { encodeBase64Url } from "./base64url";

const UTF8 = new TextEncoder();

export async function sha256Bytes(value: string | Uint8Array): Promise<Uint8Array> {
  const bytes = typeof value === "string" ? UTF8.encode(value) : value;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

export async function sha256Base64Url(value: string | Uint8Array): Promise<string> {
  return encodeBase64Url(await sha256Bytes(value));
}

async function hmacSha256(key: string, value: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey("raw", UTF8.encode(key), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, UTF8.encode(value)));
}

export async function hmacSha256Hex(key: string, value: string): Promise<string> {
  return [...(await hmacSha256(key, value))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function hmacSha256Base64Url(key: string, value: string): Promise<string> {
  return encodeBase64Url(await hmacSha256(key, value));
}

/** Constant-work comparison over the longer input. Length remains part of the result. */
export function constantTimeEqual(left: string, right: string): boolean {
  const a = UTF8.encode(left);
  const b = UTF8.encode(right);
  const length = Math.max(a.length, b.length);
  let difference = a.length ^ b.length;
  for (let index = 0; index < length; index++) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}

export function randomBase64Url(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return encodeBase64Url(bytes);
}
