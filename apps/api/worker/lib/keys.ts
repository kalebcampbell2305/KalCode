/**
 * Entitlement signing keys.
 *
 * The private key lives only in the Worker secret `ENTITLEMENT_SIGNING_KEY` (an Ed25519 private
 * JWK with a `kid`), set with `wrangler secret put` — never in the repository or in `vars`.
 * Local development and tests generate throwaway keys (`tooling/admin/gen-signing-key.mjs`).
 *
 * Rotation: publish the new key's public half in the desktop app (`crates/entitlements`) first,
 * then switch the secret and move the old public key into `ENTITLEMENT_PREVIOUS_PUBLIC_KEYS`
 * until every document it signed has expired. See docs/BILLING.md §6.
 */

import { isValidKeyId } from "@kalcode/protocol/entitlements";
import { decodeBase64Url, encodeBase64Url } from "./base64url";
import type { EntitlementSigningKey } from "./token";

export interface PublicKeyEntry {
  kid: string;
  /** base64url raw Ed25519 public key. */
  x: string;
}

/** JWK as published at /v1/entitlement/keys (RFC 8037 OKP key). */
export interface PublishedJwk {
  kty: "OKP";
  crv: "Ed25519";
  alg: "EdDSA";
  use: "sig";
  kid: string;
  x: string;
}

export class SigningKeyError extends Error {
  override name = "SigningKeyError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isKeyMaterial(value: unknown): value is string {
  return typeof value === "string" && decodeBase64Url(value)?.length === 32;
}

const PROBE = new TextEncoder().encode("kalcode entitlement signing key self-check");

/**
 * Rotation entries form an identity map, not a preference list. Reusing an id for different
 * material is ambiguous, while publishing the same material under aliases makes retirement and
 * incident revocation depend on which alias a document happened to use. Both fail closed.
 */
function assertDistinctKeySet(entries: readonly PublicKeyEntry[], setting: string): void {
  const keyIds = new Set<string>();
  const publicKeys = new Set<string>();
  for (const entry of entries) {
    if (keyIds.has(entry.kid)) {
      throw new SigningKeyError(`${setting} has a duplicate key id`);
    }
    if (publicKeys.has(entry.x)) {
      throw new SigningKeyError(`${setting} aliases one public key under multiple ids`);
    }
    keyIds.add(entry.kid);
    publicKeys.add(entry.x);
  }
}

/**
 * Parses and imports the secret. Throws `SigningKeyError` (never including key material) if it
 * is malformed or if `x` is not the public half of `d` — a mismatched secret would issue
 * documents no client could verify.
 */
export async function importSigningKey(secret: string): Promise<EntitlementSigningKey> {
  let jwk: unknown;
  try {
    jwk = JSON.parse(secret);
  } catch {
    throw new SigningKeyError("ENTITLEMENT_SIGNING_KEY is not valid JSON");
  }
  if (!isRecord(jwk) || jwk.kty !== "OKP" || jwk.crv !== "Ed25519") {
    throw new SigningKeyError("ENTITLEMENT_SIGNING_KEY must be an Ed25519 OKP JWK");
  }
  const { kid, d, x } = jwk;
  if (typeof kid !== "string" || !isValidKeyId(kid)) {
    throw new SigningKeyError("ENTITLEMENT_SIGNING_KEY needs a valid kid");
  }
  if (!isKeyMaterial(d) || !isKeyMaterial(x)) {
    throw new SigningKeyError("ENTITLEMENT_SIGNING_KEY needs 32-byte d and x");
  }
  let privateKey: CryptoKey;
  let publicKey: CryptoKey;
  try {
    privateKey = await crypto.subtle.importKey(
      "jwk",
      { kty: "OKP", crv: "Ed25519", d, x },
      { name: "Ed25519" },
      false,
      ["sign"],
    );
    publicKey = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x }, { name: "Ed25519" }, true, [
      "verify",
    ]);
  } catch {
    throw new SigningKeyError("ENTITLEMENT_SIGNING_KEY could not be imported");
  }
  const signature = await crypto.subtle.sign({ name: "Ed25519" }, privateKey, PROBE);
  if (!(await crypto.subtle.verify({ name: "Ed25519" }, publicKey, signature, PROBE))) {
    throw new SigningKeyError("ENTITLEMENT_SIGNING_KEY: x is not the public key for d");
  }
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", publicKey)) as ArrayBuffer);
  return { keyId: kid, privateKey, publicKey: encodeBase64Url(raw) };
}

/** Parses `ENTITLEMENT_PREVIOUS_PUBLIC_KEYS`. Invalid entries are an error, not silently dropped. */
export function parsePreviousPublicKeys(value: string | undefined): PublicKeyEntry[] {
  if (value === undefined || value.trim() === "") {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new SigningKeyError("ENTITLEMENT_PREVIOUS_PUBLIC_KEYS is not valid JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new SigningKeyError("ENTITLEMENT_PREVIOUS_PUBLIC_KEYS must be an array");
  }
  const keys = parsed.map((entry) => {
    if (!isRecord(entry) || typeof entry.kid !== "string" || !isValidKeyId(entry.kid) || !isKeyMaterial(entry.x)) {
      throw new SigningKeyError("ENTITLEMENT_PREVIOUS_PUBLIC_KEYS has an invalid entry");
    }
    return { kid: entry.kid, x: entry.x };
  });
  assertDistinctKeySet(keys, "ENTITLEMENT_PREVIOUS_PUBLIC_KEYS");
  return keys;
}

/** The published key set: the current key first, then unambiguous retired keys. */
export function publishedKeySet(current: PublicKeyEntry | null, previous: readonly PublicKeyEntry[]): PublishedJwk[] {
  const entries = current ? [current, ...previous] : [...previous];
  assertDistinctKeySet(entries, "entitlement public key set");
  return entries.map(({ kid, x }) => ({ kty: "OKP", crv: "Ed25519", alg: "EdDSA", use: "sig", kid, x }));
}
