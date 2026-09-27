#!/usr/bin/env node
import { fork, spawnSync } from "node:child_process";
import { lstatSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

import { R2_BUCKET, WEBSITE_DIR } from "./lib.mjs";

export const WRANGLER_SINGLE_PUT_MAX_BYTES = 300 * 1024 * 1024;
export const MULTIPART_PART_BYTES = 16 * 1024 * 1024;
const MULTIPART_MAX_CONCURRENCY = 4;
const MULTIPART_MAX_ATTEMPTS = 3;
const MAX_R2_OBJECT_BYTES = 5 * 1024 * 1024 * 1024 * 1024;
const MAX_R2_PARTS = 10_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 120_000;
const DEFAULT_ABORT_TIMEOUT_MS = 30_000;
const DEFAULT_PROXY_SETUP_TIMEOUT_MS = 60_000;
const DEFAULT_PROXY_DISPOSE_TIMEOUT_MS = 30_000;
const HELPER_PROCESS_TIMEOUT_MS = 30 * 60_000;
const SUPERVISOR_TOTAL_TIMEOUT_MS = 29 * 60_000;
const PROXY_SETUP_ATTEMPTS = 3;
const INTERNAL_ATTEMPT_ARG = "--internal-proxy-attempt";
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
const CONTENT_TYPES = new Set(["application/jose", "application/octet-stream", "application/zip"]);
const FAILURE_EXIT_CODES = Object.freeze({
  unknown: 70,
  proxy_setup: 71,
  binding: 72,
  source: 73,
  create: 74,
  handle: 75,
  part_read: 76,
  part_upload: 77,
  complete: 78,
  completed_object: 79,
  dispose: 80,
  deadline: 81,
});
const FAILURE_STAGES = new Set(Object.keys(FAILURE_EXIT_CODES));
const EXIT_FAILURE_STAGES = new Map(Object.entries(FAILURE_EXIT_CODES).map(([stage, exitCode]) => [exitCode, stage]));
const monotonicNow = () => performance.now();

function safeKey(key) {
  if (typeof key !== "string" || key.length < 16 || key.length > 1024 || !key.startsWith("components/v1/")) {
    throw new Error("multipart object key is invalid");
  }
  const segments = key.split("/");
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === ".." || !/^[A-Za-z0-9._-]+$/.test(segment),
    )
  ) {
    throw new Error("multipart object key is invalid");
  }
  return key;
}

function positiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`${label} is invalid`);
  return value;
}

function safeMetadata(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(["cacheControl", "contentType"]) ||
    !CONTENT_TYPES.has(value.contentType) ||
    value.cacheControl !== IMMUTABLE_CACHE_CONTROL
  ) {
    throw new Error("multipart object metadata is invalid");
  }
  return value;
}

function staticFailure(message, stage = "unknown") {
  const error = new Error(message);
  Object.defineProperty(error, "multipartFailureStage", {
    value: FAILURE_STAGES.has(stage) ? stage : "unknown",
    enumerable: false,
  });
  return error;
}

export function multipartFailureStage(error) {
  const stage = error?.multipartFailureStage;
  return typeof stage === "string" && FAILURE_STAGES.has(stage) ? stage : "unknown";
}

