import { describe, expect, it } from "vitest";
import { importSigningKey, parsePreviousPublicKeys, publishedKeySet, SigningKeyError } from "../../worker/lib/keys";
import { generateSigningSecret } from "../support/keys";

describe("importSigningKey", () => {
  it("imports a valid Ed25519 JWK secret and derives its public key", async () => {
    const secret = await generateSigningSecret("k2026-10");
    const key = await importSigningKey(secret);
    expect(key.keyId).toBe("k2026-10");
    expect(key.publicKey).toBe(JSON.parse(secret).x);
    expect(key.privateKey.extractable).toBe(false);
  });

  it("rejects a secret whose public half does not match its private half", async () => {
    const a = JSON.parse(await generateSigningSecret("a"));
    const b = JSON.parse(await generateSigningSecret("b"));
    // Node rejects the pair at import; runtimes that do not are caught by the sign/verify probe.
    await expect(importSigningKey(JSON.stringify({ ...a, x: b.x }))).rejects.toThrow(SigningKeyError);
  });

  it.each([
    ["not JSON", "nope"],
    ["wrong key type", JSON.stringify({ kty: "EC", crv: "P-256", kid: "a", d: "x", x: "y" })],
    ["missing kid", JSON.stringify({ kty: "OKP", crv: "Ed25519", d: "AAAA", x: "AAAA" })],
    ["short key", JSON.stringify({ kty: "OKP", crv: "Ed25519", kid: "a", d: "AAAA", x: "AAAA" })],
  ])("rejects %s without echoing key material", async (_name, secret) => {
    const error = await importSigningKey(secret).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SigningKeyError);
    expect(String(error)).not.toContain("AAAA");
  });
});

describe("previous public keys", () => {
  it("parses rotation entries and rejects invalid ones", async () => {
    const x = JSON.parse(await generateSigningSecret("a")).x as string;
    expect(parsePreviousPublicKeys(undefined)).toEqual([]);
    expect(parsePreviousPublicKeys("[]")).toEqual([]);
    expect(parsePreviousPublicKeys(JSON.stringify([{ kid: "k-old", x }]))).toEqual([{ kid: "k-old", x }]);
    expect(() => parsePreviousPublicKeys(JSON.stringify([{ kid: "k-old", x: "short" }]))).toThrow(SigningKeyError);
    expect(() => parsePreviousPublicKeys(JSON.stringify({ kid: "k-old", x }))).toThrow(SigningKeyError);
  });

  it("publishes the current key first and never duplicates a kid", () => {
    const keys = publishedKeySet({ kid: "a", x: "X1" }, [
      { kid: "a", x: "X2" },
      { kid: "b", x: "X3" },
    ]);
    expect(keys.map((key) => [key.kid, key.x])).toEqual([
      ["a", "X1"],
      ["b", "X3"],
    ]);
  });
});
