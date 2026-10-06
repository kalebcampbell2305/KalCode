import {
  AGENT_STATE_TEXT,
  AGENT_STATE_TONE,
  type AgentState,
  agentStateOf,
  type OperationRecord,
  type SquadDefinition,
  type SquadLaunch,
  type SquadLaunchMember,
  type SquadMemberDefinition,
  type StatusTone,
  type ThreadSummary,
} from "@kalcode/protocol";

export interface SquadMemberTruth {
  member: SquadLaunchMember;
  definition: SquadMemberDefinition | null;
  operation: OperationRecord | null;
  agent: ThreadSummary | null;
  state: AgentState | "queued" | "unavailable";
  label: string;
  tone: StatusTone;
  reason: string | null;
}

export interface SquadLaunchTruth {
  launch: SquadLaunch;
  definition: SquadDefinition | null;
  members: SquadMemberTruth[];
  completed: number;
  active: number;
  waiting: number;
  needsYou: number;
  failed: number;
  outcome: string;
}

export interface SquadMemberDisplay {
  name: string;
  providerId: string;
  providerAccountId: string;
  model: string;
  effort: string;
}

/**
 * Historical launches keep the execution choices captured by their canonical Operation. Editing
 * a reusable template must never relabel an already-running or completed real terminal.
 */
export function memberDisplay(truth: SquadMemberTruth): SquadMemberDisplay {
  return {
    name: truth.operation?.spec.name || truth.agent?.name || truth.definition?.name || truth.member.key,
    providerId:
      truth.operation?.spec.providerId || truth.agent?.providerId || truth.definition?.providerId || "unknown",
    providerAccountId:
      truth.operation?.spec.providerAccountId ||
      truth.agent?.providerAccountId ||
      truth.definition?.providerAccountId ||
      "",
    model: truth.operation?.spec.model || truth.agent?.model || truth.definition?.model || "",
    effort: truth.operation?.spec.effort || truth.agent?.effort || truth.definition?.effort || "",
  };
}

const TERMINAL_OPERATIONS = new Set<OperationRecord["status"]>(["succeeded", "failed", "cancelled", "interrupted"]);

function operationFallback(operation: OperationRecord | null): Pick<SquadMemberTruth, "state" | "label" | "tone"> {
  switch (operation?.status) {
    case "queued":
    case "paused":
      return { state: "queued", label: operation.status === "paused" ? "Paused" : "Queued", tone: "waiting" };
    case "blocked":
      return { state: "waiting", label: "Waiting", tone: "waiting" };
    case "starting":
      return { state: "starting", label: "Starting", tone: "recovering" };
    case "running":
      return { state: "working", label: "Working", tone: "working" };
    case "succeeded":
      return { state: "done", label: "Done", tone: "done" };
    case "failed":
    case "interrupted":
      return { state: "failed", label: operation.status === "failed" ? "Failed" : "Interrupted", tone: "failed" };
    case "cancelled":
      return { state: "stopped", label: "Stopped", tone: "muted" };
    case "unknown":
    case undefined:
      return { state: "unavailable", label: "Unavailable", tone: "muted" };
  }
}

/**
 * Projects a launched member onto the canonical Operation and real coding-agent session. The
 * launch relation adds role/dependency context only; it never becomes another status authority.
 */
export function memberTruth(
  member: SquadLaunchMember,
  definition: SquadMemberDefinition | null,
  operation: OperationRecord | null,
  agents: readonly ThreadSummary[],
): SquadMemberTruth {
  const agent = operation?.threadId ? (agents.find((candidate) => candidate.id === operation.threadId) ?? null) : null;
  const fallback = operationFallback(operation);
  const attentionReason = operation
    ? ((operation as OperationRecord & { attentionReason?: string | null }).attentionReason ?? null)
    : null;
  // A Squad launch owns one bounded turn. A terminal operation must remain terminal even when its
  // reusable coding terminal has already started another turn. Explicit Operations attention also
  // outranks a generic paused/blocked state; expected dependency waits do not become "Needs you".
  const terminal = operation ? TERMINAL_OPERATIONS.has(operation.status) : false;
  const state = terminal
    ? fallback.state
    : attentionReason
      ? "needs_you"
      : agent
        ? agentStateOf(agent)
        : fallback.state;
  return {
    member,
    definition,
    operation,
    agent,
    state,
    label: terminal
      ? fallback.label
      : state === "needs_you"
        ? "Needs you"
        : agent
          ? AGENT_STATE_TEXT[state as AgentState]
          : fallback.label,
    tone: terminal
      ? fallback.tone
      : state === "needs_you"
        ? "waiting"
        : agent
          ? AGENT_STATE_TONE[state as AgentState]
          : fallback.tone,
    reason: attentionReason ?? operation?.outcome ?? operation?.blockers[0] ?? null,
  };
}

