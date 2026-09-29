import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  buildQaVersionClaimStatement,
  exactPublicationRowProblems,
  semverPrecedenceKey,
} from "./publication-safety.mjs";
import { buildUpdaterQaStagePlan } from "./publish-plan.mjs";
import {
  canonicalQaObjectPutArguments,
  createQaStageReceipt,
  parseQaStageArguments,
  runQaStagePublication,
  validateBaselineSourceSnapshot,
  writeQaStageReceipt,
} from "./stage-updater-qa.mjs";
import { updaterQaProblems } from "./updater-manifest.mjs";

const BASELINE_VERSION = "1.2.2";
const CANDIDATE_VERSION = "1.2.3";
const BASELINE_COMMIT = "b".repeat(40);
const CANDIDATE_COMMIT = "c".repeat(40);
const BASELINE_SHA = "1".repeat(64);
const CANDIDATE_SHA = "2".repeat(64);

function qaRecord(status = "passed") {
  return {
    schemaVersion: 2,
    status,
    target: "windows-x86_64",
    channel: "stable",
    release: { version: CANDIDATE_VERSION, commit: CANDIDATE_COMMIT, sha256: CANDIDATE_SHA },
    safeguards: {
      testHooks: false,
      cacheSeeded: false,
      authenticationBypassed: false,
      tlsBypassed: false,
      fixtureOnly: false,
    },
    checks: {
      install: true,
      cleanInstall: true,
      launch: true,
      auth: true,
      providers: true,
      accountIsolation: true,
      kalvoice: true,
      browser: true,
      workspace: true,
      sleepWake: true,
    },
    updateTrial:
      status === "passed"
        ? {
            method: "public-unlisted-immutable-version-v1",
            baseline: { version: BASELINE_VERSION, commit: BASELINE_COMMIT, sha256: BASELINE_SHA },
            candidate: { version: CANDIDATE_VERSION, commit: CANDIDATE_COMMIT, sha256: CANDIDATE_SHA },
            outcomes: [
              {
                step: "update",
                from: { version: BASELINE_VERSION, commit: BASELINE_COMMIT, sha256: BASELINE_SHA },
                to: { version: CANDIDATE_VERSION, commit: CANDIDATE_COMMIT, sha256: CANDIDATE_SHA },
                passed: true,
              },
              {
                step: "rollback",
                from: { version: CANDIDATE_VERSION, commit: CANDIDATE_COMMIT, sha256: CANDIDATE_SHA },
                to: { version: BASELINE_VERSION, commit: BASELINE_COMMIT, sha256: BASELINE_SHA },
                passed: true,
              },
              {
                step: "reupdate",
                from: { version: BASELINE_VERSION, commit: BASELINE_COMMIT, sha256: BASELINE_SHA },
                to: { version: CANDIDATE_VERSION, commit: CANDIDATE_COMMIT, sha256: CANDIDATE_SHA },
                passed: true,
              },
            ],
          }
        : null,
  };
}

test("QA evidence is exact-bound and normal publication requires lower-to-newer rollback proof", () => {
  const expected = {
    target: "windows-x86_64",
    channel: "stable",
    release: { version: CANDIDATE_VERSION, commit: CANDIDATE_COMMIT, sha256: CANDIDATE_SHA },
  };
  assert.deepEqual(updaterQaProblems(qaRecord(), expected, "final"), []);
  assert.deepEqual(updaterQaProblems(qaRecord("preliminary-passed"), expected, "preliminary"), []);
  assert.match(updaterQaProblems(qaRecord("preliminary-passed"), expected, "final").join("\n"), /completed/);

  for (const mutate of [
    (record) => (record.release.sha256 = "9".repeat(64)),
    (record) => (record.release.version = BASELINE_VERSION),
    (record) => (record.safeguards.testHooks = true),
    (record) => (record.safeguards.cacheSeeded = true),
    (record) => (record.safeguards.authenticationBypassed = true),
    (record) => (record.safeguards.tlsBypassed = true),
    (record) => (record.safeguards.fixtureOnly = true),
    (record) => (record.updateTrial.baseline.version = CANDIDATE_VERSION),
    (record) => (record.updateTrial.outcomes[1].passed = false),
    (record) => (record.updateTrial.outcomes[2].from.version = "1.2.1"),
  ]) {
    const record = qaRecord();
    mutate(record);
    assert.notDeepEqual(updaterQaProblems(record, expected, "final"), []);
  }
});

