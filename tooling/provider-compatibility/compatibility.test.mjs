import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import {
  PROVIDER_COMPATIBILITY_TYPE,
  providerSignerInvocation,
  signProviderCompatibility,
  stageProviderCompatibility,
  verifyProviderCompatibility,
} from "./compatibility.mjs";

const TOKEN = `${"a".repeat(12)}.${"b".repeat(16)}.${"c".repeat(86)}\n`;
const COMPACT_TOKEN = TOKEN.trimEnd();

async function withTempRoot(run) {
  const root = await mkdtemp(join(tmpdir(), "kalcode-provider-policy-"));
  try {
    mkdirSync(join(root, "tooling", "release"), { recursive: true });
    writeFileSync(join(root, "tooling", "release", "component-public-key.json"), "{}\n");
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("provider signer invocations are domain-specific and accept only exact option sets", () => {
  const root = resolve("C:/kalcode-policy-test");
  const invocation = providerSignerInvocation({
    root,
    command: "sign-provider-compatibility",
    options: {
      "--input": resolve("C:/input.json"),
      "--output": resolve("C:/output.jws"),
      "--store": resolve("C:/key.dpapi"),
    },
  });
  assert.equal(invocation.args[0], "sign-provider-compatibility");
  assert.equal(PROVIDER_COMPATIBILITY_TYPE, "kalcode-provider-compatibility.v1");
  assert.throws(
    () =>
      providerSignerInvocation({
        root,
        command: "sign-provider-compatibility",
        options: { "--input": resolve("C:/input.json"), "--output": resolve("C:/output.jws") },
      }),
    /options are invalid/,
  );
  assert.throws(
    () =>
      providerSignerInvocation({
        root,
        command: "sign-provider-compatibility",
        options: {
          "--input": resolve("C:/input.json"),
          "--output": resolve("C:/output.jws"),
          "--store": resolve("C:/key.dpapi"),
          "--url": "https://attacker.invalid/policy",
        },
      }),
    /options are invalid/,
  );
});

test("sign and verify wrappers pass absolute distinct paths to the signer", () => {
  const calls = [];
  const runSigner = (command, options) => calls.push({ command, options });
  signProviderCompatibility(
    {
      storePath: resolve("C:/key.dpapi"),
      inputPath: resolve("C:/policy.json"),
      outputPath: resolve("C:/policy.jws"),
    },
    { runSigner },
  );
  verifyProviderCompatibility(
    { publicKeyPath: resolve("C:/public.json"), tokenPath: resolve("C:/policy.jws") },
    { runSigner },
  );
  assert.deepEqual(calls, [
    {
      command: "sign-provider-compatibility",
      options: {
        "--input": resolve("C:/policy.json"),
        "--output": resolve("C:/policy.jws"),
        "--store": resolve("C:/key.dpapi"),
      },
    },
    {
      command: "verify-provider-compatibility",
      options: {
        "--public-key-file": resolve("C:/public.json"),
        "--token": resolve("C:/policy.jws"),
      },
    },
  ]);
  assert.throws(
    () =>
      signProviderCompatibility(
        { storePath: resolve("C:/same"), inputPath: resolve("C:/same"), outputPath: resolve("C:/other") },
        { runSigner },
      ),
    /distinct/,
  );
  assert.throws(
    () =>
      verifyProviderCompatibility(
        { publicKeyPath: "relative.json", tokenPath: resolve("C:/policy.jws") },
        { runSigner },
      ),
    /absolute/,
  );
});

test("staging verifies an immutable snapshot with the repository trust key before atomic publication", async () => {
  await withTempRoot(async (root) => {
    const source = join(root, "signed.jws");
    writeFileSync(source, TOKEN);
    const destination = join(root, "apps", "website", "public", "providers", "v1", "compatibility", "stable.jws");
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, `${"x".repeat(12)}.${"y".repeat(16)}.${"z".repeat(86)}\n`);
    let verified;
    const result = stageProviderCompatibility(
      { tokenPath: source },
      {
        root,
        runSigner(command, options) {
          verified = { command, options, token: readFileSync(options["--token"], "utf8") };
        },
      },
    );
    assert.equal(result, destination);
    assert.equal(readFileSync(destination, "utf8"), COMPACT_TOKEN);
    assert.deepEqual(
      { command: verified.command, key: verified.options["--public-key-file"], token: verified.token },
      {
        command: "verify-provider-compatibility",
        key: join(root, "tooling", "release", "component-public-key.json"),
        token: COMPACT_TOKEN,
      },
    );
    assert.notEqual(verified.options["--token"], source);
    assert.equal(dirname(verified.options["--token"]), dirname(destination));
  });
});

test("failed verification preserves the last-known-good static policy and removes the snapshot", async () => {
  await withTempRoot(async (root) => {
    const destination = join(root, "apps", "website", "public", "providers", "v1", "compatibility", "stable.jws");
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, `${"x".repeat(12)}.${"y".repeat(16)}.${"z".repeat(86)}\n`);
    const source = join(root, "candidate.jws");
    writeFileSync(source, TOKEN);
    let snapshot;
    assert.throws(
      () =>
        stageProviderCompatibility(
          { tokenPath: source },
          {
            root,
            runSigner(_command, options) {
              snapshot = options["--token"];
              throw new Error("invalid signature");
            },
          },
        ),
      /invalid signature/,
    );
    assert.match(readFileSync(destination, "utf8"), /^x+\.y+\.z+\n$/);
    assert.equal(existsSync(snapshot), false);
  });
});

test("staging rejects links, malformed tokens and oversized documents before verification", async () => {
  await withTempRoot(async (root) => {
    const target = join(root, "target.jws");
    const link = join(root, "link.jws");
    writeFileSync(target, TOKEN);
    try {
      symlinkSync(target, link, "file");
      assert.throws(
        () => stageProviderCompatibility({ tokenPath: link }, { root, runSigner: assert.fail }),
        /regular file/,
      );
    } catch (error) {
      if (error?.code !== "EPERM") throw error;
    }
    const malformed = join(root, "malformed.jws");
    writeFileSync(malformed, "aaa.bbb.ccc\nsecond-line\n");
    assert.throws(
      () => stageProviderCompatibility({ tokenPath: malformed }, { root, runSigner: assert.fail }),
      /canonical compact JWS/,
    );
    const oversized = join(root, "oversized.jws");
    writeFileSync(oversized, `${"a".repeat(65 * 1024)}.b.c\n`);
    assert.throws(
      () => stageProviderCompatibility({ tokenPath: oversized }, { root, runSigner: assert.fail }),
      /safety limit/,
    );
  });
});
