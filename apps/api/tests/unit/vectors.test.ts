/**
 * Cross-language test vectors: signed in TypeScript (WebCrypto, the API's signer), verified by
 * both this file and the Rust desktop verifier (`crates/entitlements/tests/vectors.rs`).
 *
 * The committed file holds only PUBLIC keys and tokens. It was generated with throwaway keys
 * whose private halves were discarded:
 *
 *   UPDATE_VECTORS=1 pnpm --filter @kalcode/api exec vitest run tests/unit/vectors.test.ts
 *
 * Normal runs check that (a) every committed token still verifies (or fails) exactly as
 * recorded, (b) the committed tokens use the current encoding, and (c) the evaluator results
 * recorded for Rust match the TypeScript evaluator — so the two implementations cannot drift.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ENTITLEMENT_CLOCK_SKEW_SECONDS,
  ENTITLEMENT_DOCUMENT_TTL_SECONDS,
  ENTITLEMENT_DOCUMENT_VERSION,
  ENTITLEMENT_MAX_DOCUMENT_LIFETIME_SECONDS,
  type Entitlement,
  hasFeature,
  limitFor,
  tierGrants,
} from "@kalcode/protocol/entitlements";
import {
  USAGE_RECEIPT_MAX_LIFETIME_SECONDS,
  USAGE_RECEIPT_TTL_SECONDS,
  type UsageReceipt,
} from "@kalcode/protocol/usage-receipts";
import { describe, expect, it } from "vitest";
import { decodeBase64Url, encodeBase64Url, encodeBase64UrlText } from "../../worker/lib/base64url";
import { buildEntitlement } from "../../worker/lib/entitlement";
import {
  encodeSigningInput,
  importPublicKey,
  MAX_TOKEN_LENGTH,
  signEntitlement,
  signUsageReceipt,
  TOKEN_ALGORITHM,
  TOKEN_TYPE,
  USAGE_TOKEN_TYPE,
  type VerifyError,
  verifyEntitlementToken,
  verifyUsageReceipt,
} from "../../worker/lib/token";
import { generateSigningKey } from "../support/keys";
import { REPO_ROOT } from "../support/wrangler";

const VECTORS_PATH = join(REPO_ROOT, "crates", "entitlements", "testdata", "vectors.json");

const T0 = 1_790_000_000; // 2026-09-21T14:13:20Z
const ACCOUNT = "0b6f1c1e-5a39-4d0c-9a0f-2b1f7d9e4c11";
const FEATURE_QUERIES = ["persistentAgents", "advancedMissions", "eventAutomations", "featureAddedInTheFuture"];
const LIMIT_QUERIES = ["parallelAgents", "openTerminals", "kalvoiceRequestsPerMonth", "limitAddedInTheFuture"];

type Expectation =
  | { ok: true; entitlement: Entitlement; features: Record<string, boolean>; limits: Record<string, number | null> }
  | { ok: false; error: VerifyError };

interface VectorCase {
  name: string;
  token: string;
  now: number;
  /** True when the token is exactly what `signEntitlement` produces for `expect.entitlement`. */
  canonical: boolean;
  expect: Expectation;
}

interface Vectors {
  comment: string;
  constants: {
    documentVersion: number;
    documentTtlSeconds: number;
    maxDocumentLifetimeSeconds: number;
    clockSkewSeconds: number;
    maxTokenLength: number;
    tokenType: string;
    usageTokenType: string;
    usageReceiptTtlSeconds: number;
    usageReceiptMaxLifetimeSeconds: number;
    algorithm: string;
  };
  freeGrants: ReturnType<typeof tierGrants>;
  keys: { kid: string; x: string }[];
  rfc8032: { secret: string; public: string; message: string; signature: string }[];
  cases: VectorCase[];
  receiptCases: ReceiptCase[];
}

interface ReceiptCase {
  name: string;
  token: string;
  now: number;
  expect: { ok: true; receipt: UsageReceipt } | { ok: false; error: VerifyError };
}

// RFC 8032 §7.1, TEST 1 and TEST 2 (hex).
const RFC8032 = [
  {
    secret: "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
    public: "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
    message: "",
    signature:
      "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
  },
  {
    secret: "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb",
    public: "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c",
    message: "72",
    signature:
      "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00",
  },
];

