import { describe, expect, it } from "vitest";
import { formatKalCodeVersion, parseKalCodeVersion } from "./version.ts";

describe("parseKalCodeVersion", () => {
  it("separates the public version from a bounded numeric build revision", () => {
    expect(parseKalCodeVersion("0.1.7+217")).toEqual({
      fullVersion: "0.1.7+217",
      publicVersion: "0.1.7",
      prerelease: null,
      buildRevision: 217,
    });
    expect(parseKalCodeVersion("0.1.8-beta.2+65535")).toEqual({
      fullVersion: "0.1.8-beta.2+65535",
      publicVersion: "0.1.8-beta.2",
      prerelease: "beta.2",
      buildRevision: 65535,
    });
  });

  it("keeps legacy public versions compatible", () => {
    expect(parseKalCodeVersion("0.1.7")).toEqual({
      fullVersion: "0.1.7",
      publicVersion: "0.1.7",
      prerelease: null,
      buildRevision: null,
    });
  });

  it.each(["0.1.7+0", "0.1.7+01", "0.1.7+65536", "0.1.7+build", "0.1.7+1.2", "01.1.7+1"])(
    "rejects a non-canonical build identity: %s",
    (version) => expect(parseKalCodeVersion(version)).toBeNull(),
  );
});

describe("formatKalCodeVersion", () => {
  it("shows the public milestone and build without exposing SemVer syntax", () => {
    expect(formatKalCodeVersion("0.1.7+217")).toBe("0.1.7 build 217");
    expect(formatKalCodeVersion("0.1.7")).toBe("0.1.7");
  });

  it("does not rewrite an invalid version", () => {
    expect(formatKalCodeVersion("unknown")).toBe("unknown");
  });
});
