import { describe, expect, it } from "vitest";
import { validateRemoval, validateSignup } from "../../worker/lib/validation";

describe("validateSignup", () => {
  it("normalizes the email and keeps a known source", () => {
    expect(validateSignup({ email: "  Ada@Example.com ", source: "/download", website: "" })).toEqual({
      ok: true,
      value: { email: "ada@example.com", source: "/download", isBot: false },
    });
  });

  it("allows a missing or null source", () => {
    expect(validateSignup({ email: "a@example.com" })).toMatchObject({
      ok: true,
      value: { source: null },
    });
    expect(validateSignup({ email: "a@example.com", source: null })).toMatchObject({ ok: true });
  });

  it.each(["/nope", "https://evil.example/", "", 42, "/api/early-access", "/404"])(
    "rejects unknown source %j",
    (source) => {
      expect(validateSignup({ email: "a@example.com", source })).toMatchObject({
        ok: false,
        error: "invalid_source",
      });
    },
  );

  it.each([undefined, null, 42, "", "not-an-email", ["a@example.com"]])("rejects email %j", (email) => {
    expect(validateSignup({ email, source: "/" })).toMatchObject({
      ok: false,
      error: "invalid_email",
    });
  });

  it.each([null, "a@example.com", [], 3])("rejects non-object body %j", (body) => {
    expect(validateSignup(body)).toMatchObject({ ok: false, error: "invalid_body" });
  });

  it("treats a filled honeypot as a bot without validating anything else", () => {
    expect(validateSignup({ email: "garbage", source: "/evil", website: "https://spam" })).toEqual({
      ok: true,
      value: { email: "", source: null, isBot: true },
    });
  });

  it("ignores a whitespace-only honeypot", () => {
    expect(validateSignup({ email: "a@example.com", website: "   " })).toMatchObject({
      ok: true,
      value: { isBot: false },
    });
  });

  it("rejects a non-string honeypot", () => {
    expect(validateSignup({ email: "a@example.com", website: 1 })).toMatchObject({ ok: false });
  });
});

describe("validateRemoval", () => {
  it("normalizes the email", () => {
    expect(validateRemoval({ email: " B@Example.com" })).toEqual({
      ok: true,
      value: { email: "b@example.com" },
    });
  });

  it("rejects invalid input", () => {
    expect(validateRemoval({ email: "nope" })).toMatchObject({ ok: false, error: "invalid_email" });
    expect(validateRemoval("x")).toMatchObject({ ok: false, error: "invalid_body" });
  });
});
