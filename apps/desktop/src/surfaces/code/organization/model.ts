/**
 * Terminal Organization (Code): what each terminal and agent pane is for, what it is doing, and
 * how the workspace's panes group and stack. Pure functions over real state only:
 *
 * - terminals: the native terminal record (running / exited + exit code / ended by the app), the
 *   process tree under its shell (KalTidy's scan: a command under the shell is work), the Operations
 *   run attached to it (a test run is Testing) and the service it serves;
 * - agents: the thread status (the one shared display mapping), the pane's process, and approvals.
 *
 * Nothing here reads model prose, guesses from timers, or invents a state it can't observe: an
 * unknown terminal state has no badge. Names are display-only; a name the person set is kept.
 */
import type {
  DevelopmentService,
  OperationRecord,
  OperationsSnapshot,
  PaneContent,
  PaneInfo,
  ShellOption,
  StatusTone,
  TerminalInfo,
  ThreadStatus,
  ThreadSummary,
} from "@kalcode/protocol";
import type { ProcessInfo } from "../../../ipc/utilities.ts";
import { STOPPED_SERVICE, shellRoot, UNFINISHED, workUnderShell } from "../kaltidy/classify.ts";

// ---- Status badges ----

export type OrgBadge = "starting" | "ready" | "working" | "testing" | "waiting" | "failed" | "done" | "idle";

/** Label and contract tone of each badge (status is always tone + glyph + word, never colour alone). */
export const BADGES: Record<OrgBadge, { label: string; tone: StatusTone }> = {
  starting: { label: "Starting", tone: "muted" },
  ready: { label: "Ready", tone: "recovering" },
  working: { label: "Working", tone: "working" },
  testing: { label: "Testing", tone: "working" },
  waiting: { label: "Waiting", tone: "waiting" },
  failed: { label: "Failed", tone: "failed" },
  done: { label: "Done", tone: "done" },
  idle: { label: "Idle", tone: "muted" },
};

export interface BadgeView {
  badge: OrgBadge;
  /** One short fact behind the badge ("Running npm, node", "Exit code 1"). */
  detail: string;
}

/** What the process scan says about one terminal's shell. */
export interface TerminalProcesses {
  /** The shell process exists. */
  shell: boolean;
  /** Names of the commands running under the shell (not the shell or its console host). */
  work: string[];
  /** Listening ports of anything in the terminal's tree. */
  ports: number[];
}

/**
 * Groups a related-process scan by terminal; null when there is no scan. A terminal started after
 * the scan was sampled isn't in it, so it gets no entry (no badge) rather than a stale "Starting".
 */
export function scanTerminals(
  terminals: readonly TerminalInfo[],
  processes: readonly ProcessInfo[] | null,
  sampledAt?: number,
): Map<string, TerminalProcesses> | null {
  if (!processes) return null;
  const result = new Map<string, TerminalProcesses>();
  for (const terminal of terminals) {
    const started = terminal.startedAt ? Date.parse(terminal.startedAt) : Number.NaN;
    if (sampledAt !== undefined && !Number.isNaN(started) && started > sampledAt) continue;
    const tree = processes.filter((p) => p.terminalId === terminal.id);
    const root = shellRoot(tree);
    result.set(terminal.id, {
      shell: Boolean(root),
      work: root ? [...new Set(workUnderShell(terminal, tree, root).map((p) => p.name))] : [],
      ports: [...new Set(tree.flatMap((p) => p.ports))].sort((a, b) => a - b),
    });
  }
  return result;
}

/** The Operations run attached to a terminal that is still going (never the terminal's own mirror). */
export function runInTerminal(terminalId: string, items: readonly OperationRecord[]): OperationRecord | undefined {
  return items.find(
    (item) => item.terminalId === terminalId && item.source !== "terminal" && UNFINISHED.has(item.status),
  );
}

/** The service a terminal serves, while it isn't stopped. */
export function serviceInTerminal(
  terminalId: string,
  services: readonly DevelopmentService[],
): DevelopmentService | undefined {
  return services.find((s) => s.terminalId === terminalId && !STOPPED_SERVICE.has(s.status.toLowerCase()));
}

const processLabel = (name: string) => name.replace(/\.exe$/i, "");

/**
 * A terminal's badge. Ended shells are Done (exit 0) or Failed (any other exit code); a shell the
 * app ended, or one that ended without an exit code, is Idle. A running shell is Testing while an
 * Operations test run is attached, Working while a command runs under it, Ready at its prompt or
 * while it serves something, and Starting until its shell process exists. Without a process scan
 * a running terminal has no badge: nothing is guessed.
 */
