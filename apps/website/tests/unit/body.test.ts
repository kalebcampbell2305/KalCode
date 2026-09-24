import { describe, expect, it } from "vitest";
import { MAX_BODY_BYTES, isJsonContentType, readJsonBody } from "../../worker/lib/body";

function post(body: BodyInit | null, headers: Record<string, string> = {}): Request {
  const init: RequestInit & { duplex?: "half" } = {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  };
  // Node's fetch implementation requires `duplex` for streamed request bodies.
  if (body instanceof ReadableStream) init.duplex = "half";
  return new Request("https://kalcoded.com/api/early-access", init);
}

function stream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe("isJsonContentType", () => {
  it.each(["application/json", "Application/JSON", "application/json; charset=utf-8"])(
    "accepts %s",
    (value) => expect(isJsonContentType(value)).toBe(true),
  );
  it.each([null, "", "text/plain", "application/x-www-form-urlencoded", "application/jsonp"])(
    "rejects %j",
    (value) => expect(isJsonContentType(value)).toBe(false),
  );
});

describe("readJsonBody", () => {
  it("parses a small JSON object", async () => {
    await expect(readJsonBody(post('{"email":"a@example.com"}'))).resolves.toEqual({
      ok: true,
      value: { email: "a@example.com" },
    });
  });

  it("rejects a non-JSON content type", async () => {
    await expect(readJsonBody(post("{}", { "content-type": "text/plain" }))).resolves.toEqual({
      ok: false,
      reason: "unsupported_media_type",
    });
  });

  it("rejects a declared length above the limit", async () => {
    const body = JSON.stringify({ email: "a".repeat(MAX_BODY_BYTES) });
    await expect(readJsonBody(post(body))).resolves.toEqual({
      ok: false,
      reason: "payload_too_large",
    });
  });

  it("rejects a streamed body without a declared length once it exceeds the limit", async () => {
    const request = post(stream(['{"email":"', "a".repeat(1500), "a".repeat(1500), '"}']));
    expect(request.headers.get("content-length")).toBeNull();
    await expect(readJsonBody(request)).resolves.toEqual({
      ok: false,
      reason: "payload_too_large",
    });
  });

  it("accepts a body of exactly the limit", async () => {
    const padding = "a".repeat(MAX_BODY_BYTES - '{"p":""}'.length);
    const body = `{"p":"${padding}"}`;
    expect(new TextEncoder().encode(body).byteLength).toBe(MAX_BODY_BYTES);
    expect((await readJsonBody(post(body))).ok).toBe(true);
  });

  it("rejects malformed JSON", async () => {
    await expect(readJsonBody(post("{email:"))).resolves.toEqual({
      ok: false,
      reason: "invalid_json",
    });
  });

  it("rejects an empty body", async () => {
    await expect(readJsonBody(post(""))).resolves.toEqual({ ok: false, reason: "invalid_json" });
  });

  it("rejects invalid UTF-8", async () => {
    const bytes = new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]);
    await expect(readJsonBody(post(bytes))).resolves.toEqual({ ok: false, reason: "invalid_json" });
  });
});
