import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { loadComponentContract } from "./component-contract.mjs";
import { macRuntimeIdentifier, validateMacRuntimePublicationEvidence } from "./component-curate-macos.mjs";
import { notarizeMacRuntime } from "./component-notarize-macos.mjs";

const contract = loadComponentContract(new URL("./components/kalvoice-local-reasoning-v1.json", import.meta.url));
const policy = contract.runtime.macosAarch64;
const id = "123e4567-e89b-42d3-a456-426614174000";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "kalcode-mac-notary-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const artifactPath = join(dir, "runtime.zip"),
    recordPath = join(dir, "runtime.json");
  const zip = Buffer.from("synthetic ZIP bytes; extraction and Apple are injected unit fixtures");
  const bytes = (file) =>
    file === "LICENSE"
      ? readFileSync(new URL("../../third_party/kalvoice-notices/llama.cpp-MIT.txt", import.meta.url))
      : Buffer.from(`synthetic ${file}`);
  const record = {
    schemaVersion: 1,
    componentId: contract.runtime.componentId,
    kind: "runtime",
    version: contract.runtime.version,
    platform: "macos",
    arch: "aarch64",
    runtimeAbi: contract.runtime.runtimeAbi,
    source: {
      id: policy.source.id,
      revision: policy.source.revision,
      file: policy.source.file,
      size: policy.source.sizeBytes,
      sha256: policy.source.sha256,
    },
    artifact: { file: "runtime.zip", size: zip.length, sha256: hash(zip) },
    recipeSha256: "c".repeat(64),
    licenses: policy.licenses.map(({ spdxId, noticeSha256 }) => ({ spdxId, noticeSha256 })),
    memberCount: 12,
    codeMemberCount: 11,
    signing: {
      provider: "apple-developer-id",
      teamId: policy.expectedTeamId,
      allCodeSigned: true,
      timestamped: true,
      hardenedRuntime: true,
      noEntitlementExceptions: true,
    },
    members: policy.codeEntries.map((file) => ({ file, sha256: hash(bytes(file)) })),
    notarization: { status: "pending" },
    releaseEligible: false,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  writeFileSync(artifactPath, zip);
  writeFileSync(recordPath, JSON.stringify(record));
  const artifact = {
    componentId: record.componentId,
    kind: record.kind,
    version: record.version,
    runtimeAbi: record.runtimeAbi,
    file: record.artifact.file,
    sizeBytes: zip.length,
    sha256: record.artifact.sha256,
    licenses: record.licenses,
    provenance: {
      sourceId: record.source.id,
      sourceRevision: record.source.revision,
      sourceIntegritySha256: record.source.sha256,
      buildRecipeSha256: record.recipeSha256,
    },
  };
  const calls = [];
  const runner = {
    run(command, args) {
      calls.push([command, ...args]);
      if (options.failRequirement && args.includes("-R=notarized")) throw Error("notarized requirement failed");
    },
    capture(command, args) {
      calls.push([command, ...args]);
      if (command === "/usr/bin/unzip") return policy.extractEntries.join("\n");
      if (command === "lipo") return "arm64";
      if (command === "otool")
        return args[0] === "-l"
          ? "cmd LC_BUILD_VERSION\n minos 13.3\ncmd LC_RPATH\n path @loader_path (offset 12)"
          : "file:\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0)";
      if (command === "codesign")
        return args.includes("--entitlements")
          ? ""
          : `Identifier=${macRuntimeIdentifier(basename(args.at(-1)))}\nCodeDirectory v=20500 flags=0x10000(runtime)\nAuthority=Developer ID Application: Example (${policy.expectedTeamId})\nTeamIdentifier=${policy.expectedTeamId}\nTimestamp=fixture`;
      if (args[1] === "submit") {
        if (options.failSubmit) throw Error("submit interrupted");
        return JSON.stringify({ id });
      }
      if (args[1] === "wait") {
        assert.equal(JSON.parse(readFileSync(`${recordPath}.notary.json`, "utf8")).id, id);
        if (options.failWait) throw Error("wait interrupted");
        return JSON.stringify({ id, status: options.rejected ? "Invalid" : "Accepted" });
      }
      if (args[1] === "log")
        return JSON.stringify({
          jobId: id,
          status: "Accepted",
          issues: options.issues ?? null,
          sha256: options.wrongLogDigest ? "0".repeat(64) : record.artifact.sha256,
        });
      throw Error("unexpected fixture command");
    },
  };
  return {
    record,
    artifact,
    recordPath,
    artifactPath,
    calls,
    options,
    run: () =>
      notarizeMacRuntime(
        { artifactPath, recordPath, notaryProfile: "fixture-profile" },
        { runner, extractBytes: (_command, args) => bytes(args.at(-1)) },
      ),
  };
}

test("publisher rejects signed-only Mac candidate and accepts only fully bound notary evidence", async (t) => {
  const f = fixture(t);
  const catalog = { platform: "macos", arch: "aarch64", issuedAt: 2000000000 };
  assert.throws(() => validateMacRuntimePublicationEvidence(f.record, f.artifact, catalog, contract), /not eligible/);
  const accepted = await f.run();
  assert.doesNotThrow(() => validateMacRuntimePublicationEvidence(accepted, f.artifact, catalog, contract));
  assert.equal(f.calls.filter((c) => c.includes("-R=notarized")).length, 11);
  for (const patch of [
    { members: [] },
    { releaseEligible: false },
    { signing: { ...accepted.signing, teamId: "A1B2C3D4E5" } },
    { notarization: { ...accepted.notarization, allCodeNotarized: false } },
  ])
    assert.throws(() =>
      validateMacRuntimePublicationEvidence({ ...accepted, ...patch }, f.artifact, catalog, contract),
    );
});
test("interrupted wait reuses the persisted exact Apple job", async (t) => {
  const f = fixture(t, { failWait: true });
  await assert.rejects(f.run(), /wait interrupted/);
  f.options.failWait = false;
  await f.run();
  await f.run();
  assert.equal(f.calls.filter((c) => c[2] === "submit").length, 1);
});
test("ambiguous submission never silently retries", async (t) => {
  const f = fixture(t, { failSubmit: true });
  await assert.rejects(f.run(), /submit interrupted/);
  f.options.failSubmit = false;
  await assert.rejects(f.run(), /ambiguous/);
  assert.equal(f.calls.filter((c) => c[2] === "submit").length, 1);
});
test("Apple rejection, issues, wrong artifact log and failed notarized requirement remain ineligible", async (t) => {
  for (const options of [
    { rejected: true },
    { issues: [{ severity: "warning" }] },
    { wrongLogDigest: true },
    { failRequirement: true },
  ]) {
    const f = fixture(t, options);
    await assert.rejects(f.run());
    assert.equal(JSON.parse(readFileSync(f.recordPath, "utf8")).releaseEligible, false);
  }
});
test("curation metadata and artifact tampering fail before external notarization", async (t) => {
  const f = fixture(t);
  writeFileSync(f.recordPath, JSON.stringify({ ...f.record, source: { ...f.record.source, sha256: "0".repeat(64) } }));
  await assert.rejects(f.run(), /curation evidence/);
  assert.equal(f.calls.length, 0);
  writeFileSync(f.recordPath, JSON.stringify(f.record));
  writeFileSync(f.artifactPath, "changed");
  await assert.rejects(f.run(), /digest/);
  assert.equal(f.calls.length, 0);
});
