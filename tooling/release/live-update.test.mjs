import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { gunzipSync } from "node:zlib";
import {
  liveDescriptorBytes,
  liveEnvelope,
  liveFileNames,
  liveKeys,
  NATIVE_PATHS,
  nativeFingerprint,
  packUiBundle,
} from "./live-update.mjs";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const NATIVE = "a".repeat(64);

function dist(files) {
  const dir = mkdtempSync(join(tmpdir(), "kalcode-ui-"));
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, ...path.split("/"));
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

describe("live update release tooling", () => {
  it("fingerprints exactly the native inputs of a commit", () => {
    let seen;
    const exec = (_cmd, args) => {
      seen = args;
      return "100644 blob 1111\tapps/desktop/src-tauri/src/lib.rs\n100644 blob 2222\tcrates/updater/src/live.rs\n";
    };
    const first = nativeFingerprint({ commit: COMMIT, exec });
    assert.match(first, /^[0-9a-f]{64}$/);
    assert.deepEqual(seen, ["ls-tree", "-r", "--full-tree", COMMIT, "--", ...NATIVE_PATHS]);
    const changed = nativeFingerprint({
      commit: COMMIT,
      exec: () => "100644 blob 1111\tapps/desktop/src-tauri/src/lib.rs\n100644 blob 3333\tcrates/updater/src/live.rs\n",
    });
    assert.notEqual(first, changed, "any native change is a different shell");
    assert.throws(() => nativeFingerprint({ commit: "HEAD", exec }), /exact 40-character commit/);
    assert.throws(() => nativeFingerprint({ commit: COMMIT, exec: () => "" }), /native inputs were not found/);
  });

  it("keeps the UI out of the native fingerprint and the shell in it", () => {
    for (const ui of ["apps/desktop/src", "packages/ui", "apps/website"]) {
      assert.ok(!NATIVE_PATHS.some((path) => ui.startsWith(path)), ui);
    }
    for (const native of ["apps/desktop/src-tauri", "crates", "Cargo.lock", "third_party"]) {
      assert.ok(NATIVE_PATHS.includes(native), native);
    }
  });

  it("packs a reproducible bundle in the client's format", () => {
    const dir = dist({ "index.html": "<html></html>", "assets/app-1.js": "x()", "assets/app.css": "a{}" });
    try {
      const first = packUiBundle(dir);
      const second = packUiBundle(dir);
      assert.equal(first.sha256, second.sha256);
      assert.equal(first.files, 3);
      const expanded = gunzipSync(first.bytes);
      assert.equal(expanded.length, first.expandedSize);
      assert.equal(expanded.subarray(0, 7).toString(), "KALUI1\n");
      const length = expanded.readUInt32LE(7);
      const index = JSON.parse(expanded.subarray(11, 11 + length).toString());
      assert.deepEqual(
        index.files.map((file) => file.path),
        ["assets/app-1.js", "assets/app.css", "index.html"],
      );
      assert.equal(expanded.subarray(11 + length).toString(), "x()a{}<html></html>");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a UI build without an entry page, with unsafe names, or with inline code", () => {
    const noIndex = dist({ "app.js": "x" });
    const unsafe = dist({ "index.html": "x", "bad name.js": "y" });
    const inline = dist({ "index.html": "<script>alert(1)</script>" });
    const styled = dist({ "index.html": "<style>a{}</style>" });
    const fine = dist({ "index.html": '<script type="module" crossorigin src="/assets/a.js"></script>' });
    try {
      assert.throws(() => packUiBundle(noIndex), /no index.html/);
      assert.throws(() => packUiBundle(unsafe), /unsafe UI file name/);
      assert.throws(() => packUiBundle(inline), /inline script or style/);
      assert.throws(() => packUiBundle(styled), /inline script or style/);
      assert.equal(packUiBundle(fine).files, 1);
    } finally {
      for (const dir of [noIndex, unsafe, inline, styled, fine]) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("builds a strict descriptor and envelope", () => {
    const ui = { file: "KalCode_0.1.9_build1900_ui.kui", size: 10, sha256: "b".repeat(64), expandedSize: 20, files: 3 };
    const bytes = liveDescriptorBytes({
      version: "0.1.9+1900",
      channel: "stable",
      target: "windows-x86_64",
      commit: COMMIT,
      nativeFingerprint: NATIVE,
      ui,
    });
    assert.deepEqual(JSON.parse(bytes.toString()), {
      schemaVersion: 1,
      version: "0.1.9+1900",
      channel: "stable",
      target: "windows-x86_64",
      commit: COMMIT,
      shell: { nativeFingerprint: NATIVE },
      ui,
    });
    const envelope = JSON.parse(liveEnvelope(bytes, "c2lnbmF0dXJl\n"));
    assert.equal(Buffer.from(envelope.descriptor, "base64").toString(), bytes.toString());
    assert.equal(envelope.signature, "c2lnbmF0dXJl");
    assert.throws(
      () =>
        liveDescriptorBytes({
          version: "0.1.9+1900",
          channel: "stable",
          target: "windows-x86_64",
          commit: COMMIT,
          nativeFingerprint: "dev",
          ui,
        }),
      /native fingerprint/,
    );
    assert.throws(() => liveEnvelope(bytes, "not base64!"), /not base64/);
  });

  it("names live files after the installer and keys them under the build", () => {
    assert.deepEqual(liveFileNames("KalCode_0.1.9_build1900_x64-setup.exe"), {
      descriptor: "KalCode_0.1.9_build1900_x64-live.json",
      ui: "KalCode_0.1.9_build1900_ui.kui",
      envelope: "windows-x86_64.json",
    });
    assert.deepEqual(liveKeys("stable", "0.1.9+1900", "KalCode_0.1.9_build1900_ui.kui"), {
      envelope: "releases/updater/stable/0.1.9+1900/live/windows-x86_64.json",
      ui: "releases/updater/stable/0.1.9+1900/live/KalCode_0.1.9_build1900_ui.kui",
    });
  });
});
