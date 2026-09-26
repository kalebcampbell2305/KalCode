export type DoctorArea = "kalcode" | "providers" | "dev_tools" | "system" | "project";
export type FindingSeverity = "info" | "warning" | "critical";
export type CheckStatus = "running" | "passed" | "finding" | "could_not_check" | "skipped" | "cancelled";
export type RunStatus = "running" | "completed" | "cancelled";

export interface DetailFact {
  label: string;
  value: string;
}

export type IgnoreScope = { kind: "global" } | { kind: "workspace"; workspaceId: string };

export type Reversibility =
  | { kind: "reversible"; how: string }
  | { kind: "not_reversible"; why: string }
  | { kind: "nothing_changes" };

export interface FixOption {
  fixCode: string;
  label: string;
  description: string;
  scopes: string[];
  reversible: Reversibility;
  showCommandOnly: boolean;
  command: string | null;
  commandShell: string | null;
}

export interface DoctorFinding {
  code: string;
  version: string;
  checkId: string;
  area: DoctorArea;
  severity: FindingSeverity;
  title: string;
  explanation: string;
  details: DetailFact[];
  subjects: string[];
  fixes: FixOption[];
  ignored: IgnoreScope | null;
  workspaceId: string | null;
}

export interface CheckResult {
  id: string;
  area: DoctorArea;
  title: string;
  status: CheckStatus;
  summary: string;
  reason: string | null;
  durationMs: number | null;
  findingCodes: string[];
}

export interface FindingCounts {
  critical: number;
  warning: number;
  info: number;
  ignored: number;
  passed: number;
  couldNotCheck: number;
  skipped: number;
}

export interface DoctorRun {
  id: string;
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  areas: DoctorArea[];
  workspaceId: string | null;
  workspaceName: string | null;
  timeoutMs: number;
  checks: CheckResult[];
  findings: DoctorFinding[];
  counts: FindingCounts;
  persistent: boolean;
}

export interface RunRequest {
  areas: DoctorArea[];
  checks: string[];
  workspaceId: string | null;
}

export interface FixRequest {
  runId: string;
  findingCode: string;
  findingVersion: string;
  fixCode: string;
  approvalId: string | null;
}

export interface FixPreview {
  runId: string;
  findingCode: string;
  fix: FixOption;
  changes: string[];
  target: string | null;
  undo: string;
  needsApproval: boolean;
}

export type FixOutcome =
  | { kind: "done"; fixLogId: string; message: string }
  | { kind: "awaiting_approval"; approvalId: string }
  | { kind: "denied"; reason: string }
  | { kind: "show_command"; command: string };

export interface IgnoreRequest {
  findingCode: string;
  scope: IgnoreScope;
  ignored: boolean;
}

export interface RevertRequest {
  fixLogId: string;
  approvalId: string | null;
}

export interface FixLogEntry {
  id: string | null;
  findingCode: string;
  fixCode: string;
  workspaceId: string | null;
  summary: string;
  status: "awaiting_approval" | "applying" | "applied" | "undo_awaiting_approval" | "reverting" | "failed" | "reverted";
  approvalId: string | null;
  appliedAt: string | null;
  revertedAt: string | null;
  canUndo: boolean;
  error: string | null;
}

export interface IgnoredFinding {
  findingCode: string;
  scope: IgnoreScope;
  workspaceName: string | null;
  title: string;
  ignoredAt: string;
}

export interface IgnoredList {
  items: IgnoredFinding[];
  persistent: boolean;
}

export interface DoctorApi {
  run(request: RunRequest): Promise<DoctorRun>;
  cancel(runId: string): Promise<DoctorRun>;
  last(): Promise<DoctorRun | null>;
  previewFix(request: FixRequest): Promise<FixPreview>;
  fix(request: FixRequest): Promise<FixOutcome>;
  ignore(request: IgnoreRequest): Promise<DoctorRun>;
  ignored(): Promise<IgnoredList>;
  revert(request: RevertRequest): Promise<FixOutcome>;
  fixLog(limit: number): Promise<FixLogEntry[]>;
}

export type DoctorInvoke = <T>(
  command:
    | "doctor_run"
    | "doctor_cancel"
    | "doctor_last"
    | "doctor_fix_preview"
    | "doctor_fix"
    | "doctor_ignore"
    | "doctor_ignored"
    | "doctor_revert"
    | "doctor_fix_log",
  args?: Record<string, unknown>,
) => Promise<T>;

/** Dedicated adapter used by the shared IPC client once Doctor commands are registered. */
export function createDoctorApi(invoke: DoctorInvoke): DoctorApi {
  return {
    run: (request) => invoke("doctor_run", { request }),
    cancel: (runId) => invoke("doctor_cancel", { runId }),
    last: () => invoke("doctor_last"),
    previewFix: (request) => invoke("doctor_fix_preview", { request }),
    fix: (request) => invoke("doctor_fix", { request }),
    ignore: (request) => invoke("doctor_ignore", { request }),
    ignored: () => invoke("doctor_ignored"),
    revert: (request) => invoke("doctor_revert", { request }),
    fixLog: (limit) => invoke("doctor_fix_log", { limit: Math.max(1, Math.min(500, Math.floor(limit))) }),
  };
}
