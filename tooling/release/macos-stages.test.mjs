import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as contract from "./macos-contract.mjs";

const team = "A1B2C3D4E5";
const id = "123e4567-e89b-42d3-a456-426614174000";
const env = {
  KALCODE_APPLE_TEAM_ID: team,
  KALCODE_APPLE_SIGNING_IDENTITY: `Developer ID Application: Example (${team})`,
};
function candidate() {
  return {
    schemaVersion: 1,
    kind: "macos-signed-candidate",
    platform: "macos",
    version: "1.2.3",
    arch: "arm64",
    file: "KalCode_1.2.3_arm64.dmg",
    size: 10,
    sha256: "a".repeat(64),
    commit: "b".repeat(40),
    teamId: team,
    signed: true,
    signatureStatus: "Valid",
    releaseDescriptorEligible: false,
    releaseDescriptorBlockedReason: "notarization_pending",
    notarized: false,
    stapled: false,
    requestedReleaseChannel: "stable",
    compiledChannel: "stable",
    compiledChannelVerification: {
      schemaVersion: 1,
      version: "1.2.3",
      channel: "stable",
      method: "build_info_probe_v1",
      testHooks: false,
    },
    helpers: contract.MACOS_HELPERS.map(({ name, identifier }) => ({
      name,
      identifier,
      architecture: "arm64",
      sha256: "c".repeat(64),
      signed: true,
      expectedTeamBound: true,
      hardenedRuntime: true,
      timestamped: true,
    })),
  };
}

test("build-only requires signing but defers the notary credential boundary", () => {
  assert.equal(contract.parseMacPackageOptions(["--channel", "stable", "--build-only"]).buildOnly, true);
  assert.equal(contract.validateMacSigningEnvironment(env).teamId, team);
  assert.throws(() => contract.validateMacReleaseEnvironment(env), /notary/);
});
test("resume requires an explicit channel and one candidate, without rebuilding flags", () => {
  assert.equal(
    contract.parseMacPackageOptions(["--channel", "stable", "--resume", "candidate.json"]).resume,
    "candidate.json",
  );
  for (const args of [
    ["--build-only", "--build-only"],
    ["--resume"],
    ["--resume", "one", "--resume", "two"],
    ["--resume", "one", "--build-only"],
    ["--resume", "one", "--features", "safe-extra"],
  ])
    assert.throws(() => contract.parseMacPackageOptions(["--channel", "stable", ...args]));
});
test("candidate has a distinct non-publishable contract binding helpers, commit, channel, team and bytes", () => {
  const good = candidate();
  assert.equal(contract.validateMacCandidateRecord(good, good.file), good);
  assert.throws(() => contract.validateMacBuildRecord(good, good.file));
  for (const change of [
    { releaseDescriptorEligible: true },
    { notarized: true },
    { stapled: true },
    { notarySubmissionId: id },
    { kind: "release" },
    { teamId: "other" },
    { commit: "unknown" },
    { helpers: [] },
    { sha256: "bad" },
    { compiledChannel: "beta" },
  ])
    assert.throws(() => contract.validateMacCandidateRecord({ ...good, ...change }, good.file));
});

