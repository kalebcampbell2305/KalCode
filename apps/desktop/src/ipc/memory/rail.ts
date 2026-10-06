/**
 * In-memory Session Locator, workspace rail, returning-user home, recent work, workspace
 * actions and the Z6a read-only file/Git commands — for the `ui-test` build and unit tests ONLY
 * (see ../memoryTransport.ts). Never bundled into development or production builds. It mirrors
 * the native semantics of `crates/locator` (query words, aliases, filters, ranking, greeting
 * rotation, real-state summaries) closely enough that UI tests exercise real flows; the Rust
 * tests are the authority on the native behaviour.
 *
 * Scenarios: `rail` — many workspaces (pinned, a folder group, archived, a missing folder) with
 * threads across providers; `home` — the same, returning with a display name set. Every other
 * scenario starts empty (first run) and grows from what the UI does.
 */
import type {
  Branch,
  Commit,
  EventEnvelope,
  EventPayload,
  FileEntry,
  HomeSummary,
  IpcError,
  LocatorEntityKind,
  LocatorInterpretation,
  LocatorOpenTarget,
  LocatorQuery,
  LocatorRecency,
  LocatorResponse,
  LocatorResult,
  LocatorStatusFilter,
  Page,
  ProviderRow,
  ProviderStatus,
  RailGroupView,
  RailSection,
  RailState,
  RailThread,
  RecentWorkItem,
  RecentWorkWhen,
  Settings,
  StatusFile,
  TerminalInfo,
  ThreadSummary,
  Workspace,
  WorkspaceGroup,
  WorkspaceRailEntry,
} from "@kalcode/protocol";
import { displayStatusOf } from "@kalcode/protocol";
import type { EmitOptions } from "./dashboard.ts";

type Handler = (args: Record<string, unknown>) => unknown;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(error: IpcError): never {
  throw error;
}
const validation = (code: string, message: string): IpcError => ({
  category: "validation",
  code,
  message,
  retryable: false,
});
const rejected = (): IpcError => ({
  category: "internal",
  code: "ipc_rejected",
  message: "KalCode couldn't complete that request.",
  retryable: false,
});
/** Control and invisible formatting characters (names are shown verbatim). */
const invisible = (c: number) =>
  c <= 0x1f ||
  (c >= 0x7f && c <= 0x9f) ||
  (c >= 0x200b && c <= 0x200f) ||
  (c >= 0x202a && c <= 0x202e) ||
  (c >= 0x2066 && c <= 0x2069) ||
  c === 0xfeff;

function requireId(value: unknown): string {
  if (typeof value !== "string") fail(rejected());
  if (!UUID.test(value)) fail(validation("invalid_id", "That id isn't valid."));
  return value.toLowerCase();
}

// ------------------------------------------------------------------------------------------
// Query language (mirror of crates/locator/src/query.rs)
// ------------------------------------------------------------------------------------------

const ALIASES: readonly (readonly string[])[] = [
  ["auth", "authentication", "authorization", "login", "log in", "sign in", "signin", "oauth", "sso", "credentials"],
  ["database", "db", "sql", "sqlite", "postgres", "mysql", "schema", "migration"],
  ["test", "testing", "spec", "e2e", "coverage"],
  ["bug", "fix", "issue", "regression", "defect"],
  ["ui", "frontend", "front end", "interface", "css", "styling", "layout"],
  ["api", "endpoint", "backend", "server", "route", "graphql"],
  ["deploy", "deployment", "release", "ship", "publish", "pipeline"],
  ["docs", "documentation", "readme", "guide"],
  ["perf", "performance", "latency", "slow", "optimize", "optimise", "speed"],
  ["refactor", "cleanup", "clean up", "restructure", "rewrite"],
  ["config", "configuration", "settings", "setup", "environment"],
  ["deps", "dependency", "dependencies", "package", "upgrade", "bump"],
  ["billing", "payment", "stripe", "checkout", "subscription", "invoice"],
  ["notification", "alert", "email"],
  ["error", "exception", "crash", "panic"],
  ["security", "vulnerability", "xss", "csrf"],
  ["terminal", "shell", "console", "powershell", "bash"],
];
const STOP = new Set(
  "a an the my me i was were is are be been on in of to for about with that which what where when find show open search look looking all any some and or it its this from did do does had have has we you our your one ones thing things stuff please can could would at by up".split(
    " ",
  ),
);
const DROPPED = ["working on", "worked on", "work on", "was doing", "been doing", "left off"];
const KINDS: Record<string, LocatorEntityKind> = {
  thread: "thread",
  threads: "thread",
  session: "thread",
  sessions: "thread",
  conversation: "thread",
  conversations: "thread",
  chat: "thread",
  chats: "thread",
  workspace: "workspace",
  workspaces: "workspace",
  project: "workspace",
  projects: "workspace",
  folder: "workspace",
  folders: "workspace",
  repo: "workspace",
  repos: "workspace",
  repository: "workspace",
  repositories: "workspace",
  terminals: "terminal",
  shells: "terminal",
  provider: "provider",
  providers: "provider",
  activity: "activity",
  history: "activity",
};
const STATUSES: Record<string, LocatorStatusFilter> = {
  working: "working",
  running: "working",
  busy: "working",
  active: "working",
  waiting: "needs_you",
  blocked: "needs_you",
  stuck: "needs_you",
  approval: "needs_you",
  approvals: "needs_you",
  permission: "needs_you",
  done: "done",
  completed: "done",
  complete: "done",
  finished: "done",
  failed: "failed",
  failing: "failed",
  broken: "failed",
  crashed: "failed",
  idle: "idle",
  paused: "idle",
  stopped: "idle",
  archived: "archived",
};
const STATUS_PHRASES: [string, LocatorStatusFilter][] = [
  ["needs me", "needs_you"],
  ["needs you", "needs_you"],
  ["need me", "needs_you"],
  ["waiting for me", "needs_you"],
  ["in progress", "working"],
];
const RECENCY: [string, LocatorRecency][] = [
  ["this week", "this_week"],
  ["last week", "last_week"],
  ["past week", "this_week"],
  ["this month", "this_month"],
  ["today", "today"],
  ["tonight", "today"],
  ["yesterday", "yesterday"],
  ["recently", "this_week"],
  ["recent", "this_week"],
  ["lately", "this_week"],
];
const ACTIVE = ["right now", "currently", "now"];
const PROVIDERS: [string, string][] = [
  ["claude code", "claude-code"],
  ["claude", "claude-code"],
  ["codex", "codex"],
  ["gemini cli", "gemini-cli"],
  ["gemini", "gemini-cli"],
];

export interface TermGroup {
  term: string;
  alternatives: string[];
}

export interface Parsed {
  groups: TermGroup[];
  kinds: LocatorEntityKind[];
  statuses: LocatorStatusFilter[];
  providerId: string | null;
  recency: LocatorRecency | null;
  activeOnly: boolean;
  filterWords: string[];
}

export function stem(word: string): string | null {
  const len = [...word].length;
  const strip = (suffix: string, min: number) =>
    word.endsWith(suffix) && len > suffix.length && [...word.slice(0, -suffix.length)].length >= min
      ? word.slice(0, -suffix.length)
      : null;
  let out: string | null = strip("ing", 4);
  if (out === null) {
    const ied = strip("ied", 3) ?? strip("ies", 3);
    if (ied !== null) out = `${ied}y`;
  }
  out ??= strip("ed", 4);
  if (out === null) {
    const es = strip("es", 3);
    if (es && /[sxzh]$/.test(es)) out = es;
  }
  if (out === null) {
    const s = strip("s", 3);
    if (s && !/[sui]$/.test(s)) out = s;
  }
  return out !== null && out !== word && [...out].length >= 3 ? out : null;
}

