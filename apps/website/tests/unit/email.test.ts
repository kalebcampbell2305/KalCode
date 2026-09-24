import { describe, expect, it } from "vitest";
import { EMAIL_MAX_LENGTH, isValidEmail, normalizeEmail } from "../../src/lib/email";

describe("normalizeEmail", () => {
  it("trims and lowercases", () => {
    expect(normalizeEmail("  Ada.Lovelace@Example.COM \n")).toBe("ada.lovelace@example.com");
  });
});

describe("isValidEmail", () => {
  it.each([
    "a@example.com",
    "first.last@example.co.uk",
    "user+tag@sub.example.org",
    "o'brien@example.ie",
    "x@xn--80ak6aa92e.com",
    "u@example.xn--p1ai",
  ])("accepts %s", (email) => {
    expect(isValidEmail(email)).toBe(true);
  });

  it.each([
    "",
    "plainaddress",
    "@example.com",
    "user@",
    "user@example",
    "user@@example.com",
    "user@exa mple.com",
    ".user@example.com",
    "user.@example.com",
    "us..er@example.com",
    "user@-example.com",
    "user@example-.com",
    "user@example..com",
    "user@example.c",
    "user@example.123",
    '"quoted"@example.com',
    "user@[127.0.0.1]",
    "user@example.com\n",
    "<script>@example.com",
    "Upper@example.com",
  ])("rejects %j", (email) => {
    expect(isValidEmail(email)).toBe(false);
  });

  it("limits the local part to 64 characters", () => {
    expect(isValidEmail(`${"a".repeat(65)}@example.com`)).toBe(false);
    expect(isValidEmail(`${"a".repeat(64)}@example.com`)).toBe(true);
  });

  it("rejects addresses longer than 254 characters", () => {
    const label = "b".repeat(60);
    const tooLong = `abcdefghij@${label}.${label}.${label}.${label}.com`;
    expect(tooLong.length).toBeGreaterThan(EMAIL_MAX_LENGTH);
    expect(isValidEmail(tooLong)).toBe(false);
  });

  it("rejects domain labels longer than 63 characters", () => {
    expect(isValidEmail(`a@${"c".repeat(64)}.com`)).toBe(false);
  });
});
