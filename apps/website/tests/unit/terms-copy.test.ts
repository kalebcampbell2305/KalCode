import { createHash } from "node:crypto";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReleaseManifest } from "../../src/data/releases";
import { publishedManifest } from "./fixtures/releases";

const fixture = vi.hoisted(() => ({ manifest: {} as ReleaseManifest }));
vi.mock("../../src/lib/releases", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/releases")>()),
  RELEASES: fixture.manifest,
}));

import Terms from "../../src/pages/terms.astro";

beforeEach(() => Object.assign(fixture.manifest, structuredClone(publishedManifest)));

/** A signed Stable 0.1.6 selection for Windows and Apple silicon, as the publisher generates it. */
function selectSignedStable() {
  const latest = fixture.manifest.latest;
  const windows = latest?.platforms[0];
  if (!latest || !windows) throw new Error("fixture has no Windows release");
  latest.version = "0.1.6";
  latest.channel = "stable";
  windows.signed = true;
  latest.platforms.push({
    os: "macos",
    arch: "arm64",
    label: "macOS 14 or later, Apple silicon",
    kind: "dmg",
    file: "KalCode_0.1.6_arm64.dmg",
    url: "/download/macos-arm64",
    pinnedUrl: "/download/0.1.6/KalCode_0.1.6_arm64.dmg",
    size: 14_048_116,
    sha256: "d".repeat(64),
    signed: true,
  });
  fixture.manifest.unavailable = fixture.manifest.unavailable.filter((entry) => entry.os !== "macos");
}

async function renderTerms() {
  const container = await AstroContainer.create();
  return container.renderToString(Terms, { request: new Request("https://kalcoded.com/terms") });
}

/** The legal text: from the page heading to the end of the terms section. */
function legal(html: string) {
  const start = html.indexOf("<h1");
  return html.slice(start, html.indexOf("</section>", start) + "</section>".length);
}

function text(html: string) {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

function meta(html: string) {
  return html.match(/<meta name="description" content="([^"]*)"/)?.[1];
}

// The owner approved the Stable wording on 2026-09-29 (target/recovery-B9-publish/
// TERMS-WORDING-PROPOSAL.md, #1-#6 with the no-price #4). The preview terms must not change at all.
describe("/terms in preview mode", () => {
  it("renders the legal text byte-identical to the terms before the Stable wording", async () => {
    const html = await renderTerms();
    expect(createHash("sha256").update(legal(html)).digest("hex")).toBe(
      "d5e823076460105cc5a25c7e942409a638d45e26c9bf69655411ddb74e2fb879",
    );
    expect(meta(html)).toBe(
      "Terms of use for kalcoded.com, the KalCode early-access list and the KalCode preview app.",
    );
    expect(text(html)).toContain("Last updated September 24, 2026");
  });
});

describe("/terms once Stable is served", () => {
  it("scopes the terms to every version of the app with the approved sentences", async () => {
    selectSignedStable();
    const html = await renderTerms();
    const copy = text(html);
    for (const sentence of [
      "These terms cover kalcoded.com, the KalCode early-access list and the KalCode app.",
      "Last updated September 29, 2026",
      "The site describes KalCode. Descriptions of features, plans and prices reflect current plans and may change.",
      "3. The KalCode app",
      "The app is currently offered as Stable releases and preview versions. These terms apply to every version of the app until a version comes with terms of its own.",
      "Preview quality. Preview versions are incomplete, may contain errors, may change or remove features, and may not be code-signed.",
    ]) {
      expect(copy).toContain(sentence);
    }
    expect(meta(html)).toBe("Terms of use for kalcoded.com, the KalCode early-access list and the KalCode app.");
    // The /download preview link still lands on the app section.
    expect(html).toContain('<h2 id="preview">3. The KalCode app</h2>');
  });

  it("drops the preview-only scoping and the price words", async () => {
    selectSignedStable();
    const html = await renderTerms();
    const copy = `${text(html)} ${meta(html)}`;
    for (const phrase of [
      /preview app/i,
      /early preview/i,
      /free preview/i,
      /free of charge/i,
      /not code-signed yet/i,
      /every preview version/i,
      /September 24, 2026/,
    ]) {
      expect(copy).not.toMatch(phrase);
    }
  });

  it("keeps every other clause word for word", async () => {
    selectSignedStable();
    const stable = text(await renderTerms());
    Object.assign(fixture.manifest, structuredClone(publishedManifest));
    const preview = text(await renderTerms());
    for (const clause of [
      "Licence. We give you a personal, non-exclusive, non-transferable, revocable licence",
      "Restrictions. Do not sell, rent, redistribute or publicly host the app",
      "Ending use. You may stop at any time by uninstalling the app. We may end a preview; the licence for that version then ends and you should uninstall it.",
      "Nothing on the site is an offer to sell, and no purchase can be made through it today.",
      "The site and the app are provided “as is” and “as available”.",
      "Nothing in these terms limits liability that cannot be limited by law.",
      "We may update these terms. When we do, we will change the date at the top of this page.",
    ]) {
      expect(stable).toContain(clause);
      expect(preview).toContain(clause);
    }
    // Only the six approved sentences and the date differ between the two modes.
    const words = (copy: string) => copy.split(" ").length;
    expect(Math.abs(words(stable) - words(preview))).toBeLessThan(40);
  });
});