export function groupFor(word: string): TermGroup {
  const alternatives = [word];
  const stemmed = stem(word);
  if (stemmed && !alternatives.includes(stemmed)) alternatives.push(stemmed);
  const group = ALIASES.find((g) => g.includes(word) || (stemmed !== null && g.includes(stemmed)));
  for (const alias of group ?? []) if (!alternatives.includes(alias)) alternatives.push(alias);
  return { term: word, alternatives };
}

const isDirect = (group: TermGroup, alt: string) => alt === group.term || stem(group.term) === alt;

function takePhrase(text: string, phrase: string): [string, boolean] {
  const padded = ` ${text} `;
  const needle = ` ${phrase} `;
  if (!padded.includes(needle)) return [text, false];
  return [padded.split(needle).join(" ").replace(/\s+/g, " ").trim(), true];
}

export function parseQuery(text: string): Parsed {
  const parsed: Parsed = {
    groups: [],
    kinds: [],
    statuses: [],
    providerId: null,
    recency: null,
    activeOnly: false,
    filterWords: [],
  };
  let rest = [...text]
    .slice(0, 256)
    .join("")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}"]+/gu, " ")
    .trim();
  const quoted: string[] = [];
  rest = rest.replace(/"([^"]*)"/g, (_, phrase: string) => {
    if (phrase.trim()) quoted.push(phrase.trim());
    return " ";
  });
  rest = rest.replace(/"/g, " ").replace(/\s+/g, " ").trim();
  const push = <T>(list: T[], item: T) => {
    if (!list.includes(item)) list.push(item);
  };
  for (const phrase of DROPPED) [rest] = takePhrase(rest, phrase);
  for (const [phrase, status] of STATUS_PHRASES) {
    const [next, hit] = takePhrase(rest, phrase);
    rest = next;
    if (hit) {
      push(parsed.statuses, status);
      parsed.filterWords.push(phrase);
    }
  }
  for (const [phrase, recency] of RECENCY) {
    const [next, hit] = takePhrase(rest, phrase);
    rest = next;
    if (hit) {
      parsed.recency ??= recency;
      parsed.filterWords.push(phrase);
    }
  }
  for (const phrase of ACTIVE) {
    const [next, hit] = takePhrase(rest, phrase);
    rest = next;
    if (hit) {
      parsed.activeOnly = true;
      parsed.filterWords.push(phrase);
    }
  }
  for (const [phrase, provider] of PROVIDERS) {
    const [next, hit] = takePhrase(rest, phrase);
    rest = next;
    if (hit) {
      parsed.providerId ??= provider;
      parsed.filterWords.push(phrase);
    }
  }
  const words: string[] = [];
  for (const word of rest.split(" ").filter(Boolean)) {
    const kind = KINDS[word];
    const status = STATUSES[word];
    if (kind) {
      push(parsed.kinds, kind);
      parsed.filterWords.push(word);
    } else if (status) {
      push(parsed.statuses, status);
      parsed.filterWords.push(word);
    } else if (!STOP.has(word)) words.push(word);
  }
  for (const phrase of quoted) {
    if (!parsed.groups.some((g) => g.term === phrase)) parsed.groups.push({ term: phrase, alternatives: [phrase] });
  }
  for (const word of words) if (!parsed.groups.some((g) => g.term === word)) parsed.groups.push(groupFor(word));
  parsed.groups = parsed.groups.slice(0, 8);
  return parsed;
}

// ------------------------------------------------------------------------------------------
// Index entries and ranking (mirror of crates/locator/src/index.rs)
// ------------------------------------------------------------------------------------------

interface Entry {
  kind: LocatorEntityKind;
  entityId: string;
  workspaceId: string | null;
  providerId: string | null;
  title: string;
  subtitle: string | null;
  status: string | null;
  updatedAt: string;
}

const CLASS: Record<LocatorStatusFilter, readonly string[]> = {
  working: ["starting", "working", "testing", "reviewing", "recovering", "running"],
  needs_you: ["permission_required", "waiting_for_you", "needs_you"],
  done: ["done"],
  failed: ["failed"],
  idle: ["idle", "paused", "offline", "ended"],
  archived: ["archived"],
};
const classOf = (status: string | null): LocatorStatusFilter | null =>
  status === null
    ? null
    : ((Object.entries(CLASS).find(([, list]) => list.includes(status))?.[0] as LocatorStatusFilter | undefined) ??
      null);

export function recencyWindow(recency: LocatorRecency, now: Date, offsetMinutes: number): [Date, Date] {
  const local = new Date(now.getTime() + offsetMinutes * 60_000);
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - offsetMinutes * 60_000;
  const day = 86_400_000;
  const weekday = (local.getUTCDay() + 6) % 7;
  const weekStart = midnight - weekday * day;
  const monthStart = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - offsetMinutes * 60_000;
  const range: Record<LocatorRecency, [number, number]> = {
    today: [midnight, midnight + day],
    yesterday: [midnight - day, midnight],
    this_week: [weekStart, midnight + day],
    last_week: [weekStart - 7 * day, weekStart],
    this_month: [monthStart, midnight + day],
  };
  const [start, end] = range[recency];
  return [new Date(start), new Date(end)];
}

function fieldQuality(field: string, alt: string): [number, number | null] {
  const f = field.toLowerCase();
  if (!alt || !f.includes(alt)) return [0, null];
  if (f === alt) return [1, 0];
  let best: [number, number | null] = [0, null];
  let at = f.indexOf(alt);
  while (at >= 0) {
    const starts = at === 0 || !/[\p{L}\p{N}]/u.test(f.charAt(at - 1));
    const end = at + alt.length;
    const ends = end >= f.length || !/[\p{L}\p{N}]/u.test(f.charAt(end));
    let q = starts && ends ? 0.95 : starts ? 0.72 : ends ? 0.5 : 0.45;
    if (at === 0) q += 0.03;
    if (q > best[0]) best = [q, at];
    at = f.indexOf(alt, at + 1);
  }
  return best;
}