function sourceSnapshot() {
  const candidateLock = `[[package]]\nname = "kalcode-desktop"\nversion = "${CANDIDATE_VERSION}"\n\n[[package]]\nname = "serde"\nversion = "1.0.0"\nsource = "registry"\n`;
  const baselineLock = candidateLock.replace(`version = "${CANDIDATE_VERSION}"`, `version = "${BASELINE_VERSION}"`);
  return {
    candidateVersion: CANDIDATE_VERSION,
    baselineVersion: BASELINE_VERSION,
    workspacePackages: ["kalcode-desktop"],
    candidateFiles: {
      "Cargo.toml": `[workspace.package]\nversion = "${CANDIDATE_VERSION}"\n`,
      "Cargo.lock": candidateLock,
      "apps/desktop/package.json": JSON.stringify({ name: "@kalcode/desktop", version: CANDIDATE_VERSION }),
      "apps/desktop/src-tauri/tauri.conf.json": JSON.stringify({ version: CANDIDATE_VERSION }),
      "crates/updater/src/lib.rs":
        'Self::Stable => "https://kalcoded.com/releases/updater/stable.json",\nSelf::Beta => "https://kalcoded.com/releases/updater/beta.json",',
    },
    baselineFiles: {
      "Cargo.toml": `[workspace.package]\nversion = "${BASELINE_VERSION}"\n`,
      "Cargo.lock": baselineLock,
      "apps/desktop/package.json": JSON.stringify({ name: "@kalcode/desktop", version: BASELINE_VERSION }),
      "apps/desktop/src-tauri/tauri.conf.json": JSON.stringify({ version: BASELINE_VERSION }),
      "crates/updater/src/lib.rs": `Self::Stable => "https://kalcoded.com/releases/updater/stable/${CANDIDATE_VERSION}.json",\nSelf::Beta => "https://kalcoded.com/releases/updater/beta.json",`,
    },
  };
}

test("baseline source validator permits only canonical version authorities and the exact candidate selector", () => {
  assert.deepEqual(validateBaselineSourceSnapshot(sourceSnapshot()), []);
  for (const mutate of [
    (snapshot) => (snapshot.baselineVersion = CANDIDATE_VERSION),
    (snapshot) => (snapshot.baselineFiles["apps/desktop/package.json"] = JSON.stringify({ version: "1.2.1" })),
    (snapshot) =>
      (snapshot.baselineFiles["crates/updater/src/lib.rs"] = snapshot.baselineFiles[
        "crates/updater/src/lib.rs"
      ].replace(`${CANDIDATE_VERSION}.json`, "stable.json")),
    (snapshot) => (snapshot.baselineFiles["crates/updater/src/lib.rs"] += "\npub const TEST_HOOKS: bool = true;"),
    (snapshot) => (snapshot.baselineFiles["Cargo.lock"] += "\n# broadened change"),
    (snapshot) => (snapshot.changedFiles = [...Object.keys(snapshot.baselineFiles), "crates/updater/src/tests.rs"]),
  ]) {
    const snapshot = structuredClone(sourceSnapshot());
    mutate(snapshot);
    assert.notDeepEqual(validateBaselineSourceSnapshot(snapshot), []);
  }
});

