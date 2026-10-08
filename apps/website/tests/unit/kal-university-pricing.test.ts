import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it } from "vitest";
import KalUniversity from "../../src/pages/games/kal-university.astro";

async function render() {
  const container = await AstroContainer.create();
  return container.renderToString(KalUniversity, {
    request: new Request("https://kalcoded.com/games/kal-university"),
  });
}

function text(html: string) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

describe("KAL University pricing", () => {
  it("shows the planned standalone $9.99 USD one-time price", async () => {
    const copy = text(await render());

    expect(copy).toContain("Planned as a standalone $9.99 USD one-time purchase, with no subscription.");
    expect(copy).toContain(
      "KAL University is planned as a standalone $9.99 USD one-time purchase with no subscription.",
    );
    expect(copy).not.toMatch(/price (?:isn't|is not) set|price will be announced/i);
  });

  it("keeps all four game download controls disabled", async () => {
    const html = await render();
    const main = html.match(/<main\b[\s\S]*?<\/main>/i)?.[0];
    expect(main).toBeDefined();
    const downloadControls = main?.match(/<button\b[^>]*class="[^"]*cf-soon[^"]*"[^>]*>/g) ?? [];

    expect(downloadControls).toHaveLength(4);
    for (const control of downloadControls) expect(control).toMatch(/\bdisabled(?:=""|\s|>)/);
  });

  it("exposes no game purchase form or checkout link", async () => {
    const html = await render();
    const main = html.match(/<main\b[\s\S]*?<\/main>/i)?.[0];
    expect(main).toBeDefined();

    expect(main).not.toMatch(/<form\b/i);
    expect(main).not.toMatch(/href="[^"]*\b(?:account|checkout|purchase)\b/i);
  });
});
