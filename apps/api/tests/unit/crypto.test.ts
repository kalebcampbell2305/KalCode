import { describe, expect, it } from "vitest";
import { constantTimeEqual, hmacSha256Hex, sha256Base64Url } from "../../worker/lib/crypto";

describe("security crypto helpers", () => {
  it("matches the RFC 7636 S256 PKCE vector", async () => {
    expect(await sha256Base64Url("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("compares equal-length secrets without accepting encodings or prefixes", () => {
    expect(constantTimeEqual("abc123", "abc123")).toBe(true);
    expect(constantTimeEqual("abc123", "abc124")).toBe(false);
    expect(constantTimeEqual("abc123", "abc1230")).toBe(false);
  });

  it("computes deterministic lowercase HMAC-SHA256", async () => {
    expect(await hmacSha256Hex("key", "The quick brown fox jumps over the lazy dog")).toBe(
      "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8",
    );
  });
});
