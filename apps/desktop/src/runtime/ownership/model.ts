/**
 * Agent File Ownership: who is working on which files, and where two coding agents are about to
 * collide. One canonical projection, derived on every read from the real sources and never stored:
 *
 * - **Git** (`ThreadWorktreeState.changedPaths`): what an agent in its own worktree changed
 *   (committed since its branch forked, plus uncommitted and untracked). Merged work drops out by
 *   itself; a removed worktree takes its files with it.
 * - **Provider edits** (`thread_touched_paths`): what an agent that shares the project folder
 *   edited, from the provider's own file events. Only counted while that agent's session runs.
 * - **Declared areas** (Squad members' owned paths): what an agent was asked to own before it
 *   edited anything, so a second agent entering that area is seen before the files meet.
 * - **Handoffs**: an active handoff passes the sender's files to the receiver; the pair never
 *   warns about each other, because the overlap is the point.
 * - **Git merge check** (`agent_pair_conflicts`): whether two agents' committed work actually
 *   conflicts, which separates a real collision from compatible work in the same files.
 * - **The person's override**: an overlap they allowed stays allowed until it grows.
 *
 * Claims are soft: nothing here blocks an agent. Overlaps rank by how expensive they will be
 * ("live" two agents writing the same files in one folder, then a confirmed Git conflict, then
 * the same files, then one agent inside another's area). Compatible work is shown, never raised.
 * Provider-agnostic: every input is KalCode state, never a provider name.
 */
import { agentStateOf, type HandoffRecord, type ThreadSummary, type ThreadWorktreeState } from "@kalcode/protocol";

/** Provider-reported edits of one agent (`thread_touched_paths`). */
export interface TouchedPaths {
  threadId: string;
  paths: readonly string[];
  truncated: boolean;
}

/** Git's answer for one pair of worktree agents (`agent_pair_conflicts`). */
export interface PairConflict {
  leftThreadId: string;
  rightThreadId: string;
  /** `null`: unknown (no worktree, different repositories, Git too old). */
  conflicts: boolean | null;
  files: readonly string[];
}

/**
 * How expensive an overlap will be, most expensive first.
 * - `live`: both agents write the same files in one folder right now; edits can overwrite.
 * - `conflict`: Git confirms their committed work conflicts.
 * - `same-files`: both changed the same files; whether they merge cleanly is not known yet.
 * - `area`: one agent edits inside the area the other was given, before the files meet.
 * - `compatible`: the same files, but Git merges both cleanly. Shown, never raised.
 */
export type OwnershipRisk = "live" | "conflict" | "same-files" | "area" | "compatible";

export const RISK_ORDER: readonly OwnershipRisk[] = ["live", "conflict", "same-files", "area", "compatible"];

/** Lower is riskier. */
const rank = (risk: OwnershipRisk) => RISK_ORDER.indexOf(risk);

export interface AgentClaim {
  agentId: string;
  /** The agent's display name (manual names win), for surfaces naming the other side of a claim. */
  name: string;
  providerName: string;
  workspaceId: string;
  /** The agent's own worktree; `null`: it writes in the project folder. */
  worktreeId: string | null;
  branch: string | null;
  /** The session still runs (not done, failed or stopped). An ended agent keeps only Git facts. */
  active: boolean;
  /** Files the agent changed, sorted. */
  files: readonly string[];
  /** Its file list was cut short: more may exist. */
  filesIncomplete: boolean;
  /** Paths the agent was given to own (directories or globs), while it is active. */
  areas: readonly string[];
  /** Files received through an active handoff, and from whom. */
  received: { from: string; handoffId: string; files: readonly string[] } | null;
  /** This agent handed its work to another agent (active handoff). */
  handedTo: { to: string; handoffId: string } | null;
}