function rank(entries: Entry[], parsed: Parsed, sort: "relevance" | "recency", now: Date): LocatorResult[] {
  const results: LocatorResult[] = [];
  const hasText = parsed.groups.length > 0;
  for (const entry of entries) {
    let total = 0;
    let matchedAll = true;
    const highlights: { start: number; end: number }[] = [];
    for (const group of parsed.groups) {
      let best = 0;
      let range: [number, number] | null = null;
      let typedInTitle = false;
      for (const alt of group.alternatives) {
        const weight = isDirect(group, alt) ? 1 : 0.85;
        const [q, pos] = fieldQuality(entry.title, alt);
        if (q > 0 && weight >= 1) typedInTitle = true;
        if (q * weight > best) {
          best = q * weight;
          range = pos === null ? null : [pos, pos + alt.length];
        }
        const [qs] = fieldQuality(entry.subtitle ?? "", alt);
        if (qs * 0.5 * weight > best) {
          best = qs * 0.5 * weight;
          range = null;
        }
      }
      if (best === 0) {
        matchedAll = false;
        break;
      }
      if (typedInTitle) best = Math.min(1, best + 0.15);
      total += best;
      if (range) highlights.push({ start: range[0], end: range[1] });
    }
    if (!matchedAll) continue;
    const hours = Math.max(0, now.getTime() - new Date(entry.updatedAt).getTime()) / 3_600_000;
    const recency = 0.5 ** (hours / 72);
    const status = { needs_you: 1, working: 0.85, failed: 0.7, idle: 0.45, done: 0.35, archived: 0 }[
      classOf(entry.status) ?? "idle"
    ];
    const kind = entry.kind === "thread" ? 1 : entry.kind === "workspace" ? 0.9 : entry.kind === "terminal" ? 0.6 : 0.4;
    const text = hasText ? total / parsed.groups.length : 0;
    const score = hasText
      ? 0.7 * text + 0.14 * recency + 0.1 * status + 0.06 * kind
      : 0.6 * recency + 0.25 * status + 0.15 * kind;
    results.push({
      kind: entry.kind,
      entityId: entry.entityId,
      title: entry.title,
      subtitle: entry.subtitle,
      status: entry.status,
      workspaceId: entry.workspaceId,
      providerId: entry.providerId,
      updatedAt: entry.updatedAt,
      snippet: null,
      score: Math.round(score * 1000) / 1000,
      semantic: false,
      highlights: highlights.sort((a, b) => a.start - b.start),
    });
  }
  results.sort((a, b) =>
    sort === "recency"
      ? b.updatedAt.localeCompare(a.updatedAt) || b.score - a.score
      : b.score - a.score || b.updatedAt.localeCompare(a.updatedAt),
  );
  return results;
}

// ------------------------------------------------------------------------------------------
// Greetings (mirror of crates/locator/src/home.rs)
// ------------------------------------------------------------------------------------------

type Daypart = "any" | "morning" | "afternoon" | "evening" | "night";
const POOL: [string, string, Daypart][] = [
  ["any-welcome", "Welcome back, {name}.", "any"],
  ["any-good-to-see", "Good to see you, {name}.", "any"],
  ["any-ready", "Ready when you are, {name}.", "any"],
  ["any-pick-up", "Let's pick up where you left off, {name}.", "any"],
  ["any-workspace-ready", "Your workspace is ready, {name}.", "any"],
  ["any-back-at-it", "Back at it, {name}.", "any"],
  ["any-state-of-play", "Here's where things stand, {name}.", "any"],
  ["any-where-you-left", "Everything is where you left it, {name}.", "any"],
  ["morning-good", "Good morning, {name}.", "morning"],
  ["morning-build", "Morning, {name}. Let's build.", "morning"],
  ["afternoon-good", "Good afternoon, {name}.", "afternoon"],
  ["afternoon-momentum", "Afternoon, {name}. Keep the momentum.", "afternoon"],
  ["evening-good", "Good evening, {name}.", "evening"],
  ["evening-state", "Evening, {name}. Here's the state of play.", "evening"],
  ["night-late", "Working late, {name}?", "night"],
  ["night-quiet", "The quiet hours, {name}. Let's make them count.", "night"],
];
const daypart = (hour: number): Daypart =>
  hour >= 5 && hour <= 11
    ? "morning"
    : hour >= 12 && hour <= 16
      ? "afternoon"
      : hour >= 17 && hour <= 21
        ? "evening"
        : "night";

export function chooseGreeting(
  hour: number,
  name: string | null,
  firstRun: boolean,
  history: string[],
  seed: number,
): [string | null, string] {
  const trimmed = name?.trim() ?? "";
  if (!trimmed) return [null, firstRun ? "Welcome to KalCode." : "Welcome back."];
  if (firstRun) return [null, `Welcome to KalCode, ${trimmed}.`];
  const part = daypart(hour);
  const recent = history.slice(-5);
  let candidates = POOL.filter(([id, , when]) => (when === "any" || when === part) && !recent.includes(id));
  if (candidates.length === 0) candidates = POOL.filter(([, , when]) => when === "any" || when === part);
  const [id, template] = candidates[Math.abs(seed) % candidates.length] as [string, string, Daypart];
  return [id, template.replace("{name}", trimmed)];
}

// ------------------------------------------------------------------------------------------
// Fixtures for the `rail` and `home` scenarios
// ------------------------------------------------------------------------------------------

interface RailRow {
  name: string | null;
  groupId: string | null;
  pinnedAt: string | null;
  archivedAt: string | null;
  position: number | null;
  collapsed: boolean;
  indexMessages: boolean;
}

const emptyRow = (): RailRow => ({
  name: null,
  groupId: null,
  pinnedAt: null,
  archivedAt: null,
  position: null,
  collapsed: false,
  indexMessages: false,
});

export interface RailMemoryOptions {
  scenario: string;
  emit: (event: EventPayload, options?: EmitOptions) => EventEnvelope;
  events: () => readonly EventEnvelope[];
  requireCore: () => void;
  settings: () => Settings;
  setDisplayName: (name: string) => void;
  workspaceHandlers: Record<string, Handler>;
  queueFolders: (...folders: (string | null)[]) => void;
  makeUnavailable: (name: string) => void;
  threadHandlers: Record<string, Handler>;
  seedThread: (summary: ThreadSummary) => ThreadSummary;
  providers: () => readonly ProviderStatus[];
}

export interface RailMemory {
  handlers: Record<string, Handler>;
}

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

function fixtureThread(
  name: string,
  providerId: string,
  workspace: Workspace,
  status: ThreadSummary["status"],
  minutes: number,
  extra: Partial<ThreadSummary> = {},
): ThreadSummary {
  const providerName = providerId === "codex" ? "Codex" : providerId === "gemini-cli" ? "Gemini CLI" : "Claude Code";
  return {
    id: crypto.randomUUID(),
    name,
    providerId,
    providerName,
    model: providerId === "claude-code" ? "sonnet" : null,
    effort: null,
    providerAccountId: null,
    accountLabel: "Personal",
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    permissionMode: "approve",
    status,
    currentActivity: null,
    createdAt: minutesAgo(minutes + 45),
    lastActivityAt: minutesAgo(minutes),
    pendingApprovals: status === "waiting_for_permission" ? 1 : 0,
    unreadMessages: 0,
    filesChanged: null,
    branch: null,
    error: status === "failed" ? { code: "provider_exited", message: "Claude Code exited unexpectedly." } : null,
    archivedAt: null,
    resumable: status === "interrupted" || status === "paused",
    permissionProfileId: null,
    runtimeKind: null,
    terminalId: null,
    worktreeId: null,
    ...extra,
  };
}

// ------------------------------------------------------------------------------------------
// Files and Git (Z6a read-only) fixtures
// ------------------------------------------------------------------------------------------

const TREE: Record<string, string[]> = {
  "": [
    "src/",
    "docs/",
    "tests/",
    ".github/",
    "node_modules/",
    "README.md",
    "package.json",
    "tsconfig.json",
    ".gitignore",
  ],
  "src/": ["auth/", "rail/", "index.ts", "server.ts", "config.ts"],
  "src/auth/": ["callback.ts", "session.ts", "tokens.ts"],
  "src/rail/": ["RailTree.tsx", "model.ts"],
  "docs/": ["ARCHITECTURE.md", "SECURITY.md"],
  "tests/": ["auth.spec.ts", "rail.spec.ts"],
  ".github/": ["workflows/"],
  ".github/workflows/": ["ci.yml"],
  "node_modules/": [],
};
const IGNORED = new Set(["node_modules/"]);

// ------------------------------------------------------------------------------------------
// The memory runtime
// ------------------------------------------------------------------------------------------

