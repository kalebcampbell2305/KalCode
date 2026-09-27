import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { componentObjectUploadInvocation } from "./component-publish.mjs";
import {
  MULTIPART_PART_BYTES,
  multipartFailureStage,
  parseRemoteMultipartArgs,
  runMultipartCliSupervisor,
  runRemoteR2Multipart,
  uploadFileR2Multipart,
  uploadR2Multipart,
  WRANGLER_SINGLE_PUT_MAX_BYTES,
} from "./r2-multipart-upload.mjs";

const METADATA = {
  contentType: "application/octet-stream",
  cacheControl: "public, max-age=31536000, immutable",
};

function virtualReader() {
  return async ({ length, partNumber }) => Buffer.alloc(length, partNumber);
}

function fakeBucket(overrides = {}) {
  const state = {
    aborted: 0,
    completed: [],
    created: [],
    parts: [],
  };
  const upload = {
    key: "components/v1/model/test/object.bin",
    uploadId: "upload-1",
    async uploadPart(partNumber, bytes) {
      state.parts.push({ partNumber, bytes: Buffer.from(bytes), prototype: Object.getPrototypeOf(bytes) });
      return { partNumber, etag: `etag-${partNumber}` };
    },
    async abort() {
      state.aborted += 1;
    },
    async complete(parts) {
      state.completed.push(parts);
      return { key: upload.key, size: state.parts.reduce((total, part) => total + part.bytes.length, 0) };
    },
    ...overrides,
  };
  return {
    state,
    bucket: {
      async createMultipartUpload(key, options) {
        state.created.push({ key, options });
        upload.key = key;
        return upload;
      },
    },
  };
}

const TEST_OPTIONS = {
  partSizeBytes: 4,
  maxConcurrency: 2,
  maxAttempts: 3,
  operationTimeoutMs: 1_000,
  abortTimeoutMs: 1_000,
  sleep: async () => {},
  random: () => 0,
};

test("multipart upload keeps equal nonfinal parts, bounded concurrency, metadata, and completion order", async () => {
  assert.equal(MULTIPART_PART_BYTES, 16 * 1024 * 1024);
  let active = 0;
  let maximumActive = 0;
  const { bucket, state } = fakeBucket({
    async uploadPart(partNumber, bytes) {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, (4 - partNumber) * 2));
      active -= 1;
      state.parts.push({ partNumber, bytes: Buffer.from(bytes), prototype: Object.getPrototypeOf(bytes) });
      return { partNumber, etag: `etag-${partNumber}` };
    },
    async complete(parts) {
      state.completed.push(parts);
      return { key: "components/v1/model/test/object.bin", size: 10 };
    },
  });

  await uploadR2Multipart(
    {
      bucket,
      key: "components/v1/model/test/object.bin",
      sizeBytes: 10,
      httpMetadata: METADATA,
      readPart: virtualReader(),
    },
    TEST_OPTIONS,
  );

  assert.deepEqual(state.created, [
    { key: "components/v1/model/test/object.bin", options: { httpMetadata: METADATA } },
  ]);
  assert.deepEqual(
    state.parts.map(({ bytes }) => bytes.length).sort((left, right) => right - left),
    [4, 4, 2],
  );
  assert.ok(maximumActive <= 2);
  assert.ok(state.parts.every(({ prototype }) => prototype === Uint8Array.prototype));
  assert.deepEqual(
    state.completed[0].map(({ partNumber }) => partNumber),
    [1, 2, 3],
  );
  assert.equal(state.aborted, 0);
});

test("a part retries at most three times and keeps only its successful ETag", async () => {
  let attempts = 0;
  const delays = [];
  const { bucket, state } = fakeBucket({
    async uploadPart(partNumber) {
      attempts += 1;
      if (attempts < 3) throw new Error("transient private binding failure");
      return { partNumber, etag: "successful-etag" };
    },
    async complete(parts) {
      state.completed.push(parts);
      return { key: "components/v1/model/test/object.bin", size: 4 };
    },
  });
  await uploadR2Multipart(
    {
      bucket,
      key: "components/v1/model/test/object.bin",
      sizeBytes: 4,
      httpMetadata: METADATA,
      readPart: virtualReader(),
    },
    { ...TEST_OPTIONS, sleep: async (milliseconds) => delays.push(milliseconds) },
  );
  assert.equal(attempts, 3);
  assert.equal(delays.length, 2);
  assert.deepEqual(state.completed[0], [{ partNumber: 1, etag: "successful-etag" }]);
});

