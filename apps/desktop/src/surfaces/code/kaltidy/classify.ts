import type { OperationsSnapshot, TerminalInfo } from "@kalcode/protocol";
import type { ProcessInfo } from "../../../ipc/utilities.ts";
import type { TerminalActivity } from "./activity.ts";
import type { KalTidyClass } from "./kalTidyContext.ts";

/**
 * KalTidy's classifier (pure). Conservative by construction: a terminal is `idle` only when every
 * signal positively says nothing is happening in it; any doubt, and any missing data, keeps it.
 *
 * Rules, first match wins:
 *  1. The process scan or the Operations snapshot failed → `protected` (nothing is idle).
 *  2. The terminal in front of the focused Code pane → `protected`.
 *  3. Tied to an unfinished Operations run (queued, starting, running, paused, blocked or
 *     unknown: deploy, release, build, test, agent, …) → `protected`. Operations' own mirror of
 *     each terminal session (source "terminal") is not a run.
 *  4. An agent CLI (Claude Code, Codex, Gemini) runs in it → `protected`.
 *  5. Its shell ended: `idle` once quiet for {@link QUIET_MS}, else `active`.
 *  6. Running, but its shell process isn't in the scan → `protected` (can't tell what it runs).
 *  7. Hosts a development service, or something in it listens on a port → `background`.
 *  8. Programs run under the shell: busy (CPU above {@link ACTIVE_CPU_PERCENT} or output in the
 *     last {@link ACTIVE_OUTPUT_MS}) → `active`; quiet → `waiting` (likely waiting for input).
 *  9. Text typed at the prompt without Enter → `waiting` (work that would be lost).
 * 10. Used (input, output or started) within {@link QUIET_MS} → `active`.
 * 11. Otherwise → `idle`: a shell at its prompt, nothing typed, quiet for {@link QUIET_MS}.
 */

/** A terminal counts as idle only after this long without input or output (2 minutes). */
export const QUIET_MS = 2 * 60_000;
/** Output this recent means a program in the terminal is working (30 seconds). */
export const ACTIVE_OUTPUT_MS = 30_000;
/** CPU (percent of the whole machine) above this means a program in the terminal is working. */
export const ACTIVE_CPU_PERCENT = 0.5;
/** The process scan lists at most this many rows; a full list may have dropped a terminal's. */
export const PROCESS_SCAN_LIMIT = 1_000;

const UNFINISHED = new Set(["queued", "starting", "running", "paused", "blocked", "unknown"]);
const STOPPED_SERVICE = new Set(["stopped", "exited", "failed", "crashed"]);
const AGENTS: Record<string, string> = { claude: "Claude Code", codex: "Codex", gemini: "Gemini CLI" };
/** Console hosts Windows attaches to console programs: infrastructure, never anyone's work. */
const CONSOLE_HOSTS = new Set(["conhost.exe", "openconsole.exe"]);

export interface TidyTerminal extends TerminalInfo {
  /** Tab label ("PowerShell 7 (2)"). */
  label: string;
  workspaceName: string;
}

export interface TidyEntry {
  terminal: TidyTerminal;
  cls: KalTidyClass;
  /** One short reason ("Running vite dev server on :5173", "Quiet for 14 min"). */
  reason: string;
}

export interface TidyScan {
  entries: TidyEntry[];
  /** Why nothing could be classified idle (a scan failed), or null. */
  blocked: string | null;
  /** When the scan was taken (epoch ms). */
  at: number;
}

export interface TidyInputs {
  terminals: readonly TidyTerminal[];
  /** The related-process scan, or null when it failed. */
  processes: readonly ProcessInfo[] | null;
  processError?: string | null;
  /** The Operations snapshot, or null when it failed. */
  operations: Pick<OperationsSnapshot, "items" | "services"> | null;
  operationsError?: string | null;
  activity: (terminalId: string) => TerminalActivity;
  /** The terminal the person is working in right now (Code's focused pane), if any. */
  focusedTerminalId: string | null;
  now: number;
}

