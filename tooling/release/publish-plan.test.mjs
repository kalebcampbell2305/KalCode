import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  boundedJsonFetch,
  buildInitialPointerStatement,
  buildPointerAdvanceStatement,
  buildPointerReadStatement,
  buildVersionClaimStatement,
  buildVersionReadStatement,
  completeBootstrapAuthority,
  decideBootstrapPointerAction,
  parseD1Rows,
  pointerAdvanceProblems,
  publicationRowProblems,
  resolvePublicationState,
  semverPrecedenceKey,
} from "./publication-safety.mjs";
import {
  buildPublishPlan,
  isMissingR2Object,
  parsePublishMode,
  publishedUpdaterProblems,
  updaterKeys,
} from "./publish-plan.mjs";

const input = {
  bucket: "kalcode-downloads",
  version: "1.2.3",
  channel: "stable",
  installerFile: "KalCode_1.2.3_x64-setup.exe",
  installerPath: "C:\\stage\\KalCode_1.2.3_x64-setup.exe",
  signaturePath: "C:\\stage\\KalCode_1.2.3_x64-setup.exe.sig",
  downloadManifestPath: "C:\\stage\\latest.json",
  updaterManifestPath: "C:\\stage\\stable.json",
  artifactSha256: "a".repeat(64),
  signatureSha256: "b".repeat(64),
  updaterDescriptorSha256: "c".repeat(64),
  downloadDescriptorSha256: "d".repeat(64),
};

test("publish modes reject typos, duplicates, conflicting modes, and removed bypasses", () => {
  assert.equal(parsePublishMode([]), "remote");
  assert.equal(parsePublishMode(["--dry-run"]), "dry-run");
  assert.equal(parsePublishMode(["--local"]), "local");
  assert.equal(parsePublishMode(["--bootstrap-authority"]), "bootstrap");
  assert.throws(() => parsePublishMode(["--dryrun"]), /unknown/);
  assert.throws(() => parsePublishMode(["--local", "--local"]), /only once/);
  assert.throws(() => parsePublishMode(["--bootstrap-authority", "--bootstrap-authority"]), /only once/);
  assert.throws(() => parsePublishMode(["--local", "--dry-run"]), /mutually exclusive/);
  assert.throws(() => parsePublishMode(["--local", "--bootstrap-authority"]), /mutually exclusive/);
  assert.throws(() => parsePublishMode(["--without-install-test"]), /was removed/);
});