const hex = (value: string) => Uint8Array.from(value.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
const toHex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

function evaluate(entitlement: Entitlement): Pick<Extract<Expectation, { ok: true }>, "features" | "limits"> {
  return {
    features: Object.fromEntries(FEATURE_QUERIES.map((f) => [f, hasFeature(entitlement, f)])),
    limits: Object.fromEntries(LIMIT_QUERIES.map((l) => [l, limitFor(entitlement, l)])),
  };
}

/** Signs arbitrary header/payload objects — used to build deliberately invalid vectors. */
async function signRaw(header: unknown, payload: unknown, privateKey: CryptoKey): Promise<string> {
  const input = `${encodeBase64UrlText(JSON.stringify(header))}.${encodeBase64UrlText(JSON.stringify(payload))}`;
  const signature = await crypto.subtle.sign({ name: "Ed25519" }, privateKey, new TextEncoder().encode(input));
  return `${input}.${encodeBase64Url(new Uint8Array(signature))}`;
}

function replaceSegment(token: string, index: number, value: string): string {
  const parts = token.split(".");
  parts[index] = value;
  return parts.join(".");
}

async function generateVectors(): Promise<Vectors> {
  const trusted = await generateSigningKey("test-vectors-1");
  const untrusted = await generateSigningKey("test-vectors-untrusted");
  const kid = trusted.key.keyId;
  const header = { alg: TOKEN_ALGORITHM, kid, typ: TOKEN_TYPE };
  const issue = (tier: Entitlement["tier"]) =>
    buildEntitlement(ACCOUNT, { tier, grantExpiresAt: null, billingAnchor: null }, new Date(T0 * 1000), kid);
  const cases: VectorCase[] = [];
  const valid = async (name: string, entitlement: Entitlement, now = T0 + 60) => {
    const token = await signEntitlement(entitlement, trusted.key);
    cases.push({ name, token, now, canonical: true, expect: { ok: true, entitlement, ...evaluate(entitlement) } });
    return token;
  };
  const invalid = (name: string, token: string, error: VerifyError, now = T0 + 60) => {
    cases.push({ name, token, now, canonical: false, expect: { ok: false, error } });
  };

  const owner = issue("owner");
  const ownerToken = await valid("owner", owner);
  const proToken = await valid("pro", issue("pro"));
  await valid("max", issue("max"));
  await valid("max2x", issue("max2x"));
  await valid("free", issue("free"));
  await valid("owner-last-valid-second", owner, owner.expiresAt - 1);
  await valid("owner-within-clock-skew", owner, T0 - ENTITLEMENT_CLOCK_SKEW_SECONDS);

  const withExtra = { ...issue("owner"), addedByANewerServer: { anything: true } };
  const extraToken = await signRaw(header, withExtra, trusted.key.privateKey);
  const { addedByANewerServer: _ignored, ...withoutExtra } = withExtra;
  cases.push({
    name: "owner-with-unknown-fields",
    token: extraToken,
    now: T0 + 60,
    canonical: false,
    expect: { ok: true, entitlement: withoutExtra, ...evaluate(withoutExtra) },
  });

  invalid("owner-expired", ownerToken, "expired", owner.expiresAt);
  invalid("owner-not-yet-valid", ownerToken, "not_yet_valid", T0 - ENTITLEMENT_CLOCK_SKEW_SECONDS - 1);
  const forgedPayload = encodeBase64UrlText(JSON.stringify({ ...issue("owner"), accountId: ACCOUNT }));
  invalid("pro-payload-replaced-with-owner", replaceSegment(proToken, 1, forgedPayload), "bad_signature");
  const sig = decodeBase64Url(ownerToken.split(".")[2] ?? "") ?? new Uint8Array(64);
  sig[10] = (sig[10] ?? 0) ^ 0x80;
  invalid("owner-signature-bit-flipped", replaceSegment(ownerToken, 2, encodeBase64Url(sig)), "bad_signature");
  invalid(
    "owner-signed-by-untrusted-key",
    await signEntitlement({ ...owner, keyId: untrusted.key.keyId }, untrusted.key),
    "unknown_key",
  );
  invalid(
    "owner-signed-by-untrusted-key-claiming-trusted-kid",
    await signRaw(header, owner, untrusted.key.privateKey),
    "bad_signature",
  );
  invalid("alg-none", await signRaw({ ...header, alg: "none" }, owner, trusted.key.privateKey), "unsupported_header");
  invalid("wrong-typ", await signRaw({ ...header, typ: "JWT" }, owner, trusted.key.privateKey), "unsupported_header");
  invalid(
    "pro-claiming-unrestricted",
    await signRaw(header, { ...issue("pro"), unrestricted: true }, trusted.key.privateKey),
    "invalid_document",
  );
  invalid(
    "owner-not-unrestricted",
    await signRaw(header, { ...owner, unrestricted: false }, trusted.key.privateKey),
    "invalid_document",
  );
  invalid(
    "lifetime-too-long",
    await signRaw(
      header,
      { ...owner, expiresAt: owner.issuedAt + ENTITLEMENT_MAX_DOCUMENT_LIFETIME_SECONDS + 1 },
      trusted.key.privateKey,
    ),
    "invalid_document",
  );
  invalid(
    "payload-kid-mismatch",
    await signRaw(header, { ...owner, keyId: "test-vectors-other" }, trusted.key.privateKey),
    "invalid_document",
  );
  invalid(
    "unknown-tier",
    await signRaw(header, { ...owner, tier: "enterprise", unrestricted: false }, trusted.key.privateKey),
    "invalid_document",
  );
  invalid("two-segments", ownerToken.split(".").slice(0, 2).join("."), "malformed");
  invalid("padded-signature", `${ownerToken}==`, "malformed");
  invalid("oversized", `${ownerToken}${"A".repeat(MAX_TOKEN_LENGTH)}`, "malformed");

  // KalVoice usage receipts, signed by the same key with their own document type.
  const receiptCases: ReceiptCase[] = [];
  const receipt = (tier: UsageReceipt["tier"], used: number, allowance: number | null): UsageReceipt => ({
    version: 1,
    accountId: ACCOUNT,
    tier,
    used,
    allowance,
    periodStart: "2026-09-10T08:00:00.000Z",
    resetsAt: "2026-10-10T08:00:00.000Z",
    issuedAt: T0,
    expiresAt: T0 + USAGE_RECEIPT_TTL_SECONDS,
    keyId: kid,
  });
  const usageHeader = { ...header, typ: USAGE_TOKEN_TYPE };
  const receiptOk = async (name: string, value: UsageReceipt, now = T0 + 60) => {
    const token = await signUsageReceipt(value, trusted.key);
    receiptCases.push({ name, token, now, expect: { ok: true, receipt: value } });
    return token;
  };
  const receiptBad = (name: string, token: string, error: VerifyError, now = T0 + 60) => {
    receiptCases.push({ name, token, now, expect: { ok: false, error } });
  };
  const proReceipt = receipt("pro", 41, 150);
  const proReceiptToken = await receiptOk("pro-receipt", proReceipt);
  await receiptOk("owner-receipt", receipt("owner", 12_345, null));
  await receiptOk("max2x-receipt", receipt("max2x", 550, 1_000));
  await receiptOk("free-receipt-exhausted", receipt("free", 25, 25));
  receiptBad("pro-receipt-expired", proReceiptToken, "expired", proReceipt.expiresAt);
  receiptBad("entitlement-presented-as-receipt", ownerToken, "unsupported_header");
  cases.push({
    name: "receipt-presented-as-entitlement",
    token: proReceiptToken,
    now: T0 + 60,
    canonical: false,
    expect: { ok: false, error: "unsupported_header" },
  });
  receiptBad(
    "owner-receipt-with-a-number",
    await signRaw(usageHeader, receipt("owner", 1, 10), trusted.key.privateKey),
    "invalid_document",
  );
  receiptBad(
    "receipt-lifetime-too-long",
    await signRaw(
      usageHeader,
      { ...proReceipt, expiresAt: T0 + USAGE_RECEIPT_MAX_LIFETIME_SECONDS + 1 },
      trusted.key.privateKey,
    ),
    "invalid_document",
  );
  receiptBad(
    "receipt-resets-before-it-starts",
    await signRaw(usageHeader, { ...proReceipt, resetsAt: proReceipt.periodStart }, trusted.key.privateKey),
    "invalid_document",
  );
  const forgedReceipt = encodeBase64UrlText(JSON.stringify({ ...proReceipt, used: 0 }));
  receiptBad("receipt-used-rewritten", replaceSegment(proReceiptToken, 1, forgedReceipt), "bad_signature");

  return {
    comment:
      "Generated by apps/api/tests/unit/vectors.test.ts (UPDATE_VECTORS=1) with throwaway keys whose private halves were discarded. Test-only: these keys are never trusted by production builds.",
    constants: {
      documentVersion: ENTITLEMENT_DOCUMENT_VERSION,
      documentTtlSeconds: ENTITLEMENT_DOCUMENT_TTL_SECONDS,
      maxDocumentLifetimeSeconds: ENTITLEMENT_MAX_DOCUMENT_LIFETIME_SECONDS,
      clockSkewSeconds: ENTITLEMENT_CLOCK_SKEW_SECONDS,
      maxTokenLength: MAX_TOKEN_LENGTH,
      tokenType: TOKEN_TYPE,
      usageTokenType: USAGE_TOKEN_TYPE,
      usageReceiptTtlSeconds: USAGE_RECEIPT_TTL_SECONDS,
      usageReceiptMaxLifetimeSeconds: USAGE_RECEIPT_MAX_LIFETIME_SECONDS,
      algorithm: TOKEN_ALGORITHM,
    },
    freeGrants: tierGrants("free"),
    keys: [{ kid, x: trusted.key.publicKey }],
    rfc8032: RFC8032,
    cases,
    receiptCases,
  };
}

if (process.env.UPDATE_VECTORS === "1") {
  writeFileSync(VECTORS_PATH, `${JSON.stringify(await generateVectors(), null, 2)}\n`);
}

const vectors = JSON.parse(readFileSync(VECTORS_PATH, "utf8")) as Vectors;

describe("shared entitlement vectors", () => {
  it("pin the protocol constants and the Free fallback the desktop uses", () => {
    expect(vectors.constants).toEqual({
      documentVersion: ENTITLEMENT_DOCUMENT_VERSION,
      documentTtlSeconds: ENTITLEMENT_DOCUMENT_TTL_SECONDS,
      maxDocumentLifetimeSeconds: ENTITLEMENT_MAX_DOCUMENT_LIFETIME_SECONDS,
      clockSkewSeconds: ENTITLEMENT_CLOCK_SKEW_SECONDS,
      maxTokenLength: MAX_TOKEN_LENGTH,
      tokenType: TOKEN_TYPE,
      usageTokenType: USAGE_TOKEN_TYPE,
      usageReceiptTtlSeconds: USAGE_RECEIPT_TTL_SECONDS,
      usageReceiptMaxLifetimeSeconds: USAGE_RECEIPT_MAX_LIFETIME_SECONDS,
      algorithm: TOKEN_ALGORITHM,
    });
    expect(vectors.freeGrants).toEqual(tierGrants("free"));
  });

  it("cover every tier and every verification error", () => {
    const tiers = vectors.cases.flatMap((c) => (c.expect.ok ? [c.expect.entitlement.tier] : []));
    expect(new Set(tiers)).toEqual(new Set(["free", "pro", "max", "max2x", "owner"]));
    const errors = vectors.cases.flatMap((c) => (c.expect.ok ? [] : [c.expect.error]));
    expect(new Set(errors)).toEqual(
      new Set([
        "malformed",
        "unsupported_header",
        "unknown_key",
        "bad_signature",
        "invalid_document",
        "not_yet_valid",
        "expired",
      ]),
    );
  });

  it("verify in TypeScript exactly as recorded", async () => {
    const keys = new Map<string, CryptoKey>();
    for (const { kid, x } of vectors.keys) {
      const key = await importPublicKey(x);
      if (!key) throw new Error(`bad vector key ${kid}`);
      keys.set(kid, key);
    }
    for (const vector of vectors.cases) {
      const result = await verifyEntitlementToken(vector.token, keys, vector.now);
      if (vector.expect.ok) {
        expect(result, vector.name).toEqual({ ok: true, entitlement: vector.expect.entitlement });
        const { features, limits } = evaluate(vector.expect.entitlement);
        expect({ features, limits }, vector.name).toEqual({
          features: vector.expect.features,
          limits: vector.expect.limits,
        });
        if (vector.canonical) {
          expect(vector.token.startsWith(`${encodeSigningInput(vector.expect.entitlement)}.`), vector.name).toBe(true);
        }
      } else {
        expect(result, vector.name).toEqual({ ok: false, error: vector.expect.error });
      }
    }
  });

  it("verify usage receipts in TypeScript exactly as recorded", async () => {
    const keys = new Map<string, CryptoKey>();
    for (const { kid, x } of vectors.keys) {
      const key = await importPublicKey(x);
      if (key) keys.set(kid, key);
    }
    expect(vectors.receiptCases.length).toBeGreaterThanOrEqual(9);
    for (const vector of vectors.receiptCases) {
      expect(await verifyUsageReceipt(vector.token, keys, vector.now), vector.name).toEqual(vector.expect);
    }
  });

  it("record owner as unrestricted for features and limits that do not exist yet", () => {
    const owner = vectors.cases.find((c) => c.name === "owner");
    expect(owner?.expect).toMatchObject({
      ok: true,
      features: { featureAddedInTheFuture: true },
      limits: { parallelAgents: null, kalvoiceRequestsPerMonth: null, limitAddedInTheFuture: null },
    });
  });
});

describe("WebCrypto Ed25519 known answers (RFC 8032 §7.1)", () => {
  it.each(RFC8032.map((v, i) => [i + 1, v] as const))("TEST %i signs and verifies", async (_n, vector) => {
    const privateKey = await crypto.subtle.importKey(
      "jwk",
      {
        kty: "OKP",
        crv: "Ed25519",
        d: encodeBase64Url(hex(vector.secret)),
        x: encodeBase64Url(hex(vector.public)),
      },
      { name: "Ed25519" },
      false,
      ["sign"],
    );
    const signature = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, privateKey, hex(vector.message)));
    expect(toHex(signature)).toBe(vector.signature);
    const publicKey = await importPublicKey(encodeBase64Url(hex(vector.public)));
    if (!publicKey) throw new Error("import failed");
    expect(await crypto.subtle.verify({ name: "Ed25519" }, publicKey, hex(vector.signature), hex(vector.message))).toBe(
      true,
    );
    expect(vectors.rfc8032).toContainEqual(vector);
  });
});