export function formatAgo(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

function stem(name: string): string {
  return name.toLowerCase().replace(/\.exe$/, "");
}

function parseTime(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function ports(list: readonly number[]): string {
  return list
    .slice(0, 3)
    .map((p) => `:${p}`)
    .join(", ");
}

/**
 * The programs a terminal's shell is running: every process of its tree except the shell itself
 * and proven-harmless infrastructure — Windows console hosts, and Git Bash's launcher (its
 * `Git\bin\bash.exe` starts the real `usr\bin\bash.exe` as its only child and waits for it).
 */
export function workUnderShell(terminal: TerminalInfo, tree: readonly ProcessInfo[], root: ProcessInfo): ProcessInfo[] {
  let shellPid = root.pid;
  if (terminal.shellId === "git-bash") {
    const inner = tree.find((p) => p.parentPid === root.pid && p.name.toLowerCase() === "bash.exe");
    if (inner) shellPid = inner.pid;
  }
  return tree.filter((p) => p.pid !== root.pid && p.pid !== shellPid && !CONSOLE_HOSTS.has(p.name.toLowerCase()));
}

function classifyOne(terminal: TidyTerminal, inputs: TidyInputs, blocked: string | null): Omit<TidyEntry, "terminal"> {
  const { processes, operations, now } = inputs;
  if (blocked || !processes || !operations) {
    return { cls: "protected", reason: "Couldn't check this terminal, so it stays" };
  }
  if (terminal.id === inputs.focusedTerminalId) return { cls: "protected", reason: "You're working in it" };

  // Operations also mirrors every terminal session itself (source "terminal": "individual shell
  // commands are not instrumented"); that record is the terminal, not work in it.
  const run = operations.items.find(
    (item) => item.terminalId === terminal.id && item.source !== "terminal" && UNFINISHED.has(item.status),
  );
  if (run) {
    const kind = run.spec.kind.charAt(0).toUpperCase() + run.spec.kind.slice(1);
    const status = run.status === "unknown" ? "in an unknown state" : run.status;
    return { cls: "protected", reason: `${kind} “${run.spec.name}” is ${status}` };
  }

  const tree = processes.filter((p) => p.terminalId === terminal.id);
  const agent = tree.map((p) => AGENTS[stem(p.name)]).find(Boolean);
  if (agent) return { cls: "protected", reason: `${agent} agent is running` };

  const activity = inputs.activity(terminal.id);
  const lastUse = Math.max(activity.lastInputAt ?? 0, activity.lastOutputAt ?? 0);

  if (terminal.status !== "running") {
    const ended = parseTime(terminal.endedAt);
    const quietSince = Math.max(ended ?? 0, lastUse);
    const code = terminal.exitCode !== null && terminal.exitCode !== 0 ? ` (exit code ${terminal.exitCode})` : "";
    if (quietSince > 0 && now - quietSince < QUIET_MS) {
      return { cls: "active", reason: `Shell ended${code} ${formatAgo(now - quietSince)} ago` };
    }
    return {
      cls: "idle",
      reason: ended ? `Shell ended${code} ${formatAgo(now - ended)} ago` : `Shell ended${code}`,
    };
  }

  const root = tree.find((p) => p.terminalGeneration !== null);
  if (!root) return { cls: "protected", reason: "Couldn't see its shell process, so it stays" };

  const service = operations.services.find(
    (s) => s.terminalId === terminal.id && !STOPPED_SERVICE.has(s.status.toLowerCase()),
  );
  if (service) {
    return {
      cls: "background",
      reason:
        service.ports.length > 0 ? `Running ${service.name} on ${ports(service.ports)}` : `Running ${service.name}`,
    };
  }
  const listener = tree.find((p) => p.ports.length > 0);
  if (listener) return { cls: "background", reason: `${listener.name} listening on ${ports(listener.ports)}` };

  const work = workUnderShell(terminal, tree, root);
  if (work.length > 0) {
    const names = [...new Set(work.map((p) => p.name))].slice(0, 2).join(", ");
    const cpu = work.reduce((sum, p) => sum + (p.cpuPercent ?? 0), 0);
    const output = activity.lastOutputAt === null ? null : now - activity.lastOutputAt;
    if (cpu > ACTIVE_CPU_PERCENT) return { cls: "active", reason: `Running ${names} (${cpu.toFixed(1)}% CPU)` };
    if (output !== null && output < ACTIVE_OUTPUT_MS) {
      return { cls: "active", reason: `Running ${names}, output ${formatAgo(output)} ago` };
    }
    return { cls: "waiting", reason: `${names} is open and quiet — may be waiting for input` };
  }

  if (activity.unsent) return { cls: "waiting", reason: "Unsent input at the prompt" };

  const started = parseTime(terminal.startedAt) ?? 0;
  const quietSince = Math.max(lastUse, started);
  if (now - quietSince < QUIET_MS) return { cls: "active", reason: `Used ${formatAgo(now - quietSince)} ago` };
  return {
    cls: "idle",
    reason: quietSince > 0 ? `At its prompt, quiet for ${formatAgo(now - quietSince)}` : "At its prompt, quiet",
  };
}

/** Classifies every terminal. Never throws; missing data keeps every terminal. */
export function classifyTerminals(inputs: TidyInputs): TidyScan {
  const problems: string[] = [];
  if (!inputs.processes) problems.push(inputs.processError || "the process scan failed");
  else if (inputs.processes.length >= PROCESS_SCAN_LIMIT) problems.push("the process scan was cut short");
  if (!inputs.operations) problems.push(inputs.operationsError || "Operations didn't answer");
  const blocked =
    problems.length > 0 ? `KalCode couldn't check what your terminals are running: ${problems.join("; ")}.` : null;
  return {
    entries: inputs.terminals.map((terminal) => ({ terminal, ...classifyOne(terminal, inputs, blocked) })),
    blocked,
    at: inputs.now,
  };
}
