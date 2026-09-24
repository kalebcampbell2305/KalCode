/** Ephemeral Ed25519 keys for tests. Generated per run; never persisted. */
import { importSigningKey } from "../../worker/lib/keys";
import { importPublicKey } from "../../worker/lib/token";

export async function generateSigningSecret(kid: string): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  return JSON.stringify({ kty: "OKP", crv: "Ed25519", kid, d: jwk.d, x: jwk.x });
}

export async function generateSigningKey(kid: string) {
  const secret = await generateSigningSecret(kid);
  const key = await importSigningKey(secret);
  const publicKey = await importPublicKey(key.publicKey);
  if (!publicKey) throw new Error("test key import failed");
  return { secret, key, trusted: new Map([[kid, publicKey]]) };
}