test("remote RPC promise properties are resolved before fail-closed validation", async () => {
  const key = "components/v1/model/test/object.bin";
  let completedParts;
  const upload = {
    key: Promise.resolve(key),
    uploadId: Promise.resolve("remote-upload-1"),
    async uploadPart(partNumber) {
      return {
        partNumber: Promise.resolve(partNumber),
        etag: Promise.resolve(`remote-etag-${partNumber}`),
      };
    },
    async abort() {
      assert.fail("a valid remote upload must not be aborted");
    },
    async complete(parts) {
      completedParts = parts;
      return { key: Promise.resolve(key), size: Promise.resolve(4) };
    },
  };
  const result = await uploadR2Multipart(
    {
      bucket: { createMultipartUpload: async () => upload },
      key,
      sizeBytes: 4,
      httpMetadata: METADATA,
      readPart: virtualReader(),
    },
    TEST_OPTIONS,
  );
  assert.deepEqual(completedParts, [{ partNumber: 1, etag: "remote-etag-1" }]);
  assert.deepEqual(result, { key, size: 4 });
});

test("terminal part failure aborts once and abort failure never masks the bounded error", async () => {
  let attempts = 0;
  const { bucket, state } = fakeBucket({
    async uploadPart() {
      attempts += 1;
      throw new Error("private terminal binding failure");
    },
    async abort() {
      state.aborted += 1;
      throw new Error("private abort failure");
    },
  });
  await assert.rejects(
    uploadR2Multipart(
      {
        bucket,
        key: "components/v1/model/test/object.bin",
        sizeBytes: 4,
        httpMetadata: METADATA,
        readPart: virtualReader(),
      },
      TEST_OPTIONS,
    ),
    /multipart part 1 failed/,
  );
  assert.equal(attempts, 3);
  assert.equal(state.aborted, 1);
  assert.equal(state.completed.length, 0);
});

test("part and completed-object mismatches fail closed and attempt abort", async () => {
  const wrongPart = fakeBucket({
    async uploadPart() {
      return { partNumber: 2, etag: "wrong-part" };
    },
  });
  await assert.rejects(
    uploadR2Multipart(
      {
        bucket: wrongPart.bucket,
        key: "components/v1/model/test/object.bin",
        sizeBytes: 4,
        httpMetadata: METADATA,
        readPart: virtualReader(),
      },
      TEST_OPTIONS,
    ),
    /multipart part 1 failed/,
  );
  assert.equal(wrongPart.state.aborted, 1);

  const wrongObject = fakeBucket({
    async complete() {
      return { key: "components/v1/model/test/other.bin", size: 4 };
    },
  });
  await assert.rejects(
    uploadR2Multipart(
      {
        bucket: wrongObject.bucket,
        key: "components/v1/model/test/object.bin",
        sizeBytes: 4,
        httpMetadata: METADATA,
        readPart: virtualReader(),
      },
      TEST_OPTIONS,
    ),
    /completed object did not match/,
  );
  assert.equal(wrongObject.state.aborted, 1);
});

test("file size mismatch fails before a multipart upload is created", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "kalcode-r2-multipart-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "object.bin");
  writeFileSync(path, "four");
  const { bucket, state } = fakeBucket();
  await assert.rejects(
    uploadFileR2Multipart(
      {
        bucket,
        key: "components/v1/model/test/object.bin",
        path,
        sizeBytes: 5,
        httpMetadata: METADATA,
      },
      TEST_OPTIONS,
    ),
    /verified upload size changed/,
  );
  assert.equal(state.created.length, 0);
});

test("remote proxy setup is secret-minimized and always disposed after upload failure", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "kalcode-r2-remote-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "object.bin");
  writeFileSync(path, "four");
  const calls = [];
  let disposed = 0;
  await assert.rejects(
    runRemoteR2Multipart(
      {
        key: "components/v1/model/test/object.bin",
        path,
        sizeBytes: 4,
        contentType: METADATA.contentType,
        cacheControl: METADATA.cacheControl,
      },
      {
        getPlatformProxy: async (options) => {
          calls.push(options);
          const config = JSON.parse(
            await import("node:fs/promises").then(({ readFile }) => readFile(options.configPath, "utf8")),
          );
          assert.deepEqual(Object.keys(config).sort(), ["compatibility_date", "name", "r2_buckets"]);
          assert.deepEqual(config.r2_buckets, [{ binding: "RELEASES", bucket_name: "kalcode-releases", remote: true }]);
          assert.equal(Object.hasOwn(config, "vars"), false);
          return {
            env: {
              RELEASES: {
                async createMultipartUpload() {
                  throw new Error("private create failure");
                },
              },
            },
            async dispose() {
              disposed += 1;
            },
          };
        },
        uploaderOptions: TEST_OPTIONS,
      },
    ),
    /multipart upload could not be created/,
  );
  assert.equal(disposed, 1);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].envFiles, []);
  assert.equal(calls[0].persist, false);
  assert.equal(calls[0].remoteBindings, true);
});

