import { describe, expect, it } from "vitest";
import committed from "../../src/data/releases.json";
import {
  assertManifest,
  downloadCta,
  formatBytes,
  platformRows,
  RELEASES,
  type ReleaseManifest,
} from "../../src/lib/releases";
import { publishedManifest } from "./fixtures/releases";

describe("committed release manifest", () => {
  it("is the honest empty state: no public build, every OS unavailable with a reason", () => {
    expect(RELEASES.latest).toBeNull();
    expect(committed.latest).toBeNull();
    const rows = platformRows(RELEASES);
    expect(rows.map((row) => row.os)).toEqual(["windows", "macos", "linux"]);
    for (const row of rows) {
      expect(row.state).toBe("unavailable");
      if (row.state === "unavailable") expect(row.reason.length).toBeGreaterThan(0);
    }
  });

  it("makes every call to action point at early access", () => {
    expect(downloadCta()).toEqual({
      kind: "early-access",
      label: "Join early access",
      href: "/download#early-access",
      note: "No public build yet",
    });
    expect(downloadCta(RELEASES, "#early-access").href).toBe("#early-access");
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

  it("turns the call to action into a download on the download page", () => {
    expect(downloadCta(manifest)).toEqual({
      kind: "download",
      label: "Download for Windows",
      href: "/download#windows",
      note: "Preview 0.1.0 · 3.8 MB · Windows 10 (1809) or later, 64-bit",
    });
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