export function createRailMemory(options: RailMemoryOptions): RailMemory {
  const { requireCore, emit } = options;
  const rows = new Map<string, RailRow>();
  let groups: WorkspaceGroup[] = [];
  let collapsedSections: RailSection[] = [];
  let greetingHistory: string[] = [];
  let lastGreeting: { name: string | null; firstRun: boolean; text: string } | null = null;
  let lastSeenSeq = 0;
  let homeBaseline: number | null = null;
  let seed = 7;

  const row = (id: string): RailRow => {
    let r = rows.get(id);
    if (!r) {
      r = emptyRow();
      rows.set(id, r);
    }
    return r;
  };
  const workspaces = () => (options.workspaceHandlers.workspace_list?.({}) ?? []) as Workspace[];
  const activeId = () => ((options.workspaceHandlers.workspace_active?.({}) ?? null) as Workspace | null)?.id ?? null;
  const threads = () =>
    (options.threadHandlers.thread_list?.({ workspaceId: null, includeArchived: true }) ?? []) as ThreadSummary[];
  const terminals = (workspaceId: string) =>
    (options.workspaceHandlers.terminal_list?.({ workspaceId }) ?? []) as TerminalInfo[];
  const isWorking = (t: ThreadSummary) => displayStatusOf(t.status).chip === "working";
  const needsYou = (t: ThreadSummary) => displayStatusOf(t.status).chip === "waiting_for_you";

  const entryFor = (w: Workspace, all: ThreadSummary[], active: string | null): WorkspaceRailEntry => {
    const r = rows.get(w.id) ?? emptyRow();
    const own = all.filter((t) => t.workspaceId === w.id && t.archivedAt === null);
    const byProvider = new Map<string, ThreadSummary[]>();
    for (const t of own) byProvider.set(t.providerId, [...(byProvider.get(t.providerId) ?? []), t]);
    const providers: ProviderRow[] = [...byProvider.entries()]
      .map(([providerId, list]) => {
        const sorted = [...list].sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
        return {
          providerId,
          providerName: sorted[0]?.providerName ?? providerId,
          threads: list.length,
          working: list.filter(isWorking).length,
          needsYou: list.filter(needsYou).length,
          items: sorted.slice(0, 25).map(
            (t): RailThread => ({
              id: t.id,
              name: t.name,
              status: t.status,
              resumable: t.resumable,
              lastActivityAt: t.lastActivityAt,
              pendingApprovals: t.pendingApprovals,
            }),
          ),
        };
      })
      .sort(
        (a, b) => b.needsYou + b.working - (a.needsYou + a.working) || a.providerName.localeCompare(b.providerName),
      );
    const lastThread = own
      .map((t) => t.lastActivityAt)
      .sort()
      .at(-1);
    return {
      workspaceId: w.id,
      name: r.name ?? w.name,
      folderName: w.name,
      displayPath: w.displayPath,
      location: "local",
      available: w.available,
      active: active === w.id,
      pinned: r.pinnedAt !== null,
      archived: r.archivedAt !== null,
      groupId: r.groupId,
      collapsed: r.collapsed,
      indexMessages: r.indexMessages,
      providers,
      threads: own.length,
      working: providers.reduce((n, p) => n + p.working, 0),
      needsYou: providers.reduce((n, p) => n + p.needsYou, 0),
      lastOpenedAt: w.lastOpenedAt,
      lastActivityAt: lastThread && lastThread > w.lastOpenedAt ? lastThread : w.lastOpenedAt,
    };
  };

  const railState = (): RailState => {
    const all = threads();
    const active = activeId();
    const known = new Set(workspaces().map((w) => w.id));
    for (const id of rows.keys()) if (!known.has(id)) rows.delete(id);
    const entries = workspaces().map((w) => entryFor(w, all, active));
    const groupIds = new Set(groups.map((g) => g.id));
    const pinned = entries
      .filter((e) => e.pinned && !e.archived)
      .sort(
        (a, b) =>
          (rows.get(a.workspaceId)?.position ?? 1e9) - (rows.get(b.workspaceId)?.position ?? 1e9) ||
          (rows.get(a.workspaceId)?.pinnedAt ?? "").localeCompare(rows.get(b.workspaceId)?.pinnedAt ?? ""),
      );
    const grouped: RailGroupView[] = groups.map((group) => ({
      group,
      workspaces: entries
        .filter((e) => !e.pinned && !e.archived && e.groupId === group.id)
        .sort(
          (a, b) =>
            (rows.get(a.workspaceId)?.position ?? 1e9) - (rows.get(b.workspaceId)?.position ?? 1e9) ||
            a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
        ),
    }));
    const recent = entries
      .filter((e) => !e.pinned && !e.archived && !(e.groupId && groupIds.has(e.groupId)))
      .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
    const archived = entries
      .filter((e) => e.archived)
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    return { pinned, recent, groups: grouped, archived, collapsedSections: [...collapsedSections], persistent: true };
  };

  const validName = (raw: unknown, max = 80): string | null => {
    if (typeof raw !== "string") fail(rejected());
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if ([...trimmed].length > max) fail(validation("name_too_long", `Names can be at most ${max} characters.`));
    if ([...trimmed].some((ch) => invisible(ch.codePointAt(0) ?? 0)))
      fail(validation("name_invalid", "Names can't contain control or invisible formatting characters."));
    return trimmed;
  };

  const workspaceOr404 = (id: string) =>
    workspaces().find((w) => w.id === id) ?? fail(validation("workspace_unknown", "That workspace no longer exists."));

  const siblingsOf = (id: string): string[] => {
    const r = row(id);
    const ids = [...rows.entries()]
      .filter(([, other]) =>
        r.pinnedAt !== null
          ? other.pinnedAt !== null
          : r.groupId !== null && other.groupId === r.groupId && other.pinnedAt === null,
      )
      .sort(([, a], [, b]) => (a.position ?? 1e9) - (b.position ?? 1e9))
      .map(([key]) => key);
    return ids;
  };

  // ---- locator ----
  const entries = (): Entry[] => {
    const all = threads();
    const ws = workspaces();
    const out: Entry[] = [];
    for (const t of all) {
      out.push({
        kind: "thread",
        entityId: t.id,
        workspaceId: t.workspaceId,
        providerId: t.providerId,
        title: t.name,
        subtitle: `${t.providerName} · ${t.workspaceName}${t.model ? ` · ${t.model}` : ""}`,
        status: t.archivedAt ? "archived" : displayStatusOf(t.status).status,
        updatedAt: t.lastActivityAt,
      });
    }
    for (const w of ws) {
      const r = rows.get(w.id) ?? emptyRow();
      out.push({
        kind: "workspace",
        entityId: w.id,
        workspaceId: w.id,
        providerId: null,
        title: r.name ?? w.name,
        subtitle: `Workspace · ${w.displayPath}${r.name ? ` · folder ${w.name}` : ""}`,
        status: r.archivedAt ? "archived" : w.available ? "available" : "missing",
        updatedAt: w.lastOpenedAt,
      });
      for (const term of terminals(w.id)) {
        const running = term.status === "running";
        out.push({
          kind: "terminal",
          entityId: term.id,
          workspaceId: w.id,
          providerId: null,
          title: term.title,
          subtitle: `Terminal · ${w.name} · ${running ? "running" : "ended"}`,
          status: running ? "running" : "ended",
          updatedAt: term.endedAt ?? term.startedAt ?? w.lastOpenedAt,
        });
      }
    }
    for (const p of options.providers()) {
      const d = p.detection;
      const [status, detail] = !d
        ? ["unknown", "Not checked yet"]
        : d.state === "not_installed"
          ? ["not_installed", "Not installed"]
          : d.state === "outdated"
            ? ["outdated", "Update needed"]
            : d.auth === "not_authenticated"
              ? ["signed_out", "Installed · signed out"]
              : ["ready", d.auth === "authenticated" ? "Installed · signed in" : "Installed"];
      out.push({
        kind: "provider",
        entityId: p.id,
        workspaceId: null,
        providerId: p.id,
        title: p.displayName,
        subtitle: `Provider · ${detail}`,
        status: status ?? null,
        updatedAt: d?.checkedAt ?? new Date().toISOString(),
      });
    }
    const byId = new Map(all.map((t) => [t.id, t]));
    for (const event of options.events().slice(-500)) {
      let title: string | null = null;
      let workspaceId = event.correlation.workspaceId;
      if (event.type === "thread.completed" || event.type === "thread.failed" || event.type === "approval.requested") {
        const t = byId.get((event.payload as { threadId: string }).threadId);
        if (!t) continue;
        const verb =
          event.type === "thread.completed"
            ? "Completed"
            : event.type === "thread.failed"
              ? "Failed"
              : "Approval requested";
        title = `${verb} · ${t.name}`;
        workspaceId ??= t.workspaceId;
      } else if (event.type === "workspace.created" || event.type === "workspace.opened") {
        title = `${event.type === "workspace.created" ? "Added workspace" : "Opened workspace"} · ${event.payload.name}`;
      }
      if (!title) continue;
      out.push({
        kind: "activity",
        entityId: event.id,
        workspaceId,
        providerId: event.correlation.providerId,
        title,
        subtitle: "Activity",
        status: null,
        updatedAt: event.occurredAt,
      });
    }
    return out;
  };

  const search = (query: LocatorQuery): LocatorResponse => {
    requireCore();
    const page = query.page ?? { limit: 20, cursor: null };
    if (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > 100)
      fail(validation("invalid_page_size", "Page size must be between 1 and 100."));
    if (query.workspaceId !== null) requireId(query.workspaceId);
    if (query.tzOffsetMinutes < -840 || query.tzOffsetMinutes > 840)
      fail(validation("invalid_offset", "That time zone offset isn't valid."));
    const now = new Date();
    const parsed = parseQuery(query.text);
    const run = (p: Parsed) => {
      const kinds = [...new Set([...query.kinds, ...p.kinds])];
      const statuses = [...new Set([...query.statuses, ...p.statuses])];
      const recency = query.recency ?? p.recency;
      const provider = query.providerId ?? p.providerId;
      const activeOnly = query.activeOnly || p.activeOnly;
      let allowed: string[] | null = statuses.length ? statuses.flatMap((s) => [...CLASS[s]]) : null;
      if (activeOnly) {
        const active = [...CLASS.working, ...CLASS.needs_you];
        allowed = allowed ? allowed.filter((s) => active.includes(s)) : active;
      }
      const window = recency ? recencyWindow(recency, now, query.tzOffsetMinutes) : null;
      const filtered = entries().filter(
        (e) =>
          (kinds.length === 0 || kinds.includes(e.kind)) &&
          (allowed ? e.status !== null && allowed.includes(e.status) : e.status !== "archived") &&
          (!provider || e.providerId === provider) &&
          (!query.workspaceId || e.workspaceId === query.workspaceId) &&
          (!query.since || e.updatedAt >= query.since) &&
          (!window || (e.updatedAt >= window[0].toISOString() && e.updatedAt < window[1].toISOString())),
      );
      const interpretation: LocatorInterpretation = {
        terms: p.groups.map((g) => g.term),
        expanded: p.groups.flatMap((g) => g.alternatives.filter((a) => !isDirect(g, a))),
        kinds,
        statuses,
        recency,
        providerId: provider,
        activeOnly,
      };
      return { results: rank(filtered, p, query.sort, now), interpretation };
    };
    let outcome = run(parsed);
    if (outcome.results.length === 0 && parsed.filterWords.length > 0) {
      const asTerms: Parsed = {
        ...parsed,
        kinds: [],
        statuses: [],
        providerId: null,
        recency: null,
        activeOnly: false,
        groups: [...parsed.groups, ...parsed.filterWords.map(groupFor)].slice(0, 8),
      };
      const dropped: Parsed = { ...asTerms, groups: parsed.groups };
      for (const retry of [asTerms, dropped]) {
        if (retry.groups.length === 0) continue;
        const next = run(retry);
        if (next.results.length > 0) {
          outcome = next;
          break;
        }
      }
    }
    const offset = page.cursor ? Number(page.cursor) : 0;
    const items = outcome.results.slice(offset, offset + page.limit);
    const end = offset + items.length;
    return {
      results: {
        items,
        nextCursor: end < outcome.results.length ? String(end) : null,
        totalEstimate: outcome.results.length,
      },
      interpreted: outcome.interpretation,
      index: { entries: entries().length, ready: true, persistent: true },
    };
  };

  // ---- recent work ----
  const recentFrom = (events: readonly EventEnvelope[]): RecentWorkItem[] => {
    const all = threads();
    const byId = new Map(all.map((t) => [t.id, t]));
    const ws = new Map(workspaces().map((w) => [w.id, w]));
    const items = new Map<string, RecentWorkItem>();
    const push = (key: string, item: RecentWorkItem) => {
      const existing = items.get(key);
      if (!existing) items.set(key, item);
      else if (item.lastActivityAt > existing.lastActivityAt) existing.lastActivityAt = item.lastActivityAt;
    };
    for (const event of events) {
      const payload = event.payload as { threadId?: string; path?: string } | undefined;
      const threadId = event.correlation.threadId ?? payload?.threadId ?? null;
      const t = threadId ? byId.get(threadId) : undefined;
      if (t) {
        push(`thread:${t.id}`, {
          kind: "thread",
          id: t.id,
          title: t.name,
          workspaceId: t.workspaceId,
          workspaceName: t.workspaceName,
          providerId: t.providerId,
          providerName: t.providerName,
          status: t.status,
          resumable: t.resumable,
          lastActivityAt: event.occurredAt,
        });
      }
      const w = ws.get(event.correlation.workspaceId ?? t?.workspaceId ?? "");
      if (event.type.startsWith("file.") && payload?.path) {
        push(`file:${w?.id ?? ""}:${payload.path}`, {
          kind: "file",
          id: `${w?.id ?? ""}:${payload.path}`,
          title: payload.path,
          workspaceId: w?.id ?? null,
          workspaceName: w?.name ?? null,
          providerId: null,
          providerName: null,
          status: null,
          lastActivityAt: event.occurredAt,
        });
      }
      if (w) {
        push(`workspace:${w.id}`, {
          kind: "workspace",
          id: w.id,
          title: w.name,
          workspaceId: w.id,
          workspaceName: w.name,
          providerId: null,
          providerName: null,
          status: null,
          lastActivityAt: event.occurredAt,
        });
      }
    }
    return [...items.values()].sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  };
  const WORK =
    /^(thread\.|agent\.message|tool\.|file\.|approval\.|workspace\.created|workspace\.opened|shell\.started)/;
  const threadItem = (t: ThreadSummary): RecentWorkItem => ({
    kind: "thread",
    id: t.id,
    title: t.name,
    workspaceId: t.workspaceId,
    workspaceName: t.workspaceName,
    providerId: t.providerId,
    providerName: t.providerName,
    status: t.status,
    resumable: t.resumable,
    lastActivityAt: t.lastActivityAt,
  });

  // ---- files and Git ----
  const handlePath = new Map<string, string>();
  const listDir = (workspaceId: string, dir: string): FileEntry[] =>
    (TREE[dir] ?? []).map((name) => {
      const path = `${dir}${name}`;
      const id = `fh-${workspaceId.slice(0, 8)}-${btoa(path).replace(/=+$/, "")}`;
      handlePath.set(id, path);
      const isDir = name.endsWith("/");
      return {
        file: { handle: { id }, workspaceId, displayPath: isDir ? path.slice(0, -1) : path },
        isDir,
        bytes: isDir ? null : 800 + path.length * 97,
        ignored: IGNORED.has(path),
      };
    });

  const handlers: Record<string, Handler> = {
    rail_state: () => {
      requireCore();
      return railState();
    },
    rail_update: (args) => {
      requireCore();
      const update = args.update as Record<string, unknown> | undefined;
      if (!update || typeof update !== "object") fail(rejected());
      const allowed = [
        "workspaceId",
        "pinned",
        "groupId",
        "position",
        "collapsed",
        "archived",
        "name",
        "indexMessages",
      ];
      if (Object.keys(update).some((k) => !allowed.includes(k))) fail(rejected());
      const id = requireId(update.workspaceId);
      const workspace = workspaceOr404(id);
      const r = row(id);
      const at = new Date().toISOString();
      if (update.name !== undefined) r.name = validName(update.name);
      if (update.groupId !== undefined) {
        const target = update.groupId === "" ? null : requireId(update.groupId);
        if (target && !groups.some((g) => g.id === target))
          fail(validation("group_not_found", "That folder no longer exists."));
        if (target !== r.groupId) {
          r.groupId = target;
          r.position = target
            ? Math.max(-1, ...[...rows.values()].filter((o) => o.groupId === target).map((o) => o.position ?? -1)) + 1
            : null;
        }
      }
      if (typeof update.pinned === "boolean" && update.pinned !== (r.pinnedAt !== null)) {
        if (update.pinned) {
          r.pinnedAt = at;
          r.archivedAt = null;
          r.position =
            Math.max(
              -1,
              ...[...rows.values()].filter((o) => o.pinnedAt !== null && o !== r).map((o) => o.position ?? -1),
            ) + 1;
        } else r.pinnedAt = null;
      }
      if (typeof update.position === "number") {
        const ids = siblingsOf(id).filter((s) => s !== id);
        ids.splice(Math.max(0, Math.min(ids.length, update.position)), 0, id);
        ids.forEach((s, i) => {
          row(s).position = i;
        });
      }
      if (typeof update.collapsed === "boolean") r.collapsed = update.collapsed;
      if (typeof update.archived === "boolean" && update.archived !== (r.archivedAt !== null)) {
        r.archivedAt = update.archived ? at : null;
        if (update.archived) r.pinnedAt = null;
      }
      if (typeof update.indexMessages === "boolean") r.indexMessages = update.indexMessages;
      return entryFor(workspace, threads(), activeId());
    },
    rail_section_set: (args) => {
      requireCore();
      const section = args.section as RailSection;
      if (!["pinned", "recent", "folders", "archived", "rail"].includes(section)) fail(rejected());
      collapsedSections = collapsedSections.filter((s) => s !== section);
      if (args.collapsed === true) collapsedSections.push(section);
      return railState();
    },
    rail_group_create: (args) => {
      requireCore();
      const name = validName(args.name) ?? fail(validation("name_required", "Give the folder a name."));
      const group: WorkspaceGroup = {
        id: crypto.randomUUID(),
        name,
        position: groups.length,
        collapsed: false,
      };
      groups = [...groups, group];
      return group;
    },
    rail_group_update: (args) => {
      requireCore();
      const id = requireId(args.id);
      const group =
        groups.find((g) => g.id === id) ?? fail(validation("group_not_found", "That folder no longer exists."));
      const name =
        args.name === null || args.name === undefined
          ? group.name
          : (validName(args.name) ?? fail(validation("name_required", "Give the folder a name.")));
      const next = {
        ...group,
        name,
        collapsed: typeof args.collapsed === "boolean" ? args.collapsed : group.collapsed,
      };
      groups = groups.map((g) => (g.id === id ? next : g));
      return next;
    },
    rail_group_delete: (args) => {
      requireCore();
      const id = requireId(args.id);
      if (!groups.some((g) => g.id === id)) fail(validation("group_not_found", "That folder no longer exists."));
      for (const r of rows.values()) {
        if (r.groupId === id) {
          r.groupId = null;
          r.position = null;
        }
      }
      groups = groups.filter((g) => g.id !== id);
      return undefined;
    },
    rail_group_reorder: (args) => {
      requireCore();
      const ids = (Array.isArray(args.ids) ? args.ids : fail(rejected())).map(requireId);
      if (
        new Set(ids).size !== ids.length ||
        ids.length !== groups.length ||
        ids.some((i) => !groups.some((g) => g.id === i))
      )
        fail(validation("groups_mismatch", "The folder list changed. Try again."));
      groups = ids.map((id, position) => ({ ...(groups.find((g) => g.id === id) as WorkspaceGroup), position }));
      return groups;
    },
    locator_search: (args) => search(args.query as LocatorQuery),
    locator_open: (args) => {
      requireCore();
      const { kind, entityId, via } = (args.args ?? {}) as { kind: LocatorEntityKind; entityId: string; via: string };
      if (!["palette", "rail", "home", "voice"].includes(via)) fail(rejected());
      const notFound = () => fail(validation("not_found", "That item no longer exists."));
      const target: LocatorOpenTarget = {
        kind,
        entityId,
        workspaceId: null,
        threadId: null,
        terminalId: null,
        providerId: null,
      };
      if (kind === "thread") {
        const t = threads().find((x) => x.id === entityId) ?? notFound();
        return { ...target, workspaceId: t.workspaceId, threadId: t.id, providerId: t.providerId };
      }
      if (kind === "workspace") {
        const w = workspaces().find((x) => x.id === entityId) ?? notFound();
        return { ...target, workspaceId: w.id };
      }
      if (kind === "terminal") {
        for (const w of workspaces()) {
          const term = terminals(w.id).find((x) => x.id === entityId);
          if (term) return { ...target, workspaceId: w.id, terminalId: term.id };
        }
        return notFound();
      }
      if (kind === "provider") {
        return options.providers().some((p) => p.id === entityId) ? { ...target, providerId: entityId } : notFound();
      }
      if (kind === "activity") {
        const event = options.events().find((e) => e.id === entityId) ?? notFound();
        return { ...target, workspaceId: event.correlation.workspaceId, threadId: event.correlation.threadId };
      }
      return notFound();
    },
    home_summary: (args) => {
      requireCore();
      const hour = args.localHour;
      if (typeof hour !== "number" || !Number.isInteger(hour) || hour < 0 || hour > 255) fail(rejected());
      if (hour > 23) fail(validation("invalid_hour", "That hour isn't valid."));
      const all = threads();
      const ws = workspaces();
      const firstRun = ws.length === 0 && all.length === 0;
      const name = options.settings().displayName ?? null;
      let greeting: string;
      if (args.visit === false && lastGreeting && lastGreeting.name === name && lastGreeting.firstRun === firstRun) {
        greeting = lastGreeting.text;
      } else {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        const [id, text] = chooseGreeting(hour, name, firstRun, greetingHistory, seed);
        if (id) greetingHistory = [...greetingHistory, id].slice(-10);
        greeting = text;
        lastGreeting = { name, firstRun, text };
      }
      const events = options.events();
      const starts = events.filter((e) => e.type === "app.started");
      const previous = starts.at(-2);
      const current = starts.at(-1);
      const lastSession =
        previous && current
          ? recentFrom(
              events.filter((e) => e.seq >= previous.seq && e.seq < current.seq && WORK.test(e.type)).reverse(),
            )
              .filter((i) => i.kind !== "file")
              .slice(0, 8)
          : [];
      homeBaseline ??= lastSeenSeq;
      const byId = new Map(all.map((t) => [t.id, t]));
      const finished: RecentWorkItem[] = [];
      for (const event of [...events].reverse()) {
        if (event.seq <= homeBaseline || event.type !== "thread.completed") continue;
        const t = byId.get(event.payload.threadId);
        if (t && !finished.some((f) => f.id === t.id))
          finished.push({ ...threadItem(t), lastActivityAt: event.occurredAt });
      }
      lastSeenSeq = events.at(-1)?.seq ?? 0;
      const open = all
        .filter((t) => t.archivedAt === null)
        .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
      const state = railState();
      const recentWorkspaces = [...state.pinned, ...state.groups.flatMap((g) => g.workspaces), ...state.recent]
        .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.lastActivityAt.localeCompare(a.lastActivityAt))
        .slice(0, 6);
      return {
        greeting,
        displayName: options.settings().displayName ?? null,
        firstRun,
        lastSession,
        running: open.filter(isWorking).slice(0, 8).map(threadItem),
        runningCount: open.filter(isWorking).length,
        needsYou: open.filter(needsYou).slice(0, 8).map(threadItem),
        needsYouCount: open.filter(needsYou).length,
        finishedSinceLastVisit: finished.slice(0, 8),
        resumable: open
          .filter((t) => t.status === "interrupted" || t.status === "paused" || (t.status === "failed" && t.resumable))
          .slice(0, 8)
          .map(threadItem),
        recentWorkspaces,
        workspaceCount: ws.length,
        threadCount: open.length,
      } satisfies HomeSummary;
    },
    recent_work: (args) => {
      requireCore();
      const when = args.when as RecentWorkWhen;
      if (!["today", "yesterday", "this_week"].includes(when)) fail(rejected());
      const offset = args.tzOffsetMinutes;
      if (typeof offset !== "number" || offset < -840 || offset > 840)
        fail(validation("invalid_offset", "That time zone offset isn't valid."));
      const page = args.page as { limit: number; cursor: string | null };
      const [from, to] = recencyWindow(when, new Date(), offset);
      const inWindow = options
        .events()
        .filter((e) => WORK.test(e.type) && e.occurredAt >= from.toISOString() && e.occurredAt < to.toISOString())
        .reverse();
      const items = recentFrom(inWindow);
      const start = page.cursor ? Number(page.cursor) : 0;
      const slice = items.slice(start, start + page.limit);
      return {
        items: slice,
        nextCursor: start + slice.length < items.length ? String(start + slice.length) : null,
        totalEstimate: items.length,
      } satisfies Page<RecentWorkItem>;
    },
    workspace_reveal: (args) => {
      requireCore();
      const w = workspaceOr404(requireId(args.workspaceId));
      if (!w.available)
        fail({
          category: "filesystem",
          code: "folder_missing",
          message: "That folder was moved or deleted outside KalCode.",
          retryable: false,
        });
      return undefined;
    },
    workspace_create: (args) => {
      requireCore();
      if (typeof args.name !== "string") fail(rejected());
      const name = args.name.trim();
      const badChar = [...name].some((ch) => '<>:"/\\|?*'.includes(ch) || (ch.codePointAt(0) ?? 0) <= 0x1f);
      if (!name || badChar || /[. ]$/.test(name) || [...name].length > 80)
        fail(validation("invalid_folder_name", "That isn't a valid folder name."));
      if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(name))
        fail(validation("invalid_folder_name", "That name is reserved by Windows."));
      if (workspaces().some((w) => w.name.toLowerCase() === name.toLowerCase()))
        fail({
          category: "filesystem",
          code: "folder_exists",
          message: "A folder with that name already exists there. Open it with Open folder instead.",
          retryable: false,
        });
      options.queueFolders(name);
      return options.workspaceHandlers.workspace_open_dialog?.({}) ?? null;
    },
    files_list: (args) => {
      requireCore();
      const a = (args.args ?? {}) as { workspaceId: string; dir: { id: string } | null; page: { limit: number } };
      const w = workspaceOr404(requireId(a.workspaceId));
      if (!w.available)
        fail({
          category: "filesystem",
          code: "folder_not_found",
          message: "That folder no longer exists.",
          retryable: false,
        });
      const dir = a.dir
        ? (handlePath.get(a.dir.id) ?? fail(validation("stale_handle", "That file list is out of date.")))
        : "";
      const items = listDir(w.id, dir);
      return {
        items: items.slice(0, a.page.limit),
        nextCursor: null,
        totalEstimate: items.length,
      } satisfies Page<FileEntry>;
    },
    utility_file_read: (args) => {
      requireCore();
      const w = workspaceOr404(requireId(args.workspaceId));
      const handle = args.handle as { id?: string } | undefined;
      const path = handle?.id ? handlePath.get(handle.id) : undefined;
      if (!path || path.endsWith("/")) fail(validation("stale_handle", "That file is no longer available."));
      const text = `// ${path}\n// Preview content from the UI test workspace.\nexport const workspace = ${JSON.stringify(w.name)};\n`;
      return { file: { handle, workspaceId: w.id, displayPath: path }, text, bytes: text.length, truncated: false };
    },
    git_status: (args) => {
      requireCore();
      const a = (args.args ?? {}) as { workspaceId: string };
      const w = workspaceOr404(requireId(a.workspaceId));
      const plain = w.name.includes("notes") || w.name.includes("scratch");
      if (plain) {
        return {
          repository: false,
          summary: null,
          branch: null,
          files: { items: [], nextCursor: null, totalEstimate: 0 },
          truncated: false,
        };
      }
      const file = (path: string, change: StatusFile["unstaged"], untracked = false): StatusFile => {
        const id = `st-${w.id}-${btoa(path)}`;
        handlePath.set(id, path);
        return {
          file: { handle: { id }, workspaceId: w.id, displayPath: path },
          path,
          origPath: null,
          staged: null,
          unstaged: change,
          untracked,
          conflict: null,
          submodule: false,
        };
      };
      const files = [
        file("src/auth/callback.ts", "modified"),
        file("src/auth/session.ts", "modified"),
        file("tests/auth.spec.ts", "added"),
        file("docs/notes-draft.md", null, true),
      ];
      return {
        repository: true,
        summary: {
          workspaceId: w.id,
          branch: "feature/oauth-race",
          head: "4c8d2f1",
          changed: 3,
          untracked: 1,
          ahead: 2,
          behind: 0,
        },
        branch: {
          headOid: "4c8d2f1a9e",
          branch: "feature/oauth-race",
          upstream: "origin/feature/oauth-race",
          ahead: 2,
          behind: 0,
        },
        files: { items: files, nextCursor: null, totalEstimate: files.length },
        truncated: false,
      };
    },
    git_log: (args) => {
      requireCore();
      const a = (args.args ?? {}) as { workspaceId: string };
      workspaceOr404(requireId(a.workspaceId));
      const commit = (oid: string, subject: string, minutes: number): Commit => ({
        oid,
        parents: [],
        authorName: "You",
        authorEmail: "you@example.com",
        authoredAt: minutesAgo(minutes),
        committedAt: minutesAgo(minutes),
        subject,
      });
      const items = [
        commit("4c8d2f1a9e", "Check the OAuth state before writing the session", 42),
        commit("a17be09c11", "Stream terminal output over raw channels", 60 * 5),
        commit("9f03c44b2d", "Keep tabs alive while switching", 60 * 26),
        commit("5e2a7d0e71", "Design terminal palettes for both themes", 60 * 50),
      ];
      return { items, nextCursor: null, totalEstimate: items.length } satisfies Page<Commit>;
    },
    git_branches: (args) => {
      requireCore();
      const a = (args.args ?? {}) as { workspaceId: string };
      workspaceOr404(requireId(a.workspaceId));
      const branch = (name: string, current: boolean, kind: Branch["kind"] = "local"): Branch => ({
        name,
        kind,
        oid: "4c8d2f1a9e",
        upstream: kind === "local" ? `origin/${name}` : null,
        ahead: current ? 2 : 0,
        behind: 0,
        upstreamGone: false,
        current,
      });
      return [branch("feature/oauth-race", true), branch("main", false), branch("origin/main", false, "remote")];
    },
  };

  // ---- scenario fixtures ----
  if (options.scenario === "rail" || options.scenario === "home") {
    const names = [
      "kalcode",
      "atlas-api",
      "orbit-web",
      "billing-service",
      "design-notes",
      "infra-terraform",
      "mobile-app",
      "data-pipeline",
      "docs-site",
      "client-portal",
      "scratch-experiments",
      "old-prototype",
    ];
    options.queueFolders(...names);
    const opened = new Map<string, Workspace>();
    for (const _ of names) {
      const w = options.workspaceHandlers.workspace_open_dialog?.({}) as Workspace | null;
      if (w) opened.set(w.name, w);
    }
    options.makeUnavailable("old-prototype");
    const ws = (name: string) => opened.get(name) as Workspace;
    // The kalcode workspace is the active one.
    options.workspaceHandlers.workspace_activate?.({ workspaceId: ws("kalcode").id });
    const seedThread = (...args: Parameters<typeof fixtureThread>) => options.seedThread(fixtureThread(...args));
    const auth = seedThread("Authentication Refactor", "claude-code", ws("atlas-api"), "running_tool", 2, {
      currentActivity: "Run npm test",
    });
    seedThread("Rate limiter for login", "codex", ws("atlas-api"), "waiting_for_permission", 6);
    seedThread("OpenAPI schema cleanup", "claude-code", ws("atlas-api"), "completed", 60 * 20);
    seedThread("Workspace rail persistence", "claude-code", ws("kalcode"), "editing", 1);
    seedThread("Session Locator ranking", "claude-code", ws("kalcode"), "testing", 4);
    seedThread("Greeting rotation", "codex", ws("kalcode"), "completed", 35);
    seedThread("Folder surface Git status", "gemini-cli", ws("kalcode"), "waiting_for_user", 12);
    seedThread("Checkout webhooks", "claude-code", ws("billing-service"), "failed", 90, { resumable: true });
    // "Yesterday" in the person's calendar, whatever the time now (recent work by day).
    const yesterdayAt = (hour: number) => {
      const at = new Date();
      at.setDate(at.getDate() - 1);
      at.setHours(hour, 0, 0, 0);
      return Math.round((Date.now() - at.getTime()) / 60_000);
    };
    const invoiceAt = yesterdayAt(15);
    const terraformAt = yesterdayAt(11);
    seedThread("Invoice PDF layout", "codex", ws("billing-service"), "interrupted", invoiceAt);
    seedThread("Landing page hero", "claude-code", ws("orbit-web"), "paused", 60 * 30);
    seedThread("Terraform state split", "codex", ws("infra-terraform"), "completed", terraformAt);
    seedThread("Offline sync spike", "claude-code", ws("mobile-app"), "idle", 60 * 50);
    seedThread("Old onboarding flow", "claude-code", ws("docs-site"), "completed", 60 * 24 * 9, {
      archivedAt: minutesAgo(60 * 24 * 8),
    });
    // Pinned, a folder group, archived.
    const pin = (name: string, position: number) => {
      const r = row(ws(name).id);
      r.pinnedAt = minutesAgo(600 - position);
      r.position = position;
    };
    pin("kalcode", 0);
    pin("atlas-api", 1);
    const client: WorkspaceGroup = { id: crypto.randomUUID(), name: "Client work", position: 0, collapsed: false };
    groups = [client];
    for (const [i, name] of ["billing-service", "client-portal"].entries()) {
      const r = row(ws(name).id);
      r.groupId = client.id;
      r.position = i;
    }
    row(ws("scratch-experiments").id).archivedAt = minutesAgo(60 * 24 * 3);
    row(ws("mobile-app").id).collapsed = true;
    // History for recent work: yesterday and today.
    const at = (minutes: number): EmitOptions => ({ occurredAt: minutesAgo(minutes) });
    const threadCorr = (t: ThreadSummary, minutes: number): EmitOptions => ({
      ...at(minutes),
      correlation: { threadId: t.id, workspaceId: t.workspaceId, providerId: t.providerId },
    });
    const invoice = threads().find((t) => t.name === "Invoice PDF layout") as ThreadSummary;
    const terraform = threads().find((t) => t.name === "Terraform state split") as ThreadSummary;
    const greeting = threads().find((t) => t.name === "Greeting rotation") as ThreadSummary;
    emit({ type: "thread.started", payload: { threadId: invoice.id } }, threadCorr(invoice, invoiceAt + 20));
    emit(
      { type: "file.modified", payload: { threadId: invoice.id, path: "src/invoice/pdf.ts" } },
      threadCorr(invoice, invoiceAt + 5),
    );
    emit({ type: "thread.started", payload: { threadId: terraform.id } }, threadCorr(terraform, terraformAt + 30));
    emit({ type: "thread.completed", payload: { threadId: terraform.id } }, threadCorr(terraform, terraformAt));
    emit(
      {
        type: "app.started",
        payload: { version: "0.1.0", channel: "development", platform: "windows", arch: "x86_64" },
      },
      at(60 * 3),
    );
    // Today's work stays inside the person's calendar day, even just after midnight.
    const sinceMidnight = (() => {
      const midnight = new Date();
      midnight.setHours(0, 0, 0, 0);
      return Math.floor((Date.now() - midnight.getTime()) / 60_000);
    })();
    const today = (minutes: number) => Math.min(minutes, Math.max(0, sinceMidnight - 1));
    emit({ type: "thread.started", payload: { threadId: auth.id } }, threadCorr(auth, today(50)));
    emit(
      { type: "file.modified", payload: { threadId: auth.id, path: "src/auth/callback.ts" } },
      threadCorr(auth, today(0)),
    );
    emit({ type: "thread.completed", payload: { threadId: greeting.id } }, threadCorr(greeting, today(35)));
    emit(
      {
        type: "app.started",
        payload: { version: "0.1.0", channel: "development", platform: "windows", arch: "x86_64" },
      },
      at(0),
    );
    // The last visit was before today's completion.
    lastSeenSeq = options.events().find((e) => e.type === "thread.completed" && e.payload.threadId === greeting.id)
      ? (options.events().find((e) => e.type === "thread.completed" && e.payload.threadId === greeting.id)?.seq ?? 1) -
        1
      : 0;
    if (options.scenario === "home") options.setDisplayName("Kaleb");
  }

  return { handlers };
}
