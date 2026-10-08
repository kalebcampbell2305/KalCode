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
    expect(source).not.toMatch(/document\.cookie/);
    // localStorage holds only the plan chosen on /pricing (lib/checkout-intent.ts), never a session.
    // The page may also read (never write) the KAL University "continue" hint (lib/games-client.ts).
    const storageCalls = [...source.matchAll(/localStorage\.(\w+)\(([^,)]*)/g)].map((match) => [match[1], match[2]]);
    expect(storageCalls.length).toBeGreaterThan(0);
    for (const [method, key] of storageCalls) {
      expect(["getItem", "setItem", "removeItem"]).toContain(method);
      if (key === "GAMES_RETURN_KEY") expect(method).toBe("getItem");
      else expect(key).toBe("CHECKOUT_INTENT_KEY");
    }
    expect(source).not.toMatch(/sessionStorage\.setItem\([^\n]*(?:token|session|kcs_)/i);
    expect(source.indexOf("sessionStorage.removeItem")).toBeLessThan(source.indexOf(socialCompletePath));
  });

  it("states the current billing boundaries in user language", () => {
    expect(source).toContain("KalVoice Requests");
    expect(source).toContain("remaining`");
    expect(source).toContain("`Resets ${");
    expect(source).toContain("Unlimited on every plan");
    expect(source).toContain("Handled by your connected provider");
    expect(source).toContain("Confirming your plan…");
    expect(source).toContain("Your paid plan is not active yet.");
    expect(source).not.toContain("Payment received");
    expect(source).not.toMatch(/>\s*Tokens?\s*</i);
  });

  it("treats OWNER as permanent private access without subscription billing", () => {
    expect(source).toContain("<p data-owner-access hidden></p>");
    expect(source).toContain("No subscription payment is required");
    expect(source).toContain("billingPortal.hidden = owner");
    expect(source).toContain("ownerNotice.hidden = !owner");
    expect(source).toContain("checkoutClosedNotice.hidden = owner");
  });

  it("clears every account authority display before refreshing server state", () => {
    const start = source.indexOf("async function loadAccount");
    const request = source.indexOf('const response = await api("/v1/account")', start);
    expect(start).toBeGreaterThan(-1);
    expect(request).toBeGreaterThan(start);
    for (const reset of [
      'planOutput.textContent = "Plan unavailable"',
      'usageOutput.textContent = "Usage unavailable"',
      "activateFree.hidden = true",
      "upgrades.hidden = true",
      "ownerNotice.hidden = true",
      'ownerNotice.textContent = ""',
      "checkoutClosedNotice.hidden = true",
      "billingPortal.hidden = true",
    ]) {
      const resetAt = source.indexOf(reset, start);
      expect(resetAt, reset).toBeGreaterThan(start);
      expect(resetAt, reset).toBeLessThan(request);
    }
  });

  it("renders every paid plan from the canonical protocol catalog without hardcoded prices", () => {
    expect(PLANS.filter((plan) => plan.price.monthlyUsd > 0).map((plan) => plan.id)).toEqual(["pro", "max", "max2x"]);
    expect(source).toContain('from "@kalcode/protocol/plans"');
    expect(source).toContain("paidPlans.map");
    expect(source).toContain('formatPrice(plan, "month")');
    expect(source).toContain('formatPrice(plan, "year")');
    expect(source).not.toMatch(/\$\s?(10|25|50)\b/);
  });

  it("sends only a public tier and an interval to checkout, never a price", () => {
    const start = source.indexOf("async function startCheckout");
    const body = source.slice(start, source.indexOf("});", source.indexOf("JSON.stringify", start)));
    expect(body).toContain("tier,");
    expect(body).toContain("interval,");
    expect(body).toContain("requestId:");
    expect(body).not.toMatch(/price/i);
  });
});
