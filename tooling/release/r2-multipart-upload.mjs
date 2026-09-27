#!/usr/bin/env node
import { lstatSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
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
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
const CONTENT_TYPES = new Set(["application/jose", "application/octet-stream", "application/zip"]);

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

function staticFailure(message) {
  return new Error(message);
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

function validUploadedPart(value, expectedPartNumber) {
  return (
    value &&
    typeof value === "object" &&
    value.partNumber === expectedPartNumber &&
    typeof value.etag === "string" &&
    value.etag.length > 0 &&
    value.etag.length <= 1024 &&
    Array.from(value.etag).every((character) => {
      const code = character.codePointAt(0);
      return code >= 0x20 && code !== 0x7f;
    })
  );
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
    throw staticFailure("multipart upload could not be created");
  }
  if (
    !upload ||
    upload.key !== key ||
    typeof upload.uploadId !== "string" ||
    upload.uploadId.length === 0 ||
    typeof upload.uploadPart !== "function" ||
    typeof upload.complete !== "function" ||
    typeof upload.abort !== "function"
  ) {
    await bestEffortAbort(upload ?? { abort: async () => {} }, abortTimeoutMs);
    throw staticFailure("multipart upload handle is invalid");
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
          throw staticFailure(`multipart part ${partNumber} could not be read`);
        }
        if (!(bytes instanceof Uint8Array) || bytes.byteLength !== length) {
          throw staticFailure(`multipart part ${partNumber} had an invalid length`);
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
            if (!validUploadedPart(result, partNumber)) throw staticFailure("multipart part result is invalid");
            successful = { partNumber: result.partNumber, etag: result.etag };
            break;
          } catch {
            if (failure !== null) break;
            if (attempt < maxAttempts) await sleep(retryDelay(attempt, random));
          }
        }
        if (!successful) throw staticFailure(`multipart part ${partNumber} failed after bounded retries`);
        uploadedParts[index] = successful;
      } catch (error) {
        failure ??= error instanceof Error ? error : staticFailure(`multipart part ${partNumber} failed`);
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
    throw staticFailure("multipart upload part set is incomplete");
  }

  const orderedParts = [...uploadedParts].sort((left, right) => left.partNumber - right.partNumber);
  let completed;
  try {
    completed = await withTimeout(upload.complete(orderedParts), operationTimeoutMs, "multipart completion timed out");
  } catch {
    await bestEffortAbort(upload, abortTimeoutMs);
    throw staticFailure("multipart upload could not be completed");
  }
  if (!completed || completed.key !== key || completed.size !== sizeBytes) {
    await bestEffortAbort(upload, abortTimeoutMs);
    throw staticFailure("multipart completed object did not match the verified upload");
  }
  return completed;
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
    if (!before.isFile() || before.size !== sizeBytes) throw staticFailure("verified upload size changed");
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
          if (read !== length) throw staticFailure(`multipart part ${partNumber} became incomplete`);
          return bytes;
        },
      },
      options,
    );
    const after = await descriptor.stat();
    if (!after.isFile() || after.size !== sizeBytes) throw staticFailure("verified upload size changed");
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
      throw staticFailure("Wrangler remote R2 binding could not be established");
    }
    const bucket = platform?.env?.RELEASES;
    if (!bucket || typeof bucket.createMultipartUpload !== "function") {
      throw staticFailure("Wrangler remote R2 binding is invalid");
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
    failure = error instanceof Error ? error : staticFailure("multipart publication failed");
  } finally {
    if (platform) {
      try {
        await withTimeout(platform.dispose(), disposeTimeoutMs, "Wrangler remote binding disposal timed out");
      } catch {
        failure ??= staticFailure("Wrangler remote R2 binding could not be disposed");
      }
    }
    rmSync(directory, { recursive: true, force: true });
  }
  if (failure) throw failure;
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const watchdog = setTimeout(() => {
    console.error("multipart component upload exceeded its process deadline");
    process.exit(1);
  }, HELPER_PROCESS_TIMEOUT_MS);
  let args;
  try {
    args = parseRemoteMultipartArgs(process.argv.slice(2));
  } catch {
    clearTimeout(watchdog);
    console.error("multipart component upload arguments are invalid");
    process.exit(1);
  }
  runRemoteR2Multipart(args).then(
    (result) => {
      clearTimeout(watchdog);
      console.log(`Uploaded multipart component object ${result.size} bytes.`);
    },
    () => {
      clearTimeout(watchdog);
      console.error("multipart component upload failed");
      process.exit(1);
    },
  );
}