test("bootstrap resumes from clean N after an exact manifest write and formatter failure", (context) => {
  const migration = readFileSync(
    new URL("../../apps/website/migrations/0003_release_publication_pointers.sql", import.meta.url),
    "utf8",
  );
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(migration);
  const candidate = Object.freeze({
    channel: "stable",
    version: "1.2.3",
    updaterDescriptorKey: `releases/updater/stable/1.2.3/${"a".repeat(64)}.json`,
    downloadDescriptorKey: `releases/1.2.3/${"b".repeat(64)}.json`,
    updaterDescriptorSha256: "a".repeat(64),
    downloadDescriptorSha256: "b".repeat(64),
    publishedAt: "2026-09-25T12:00:00.000Z",
  });
  const frozenCandidate = JSON.stringify(candidate);
  const recoveryRoot = mkdtempSync(join(tmpdir(), "kalcode-bootstrap-recovery-"));
  context.after(() => rmSync(recoveryRoot, { recursive: true, force: true }));
  const failedWorkspaceManifest = join(recoveryRoot, "failed-workspace", "releases.json");
  const partialWorkspaceManifest = join(recoveryRoot, "partial-workspace", "releases.json");
  const freshWorkspaceManifest = join(recoveryRoot, "fresh-workspace", "releases.json");
  for (const directory of ["failed-workspace", "partial-workspace", "fresh-workspace"]) {
    mkdirSync(join(recoveryRoot, directory));
  }
  const execute = (statement) => db.prepare(statement).all();
  let pointerReads = 0;
  const readPointer = () => {
    pointerReads += 1;
    return execute(buildPointerReadStatement(candidate.channel));
  };
  const events = [];
  let pointerWrites = 0;
  let manifestWrites = 0;

  const attempt = ({ failure, manifestPath }) => {
    const action = decideBootstrapPointerAction(readPointer(), candidate);
    events.push(`${action}:immutable-readback`);
    const claimed = execute(buildVersionClaimStatement(candidate));
    const versionRows =
      claimed.length > 0 ? claimed : execute(buildVersionReadStatement(candidate.channel, candidate.version));
    assert.deepEqual(publicationRowProblems(versionRows[0], candidate), []);
    events.push(`${action}:version-claim`);
    return completeBootstrapAuthority({
      action,
      candidate,
      initializePointer:
        action === "initialize"
          ? () => {
              pointerWrites += 1;
              return execute(buildInitialPointerStatement(candidate));
            }
          : undefined,
      readPointer,
      writeManifest: () => {
        manifestWrites += 1;
        if (failure === "partial-write") {
          writeFileSync(manifestPath, '{"schemaVersion":', "utf8");
          throw new Error("simulated manifest disk write failure");
        }
        writeFileSync(manifestPath, `${JSON.stringify(candidate, null, 2)}\n`, "utf8");
        if (failure === "formatter") throw new Error("simulated manifest formatter failure");
        events.push(`${action}:manifest-write`);
      },
    });
  };

  assert.throws(
    () => attempt({ failure: "formatter", manifestPath: failedWorkspaceManifest }),
    /simulated manifest formatter failure/,
  );
  assert.equal(pointerWrites, 1);
  assert.equal(readPointer().length, 1);
  assert.deepEqual(JSON.parse(readFileSync(failedWorkspaceManifest, "utf8")), candidate);
  const readsBeforeRetry = pointerReads;
  assert.throws(
    () => attempt({ failure: "partial-write", manifestPath: partialWorkspaceManifest }),
    /simulated manifest disk write failure/,
  );
  assert.equal(pointerReads - readsBeforeRetry, 2, "resume must preflight and then re-read the exact pointer");
  assert.equal(readFileSync(partialWorkspaceManifest, "utf8"), '{"schemaVersion":');
  const readsBeforeFreshRetry = pointerReads;
  assert.doesNotThrow(() => attempt({ failure: null, manifestPath: freshWorkspaceManifest }));
  assert.equal(pointerReads - readsBeforeFreshRetry, 2, "fresh retry must re-prove the exact pointer");
  assert.equal(pointerWrites, 1, "an exact bootstrap retry must not mutate the existing pointer");
  assert.equal(manifestWrites, 3);
  assert.deepEqual(events, [
    "initialize:immutable-readback",
    "initialize:version-claim",
    "resume:immutable-readback",
    "resume:version-claim",
    "resume:immutable-readback",
    "resume:version-claim",
    "resume:manifest-write",
  ]);
  assert.deepEqual(JSON.parse(readFileSync(freshWorkspaceManifest, "utf8")), candidate);
  assert.deepEqual(publicationRowProblems(readPointer()[0], candidate), []);
  assert.equal(JSON.stringify(candidate), frozenCandidate, "the frozen publication identity must remain unchanged");
});

test("bootstrap rejects every non-exact existing pointer before publication effects", () => {
  const candidate = {
    channel: "stable",
    version: "1.2.3",
    updaterDescriptorKey: `releases/updater/stable/1.2.3/${"a".repeat(64)}.json`,
    downloadDescriptorKey: `releases/1.2.3/${"b".repeat(64)}.json`,
    updaterDescriptorSha256: "a".repeat(64),
    downloadDescriptorSha256: "b".repeat(64),
    publishedAt: "2026-09-25T12:00:00.000Z",
  };
  const exact = {
    channel: candidate.channel,
    version: candidate.version,
    precedence_key: semverPrecedenceKey(candidate.version),
    updater_descriptor_key: candidate.updaterDescriptorKey,
    download_descriptor_key: candidate.downloadDescriptorKey,
    updater_descriptor_sha256: candidate.updaterDescriptorSha256,
    download_descriptor_sha256: candidate.downloadDescriptorSha256,
    published_at: candidate.publishedAt,
  };
  const conflicts = [
    { ...exact, channel: "beta" },
    { ...exact, version: "1.2.2", precedence_key: semverPrecedenceKey("1.2.2") },
    { ...exact, version: "1.2.4", precedence_key: semverPrecedenceKey("1.2.4") },
    { ...exact, precedence_key: semverPrecedenceKey("1.2.4") },
    { ...exact, updater_descriptor_key: `releases/updater/stable/1.2.3/${"c".repeat(64)}.json` },
    { ...exact, download_descriptor_key: `releases/1.2.3/${"c".repeat(64)}.json` },
    { ...exact, updater_descriptor_sha256: "c".repeat(64) },
    { ...exact, download_descriptor_sha256: "c".repeat(64) },
    { ...exact, published_at: "2026-09-25T12:00:01.000Z" },
    { malformed: true },
  ];
  const effects = { uploads: 0, d1Mutations: 0, manifestWrites: 0 };
  const attempt = (row) => {
    const action = decideBootstrapPointerAction([row], candidate);
    effects.uploads += 1;
    effects.d1Mutations += 1;
    effects.manifestWrites += 1;
    return action;
  };
  for (const row of conflicts) {
    assert.throws(() => attempt(row), /bootstrap/);
    assert.deepEqual(effects, { uploads: 0, d1Mutations: 0, manifestWrites: 0 });
  }
  assert.throws(() => decideBootstrapPointerAction([exact, exact], candidate), /multiple rows/);
  assert.deepEqual(effects, { uploads: 0, d1Mutations: 0, manifestWrites: 0 });
  assert.equal(decideBootstrapPointerAction([], candidate), "initialize");
  assert.equal(decideBootstrapPointerAction([exact], candidate), "resume");
  assert.throws(
    () =>
      completeBootstrapAuthority({
        action: "resume",
        candidate,
        initializePointer: () => [],
        readPointer: () => [exact],
        writeManifest: () => {},
      }),
    /received pointer mutation authority/,
  );
});

