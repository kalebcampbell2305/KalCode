import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import {
  COMPONENT_CATALOG_TYPE,
  COMPONENT_MANIFEST_TYPE,
  componentKeyStatus,
  componentSignerInvocation,
  parseComponentPublicKey,
  runComponentSigner,
  signComponentCatalog,
  signComponentManifest,
} from "./component-signing.mjs";

test("component public-key export is a closed Ed25519 document", () => {
  const value = { schemaVersion: 1, alg: "EdDSA", kid: "component-2026-1", x: "A".repeat(43) };
  assert.deepEqual(parseComponentPublicKey(JSON.stringify(value)), value);
  for (const invalid of [
    { ...value, privateKey: "forbidden" },
    { ...value, alg: "RS256" },
    { ...value, kid: "Updater Key" },
    { ...value, kid: "1-component-key" },
    { ...value, x: "not-base64url" },
  ]) {
    assert.throws(() => parseComponentPublicKey(JSON.stringify(invalid)), /public key/);
  }
});

test("component key status is closed and represents configured or absent custody", () => {
  assert.deepEqual(
    componentKeyStatus(
      { storePath: "C:\\keys\\component.dpapi" },
      { runSigner: () => JSON.stringify({ configured: true, kid: "component-2026-1" }) },
    ),
    { configured: true, kid: "component-2026-1" },
  );
  assert.deepEqual(
    componentKeyStatus(
      { storePath: "C:\\keys\\component.dpapi" },
      { runSigner: () => JSON.stringify({ configured: false, kid: null }) },
    ),
    { configured: false, kid: null },
  );
  assert.throws(
    () =>
      componentKeyStatus(
        { storePath: "C:\\keys\\component.dpapi" },
        { runSigner: () => JSON.stringify({ configured: false, kid: "leaked-state" }) },
      ),
    /status/,
  );
});

test("component signer invocations use only the separate component signer and exact command options", () => {
  const root = "C:\\repo";
  const invocation = componentSignerInvocation({
    root,
    command: "sign-manifest",
    options: {
      "--store": "C:\\keys\\component.dpapi",
      "--input": "C:\\stage\\manifest.json",
      "--artifact": "C:\\stage\\runtime.zip",
      "--output": "C:\\stage\\runtime.jws",
    },
  });
  assert.equal(
    invocation.command,
    join(root, "tooling", "component-signer", "target", "release", "kalcode-component-signer.exe"),
  );
  assert.deepEqual(invocation.args, [
    "sign-manifest",
    "--artifact",
    "C:\\stage\\runtime.zip",
    "--input",
    "C:\\stage\\manifest.json",
    "--output",
    "C:\\stage\\runtime.jws",
    "--store",
    "C:\\keys\\component.dpapi",
  ]);
  assert.equal(COMPONENT_MANIFEST_TYPE, "kalcode-local-component.v1");
  assert.equal(COMPONENT_CATALOG_TYPE, "kalcode-local-component-catalog.v1");
});

test("the wrapper always performs a locked release build before invoking an existing signer binary", () => {
  const calls = [];
  const spawn = (command, args) => {
    calls.push({ command, args });
    return command === "cargo"
      ? { status: 0, stdout: "", stderr: "" }
      : { status: 0, stdout: '{"configured":false,"kid":null}\n', stderr: "" };
  };
  assert.equal(
    runComponentSigner(
      "status",
      { "--store": "C:\\keys\\component.dpapi" },
      { root: "C:\\repo", spawn, exists: () => true },
    ),
    '{"configured":false,"kid":null}',
  );
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], {
    command: "cargo",
    args: ["build", "--locked", "--release", "--manifest-path", "C:\\repo\\tooling\\component-signer\\Cargo.toml"],
  });
  assert.equal(calls[1].command, "C:\\repo\\tooling\\component-signer\\target\\release\\kalcode-component-signer.exe");
});

test("manifest and catalog signing wrappers preserve exact paths and never expose child output", () => {
  const calls = [];
  const runSigner = (command, options) => {
    calls.push({ command, options });
    return "private-looking child output that must be discarded";
  };
  assert.equal(
    signComponentManifest(
      {
        storePath: "C:\\keys\\component.dpapi",
        inputPath: "C:\\stage\\manifest.json",
        artifactPath: "C:\\stage\\runtime.zip",
        outputPath: "C:\\stage\\runtime.jws",
      },
      { runSigner },
    ),
    undefined,
  );
  assert.equal(
    signComponentCatalog(
      {
        storePath: "C:\\keys\\component.dpapi",
        inputPath: "C:\\stage\\catalog.json",
        outputPath: "C:\\stage\\catalog.jws",
      },
      { runSigner },
    ),
    undefined,
  );
  assert.deepEqual(calls, [
    {
      command: "sign-manifest",
      options: {
        "--artifact": "C:\\stage\\runtime.zip",
        "--input": "C:\\stage\\manifest.json",
        "--output": "C:\\stage\\runtime.jws",
        "--store": "C:\\keys\\component.dpapi",
      },
    },
    {
      command: "sign-catalog",
      options: {
        "--input": "C:\\stage\\catalog.json",
        "--output": "C:\\stage\\catalog.jws",
        "--store": "C:\\keys\\component.dpapi",
      },
    },
  ]);
});

test("signing wrappers reject path aliasing before invoking the signer", () => {
  let calls = 0;
  const runSigner = () => {
    calls += 1;
  };
  assert.throws(
    () =>
      signComponentManifest(
        {
          storePath: "C:\\keys\\component.dpapi",
          inputPath: "C:\\stage\\manifest.json",
          artifactPath: "C:\\stage\\runtime.zip",
          outputPath: "C:\\stage\\runtime.zip",
        },
        { runSigner },
      ),
    /distinct/,
  );
  assert.equal(calls, 0);
});