export function terminalBadge(
  terminal: TerminalInfo,
  processes: TerminalProcesses | null | undefined,
  operations: OperationsSnapshot | null,
): BadgeView | null {
  if (terminal.status === "ended_by_app") return { badge: "idle", detail: "Ended when KalCode closed" };
  if (terminal.status === "exited") {
    if (terminal.exitCode === 0) return { badge: "done", detail: "Exited normally" };
    if (terminal.exitCode !== null) return { badge: "failed", detail: `Exit code ${terminal.exitCode}` };
    return { badge: "idle", detail: "Ended" };
  }
  const run = operations ? runInTerminal(terminal.id, operations.items) : undefined;
  if (run?.spec.kind === "test" && (run.status === "running" || run.status === "starting")) {
    return { badge: "testing", detail: `Running ${run.spec.name}` };
  }
  if (!processes) return null;
  if (!processes.shell) return { badge: "starting", detail: "Shell starting" };
  if (processes.work.length > 0) {
    return { badge: "working", detail: `Running ${processes.work.slice(0, 2).map(processLabel).join(", ")}` };
  }
  const service = operations ? serviceInTerminal(terminal.id, operations.services) : undefined;
  if (service) {
    const where = serviceAddress(service);
    return { badge: "ready", detail: where ? `Serving ${where}` : `Running ${service.name}` };
  }
  return { badge: "ready", detail: "At its prompt" };
}

/** Thread statuses that mean the agent is doing something. */
const AGENT_WORKING = new Set<ThreadStatus>([
  "active",
  "thinking",
  "running_tool",
  "running_command",
  "editing",
  "reviewing",
]);

/**
 * An agent's badge from its thread status, pane process and approvals. Done and Failed come only
 * from the thread status (never from the CLI's exit code). An agent whose process has ended is not
 * Working: it is Idle unless its status says Done or Failed.
 */
export function agentBadge(thread: ThreadSummary, info: PaneInfo | null): BadgeView {
  const { status } = thread;
  if (status === "failed") return { badge: "failed", detail: "The run failed" };
  if (status === "completed") return { badge: "done", detail: "Finished" };
  if (thread.pendingApprovals > 0 || status === "waiting_for_permission") {
    return { badge: "waiting", detail: "Needs your approval" };
  }
  if (status === "waiting_for_user") return { badge: "waiting", detail: "Waiting for your reply" };
  if (info === null) return { badge: "starting", detail: "Connecting to its terminal" };
  const live = info.running;
  if (!live) return { badge: "idle", detail: info.exitCode === null ? "Ended" : `Ended (exit ${info.exitCode})` };
  if (status === "starting" || status === "recovering") return { badge: "starting", detail: "Starting" };
  if (status === "testing") return { badge: "testing", detail: thread.currentActivity ?? "Running tests" };
  if (AGENT_WORKING.has(status)) return { badge: "working", detail: thread.currentActivity ?? "Working" };
  if (status === "idle") return { badge: "ready", detail: "Ready for your next prompt" };
  if (status === "paused") return { badge: "idle", detail: "Paused" };
  if (status === "interrupted") return { badge: "idle", detail: "Stopped · resumable" };
  if (status === "waiting_for_dependency") return { badge: "idle", detail: "Waiting on another task" };
  return { badge: "idle", detail: "Offline" };
}

// ---- Purpose names and groups ----

/** The built-in purpose groups, in order. People can add their own groups. */
export const AUTO_GROUPS = ["Frontend", "Backend", "Tests", "Release", "Agents", "Terminals"] as const;
export type AutoGroup = (typeof AUTO_GROUPS)[number];

const FRONTEND =
  /\b(vite|next|nuxt|astro|remix|react|vue|svelte|angular|storybook|webpack|parcel|frontend|web|ui|site|client)\b/i;
const BACKEND =
  /\b(api|server|backend|worker|wrangler|uvicorn|gunicorn|django|flask|rails|express|fastify|nest|cargo run|go run|dotnet run)\b/i;

/** Frontend or Backend from what a service or command calls itself; null when it says neither. */
export function serviceSide(text: string): "Frontend" | "Backend" | null {
  if (FRONTEND.test(text)) return "Frontend";
  if (BACKEND.test(text)) return "Backend";
  return null;
}

const RELEASE_KINDS = new Set(["release", "deploy", "build"]);

/** The first address a service answers on ("localhost:3000"), from its URLs or ports. */
export function serviceAddress(service: DevelopmentService): string | null {
  const url = service.urls[0];
  if (url) {
    try {
      const parsed = new URL(url);
      return parsed.host || url;
    } catch {
      return url;
    }
  }
  const port = service.ports[0];
  return port === undefined ? null : `localhost:${port}`;
}

/**
 * A terminal title the person chose. Native terminals start with their shell's name and only
 * change when someone renames them; Operations terminals carry their task's name.
 */