test("public upload plan contains only digest-qualified immutable objects", () => {
  const plan = buildPublishPlan({ ...input, includeUpdater: true, includeDownloadDescriptor: true });
  assert.deepEqual(
    plan.map((entry) => entry.name),
    [
      "versioned installer",
      "immutable download descriptor",
      "immutable updater artifact",
      "immutable updater signature",
      "immutable updater version descriptor",
    ],
  );
  assert.deepEqual(updaterKeys("stable", "1.2.3", input.installerFile, input), {
    artifact: `releases/updater/stable/1.2.3/${input.artifactSha256}/${input.installerFile}`,
    signature: `releases/updater/stable/1.2.3/${input.artifactSha256}/${input.signatureSha256}/${input.installerFile}.sig`,
    version: `releases/updater/stable/1.2.3/${input.updaterDescriptorSha256}.json`,
    channel: "releases/updater/stable.json",
  });
  assert.match(plan[1].argv.join(" "), /max-age=31536000, immutable/);
  assert.equal(
    plan.every((entry) => entry.argv.join(" ").includes("max-age=31536000, immutable")),
    true,
  );
  assert.equal(
    plan.some((entry) => entry.key === "releases/latest.json"),
    false,
  );
  assert.equal(
    plan.some((entry) => entry.key === "releases/updater/stable.json"),
    false,
  );
});

test("publish object keys use the same canonical version grammar as public routes", () => {
  assert.throws(() => updaterKeys("stable", "1.2.3+build.1", input.installerFile, input), /canonical SemVer/);
  assert.throws(
    () => buildPublishPlan({ ...input, version: "1.2.3+build.1", includeUpdater: true }),
    /canonical SemVer/,
  );
});

test("unsigned local simulation cannot emit public updater or immutable descriptors", () => {
  const plan = buildPublishPlan({
    ...input,
    includeUpdater: false,
    includeDownloadDescriptor: false,
    includeLocalPointer: true,
  });
  assert.deepEqual(
    plan.map((entry) => entry.name),
    ["versioned installer", "website latest pointer"],
  );
  assert.equal(plan[0].key, `releases/1.2.3/${input.installerFile}`);
  assert.equal(
    plan.some((entry) => entry.key.includes("/updater/")),
    false,
  );
});

test("a verified partial publish skips every already-verified immutable object", () => {
  const plan = buildPublishPlan({
    ...input,
    includeInstaller: false,
    includeUpdater: true,
    includeImmutableUpdater: false,
    includeDownloadDescriptor: false,
  });
  assert.deepEqual(plan, []);
});

test("a remote publish retry reuses the exact publication timestamp and descriptor identity", () => {
  const build = {
    version: "1.2.3",
    commit: "a".repeat(40),
    requestedReleaseChannel: "stable",
    file: input.installerFile,
    size: 42,
    sha256: input.artifactSha256,
    builtAt: "2026-09-25T11:00:00.000Z",
  };
  const first = resolvePublicationState(null, build, "2026-09-25T12:00:00.000Z");
  const resumed = resolvePublicationState(first, build, "2026-09-25T13:00:00.000Z");
  assert.deepEqual(resumed, first);
  assert.equal(resumed.publishedAt, "2026-09-25T12:00:00.000Z");
  assert.throws(
    () => resolvePublicationState({ ...first, sha256: "b".repeat(64) }, build, "2026-09-25T13:00:00.000Z"),
    /does not match the exact build/,
  );
  assert.throws(
    () =>
      resolvePublicationState({ ...first, publishedAt: "2026-09-25T14:00:00.000Z" }, build, "2026-09-25T13:00:00.000Z"),
    /future/,
  );
});

