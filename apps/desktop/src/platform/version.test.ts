import { describe, expect, it } from "vitest";
import { formatVersion, parseAppVersion, publicVersion, sameVersionBuild } from "./version.ts";

describe("app version", () => {
  it("splits a build version into its public version and build number", () => {
    expect(parseAppVersion("0.1.7+780")).toEqual({ public: "0.1.7", build: 780 });
    expect(parseAppVersion("0.1.7")).toEqual({ public: "0.1.7", build: null });
    expect(parseAppVersion("0.2.0-beta.1+12")).toEqual({ public: "0.2.0-beta.1", build: 12 });
  });

  it("never invents a build number from non-numeric or non-canonical metadata", () => {
    expect(parseAppVersion("0.1.7+sha.abc")).toEqual({ public: "0.1.7", build: null });
    expect(parseAppVersion("0.1.7+007")).toEqual({ public: "0.1.7", build: null });
    expect(parseAppVersion("0.1.7+")).toEqual({ public: "0.1.7", build: null });
  });

  it("shows the public version, adding the build only in detailed form", () => {
    expect(publicVersion("0.1.7+780")).toBe("0.1.7");
    expect(publicVersion("0.1.7")).toBe("0.1.7");
    expect(formatVersion("0.1.7+780")).toBe("0.1.7 build 780");
    expect(formatVersion("0.1.7")).toBe("0.1.7");
  });

  it("recognizes a newer build of the same public version", () => {
    expect(sameVersionBuild("0.1.7", "0.1.7+780")).toBe(780);
    expect(sameVersionBuild("0.1.7+779", "0.1.7+780")).toBe(780);
    expect(sameVersionBuild("0.1.7+779", "0.1.8+900")).toBeNull();
    expect(sameVersionBuild("0.1.7", "0.1.8")).toBeNull();
    expect(sameVersionBuild(null, "0.1.7+780")).toBeNull();
  });
});