async function fixture(t, options = {}) {
  const { resumeMacCandidate } = await import("./macos-resume.mjs");
  const dir = mkdtempSync(join(tmpdir(), "kalcode-stage-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const record = candidate();
  mkdirSync(join(dir, "macos-arm64-candidate"));
  const artifact = join(dir, "macos-arm64-candidate", record.file);
  const path = join(dir, "macos-arm64-candidate.json");
  writeFileSync(artifact, "1234567890");
  writeFileSync(path, JSON.stringify(record));
  const calls = [];
  const runner = {
    run(command, args) {
      calls.push([command, ...args]);
      if (options.failStaple && args[1] === "staple") throw Error("staple interrupted");
    },
    capture(command, args) {
      calls.push([command, ...args]);
      if (args[1] === "submit") {
        assert.equal(args.includes("--wait"), false);
        if (options.failSubmit) throw Error("submit interrupted");
        return JSON.stringify({ id, message: "Successfully uploaded file" });
      }
      if (args[1] === "wait") {
        const checkpoint = JSON.parse(readFileSync(join(dir, "macos-arm64-notary.json"), "utf8"));
        assert.equal(checkpoint.submissionId, id, "ID must be persisted before wait");
        if (options.failWait) throw Error("wait interrupted");
        return JSON.stringify({ id, status: options.rejected ? "Invalid" : "Accepted" });
      }
      if (args[1] === "log") return JSON.stringify({ jobId: id, status: "Accepted", issues: options.issues ?? null });
      throw Error("unexpected command");
    },
  };
  const run = (overrides = {}) =>
    resumeMacCandidate({
      candidatePath: path,
      expected: {
        commit: record.commit,
        version: record.version,
        arch: record.arch,
        requestedReleaseChannel: "stable",
        teamId: team,
      },
      notaryProfile: "kalcode-notary",
      runner,
      hashFile: async () => record.sha256,
      verifyCandidate: async () => {
        calls.push(["candidate-verified"]);
      },
      verifyRelease: async () => {
        if (options.failVerify) throw Error("Gatekeeper failed");
        return { status: "passed" };
      },
      ...overrides,
    });
  return { run, calls, dir, path, artifact, record, options };
}
test("notary resume persists the job before waiting and reuses it after interruption", async (t) => {
  const f = await fixture(t, { failWait: true });
  await assert.rejects(f.run(), /wait interrupted/);
  assert.equal(existsSync(join(f.dir, "macos-arm64-build.json")), false);
  f.options.failWait = false;
  await f.run();
  assert.equal(f.calls.filter((c) => c[2] === "submit").length, 1);
  assert.equal(f.calls.filter((c) => c[0] === "candidate-verified").length, 2);
  const record = JSON.parse(readFileSync(join(f.dir, "macos-arm64-build.json"), "utf8"));
  assert.equal(record.notarySubmissionId, id);
  assert.equal(record.releaseDescriptorEligible, true);
  assert.equal(readFileSync(f.artifact, "utf8"), "1234567890", "signed candidate stays immutable");
});
test("an ambiguous interrupted submit never silently resubmits", async (t) => {
  const f = await fixture(t, { failSubmit: true });
  await assert.rejects(f.run(), /submit interrupted/);
  f.options.failSubmit = false;
  await assert.rejects(f.run(), /ambiguous/i);
  assert.equal(f.calls.filter((c) => c[2] === "submit").length, 1);
});
test("candidate corruption or source/channel/team mismatch fails before Apple submission", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.run({ hashFile: async () => "d".repeat(64) }), /digest/);
  for (const change of [
    { commit: "d".repeat(40) },
    { version: "1.2.4" },
    { arch: "x64" },
    { requestedReleaseChannel: "beta" },
    { teamId: "Z9Y8X7W6V5" },
  ]) {
    await assert.rejects(f.run({ expected: { ...f.record, ...change } }), /candidate.*match/i);
  }
  assert.equal(f.calls.length, 0);
});
test("Apple rejection, nonempty issue log and final verification failure emit no release evidence", async (t) => {
  for (const options of [{ rejected: true }, { issues: [{ severity: "warning" }] }, { failVerify: true }]) {
    const f = await fixture(t, options);
    await assert.rejects(f.run());
    assert.equal(existsSync(join(f.dir, "macos-arm64-build.json")), false);
    assert.equal(existsSync(join(f.dir, "macos-arm64-verify.json")), false);
  }
});
test("interrupted stapling resumes from immutable candidate and already recorded Apple job", async (t) => {
  const f = await fixture(t, { failStaple: true });
  await assert.rejects(f.run(), /staple interrupted/);
  f.options.failStaple = false;
  await f.run();
  assert.equal(f.calls.filter((c) => c[2] === "submit").length, 1);
});

test("completed resume is idempotent and regenerates missing final evidence only after reverification", async (t) => {
  const f = await fixture(t);
  await f.run();
  rmSync(join(f.dir, "macos-arm64-verify.json"));
  await f.run();
  assert.equal(f.calls.filter((c) => c[2] === "submit").length, 1);
  assert.equal(f.calls.filter((c) => c[2] === "staple").length, 1);
  assert.equal(existsSync(join(f.dir, "macos-arm64-verify.json")), true);
});
test("a checkpoint cannot be reused after candidate record mutation", async (t) => {
  const f = await fixture(t, { failWait: true });
  await assert.rejects(f.run(), /wait interrupted/);
  writeFileSync(f.path, JSON.stringify({ ...f.record, createdAt: "changed" }));
  f.options.failWait = false;
  await assert.rejects(f.run(), /different candidate/);
  assert.equal(f.calls.filter((c) => c[2] === "submit").length, 1);
});
test("concurrent resume and preexisting unrelated release artifact fail closed", async (t) => {
  const f = await fixture(t);
  const lock = join(f.dir, "macos-arm64-notary.lock");
  mkdirSync(lock);
  await assert.rejects(f.run(), /lock exists/);
  assert.equal(f.calls.length, 0);
  rmSync(lock, { recursive: true });
  writeFileSync(join(f.dir, f.record.file), "unrelated");
  await assert.rejects(f.run(), /unrelated final DMG/);
  assert.equal(readFileSync(join(f.dir, f.record.file), "utf8"), "unrelated");
});
