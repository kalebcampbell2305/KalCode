/**
 * The signed game license: compact JWS (RFC 7515), EdDSA/Ed25519 (RFC 8037), `typ`
 * `kalcode-game-license.v1`, signed with its own key (`GAME_LICENSE_SIGNING_KEY`), never the
 * desktop entitlement key. The game embeds the public key and verifies offline (Unity:
 * `CampusFounder.Runtime.Licensing.Ed25519` + `LicenseVerifier`).
 *
 * The signature covers the exact transmitted bytes, and the `typ` is signed, so a license can never
 * be replayed as a KalCode entitlement or the reverse.
 */

import {
  canonicalGameLicense,
  GAME_LICENSE_CLOCK_SKEW_SECONDS,
  GAME_LICENSE_TOKEN_TYPE,
  type GameLicense,
  parseGameLicense,
} from "@kalcode/protocol/games";
import { decodeBase64Url, encodeBase64Url, encodeBase64UrlText } from "./base64url";
import { sha256Base64Url } from "./crypto";
import type { EntitlementSigningKey, VerifyError } from "./token";

const ED25519 = { name: "Ed25519" } as const;
const MAX_TOKEN_LENGTH = 8192;

/** Opaque, stable account reference for the game: never the account id or email itself. */
export function licenseSubject(accountId: string): Promise<string> {
  return sha256Base64Url(`kalcode-game-account:v1:${accountId}`);
}

export function encodeLicenseSigningInput(license: GameLicense): string {
  const header = { alg: "EdDSA", kid: license.keyId, typ: GAME_LICENSE_TOKEN_TYPE };
  return `${encodeBase64UrlText(JSON.stringify(header))}.${encodeBase64UrlText(
    JSON.stringify(canonicalGameLicense(license)),
  )}`;
}

export async function signGameLicense(license: GameLicense, key: EntitlementSigningKey): Promise<string> {
  if (license.keyId !== key.keyId) throw new Error("license keyId does not match the signing key");
  const parsed = parseGameLicense(license);
  if (!parsed.ok) throw new Error(`refusing to sign an invalid license: ${parsed.reason}`);
  const input = encodeLicenseSigningInput(license);
  const signature = await crypto.subtle.sign(ED25519, key.privateKey, new TextEncoder().encode(input));
  return `${input}.${encodeBase64Url(new Uint8Array(signature))}`;
}

function jsonSegment(segment: string): unknown {
  const bytes = decodeBase64Url(segment);
  if (!bytes) return undefined;
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)) as unknown;
  } catch {
    return undefined;
  }
}

export type LicenseVerifyResult = { ok: true; license: GameLicense } | { ok: false; error: VerifyError };

/** Shape → header → key → signature → document → time; the order the Unity verifier uses. */
export async function verifyGameLicense(
  token: string,
  keys: ReadonlyMap<string, CryptoKey>,
  nowSeconds: number,
): Promise<LicenseVerifyResult> {
  const fail = (error: VerifyError): LicenseVerifyResult => ({ ok: false, error });
  if (token.length > MAX_TOKEN_LENGTH) return fail("malformed");
  const parts = token.split(".");
  if (parts.length !== 3) return fail("malformed");
  const [headerSegment = "", payloadSegment = "", signatureSegment = ""] = parts;
  const signature = decodeBase64Url(signatureSegment);
  if (signature?.length !== 64) return fail("malformed");
  const header = jsonSegment(headerSegment) as Record<string, unknown> | undefined;
  const payload = jsonSegment(payloadSegment);
  if (header === undefined || payload === undefined) return fail("malformed");
  if (
    typeof header !== "object" ||
    header === null ||
    header.alg !== "EdDSA" ||
    header.typ !== GAME_LICENSE_TOKEN_TYPE ||
    typeof header.kid !== "string"
  ) {
    return fail("unsupported_header");
  }
  const key = keys.get(header.kid);
  if (!key) return fail("unknown_key");
  let valid = false;
  try {
    valid = await crypto.subtle.verify(
      ED25519,
      key,
      signature,
      new TextEncoder().encode(`${headerSegment}.${payloadSegment}`),
    );
  } catch {
    valid = false;
  }
  if (!valid) return fail("bad_signature");
  const parsed = parseGameLicense(payload);
  if (!parsed.ok || parsed.value.keyId !== header.kid) return fail("invalid_document");
  if (nowSeconds + GAME_LICENSE_CLOCK_SKEW_SECONDS < parsed.value.issuedAt) return fail("not_yet_valid");
  if (nowSeconds >= parsed.value.expiresAt) return fail("expired");
  return { ok: true, license: parsed.value };
}
