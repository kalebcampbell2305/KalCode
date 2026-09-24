/** Bounded, content-type-checked JSON body reading for untrusted requests. */

export const MAX_BODY_BYTES = 1024;

export type BodyResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: "unsupported_media_type" | "payload_too_large" | "invalid_json" };

export function isJsonContentType(header: string | null): boolean {
  return header?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

/** Reads at most `limit` bytes, rejecting early on a larger declared length. */
export async function readJsonBody(request: Request, limit = MAX_BODY_BYTES): Promise<BodyResult> {
  if (!isJsonContentType(request.headers.get("content-type"))) {
    return { ok: false, reason: "unsupported_media_type" };
  }
  const declared = request.headers.get("content-length");
  if (declared !== null && !(Number(declared) <= limit)) {
    return { ok: false, reason: "payload_too_large" };
  }
  const bytes = new Uint8Array(limit);
  let received = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (received + value.byteLength > limit) {
        await reader.cancel();
        return { ok: false, reason: "payload_too_large" };
      }
      bytes.set(value, received);
      received += value.byteLength;
    }
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes.subarray(0, received));
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
}