test("different same-version builds cannot target the same immutable R2 keys", () => {
  const first = buildPublishPlan({ ...input, includeUpdater: true, includeDownloadDescriptor: true });
  const second = buildPublishPlan({
    ...input,
    artifactSha256: "e".repeat(64),
    signatureSha256: "f".repeat(64),
    updaterDescriptorSha256: "1".repeat(64),
    downloadDescriptorSha256: "2".repeat(64),
    includeUpdater: true,
    includeDownloadDescriptor: true,
  });
  assert.equal(
    new Set(first.map((entry) => entry.key).filter((key) => second.some((entry) => entry.key === key))).size,
    0,
  );
});

test("an immutable updater version can never be replaced with different bytes", () => {
  const sha = "a".repeat(64);
  assert.deepEqual(publishedUpdaterProblems({ version: "1.2.3", kalcode: { sha256: sha } }, "1.2.3", sha), []);
  assert.match(
    publishedUpdaterProblems({ version: "1.2.3", kalcode: { sha256: "b".repeat(64) } }, "1.2.3", sha)[0],
    /bump the version/,
  );
  assert.match(publishedUpdaterProblems({ version: "1.2.4", kalcode: { sha256: sha } }, "1.2.3", sha)[0], /version/);
});

test("only an explicit R2 missing-object response permits first publication", () => {
  assert.equal(isMissingR2Object("The specified key does not exist [code: 10007]"), true);
  assert.equal(isMissingR2Object("NoSuchKey"), true);
  assert.equal(isMissingR2Object("authentication failed"), false);
  assert.equal(isMissingR2Object("network timeout"), false);
});

test("public manifest probes are time bounded and cancel the request", async () => {
  let observedSignal;
  const fetchImpl = (_url, init) => {
    observedSignal = init.signal;
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    });
  };

  await assert.rejects(
    boundedJsonFetch("https://kalcoded.com/releases/latest.json", {
      fetchImpl,
      timeoutMs: 5,
      maxBytes: 1_024,
    }),
    /timed out/,
  );
  assert.equal(observedSignal.aborted, true);

  await assert.rejects(
    boundedJsonFetch("https://kalcoded.com/releases/latest.json", {
      fetchImpl: () =>
        new Response(
          new ReadableStream({
            pull() {
              return new Promise(() => {});
            },
          }),
          { status: 200 },
        ),
      timeoutMs: 5,
      maxBytes: 1_024,
    }),
    /timed out/,
  );
});

test("public manifest probes bound declared and streamed response bodies", async () => {
  const oversizedHeader = () =>
    new Response("{}", {
      headers: { "content-length": "4097", "content-type": "application/json" },
    });
  await assert.rejects(
    boundedJsonFetch("https://kalcoded.com/releases/latest.json", {
      fetchImpl: oversizedHeader,
      maxBytes: 4_096,
    }),
    /body exceeds/,
  );

  const oversizedStream = () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(3_000));
          controller.enqueue(new Uint8Array(3_000));
          controller.close();
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
  await assert.rejects(
    boundedJsonFetch("https://kalcoded.com/releases/latest.json", {
      fetchImpl: oversizedStream,
      maxBytes: 4_096,
    }),
    /body exceeds/,
  );
});

test("bounded probes return parsed JSON and close non-success bodies", async () => {
  const ok = await boundedJsonFetch("https://kalcoded.com/releases/latest.json", {
    fetchImpl: () => new Response('{"latest":{"version":"1.2.3"}}', { status: 200 }),
  });
  assert.deepEqual(ok, {
    ok: true,
    status: 200,
    value: { latest: { version: "1.2.3" } },
    releaseAuthority: null,
  });

  let cancelled = false;
  const missing = await boundedJsonFetch("https://kalcoded.com/releases/latest.json", {
    fetchImpl: () => ({
      ok: false,
      status: 404,
      body: { cancel: async () => (cancelled = true) },
      headers: new Headers(),
    }),
  });
  assert.deepEqual(missing, { ok: false, status: 404, value: null, releaseAuthority: null });
  assert.equal(cancelled, true);
});

