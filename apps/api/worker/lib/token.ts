/**
 * Signed documents: compact JWS (RFC 7515) with EdDSA/Ed25519 (RFC 8037).
 *
 *   token = base64url(header) "." base64url(payload) "." base64url(signature)
 *   header  = {"alg":"EdDSA","kid":"<key id>","typ":"<document type>"}
 *   signature = Ed25519 over the ASCII bytes of `base64url(header) "." base64url(payload)`
 *
 * Two document types share the key and format:
 *   - `kalcode-entitlement.v1`: an `Entitlement` (packages/protocol/src/entitlements.ts)
 *   - `kalcode-usage.v1`: a KalVoice `UsageReceipt` (packages/protocol/src/usage-receipts.ts)
 * The `typ` is covered by the signature, so one kind can never be replayed as the other.
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
import { parseUsageReceipt, type UsageReceipt } from "@kalcode/protocol/usage-receipts";
import { decodeBase64Url, encodeBase64Url, encodeBase64UrlText } from "./base64url";

export const TOKEN_TYPE = "kalcode-entitlement.v1";
export const USAGE_TOKEN_TYPE = "kalcode-usage.v1";
export const TOKEN_ALGORITHM = "EdDSA";
/** Upper bound on an accepted token, checked before any decoding. */
export const MAX_TOKEN_LENGTH = 8192;

type DocumentType = typeof TOKEN_TYPE | typeof USAGE_TOKEN_TYPE;

const ED25519 = { name: "Ed25519" } as const;

export interface TokenHeader {
  alg: typeof TOKEN_ALGORITHM;
  kid: string;
  typ: DocumentType;
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
export type UsageVerifyResult = { ok: true; receipt: UsageReceipt } | { ok: false; error: VerifyError };

function signingInput(typ: DocumentType, keyId: string, payload: unknown): string {
  const header: TokenHeader = { alg: TOKEN_ALGORITHM, kid: keyId, typ };
  return `${encodeBase64UrlText(JSON.stringify(header))}.${encodeBase64UrlText(JSON.stringify(payload))}`;
}

async function sign(input: string, key: EntitlementSigningKey): Promise<string> {
  const signature = await crypto.subtle.sign(ED25519, key.privateKey, new TextEncoder().encode(input));
  return `${input}.${encodeBase64Url(new Uint8Array(signature))}`;
}

/** Header and payload segments of an entitlement token, exactly as signed (fixed key order). */
export function encodeSigningInput(entitlement: Entitlement): string {
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
  return signingInput(TOKEN_TYPE, entitlement.keyId, payload);
}

/** Header and payload segments of a usage receipt token, exactly as signed. */
export function encodeUsageSigningInput(receipt: UsageReceipt): string {
  const payload: UsageReceipt = {
    version: receipt.version,
    accountId: receipt.accountId,
    tier: receipt.tier,
    used: receipt.used,
    allowance: receipt.allowance,
    periodStart: receipt.periodStart,
    resetsAt: receipt.resetsAt,
    issuedAt: receipt.issuedAt,
    expiresAt: receipt.expiresAt,
    keyId: receipt.keyId,
  };
  return signingInput(USAGE_TOKEN_TYPE, receipt.keyId, payload);
}

export async function signEntitlement(entitlement: Entitlement, key: EntitlementSigningKey): Promise<string> {
  if (entitlement.keyId !== key.keyId) {
    throw new Error("entitlement keyId does not match the signing key");
  }
  return sign(encodeSigningInput(entitlement), key);
}

export async function signUsageReceipt(receipt: UsageReceipt, key: EntitlementSigningKey): Promise<string> {
  if (receipt.keyId !== key.keyId) {
    throw new Error("usage receipt keyId does not match the signing key");
  }
  return sign(encodeUsageSigningInput(receipt), key);
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

type JwsResult = { ok: true; kid: string; payload: unknown } | { ok: false; error: VerifyError };

/** Shape → header → key → signature. Identical order in Rust (`crates/entitlements`). */
async function verifyJws(token: string, typ: DocumentType, keys: ReadonlyMap<string, CryptoKey>): Promise<JwsResult> {
  const fail = (error: VerifyError): JwsResult => ({ ok: false, error });
  if (token.length > MAX_TOKEN_LENGTH) return fail("malformed");
  const segments = token.split(".");
  if (segments.length !== 3) return fail("malformed");
  const [headerSegment = "", payloadSegment = "", signatureSegment = ""] = segments;
  const signature = decodeBase64Url(signatureSegment);
  if (signature?.length !== 64) return fail("malformed");
  const header = parseJsonSegment(headerSegment);
  if (header === undefined || decodeBase64Url(payloadSegment) === null) return fail("malformed");

  if (typeof header !== "object" || header === null || Array.isArray(header)) return fail("unsupported_header");
  const { alg, kid, typ: headerTyp } = header as Record<string, unknown>;
  if (alg !== TOKEN_ALGORITHM || headerTyp !== typ || typeof kid !== "string" || !isValidKeyId(kid)) {
    return fail("unsupported_header");
  }

  const key = keys.get(kid);
  if (!key) return fail("unknown_key");

  const input = new TextEncoder().encode(`${headerSegment}.${payloadSegment}`);
  let valid: boolean;
  try {
    valid = await crypto.subtle.verify(ED25519, key, signature, input);
  } catch {
    valid = false;
  }
  if (!valid) return fail("bad_signature");
  return { ok: true, kid, payload: parseJsonSegment(payloadSegment) };
}

/** Then document → time. */
function checkTime(issuedAt: number, expiresAt: number, nowSeconds: number): VerifyError | null {
  if (nowSeconds + ENTITLEMENT_CLOCK_SKEW_SECONDS < issuedAt) return "not_yet_valid";
  if (nowSeconds >= expiresAt) return "expired";
  return null;
}

/** Verifies an entitlement token against trusted public keys (by key id) at `nowSeconds`. */
export async function verifyEntitlementToken(
  token: string,
  keys: ReadonlyMap<string, CryptoKey>,
  nowSeconds: number,
): Promise<VerifyResult> {
  const jws = await verifyJws(token, TOKEN_TYPE, keys);
  if (!jws.ok) return jws;
  const parsed = parseEntitlement(jws.payload);
  if (!parsed.ok || parsed.value.keyId !== jws.kid) return { ok: false, error: "invalid_document" };
  const timeError = checkTime(parsed.value.issuedAt, parsed.value.expiresAt, nowSeconds);
  return timeError ? { ok: false, error: timeError } : { ok: true, entitlement: parsed.value };
}

/** Verifies a KalVoice usage receipt token. */
export async function verifyUsageReceipt(
  token: string,
  keys: ReadonlyMap<string, CryptoKey>,
  nowSeconds: number,
): Promise<UsageVerifyResult> {
  const jws = await verifyJws(token, USAGE_TOKEN_TYPE, keys);
  if (!jws.ok) return jws;
  const parsed = parseUsageReceipt(jws.payload);
  if (!parsed.ok || parsed.value.keyId !== jws.kid) return { ok: false, error: "invalid_document" };
  const timeError = checkTime(parsed.value.issuedAt, parsed.value.expiresAt, nowSeconds);
  return timeError ? { ok: false, error: timeError } : { ok: true, receipt: parsed.value };
}
