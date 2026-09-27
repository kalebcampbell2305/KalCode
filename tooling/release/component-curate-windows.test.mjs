import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { linkSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateComponentContract } from "./component-contract.mjs";
import {
  curateWindowsRuntime,
  readWindowsZipInventory,
  validateWindowsSourceInventory,
  writeDeterministicZip,
} from "./component-curate-windows.mjs";

const contract = validateComponentContract(
  JSON.parse(readFileSync(join(import.meta.dirname, "components", "kalvoice-local-reasoning-v1.json"), "utf8")),
);
const policy = contract.runtime.windowsX86_64;

if (process.platform === "win32") {
  test("Windows PowerShell reads the real deterministic runtime ZIP", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "kalcode-component-real-zip-")));
    writeFileSync(join(root, "llama-server.exe"), "fixture executable bytes");
    const archive = join(root, "runtime.zip");
    writeDeterministicZip(root, ["llama-server.exe"], archive);
    const inventory = readWindowsZipInventory(archive);
    assert.equal(inventory.length, 1);
    assert.equal(inventory[0].name, "llama-server.exe");
    assert.equal(inventory[0].size, 24);
    assert.equal(inventory[0].directory, false);
  });
}

function sourceInventory() {
  return policy.sourceEntries.map((name, index) => ({
    name,
    size: index + 1,
    compressedSize: index + 1,
    directory: false,
  }));
}

test("Windows source inventory must match all 51 pinned flat entries exactly", () => {
  assert.deepEqual(validateWindowsSourceInventory(sourceInventory(), policy), sourceInventory());
  assert.throws(() => validateWindowsSourceInventory(sourceInventory().slice(1), policy), /inventory/);
  assert.throws(
    () =>
      validateWindowsSourceInventory(
        [...sourceInventory(), { name: "escape.exe", size: 1, compressedSize: 1 }],
        policy,
      ),
    /inventory/,
  );
  const collision = sourceInventory();
  collision[1] = { ...collision[1], name: collision[0].name.toUpperCase() };
  assert.throws(() => validateWindowsSourceInventory(collision, policy), /collision|inventory/);
});

test("deterministic ZIP bytes are independent of caller order and timestamps", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kalcode-component-zip-")));
  writeFileSync(join(root, "b.dll"), "BBBB");
  writeFileSync(join(root, "a.exe"), "AAAA");
  const first = join(root, "first.zip");
  const second = join(root, "second.zip");
  writeDeterministicZip(root, ["b.dll", "a.exe"], first);
  writeDeterministicZip(root, ["a.exe", "b.dll"], second);
  assert.deepEqual(readFileSync(first), readFileSync(second));
  assert.equal(
    createHash("sha256").update(readFileSync(first)).digest("hex"),
    "da64729e518b9e15722426a2839dc81153525aa17ff78d4618172337510855a3",
    "Windows default ZIP bytes must remain unchanged",
  );
  assert.throws(
    () =>
      writeDeterministicZip(root, ["a.exe"], join(root, "missing.zip"), {
        executableEntries: ["missing.exe"],
      }),
    /executable inventory/,
  );
  assert.throws(
    () =>
      writeDeterministicZip(root, ["a.exe"], join(root, "duplicate.zip"), {
        executableEntries: ["a.exe", "a.exe"],
      }),
    /executable inventory/,
  );
});

