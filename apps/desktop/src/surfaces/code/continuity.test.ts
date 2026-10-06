import type { ThreadSummary } from "@kalcode/protocol";
import { describe, expect, it } from "vitest";
import { RestoreQueue, recoveryCandidates } from "./continuity.ts";

const agent = (id: string, changes = {}): ThreadSummary =>
  ({
    id,
    runtimeKind: "interactive_pty",
    status: "interrupted",
    resumable: true,
    restartRecoverable: true,
    archivedAt: null,
    ...changes,
  }) as ThreadSummary;

describe("desk recovery", () => {
  it("resumes only restart-interrupted agents still in the saved desk", () => {
    const entries = [
      agent("open"),
      agent("closed"),
      agent("stopped", { restartRecoverable: false }),
      agent("done", { status: "completed" }),
      agent("failed", { status: "failed" }),
      agent("unknown", { resumable: false }),
      agent("chat", { runtimeKind: null }),
      agent("archived", { archivedAt: "yesterday" }),
      agent("live"),
    ];
    expect(
      recoveryCandidates(
        entries,
        new Set(entries.filter((a) => a.id !== "closed").map((a) => a.id)),
        new Set(["live"]),
      ).map((a) => a.id),
    ).toEqual(["open"]);
  });

  it("holds a queued prompt for the dedicated queued-task action instead of automatic recovery", () => {
    const ready = agent("ready");
    const queued = agent("queued", { resumeHasPendingInput: true });
    const open = new Set([ready.id, queued.id]);

    expect(recoveryCandidates([ready, queued], open, new Set()).map((entry) => entry.id)).toEqual(["ready"]);
    expect(
      recoveryCandidates([ready, queued], open, new Set(), { allowPendingInput: true }).map((entry) => entry.id),
    ).toEqual(["ready", "queued"]);
  });

  it("deduplicates concurrent recovery, bounds launches and rechecks closed work", async () => {
    const queue = new RestoreQueue(2);
    const open = new Set(["a", "b", "c"]);
    let active = 0;
    let maximum = 0;
    const calls: string[] = [];
    const releases: (() => void)[] = [];
    const run = async (id: string) => {
      calls.push(id);
      active++;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active--;
    };
    const first = queue.restore(["a", "b", "c"], (id) => open.has(id), run);
    const second = queue.restore(["a", "b"], (id) => open.has(id), run);
    await Promise.resolve();
    expect(calls).toEqual(["a", "b"]);
    open.delete("c");
    for (const release of releases) release();
    await Promise.all([first, second]);
    expect(maximum).toBe(2);
    expect(calls).toEqual(["a", "b"]);
    await queue.restore(["a"], () => true, run);
    expect(calls).toEqual(["a", "b"]);
  });

  it("keeps one failed restore from stopping the desk and retries only failures explicitly", async () => {
    const queue = new RestoreQueue(2);
    const calls: string[] = [];
    const run = async (id: string) => {
      calls.push(id);
      if (id === "bad") throw new Error("Session unavailable");
    };
    expect(await queue.restore(["bad", "good"], () => true, run)).toEqual(["bad"]);
    await queue.restore(["bad", "good"], () => true, run);
    expect(calls).toEqual(["bad", "good"]);
    queue.retry(["bad"]);
    await queue.restore(["bad", "good"], () => true, run);
    expect(calls).toEqual(["bad", "good", "bad"]);
  });
});
