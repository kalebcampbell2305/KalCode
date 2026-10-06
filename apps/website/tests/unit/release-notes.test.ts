import { describe, expect, it } from "vitest";
import { buildsFromNotes, NOTES_019, parseBuildNotes } from "../../src/lib/release-notes";

const NOTES = `# KalCode {{PUBLIC_VERSION}} (build 9000)

Source commit: \`abc\`.

## New in this build

- **Faster panes.** Each pane redraws on its own. Busy agents stay smooth.
- **Weekly usage, front and center.** Headers show weekly usage left.
- **Your follow-ups are never held.** They start right away.
- **A fourth thing.** It does \`code\` things.

## Platforms

- Windows 10 version 1809 or later, x64.
`;

describe("release notes", () => {
  it("parses the highlights of one build: a title from the first leads, one sentence per point", () => {
    expect(parseBuildNotes(9000, NOTES)).toEqual({
      build: 9000,
      title: "Faster panes, Weekly usage, front and center, Your follow-ups are never held.",
      points: [
        "Faster panes. Each pane redraws on its own.",
        "Weekly usage, front and center. Headers show weekly usage left.",
        "Your follow-ups are never held. They start right away.",
        "A fourth thing. It does code things.",
      ],
    });
  });

  it("ignores notes without highlights and sorts builds newest first", () => {
    const builds = buildsFromNotes("0.1.9", {
      "docs/releases/0.1.9+100.md": NOTES,
      "docs/releases/0.1.9+300.md": NOTES,
      "docs/releases/0.1.9+200.md": "# empty\n\n## Platforms\n",
      "docs/releases/0.1.8+999.md": NOTES,
    });
    expect(builds.map((b) => b.build)).toEqual([300, 100]);
  });

  it("reads the repository's published 0.1.9 notes, including 1816", () => {
    const builds = NOTES_019.map((b) => b.build);
    expect(builds).toContain(1816);
    expect(builds).toEqual([...builds].sort((a, b) => b - a));
    for (const notes of NOTES_019) {
      expect(notes.points.length).toBeGreaterThan(0);
      expect(notes.points.length).toBeLessThanOrEqual(6);
      for (const point of notes.points) expect(point).not.toMatch(/\*\*|`/);
    }
  });
});
