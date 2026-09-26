import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertUpdaterKeyReady,
  initializeUpdaterKey,
  invokeUpdaterSigner,
  signUpdaterArtifact,
  validateUpdaterChannel,
  validateUpdaterPublicKey,
  validateUpdaterTarget,
  verifyUpdaterArtifact,
} from "./updater-signing.mjs";

const publicText = `untrusted comment: minisign public key: 0000000000000000\n${Buffer.concat([
  Buffer.from("Ed"),
  Buffer.alloc(40),
]).toString("base64")}`;
const publicKey = Buffer.from(`${publicText}\n`, "utf8").toString("base64");

test("updater public keys must be canonical Minisign Ed25519 documents", () => {
  assert.equal(validateUpdaterPublicKey(`${publicKey}\n`), publicKey);
  assert.throws(() => validateUpdaterPublicKey(` ${publicKey}`), /canonical/);
  assert.throws(() => validateUpdaterPublicKey(Buffer.from("not minisign").toString("base64")), /Minisign/);
});

test("release signer process failures are redacted", () => {
  assert.throws(
    () =>
      invokeUpdaterSigner(["public-key"], {
        spawn: () => ({ status: 7, stdout: "private key", stderr: "sensitive path" }),
      }),
    (error) => {
      assert.match(error.message, /exited with 7/);
      assert.doesNotMatch(error.message, /private|sensitive/i);
      return true;
    },
  );
});

test("key initialization writes only the public key and refuses implicit rotation", () => {
  const root = mkdtempSync(join(tmpdir(), "kalcode-updater-public-"));
  const path = join(root, "updater-public-key.txt");
  const spawn = () => ({ status: 0, stdout: `${publicKey}\n`, stderr: "" });
  assert.equal(initializeUpdaterKey({ publicKeyPath: path, storePath: "C:\\outside\\key.dpapi", spawn }), publicKey);
  assert.equal(readFileSync(path, "utf8"), `${publicKey}\n`);
  assert.throws(() => initializeUpdaterKey({ publicKeyPath: path, spawn }), /rotation/);
});

test("release signing fails closed when DPAPI store and tracked public key differ", () => {
  const root = mkdtempSync(join(tmpdir(), "kalcode-updater-key-"));
  const path = join(root, "updater-public-key.txt");
  writeFileSync(path, `${publicKey}\n`);
  const otherRecord = Buffer.concat([Buffer.from("Ed"), Buffer.alloc(39), Buffer.from([1])]);
  const otherText = `untrusted comment: minisign public key: 0000000000000001\n${otherRecord.toString("base64")}\n`;
  const other = Buffer.from(otherText).toString("base64");
  assert.throws(
    () => assertUpdaterKeyReady({ publicKeyPath: path, spawn: () => ({ status: 0, stdout: other, stderr: "" }) }),
    /does not match/,
  );
});

test("artifact signing checks custody before signing and verifies the emitted signature", () => {
  const root = mkdtempSync(join(tmpdir(), "kalcode-updater-sign-"));
  const keyPath = join(root, "updater-public-key.txt");
  writeFileSync(keyPath, `${publicKey}\n`);
  const calls = [];
  const spawn = (_command, args) => {
    calls.push(args.slice(args.indexOf("--") + 1));
    return { status: 0, stdout: calls.length === 1 ? publicKey : "ok", stderr: "" };
  };
  signUpdaterArtifact({
    artifactPath: "C:\\stage\\KalCode_1.2.3_x64-setup.exe",
    signaturePath: "C:\\stage\\KalCode_1.2.3_x64-setup.exe.sig",
    version: "1.2.3",
    publicKeyPath: keyPath,
    spawn,
  });
  assert.deepEqual(
    calls.map((call) => call[0]),
    ["public-key", "sign", "verify"],
  );
  assert.ok(calls[2].includes("--public-key"));
  assert.equal(
    calls.some((call) => call.includes("--target") || call.includes("--channel")),
    false,
  );
});

test("candidate verification needs only the tracked public key", () => {
  const root = mkdtempSync(join(tmpdir(), "kalcode-updater-verify-"));
  const keyPath = join(root, "updater-public-key.txt");
  writeFileSync(keyPath, `${publicKey}\n`);
  let signerArgs;
  verifyUpdaterArtifact({
    artifactPath: "C:\\stage\\KalCode_1.2.3_x64-setup.exe",
    signaturePath: "C:\\stage\\KalCode_1.2.3_x64-setup.exe.sig",
    version: "1.2.3",
    publicKeyPath: keyPath,
    spawn: (_command, args) => {
      signerArgs = args.slice(args.indexOf("--") + 1);
      return { status: 0, stdout: "updater signature verified", stderr: "" };
    },
  });
  assert.equal(signerArgs[0], "verify");
  assert.ok(signerArgs.includes("--public-key"));
  assert.equal(signerArgs.includes("public-key"), false);
  assert.equal(signerArgs.includes("--target"), false);
  assert.equal(signerArgs.includes("--channel"), false);
});