test("remote proxy setup and disposal have independent hard deadlines", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "kalcode-r2-timeout-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "object.bin");
  writeFileSync(path, "four");
  const args = {
    key: "components/v1/model/test/object.bin",
    path,
    sizeBytes: 4,
    contentType: METADATA.contentType,
    cacheControl: METADATA.cacheControl,
  };
  await assert.rejects(
    runRemoteR2Multipart(args, {
      getPlatformProxy: () => new Promise(() => {}),
      setupTimeoutMs: 5,
      disposeTimeoutMs: 5,
    }),
    /binding could not be established/,
  );

  const { bucket } = fakeBucket();
  let disposeCalls = 0;
  await assert.rejects(
    runRemoteR2Multipart(args, {
      getPlatformProxy: async () => ({
        env: { RELEASES: bucket },
        dispose() {
          disposeCalls += 1;
          return new Promise(() => {});
        },
      }),
      setupTimeoutMs: 50,
      disposeTimeoutMs: 5,
      uploaderOptions: TEST_OPTIONS,
    }),
    /binding could not be disposed/,
  );
  assert.equal(disposeCalls, 1);
});

test("the CLI retries only process-isolated proxy setup failures", async () => {
  const rawArgs = [
    "--key",
    "components/v1/model/test/object.bin",
    "--file",
    import.meta.filename,
    "--size",
    String(statSync(import.meta.filename).size),
    "--content-type",
    METADATA.contentType,
    "--cache-control",
    METADATA.cacheControl,
  ];
  const attempts = [];
  const recovered = await runMultipartCliSupervisor(rawArgs, {
    startAttempt() {
      attempts.push("attempt");
      return {
        result: Promise.resolve({ status: attempts.length < 3 ? 71 : 0 }),
        terminate() {},
      };
    },
  });
  assert.deepEqual(recovered, { ok: true, stage: null, attempts: 3 });
  assert.equal(attempts.length, 3);

  attempts.length = 0;
  const exhausted = await runMultipartCliSupervisor(rawArgs, {
    startAttempt() {
      attempts.push("attempt");
      return { result: Promise.resolve({ status: 71 }), terminate() {} };
    },
  });
  assert.deepEqual(exhausted, { ok: false, stage: "proxy_setup", attempts: 3 });
  assert.equal(attempts.length, 3);

  for (const [status, stage] of [
    [70, "unknown"],
    [72, "binding"],
    [73, "source"],
    [74, "create"],
    [75, "handle"],
    [76, "part_read"],
    [77, "part_upload"],
    [78, "complete"],
    [79, "completed_object"],
    [80, "dispose"],
    [81, "deadline"],
    [199, "unknown"],
  ]) {
    let calls = 0;
    const failed = await runMultipartCliSupervisor(rawArgs, {
      startAttempt() {
        calls += 1;
        return {
          result: Promise.resolve({ status, stdout: "private response", stderr: "private credential" }),
          terminate() {},
        };
      },
    });
    assert.deepEqual(failed, { ok: false, stage, attempts: 1 });
    assert.equal(calls, 1);
    assert.equal(JSON.stringify(failed).includes("private"), false);
  }
});

test("the total supervisor deadline terminates its active child before returning", async () => {
  const rawArgs = [
    "--key",
    "components/v1/model/test/object.bin",
    "--file",
    import.meta.filename,
    "--size",
    String(statSync(import.meta.filename).size),
    "--content-type",
    METADATA.contentType,
    "--cache-control",
    METADATA.cacheControl,
  ];
  const events = [];
  await assert.rejects(
    runMultipartCliSupervisor(rawArgs, { totalTimeoutMs: 29 * 60_000 + 1 }),
    /supervisor timeout is invalid/,
  );
  const outcome = await runMultipartCliSupervisor(rawArgs, {
    totalTimeoutMs: 5,
    startAttempt() {
      events.push("start");
      return {
        result: new Promise(() => {}),
        terminate() {
          events.push("terminate");
        },
      };
    },
  });
  events.push("return");
  assert.deepEqual(outcome, { ok: false, stage: "deadline", attempts: 1 });
  assert.deepEqual(events, ["start", "terminate", "return"]);
});