function release(version, byte, commit) {
  const updaterBytes = Buffer.from(byte);
  const downloadBytes = Buffer.from(`${byte}-download`);
  const updaterSha = createHash("sha256").update(updaterBytes).digest("hex");
  const downloadSha = createHash("sha256").update(downloadBytes).digest("hex");
  const candidate = {
    channel: "stable",
    version,
    updaterDescriptorKey: `releases/updater/stable/${version}/${updaterSha}.json`,
    downloadDescriptorKey: `releases/${version}/${downloadSha}.json`,
    updaterDescriptorSha256: updaterSha,
    downloadDescriptorSha256: downloadSha,
    publishedAt: "2026-09-26T12:00:00.000Z",
  };
  return {
    version,
    commit,
    candidate,
    objects: [
      { key: candidate.updaterDescriptorKey, sha256: updaterSha, bytes: updaterBytes },
      { key: candidate.downloadDescriptorKey, sha256: downloadSha, bytes: downloadBytes },
    ],
  };
}

function pointerRow(version = "1.2.1", byte = "pointer") {
  const candidate = release(version, byte, "a".repeat(40)).candidate;
  return {
    channel: candidate.channel,
    version: candidate.version,
    precedence_key: semverPrecedenceKey(candidate.version),
    updater_descriptor_key: candidate.updaterDescriptorKey,
    download_descriptor_key: candidate.downloadDescriptorKey,
    updater_descriptor_sha256: candidate.updaterDescriptorSha256,
    download_descriptor_sha256: candidate.downloadDescriptorSha256,
    published_at: candidate.publishedAt,
  };
}

function remoteFixture(pointer = pointerRow()) {
  const objects = new Map();
  const versions = new Map();
  let currentPointer = structuredClone(pointer);
  return {
    objects,
    versions,
    setPointer(value) {
      currentPointer = structuredClone(value);
    },
    async readPointer() {
      return currentPointer === null ? [] : [structuredClone(currentPointer)];
    },
    async readVersion(_channel, version) {
      return versions.has(version) ? [structuredClone(versions.get(version))] : [];
    },
    async readObject(key) {
      return objects.get(key) ?? null;
    },
    async putObject(object) {
      objects.set(object.key, Buffer.from(object.bytes));
    },
    async claimVersion(candidate) {
      const row = {
        channel: candidate.channel,
        version: candidate.version,
        precedence_key: candidate.precedenceKey,
        updater_descriptor_key: candidate.updaterDescriptorKey,
        download_descriptor_key: candidate.downloadDescriptorKey,
        updater_descriptor_sha256: candidate.updaterDescriptorSha256,
        download_descriptor_sha256: candidate.downloadDescriptorSha256,
        published_at: candidate.publishedAt,
      };
      versions.set(candidate.version, row);
      return [structuredClone(row)];
    },
    async readPublicVersion(candidate) {
      return objects.get(candidate.updaterDescriptorKey) ?? null;
    },
  };
}

test("stage plan contains immutable content-addressed objects and no mutable pointer key", () => {
  const plan = buildUpdaterQaStagePlan({
    bucket: "kalcode-releases",
    version: CANDIDATE_VERSION,
    channel: "stable",
    artifacts: [
      {
        target: "windows-x86_64",
        file: `KalCode_${CANDIDATE_VERSION}_x64-setup.exe`,
        artifactPath: "candidate.exe",
        signaturePath: "candidate.exe.sig",
        artifactSha256: "a".repeat(64),
        signatureSha256: "b".repeat(64),
      },
    ],
    downloadManifestPath: "latest.json",
    updaterManifestPath: "stable.json",
    updaterDescriptorSha256: "c".repeat(64),
    downloadDescriptorSha256: "d".repeat(64),
  });
  assert.ok(plan.length > 0);
  assert.equal(
    plan.some(({ key }) => /(?:latest|stable)\.json$/.test(key)),
    false,
  );
  assert.equal(
    plan.every(({ argv }) => argv.includes("public, max-age=31536000, immutable")),
    true,
  );
});

