import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildManifest, validateManifest } from "./manifest.mjs";
import {
  pointerAdvanceProblems,
  resolvePlatformPublicationState,
  writeFrozenPublicationJson,
} from "./publication-safety.mjs";
import { buildPublishPlan, publishedUpdaterProblems, windowsUpdaterV2Problems } from "./publish-plan.mjs";

const VERSION = "1.2.3";
const COMMIT = "a".repeat(40);
const WINDOWS_SHA = "1".repeat(64);
const MAC_SHA = "2".repeat(64);
const DESCRIPTOR_SHA = "3".repeat(64);
const DOWNLOAD_SHA = "4".repeat(64);

const windows = {
  target: "windows-x86_64",
  file: `KalCode_${VERSION}_x64-setup.exe`,
  artifactPath: `C:\\stage\\KalCode_${VERSION}_x64-setup.exe`,
  signaturePath: `C:\\stage\\KalCode_${VERSION}_x64-setup.exe.sig`,
  artifactSha256: WINDOWS_SHA,
  signatureSha256: "5".repeat(64),
};
const mac = {
  target: "darwin-aarch64",
  file: `KalCode_${VERSION}_arm64.dmg`,
  artifactPath: `/stage/KalCode_${VERSION}_arm64.dmg`,
  signaturePath: `/stage/KalCode_${VERSION}_arm64.dmg.sig`,
  artifactSha256: MAC_SHA,
  signatureSha256: "6".repeat(64),
};

function manifest(platforms = "both") {
  return buildManifest({
    version: VERSION,
    commit: COMMIT,
    publishedAt: "2026-09-25T12:00:00.000Z",
    channel: "stable",
    ...(platforms !== "mac" && {
      windows: { file: windows.file, size: 41, sha256: WINDOWS_SHA, signed: true },
    }),
    ...(platforms !== "windows" && {
      macosArm64: { file: mac.file, size: 42, sha256: MAC_SHA, signed: true },
    }),
  });
}

test("download manifest truthfully represents dual-platform and Mac-only releases", () => {
  const both = manifest();
  assert.deepEqual(validateManifest(both), []);
  assert.deepEqual(
    both.latest.platforms.map(({ os, arch, kind }) => ({ os, arch, kind })),
    [
      { os: "windows", arch: "x64", kind: "nsis" },
      { os: "macos", arch: "arm64", kind: "dmg" },
    ],
  );
  assert.deepEqual(
    both.unavailable.map(({ os }) => os),
    ["linux"],
  );

  const macOnly = manifest("mac");
  assert.deepEqual(validateManifest(macOnly), []);
  assert.deepEqual(
    macOnly.latest.platforms.map(({ os }) => os),
    ["macos"],
  );
  assert.deepEqual(
    macOnly.unavailable.map(({ os }) => os),
    ["windows", "linux"],
  );
});

test("one upload plan contains every platform object and one descriptor of each kind", () => {
  const plan = buildPublishPlan({
    bucket: "kalcode-downloads",
    version: VERSION,
    channel: "stable",
    artifacts: [windows, mac],
    downloadManifestPath: "C:\\stage\\latest.json",
    updaterManifestPath: "C:\\stage\\stable.json",
    updaterDescriptorSha256: DESCRIPTOR_SHA,
    downloadDescriptorSha256: DOWNLOAD_SHA,
    includeDownloadDescriptor: true,
    includeUpdater: true,
  });
  assert.equal(plan.filter(({ kind }) => kind === "download-artifact").length, 2);
  assert.equal(plan.filter(({ kind }) => kind === "updater-artifact").length, 2);
  assert.equal(plan.filter(({ kind }) => kind === "updater-signature").length, 2);
  assert.equal(plan.filter(({ kind }) => kind === "download-descriptor").length, 1);
  assert.equal(plan.filter(({ kind }) => kind === "updater-descriptor").length, 1);
  assert.equal(new Set(plan.map(({ key }) => key)).size, plan.length);
  assert.match(
    plan.find(({ target, kind }) => target === mac.target && kind === "download-artifact").argv.join(" "),
    /application\/x-apple-diskimage/,
  );
});

test("platform upload planning rejects path substitution and ambiguous target sets", () => {
  const base = {
    bucket: "kalcode-downloads",
    version: VERSION,
    channel: "stable",
    downloadManifestPath: "latest.json",
    updaterManifestPath: "stable.json",
    updaterDescriptorSha256: DESCRIPTOR_SHA,
    downloadDescriptorSha256: DOWNLOAD_SHA,
    includeDownloadDescriptor: true,
    includeUpdater: true,
  };
  assert.throws(() => buildPublishPlan({ ...base, artifacts: [windows, windows] }), /unique/);
  assert.throws(
    () => buildPublishPlan({ ...base, artifacts: [{ ...mac, file: "../KalCode.dmg" }] }),
    /file is invalid/,
  );
  assert.throws(() => buildPublishPlan({ ...base, artifacts: [{ ...mac, file: "KalCode.exe" }] }), /file is invalid/);
  assert.throws(
    () => buildPublishPlan({ ...base, artifacts: [{ ...mac, signatureSha256: undefined }] }),
    /signatureSha256/,
  );
});

