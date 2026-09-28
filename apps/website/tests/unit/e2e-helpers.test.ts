import { describe, expect, it } from "vitest";
import { type ReleaseManifest, signedStableRelease } from "../../src/lib/releases";
// The e2e specs cannot import src/lib/releases.ts (Playwright rejects its JSON import), so
// helpers.ts restates the signed Stable rule; this keeps the two from drifting apart.
import { isSignedStable } from "../e2e/helpers";
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
});
