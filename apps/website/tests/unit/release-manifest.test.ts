import { describe, expect, it } from "vitest";
// The release tooling is plain Node ESM; this test keeps its manifest and the Worker's parser in step.
import { buildManifest, emptyManifest, notesAnchor, validateManifest } from "../../../../tooling/release/manifest.mjs";
import schema from "../../../../tooling/release/releases.schema.json";
import committed from "../../src/data/releases.json";
import { parseReleaseManifest } from "../../worker/downloads";

const published = buildManifest({
  version: "0.1.0",
  commit: "0123456789abcdef0123456789abcdef01234567",
  publishedAt: "2026-09-24T12:00:00.000Z",
  windows: { file: "KalCode_0.1.0_x64-setup.exe", size: 3_836_045, sha256: "c".repeat(64), signed: false },
});

describe("release manifest (tooling ↔ worker)", () => {
  it("the committed manifest is the honest empty state until a publish", () => {
    expect(committed).toEqual(emptyManifest());
    expect(committed.latest).toBeNull();
    expect(validateManifest(committed)).toEqual([]);
  });

  it("a published manifest from the tooling is accepted by the Worker unchanged", () => {
    expect(validateManifest(published)).toEqual([]);
    expect(parseReleaseManifest(published)).toEqual(published);
  });

  it("published manifests say the installer is unsigned and list macOS and Linux as unavailable", () => {
    expect(published.latest.platforms.map((p: { signed: boolean }) => p.signed)).toEqual([false]);
    expect(published.unavailable.map((u: { os: string }) => u.os)).toEqual(["macos", "linux"]);
    expect(published.latest.notesUrl).toBe(`/changelog#${notesAnchor("0.1.0")}`);
    expect(notesAnchor("0.1.0")).toBe("release-0-1-0");
  });

  it("the tooling validator rejects what the Worker rejects", () => {
    const bad = structuredClone(published);
    bad.latest.platforms[0].file = "../evil.exe";
    expect(validateManifest(bad)).not.toEqual([]);
    expect(parseReleaseManifest(bad)).toBeNull();
    const silent = structuredClone(emptyManifest());
    silent.unavailable = silent.unavailable.filter((u: { os: string }) => u.os !== "linux");
    expect(validateManifest(silent)).toContain("linux must appear in latest.platforms or unavailable");
  });

  it("the JSON schema lists the same required fields as the types", () => {
    expect(schema.required).toEqual(["schemaVersion", "latest", "unavailable"]);
    expect(schema.$defs.platform.required.sort()).toEqual(Object.keys(published.latest.platforms[0]).sort());
    expect(schema.$defs.release.required.sort()).toEqual(Object.keys(published.latest).sort());
  });
});
