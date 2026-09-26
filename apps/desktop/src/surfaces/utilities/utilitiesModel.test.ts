import { describe, expect, it, vi } from "vitest";
import { type DiffRow, diffLines, formatJson, LatestOperation, transformText } from "./utilitiesModel.ts";

describe("formatJson", () => {
  it("formats valid JSON without changing values", () => {
    expect(formatJson('{"name":"KalCode","enabled":true}', "pretty")).toEqual({
      ok: true,
      output: '{\n  "name": "KalCode",\n  "enabled": true\n}',
    });
  });

  it("returns a useful parse error and preserves the person's input", () => {
    const result = formatJson('{"name": }', "pretty");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.input).toBe('{"name": }');
      expect(result.message.length).toBeGreaterThan(0);
    }
  });
});

describe("diffLines", () => {
  it("aligns additions and removals around unchanged lines", () => {
    expect(diffLines("alpha\nbeta\ngamma", "alpha\ndelta\ngamma")).toEqual<DiffRow[]>([
      { kind: "same", left: "alpha", right: "alpha", leftLine: 1, rightLine: 1 },
      { kind: "removed", left: "beta", right: null, leftLine: 2, rightLine: null },
      { kind: "added", left: null, right: "delta", leftLine: null, rightLine: 2 },
      { kind: "same", left: "gamma", right: "gamma", leftLine: 3, rightLine: 3 },
    ]);
  });

  it("refuses unbounded comparisons", () => {
    expect(() => diffLines("x\n".repeat(2_001), "x")).toThrow(/2,000 lines/i);
  });
});

describe("transformText", () => {
  it("round-trips unicode through base64", async () => {
    const encoded = await transformText("signal ✓", "base64_encode");
    await expect(transformText(encoded, "base64_decode")).resolves.toBe("signal ✓");
  });

  it("computes the standard SHA-256 digest", async () => {
    await expect(transformText("abc", "sha256")).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("rejects malformed hex rather than silently changing it", async () => {
    await expect(transformText("f", "hex_decode")).rejects.toThrow(/pairs/i);
  });
});

describe("LatestOperation", () => {
  it("commits only the latest result when requests finish out of order", async () => {
    const committed: string[] = [];
    const failed = vi.fn();
    const operations = new LatestOperation<string>((value) => committed.push(value), failed);
    let resolveFirst: (value: string) => void = () => {};
    let resolveSecond: (value: string) => void = () => {};
    const first = new Promise<string>((resolve) => {
      resolveFirst = resolve;
    });
    const second = new Promise<string>((resolve) => {
      resolveSecond = resolve;
    });

    const firstRun = operations.run(() => first);
    const secondRun = operations.run(() => second);
    resolveSecond("new");
    await secondRun;
    resolveFirst("stale");
    await firstRun;

    expect(committed).toEqual(["new"]);
    expect(failed).not.toHaveBeenCalled();
  });

  it("cancel suppresses both late success and late failure", async () => {
    const committed = vi.fn();
    const failed = vi.fn();
    const operations = new LatestOperation<string>(committed, failed);
    let reject: (error: Error) => void = () => {};
    const pending = new Promise<string>((_resolve, rejectPromise) => {
      reject = rejectPromise;
    });

    const run = operations.run(() => pending);
    operations.cancel();
    reject(new Error("late"));
    await run;

    expect(committed).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
  });
});
