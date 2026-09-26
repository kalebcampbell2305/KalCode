import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { gzipSync } from "node:zlib";
import * as contract from "./component-contract.mjs";

test("pinned Mac runtime policy matches the consumer closure and exact upstream MIT license", () => {
  const value = contract.loadComponentContract(
    new URL("./components/kalvoice-local-reasoning-v1.json", import.meta.url),
  );
  const mac = value.runtime.macosAarch64;
  assert.equal(mac.source.sha256, "1ad3f9eff80edb9dbef4259ad564d1720612ef7eea48fa4afed0e54f5f3d5711");
  assert.equal(mac.source.sizeBytes, 11189714);
  assert.equal(mac.codeEntries.length, 11);
  const consumer = readFileSync(new URL("../../crates/kalvoice/src/component_store.rs", import.meta.url), "utf8");
  for (const file of mac.extractEntries) assert.ok(consumer.includes(`"${file}"`));
  assert.throws(
    () =>
      contract.validateComponentContract({
        ...value,
        runtime: { ...value.runtime, macosAarch64: { ...mac, source: { ...mac.source, sha256: "0".repeat(64) } } },
      }),
    /Mac.*source|Mac.*policy/,
  );
});

test("Mach-O closure accepts only exact arm64, bounded deployment, safe loader rpath and known dependencies", async () => {
  const { validateMacRuntimeMachO } = await import("./component-curate-macos.mjs");
  const evidence = {
    archs: "arm64",
    loadCommands: "cmd LC_BUILD_VERSION\n minos 13.3\ncmd LC_RPATH\n path @loader_path (offset 12)",
    dependencies:
      "llama-server:\n\t@rpath/libllama.0.dylib (compatibility version 0.0.0)\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0)",
  };
  assert.equal(validateMacRuntimeMachO(evidence), true);
  for (const changed of [
    { archs: "arm64 x86_64" },
    { loadCommands: evidence.loadCommands.replace("13.3", "27.0") },
    { loadCommands: evidence.loadCommands.replace("@loader_path", "/tmp/injected") },
    { dependencies: evidence.dependencies.replace("@rpath/libllama.0.dylib", "@rpath/unknown.dylib") },
    { dependencies: evidence.dependencies.replace("/usr/lib/libSystem.B.dylib", "/tmp/evil.dylib") },
  ])
    assert.throws(() => validateMacRuntimeMachO({ ...evidence, ...changed }));
});

test("only pinned in-archive dylib aliases can become regular component members", async () => {
  const { selectMacRuntimeMembers } = await import("./component-curate-macos.mjs");
  const policy = contract.loadComponentContract(
    new URL("./components/kalvoice-local-reasoning-v1.json", import.meta.url),
  ).runtime.macosAarch64;
  const entries = new Map();
  for (const item of policy.members) {
    entries.set(
      item.file,
      item.source === item.file ? { type: "0", bytes: Buffer.from(item.file) } : { type: "2", link: item.source },
    );
    entries.set(item.source, { type: "0", bytes: Buffer.from(item.file) });
  }
  entries.set("LICENSE", { type: "0", bytes: Buffer.from("fixture") });
  assert.equal(selectMacRuntimeMembers(entries, policy).length, 12);
  const alias = policy.members.find((m) => m.file !== m.source);
  entries.set(alias.file, { type: "2", link: "../escape" });
  assert.throws(() => selectMacRuntimeMembers(entries, policy), /alias/);
});

test("signed Mac candidate cannot qualify as notarized publication evidence", async () => {
  const { validateMacRuntimeNotaryEvidence } = await import("./component-curate-macos.mjs");
  assert.throws(() => validateMacRuntimeNotaryEvidence({ status: "pending" }, "a".repeat(64)), /notar/);
  const accepted = {
    status: "accepted",
    submissionId: "123e4567-e89b-42d3-a456-426614174000",
    artifactSha256: "a".repeat(64),
    logIssueFree: true,
    allCodeNotarized: true,
  };
  assert.equal(validateMacRuntimeNotaryEvidence(accepted, "a".repeat(64)), true);
  for (const changed of [
    { artifactSha256: "b".repeat(64) },
    { logIssueFree: false },
    { allCodeNotarized: false },
    { submissionId: "bad" },
  ])
    assert.throws(() => validateMacRuntimeNotaryEvidence({ ...accepted, ...changed }, "a".repeat(64)), /notar/);
});

test("tar reader rejects traversal, corrupt headers and duplicate members before writing any file", async () => {
  const { readMacRuntimeTar } = await import("./component-curate-macos.mjs");
  const archive = (names, corrupt = false) => {
    const headers = names.map((name) => {
      const header = Buffer.alloc(512);
      header.write(name, 0);
      header.write("00000000000\0", 124);
      header.fill(32, 148, 156);
      header[156] = 48;
      let sum = 0;
      for (const byte of header) sum += byte;
      header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
      return header;
    });
    const bytes = Buffer.concat([...headers, Buffer.alloc(1024)]);
    if (corrupt) bytes[0] ^= 1;
    return gzipSync(bytes);
  };
  const names = Array.from({ length: 60 }, (_, i) => `llama-b11146/file-${i}`);
  assert.equal(readMacRuntimeTar(archive(names)).size, 60);
  for (const [changed, corrupt] of [
    [names, true],
    [[...names.slice(1), "llama-b11146/../outside"], false],
    [[...names.slice(1), names[1]], false],
  ])
    assert.throws(() => readMacRuntimeTar(archive(changed, corrupt)));
});
