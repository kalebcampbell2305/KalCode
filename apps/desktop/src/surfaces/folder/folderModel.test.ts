import type { EventEnvelope, StatusFile } from "@kalcode/protocol";
import { describe, expect, it } from "vitest";
import { changeOf, fileSize, recentFilesFrom, splitPath } from "./folderModel.ts";

const status = (partial: Partial<StatusFile>): StatusFile => ({
  file: null,
  path: "src/a.ts",
  origPath: null,
  staged: null,
  unstaged: null,
  untracked: false,
  conflict: null,
  submodule: false,
  ...partial,
});

describe("changeOf", () => {
  it("prefers conflicts, then the working tree, then the index", () => {
    expect(changeOf(status({ conflict: "both_modified" as never, unstaged: "modified" })).words).toBe("conflict");
    expect(changeOf(status({ untracked: true }))).toMatchObject({ letter: "?", words: "untracked" });
    expect(changeOf(status({ unstaged: "deleted", staged: "modified" }))).toMatchObject({ letter: "D", staged: false });
    expect(changeOf(status({ staged: "added" }))).toMatchObject({ letter: "A", staged: true });
  });
});

describe("helpers", () => {
  it("formats sizes and splits paths", () => {
    expect(fileSize(null)).toBe("");
    expect(fileSize(512)).toBe("512 B");
    expect(fileSize(2048)).toBe("2.0 KB");
    expect(fileSize(50 * 1024)).toBe("50 KB");
    expect(fileSize(3 * 1024 * 1024)).toBe("3.0 MB");
    expect(splitPath("src/auth/callback.ts")).toEqual({ dir: "src/auth/", name: "callback.ts" });
    expect(splitPath("README.md")).toEqual({ dir: "", name: "README.md" });
  });

  it("lists distinct recent files from file events, newest first", () => {
    const event = (seq: number, type: string, path: string): EventEnvelope =>
      ({
        id: String(seq),
        seq,
        version: 1,
        occurredAt: `2026-09-25T10:0${seq}:00.000Z`,
        source: "core",
        correlation: {},
        type,
        payload: { threadId: null, path },
      }) as unknown as EventEnvelope;
    const files = recentFilesFrom([
      event(1, "file.modified", "a.ts"),
      event(2, "file.created", "b.ts"),
      event(3, "file.modified", "a.ts"),
      event(4, "thread.started", "ignored"),
      event(5, "file.deleted", "c.ts"),
    ]);
    expect(files.map((f) => [f.path, f.change])).toEqual([
      ["c.ts", "deleted"],
      ["a.ts", "modified"],
      ["b.ts", "created"],
    ]);
  });
});