test("mutable pointers cannot regress or reuse a version with different bytes", () => {
  const target = {
    version: "1.4.0",
    downloadSha256: "a".repeat(64),
    updaterSha256: "b".repeat(64),
  };
  assert.deepEqual(
    pointerAdvanceProblems({
      ...target,
      currentLatest: { latest: { version: "1.3.9", platforms: [{ os: "windows", sha256: "c".repeat(64) }] } },
      currentUpdater: { version: "1.3.9", kalcode: { sha256: "d".repeat(64) } },
    }),
    [],
  );
  assert.match(
    pointerAdvanceProblems({
      ...target,
      currentLatest: { latest: { version: "1.5.0", platforms: [{ os: "windows", sha256: "c".repeat(64) }] } },
      currentUpdater: null,
    })[0],
    /newer version/,
  );
  assert.match(
    pointerAdvanceProblems({
      ...target,
      currentLatest: { latest: { version: "1.4.0", platforms: [{ os: "windows", sha256: "c".repeat(64) }] } },
      currentUpdater: { version: "1.4.0", kalcode: { sha256: target.updaterSha256 } },
    })[0],
    /different installer/,
  );
  assert.match(
    pointerAdvanceProblems({
      ...target,
      currentLatest: { latest: { version: "1.4.0", platforms: [{ os: "windows", sha256: target.downloadSha256 }] } },
      currentUpdater: { version: "1.4.0", kalcode: { sha256: "e".repeat(64) } },
    })[0],
    /different updater/,
  );
});

test("D1 pointer advance is an atomic monotonic compare-and-set", () => {
  assert.ok(semverPrecedenceKey("1.2.4") > semverPrecedenceKey("1.2.3"));
  assert.ok(semverPrecedenceKey("1.2.3") > semverPrecedenceKey("1.2.3-rc.9"));
  assert.ok(semverPrecedenceKey("1.2.3-rc.10") > semverPrecedenceKey("1.2.3-rc.9"));
  assert.ok(semverPrecedenceKey("1.2.3-rc.1") > semverPrecedenceKey("1.2.3-beta.99"));
  assert.ok(
    semverPrecedenceKey("123456789012345678901234567890.0.0") >
      semverPrecedenceKey("99999999999999999999999999999.999999999999999999999999.999999999999999999999999"),
  );
  assert.throws(() => semverPrecedenceKey("1.2.3+build.1"), /canonical SemVer/);

  const candidate = {
    channel: "stable",
    version: "1.2.3",
    updaterDescriptorKey: `releases/updater/stable/1.2.3/${"a".repeat(64)}.json`,
    downloadDescriptorKey: `releases/1.2.3/${"b".repeat(64)}.json`,
    updaterDescriptorSha256: "a".repeat(64),
    downloadDescriptorSha256: "b".repeat(64),
    publishedAt: "2026-09-25T12:00:00.000Z",
  };
  const claim = buildVersionClaimStatement(candidate);
  assert.match(claim, /INSERT INTO release_publication_versions/);
  assert.match(claim, /WHERE NOT EXISTS/);
  assert.match(claim, /release_publication_pointers\.precedence_key > /);
  assert.match(claim, /ON CONFLICT\(channel, version\) DO NOTHING/);
  assert.match(claim, /updater_descriptor_sha256/);

  const statement = buildPointerAdvanceStatement(candidate);
  assert.match(statement, /INSERT INTO release_publication_pointers/);
  assert.match(statement, /SELECT .* WHERE NOT EXISTS/);
  assert.match(statement, /ON CONFLICT\(channel\) DO UPDATE/);
  assert.match(statement, /release_publication_pointers\.precedence_key < excluded\.precedence_key/);
  assert.match(statement, /release_publication_pointers\.version = excluded\.version/);
  assert.match(statement, /RETURNING channel, version, precedence_key/);
  assert.match(buildPointerReadStatement("stable"), /versions\.precedence_key = pointers\.precedence_key/);

  assert.deepEqual(parseD1Rows('[{"success":true,"results":[{"version":"1.2.3"}]}]'), [{ version: "1.2.3" }]);
  assert.throws(() => parseD1Rows('[{"success":false,"results":[]}]'), /D1 pointer operation failed/);
  assert.throws(() =>
    buildPointerAdvanceStatement({
      channel: "stable'; DROP TABLE x;--",
      version: "1.2.3",
      updaterDescriptorKey: `releases/updater/stable/1.2.3/${"a".repeat(64)}.json`,
      downloadDescriptorKey: `releases/1.2.3/${"b".repeat(64)}.json`,
      updaterDescriptorSha256: "a".repeat(64),
      downloadDescriptorSha256: "b".repeat(64),
      publishedAt: "2026-09-25T12:00:00.000Z",
    }),
  );

  const exactRow = {
    channel: candidate.channel,
    version: candidate.version,
    precedence_key: semverPrecedenceKey(candidate.version),
    updater_descriptor_key: candidate.updaterDescriptorKey,
    download_descriptor_key: candidate.downloadDescriptorKey,
    updater_descriptor_sha256: candidate.updaterDescriptorSha256,
    download_descriptor_sha256: candidate.downloadDescriptorSha256,
    published_at: candidate.publishedAt,
  };
  assert.deepEqual(publicationRowProblems(exactRow, candidate), []);
  assert.match(
    publicationRowProblems(
      { ...exactRow, version: "1.2.4", precedence_key: semverPrecedenceKey("1.2.4") },
      candidate,
    )[0],
    /newer version/,
  );
  assert.match(
    publicationRowProblems({ ...exactRow, updater_descriptor_sha256: "c".repeat(64) }, candidate)[0],
    /different immutable descriptors/,
  );
});

