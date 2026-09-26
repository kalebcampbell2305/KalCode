import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PLANS } from "@kalcode/protocol/plans";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const source = readFileSync(resolve(root, "src/pages/account.astro"), "utf8");

describe("Account page", () => {
  it("offers email and social sign-in while keeping the website session out of script storage", () => {
    const providerTemplate = "$" + "{provider}";
    const socialCompletePath = `/v1/auth/${providerTemplate}/complete`;
    expect(source).toContain("Account access");
    expect(source).toContain("One account. No password to remember.");
    expect(source).toContain("HttpOnly cookie");
    expect(source).toContain("Continue with Google");
    expect(source).toContain("Continue with Microsoft");
    expect(source).toContain(`/v1/auth/${providerTemplate}/start`);
    expect(source).toContain(socialCompletePath);
    expect(source).toContain("/v1/auth/email/start");
    expect(source).toContain("/v1/auth/email/verify");
    expect(source).toContain("location.hash.slice(1)");
    expect(source).not.toContain('searchParams.get("verify")');
    expect(source).toContain("sessionStorage.setItem");
    expect(source).toContain("sessionStorage.removeItem");
    expect(source).not.toMatch(/localStorage|document\.cookie/);
    expect(source).not.toMatch(/sessionStorage\.setItem\([^\n]*(?:token|session|kcs_)/i);
    expect(source.indexOf("sessionStorage.removeItem")).toBeLessThan(source.indexOf(socialCompletePath));
  });

  it("states the current billing boundaries in user language", () => {
    expect(source).toContain("KalVoice Requests");
    expect(source).toContain("remaining · Renews");
    expect(source).toContain("Unlimited on every plan");
    expect(source).toContain("Handled by your connected provider");
    expect(source).toContain("Confirming your plan…");
    expect(source).toContain("Your paid plan is not active yet.");
    expect(source).not.toContain("Payment received");
    expect(source).not.toContain("OWNER");
    expect(source).not.toMatch(/>\s*Tokens?\s*</i);
  });

  it("renders every paid plan from the canonical protocol catalog without hardcoded prices", () => {
    expect(PLANS.filter((plan) => plan.price.amountUsd > 0).map((plan) => plan.id)).toEqual(["pro", "max", "max2x"]);
    expect(source).toContain('from "@kalcode/protocol/plans"');
    expect(source).toContain("paidPlans.map");
    expect(source).toContain("formatPrice(plan.price)");
    expect(source).not.toMatch(/\$\s?(10|25|50)\b/);
  });
});
