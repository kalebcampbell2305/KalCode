import { createHash } from "node:crypto";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { expect, it } from "vitest";
import { CONTACT_EMAIL, FOOTER_NAV } from "../../src/lib/site";
import Terms from "../../src/pages/games/kal-university/terms.astro";

it("publishes the exact owner-approved game terms with the 14-day refund window", async () => {
  const container = await AstroContainer.create();
  const html = await container.renderToString(Terms, {
    request: new Request("https://kalcoded.com/games/kal-university/terms"),
  });
  const body = html.match(/<div[^>]*data-game-terms[^>]*>([\s\S]*?)<\/div>/)?.[1];
  expect(body).toBeDefined();
  const copy = (body ?? "")
    .replace(/<\/?(?:strong|a)\b[^>]*>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replaceAll(CONTACT_EMAIL, "{CONTACT_EMAIL}")
    .replace(/\s+/g, " ")
    .trim();
  // Computed from the approved Markdown body, not the rendered implementation.
  expect(createHash("sha256").update(copy).digest("hex")).toBe(
    "8e3a883e3ceed40fdef26bf282b49e09c627252d67ff7040eb84adce38028425",
  );
  expect(html).toContain(`href="mailto:${CONTACT_EMAIL}"`);
  expect(html).toContain("Last updated October 8, 2026");
  expect(html).toContain("Coming soon · Not on sale yet");
  expect(html).not.toMatch(/\{(?:UPDATED|CONTACT_EMAIL|REFUND_DAYS)\}/);
  expect(body?.match(/<h2[ >]/g)).toHaveLength(10);
  const termsIndex = FOOTER_NAV.legal.findIndex((link) => link.href === "/terms");
  expect(FOOTER_NAV.legal[termsIndex + 1]).toEqual({
    href: "/games/kal-university/terms",
    label: "KAL University terms",
  });
});