test("release publication migration keeps immutable versions separate from the channel pointer", () => {
  const migration = readFileSync(
    new URL("../../apps/website/migrations/0003_release_publication_pointers.sql", import.meta.url),
    "utf8",
  );
  assert.match(migration, /CREATE TABLE release_publication_versions/);
  assert.match(migration, /PRIMARY KEY \(channel, version\)/);
  assert.match(migration, /CREATE TABLE release_publication_pointers/);
  assert.match(migration, /UNIQUE \(channel, version, precedence_key\)/);
  assert.match(migration, /FOREIGN KEY \(channel, version, precedence_key\)/);
  assert.match(migration, /updater_descriptor_key =/);
  assert.match(migration, /download_descriptor_key =/);
  assert.match(migration, /release_publication_versions_no_update/);
  assert.match(migration, /release_publication_versions_no_delete/);
  assert.match(migration, /release_publication_pointers_no_regression/);
  assert.match(migration, /release_publication_pointers_match_version_insert/);
  assert.match(migration, /release_publication_pointers_match_version_update/);
  assert.match(migration, /release_publication_pointers_no_regression_insert/);
  assert.match(migration, /NEW\.precedence_key < OLD\.precedence_key/);
  assert.match(migration, /release_publication_pointers_no_delete/);
});

test("SQLite enforces immutable archives and monotonic channel movement", () => {
  const migration = readFileSync(
    new URL("../../apps/website/migrations/0003_release_publication_pointers.sql", import.meta.url),
    "utf8",
  );
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(migration);
  const candidate = {
    channel: "stable",
    version: "1.2.3",
    updaterDescriptorKey: `releases/updater/stable/1.2.3/${"a".repeat(64)}.json`,
    downloadDescriptorKey: `releases/1.2.3/${"b".repeat(64)}.json`,
    updaterDescriptorSha256: "a".repeat(64),
    downloadDescriptorSha256: "b".repeat(64),
    publishedAt: "2026-09-25T12:00:00.000Z",
  };
  assert.equal(db.prepare(buildVersionClaimStatement(candidate)).all().length, 1);
  assert.equal(db.prepare(buildPointerAdvanceStatement(candidate)).all().length, 1);

  const newer = {
    ...candidate,
    version: "1.2.4",
    updaterDescriptorKey: `releases/updater/stable/1.2.4/${"7".repeat(64)}.json`,
    downloadDescriptorKey: `releases/1.2.4/${"8".repeat(64)}.json`,
    updaterDescriptorSha256: "7".repeat(64),
    downloadDescriptorSha256: "8".repeat(64),
  };
  assert.equal(db.prepare(buildVersionClaimStatement(newer)).all().length, 1);
  assert.equal(db.prepare(buildPointerAdvanceStatement(newer)).all().length, 1);
  assert.equal(db.prepare(buildPointerReadStatement("stable")).get().version, "1.2.4");
  for (const forgedPrecedenceKey of [semverPrecedenceKey(newer.version), semverPrecedenceKey("999.0.0")]) {
    assert.throws(
      () =>
        db
          .prepare(
            "UPDATE release_publication_pointers SET version = '1.2.3', precedence_key = ? WHERE channel = 'stable'",
          )
          .run(forgedPrecedenceKey),
      /immutable version|FOREIGN KEY|equal precedence/,
    );
    assert.equal(db.prepare(buildPointerReadStatement("stable")).get().version, "1.2.4");
  }
  const forgedUpsert = db.prepare(
    "INSERT INTO release_publication_pointers (channel, version, precedence_key, updated_at) VALUES ('stable', ?, ?, unixepoch()) ON CONFLICT(channel) DO UPDATE SET version = excluded.version, precedence_key = excluded.precedence_key, updated_at = excluded.updated_at WHERE release_publication_pointers.precedence_key < excluded.precedence_key OR release_publication_pointers.version = excluded.version RETURNING version",
  );
  assert.throws(
    () => forgedUpsert.all("0.0.1", semverPrecedenceKey(newer.version)),
    /immutable version|FOREIGN KEY|equal precedence/,
  );
  assert.throws(() => forgedUpsert.all("0.0.1", semverPrecedenceKey("999.0.0")), /immutable version|FOREIGN KEY/);
  assert.equal(db.prepare(buildPointerReadStatement("stable")).get().version, "1.2.4");

  const stale = {
    ...candidate,
    version: "1.2.2",
    updaterDescriptorKey: `releases/updater/stable/1.2.2/${"c".repeat(64)}.json`,
    downloadDescriptorKey: `releases/1.2.2/${"d".repeat(64)}.json`,
    updaterDescriptorSha256: "c".repeat(64),
    downloadDescriptorSha256: "d".repeat(64),
  };
  assert.equal(db.prepare(buildVersionClaimStatement(stale)).all().length, 0);
  assert.equal(db.prepare(buildPointerAdvanceStatement(stale)).all().length, 0);
  assert.equal(db.prepare(buildPointerReadStatement("stable")).get().version, "1.2.4");

  const equalPrecedenceVersion = "1.2.4-replacement";
  db.prepare(
    "INSERT INTO release_publication_versions (channel, version, precedence_key, updater_descriptor_key, download_descriptor_key, updater_descriptor_sha256, download_descriptor_sha256, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    candidate.channel,
    equalPrecedenceVersion,
    semverPrecedenceKey(newer.version),
    `releases/updater/stable/${equalPrecedenceVersion}/${"e".repeat(64)}.json`,
    `releases/${equalPrecedenceVersion}/${"f".repeat(64)}.json`,
    "e".repeat(64),
    "f".repeat(64),
    candidate.publishedAt,
  );
  assert.throws(
    () =>
      db
        .prepare("UPDATE release_publication_pointers SET version = ? WHERE channel = 'stable'")
        .run(equalPrecedenceVersion),
    /equal precedence/,
  );

  assert.throws(
    () => db.exec("UPDATE release_publication_versions SET published_at = 'changed' WHERE channel = 'stable'"),
    /immutable/,
  );
  assert.throws(
    () =>
      db.exec(
        "UPDATE release_publication_pointers SET precedence_key = '0', version = '1.2.2' WHERE channel = 'stable'",
      ),
    /cannot regress/,
  );
  assert.throws(
    () => db.exec("DELETE FROM release_publication_pointers WHERE channel = 'stable'"),
    /audited migration/,
  );
  db.close();
});

