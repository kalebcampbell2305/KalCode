/**
 * Signed entitlement documents: compact JWS (RFC 7515) with EdDSA/Ed25519 (RFC 8037).
 *
 *   token = base64url(header) "." base64url(payload) "." base64url(signature)
 *   header  = {"alg":"EdDSA","kid":"<key id>","typ":"kalcode-entitlement.v1"}
 *   payload = the `Entitlement` JSON (packages/protocol/src/entitlements.ts)
 *   signature = Ed25519 over the ASCII bytes of `base64url(header) "." base64url(payload)`
 *
 * Signing the transmitted bytes (not a re-serialization) means no canonical-JSON rules are
 * needed: the desktop verifier (`crates/entitlements`) checks exactly what it received. Both
 * verifiers apply the same checks in the same order and return the same error codes; the shared
 * vectors in `crates/entitlements/testdata/vectors.json` pin that.
 */

import {
  ENTITLEMENT_CLOCK_SKEW_SECONDS,
  type Entitlement,
  isValidKeyId,
  parseEntitlement,
} from "@kalcode/protocol/entitlements";
import { decodeBase64Url, encodeBase64Url, encodeBase64UrlText } from "./base64url";

export const TOKEN_TYPE = "kalcode-entitlement.v1";
export const TOKEN_ALGORITHM = "EdDSA";
/** Upper bound on an accepted token, checked before any decoding. */
export const MAX_TOKEN_LENGTH = 8192;

const ED25519 = { name: "Ed25519" } as const;

export interface TokenHeader {
  alg: typeof TOKEN_ALGORITHM;
  kid: string;
  typ: typeof TOKEN_TYPE;
}

export interface EntitlementSigningKey {
  keyId: string;
  privateKey: CryptoKey;
  /** base64url raw public key (the JWK `x`). */
  publicKey: string;
}

export type VerifyError =
  | "malformed"
  | "unsupported_header"
  | "unknown_key"
  | "bad_signature"
  | "invalid_document"
  | "not_yet_valid"
  | "expired";

export type VerifyResult = { ok: true; entitlement: Entitlement } | { ok: false; error: VerifyError };

/** Header and payload segments, exactly as signed. Key order is fixed by construction. */
export function encodeSigningInput(entitlement: Entitlement): string {
  const header: TokenHeader = { alg: TOKEN_ALGORITHM, kid: entitlement.keyId, typ: TOKEN_TYPE };
  const payload: Entitlement = {
    version: entitlement.version,
    accountId: entitlement.accountId,
    tier: entitlement.tier,
    unrestricted: entitlement.unrestricted,
    features: entitlement.features,
    limits: entitlement.limits,
    issuedAt: entitlement.issuedAt,
    expiresAt: entitlement.expiresAt,
    keyId: entitlement.keyId,
  };
  return `${encodeBase64UrlText(JSON.stringify(header))}.${encodeBase64UrlText(JSON.stringify(payload))}`;
}

export async function signEntitlement(entitlement: Entitlement, key: EntitlementSigningKey): Promise<string> {
  if (entitlement.keyId !== key.keyId) {
    throw new Error("entitlement keyId does not match the signing key");
  }
  const signingInput = encodeSigningInput(entitlement);
  const signature = await crypto.subtle.sign(ED25519, key.privateKey, new TextEncoder().encode(signingInput));
  return `${signingInput}.${encodeBase64Url(new Uint8Array(signature))}`;
}

export async function importPublicKey(x: string): Promise<CryptoKey | null> {
  const raw = decodeBase64Url(x);
  if (raw?.length !== 32) {
    return null;
  }
  try {
    return await crypto.subtle.importKey("raw", raw, ED25519, true, ["verify"]);
  } catch {
    return null;
  }
}

function parseJsonSegment(segment: string): unknown {
  const bytes = decodeBase64Url(segment);
  if (!bytes) {
    return undefined;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Verifies a token against a set of trusted public keys (by key id) at `nowSeconds`.
 * Check order (identical in Rust): shape → header → key → signature → document → time.
 */
export async function verifyEntitlementToken(
  token: string,
  keys: ReadonlyMap<string, CryptoKey>,
  nowSeconds: number,
): Promise<VerifyResult> {
  const fail = (error: VerifyError): VerifyResult => ({ ok: false, error });
  if (token.length > MAX_TOKEN_LENGTH) return fail("malformed");
  const segments = token.split(".");
  if (segments.length !== 3) return fail("malformed");
  const [headerSegment = "", payloadSegment = "", signatureSegment = ""] = segments;
  const signature = decodeBase64Url(signatureSegment);
  if (signature?.length !== 64) return fail("malformed");
  const header = parseJsonSegment(headerSegment);
  if (header === undefined || decodeBase64Url(payloadSegment) === null) return fail("malformed");

  if (typeof header !== "object" || header === null || Array.isArray(header)) return fail("unsupported_header");
  const { alg, kid, typ } = header as Record<string, unknown>;
  if (alg !== TOKEN_ALGORITHM || typ !== TOKEN_TYPE || typeof kid !== "string" || !isValidKeyId(kid)) {
    return fail("unsupported_header");
  }

  const key = keys.get(kid);
  if (!key) return fail("unknown_key");

  const signingInput = new TextEncoder().encode(`${headerSegment}.${payloadSegment}`);
  let valid: boolean;
  try {
    valid = await crypto.subtle.verify(ED25519, key, signature, signingInput);
  } catch {
    valid = false;
  }
  if (!valid) return fail("bad_signature");

  const parsed = parseEntitlement(parseJsonSegment(payloadSegment));
  if (!parsed.ok || parsed.value.keyId !== kid) return fail("invalid_document");

  const entitlement = parsed.value;
  if (nowSeconds + ENTITLEMENT_CLOCK_SKEW_SECONDS < entitlement.issuedAt) return fail("not_yet_valid");
  if (nowSeconds >= entitlement.expiresAt) return fail("expired");
  return { ok: true, entitlement };
}
