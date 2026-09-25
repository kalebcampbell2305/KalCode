import { describe, expect, it } from "vitest";
import { summaryLine } from "./homeModel.ts";

const base = {
  runningCount: 0,
  needsYouCount: 0,
  finishedSinceLastVisit: [],
  firstRun: false,
  threadCount: 4,
  workspaceCount: 2,
};

describe("summaryLine", () => {
  it("says what needs you first, then what runs and what finished", () => {
    expect(
      summaryLine({
        ...base,
        runningCount: 3,
        needsYouCount: 1,
        finishedSinceLastVisit: [{} as never, {} as never],
      }),
    ).toBe("1 thread needs you · 3 working · 2 finished since your last visit");
    expect(summaryLine({ ...base, needsYouCount: 2 })).toBe("2 threads need you");
  });

  it("is honest when nothing is happening", () => {
    expect(summaryLine(base)).toBe("Nothing is running and nothing needs you right now.");
    expect(summaryLine({ ...base, threadCount: 0, workspaceCount: 1 })).toBe("1 workspace, no threads yet.");
    expect(summaryLine({ ...base, firstRun: true, threadCount: 0, workspaceCount: 0 })).toBe(
      "Nothing has run yet. This page fills in as you work.",
    );
  });
});