test("build numbers order numerically after the plain public version", () => {
  const ordered = [
    "0.1.6",
    "0.1.7-beta.1",
    "0.1.7-beta.1+5",
    "0.1.7-beta.2",
    "0.1.7",
    "0.1.7+1",
    "0.1.7+9",
    "0.1.7+10",
    "0.1.7+779",
    "0.1.7+780",
    "0.1.7+999",
    "0.1.7+1000",
    "0.1.8-alpha",
    "0.1.8",
  ];
  const keys = ordered.map(semverPrecedenceKey);
  for (let index = 1; index < keys.length; index++) {
    assert.ok(
      Buffer.compare(Buffer.from(keys[index - 1]), Buffer.from(keys[index])) < 0,
      `${ordered[index - 1]} < ${ordered[index]}`,
    );
  }
  // Keys already stored in D1 for plain versions are unchanged.
  assert.equal(semverPrecedenceKey("0.1.7"), "100!101!107~1");
  assert.equal(semverPrecedenceKey("0.1.7+779"), "100!101!107~1+1110779");
  for (const invalid of ["0.1.7+0", "0.1.7+0779", "0.1.7+abc", "0.1.7+1.2", "0.1.7+"]) {
    assert.throws(() => semverPrecedenceKey(invalid), /SemVer/);
  }
});

test("SQLite moves Stable through builds of one public version and never back", () => {
  const migration = readFileSync(
    new URL("../../apps/website/migrations/0003_release_publication_pointers.sql", import.meta.url),
    "utf8",
  );
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(migration);
  const release = (version, digit) => ({
    channel: "stable",
    version,
    updaterDescriptorKey: `releases/updater/stable/${version}/${digit.repeat(64)}.json`,
    downloadDescriptorKey: `releases/${version}/${digit.repeat(64)}.json`,
    updaterDescriptorSha256: digit.repeat(64),
    downloadDescriptorSha256: digit.repeat(64),
    publishedAt: "2026-09-30T12:00:00.000Z",
  });
  const publish = (candidate) => [
    db.prepare(buildVersionClaimStatement(candidate)).all().length,
    db.prepare(buildPointerAdvanceStatement(candidate)).all().length,
  ];
  const pointer = () => db.prepare(buildPointerReadStatement("stable")).get().version;
  assert.deepEqual(publish(release("0.1.7", "1")), [1, 1]);
  assert.deepEqual(publish(release("0.1.7+779", "2")), [1, 1]);
  assert.equal(pointer(), "0.1.7+779");
  assert.deepEqual(publish(release("0.1.7+1000", "3")), [1, 1]);
  assert.equal(pointer(), "0.1.7+1000");
  assert.deepEqual(publish(release("0.1.7+999", "4")), [0, 0]);
  assert.deepEqual(publish(release("0.1.7", "5")), [0, 0]);
  assert.equal(pointer(), "0.1.7+1000");
  assert.deepEqual(publish(release("0.1.8", "6")), [1, 1]);
  assert.equal(pointer(), "0.1.8");
  db.close();
});

