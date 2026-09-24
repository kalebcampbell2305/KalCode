/** Bounded, content-type-checked JSON body reading for untrusted requests. */

export const MAX_BODY_BYTES = 2048;

export type BodyResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: "unsupported_media_type" | "payload_too_large" | "invalid_json" };

/** True for `application/json`, with or without parameters such as `charset=utf-8`. */
export function isJsonContentType(header: string | null): boolean {
  if (!header) {
    return false;
  }
  const mediaType = header.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json";
}

/**
 * Reads at most `limit` bytes. Rejects early on a declared Content-Length above the limit and
 * stops streaming as soon as the limit is exceeded (chunked bodies have no declared length).
 */
export async function readJsonBody(request: Request, limit = MAX_BODY_BYTES): Promise<BodyResult> {
  if (!isJsonContentType(request.headers.get("content-type"))) {
    return { ok: false, reason: "unsupported_media_type" };
  }

  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isFinite(length) || length > limit) {
      return { ok: false, reason: "payload_too_large" };
    }
  }

  const bytes = new Uint8Array(limit);
  let received = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (received + value.byteLength > limit) {
        await reader.cancel();
        return { ok: false, reason: "payload_too_large" };
      }
      bytes.set(value, received);
      received += value.byteLength;
    }
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes.subarray(0, received));
  } catch {
    return { ok: false, reason: "invalid_json" };
  }

  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
}
