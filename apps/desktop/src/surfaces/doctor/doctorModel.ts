import type { DoctorArea, DoctorFinding, DoctorRun, FixRequest } from "../../ipc/doctor.ts";

export const AREA_ORDER: DoctorArea[] = ["kalcode", "providers", "dev_tools", "system", "project"];

export const AREA_LABEL: Record<DoctorArea, string> = {
  kalcode: "KalCode",
  providers: "Providers",
  dev_tools: "Developer tools",
  system: "System",
  project: "Current project",
};

export function checksByArea(run: DoctorRun): Array<{
  area: DoctorArea;
  checks: DoctorRun["checks"];
}> {
  return AREA_ORDER.map((area) => ({
    area,
    checks: run.checks.filter((check) => check.area === area),
  })).filter((group) => group.checks.length > 0);
}

export function visibleFindings(run: DoctorRun, showIgnored: boolean): DoctorFinding[] {
  return run.findings
    .filter((finding) => showIgnored || finding.ignored === null)
    .sort((a, b) => {
      const severity = { critical: 0, warning: 1, info: 2 };
      return severity[a.severity] - severity[b.severity] || a.title.localeCompare(b.title);
    });
}

export function fixRequest(
  run: DoctorRun,
  finding: DoctorFinding,
  fixCode: string,
  approvalId: string | null = null,
): FixRequest {
  return {
    runId: run.id,
    findingCode: finding.code,
    findingVersion: finding.version,
    fixCode,
    approvalId,
  };
}

export function progress(run: DoctorRun): { completed: number; total: number } {
  return {
    completed: run.checks.filter((check) => check.status !== "running").length,
    total: run.checks.length,
  };
}