async function withTimeout(promise, milliseconds, message) {
  positiveInteger(milliseconds, "multipart operation timeout", 30 * 60_000);
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(staticFailure(message)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function retryDelay(attempt, random) {
  const jitter = Math.floor(Math.max(0, Math.min(0.999999, random())) * 250);
  return 250 * 2 ** (attempt - 1) + jitter;
}

function safeEtag(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 1024 &&
    Array.from(value).every((character) => {
      const code = character.codePointAt(0);
      return code >= 0x20 && code !== 0x7f;
    })
  );
}

async function normalizeUploadedPart(value, expectedPartNumber, operationTimeoutMs) {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return null;
  try {
    // Wrangler remote bindings expose native service objects through Cap'n Web. Their fields are
    // RPC thenables even though the Workers R2 types declare immediate property values.
    const [partNumber, etag] = await withTimeout(
      Promise.all([value.partNumber, value.etag]),
      operationTimeoutMs,
      "multipart part result timed out",
    );
    return partNumber === expectedPartNumber && safeEtag(etag) ? { partNumber, etag } : null;
  } catch {
    return null;
  }
}

async function validUploadHandle(upload, key, operationTimeoutMs) {
  if (
    !upload ||
    typeof upload.uploadPart !== "function" ||
    typeof upload.complete !== "function" ||
    typeof upload.abort !== "function"
  ) {
    return false;
  }
  try {
    const [uploadKey, uploadId] = await withTimeout(
      Promise.all([upload.key, upload.uploadId]),
      operationTimeoutMs,
      "multipart upload handle properties timed out",
    );
    return uploadKey === key && typeof uploadId === "string" && uploadId.length > 0;
  } catch {
    return false;
  }
}

async function normalizedCompletedObject(value, key, sizeBytes, operationTimeoutMs) {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return null;
  try {
    const [completedKey, completedSize] = await withTimeout(
      Promise.all([value.key, value.size]),
      operationTimeoutMs,
      "multipart completed object properties timed out",
    );
    return completedKey === key && completedSize === sizeBytes ? { key: completedKey, size: completedSize } : null;
  } catch {
    return null;
  }
}

async function bestEffortAbort(upload, timeoutMs) {
  try {
    await withTimeout(upload.abort(), timeoutMs, "multipart abort timed out");
  } catch {
    // Preserve the primary upload failure. Incomplete R2 multipart uploads remain invisible.
  }
}

export async function uploadR2Multipart(
  { bucket, key, sizeBytes, httpMetadata, readPart },
  {
    partSizeBytes = MULTIPART_PART_BYTES,
    maxConcurrency = MULTIPART_MAX_CONCURRENCY,
    maxAttempts = MULTIPART_MAX_ATTEMPTS,
    operationTimeoutMs = DEFAULT_OPERATION_TIMEOUT_MS,
    abortTimeoutMs = DEFAULT_ABORT_TIMEOUT_MS,
    sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
    random = Math.random,
  } = {},
) {
  safeKey(key);
  positiveInteger(sizeBytes, "multipart object size", MAX_R2_OBJECT_BYTES);
  positiveInteger(partSizeBytes, "multipart part size", MAX_R2_OBJECT_BYTES);
  positiveInteger(maxConcurrency, "multipart concurrency", MULTIPART_MAX_CONCURRENCY);
  positiveInteger(maxAttempts, "multipart attempt count", MULTIPART_MAX_ATTEMPTS);
  positiveInteger(operationTimeoutMs, "multipart operation timeout", 30 * 60_000);
  positiveInteger(abortTimeoutMs, "multipart abort timeout", 5 * 60_000);
  safeMetadata(httpMetadata);
  if (!bucket || typeof bucket.createMultipartUpload !== "function" || typeof readPart !== "function") {
    throw new Error("multipart upload dependencies are invalid");
  }
  const partCount = Math.ceil(sizeBytes / partSizeBytes);
  if (partCount > MAX_R2_PARTS) throw new Error("multipart upload has too many parts");

  let upload;
  try {
    upload = await withTimeout(
      bucket.createMultipartUpload(key, { httpMetadata }),
      operationTimeoutMs,
      "multipart upload creation timed out",
    );
  } catch {
    throw staticFailure("multipart upload could not be created", "create");
  }
  if (!(await validUploadHandle(upload, key, operationTimeoutMs))) {
    await bestEffortAbort(upload ?? { abort: async () => {} }, abortTimeoutMs);
    throw staticFailure("multipart upload handle is invalid", "handle");
  }

  const uploadedParts = new Array(partCount);
  let nextIndex = 0;
  let failure = null;
  const worker = async () => {
    while (failure === null) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= partCount) return;
      const partNumber = index + 1;
      const offset = index * partSizeBytes;
      const length = Math.min(partSizeBytes, sizeBytes - offset);
      try {
        let bytes;
        try {
          bytes = await withTimeout(
            readPart({ partNumber, offset, length }),
            operationTimeoutMs,
            `multipart part ${partNumber} read timed out`,
          );
        } catch {
          throw staticFailure(`multipart part ${partNumber} could not be read`, "part_read");
        }
        if (!(bytes instanceof Uint8Array) || bytes.byteLength !== length) {
          throw staticFailure(`multipart part ${partNumber} had an invalid length`, "part_read");
        }
        // Wrangler's remote-binding RPC recognizes the exact Uint8Array prototype; Node Buffers
        // are Uint8Array subclasses but have a different prototype and are not an RPC byte value.
        const payload =
          Object.getPrototypeOf(bytes) === Uint8Array.prototype
            ? bytes
            : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        let successful = null;
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          try {
            const result = await withTimeout(
              upload.uploadPart(partNumber, payload),
              operationTimeoutMs,
              `multipart part ${partNumber} timed out`,
            );
            const uploadedPart = await normalizeUploadedPart(result, partNumber, operationTimeoutMs);
            if (!uploadedPart) {
              throw staticFailure("multipart part result is invalid", "part_upload");
            }
            successful = uploadedPart;
            break;
          } catch {
            if (failure !== null) break;
            if (attempt < maxAttempts) await sleep(retryDelay(attempt, random));
          }
        }
        if (!successful) {
          throw staticFailure(`multipart part ${partNumber} failed after bounded retries`, "part_upload");
        }
        uploadedParts[index] = successful;
      } catch (error) {
        failure ??=
          error instanceof Error ? error : staticFailure(`multipart part ${partNumber} failed`, "part_upload");
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(maxConcurrency, partCount) }, () => worker()));
  if (failure) {
    await bestEffortAbort(upload, abortTimeoutMs);
    throw failure;
  }
  if (Array.from({ length: partCount }, (_, index) => uploadedParts[index]).some((part) => !part)) {
    await bestEffortAbort(upload, abortTimeoutMs);
    throw staticFailure("multipart upload part set is incomplete", "part_upload");
  }

  const orderedParts = [...uploadedParts].sort((left, right) => left.partNumber - right.partNumber);
  let completed;
  try {
    completed = await withTimeout(upload.complete(orderedParts), operationTimeoutMs, "multipart completion timed out");
  } catch {
    await bestEffortAbort(upload, abortTimeoutMs);
    throw staticFailure("multipart upload could not be completed", "complete");
  }
  const completedObject = await normalizedCompletedObject(completed, key, sizeBytes, operationTimeoutMs);
  if (!completedObject) {
    await bestEffortAbort(upload, abortTimeoutMs);
    throw staticFailure("multipart completed object did not match the verified upload", "completed_object");
  }
  return completedObject;
}

