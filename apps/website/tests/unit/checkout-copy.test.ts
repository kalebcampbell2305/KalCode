import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { afterEach, describe, expect, it, vi } from "vitest";
import Home from "../../src/pages/index.astro";
import Pricing from "../../src/pages/pricing.astro";
import Privacy from "../../src/pages/privacy.astro";

// Owner-approved 2026-09-30 (target/recovery-B10-release/CHECKOUT-GO-LIVE.md). The paid-plan copy
// follows the same strict PUBLIC_CHECKOUT_ENABLED build flag as the account page's checkout buttons.
async function render(page: typeof Home, path: string) {
  const container = await AstroContainer.create();
  const html = await container.renderToString(page, { request: new Request(`https://kalcoded.com${path}`) });
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ");
}

const PRIVACY_LINE =
  "Payments are processed by Stripe; KalCode receives your subscription status and billing contact, never your card details.";

describe("paid-plan copy", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("keeps the closed copy until checkout is open", async () => {
    expect(await render(Pricing, "/pricing")).toContain("Paid plans open soon · start on Free today");
    expect(await render(Home, "/")).toContain("Nothing is for sale today.");
    const privacy = await render(Privacy, "/privacy");
    expect(privacy).not.toContain(PRIVACY_LINE);
    expect(privacy).toContain("Last updated September 28, 2026");
  });

  it("sends buyers to their account and names Stripe once checkout is open", async () => {
    const closedPrivacy = await render(Privacy, "/privacy");
    vi.stubEnv("PUBLIC_CHECKOUT_ENABLED", "true");
    const pricing = await render(Pricing, "/pricing");
    expect(pricing).toContain("Paid plans are open · monthly or yearly");
    expect(pricing).toContain("How do I buy a plan?");
    expect(pricing).not.toMatch(/for sale today|Billing is not open yet/);
    const home = await render(Home, "/");
    expect(home).toContain("Paid plans are open, monthly or yearly.");
    expect(home).not.toContain("Nothing is for sale today.");
    const privacy = await render(Privacy, "/privacy");
    expect(privacy).toContain(PRIVACY_LINE);
    expect(privacy).toContain("Last updated September 30, 2026");
    // Only the approved line and the date differ.
    expect(privacy.replace(` ${PRIVACY_LINE}`, "").replace("September 30, 2026", "September 28, 2026")).toBe(
      closedPrivacy,
    );
  });
});