test("aggregate Windows packet requires closed target-and-channel-bound v2 evidence", () => {
  const file = windows.file;
  const signatureFile = `${file}.windows-x86_64.sig`;
  const build = {
    file,
    requestedReleaseChannel: "stable",
    updaterV2: {
      schemaVersion: 2,
      artifactFile: file,
      signatureFile,
      signatureStatus: "Valid",
      cryptographicallyVerified: true,
      versionBound: true,
      target: "windows-x86_64",
      targetBound: true,
      channel: "stable",
      channelBound: true,
      publicKeyConfigured: true,
    },
  };
  const verify = {
    status: "passed",
    updaterV2: {
      schemaVersion: 2,
      signatureFile,
      signatureStatus: "Valid",
      exactBytes: true,
      versionBound: true,
      target: "windows-x86_64",
      targetBound: true,
      channel: "stable",
      channelBound: true,
    },
  };
  assert.deepEqual(windowsUpdaterV2Problems(build, verify), []);
  assert.match(
    windowsUpdaterV2Problems({ ...build, updaterV2: { ...build.updaterV2, channel: "beta" } }, verify)[0],
    /build packet/,
  );
  assert.match(
    windowsUpdaterV2Problems(build, {
      ...verify,
      updaterV2: { ...verify.updaterV2, exactBytes: false },
    })[0],
    /verification packet/,
  );
  const widened = structuredClone(build);
  widened.updaterV2.keyId = "must-not-be-recorded";
  assert.match(windowsUpdaterV2Problems(widened, verify)[0], /build packet/);
});

test("partial upload resume flags operate independently per object", () => {
  const plan = buildPublishPlan({
    bucket: "kalcode-downloads",
    version: VERSION,
    channel: "stable",
    artifacts: [
      {
        ...windows,
        includeDownloadArtifact: false,
        includeUpdaterArtifact: false,
        includeUpdaterSignature: true,
      },
      { ...mac, includeUpdaterSignature: false },
    ],
    downloadManifestPath: "latest.json",
    updaterManifestPath: "stable.json",
    updaterDescriptorSha256: DESCRIPTOR_SHA,
    downloadDescriptorSha256: DOWNLOAD_SHA,
    includeDownloadDescriptor: false,
    includeUpdater: true,
    includeImmutableUpdater: false,
  });
  assert.deepEqual(
    plan.map(({ target, kind }) => [target, kind]),
    [
      [mac.target, "download-artifact"],
      [mac.target, "updater-artifact"],
      [windows.target, "updater-signature"],
    ],
  );
});

test("local Windows simulation retains the legacy Worker object key", () => {
  const plan = buildPublishPlan({
    bucket: "kalcode-downloads",
    version: VERSION,
    channel: "dev",
    artifacts: [windows],
    downloadManifestPath: "latest.json",
    updaterManifestPath: "dev.json",
    updaterDescriptorSha256: DESCRIPTOR_SHA,
    downloadDescriptorSha256: DOWNLOAD_SHA,
    includeDownloadDescriptor: false,
    includeUpdater: false,
    includeLocalPointer: true,
  });
  assert.deepEqual(
    plan.map(({ key }) => key),
    [`releases/${VERSION}/${windows.file}`, "releases/latest.json"],
  );
});

test("resumable publication state binds the whole ordered artifact set", () => {
  const release = {
    version: VERSION,
    commit: COMMIT,
    requestedReleaseChannel: "stable",
    artifacts: [
      {
        target: windows.target,
        file: windows.file,
        size: 41,
        sha256: WINDOWS_SHA,
        signatureSha256: windows.signatureSha256,
        builtAt: "2026-09-25T10:00:00.000Z",
      },
      {
        target: mac.target,
        file: mac.file,
        size: 42,
        sha256: MAC_SHA,
        signatureSha256: mac.signatureSha256,
        builtAt: "2026-09-25T11:00:00.000Z",
      },
    ],
  };
  const first = resolvePlatformPublicationState(null, release, "2026-09-25T12:00:00.000Z");
  const resumed = resolvePlatformPublicationState(
    first,
    { ...release, artifacts: [...release.artifacts].reverse() },
    "2026-09-25T13:00:00.000Z",
  );
  assert.deepEqual(resumed, first);
  assert.throws(
    () =>
      resolvePlatformPublicationState(
        first,
        { ...release, artifacts: [release.artifacts[0]] },
        "2026-09-25T13:00:00.000Z",
      ),
    /exact platform set/,
  );
  const replacedSignature = structuredClone(release);
  replacedSignature.artifacts[0].signatureSha256 = "9".repeat(64);
  assert.throws(
    () => resolvePlatformPublicationState(first, replacedSignature, "2026-09-25T13:00:00.000Z"),
    /exact platform set/,
  );
  assert.throws(() => resolvePlatformPublicationState(null, release, "2026-09-25T10:30:00.000Z"), /predates/);
});