export interface OwnershipOverlap {
  /** Stable per pair: `ownership:<a>:<b>` with sorted ids (Needs You and overrides use it). */
  key: string;
  /** The two agents, in listing order. */
  agentIds: readonly [string, string];
  workspaceId: string;
  risk: OwnershipRisk;
  /** The files involved, sorted. For `conflict` these are Git's conflicting files. */
  files: readonly string[];
  /** A side's list was cut short: more may overlap. */
  incomplete: boolean;
  /** For `area`: whose area was entered, by whom, and the area. */
  area: { owner: string; entrant: string; pattern: string } | null;
  /** The person allowed this overlap and it has not grown since. */
  allowed: boolean;
}

/** One agent's view of an overlap: the other agent and the overlap itself. */
export interface AgentOverlap {
  other: ThreadSummary;
  overlap: OwnershipOverlap;
}

/** Who holds a path, for file views. */
export interface PathOwner {
  agentId: string;
  /** `editing`: changed it; `received`: handed to it; `area`: inside the area it owns. */
  how: "editing" | "received" | "area";
}

export interface OwnershipInput {
  /** Open coding agents. */
  agents: readonly ThreadSummary[];
  worktrees: ReadonlyMap<string, ThreadWorktreeState>;
  touched: ReadonlyMap<string, TouchedPaths>;
  /** Git merge answers keyed by `pairKey`. */
  pairs: ReadonlyMap<string, PairConflict>;
  /** Agent id → its declared owned paths. */
  declared: ReadonlyMap<string, readonly string[]>;
  handoffs: readonly HandoffRecord[];
  /** Pair key → what the person allowed. */
  allowed: ReadonlyMap<string, AllowedGrant>;
  /** Now (ms); defaults to the clock. Only ages out stuck handoffs. */
  now?: number;
}

/** An overlap the person allowed: the files involved and how risky it was at the time. */
export interface AllowedGrant {
  files: readonly string[];
  risk: OwnershipRisk;
}

export interface Ownership {
  claims: ReadonlyMap<string, AgentClaim>;
  /** Every overlap, most expensive first. */
  overlaps: readonly OwnershipOverlap[];
  /** Each agent's overlaps, most expensive first. */
  byAgent: ReadonlyMap<string, readonly AgentOverlap[]>;
}

export const EMPTY_OWNERSHIP: Ownership = { claims: new Map(), overlaps: [], byAgent: new Map() };

/** Handoffs still in flight: the receiver holds the sender's work until it reports back. */
const HANDOFF_ACTIVE: ReadonlySet<HandoffRecord["status"]> = new Set(["queued", "delivered", "working", "needs_you"]);
/** A handoff with no progress for this long no longer silences the pair: it may be stuck. */
const HANDOFF_STALE_MS = 24 * 60 * 60 * 1000;

export function pairKey(a: string, b: string): string {
  return `ownership:${[a, b].toSorted().join(":")}`;
}

/** The session still runs: the agent may still change files. */
export function isActiveAgent(agent: Pick<ThreadSummary, "status" | "currentActivity" | "pendingApprovals">): boolean {
  const state = agentStateOf(agent);
  return state !== "done" && state !== "failed" && state !== "stopped";
}

function normalizePath(path: string): string {
  return path
    .replaceAll("\\", "/")
    .replace(/\/(?:\.\/)+/g, "/")
    .replace(/^(?:\.?\/)+/, "");
}

/**
 * How two paths compare: case-insensitively, because Windows and macOS file systems are, and a
 * provider may report `Src/App.tsx` for Git's `src/app.tsx`. Display keeps the original casing.
 */
function fileKey(path: string): string {
  return path.toLocaleLowerCase();
}

/**
 * The directory an owned-path pattern covers: `src/billing/**` and `src/billing/` cover
 * `src/billing`. The same reading Squads use when they serialize shared-folder members.
 */