test("upload sink derives exact immutable Wrangler arguments and rejects caller command authority", async () => {
  const sha256 = "a".repeat(64);
  const path = resolve("candidate.exe");
  assert.deepEqual(
    canonicalQaObjectPutArguments({
      key: `releases/${CANDIDATE_VERSION}/${sha256}/KalCode_${CANDIDATE_VERSION}_x64-setup.exe`,
      path,
      sha256,
      size: 1,
    }),
    [
      "r2",
      "object",
      "put",
      `kalcode-releases/releases/${CANDIDATE_VERSION}/${sha256}/KalCode_${CANDIDATE_VERSION}_x64-setup.exe`,
      "--file",
      path,
      "--content-type",
      "application/vnd.microsoft.portable-executable",
      "--content-disposition",
      `attachment; filename="KalCode_${CANDIDATE_VERSION}_x64-setup.exe"`,
      "--cache-control",
      "public, max-age=31536000, immutable",
    ],
  );
  const signatureSha256 = "b".repeat(64);
  const signaturePath = resolve("candidate.exe.windows-x86_64.sig");
  assert.deepEqual(
    canonicalQaObjectPutArguments({
      key: `releases/updater/stable/${CANDIDATE_VERSION}/${sha256}/${signatureSha256}/candidate.exe.sig`,
      path: signaturePath,
      sha256: signatureSha256,
      size: 1,
    }),
    [
      "r2",
      "object",
      "put",
      `kalcode-releases/releases/updater/stable/${CANDIDATE_VERSION}/${sha256}/${signatureSha256}/candidate.exe.sig`,
      "--file",
      signaturePath,
      "--content-type",
      "text/plain; charset=utf-8",
      "--cache-control",
      "public, max-age=31536000, immutable",
    ],
  );
  assert.throws(
    () =>
      canonicalQaObjectPutArguments({
        key: `releases/${CANDIDATE_VERSION}/${sha256}/candidate.exe`,
        path,
        sha256,
        size: 1,
        argv: ["r2", "object", "put", "kalcode-releases/releases/updater/beta.json"],
      }),
    /upload path is invalid/,
  );

  const baseline = release(BASELINE_VERSION, "3", BASELINE_COMMIT);
  const candidate = release(CANDIDATE_VERSION, "5", CANDIDATE_COMMIT);
  candidate.objects[0].argv = ["r2", "object", "put", "kalcode-releases/releases/updater/dev.json"];
  const pointer = pointerRow();
  const receipt = createQaStageReceipt({ baseline, candidate, pointerRows: [pointer] });
  const remote = remoteFixture(pointer);
  let puts = 0;
  remote.putObject = async () => {
    puts += 1;
  };
  await assert.rejects(runQaStagePublication({ baseline, candidate, receipt, remote }), /object plan is invalid/);
  assert.equal(puts, 0);
});