test("publication state and generated descriptors are create-once byte identities", () => {
  const path = join(mkdtempSync(join(tmpdir(), "kalcode-frozen-publication-")), "publication.json");
  const value = { schemaVersion: 3, publishedAt: "2026-09-25T12:00:00.000Z", signatureSha256: "a".repeat(64) };
  assert.equal(writeFrozenPublicationJson(path, value), "created");
  assert.equal(writeFrozenPublicationJson(path, structuredClone(value)), "reused");
  assert.throws(
    () => writeFrozenPublicationJson(path, { ...value, publishedAt: "2026-09-25T12:01:00.000Z" }),
    /different bytes/,
  );
  assert.throws(
    () => writeFrozenPublicationJson(path, { ...value, signatureSha256: "b".repeat(64) }),
    /different bytes/,
  );
});

test("same-identity guards compare the complete aggregate, independent of object key order", () => {
  const expectedLatest = manifest();
  const expectedUpdater = {
    version: VERSION,
    platforms: {
      "windows-x86_64": { url: "https://kalcoded.com/windows", signature: "windows" },
      "darwin-aarch64": { url: "https://kalcoded.com/macos", signature: "mac" },
    },
    kalcode: {
      schemaVersion: 2,
      channel: "stable",
      commit: COMMIT,
      artifacts: {
        "windows-x86_64": { target: "windows-x86_64", format: "nsis", size: 41, sha256: WINDOWS_SHA },
        "darwin-aarch64": { target: "darwin-aarch64", format: "dmg", size: 42, sha256: MAC_SHA },
      },
    },
  };
  assert.deepEqual(publishedUpdaterProblems(structuredClone(expectedUpdater), VERSION, expectedUpdater), []);
  const replaced = structuredClone(expectedUpdater);
  replaced.kalcode.artifacts["darwin-aarch64"].sha256 = "9".repeat(64);
  assert.match(publishedUpdaterProblems(replaced, VERSION, expectedUpdater)[0], /new immutable build identity/);
  assert.deepEqual(
    pointerAdvanceProblems({
      version: VERSION,
      expectedLatest,
      expectedUpdater,
      currentLatest: structuredClone(expectedLatest),
      currentUpdater: structuredClone(expectedUpdater),
    }),
    [],
  );
  assert.match(
    pointerAdvanceProblems({
      version: VERSION,
      expectedLatest,
      expectedUpdater,
      currentLatest: structuredClone(expectedLatest),
      currentUpdater: replaced,
    })[0],
    /different updater/,
  );
});

test("newer releases cannot silently withdraw an active platform", () => {
  const currentLatest = manifest();
  const proposedMacOnly = {
    ...manifest("mac"),
    latest: { ...manifest("mac").latest, version: "1.2.4" },
  };
  const currentUpdater = {
    version: VERSION,
    platforms: {
      "windows-x86_64": { url: "https://kalcoded.com/windows", signature: "windows" },
      "darwin-aarch64": { url: "https://kalcoded.com/macos", signature: "mac" },
    },
  };
  const proposedUpdater = {
    version: "1.2.4",
    platforms: { "darwin-aarch64": { url: "https://kalcoded.com/macos-next", signature: "mac-next" } },
  };
  const problems = pointerAdvanceProblems({
    version: "1.2.4",
    expectedLatest: proposedMacOnly,
    expectedUpdater: proposedUpdater,
    currentLatest,
    currentUpdater,
  });
  assert.ok(problems.some((problem) => /download platform.*windows\/x64/.test(problem)));
  assert.ok(problems.some((problem) => /updater platform.*windows-x86_64/.test(problem)));

  const currentWindowsOnly = manifest("windows");
  const proposedMacUpdaterOnly = {
    version: "1.2.4",
    platforms: { "darwin-aarch64": { url: "https://kalcoded.com/macos-next", signature: "mac-next" } },
  };
  const windowsToMac = pointerAdvanceProblems({
    version: "1.2.4",
    expectedLatest: proposedMacOnly,
    expectedUpdater: proposedMacUpdaterOnly,
    currentLatest: currentWindowsOnly,
    currentUpdater: {
      version: VERSION,
      platforms: { "windows-x86_64": { url: "https://kalcoded.com/windows", signature: "windows" } },
    },
  });
  assert.ok(windowsToMac.some((problem) => /download platform.*windows\/x64/.test(problem)));
  assert.ok(windowsToMac.some((problem) => /updater platform.*windows-x86_64/.test(problem)));
});

test("the canonical publisher consumes both verified platform packets before its D1 claim", () => {
  const source = readFileSync(join(import.meta.dirname, "publish.mjs"), "utf8");
  assert.match(source, /macos-arm64-build\.json/);
  assert.match(source, /macos-arm64-verify\.json/);
  assert.match(source, /macos-arm64-qa\.json/);
  assert.match(source, /windows-x86_64-qa\.json/);
  assert.match(source, /writeFrozenPublicationJson/);
  assert.match(source, /\.windows-x86_64/);
  assert.match(source, /createPlatformUpdaterManifest/);
  assert.match(source, /artifacts:/);
  assert.ok(
    source.indexOf("createPlatformUpdaterManifest") < source.indexOf("buildVersionClaimStatement(pointerCandidate)"),
  );
});
