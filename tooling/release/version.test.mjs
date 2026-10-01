import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildManifest, notesAnchor, validateManifest } from "./manifest.mjs";
import {
  buildRevision,
  compareStableBuildVersions,
  MAX_NATIVE_BUILD_REVISION,
  publicVersion,
  releaseNotesRelativePath,
  validateStableBuildVersion,
  windowsNativeFileVersion,
} from "./version.mjs";

test("stable build identities keep the public version separate from a bounded native revision", () => {
  assert.equal(MAX_NATIVE_BUILD_REVISION, 65_535);
  assert.deepEqual(validateStableBuildVersion("0.1.7"), {
    version: "0.1.7",
    publicVersion: "0.1.7",
    revision: null,
  });
  assert.deepEqual(validateStableBuildVersion("0.1.7+218"), {
    version: "0.1.7+218",
    publicVersion: "0.1.7",
    revision: 218,
  });
  assert.equal(publicVersion("0.1.7+218"), "0.1.7");
  assert.equal(buildRevision("0.1.7+218"), 218);
  assert.equal(buildRevision("0.1.7"), null);
  assert.equal(windowsNativeFileVersion("0.1.7"), "0.1.7.0");
  assert.equal(windowsNativeFileVersion("0.1.7+218"), "0.1.7.218");
});

test("stable build identities reject prereleases, nonnumeric metadata, zero and native overflow", () => {
  for (const version of [
    "0.1.7-rc.1",
    "0.1.7+build.1",
    "0.1.7+01",
    "0.1.7+0",
    "0.1.7+65536",
    "0.1.7+999999999999999999999999",
  ]) {
    assert.throws(() => validateStableBuildVersion(version), /stable build version/i, version);
  }
  assert.equal(buildRevision("0.1.7+65535"), 65_535);
  const schema = JSON.parse(readFileSync(new URL("./releases.schema.json", import.meta.url), "utf8"));
  const schemaPattern = new RegExp(schema.$defs.version.pattern);
  assert.equal(schemaPattern.test("0.1.7+65535"), true);
  for (const version of ["0.1.7+0", "0.1.7+01", "0.1.7+65536", "0.1.7+build.1"]) {
    assert.equal(schemaPattern.test(version), false, version);
  }
});

test("stable build order advances revisions, supports rollback comparisons and yields to the next milestone", () => {
  assert.equal(compareStableBuildVersions("0.1.7", "0.1.7+1"), -1);
  assert.equal(compareStableBuildVersions("0.1.7+1", "0.1.7+2"), -1);
  assert.equal(compareStableBuildVersions("0.1.7+2", "0.1.7+2"), 0);
  assert.equal(compareStableBuildVersions("0.1.7+2", "0.1.7+1"), 1);
  assert.equal(compareStableBuildVersions("0.1.7+65535", "0.1.8"), -1);
  assert.equal(compareStableBuildVersions("10.0.0", "2.999.999+65535"), 1);
});

test("continuous builds use build evidence while milestones retain public release notes", () => {
  assert.equal(releaseNotesRelativePath("0.1.7"), "docs/releases/0.1.7.md");
  assert.equal(releaseNotesRelativePath("0.1.7+218"), "docs/builds/0.1.7+218.md");
  assert.equal(notesAnchor("0.1.7+218"), "release-0-1-7");
  const manifest = buildManifest({
    version: "0.1.7+218",
    commit: "a".repeat(40),
    publishedAt: "2026-09-30T12:00:00.000Z",
    channel: "stable",
    windows: {
      file: "KalCode_0.1.7+218_x64-setup.exe",
      size: 123,
      sha256: "b".repeat(64),
      signed: true,
    },
  });
  assert.deepEqual(validateManifest(manifest), []);
  assert.equal(manifest.latest.notesUrl, "/updates#release-0-1-7");
  assert.equal(manifest.latest.platforms[0].pinnedUrl, "/download/0.1.7+218/KalCode_0.1.7+218_x64-setup.exe");
});
