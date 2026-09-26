import { describe, expect, it } from "vitest";
import { buildRows, type DiffFileData, type DiffMode } from "./DiffView.model.ts";

function file(overrides: Partial<DiffFileData> = {}): DiffFileData {
  return {
    path: "after-cap.txt",
    change: "modified",
    additions: 0,
    deletions: 0,
    binary: false,
    hunks: [],
    ...overrides,
  };
}

function notices(data: DiffFileData, mode: DiffMode) {
  return buildRows([data], mode).flatMap((row) => (row.type === "notice" ? [row.notice] : []));
}

describe.each(["unified", "split"] as const)("DiffView %s notices", (mode) => {
  it.each([
    { additions: 3, deletions: 0 },
    { additions: 0, deletions: 2 },
    { additions: 3, deletions: 2 },
  ])("distinguishes unavailable patch content for $additions additions and $deletions deletions", (counts) => {
    // Files after a total patch cap still have counts but no per-file truncation flag.
    expect(notices(file({ ...counts, hunksTruncated: false }), mode)).toEqual(["content_unavailable"]);
  });

  it("preserves the no-change notice for a rename without line changes", () => {
    expect(notices(file({ change: "renamed", oldPath: "before.txt" }), mode)).toEqual(["no_content"]);
  });

  it("preserves the no-change notice for an empty file", () => {
    expect(notices(file({ change: "added" }), mode)).toEqual(["no_content"]);
  });

  it("preserves the binary notice", () => {
    expect(notices(file({ binary: true, additions: 3 }), mode)).toEqual(["binary"]);
  });

  it("preserves an explicit per-file truncation notice", () => {
    expect(notices(file({ additions: 3, hunksTruncated: true }), mode)).toEqual(["truncated"]);
  });

  it("does not mark delivered patch content as unavailable", () => {
    expect(
      notices(
        file({
          additions: 1,
          hunks: [
            {
              header: "@@ -0,0 +1 @@",
              oldStart: 0,
              oldLines: 0,
              newStart: 1,
              newLines: 1,
              lines: [{ kind: "add", oldLine: null, newLine: 1, text: "Delivered" }],
            },
          ],
        }),
        mode,
      ),
    ).toEqual([]);
  });
});