test("setup retries consume one shared supervisor deadline", async () => {
  const rawArgs = [
    "--key",
    "components/v1/model/test/object.bin",
    "--file",
    import.meta.filename,
    "--size",
    String(statSync(import.meta.filename).size),
    "--content-type",
    METADATA.contentType,
    "--cache-control",
    METADATA.cacheControl,
  ];
  const times = [0, 0, 6, 11];
  let starts = 0;
  const outcome = await runMultipartCliSupervisor(rawArgs, {
    totalTimeoutMs: 10,
    now: () => times.shift() ?? 11,
    startAttempt() {
      starts += 1;
      return { result: Promise.resolve({ status: 71 }), terminate() {} };
    },
  });
  assert.deepEqual(outcome, { ok: false, stage: "deadline", attempts: 2 });
  assert.equal(starts, 2);
});

test("multipart failure diagnostics are static and reject forged stages", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "kalcode-r2-diagnostic-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "object.bin");
  writeFileSync(path, "four");
  let failure;
  try {
    await runRemoteR2Multipart(
      {
        key: "components/v1/model/test/object.bin",
        path,
        sizeBytes: 4,
        contentType: METADATA.contentType,
        cacheControl: METADATA.cacheControl,
      },
      {
        getPlatformProxy: async () => {
          throw new Error("credential=private provider response");
        },
        setupTimeoutMs: 50,
      },
    );
  } catch (error) {
    failure = error;
  }
  assert.equal(failure?.message, "Wrangler remote R2 binding could not be established");
  assert.equal(multipartFailureStage(failure), "proxy_setup");
  assert.equal(JSON.stringify(failure).includes("private"), false);
  assert.equal(multipartFailureStage({ multipartFailureStage: "proxy_setup\ncredential=private" }), "unknown");
});

test("remote arguments and publisher selection are closed at the Wrangler single-put boundary", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "kalcode-r2-args-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "object.bin");
  writeFileSync(path, "four");
  assert.deepEqual(
    parseRemoteMultipartArgs([
      "--key",
      "components/v1/model/test/object.bin",
      "--file",
      path,
      "--size",
      "4",
      "--content-type",
      METADATA.contentType,
      "--cache-control",
      METADATA.cacheControl,
    ]),
    {
      key: "components/v1/model/test/object.bin",
      path,
      sizeBytes: 4,
      contentType: METADATA.contentType,
      cacheControl: METADATA.cacheControl,
    },
  );
  assert.throws(() => parseRemoteMultipartArgs(["--key", "../escape"]), /usage/);

  const upload = {
    kind: "artifact",
    key: "components/v1/model/test/object.bin",
    path,
    argv: [
      "r2",
      "object",
      "put",
      "kalcode-releases/components/v1/model/test/object.bin",
      "--file",
      path,
      "--content-type",
      METADATA.contentType,
      "--cache-control",
      METADATA.cacheControl,
    ],
  };
  assert.equal(componentObjectUploadInvocation(upload, WRANGLER_SINGLE_PUT_MAX_BYTES).kind, "wrangler");
  assert.equal(componentObjectUploadInvocation(upload, WRANGLER_SINGLE_PUT_MAX_BYTES + 1).kind, "multipart");
});

test("a sparse size mismatch fixture does not allocate its declared bytes", () => {
  const directory = mkdtempSync(join(tmpdir(), "kalcode-r2-sparse-test-"));
  try {
    const path = join(directory, "large.bin");
    writeFileSync(path, "");
    truncateSync(path, WRANGLER_SINGLE_PUT_MAX_BYTES + 1);
    assert.equal(
      componentObjectUploadInvocation(
        {
          kind: "artifact",
          key: "components/v1/model/test/large.bin",
          path,
          argv: [
            "r2",
            "object",
            "put",
            "kalcode-releases/components/v1/model/test/large.bin",
            "--file",
            path,
            "--content-type",
            METADATA.contentType,
            "--cache-control",
            METADATA.cacheControl,
          ],
        },
        WRANGLER_SINGLE_PUT_MAX_BYTES + 1,
      ).kind,
      "multipart",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