function canonicalFile(path) {
  if (typeof path !== "string" || !isAbsolute(path)) throw new Error("multipart source path is invalid");
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || resolve(realpathSync(path)) !== resolve(path)) {
    throw new Error("multipart source must be a canonical regular file");
  }
  return path;
}

export async function uploadFileR2Multipart({ bucket, key, path, sizeBytes, httpMetadata }, options = {}) {
  canonicalFile(path);
  positiveInteger(sizeBytes, "multipart object size", MAX_R2_OBJECT_BYTES);
  const descriptor = await open(path, "r");
  try {
    const before = await descriptor.stat();
    if (!before.isFile() || before.size !== sizeBytes) {
      throw staticFailure("verified upload size changed", "source");
    }
    const result = await uploadR2Multipart(
      {
        bucket,
        key,
        sizeBytes,
        httpMetadata,
        async readPart({ partNumber, offset, length }) {
          const bytes = Buffer.allocUnsafe(length);
          let read = 0;
          while (read < length) {
            const item = await descriptor.read(bytes, read, length - read, offset + read);
            if (item.bytesRead === 0) break;
            read += item.bytesRead;
          }
          if (read !== length) {
            throw staticFailure(`multipart part ${partNumber} became incomplete`, "part_read");
          }
          return bytes;
        },
      },
      options,
    );
    const after = await descriptor.stat();
    if (!after.isFile() || after.size !== sizeBytes) {
      throw staticFailure("verified upload size changed", "source");
    }
    return result;
  } finally {
    await descriptor.close();
  }
}

function validateRemoteArgs(value) {
  safeKey(value.key);
  canonicalFile(value.path);
  positiveInteger(value.sizeBytes, "multipart object size", MAX_R2_OBJECT_BYTES);
  safeMetadata({ contentType: value.contentType, cacheControl: value.cacheControl });
  return value;
}

export function parseRemoteMultipartArgs(args) {
  if (!Array.isArray(args) || args.length !== 10) {
    throw new Error(
      "usage: r2-multipart-upload --key KEY --file ABSOLUTE_PATH --size BYTES --content-type TYPE --cache-control VALUE",
    );
  }
  const values = {};
  const allowed = new Set(["--key", "--file", "--size", "--content-type", "--cache-control"]);
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    if (!allowed.has(name) || Object.hasOwn(values, name)) throw new Error("multipart upload arguments are invalid");
    values[name] = args[index + 1];
  }
  const sizeBytes = Number(values["--size"]);
  const value = {
    key: values["--key"],
    path: values["--file"],
    sizeBytes,
    contentType: values["--content-type"],
    cacheControl: values["--cache-control"],
  };
  validateRemoteArgs(value);
  return value;
}