export function isCustomTerminalTitle(terminal: TerminalInfo, shells: readonly ShellOption[]): boolean {
  if (terminal.shellId.startsWith("operation:")) return false;
  const shell = shells.find((s) => s.id === terminal.shellId);
  return shell ? terminal.title !== shell.name : false;
}

export interface Purpose {
  /** A purpose name, or null to keep the pane's own name. */
  name: string | null;
  group: AutoGroup;
}

/** What a terminal is for, from the run attached to it or the service it serves. */
export function terminalPurpose(terminal: TerminalInfo, operations: OperationsSnapshot | null): Purpose {
  const items = operations?.items ?? [];
  // The newest Operations run that used this terminal (finished ones still say what it is for).
  const run = [...items]
    .filter((item) => item.terminalId === terminal.id && item.source !== "terminal")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (run?.spec.kind === "test") return { name: "Tests", group: "Tests" };
  if (run && RELEASE_KINDS.has(run.spec.kind)) return { name: "Release", group: "Release" };
  const service = operations ? serviceInTerminal(terminal.id, operations.services) : undefined;
  if (service) {
    const side = serviceSide(`${service.name} ${service.processName}`);
    return { name: side ?? service.name, group: side ?? "Terminals" };
  }
  if (run?.spec.kind === "service") {
    const side = serviceSide(`${run.spec.name} ${run.spec.command ?? ""}`);
    if (side) return { name: side, group: side };
  }
  return { name: null, group: "Terminals" };
}

/** Native restores legacy defaults; every nonempty persisted name can be an explicit manual choice. */
export function agentDisplayName(thread: ThreadSummary): string {
  const name = thread.name.trim();
  return name || thread.providerName || thread.providerId;
}

/** Numbers repeated names in order ("Tests", "Tests (2)"), like terminal tab labels. */
export function numberRepeats(names: readonly (readonly [string, string])[]): Map<string, string> {
  const seen = new Map<string, number>();
  const result = new Map<string, string>();
  for (const [key, name] of names) {
    const count = (seen.get(name) ?? 0) + 1;
    seen.set(name, count);
    result.set(key, count === 1 ? name : `${name} (${count})`);
  }
  return result;
}

// ---- Organizing the workspace ----

export interface OrgItem {
  /** `contentKey` of the pane content. */
  key: string;
  content: PaneContent;
  kind: "terminal" | "agent";
  title: string;
  /** Null when the state can't be observed right now. */
  status: BadgeView | null;
  group: AutoGroup;
  /** Provider id for agents, "shell" for terminals (the glyph). */
  glyph: string;
  /** Creation order (oldest first) within a group. */
  order: string;
}

export interface OrgPrefs {
  /** Show purpose groups (on by default); off shows one stack. */
  grouping: boolean;
  collapsedGroups: string[];
  /** Pinned items never collapse into Finished. */
  pinned: string[];
  /** Items the person moved to another group. */
  groupOf: Record<string, string>;
  /** Groups the person added. */
  customGroups: string[];
  /** The stack panel is open; null follows the workspace (open once it is busy). */
  stackOpen: boolean | null;
}

export const DEFAULT_PREFS: OrgPrefs = {
  grouping: true,
  collapsedGroups: [],
  pinned: [],
  groupOf: {},
  customGroups: [],
  stackOpen: null,
};

/** With no choice made, the stack opens once a workspace has this many terminals and agents. */
export const BUSY_WORKSPACE_ITEMS = 4;

/** Whether the stack shows: the person's choice, else open for a busy workspace. */
export function stackShown(prefs: OrgPrefs, itemCount: number): boolean {
  return prefs.stackOpen ?? itemCount >= BUSY_WORKSPACE_ITEMS;
}

export interface StackGroup {
  name: string;
  collapsed: boolean;
  /** In order: waiting, failed, working, testing, starting, ready, unknown. */
  active: OrgItem[];
  /** Done and idle items that aren't pinned or focused; collapsed under "Finished". */
  finished: OrgItem[];
  counts: { working: number; waiting: number; failed: number; done: number };
}

const STACK_ORDER: Record<OrgBadge | "unknown", number> = {
  waiting: 0,
  failed: 1,
  working: 2,
  testing: 3,
  starting: 4,
  ready: 5,
  unknown: 6,
  done: 7,
  idle: 8,
};

const isFinished = (item: OrgItem) => item.status?.badge === "done" || item.status?.badge === "idle";

/**
 * Groups and stacks the workspace's terminals and agents. Finished work (Done, Idle) collapses
 * under each group's "Finished" unless it is pinned or focused; nothing is removed. Without
 * grouping everything is one stack named "All".
 */