test("schema-v2 targets are a closed canonical set", () => {
  assert.equal(validateUpdaterTarget("windows-x86_64"), "windows-x86_64");
  assert.equal(validateUpdaterTarget("darwin-aarch64"), "darwin-aarch64");
  for (const invalid of [
    "",
    "macos-arm64",
    "darwin-x86_64",
    "DARWIN-AARCH64",
    "darwin-aarch64\ttarget:windows-x86_64",
  ]) {
    assert.throws(() => validateUpdaterTarget(invalid), /target/);
  }
});

test("schema-v2 channels are a closed canonical set", () => {
  for (const channel of ["stable", "beta", "dev"]) {
    assert.equal(validateUpdaterChannel(channel), channel);
  }
  for (const invalid of ["", "nightly", "Stable", "stable\tchannel:dev"]) {
    assert.throws(() => validateUpdaterChannel(invalid), /channel/);
  }
});

test("schema-v2 target and channel must be supplied together before signer execution", () => {
  for (const options of [{ target: "darwin-aarch64" }, { channel: "stable" }]) {
    let calls = 0;
    assert.throws(
      () =>
        signUpdaterArtifact({
          artifactPath: "C:\\stage\\KalCode_1.2.3_arm64.dmg",
          signaturePath: "C:\\stage\\KalCode_1.2.3_arm64.dmg.sig",
          version: "1.2.3",
          ...options,
          spawn: () => {
            calls += 1;
            return { status: 0, stdout: publicKey, stderr: "" };
          },
        }),
      /target and channel/,
    );
    assert.equal(calls, 0);
  }
});

test("invalid targets fail before key custody or signer execution", () => {
  let calls = 0;
  assert.throws(
    () =>
      signUpdaterArtifact({
        artifactPath: "C:\\stage\\KalCode_1.2.3_arm64.dmg",
        signaturePath: "C:\\stage\\KalCode_1.2.3_arm64.dmg.sig",
        version: "1.2.3",
        target: "macos-arm64",
        channel: "stable",
        spawn: () => {
          calls += 1;
          return { status: 0, stdout: publicKey, stderr: "" };
        },
      }),
    /target/,
  );
  assert.equal(calls, 0);

  assert.throws(
    () =>
      verifyUpdaterArtifact({
        artifactPath: "C:\\stage\\KalCode_1.2.3_arm64.dmg",
        signaturePath: "C:\\stage\\KalCode_1.2.3_arm64.dmg.sig",
        version: "1.2.3",
        target: "darwin-aarch64",
        channel: "nightly",
        spawn: () => {
          calls += 1;
          return { status: 0, stdout: "ok", stderr: "" };
        },
      }),
    /channel/,
  );
  assert.equal(calls, 0);
});

test("schema-v2 signing binds and immediately verifies the exact target and channel", () => {
  const root = mkdtempSync(join(tmpdir(), "kalcode-updater-target-sign-"));
  const keyPath = join(root, "updater-public-key.txt");
  writeFileSync(keyPath, `${publicKey}\n`);
  const calls = [];
  const spawn = (_command, args) => {
    calls.push(args.slice(args.indexOf("--") + 1));
    return { status: 0, stdout: calls.length === 1 ? publicKey : "ok", stderr: "" };
  };
  signUpdaterArtifact({
    artifactPath: "C:\\stage\\KalCode_1.2.3_arm64.dmg",
    signaturePath: "C:\\stage\\KalCode_1.2.3_arm64.dmg.sig",
    version: "1.2.3",
    target: "darwin-aarch64",
    channel: "stable",
    publicKeyPath: keyPath,
    spawn,
  });
  for (const call of calls.slice(1)) {
    assert.equal(call.filter((value) => value === "--target").length, 1);
    const targetIndex = call.indexOf("--target");
    assert.equal(call[targetIndex + 1], "darwin-aarch64");
    assert.equal(call.filter((value) => value === "--channel").length, 1);
    const channelIndex = call.indexOf("--channel");
    assert.equal(call[channelIndex + 1], "stable");
  }
});

test("schema-v2 verification passes the exact target and channel with no omission downgrade", () => {
  const root = mkdtempSync(join(tmpdir(), "kalcode-updater-target-verify-"));
  const keyPath = join(root, "updater-public-key.txt");
  writeFileSync(keyPath, `${publicKey}\n`);
  let signerArgs;
  verifyUpdaterArtifact({
    artifactPath: "C:\\stage\\KalCode_1.2.3_arm64.dmg",
    signaturePath: "C:\\stage\\KalCode_1.2.3_arm64.dmg.sig",
    version: "1.2.3",
    target: "darwin-aarch64",
    channel: "stable",
    publicKeyPath: keyPath,
    spawn: (_command, args) => {
      signerArgs = args.slice(args.indexOf("--") + 1);
      return { status: 0, stdout: "updater signature verified", stderr: "" };
    },
  });
  assert.deepEqual(signerArgs.slice(-4), ["--target", "darwin-aarch64", "--channel", "stable"]);
});