test("Windows curation signs every PE and emits only closed redacted evidence", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kalcode-component-curate-")));
  const source = join(root, policy.source.file);
  const artifact = join(root, "runtime.zip");
  const record = join(root, "windows-x86_64-component-build.json");
  const metadata = join(root, "metadata.json");
  writeFileSync(source, "source bytes");
  writeFileSync(metadata, "{}");
  const signed = [];
  const status = new Map();
  const result = await curateWindowsRuntime(
    { sourcePath: source, artifactPath: artifact, recordPath: record, metadataPath: metadata },
    {
      contract,
      hashFile: async (path) => (path === source ? policy.source.sha256 : "b".repeat(64)),
      fileSize: (path) => (path === source ? policy.source.sizeBytes : 12_345),
      readZipInventory: () => sourceInventory(),
      withExtractedEntries: async (_sourcePath, names, callback) => {
        const extracted = join(root, "extracted");
        return callback(extracted, names, (name) => join(extracted, name));
      },
      authenticodeStatus: (path) => status.get(path) ?? { status: "NotSigned", timestamped: false },
      authenticodeIdentityOids: () => ["pinned"],
      artifactSigningIdentityMatchesPinned: (oids) => oids.length === 1 && oids[0] === "pinned",
      signTarget: ({ targetPath }) => {
        signed.push(targetPath);
        status.set(targetPath, { status: "Valid", timestamped: true });
      },
      writeZip: (_directory, names, output) => {
        assert.deepEqual(names, policy.extractEntries);
        writeFileSync(output, "curated zip");
      },
      now: () => new Date("2026-09-25T12:00:00.000Z"),
    },
  );
  assert.equal(signed.length, 22);
  assert.equal(result.memberCount, 23);
  assert.equal(result.codeMemberCount, 22);
  assert.deepEqual(Object.keys(result).sort(), [
    "arch",
    "artifact",
    "codeMemberCount",
    "componentId",
    "createdAt",
    "kind",
    "licenses",
    "memberCount",
    "platform",
    "recipeSha256",
    "runtimeAbi",
    "schemaVersion",
    "signing",
    "source",
    "version",
  ]);
  assert.deepEqual(result.signing, {
    provider: "azure-artifact-signing",
    allCodeSigned: true,
    timestamped: true,
    publisherIdentityBound: true,
  });
  assert.doesNotMatch(JSON.stringify(result), /subject|thumbprint|certificate|private/i);
  assert.equal(readFileSync(source, "utf8"), "source bytes");
});

test("Windows curation fails before signing on source or pre-signature substitution", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kalcode-component-curate-fail-")));
  const source = join(root, policy.source.file);
  const metadata = join(root, "metadata.json");
  writeFileSync(source, "source bytes");
  writeFileSync(metadata, "{}");
  let signCalls = 0;
  const baseDeps = {
    contract,
    fileSize: () => policy.source.sizeBytes,
    readZipInventory: () => sourceInventory(),
    withExtractedEntries: async (_sourcePath, names, callback) => {
      await callback(root, names, (name) => join(root, name));
    },
    authenticodeStatus: () => ({ status: "NotSigned", timestamped: false }),
    signTarget: () => {
      signCalls += 1;
    },
  };
  await assert.rejects(
    curateWindowsRuntime(
      {
        sourcePath: source,
        artifactPath: join(root, "runtime.zip"),
        recordPath: join(root, "record.json"),
        metadataPath: metadata,
      },
      { ...baseDeps, hashFile: async () => "0".repeat(64) },
    ),
    /source integrity/,
  );
  assert.equal(signCalls, 0);

  await assert.rejects(
    curateWindowsRuntime(
      {
        sourcePath: source,
        artifactPath: join(root, "runtime-2.zip"),
        recordPath: join(root, "record-2.json"),
        metadataPath: metadata,
      },
      {
        ...baseDeps,
        hashFile: async () => policy.source.sha256,
        authenticodeStatus: () => ({ status: "Valid", timestamped: true }),
      },
    ),
    /unsigned upstream/,
  );
  assert.equal(signCalls, 0);
});

test("Windows curation rejects output and hardlink aliases before the first signing effect", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kalcode-component-curate-alias-")));
  const source = join(root, policy.source.file);
  const metadata = join(root, "metadata.json");
  const artifact = join(root, "runtime.zip");
  writeFileSync(source, "source bytes");
  writeFileSync(metadata, "{}");
  writeFileSync(artifact, "existing artifact");
  let signCalls = 0;
  const options = {
    contract,
    hashFile: async () => policy.source.sha256,
    fileSize: () => policy.source.sizeBytes,
    readZipInventory: () => sourceInventory(),
    signTarget: () => {
      signCalls += 1;
    },
  };
  await assert.rejects(
    curateWindowsRuntime(
      { sourcePath: source, artifactPath: artifact, recordPath: join(root, "record.json"), metadataPath: metadata },
      options,
    ),
    /already exists/,
  );
  assert.equal(signCalls, 0);
  assert.equal(readFileSync(artifact, "utf8"), "existing artifact");

  const metadataAlias = join(root, "metadata-alias.json");
  linkSync(source, metadataAlias);
  await assert.rejects(
    curateWindowsRuntime(
      {
        sourcePath: source,
        artifactPath: join(root, "new-runtime.zip"),
        recordPath: join(root, "new-record.json"),
        metadataPath: metadataAlias,
      },
      options,
    ),
    /distinct/,
  );
  assert.equal(signCalls, 0);
  assert.equal(readFileSync(source, "utf8"), "source bytes");
});
