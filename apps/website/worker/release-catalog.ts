/** Public release metadata. D1 owns publication; R2 holds content-addressed bytes only. */
export interface PublishedRelease {
  channel: string;
  version: string;
  updater_descriptor_key: string;
  download_descriptor_key: string;
  updater_descriptor_sha256: string;
  download_descriptor_sha256: string;
}

export interface ReleaseCatalog {
  get(channel: string, version?: string): Promise<PublishedRelease | null>;
}

export function releaseCatalog(db: D1Database): ReleaseCatalog {
  return {
    async get(channel, version) {
      if (version !== undefined) {
        return db
          .prepare("SELECT * FROM release_publication_versions WHERE channel = ? AND version = ?")
          .bind(channel, version)
          .first<PublishedRelease>();
      }
      return db
        .prepare(
          "SELECT v.* FROM release_publication_pointers p JOIN release_publication_versions v ON v.channel = p.channel AND v.version = p.version AND v.precedence_key = p.precedence_key WHERE p.channel = ?",
        )
        .bind(channel)
        .first<PublishedRelease>();
    },
  };
}

interface DescriptorBucket {
  get(key: string): Promise<{ size: number; body: ReadableStream<Uint8Array> } | null>;
}

const MAX_DESCRIPTOR_BYTES = 64 * 1024;

/** Enforce the actual stream bound, then verify the exact publication-selected bytes. */
export async function readPublishedDescriptor(
  bucket: DescriptorBucket,
  key: string,
  expectedHash: string,
): Promise<string> {
  if (!/^[0-9a-f]{64}$/.test(expectedHash)) throw new Error("Invalid release hash");
  const object = await bucket.get(key);
  if (!object || !Number.isSafeInteger(object.size) || object.size <= 0 || object.size > MAX_DESCRIPTOR_BYTES) {
    throw new Error("Release descriptor unavailable");
  }
  const reader = object.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > MAX_DESCRIPTOR_BYTES || length > object.size) throw new Error("Release descriptor too large");
      chunks.push(part.value);
    }
    if (length !== object.size) throw new Error("Release descriptor incomplete");
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (hash !== expectedHash) throw new Error("Release descriptor integrity failure");
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
}