export function areaBase(pattern: string): string {
  return normalizePath(pattern)
    .replace(/\/*[*?{[].*$/, "")
    .replace(/\/+$/, "");
}

/** `path` lies inside the area `pattern` (case-insensitive, like Squads). */
export function inArea(path: string, pattern: string): boolean {
  const base = areaBase(pattern).toLocaleLowerCase();
  if (!base) return false;
  const file = normalizePath(path).toLocaleLowerCase();
  return file === base || file.startsWith(`${base}/`);
}

/** The files of `a` that `b` also has (compared by `fileKey`), sorted, in `a`'s casing. */
function intersect(a: readonly string[], b: readonly string[]): string[] {
  const keys = new Set(b.map(fileKey));
  return a.filter((file) => keys.has(fileKey(file))).toSorted();
}

function claimOf(
  agent: ThreadSummary,
  input: OwnershipInput,
  active: boolean,
): Omit<AgentClaim, "received" | "handedTo"> {
  const worktree = agent.worktreeId ? input.worktrees.get(agent.id) : undefined;
  let files: readonly string[] = [];
  let filesIncomplete = false;
  if (agent.worktreeId) {
    // Git is the truth for a worktree: merged work drops out, a stopped agent's unmerged work stays.
    if (worktree) {
      files = worktree.changedPaths.map(normalizePath);
      filesIncomplete = worktree.changedPathsTruncated;
    }
  } else if (active) {
    // A shared-folder agent has no branch of its own; its edits count while its session runs.
    const touched = input.touched.get(agent.id);
    if (touched) {
      files = [...new Set(touched.paths.map(normalizePath))].toSorted();
      filesIncomplete = touched.truncated;
    }
  }
  return {
    agentId: agent.id,
    name: agent.name.trim() || agent.providerName,
    providerName: agent.providerName,
    workspaceId: agent.workspaceId,
    worktreeId: agent.worktreeId,
    branch: agent.branch,
    active,
    files,
    filesIncomplete,
    areas: active ? (input.declared.get(agent.id) ?? []) : [],
  };
}

/**
 * Allowed while the overlap is no riskier than when the person allowed it and every file still
 * involved was among the files they allowed. A new file or a worse risk warns again.
 */
function isAllowed(
  key: string,
  files: readonly string[],
  risk: OwnershipRisk,
  allowed: OwnershipInput["allowed"],
): boolean {
  const grant = allowed.get(key);
  if (!grant || rank(risk) < rank(grant.risk)) return false;
  const set = new Set(grant.files.map(fileKey));
  return files.every((file) => set.has(fileKey(file)));
}

function overlapOf(a: AgentClaim, b: AgentClaim, input: OwnershipInput): OwnershipOverlap | null {
  const key = pairKey(a.agentId, b.agentId);
  const sameFolder = a.worktreeId === b.worktreeId;
  const base = { key, agentIds: [a.agentId, b.agentId] as const, workspaceId: a.workspaceId };
  const shared = intersect(a.files, b.files);
  if (shared.length > 0) {
    const incomplete = a.filesIncomplete || b.filesIncomplete;
    if (sameFolder) {
      // Two agents writing one folder: only a collision while both sessions run.
      if (!a.active || !b.active) return null;
      return {
        ...base,
        risk: "live",
        files: shared,
        incomplete,
        area: null,
        allowed: isAllowed(key, shared, "live", input.allowed),
      };
    }
    const git = a.worktreeId && b.worktreeId ? input.pairs.get(key) : undefined;
    if (git?.conflicts === true) {
      const files = git.files.length > 0 ? [...git.files].map(normalizePath).toSorted() : shared;
      return {
        ...base,
        risk: "conflict",
        files,
        incomplete,
        area: null,
        allowed: isAllowed(key, files, "conflict", input.allowed),
      };
    }
    // Git's answer covers committed work only: uncommitted edits in either worktree keep it open.
    const clean = (claim: AgentClaim) => {
      const state = input.worktrees.get(claim.agentId);
      return state !== undefined && state.changed === 0 && state.untracked === 0;
    };
    const risk: OwnershipRisk = git?.conflicts === false && clean(a) && clean(b) ? "compatible" : "same-files";
    return {
      ...base,
      risk,
      files: shared,
      incomplete,
      area: null,
      allowed: isAllowed(key, shared, risk, input.allowed),
    };
  }
  // Entering another agent's area: the entrant changed files there that the owner has not.
  for (const [owner, entrant] of [
    [a, b],
    [b, a],
  ] as const) {
    if (!owner.active || owner.areas.length === 0 || entrant.files.length === 0) continue;
    if (sameFolder && !entrant.active) continue;
    for (const pattern of owner.areas) {
      const files = entrant.files.filter((file) => inArea(file, pattern));
      if (files.length === 0) continue;
      return {
        ...base,
        risk: "area",
        files,
        incomplete: entrant.filesIncomplete,
        area: { owner: owner.agentId, entrant: entrant.agentId, pattern },
        allowed: isAllowed(key, files, "area", input.allowed),
      };
    }
  }
  return null;
}

/** Every agent's claim and every overlap between agents of one project. */
export function deriveOwnership(input: OwnershipInput): Ownership {
  // Ordered by id, not by activity, so pairs, sentences and signatures stay put as agents work.
  const agents = input.agents
    .filter((agent) => agent.archivedAt === null)
    .toSorted((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  const now = input.now ?? Date.now();
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const claims = new Map<string, AgentClaim>();
  for (const agent of agents) {
    claims.set(agent.id, { ...claimOf(agent, input, isActiveAgent(agent)), received: null, handedTo: null });
  }

  // Active handoffs: the receiver holds the sender's files; the pair never warns about each other.
  // Handoffs arrive newest first, so an agent's latest handoff names what it holds.
  const handedOff = new Set<string>();
  for (const handoff of input.handoffs) {
    if (!HANDOFF_ACTIVE.has(handoff.status)) continue;
    const updated = Date.parse(handoff.updatedAt);
    if (!Number.isNaN(updated) && now - updated > HANDOFF_STALE_MS) continue;
    const source = claims.get(handoff.sourceThreadId);
    const target = claims.get(handoff.targetThreadId);
    if (!source || !target || source.agentId === target.agentId) continue;
    handedOff.add(pairKey(source.agentId, target.agentId));
    source.handedTo ??= { to: target.agentId, handoffId: handoff.id };
    target.received ??= { from: source.agentId, handoffId: handoff.id, files: source.files };
  }

  const list = [...claims.values()];
  const overlaps: OwnershipOverlap[] = [];
  for (let i = 0; i < list.length; i += 1) {
    const a = list[i];
    if (!a) continue;
    for (let j = i + 1; j < list.length; j += 1) {
      const b = list[j];
      if (!b || b.workspaceId !== a.workspaceId) continue;
      if (handedOff.has(pairKey(a.agentId, b.agentId))) continue;
      const overlap = overlapOf(a, b, input);
      if (overlap) overlaps.push(overlap);
    }
  }
  overlaps.sort(
    (x, y) =>
      rank(x.risk) - rank(y.risk) || y.files.length - x.files.length || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0),
  );

  const byAgent = new Map<string, AgentOverlap[]>();
  for (const overlap of overlaps) {
    const [a, b] = overlap.agentIds;
    for (const [self, otherId] of [
      [a, b],
      [b, a],
    ] as const) {
      const other = byId.get(otherId);
      if (!other) continue;
      const mine = byAgent.get(self) ?? [];
      mine.push({ other, overlap });
      byAgent.set(self, mine);
    }
  }
  return { claims, overlaps, byAgent };
}

/**
 * Everything a reader of `Ownership` shows (claims, overlaps, the other agents' names), as one
 * string: equal signatures mean no surface needs to re-render, however often agents report activity.
 */
export function ownershipSignature(ownership: Ownership): string {
  const others = [...ownership.byAgent].map(([id, list]) => [
    id,
    list.map(({ other }) => [other.id, other.name, other.providerName, other.workspaceId]),
  ]);
  return JSON.stringify([[...ownership.claims.values()], ownership.overlaps, others]);
}

/** The overlap is worth the person's attention (Needs You): risky and not allowed. */
export function needsAttention(overlap: OwnershipOverlap): boolean {
  return overlap.risk !== "compatible" && !overlap.allowed;
}

/** Pairs worth asking Git about: two worktree agents that changed the same files. */
export function pairsToCheck(input: Pick<OwnershipInput, "agents" | "worktrees">): [string, string][] {
  const candidates = input.agents.flatMap((agent) => {
    if (agent.archivedAt !== null || !agent.worktreeId) return [];
    const state = input.worktrees.get(agent.id);
    return state && state.changedPaths.length > 0 ? [{ agent, files: state.changedPaths }] : [];
  });
  const pairs: [string, string][] = [];
  for (let i = 0; i < candidates.length; i += 1) {
    const a = candidates[i];
    if (!a) continue;
    for (let j = i + 1; j < candidates.length; j += 1) {
      const b = candidates[j];
      if (!b || b.agent.workspaceId !== a.agent.workspaceId || b.agent.worktreeId === a.agent.worktreeId) continue;
      if (intersect(a.files, b.files).length > 0) pairs.push([a.agent.id, b.agent.id]);
    }
  }
  return pairs;
}

/** Who holds `path` in a project, for file views. Most direct hold first. */
export function ownersOf(ownership: Ownership, workspaceId: string, path: string): PathOwner[] {
  const file = fileKey(normalizePath(path));
  const holds = (files: readonly string[] | undefined) => files?.some((held) => fileKey(held) === file) ?? false;
  const owners: PathOwner[] = [];
  for (const claim of ownership.claims.values()) {
    if (claim.workspaceId !== workspaceId) continue;
    if (holds(claim.files)) owners.push({ agentId: claim.agentId, how: "editing" });
    else if (holds(claim.received?.files)) owners.push({ agentId: claim.agentId, how: "received" });
    else if (claim.areas.some((pattern) => inArea(file, pattern))) owners.push({ agentId: claim.agentId, how: "area" });
  }
  const order = { editing: 0, received: 1, area: 2 } as const;
  return owners.sort((a, b) => order[a.how] - order[b.how]);
}

/** "2 files" / "at least 2 files". */
export function fileCount(overlap: Pick<OwnershipOverlap, "files" | "incomplete">): string {
  const n = overlap.files.length;
  return `${overlap.incomplete ? "at least " : ""}${n} ${n === 1 ? "file" : "files"}`;
}

/** Short, plain words for a risk (badges, tooltips, screen readers). */
export const RISK_LABEL: Record<OwnershipRisk, string> = {
  live: "Editing the same files",
  conflict: "Will conflict",
  "same-files": "Same files",
  area: "In owned area",
  compatible: "Merges cleanly",
};

/** One sentence: what is happening between the two agents. */
export function describeOverlap(overlap: OwnershipOverlap, nameOf: (agentId: string) => string): string {
  const [a, b] = overlap.agentIds.map(nameOf);
  const count = fileCount(overlap);
  switch (overlap.risk) {
    case "live":
      return `${a} and ${b} both edited ${count} in the same folder while both are running, so their changes can collide.`;
    case "conflict":
      return `Git says ${a} and ${b} conflict in ${count}. Whichever merges second needs a fix.`;
    case "same-files":
      return `${a} and ${b} both changed ${count}. They may conflict when they merge.`;
    case "area": {
      const area = overlap.area;
      if (!area) return `${a} and ${b} overlap in ${count}.`;
      return `${nameOf(area.entrant)} changed ${count} in ${areaBase(area.pattern) || area.pattern}, which ${nameOf(area.owner)} owns.`;
    }
    case "compatible":
      return `${a} and ${b} both changed ${count}, and Git merges both cleanly.`;
  }
}