test("QA version claim is atomically guarded by the exact read-only pointer snapshot", () => {
  const candidate = release(CANDIDATE_VERSION, "5", CANDIDATE_COMMIT).candidate;
  const empty = buildQaVersionClaimStatement(candidate, null);
  assert.match(empty, /INSERT INTO release_publication_versions/);
  assert.match(empty, /NOT EXISTS \(SELECT 1 FROM release_publication_pointers/);
  assert.doesNotMatch(empty, /UPDATE SET|INSERT INTO release_publication_pointers/);
  const prior = pointerRow();
  const guarded = buildQaVersionClaimStatement(candidate, prior);
  assert.match(guarded, /EXISTS \(SELECT 1 FROM release_publication_pointers/);
  assert.match(guarded, /version = '1\.2\.1'/);
  assert.match(guarded, /JOIN release_publication_versions/);
  assert.match(guarded, new RegExp(prior.updater_descriptor_sha256));
  assert.match(guarded, new RegExp(prior.download_descriptor_sha256));
  const changedAuthority = pointerRow("1.2.1", "changed-authority");
  const changedGuard = buildQaVersionClaimStatement(candidate, changedAuthority);
  assert.notEqual(changedGuard, guarded);
  assert.match(changedGuard, new RegExp(changedAuthority.updater_descriptor_sha256));
  assert.throws(() => buildQaVersionClaimStatement(candidate, { ...prior, precedence_key: "wrong" }), /precedence/);
});

test("staging claims only immutable versions, supports receipt-authorized partial resume, and preserves Stable", async () => {
  const baseline = release(BASELINE_VERSION, "3", BASELINE_COMMIT);
  const candidate = release(CANDIDATE_VERSION, "5", CANDIDATE_COMMIT);
  const pointer = pointerRow();
  const receipt = createQaStageReceipt({ baseline, candidate, pointerRows: [pointer] });
  const remote = remoteFixture(pointer);
  remote.objects.set(baseline.objects[0].key, Buffer.from(baseline.objects[0].bytes));

  const result = await runQaStagePublication({ baseline, candidate, receipt, remote });
  assert.deepEqual(result.pointerRows, [pointer]);
  assert.equal(remote.versions.size, 2);
  assert.equal(remote.objects.size, 4);
  assert.deepEqual(exactPublicationRowProblems(remote.versions.get(BASELINE_VERSION), baseline.candidate), []);
  assert.deepEqual(exactPublicationRowProblems(remote.versions.get(CANDIDATE_VERSION), candidate.candidate), []);
  const resumed = await runQaStagePublication({ baseline, candidate, receipt, remote });
  assert.deepEqual(resumed.pointerRows, [pointer]);
  assert.equal(remote.versions.size, 2);
});

test("staging a new private pair leaves unrelated burned immutable versions untouched and unread", async () => {
  // B10 shape: stable/0.1.4 and stable/0.1.5 are already claimed (burned, never pointed); the new
  // pair is a lower derived baseline (0.1.3) and a newer candidate (0.1.6), staged with no pointer.
  const burned = [release("0.1.4", "burned-4", "d".repeat(40)), release("0.1.5", "burned-5", "e".repeat(40))];
  const baseline = release("0.1.3", "3", BASELINE_COMMIT);
  const candidate = release("0.1.6", "6", CANDIDATE_COMMIT);
  const remote = remoteFixture(null);
  const burnedRows = new Map();
  for (const old of burned) {
    const [row] = await remote.claimVersion({ ...old.candidate, precedenceKey: semverPrecedenceKey(old.version) });
    burnedRows.set(old.version, row);
  }
  const reads = [];
  const readVersion = remote.readVersion;
  remote.readVersion = async (channel, version) => {
    reads.push(version);
    return readVersion(channel, version);
  };
  const receipt = createQaStageReceipt({ baseline, candidate, pointerRows: [] });
  const result = await runQaStagePublication({ baseline, candidate, receipt, remote });
  assert.deepEqual(result.pointerRows, []);
  assert.deepEqual(result.versions, ["0.1.3", "0.1.6"]);
  assert.deepEqual([...new Set(reads)].sort(), ["0.1.3", "0.1.6"]);
  assert.deepEqual([...remote.versions.keys()].sort(), ["0.1.3", "0.1.4", "0.1.5", "0.1.6"]);
  for (const [version, row] of burnedRows) assert.deepEqual(remote.versions.get(version), row);

  // A pre-existing row for the new candidate version without the exact receipt still refuses.
  const squatted = remoteFixture(null);
  await squatted.claimVersion({ ...candidate.candidate, precedenceKey: semverPrecedenceKey(candidate.version) });
  await assert.rejects(
    runQaStagePublication({ baseline, candidate, receipt: null, remote: squatted }),
    /durable receipt/,
  );
});

test("staging fails closed for unreceipted collisions, byte mismatch, and pointer races", async () => {
  const baseline = release(BASELINE_VERSION, "3", BASELINE_COMMIT);
  const candidate = release(CANDIDATE_VERSION, "5", CANDIDATE_COMMIT);
  const pointer = pointerRow();

  const collision = remoteFixture(pointer);
  collision.objects.set(baseline.objects[0].key, Buffer.from(baseline.objects[0].bytes));
  await assert.rejects(
    runQaStagePublication({ baseline, candidate, receipt: null, remote: collision }),
    /durable receipt/,
  );

  const mismatch = remoteFixture(pointer);
  const receipt = createQaStageReceipt({ baseline, candidate, pointerRows: [pointer] });
  mismatch.objects.set(baseline.objects[0].key, Buffer.from("different"));
  await assert.rejects(runQaStagePublication({ baseline, candidate, receipt, remote: mismatch }), /different bytes/);

  const rowConflict = remoteFixture(pointer);
  rowConflict.versions.set(BASELINE_VERSION, {
    channel: "stable",
    version: BASELINE_VERSION,
    precedence_key: "wrong",
    updater_descriptor_key: "wrong",
  });
  await assert.rejects(runQaStagePublication({ baseline, candidate, receipt, remote: rowConflict }), /different/);

  const raced = remoteFixture(pointer);
  const claim = raced.claimVersion;
  raced.claimVersion = async (value) => {
    const result = await claim(value);
    raced.setPointer({ channel: "stable", version: "9.9.9", precedence_key: "race" });
    return result;
  };
  await assert.rejects(runQaStagePublication({ baseline, candidate, receipt, remote: raced }), /pointer changed/);
});

test("receipt creation is exclusive and exact resume cannot mutate publication identity", () => {
  const dir = mkdtempSync(join(tmpdir(), "kalcode-updater-qa-receipt-"));
  const path = join(dir, "receipt.json");
  const pointer = pointerRow();
  const receipt = createQaStageReceipt({
    baseline: release(BASELINE_VERSION, "3", BASELINE_COMMIT),
    candidate: release(CANDIDATE_VERSION, "5", CANDIDATE_COMMIT),
    pointerRows: [pointer],
  });
  assert.equal(writeQaStageReceipt(path, receipt), "created");
  assert.equal(writeQaStageReceipt(path, structuredClone(receipt)), "reused");
  const changed = structuredClone(receipt);
  changed.candidate.commit = "9".repeat(40);
  assert.throws(() => writeQaStageReceipt(path, changed), /does not match/);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).candidate.commit, CANDIDATE_COMMIT);
});

