import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { expect, it } from "vitest";
import { RELEASES, servedStableRelease } from "../../src/lib/releases";
import KalVoicePage from "../../src/pages/kalvoice.astro";
import Privacy from "../../src/pages/privacy.astro";

// Pins today's behavior against the real generated manifest (no fixture): KalVoice is labelled as
// in development until the publisher writes a signed Stable selection into releases.json.
it("labels KalVoice by what the committed manifest serves", async () => {
  const container = await AstroContainer.create();
  const kalvoice = await container.renderToString(KalVoicePage, {
    request: new Request("https://kalcoded.com/kalvoice"),
  });
  const privacy = await container.renderToString(Privacy, { request: new Request("https://kalcoded.com/privacy") });
  const stable = servedStableRelease(RELEASES);
  if (stable) {
    expect(kalvoice).toContain(`Available in KalCode Stable ${stable.version}`);
    expect(privacy).not.toContain("KalVoice (in development)");
  } else {
    expect(kalvoice).toContain('<p class="chip chip--dev">In development</p>');
    expect(privacy).toContain("KalVoice (in development)");
  }
});
