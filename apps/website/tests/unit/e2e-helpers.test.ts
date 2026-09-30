import { describe, expect, it } from "vitest";
import { type ReleaseManifest, servedStableRelease, signedStableRelease } from "../../src/lib/releases";
import { PAGES } from "../../src/lib/site";
// The e2e specs cannot import src/lib/releases.ts (Playwright rejects its JSON import), so
// helpers.ts restates the signed Stable rule; this keeps the two from drifting apart.
import { isServedStable, isSignedStable, renderedDescription } from "../e2e/helpers";
import { publishedManifest } from "./fixtures/releases";

function stable(mac: "signed" | "unsigned" | "none"): ReleaseManifest {
  const manifest = structuredClone(publishedManifest);
  if (!manifest.latest?.platforms[0]) throw new Error("fixture has no Windows release");
  manifest.latest.channel = "stable";
  manifest.latest.platforms[0].signed = true;
  if (mac !== "none") {
    manifest.latest.platforms.push({
      os: "macos",
      arch: "arm64",
      label: "macOS 14 or later, Apple silicon",
      kind: "dmg",
      file: "KalCode_0.1.0_arm64.dmg",
      url: "/download/macos-arm64",
      pinnedUrl: "/download/0.1.0/KalCode_0.1.0_arm64.dmg",
      size: 4_200_000,
      sha256: "d".repeat(64),
      signed: mac === "signed",
    });
    manifest.unavailable = manifest.unavailable.filter((entry) => entry.os !== "macos");
  }
  return manifest;
}

describe("e2e helpers", () => {
  it.each([
    ["preview", structuredClone(publishedManifest), false],
    ["signed Windows and Mac Stable", stable("signed"), true],
    ["Windows-only Stable", stable("none"), false],
    ["Stable with an unsigned Mac build", stable("unsigned"), false],
  ] as const)("isSignedStable matches signedStableRelease for a %s manifest", (_name, manifest, expected) => {
    expect(Boolean(signedStableRelease(manifest))).toBe(expected);
    expect(isSignedStable(manifest)).toBe(expected);
  });

  it.each([
    ["preview", structuredClone(publishedManifest), false],
    ["signed Windows and Mac Stable", stable("signed"), true],
    ["Windows-only Stable", stable("none"), true],
    ["Stable with an unsigned Mac build", stable("unsigned"), true],
  ] as const)("isServedStable matches servedStableRelease for a %s manifest", (_name, manifest, expected) => {
    expect(Boolean(servedStableRelease(manifest))).toBe(expected);
    expect(isServedStable(manifest)).toBe(expected);
  });

  it("expects the /kalvoice description kalvoice.astro renders in both release states", () => {
    const kalvoice = PAGES.find((page) => page.path === "/kalvoice");
    if (!kalvoice) throw new Error("no /kalvoice page");
    expect(kalvoice.description).toMatch(/ In development\.$/);
    expect(renderedDescription(kalvoice, false)).toBe(kalvoice.description);
    expect(renderedDescription(kalvoice, true)).not.toMatch(/In development/);
    expect(renderedDescription(kalvoice, true)).toBe(kalvoice.description.replace(/ In development\.$/, ""));
    const terms = PAGES.find((page) => page.path === "/terms");
    if (!terms) throw new Error("no /terms page");
    expect(renderedDescription(terms, false)).toBe(terms.description);
    expect(renderedDescription(terms, true)).toBe(
      "Terms of use for kalcoded.com, the KalCode early-access list and the KalCode app.",
    );
    for (const page of PAGES.filter((p) => p.path !== "/kalvoice" && p.path !== "/terms")) {
      expect(renderedDescription(page, true, "0.1.6")).toBe(page.description);
    }
    // A served Stable 0.1.7 names itself where the docs catalog text says 0.1.6 (Docs.astro releaseCopy).
    const providers = PAGES.find((page) => page.path === "/docs/providers");
    if (!providers) throw new Error("no /docs/providers page");
    expect(renderedDescription(providers, true, "0.1.7")).toContain("why Gemini CLI is unavailable in 0.1.7.");
    expect(renderedDescription(providers, false, "0.1.7")).toBe(providers.description);
  });
});