export function launchTruth(
  launch: SquadLaunch,
  squads: readonly SquadDefinition[],
  operations: readonly OperationRecord[],
  agents: readonly ThreadSummary[],
): SquadLaunchTruth {
  const definition = squads.find((candidate) => candidate.id === launch.squadId) ?? null;
  const byOperation = new Map(operations.map((operation) => [operation.id, operation]));
  const byKey = new Map(definition?.members.map((member) => [member.key, member]) ?? []);
  const members = launch.members.map((member) =>
    memberTruth(member, byKey.get(member.key) ?? null, byOperation.get(member.operationId) ?? null, agents),
  );
  const completed = members.filter(({ operation }) => operation?.status === "succeeded").length;
  const stopped = members.filter(({ state }) => state === "stopped").length;
  const failed = members.filter(({ state }) => state === "failed").length;
  const needsYou = members.filter(({ state }) => state === "needs_you").length;
  const active = members.filter(
    ({ state }) =>
      state === "starting" || state === "working" || state === "testing" || state === "ready" || state === "idle",
  ).length;
  const waiting = members.filter(
    ({ operation, state }) =>
      (state === "waiting" || state === "queued") && !operation?.attentionReason && Boolean(operation?.blockers.length),
  ).length;
  const activity = [active > 0 ? `${active} active` : null, waiting > 0 ? `${waiting} waiting` : null]
    .filter(Boolean)
    .join(" · ");
  const outcome =
    failed > 0
      ? `${failed} ${failed === 1 ? "member needs" : "members need"} recovery${waiting > 0 ? ` · ${waiting} waiting` : ""}`
      : completed === members.length && members.length > 0
        ? "Agents done"
        : needsYou > 0
          ? `${needsYou} ${needsYou === 1 ? "decision" : "decisions"} needed${activity ? ` · ${activity}` : ""}`
          : completed > 0 && stopped > 0 && completed + stopped === members.length
            ? `${completed} done · ${stopped} stopped`
            : members.length > 0 && members.every(({ state }) => state === "stopped")
              ? "Squad stopped"
              : activity
                ? activity
                : "Preparing the squad";
  return { launch, definition, members, completed, active, waiting, needsYou, failed, outcome };
}

export interface OwnershipCollision {
  path: string;
  memberKeys: string[];
  mode: "shared" | "merge";
  undeclared: boolean;
}

function ownedPath(value: string): string {
  return value
    .trim()
    .replaceAll("\\", "/")
    .replace(/\/\*\*?$/, "")
    .replace(/\/$/, "")
    .toLocaleLowerCase();
}

/**
 * Declared exact and ancestor/descendant ownership collisions, before agents edit. Agents in a
 * shared checkout should serialize the affected path; undeclared ownership there means the whole
 * workspace is unknown and serializes conservatively. Any isolated worktree can proceed and
 * resolve declared overlap in the merge train. Runtime changed-file overlap remains Fleet truth.
 */
export function ownershipCollisions(
  members: readonly Pick<SquadMemberDefinition, "key" | "ownedPaths" | "worktree">[],
): OwnershipCollision[] {
  const collisions = new Map<string, { keys: Set<string>; sharedCheckout: boolean; undeclared: boolean }>();
  for (let leftIndex = 0; leftIndex < members.length; leftIndex += 1) {
    const left = members[leftIndex];
    if (!left) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < members.length; rightIndex += 1) {
      const right = members[rightIndex];
      if (!right) continue;
      const sharedCheckout = !left.worktree && !right.worktree;
      if (sharedCheckout && (left.ownedPaths.length === 0 || right.ownedPaths.length === 0)) {
        const collision = collisions.get("\0workspace") ?? {
          keys: new Set<string>(),
          sharedCheckout: true,
          undeclared: true,
        };
        collision.keys.add(left.key);
        collision.keys.add(right.key);
        collisions.set("\0workspace", collision);
        continue;
      }
      for (const leftRaw of left.ownedPaths) {
        const leftPath = ownedPath(leftRaw);
        if (!leftPath) continue;
        for (const rightRaw of right.ownedPaths) {
          const rightPath = ownedPath(rightRaw);
          if (!rightPath) continue;
          if (
            leftPath !== rightPath &&
            !leftPath.startsWith(`${rightPath}/`) &&
            !rightPath.startsWith(`${leftPath}/`)
          ) {
            continue;
          }
          const path = leftPath.length <= rightPath.length ? leftPath : rightPath;
          const collision = collisions.get(path) ?? {
            keys: new Set<string>(),
            sharedCheckout: false,
            undeclared: false,
          };
          collision.keys.add(left.key);
          collision.keys.add(right.key);
          collision.sharedCheckout ||= sharedCheckout;
          collisions.set(path, collision);
        }
      }
    }
  }
  return [...collisions]
    .map(([key, collision]) => ({
      path: key === "\0workspace" ? "Entire workspace" : key,
      memberKeys: [...collision.keys],
      mode: collision.sharedCheckout ? ("shared" as const) : ("merge" as const),
      undeclared: collision.undeclared,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

export function memberOperation(
  launch: SquadLaunch,
  memberKey: string,
  operations: readonly OperationRecord[],
): OperationRecord | null {
  const operationId = launch.members.find((member) => member.key === memberKey)?.operationId;
  return operationId ? (operations.find((operation) => operation.id === operationId) ?? null) : null;
}
