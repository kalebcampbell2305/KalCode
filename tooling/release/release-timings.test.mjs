import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { mark, readTimings, setState, summarize, timingsPath } from "./release-timings.mjs";

test("marks start/end per step and summarizes minutes and the end-to-end total", () => {
  const root = mkdtempSync(join(tmpdir(), "kalcode-timings-"));
  try {
    mark(root, { release: "0.1.9+1038", step: "merge", phase: "end", at: "2026-10-02T20:00:00Z" });
    mark(root, { release: "0.1.9+1038", step: "build-windows", phase: "start", at: "2026-10-02T20:00:00Z" });
    mark(root, { release: "0.1.9+1038", step: "build-windows", phase: "end", at: "2026-10-02T20:10:30Z" });
    mark(root, {
      release: "0.1.9+1038",
      step: "package-mac",
      phase: "start",
      at: "2026-10-02T20:04:00Z",
      note: "cold base",
    });
    const summary = summarize(readTimings(root, "0.1.9+1038"));
    const win = summary.steps.find((s) => s.step === "build-windows");
    assert.equal(win.minutes, 10.5);
    assert.equal(summary.steps.find((s) => s.step === "package-mac").minutes, null, "open step");
    assert.equal(summary.totalMinutes, 10.5);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refuses bad versions, steps, phases and timestamps", () => {
  const root = mkdtempSync(join(tmpdir(), "kalcode-timings-"));
  try {
    assert.throws(() => timingsPath(root, "0.1.9-beta"));
    assert.throws(() => mark(root, { release: "0.1.9", step: "Bad Step", phase: "start" }));
    assert.throws(() => mark(root, { release: "0.1.9", step: "stage", phase: "middle" }));
    assert.throws(() => mark(root, { release: "0.1.9", step: "stage", phase: "start", at: "not a date" }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pipeline states give the current state and the time from merge to users; terminal states stay final", () => {
  const root = mkdtempSync(join(tmpdir(), "kalcode-timings-"));
  try {
    const release = "0.1.9+1800";
    setState(root, { release, state: "MERGED", at: "2026-10-05T12:00:00Z" });
    setState(root, { release, state: "RELEASE_PREPARING", at: "2026-10-05T12:01:00Z" });
    setState(root, { release, state: "PACKAGED", at: "2026-10-05T12:40:00Z" });
    setState(root, { release, state: "PUBLISHED", at: "2026-10-05T12:45:00Z" });
    setState(root, { release, state: "USER_RECEIVABLE", at: "2026-10-05T12:50:00Z", note: "feed proof" });
    const report = summarize(readTimings(root, release));
    assert.equal(report.state, "USER_RECEIVABLE");
    assert.equal(report.mergedToUsersMinutes, 50);
    assert.equal(report.states.length, 5);
    assert.throws(() => setState(root, { release, state: "FAILED" }), /already USER_RECEIVABLE/);
    setState(root, { release: "0.1.9+1799", state: "SUPERSEDED", note: "1800 contains it" });
    assert.equal(summarize(readTimings(root, "0.1.9+1799")).state, "SUPERSEDED");
    assert.throws(() => setState(root, { release, state: "DONE" }), /state must be one of/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
