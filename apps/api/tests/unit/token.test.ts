import { ENTITLEMENT_CLOCK_SKEW_SECONDS, type Entitlement } from "@kalcode/protocol/entitlements";
import { beforeAll, describe, expect, it } from "vitest";
import { decodeBase64Url, encodeBase64Url, encodeBase64UrlText } from "../../worker/lib/base64url";
import { buildEntitlement } from "../../worker/lib/entitlement";
import { encodeSigningInput, signEntitlement, verifyEntitlementToken } from "../../worker/lib/token";
import { generateSigningKey } from "../support/keys";

const NOW = new Date("2026-09-24T12:00:00.000Z");
const NOW_S = NOW.getTime() / 1000;
const ACCOUNT = "0b6f1c1e-5a39-4d0c-9a0f-2b1f7d9e4c11";
const TYP = "kalcode-entitlement.v1";

type TestKey = Awaited<ReturnType<typeof generateSigningKey>>;
let signer: TestKey;
let other: TestKey;
let ownerDoc: Entitlement;

beforeAll(async () => {
  signer = await generateSigningKey("test-a");
  other = await generateSigningKey("test-b");
  ownerDoc = buildEntitlement(ACCOUNT, { tier: "owner", grantExpiresAt: null }, NOW, "test-a");
});

function replaceSegment(token: string, index: number, value: string): string {
  const parts = token.split(".");
  parts[index] = value;
  return parts.join(".");
}

function segmentJson(token: string, index: number): unknown {
  const bytes = decodeBase64Url(token.split(".")[index] ?? "");
  if (!bytes) throw new Error("bad segment");
  return JSON.parse(new TextDecoder().decode(bytes));
}

describe("base64url", () => {
  it("round-trips and rejects non-canonical input", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(decodeBase64Url(encodeBase64Url(bytes))).toEqual(bytes);
    expect(decodeBase64Url("AQ==")).toBeNull(); // padding
    expect(decodeBase64Url("AR")).toBeNull(); // non-zero trailing bits (canonical form is "AQ")
    expect(decodeBase64Url("A+/B")).toBeNull(); // standard alphabet
    expect(decodeBase64Url("A")).toBeNull();
  });
});

describe("Ed25519 entitlement tokens (WebCrypto)", () => {
  it("round-trips: what the API signs verifies with the published public key", async () => {
    const token = await signEntitlement(ownerDoc, signer.key);
    const result = await verifyEntitlementToken(token, signer.trusted, NOW_S);
    expect(result).toEqual({ ok: true, entitlement: ownerDoc });
  });

  it("uses a JWS header naming the algorithm, key and document type", async () => {
    const token = await signEntitlement(ownerDoc, signer.key);
    expect(segmentJson(token, 0)).toEqual({ alg: "EdDSA", kid: "test-a", typ: TYP });
    expect(token.startsWith(`${encodeSigningInput(ownerDoc)}.`)).toBe(true);
  });

  it("refuses to sign with a key other than the one the document names", async () => {
    await expect(signEntitlement({ ...ownerDoc, keyId: "test-b" }, signer.key)).rejects.toThrow(/keyId/);
  });

  it("rejects a tampered payload (e.g. pro rewritten to owner)", async () => {
    const pro = buildEntitlement(ACCOUNT, { tier: "pro", grantExpiresAt: null }, NOW, "test-a");
    const token = await signEntitlement(pro, signer.key);
    const forged = encodeBase64UrlText(
      JSON.stringify({ ...pro, tier: "owner", unrestricted: true, features: [], limits: {} }),
    );
    expect(await verifyEntitlementToken(replaceSegment(token, 1, forged), signer.trusted, NOW_S)).toEqual({
      ok: false,
      error: "bad_signature",
    });
  });

  it("rejects a flipped signature bit", async () => {
    const token = await signEntitlement(ownerDoc, signer.key);
    const signature = decodeBase64Url(token.split(".")[2] ?? "") ?? new Uint8Array();
    signature[0] = (signature[0] ?? 0) ^ 1;
    const result = await verifyEntitlementToken(
      replaceSegment(token, 2, encodeBase64Url(signature)),
      signer.trusted,
      NOW_S,
    );
    expect(result).toEqual({ ok: false, error: "bad_signature" });
  });

  it("rejects a document signed by an untrusted key, even when it claims a trusted kid", async () => {
    const token = await signEntitlement({ ...ownerDoc, keyId: "test-b" }, other.key);
    expect(await verifyEntitlementToken(token, signer.trusted, NOW_S)).toEqual({ ok: false, error: "unknown_key" });
    const header = encodeBase64UrlText(JSON.stringify({ alg: "EdDSA", kid: "test-a", typ: TYP }));
    expect(await verifyEntitlementToken(replaceSegment(token, 0, header), signer.trusted, NOW_S)).toEqual({
      ok: false,
      error: "bad_signature",
    });
  });

  it("rejects other algorithms and document types", async () => {
    const token = await signEntitlement(ownerDoc, signer.key);
    for (const header of [
      { alg: "none", kid: "test-a", typ: TYP },
      { alg: "HS256", kid: "test-a", typ: TYP },
      { alg: "EdDSA", kid: "test-a", typ: "JWT" },
      { alg: "EdDSA", typ: TYP },
    ]) {
      const result = await verifyEntitlementToken(
        replaceSegment(token, 0, encodeBase64UrlText(JSON.stringify(header))),
        signer.trusted,
        NOW_S,
      );
      expect(result).toEqual({ ok: false, error: "unsupported_header" });
    }
  });

  it("rejects malformed tokens", async () => {
    const token = await signEntitlement(ownerDoc, signer.key);
    for (const bad of ["", "a.b", `${token}.x`, replaceSegment(token, 2, "AAAA"), "x".repeat(9000)]) {
      expect(await verifyEntitlementToken(bad, signer.trusted, NOW_S)).toEqual({ ok: false, error: "malformed" });
    }
  });

  it("rejects expired and future-dated documents, with bounded clock skew", async () => {
    const token = await signEntitlement(ownerDoc, signer.key);
    expect((await verifyEntitlementToken(token, signer.trusted, ownerDoc.expiresAt - 1)).ok).toBe(true);
    expect(await verifyEntitlementToken(token, signer.trusted, ownerDoc.expiresAt)).toEqual({
      ok: false,
      error: "expired",
    });
    expect((await verifyEntitlementToken(token, signer.trusted, NOW_S - ENTITLEMENT_CLOCK_SKEW_SECONDS)).ok).toBe(true);
    expect(await verifyEntitlementToken(token, signer.trusted, NOW_S - ENTITLEMENT_CLOCK_SKEW_SECONDS - 1)).toEqual({
      ok: false,
      error: "not_yet_valid",
    });
  });

  it("rejects validly signed but invalid documents", async () => {
    const liar = {
      ...buildEntitlement(ACCOUNT, { tier: "pro", grantExpiresAt: null }, NOW, "test-a"),
      unrestricted: true,
    };
    const token = await signEntitlement(liar, signer.key);
    expect(await verifyEntitlementToken(token, signer.trusted, NOW_S)).toEqual({
      ok: false,
      error: "invalid_document",
    });
  });
});