test("CLI requires explicit safe mode and absolute independent inputs", () => {
  const root = resolve("C:/qa");
  const argv = [
    "--baseline-source",
    join(root, "baseline-source"),
    "--baseline-staging",
    join(root, "baseline-stage"),
    "--candidate-source",
    join(root, "candidate-source"),
    "--candidate-staging",
    join(root, "candidate-stage"),
    "--receipt",
    join(root, "receipt.json"),
    "--dry-run",
  ];
  assert.equal(parseQaStageArguments(argv).mode, "dry-run");
  assert.throws(() => parseQaStageArguments(argv.slice(0, -1)), /explicit/);
  assert.throws(() => parseQaStageArguments([...argv, "--remote"]), /mutually exclusive/);
  assert.throws(() => parseQaStageArguments(argv.with(1, "relative")), /absolute/);
  assert.equal(
    parseQaStageArguments([...argv, "--approved-tool-commit", "a".repeat(40)]).approvedToolCommit,
    "a".repeat(40),
  );
  for (const value of ["a".repeat(12), "G".repeat(40), "", "--remote"]) {
    assert.throws(() => parseQaStageArguments([...argv, "--approved-tool-commit", value]));
  }
  assert.throws(
    () =>
      parseQaStageArguments([
        ...argv,
        "--approved-tool-commit",
        "a".repeat(40),
        "--approved-tool-commit",
        "a".repeat(40),
      ]),
    /exactly once/,
  );
});