export function organize(items: readonly OrgItem[], prefs: OrgPrefs, focusedKey: string | null): StackGroup[] {
  const groupName = (item: OrgItem) => (prefs.grouping ? (prefs.groupOf[item.key] ?? item.group) : "All");
  const names = prefs.grouping ? [...AUTO_GROUPS, ...prefs.customGroups.filter((g) => !isAutoGroup(g))] : ["All"];
  for (const item of items) {
    const name = groupName(item);
    if (!names.includes(name)) names.push(name);
  }
  const pinned = new Set(prefs.pinned);
  const groups: StackGroup[] = [];
  for (const name of names) {
    const members = items
      .filter((item) => groupName(item) === name)
      .sort(
        (a, b) =>
          STACK_ORDER[a.status?.badge ?? "unknown"] - STACK_ORDER[b.status?.badge ?? "unknown"] ||
          a.order.localeCompare(b.order) ||
          a.key.localeCompare(b.key),
      );
    if (members.length === 0 && !prefs.customGroups.includes(name)) continue;
    const keep = (item: OrgItem) => !isFinished(item) || pinned.has(item.key) || item.key === focusedKey;
    groups.push({
      name,
      collapsed: prefs.collapsedGroups.includes(name),
      active: members.filter(keep),
      finished: members.filter((item) => !keep(item)),
      counts: {
        working: members.filter((i) => i.status?.badge === "working" || i.status?.badge === "testing").length,
        waiting: members.filter((i) => i.status?.badge === "waiting").length,
        failed: members.filter((i) => i.status?.badge === "failed").length,
        done: members.filter((i) => i.status?.badge === "done").length,
      },
    });
  }
  return groups;
}

export function isAutoGroup(name: string): name is AutoGroup {
  return (AUTO_GROUPS as readonly string[]).includes(name);
}

// ---- What's Happening ----

export type HappeningSegment =
  | { kind: "agents"; text: string; count: number }
  | { kind: "needs-you"; text: string; count: number }
  | { kind: "tests"; text: string; tone: StatusTone; recordId: string }
  | { kind: "service"; text: string; url: string }
  | { kind: "git"; text: string; clean: boolean };

export interface HappeningInputs {
  agents: readonly OrgItem[];
  needsYou: number;
  operations: OperationsSnapshot | null;
  git: { branch: string | null; changed: number; untracked: number } | null;
}

/** The newest test run in the workspace's Operations records (any source but a terminal mirror). */
export function latestTestRun(operations: OperationsSnapshot | null): OperationRecord | undefined {
  return [...(operations?.items ?? [])]
    .filter((item) => item.spec.kind === "test" && item.source !== "terminal")
    .sort((a, b) => (b.startedAt ?? b.createdAt).localeCompare(a.startedAt ?? a.createdAt))[0];
}

const TEST_WORDS: Partial<Record<OperationRecord["status"], { text: string; tone: StatusTone }>> = {
  queued: { text: "tests queued", tone: "muted" },
  starting: { text: "tests starting", tone: "working" },
  running: { text: "tests running", tone: "working" },
  succeeded: { text: "tests passing", tone: "done" },
  failed: { text: "tests failing", tone: "failed" },
  interrupted: { text: "tests interrupted", tone: "failed" },
};

/**
 * One line of what is happening, each part from an observed fact and each part only when there
 * is one: working agents, what needs you, the newest test run, the first live service, and Git.
 */
export function happening({ agents, needsYou, operations, git }: HappeningInputs): HappeningSegment[] {
  const segments: HappeningSegment[] = [];
  const working = agents.filter((a) => a.status?.badge === "working" || a.status?.badge === "testing").length;
  if (working > 0) {
    segments.push({ kind: "agents", count: working, text: `${working} ${working === 1 ? "agent" : "agents"} working` });
  }
  if (needsYou > 0) segments.push({ kind: "needs-you", count: needsYou, text: `${needsYou} needs you` });
  const tests = latestTestRun(operations);
  const words = tests ? TEST_WORDS[tests.status] : undefined;
  if (tests && words) segments.push({ kind: "tests", text: words.text, tone: words.tone, recordId: tests.id });
  const live = (operations?.services ?? []).filter((s) => !STOPPED_SERVICE.has(s.status.toLowerCase()));
  for (const service of live) {
    const address = serviceAddress(service);
    const url = service.urls[0] ?? (service.ports[0] === undefined ? null : `http://localhost:${service.ports[0]}`);
    if (address && url) {
      const more = live.length - 1;
      segments.push({ kind: "service", url, text: more > 0 ? `${address} +${more}` : address });
      break;
    }
  }
  if (git?.branch) {
    const changed = git.changed + git.untracked;
    segments.push({
      kind: "git",
      clean: changed === 0,
      text: changed === 0 ? `${git.branch} clean` : `${git.branch} · ${changed} changed`,
    });
  }
  return segments;
}