async function loadGetPlatformProxy() {
  const websiteRequire = createRequire(join(WEBSITE_DIR, "package.json"));
  const wranglerEntry = websiteRequire.resolve("wrangler");
  const module = await import(pathToFileURL(wranglerEntry).href);
  if (typeof module.getPlatformProxy !== "function") throw new Error("Wrangler platform proxy is unavailable");
  return module.getPlatformProxy;
}

export async function runRemoteR2Multipart(
  args,
  {
    getPlatformProxy,
    uploaderOptions = {},
    setupTimeoutMs = DEFAULT_PROXY_SETUP_TIMEOUT_MS,
    disposeTimeoutMs = DEFAULT_PROXY_DISPOSE_TIMEOUT_MS,
  } = {},
) {
  validateRemoteArgs(args);
  const directory = mkdtempSync(join(tmpdir(), "kalcode-r2-multipart-"));
  const configPath = join(directory, "wrangler.jsonc");
  let platform = null;
  let result;
  let failure = null;
  try {
    writeFileSync(
      configPath,
      JSON.stringify({
        name: "kalcode-website",
        compatibility_date: "2026-09-21",
        r2_buckets: [{ binding: "RELEASES", bucket_name: R2_BUCKET, remote: true }],
      }),
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    const platformFactory = getPlatformProxy ?? (await loadGetPlatformProxy());
    try {
      platform = await withTimeout(
        platformFactory({ configPath, envFiles: [], persist: false, remoteBindings: true }),
        setupTimeoutMs,
        "Wrangler remote binding setup timed out",
      );
    } catch {
      throw staticFailure("Wrangler remote R2 binding could not be established", "proxy_setup");
    }
    const bucket = platform?.env?.RELEASES;
    if (!bucket || typeof bucket.createMultipartUpload !== "function") {
      throw staticFailure("Wrangler remote R2 binding is invalid", "binding");
    }
    result = await uploadFileR2Multipart(
      {
        bucket,
        key: args.key,
        path: args.path,
        sizeBytes: args.sizeBytes,
        httpMetadata: { contentType: args.contentType, cacheControl: args.cacheControl },
      },
      uploaderOptions,
    );
  } catch (error) {
    failure = error instanceof Error ? error : staticFailure("multipart publication failed", "unknown");
  } finally {
    if (platform) {
      try {
        await withTimeout(platform.dispose(), disposeTimeoutMs, "Wrangler remote binding disposal timed out");
      } catch {
        failure ??= staticFailure("Wrangler remote R2 binding could not be disposed", "dispose");
      }
    }
    rmSync(directory, { recursive: true, force: true });
  }
  if (failure) throw failure;
  return result;
}

function terminateAttemptTree(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const killed = spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      timeout: 10_000,
      windowsHide: true,
    });
    if (killed.status !== 0) {
      try {
        child.kill("SIGKILL");
      } catch {
        // The isolated attempt may already have exited between the IPC result and tree termination.
      }
    }
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // The isolated attempt may already have exited at the deadline boundary.
    }
  }
}

function startIsolatedAttempt(rawArgs) {
  let child;
  let terminate;
  const result = new Promise((resolveAttempt) => {
    // A timed-out getPlatformProxy() does not expose its partially-created session for disposal.
    // Keep setup in a child so the complete process tree can be terminated before a clean retry.
    child = fork(import.meta.filename, [INTERNAL_ATTEMPT_ARG, ...rawArgs], {
      detached: process.platform !== "win32",
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      windowsHide: true,
    });
    let reportedStatus = null;
    let settled = false;
    const finish = (status) => {
      if (settled) return;
      settled = true;
      resolveAttempt({ status });
    };
    terminate = () => {
      terminateAttemptTree(child);
    };
    child.on("message", (message) => {
      if (!message || typeof message !== "object" || message.type !== "kalcode-r2-multipart-result") return;
      if (message.ok === true) {
        reportedStatus = 0;
        return;
      }
      const stage = typeof message.stage === "string" && FAILURE_STAGES.has(message.stage) ? message.stage : "unknown";
      reportedStatus = FAILURE_EXIT_CODES[stage];
      if (stage === "proxy_setup") terminate();
    });
    child.once("error", () => {
      terminate();
      finish(FAILURE_EXIT_CODES.unknown);
    });
    child.once("exit", (code) => finish(reportedStatus ?? code ?? FAILURE_EXIT_CODES.unknown));
  });
  return { result, terminate: () => terminate?.() };
}

