import { describe, expect, it } from "vitest";
import {
  DISPLAY_QUALIFIER_LABEL,
  DISPLAY_STATUS_LABEL,
  DISPLAY_STATUS_OF,
  DISPLAY_STATUS_TONE,
  displayStatusOf,
} from "./display-status.ts";
import type { DisplayStatus, ThreadStatus } from "./generated/index.ts";

/** The 18 runtime statuses. `Record` keeps this exhaustive when a status is added. */
const EVERY_THREAD_STATUS: Record<ThreadStatus, true> = {
  starting: true,
  active: true,
  thinking: true,
  running_tool: true,
  running_command: true,
  editing: true,
  testing: true,
  reviewing: true,
  idle: true,
  waiting_for_permission: true,
  waiting_for_user: true,
  waiting_for_dependency: true,
  paused: true,
  completed: true,
  failed: true,
  interrupted: true,
  recovering: true,
  offline: true,
};

/** The 12 display statuses. */
const EVERY_DISPLAY_STATUS: Record<DisplayStatus, true> = {
  starting: true,
  working: true,
  testing: true,
  reviewing: true,
  permission_required: true,
  waiting_for_you: true,
  idle: true,
  paused: true,
  done: true,
  failed: true,
  recovering: true,
  offline: true,
};

const THREAD_STATUSES = Object.keys(EVERY_THREAD_STATUS) as ThreadStatus[];
const DISPLAY_STATUSES = Object.keys(EVERY_DISPLAY_STATUS) as DisplayStatus[];

describe("display status", () => {
  it("maps every runtime status", () => {
    expect(THREAD_STATUSES).toHaveLength(18);
    expect(Object.keys(DISPLAY_STATUS_OF).sort()).toEqual([...THREAD_STATUSES].sort());
    for (const status of THREAD_STATUSES) {
      const info = displayStatusOf(status);
      expect(info).toBe(DISPLAY_STATUS_OF[status]);
      expect(DISPLAY_STATUSES).toContain(info.status);
      expect(info.chip).not.toBe("all");
    }
  });

  it("reaches all 12 display statuses", () => {
    expect(DISPLAY_STATUSES).toHaveLength(12);
    const reached = new Set(THREAD_STATUSES.map((status) => displayStatusOf(status).status));
    expect([...reached].sort()).toEqual([...DISPLAY_STATUSES].sort());
  });

  it("puts every status that needs attention on the Waiting for you chip", () => {
    for (const status of ["waiting_for_permission", "waiting_for_user", "failed"] as const) {
      expect(displayStatusOf(status).chip).toBe("waiting_for_you");
    }
    const waiting = THREAD_STATUSES.filter((status) => displayStatusOf(status).chip === "waiting_for_you");
    expect(waiting.sort()).toEqual(["failed", "waiting_for_permission", "waiting_for_user"]);
  });

  it("reserves the paused (amber) tone for PAUSED", () => {
    const paused = DISPLAY_STATUSES.filter((status) => DISPLAY_STATUS_TONE[status] === "paused");
    expect(paused).toEqual(["paused"]);
    expect(displayStatusOf("paused").status).toBe("paused");
  });

  it("shows an interrupted thread as idle, stopped and resumable", () => {
    expect(displayStatusOf("interrupted")).toEqual({ status: "idle", qualifier: "stopped_resumable", chip: "idle" });
    expect(DISPLAY_QUALIFIER_LABEL.stopped_resumable).toBe("stopped · resumable");
  });

  it("labels every display status and tone", () => {
    for (const status of DISPLAY_STATUSES) {
      expect(DISPLAY_STATUS_LABEL[status]).toMatch(/^[A-Z ]+$/);
      expect(DISPLAY_STATUS_TONE[status]).toBeTruthy();
    }
  });
});
