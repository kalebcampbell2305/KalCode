import { describe, expect, it } from "vitest";
import committed from "../../src/data/releases.json";
import {
  assertManifest,
  buildStatus,
  downloadCta,
  formatBytes,
  platformRows,
  RELEASES,
  type ReleaseManifest,
} from "../../src/lib/releases";
import { publishedManifest } from "./fixtures/releases";

const EMPTY: ReleaseManifest = {
  ...publishedManifest,
  latest: null,
  unavailable: [
    { os: "windows", label: "Windows 10 (1809) or later, 64-bit", reason: "No public build has been published yet." },
    ...publishedManifest.unavailable,
  ],
};

describe("committed release manifest", () => {
  it("passes the website's guard and lists every OS once", () => {
    expect(assertManifest(committed)).toBe(committed);
    expect(platformRows(RELEASES).map((row) => row.os)).toEqual(["windows", "macos", "linux"]);
  });
});

describe("with no public build (empty manifest)", () => {
  it("is the honest empty state: every OS unavailable with a reason", () => {
    const rows = platformRows(EMPTY);
    expect(rows.map((row) => row.os)).toEqual(["windows", "macos", "linux"]);
    for (const row of rows) {
      expect(row.state).toBe("unavailable");
      if (row.state === "unavailable") expect(row.reason.length).toBeGreaterThan(0);
    }
  });

  it("keeps the Download KalCode label but goes to the honest download page", () => {
    expect(downloadCta(EMPTY)).toEqual({
      kind: "pending",
      label: "Download KalCode",
      href: "/download",
      os: null,
      note: "No public build yet",
    });
    expect(buildStatus(EMPTY)).toBe("In private development");
  });
});

describe("with a published Windows preview (fixture)", () => {
  const manifest = assertManifest(publishedManifest);

  it("offers the Windows build and keeps macOS and Linux unavailable", () => {
    const rows = platformRows(manifest);
    expect(rows.map((row) => row.state)).toEqual(["available", "unavailable", "unavailable"]);
    const windows = rows[0];
    if (windows?.state !== "available") throw new Error("expected a Windows build");
    expect(windows.build.url).toBe("/download/windows-x64");
    expect(windows.build.signed).toBe(false);
  });

  it("turns the call to action into the real download", () => {
    expect(downloadCta(manifest)).toEqual({
      kind: "download",
      label: "Download KalCode",
      href: "/download/windows-x64",
      os: "windows",
      note: "Windows · Preview 0.1.0 · 3.8 MB",
    });
    expect(buildStatus(manifest)).toBe("Preview 0.1.0 for Windows");
  });
});

describe("with a published Stable release", () => {
  it("labels download calls to action and shared build status from the manifest channel", () => {
    const manifest = structuredClone(publishedManifest);
    if (!manifest.latest) throw new Error("fixture has no release");
    manifest.latest.channel = "stable";
    manifest.latest.version = "0.1.6";
    expect(downloadCta(manifest).note).toBe("Windows · Stable 0.1.6 · 3.8 MB");
    expect(buildStatus(manifest)).toBe("Stable 0.1.6 for Windows");
  });
});

describe("manifest guard", () => {
  const clone = (): ReleaseManifest => structuredClone(publishedManifest) as ReleaseManifest;

  it("rejects an OS listed as both downloadable and unavailable", () => {
    const bad = clone();
    bad.unavailable.push({ os: "windows", label: "Windows", reason: "x" });
    expect(() => assertManifest(bad)).toThrow(/exactly one/);
  });

  it("rejects an OS that is missing from both lists", () => {
    const bad = clone();
    bad.unavailable = bad.unavailable.filter((entry) => entry.os !== "linux");
    expect(() => assertManifest(bad)).toThrow(/linux/);
  });

  it("rejects a download link the Worker does not serve, or a malformed checksum", () => {
    const external = clone();
    if (external.latest?.platforms[0]) external.latest.platforms[0].url = "https://example.com/KalCode.exe";
    expect(() => assertManifest(external)).toThrow(/\/download\//);
    const hash = clone();
    if (hash.latest?.platforms[0]) hash.latest.platforms[0].sha256 = "ABC";
    expect(() => assertManifest(hash)).toThrow(/sha256/);
  });
});

describe("formatBytes", () => {
  it("uses decimal units", () => {
    expect(formatBytes(3_836_045)).toBe("3.8 MB");
    expect(formatBytes(84_200_000)).toBe("84.2 MB");
    expect(formatBytes(1_500)).toBe("2 KB");
    expect(formatBytes(1_200_000_000)).toBe("1.2 GB");
  });
});