export async function runMultipartCliSupervisor(
  rawArgs,
  { startAttempt = startIsolatedAttempt, totalTimeoutMs = SUPERVISOR_TOTAL_TIMEOUT_MS, now = monotonicNow } = {},
) {
  parseRemoteMultipartArgs(rawArgs);
  positiveInteger(totalTimeoutMs, "multipart supervisor timeout", SUPERVISOR_TOTAL_TIMEOUT_MS);
  if (typeof now !== "function") throw new Error("multipart supervisor clock is invalid");
  const startedAt = now();
  if (!Number.isFinite(startedAt)) throw new Error("multipart supervisor clock is invalid");
  for (let attempt = 1; attempt <= PROXY_SETUP_ATTEMPTS; attempt += 1) {
    const currentTime = now();
    if (!Number.isFinite(currentTime)) throw new Error("multipart supervisor clock is invalid");
    const elapsedMs = currentTime - startedAt;
    const remainingMs = totalTimeoutMs - Math.max(0, elapsedMs);
    if (remainingMs <= 0) return { ok: false, stage: "deadline", attempts: attempt - 1 };
    let isolated;
    try {
      isolated = startAttempt(rawArgs);
    } catch {
      return { ok: false, stage: "unknown", attempts: attempt };
    }
    if (!isolated || typeof isolated.terminate !== "function" || typeof isolated.result?.then !== "function") {
      try {
        isolated?.terminate?.();
      } catch {
        // Invalid attempts still receive a best-effort cleanup before failing closed.
      }
      return { ok: false, stage: "unknown", attempts: attempt };
    }
    let deadlineTimer;
    const result = await Promise.race([
      Promise.resolve(isolated.result).catch(() => ({ status: FAILURE_EXIT_CODES.unknown })),
      new Promise((resolveDeadline) => {
        deadlineTimer = setTimeout(() => {
          try {
            isolated.terminate();
          } catch {
            // The process may have exited at the deadline boundary.
          } finally {
            resolveDeadline({ status: FAILURE_EXIT_CODES.deadline });
          }
        }, remainingMs);
      }),
    ]);
    clearTimeout(deadlineTimer);
    if (result?.status === 0) return { ok: true, stage: null, attempts: attempt };
    const stage = EXIT_FAILURE_STAGES.get(result?.status) ?? "unknown";
    if (stage !== "proxy_setup" || attempt === PROXY_SETUP_ATTEMPTS) {
      return { ok: false, stage, attempts: attempt };
    }
  }
  return { ok: false, stage: "unknown", attempts: PROXY_SETUP_ATTEMPTS };
}

function reportInternalAttempt(ok, stage) {
  const exitCode = ok ? 0 : FAILURE_EXIT_CODES[FAILURE_STAGES.has(stage) ? stage : "unknown"];
  if (typeof process.send !== "function") process.exit(exitCode);
  const keepAlive = stage === "proxy_setup" ? setInterval(() => {}, HELPER_PROCESS_TIMEOUT_MS) : null;
  try {
    process.send({ type: "kalcode-r2-multipart-result", ok, stage }, (error) => {
      if (error && keepAlive !== null) clearInterval(keepAlive);
      if (error || keepAlive === null) process.exit(exitCode);
    });
  } catch {
    if (keepAlive !== null) clearInterval(keepAlive);
    process.exit(exitCode);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const processArgs = process.argv.slice(2);
  const internalAttempt = processArgs[0] === INTERNAL_ATTEMPT_ARG;
  const rawArgs = internalAttempt ? processArgs.slice(1) : processArgs;
  if (!internalAttempt) {
    let args;
    try {
      args = parseRemoteMultipartArgs(rawArgs);
    } catch {
      console.error("multipart component upload arguments are invalid");
      process.exit(1);
    }
    let outcome;
    try {
      outcome = await runMultipartCliSupervisor(rawArgs);
    } catch {
      console.error("multipart component upload failed: unknown");
      process.exit(1);
    }
    if (outcome.ok) {
      console.log(`Uploaded multipart component object ${args.sizeBytes} bytes.`);
      process.exit(0);
    }
    console.error(`multipart component upload failed: ${outcome.stage}`);
    process.exit(1);
  }
  const watchdog = setTimeout(() => {
    reportInternalAttempt(false, "unknown");
  }, HELPER_PROCESS_TIMEOUT_MS);
  let args;
  try {
    args = parseRemoteMultipartArgs(rawArgs);
  } catch {
    clearTimeout(watchdog);
    process.exit(1);
  }
  runRemoteR2Multipart(args).then(
    (result) => {
      clearTimeout(watchdog);
      void result;
      reportInternalAttempt(true, null);
    },
    (error) => {
      clearTimeout(watchdog);
      reportInternalAttempt(false, multipartFailureStage(error));
    },
  );
}
