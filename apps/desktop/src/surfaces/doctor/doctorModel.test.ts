import { describe, expect, it } from "vitest";

import type { DoctorFinding, DoctorRun } from "../../ipc/doctor.ts";
import { checksByArea, fixRequest, progress, visibleFindings } from "./doctorModel.ts";

function finding(partial: Partial<DoctorFinding>): DoctorFinding {
  return {
    code: "tools.node.missing",
    version: "finding-version",
    checkId: "tools.node",
    area: "dev_tools",
    severity: "warning",
    title: "Node.js was not found",
    explanation: "Node.js is needed by this project.",
    details: [],
    subjects: [],
    fixes: [],
    ignored: null,
    workspaceId: null,
    ...partial,
  };
}

function run(partial: Partial<DoctorRun> = {}): DoctorRun {
  return {
    id: "run-id",
    status: "completed",
    startedAt: "2026-09-25T00:00:00Z",
    finishedAt: "2026-09-25T00:00:01Z",
    areas: ["kalcode", "dev_tools"],
    workspaceId: null,
    workspaceName: null,
    timeoutMs: 15_000,
    checks: [
      {
        id: "tools.node",
        area: "dev_tools",
        title: "Node.js",
        status: "finding",
        summary: "Not found",
        reason: null,
        durationMs: 4,
        findingCodes: ["tools.node.missing"],
      },
      {
        id: "kalcode.database",
        area: "kalcode",
        title: "Database integrity",
        status: "passed",
        summary: "No damage found",
        reason: null,
        durationMs: 9,
        findingCodes: [],
      },
    ],
    findings: [],
    counts: {
      critical: 0,
      warning: 0,
      info: 0,
      ignored: 0,
      passed: 1,
      couldNotCheck: 0,
      skipped: 0,
    },
    persistent: true,
    ...partial,
  };
}

describe("Environment Doctor model", () => {
  it("uses the fixed area order and reports actual completed checks", () => {
    const snapshot = run({
      status: "running",
      checks: [
        ...run().checks,
        {
          id: "tools.cargo",
          area: "dev_tools",
          title: "Cargo",
          status: "running",
          summary: "Waiting",
          reason: null,
          durationMs: null,
          findingCodes: [],
        },
      ],
    });
    expect(checksByArea(snapshot).map((group) => group.area)).toEqual(["kalcode", "dev_tools"]);
    expect(progress(snapshot)).toEqual({ completed: 2, total: 3 });
  });

  it("hides ignored findings and sorts remaining findings by severity", () => {
    const snapshot = run({
      findings: [
        finding({ code: "info", severity: "info", title: "Info" }),
        finding({ code: "critical", severity: "critical", title: "Critical" }),
        finding({
          code: "ignored",
          ignored: { kind: "global" },
          title: "Ignored",
        }),
      ],
    });
    expect(visibleFindings(snapshot, false).map((item) => item.code)).toEqual(["critical", "info"]);
    expect(visibleFindings(snapshot, true).map((item) => item.code)).toEqual(["critical", "ignored", "info"]);
  });

  it("binds a fix to the exact run, finding version and fixed catalog code", () => {
    const observed = finding({ code: "project.env.not_ignored", version: "opaque-version" });
    expect(fixRequest(run(), observed, "file.gitignore_env", "approval-id")).toEqual({
      runId: "run-id",
      findingCode: "project.env.not_ignored",
      findingVersion: "opaque-version",
      fixCode: "file.gitignore_env",
      approvalId: "approval-id",
    });
  });
});
