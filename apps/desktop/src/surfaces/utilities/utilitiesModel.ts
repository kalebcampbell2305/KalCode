export type JsonMode = "pretty" | "compact";

export type JsonResult = { ok: true; output: string } | { ok: false; input: string; message: string };

export type DiffRow = {
  kind: "same" | "added" | "removed";
  left: string | null;
  right: string | null;
  leftLine: number | null;
  rightLine: number | null;
};

export type TextTransform =
  | "base64_encode"
  | "base64_decode"
  | "hex_encode"
  | "hex_decode"
  | "url_encode"
  | "url_decode"
  | "sha256";

const MAX_DIFF_LINES = 2_000;
const MAX_TRANSFORM_BYTES = 1_048_576;

function lineAt(lines: readonly string[], index: number): string {
  const line = lines[index];
  if (line === undefined) {
    throw new Error("The diff index moved outside the bounded input.");
  }
  return line;
}

function scoreAt(scores: Uint16Array, index: number): number {
  return scores[index] ?? 0;
}

function safeMessage(error: unknown): string {
  const source = error instanceof Error ? error.message : "The input is not valid.";
  const clean = [...source]
    .map((character) => (character < " " ? " " : character))
    .join("")
    .trim();
  return clean.slice(0, 300) || "The input is not valid.";
}

export function formatJson(input: string, mode: JsonMode): JsonResult {
  try {
    const value: unknown = JSON.parse(input);
    return {
      ok: true,
      output: JSON.stringify(value, null, mode === "pretty" ? 2 : 0),
    };
  } catch (error) {
    return { ok: false, input, message: safeMessage(error) };
  }
}

export function diffLines(left: string, right: string): DiffRow[] {
  const leftLines = left.split("\n");
  const rightLines = right.split("\n");
  if (leftLines.length > MAX_DIFF_LINES || rightLines.length > MAX_DIFF_LINES) {
    throw new Error("Compare up to 2,000 lines on each side.");
  }

  const width = rightLines.length + 1;
  const common = new Uint16Array((leftLines.length + 1) * width);
  for (let leftIndex = leftLines.length - 1; leftIndex >= 0; leftIndex -= 1) {
    for (let rightIndex = rightLines.length - 1; rightIndex >= 0; rightIndex -= 1) {
      const offset = leftIndex * width + rightIndex;
      common[offset] =
        leftLines[leftIndex] === rightLines[rightIndex]
          ? scoreAt(common, (leftIndex + 1) * width + rightIndex + 1) + 1
          : Math.max(scoreAt(common, (leftIndex + 1) * width + rightIndex), scoreAt(common, offset + 1));
    }
  }

  const rows: DiffRow[] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < leftLines.length || rightIndex < rightLines.length) {
    if (
      leftIndex < leftLines.length &&
      rightIndex < rightLines.length &&
      leftLines[leftIndex] === rightLines[rightIndex]
    ) {
      rows.push({
        kind: "same",
        left: lineAt(leftLines, leftIndex),
        right: lineAt(rightLines, rightIndex),
        leftLine: leftIndex + 1,
        rightLine: rightIndex + 1,
      });
      leftIndex += 1;
      rightIndex += 1;
    } else if (
      leftIndex < leftLines.length &&
      (rightIndex >= rightLines.length ||
        scoreAt(common, (leftIndex + 1) * width + rightIndex) >= scoreAt(common, leftIndex * width + rightIndex + 1))
    ) {
      rows.push({
        kind: "removed",
        left: lineAt(leftLines, leftIndex),
        right: null,
        leftLine: leftIndex + 1,
        rightLine: null,
      });
      leftIndex += 1;
    } else {
      rows.push({
        kind: "added",
        left: null,
        right: lineAt(rightLines, rightIndex),
        leftLine: null,
        rightLine: rightIndex + 1,
      });
      rightIndex += 1;
    }
  }
  return rows;
}

function bytesToBinary(bytes: Uint8Array): string {
  let result = "";
  for (let offset = 0; offset < bytes.length; offset += 8_192) {
    result += String.fromCharCode(...bytes.subarray(offset, offset + 8_192));
  }
  return result;
}

function boundedBytes(input: string): Uint8Array {
  const bytes = new TextEncoder().encode(input);
  if (bytes.byteLength > MAX_TRANSFORM_BYTES) {
    throw new Error("Transform up to 1 MB at a time.");
  }
  return bytes;
}

export async function transformText(input: string, operation: TextTransform): Promise<string> {
  switch (operation) {
    case "base64_encode":
      return btoa(bytesToBinary(boundedBytes(input)));
    case "base64_decode": {
      const binary = atob(input.trim());
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    }
    case "hex_encode":
      return [...boundedBytes(input)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    case "hex_decode": {
      const compact = input.replaceAll(/\s/g, "");
      if (compact.length % 2 !== 0) throw new Error("Hex input must contain complete byte pairs.");
      if (!/^[0-9a-f]*$/i.test(compact)) throw new Error("Hex input may contain only 0–9 and A–F.");
      const bytes = new Uint8Array(compact.length / 2);
      for (let index = 0; index < compact.length; index += 2) {
        bytes[index / 2] = Number.parseInt(compact.slice(index, index + 2), 16);
      }
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    }
    case "url_encode":
      boundedBytes(input);
      return encodeURIComponent(input);
    case "url_decode":
      return decodeURIComponent(input);
    case "sha256": {
      const source = boundedBytes(input);
      const digestInput = new Uint8Array(source.byteLength);
      digestInput.set(source);
      const digest = await globalThis.crypto.subtle.digest("SHA-256", digestInput);
      return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    }
  }
}

export class LatestOperation<T> {
  private generation = 0;

  constructor(
    private readonly commit: (value: T) => void,
    private readonly fail: (error: unknown) => void,
  ) {}

  async run(operation: () => Promise<T>): Promise<void> {
    const generation = ++this.generation;
    try {
      const value = await operation();
      if (generation === this.generation) this.commit(value);
    } catch (error) {
      if (generation === this.generation) this.fail(error);
    }
  }

  cancel(): void {
    this.generation += 1;
  }
}