test("publication pointer CAS rejects an intervening platform-set release", () => {
  const migration = readFileSync(
    new URL("../../apps/website/migrations/0003_release_publication_pointers.sql", import.meta.url),
    "utf8",
  );
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(migration);
  const release = (version, updaterDigit, downloadDigit) => ({
    channel: "stable",
    version,
    updaterDescriptorKey: `releases/updater/stable/${version}/${updaterDigit.repeat(64)}.json`,
    downloadDescriptorKey: `releases/${version}/${downloadDigit.repeat(64)}.json`,
    updaterDescriptorSha256: updaterDigit.repeat(64),
    downloadDescriptorSha256: downloadDigit.repeat(64),
    publishedAt: "2026-09-25T12:00:00.000Z",
  });
  const baseline = release("1.2.3", "1", "2");
  const intervening = release("1.2.4", "3", "4");
  const candidate = release("1.2.5", "5", "6");
  for (const value of [baseline, intervening, candidate]) {
    assert.equal(db.prepare(buildVersionClaimStatement(value)).all().length, 1);
    if (value === baseline) assert.equal(db.prepare(buildPointerAdvanceStatement(value, null)).all().length, 1);
  }
  const observed = db.prepare(buildPointerReadStatement("stable")).get();
  assert.equal(db.prepare(buildPointerAdvanceStatement(intervening, observed)).all().length, 1);
  assert.equal(db.prepare(buildPointerAdvanceStatement(candidate, observed)).all().length, 0);
  assert.equal(db.prepare(buildPointerReadStatement("stable")).get().version, intervening.version);
  db.close();
});

test("pointer triggers reject INSERT OR REPLACE bypasses with foreign keys disabled", () => {
  const migration = readFileSync(
    new URL("../../apps/website/migrations/0003_release_publication_pointers.sql", import.meta.url),
    "utf8",
  );
  const row = (version, updaterDigit, downloadDigit) => ({
    channel: "stable",
    version,
    updaterDescriptorKey: `releases/updater/stable/${version}/${updaterDigit.repeat(64)}.json`,
    downloadDescriptorKey: `releases/${version}/${downloadDigit.repeat(64)}.json`,
    updaterDescriptorSha256: updaterDigit.repeat(64),
    downloadDescriptorSha256: downloadDigit.repeat(64),
    publishedAt: "2026-09-25T12:00:00.000Z",
  });
  const stale = row("1.0.0", "1", "2");
  const current = row("2.0.0", "3", "4");
  const equalVersion = "2.0.0-shadow";
  const replacement =
    "INSERT OR REPLACE INTO release_publication_pointers (channel, version, precedence_key, updated_at) VALUES ('stable', ?, ?, unixepoch())";

  const database = () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = OFF;");
    assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys, 0);
    db.exec(migration);
    assert.equal(db.prepare(buildVersionClaimStatement(stale)).all().length, 1);
    assert.equal(db.prepare(buildVersionClaimStatement(current)).all().length, 1);
    db.prepare(
      "INSERT INTO release_publication_versions (channel, version, precedence_key, updater_descriptor_key, download_descriptor_key, updater_descriptor_sha256, download_descriptor_sha256, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "stable",
      equalVersion,
      semverPrecedenceKey(current.version),
      `releases/updater/stable/${equalVersion}/${"5".repeat(64)}.json`,
      `releases/${equalVersion}/${"6".repeat(64)}.json`,
      "5".repeat(64),
      "6".repeat(64),
      current.publishedAt,
    );
    assert.equal(db.prepare(buildPointerAdvanceStatement(current)).all().length, 1);
    return db;
  };

  for (const [version, precedenceKey] of [
    ["0.5.0", semverPrecedenceKey("0.5.0")],
    [stale.version, semverPrecedenceKey(stale.version)],
    [equalVersion, semverPrecedenceKey(current.version)],
    ["0.5.0", semverPrecedenceKey("999.0.0")],
  ]) {
    const db = database();
    assert.throws(
      () => db.prepare(replacement).run(version, precedenceKey),
      /immutable version|regress|equal precedence/,
    );
    assert.equal(db.prepare(buildPointerReadStatement("stable")).get().version, current.version);
    db.close();
  }
});
