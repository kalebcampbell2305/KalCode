import { describe, expect, it } from "vitest";
import { readPublishedDescriptor } from "../../worker/release-catalog";

const bytes = new TextEncoder().encode('{"version":"1.0.0"}');
async function sha256(value: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", value);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function object(body: Uint8Array, size = body.length) {
  return { size, body: new Response(body).body as ReadableStream<Uint8Array> };
}

describe("authoritative release descriptors", () => {
  it("returns only the exact bytes selected by the publication hash", async () => {
    const hash = await sha256(bytes);
    const bucket = { get: async () => object(bytes) };
    expect(await readPublishedDescriptor(bucket, `releases/1.0.0/${hash}.json`, hash)).toBe('{"version":"1.0.0"}');
  });

  it("rejects replacement content and missing objects", async () => {
    const hash = await sha256(bytes);
    await expect(
      readPublishedDescriptor({ get: async () => object(new TextEncoder().encode("tampered")) }, "key", hash),
    ).rejects.toThrow();
    await expect(readPublishedDescriptor({ get: async () => null }, "key", hash)).rejects.toThrow();
  });

  it("bounds actual streamed bytes even when metadata is false", async () => {
    await expect(
      readPublishedDescriptor({ get: async () => object(new Uint8Array(65_537), 1) }, "key", "a".repeat(64)),
    ).rejects.toThrow();
  });

  it("rejects oversized metadata before consuming its body", async () => {
    let pulled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull() {
          pulled = true;
        },
      },
      { highWaterMark: 0 },
    );
    await expect(
      readPublishedDescriptor({ get: async () => ({ size: 65_537, body }) }, "key", "a".repeat(64)),
    ).rejects.toThrow();
    expect(pulled).toBe(false);
  });
});