function toolAuthority() {
  return {
    toolCommit: "a".repeat(40),
    productCommit: CANDIDATE_COMMIT,
    candidateNotesCommit: "b".repeat(40),
    baselineQaSha256: { "windows-x86_64": "c".repeat(64), "darwin-aarch64": "d".repeat(64) },
  };
}

test("separate tool receipt binds source and baseline observation identities and resumes exactly", async () => {
  const baseline = release(BASELINE_VERSION, "3", BASELINE_COMMIT);
  const candidate = release(CANDIDATE_VERSION, "5", CANDIDATE_COMMIT);
  const pointerRows = [pointerRow()];
  const sourceAuthority = toolAuthority();
  const receipt = createQaStageReceipt({ baseline, candidate, pointerRows, sourceAuthority });
  assert.equal(receipt.schemaVersion, 2);
  assert.deepEqual(receipt.sourceAuthority, sourceAuthority);
  const legacy = createQaStageReceipt({ baseline, candidate, pointerRows, createdAt: receipt.createdAt });
  assert.equal(legacy.schemaVersion, 1);
  assert.equal(legacy.sourceAuthority, undefined);
  assert.notEqual(legacy.planSha256, receipt.planSha256);
  const remote = remoteFixture(pointerRows[0]);
  await runQaStagePublication({ baseline, candidate, receipt, sourceAuthority, remote });
  await runQaStagePublication({ baseline, candidate, receipt, sourceAuthority, remote });
  for (const mutate of [
    (a) => {
      a.toolCommit = "e".repeat(40);
    },
    (a) => {
      a.productCommit = "e".repeat(40);
    },
    (a) => {
      a.candidateNotesCommit = "e".repeat(40);
    },
    (a) => {
      a.baselineQaSha256["windows-x86_64"] = "e".repeat(64);
    },
    (a) => {
      a.baselineQaSha256["darwin-aarch64"] = "e".repeat(64);
    },
  ]) {
    const changed = structuredClone(sourceAuthority);
    mutate(changed);
    await assert.rejects(
      runQaStagePublication({ baseline, candidate, receipt, sourceAuthority: changed, remote }),
      /authority|receipt/,
    );
  }
  await assert.rejects(runQaStagePublication({ baseline, candidate, receipt, remote }), /receipt/);
  await assert.rejects(
    runQaStagePublication({ baseline, candidate, receipt: legacy, sourceAuthority, remote }),
    /receipt/,
  );
});

test("tool receipts reject incomplete, substituted, and extra authority fields before writes", () => {
  const baseline = release(BASELINE_VERSION, "3", BASELINE_COMMIT);
  const candidate = release(CANDIDATE_VERSION, "5", CANDIDATE_COMMIT);
  for (const mutate of [
    (a) => {
      delete a.toolCommit;
    },
    (a) => {
      a.toolCommit = "short";
    },
    (a) => {
      a.productCommit = "e".repeat(40);
    },
    (a) => {
      delete a.baselineQaSha256["darwin-aarch64"];
    },
    (a) => {
      a.baselineQaSha256["windows-x86_64"] = "short";
    },
    (a) => {
      a.baselineQaSha256.extra = "e".repeat(64);
    },
    (a) => {
      a.unreviewed = true;
    },
  ]) {
    const sourceAuthority = toolAuthority();
    mutate(sourceAuthority);
    assert.throws(() => createQaStageReceipt({ baseline, candidate, pointerRows: [], sourceAuthority }), /authority/);
  }
});

test("stage executable has no pointer-write or mutable-feed publication capability", () => {
  const source = readFileSync(join(import.meta.dirname, "stage-updater-qa.mjs"), "utf8");
  assert.doesNotMatch(source, /buildPointerAdvanceStatement|buildInitialPointerStatement/);
  assert.doesNotMatch(source, /release_publication_pointers\s*(?:\)|,)\s*(?:VALUES|SELECT)/i);
  assert.match(source, /buildQaVersionClaimStatement/);
  assert.match(source, /Stable pointer changed/);
});
