/**
 * Squads adapter for unit tests and the ui-test build. Production uses the native Squads store,
 * scheduler, and provider-pane runtime. This module deliberately points members at the same
 * in-memory Operations and pane records used by Runs, Queue, Code, Fleet, and Needs You.
 */
import type {
  OperationSpec,
  SquadDefinition,
  SquadLaunch,
  SquadLaunchMember,
  SquadMemberDefinition,
  SquadRecipe,
  SquadsSnapshot,
  ThreadStatus,
  ThreadSummary,
} from "@kalcode/protocol";
import type { DashboardHandlers } from "./dashboard.ts";
import type { AgentOperationHooks } from "./operations.ts";

interface SquadsMemoryOptions {
  requireCore: () => void;
  operations: AgentOperationHooks;
  workspaceId: () => string;
  createPane(member: SquadMemberDefinition, workspaceId: string): Promise<ThreadSummary>;
  sendTask(threadId: string, task: string): Promise<void>;
  setPaneStatus?: (threadId: string, status: ThreadStatus, activity: string | null) => void;
  accountState?: (member: SquadMemberDefinition) => { available: boolean; accountLabel: string | null };
  seedOrion: boolean;
  afterOrionSeed?: (launch: SquadLaunch) => void | Promise<void>;
}

export interface SquadsMemory {
  handlers: DashboardHandlers;
}

interface StoredRequest {
  fingerprint: string;
  launchId: string;
}

interface LaunchIds {
  launchId: string;
  operationIds: Readonly<Record<string, string>>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROVIDER_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const MEMBER_KEY = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,62}[A-Za-z0-9])?$/;
const SECRET_ASSIGNMENT = /\b(?:password|passwd|pwd|api[_-]?key|access[_-]?token|secret)\s*[:=]\s*\S+/i;
const encoder = new TextEncoder();

function isControl(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

export const ORION_FIXTURE = {
  squadId: "00000000-0000-4000-8000-00000000a001",
  recipeId: "00000000-0000-4000-8000-00000000a002",
  launchId: "00000000-0000-4000-8000-00000000a003",
  operations: {
    lead: "00000000-0000-4000-8000-00000000a011",
    tests: "00000000-0000-4000-8000-00000000a012",
    review: "00000000-0000-4000-8000-00000000a013",
  },
} as const;

const ORION_SQUAD: SquadDefinition = {
  id: ORION_FIXTURE.squadId,
  name: "Orion Release Crew",
  goal: "Ship the updater reliability pass",
  members: [
    {
      key: "lead",
      name: "Updater implementation",
      providerId: "codex",
      providerAccountId: "0192f3c4-0000-7000-8000-000000000201",
      model: "gpt-5.6-sol",
      effort: "xhigh",
      role: "implementation",
      task: "Implement the updater reliability pass",
      worktree: true,
      dependsOn: [],
      managerKey: null,
      ownedPaths: ["tooling/release/**", "crates/updater/**"],
    },
    {
      key: "tests",
      name: "Updater test authority",
      providerId: "claude-code",
      providerAccountId: "0192f3c4-0000-7000-8000-000000000101",
      model: "sonnet",
      effort: "high",
      role: "test",
      task: "Validate updater recovery and close-and-reopen delivery",
      worktree: true,
      dependsOn: [],
      managerKey: "lead",
      ownedPaths: ["apps/desktop/tests/e2e/**"],
    },
    {
      key: "review",
      name: "Release review",
      providerId: "codex",
      providerAccountId: "0192f3c4-0000-7000-8000-000000000201",
      model: "gpt-5.6-sol",
      effort: "high",
      role: "review",
      task: "Review updater integrity and release evidence",
      worktree: true,
      dependsOn: [],
      managerKey: "lead",
      // Deliberate overlap: the Ownership surface should guide these two before merge.
      ownedPaths: ["tooling/release/**", "docs/releases/**"],
    },
  ],
};

const ORION_RECIPE: SquadRecipe = {
  id: ORION_FIXTURE.recipeId,
  name: "Orion updater release",
  squadId: ORION_FIXTURE.squadId,
  goal: "Ship the updater reliability pass",
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

function fail(code: string, message: string, retryable = false): never {
  throw { category: "validation", code, message, retryable };
}

function required<T>(value: T | undefined): T {
  if (value === undefined) fail("squad_state_invalid", "Squad state is incomplete.");
  return value;
}

function rejectSecret(value: string): string {
  if (SECRET_ASSIGNMENT.test(value)) {
    fail("squad_secret_detected", "Remove credentials and secrets before saving or launching this Squad.");
  }
  return value;
}

function text(value: unknown, code: string, label: string, maxBytes: number): string {
  if (typeof value !== "string") fail(code, `${label} is required.`);
  const next = value.trim();
  if (!next || encoder.encode(next).length > maxBytes || [...next].some(isControl)) {
    fail(code, `${label} must be visible text under ${maxBytes.toLocaleString()} bytes.`);
  }
  return next;
}

function optionalText(value: unknown, code: string, label: string, maxCharacters: number): string {
  if (typeof value !== "string") fail(code, `${label} must be text.`);
  const next = value.trim();
  if ([...next].length > maxCharacters || [...next].some(isControl)) {
    fail(code, `${label} must be under ${maxCharacters.toLocaleString()} characters.`);
  }
  return next;
}

function boundedMultiline(value: unknown, code: string, label: string, maxBytes: number): string {
  if (typeof value !== "string") fail(code, `${label} must be text.`);
  const next = value.trim();
  if (
    encoder.encode(next).length > maxBytes ||
    [...next].some(
      (character) => isControl(character) && character !== "\n" && character !== "\r" && character !== "\t",
    )
  ) {
    fail(code, `${label} must be under ${maxBytes.toLocaleString()} bytes.`);
  }
  return next;
}

function id(value: unknown, code: string, label: string): string {
  if (typeof value !== "string" || !UUID.test(value)) fail(code, `${label} isn't valid.`);
  return value;
}

function confirmedRecipe(value: unknown): SquadRecipe {
  if (typeof value !== "object" || value === null) {
    fail("squad_recipe_confirmation_invalid", "Review the dependent Recipes again before deleting this Squad.");
  }
  const source = value as SquadRecipe;
  const recipe: SquadRecipe = {
    id: id(source.id, "recipe_id_invalid", "That Recipe id"),
    name: text(source.name, "recipe_name_invalid", "Recipe name", 120),
    squadId: id(source.squadId, "squad_id_invalid", "That Squad id"),
    goal:
      source.goal == null
        ? null
        : rejectSecret(boundedMultiline(source.goal, "squad_goal_invalid", "Recipe goal", 16_384)) || null,
  };
  if (recipe.name !== source.name || recipe.goal !== (source.goal ?? null)) {
    fail("squad_recipe_confirmation_stale", "Recipes changed. Review their exact saved contents before deleting.");
  }
  return recipe;
}

function sortedRecipes(values: readonly SquadRecipe[]): SquadRecipe[] {
  return values.toSorted((left, right) => left.id.localeCompare(right.id));
}

function requestId(value: unknown): string {
  if (typeof value !== "string") fail("squad_request_invalid", "That launch request isn't valid.");
  const next = value.trim();
  if (!next || next.length > 128 || [...next].some(isControl)) {
    fail("squad_request_invalid", "That launch request isn't valid.");
  }
  return next;
}

function referencesAcyclic(
  members: readonly SquadMemberDefinition[],
  edges: (member: SquadMemberDefinition) => readonly string[],
  code: string,
  message: string,
) {
  const byKey = new Map(members.map((member) => [member.key, member]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string) => {
    if (visited.has(key)) return;
    if (visiting.has(key)) fail(code, message);
    visiting.add(key);
    for (const dependency of edges(required(byKey.get(key)))) visit(dependency);
    visiting.delete(key);
    visited.add(key);
  };
  for (const key of byKey.keys()) visit(key);
}

function squadDefinition(value: unknown): SquadDefinition {
  if (typeof value !== "object" || value === null) fail("squad_invalid", "Enter a valid Squad.");
  const source = value as SquadDefinition;
  const safeId = id(source.id, "squad_id_invalid", "That Squad id");
  const name = text(source.name, "squad_name_invalid", "Squad name", 120);
  const goal = rejectSecret(boundedMultiline(source.goal, "squad_goal_invalid", "Squad goal", 16_384));
  if (!Array.isArray(source.members) || source.members.length === 0 || source.members.length > 100) {
    fail("squad_members_invalid", "Add between 1 and 100 coding-agent members.");
  }
  const members = source.members.map((candidate): SquadMemberDefinition => {
    if (typeof candidate !== "object" || candidate === null) fail("squad_member_invalid", "Enter a valid member.");
    const member = candidate as SquadMemberDefinition;
    const key = text(member.key, "squad_member_key_invalid", "Member key", 64);
    if (!MEMBER_KEY.test(key)) fail("squad_member_key_invalid", "Use letters, numbers, dashes, or underscores.");
    const providerId = text(member.providerId, "squad_provider_invalid", "Provider", 64);
    if (!PROVIDER_ID.test(providerId)) fail("squad_provider_invalid", "That provider reference isn't valid.");
    const providerAccountId = id(member.providerAccountId, "squad_provider_account_invalid", "That provider account");
    const normalizedTask =
      member.task == null ? null : boundedMultiline(member.task, "squad_task_invalid", "Launch task", 65_536);
    const task = normalizedTask || null;
    if (!Array.isArray(member.dependsOn) || member.dependsOn.some((dependency) => typeof dependency !== "string")) {
      fail("squad_dependencies_invalid", "Member dependencies aren't valid.");
    }
    if (!Array.isArray(member.ownedPaths) || member.ownedPaths.some((path) => typeof path !== "string")) {
      fail("squad_owned_paths_invalid", "Owned paths aren't valid.");
    }
    const ownedPaths = member.ownedPaths.map((path) => text(path, "squad_owned_path_invalid", "Owned path", 512));
    if (
      ownedPaths.some(
        (path) =>
          /^[A-Za-z]:[\\/]/.test(path) ||
          path.startsWith("/") ||
          path.startsWith("\\") ||
          path.split(/[\\/]/).includes(".."),
      )
    ) {
      fail("squad_owned_path_invalid", "Owned paths must stay inside the project.");
    }
    return {
      key,
      name: text(member.name, "squad_member_name_invalid", "Member name", 120),
      providerId,
      providerAccountId,
      model: optionalText(member.model, "squad_model_invalid", "Model", 128),
      effort: optionalText(member.effort, "squad_effort_invalid", "Effort", 32),
      role: optionalText(member.role, "squad_role_invalid", "Role", 80),
      task,
      worktree: member.worktree === true,
      dependsOn: [...new Set(member.dependsOn)],
      managerKey: member.managerKey == null ? null : String(member.managerKey),
      ownedPaths: [...new Set(ownedPaths)],
    };
  });
  const keys = new Set<string>();
  for (const member of members) {
    if (keys.has(member.key)) fail("squad_member_key_exists", "Member keys must be unique within a Squad.");
    keys.add(member.key);
  }
  for (const member of members) {
    if (member.dependsOn.includes(member.key) || member.dependsOn.some((dependency) => !keys.has(dependency))) {
      fail("squad_dependencies_invalid", "Dependencies must name other members in this Squad.");
    }
    if (member.managerKey === member.key || (member.managerKey !== null && !keys.has(member.managerKey))) {
      fail("squad_manager_invalid", "A manager must name another member in this Squad.");
    }
  }
  referencesAcyclic(
    members,
    (member) => member.dependsOn,
    "squad_dependency_cycle",
    "Squad dependencies contain a cycle.",
  );
  referencesAcyclic(
    members,
    (member) => (member.managerKey === null ? [] : [member.managerKey]),
    "squad_manager_cycle",
    "Squad managers contain a cycle.",
  );
  return { id: safeId, name, goal, members };
}

function providerFailure(error: unknown, member: SquadMemberDefinition): string {
  const message =
    typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
      ? error.message.trim()
      : `${member.name}'s provider is unavailable.`;
  return message || `${member.name}'s provider is unavailable.`;
}

/** Creates the contract handlers while preserving Operations and provider panes as the authorities. */
export function createSquadsMemory(options: SquadsMemoryOptions): SquadsMemory {
  let squads: SquadDefinition[] = options.seedOrion ? [clone(ORION_SQUAD)] : [];
  let recipes: SquadRecipe[] = options.seedOrion ? [clone(ORION_RECIPE)] : [];
  let launches: SquadLaunch[] = [];
  const launchDefinitions = new Map<string, SquadDefinition>();
  const requests = new Map<string, StoredRequest>();
  const preparing = new Map<string, Promise<void>>();
  const admitting = new Map<string, Promise<void>>();
  let orionSeed: Promise<void> | null = null;

  const resolve = <T extends { id: string; name: string }>(raw: unknown, values: readonly T[], noun: string): T => {
    const invalidCode = noun === "squad" ? "invalid_squad_query" : "invalid_squad_recipe_query";
    const notFoundCode = noun === "squad" ? "squad_not_found" : "squad_recipe_not_found";
    const ambiguousCode = noun === "squad" ? "squad_name_ambiguous" : "squad_recipe_name_ambiguous";
    if (typeof raw !== "string" || !raw.trim()) {
      fail(invalidCode, `Choose a ${noun.replace("_", " ")}.`);
    }
    const exact = values.find((value) => value.id === raw);
    if (exact) return exact;
    const name = raw.trim().toLocaleLowerCase();
    const matches = values.filter((value) => value.name.toLocaleLowerCase() === name);
    if (matches.length === 0) fail(notFoundCode, `That ${noun.replace("_", " ")} no longer exists.`);
    if (matches.length > 1) fail(ambiguousCode, `Choose the exact ${noun.replace("_", " ")}.`);
    return required(matches[0]);
  };

  const launchById = (launchId: string) => {
    const launch = launches.find((candidate) => candidate.id === launchId);
    if (!launch) fail("squad_launch_not_found", "That Squad launch no longer exists.");
    return launch;
  };

  const prepareMember = async (launch: SquadLaunch, member: SquadMemberDefinition, operationId: string) => {
    if (preparing.has(operationId)) return preparing.get(operationId);
    const task = (async () => {
      try {
        const thread = await options.createPane(member, launch.workspaceId);
        options.operations.prepare(operationId, {
          threadId: thread.id,
          terminalId: thread.terminalId ?? thread.id,
          branch: thread.branch,
          accountLabel: thread.accountLabel,
        });
      } catch (error) {
        options.operations.hold(operationId, providerFailure(error, member));
      }
    })().finally(() => preparing.delete(operationId));
    preparing.set(operationId, task);
    return task;
  };

  const admitMember = async (
    member: SquadMemberDefinition,
    operationId: string,
    threadId: string,
    prompt: string | null,
  ) => {
    if (admitting.has(operationId)) return admitting.get(operationId);
    const task = (async () => {
      try {
        if (prompt !== null) await options.sendTask(threadId, prompt);
        options.operations.activate(operationId, prompt !== null);
        options.setPaneStatus?.(
          threadId,
          prompt === null ? "idle" : "active",
          prompt === null ? "Ready for a task" : "Working on Squad task",
        );
      } catch (error) {
        options.operations.hold(operationId, providerFailure(error, member));
        options.setPaneStatus?.(threadId, "paused", "Launch task needs attention");
      }
    })().finally(() => admitting.delete(operationId));
    admitting.set(operationId, task);
    return task;
  };

  const tickLaunch = async (launch: SquadLaunch) => {
    const definition = launchDefinitions.get(launch.id);
    // A launch retains the member configuration it was created from even if its reusable
    // definition is later edited or deleted.
    const memberDefinitions = new Map((definition?.members ?? []).map((member) => [member.key, member] as const));
    const operationIds = launch.members.map((member) => member.operationId);
    let records = new Map(options.operations.exact(operationIds).map((record) => [record.id, record] as const));
    const preparations: Promise<void>[] = [];
    for (const launchedMember of launch.members) {
      const member = memberDefinitions.get(launchedMember.key);
      const operation = records.get(launchedMember.operationId);
      if (
        !member ||
        !operation ||
        operation.threadId !== null ||
        operation.endedAt !== null ||
        operation.attentionReason !== undefined ||
        operation.status === "paused" ||
        operation.status === "cancelled" ||
        operation.status === "failed"
      ) {
        continue;
      }
      preparations.push(prepareMember(launch, member, operation.id));
    }
    await Promise.all(preparations);
    records = new Map(options.operations.exact(operationIds).map((record) => [record.id, record] as const));
    const eligible: Promise<void>[] = [];
    for (const launchedMember of launch.members) {
      const member = memberDefinitions.get(launchedMember.key);
      if (!member) continue;
      const initialOperation = records.get(launchedMember.operationId);
      if (!initialOperation || initialOperation.threadId === null || initialOperation.endedAt !== null) continue;
      let operation = initialOperation;
      if (
        operation.attentionReason !== undefined ||
        operation.status === "paused" ||
        operation.status === "cancelled" ||
        operation.status === "failed"
      ) {
        continue;
      }
      const blockers = operation.spec.dependencies.filter(
        (dependencyId) => records.get(dependencyId)?.status !== "succeeded",
      );
      if (blockers.length > 0) {
        const dependencyFailed = blockers.some((blocker) => {
          const status = records.get(blocker)?.status;
          return status === "failed" || status === "cancelled";
        });
        const desiredStatus = dependencyFailed ? "blocked" : "queued";
        const names = launch.members
          .filter((candidate) => blockers.includes(candidate.operationId))
          .map((candidate) => candidate.key)
          .join(", ");
        if (
          operation.status !== desiredStatus ||
          blockers.length !== operation.blockers.length ||
          blockers.some((blocker) => !operation.blockers.includes(blocker))
        ) {
          if (dependencyFailed) {
            options.operations.block(operation.id, blockers, `Blocked by ${names}`);
          } else {
            options.operations.wait(operation.id, blockers);
          }
        }
        if (operation.threadId) {
          options.setPaneStatus?.(operation.threadId, "waiting_for_dependency", `Waiting for ${names}`);
        }
        continue;
      }
      if (operation.status === "blocked") operation = options.operations.queue(operation.id);
      if (operation.status === "queued" && operation.threadId !== null) {
        eligible.push(admitMember(member, operation.id, operation.threadId, operation.spec.prompt));
      }
    }
    await Promise.all(eligible);
  };

  const tick = async () => {
    for (const launch of launches) await tickLaunch(launch);
  };

  const replayRequest = (request: string, fingerprint: string): SquadLaunch | undefined => {
    const existing = requests.get(request);
    if (!existing) return undefined;
    if (existing.fingerprint !== fingerprint) {
      fail("squad_launch_request_conflict", "That launch request was already used for different Squad work.");
    }
    return clone(launchById(existing.launchId));
  };

  const makeLaunch = async (
    definition: SquadDefinition,
    workspaceId: string,
    request: string,
    fingerprint: string,
    goalOverride: string | null,
    ids?: LaunchIds,
  ): Promise<SquadLaunch> => {
    const replayed = replayRequest(request, fingerprint);
    if (replayed) return replayed;
    const operationIds = new Map(
      definition.members.map((member) => [member.key, ids?.operationIds[member.key] ?? crypto.randomUUID()] as const),
    );
    const dependencyKeys = new Map<string, string[]>(
      definition.members.map((member) => [member.key, [...member.dependsOn]]),
    );
    const dependencyReaches = (start: string, target: string): boolean => {
      const pending = [start];
      const seen = new Set<string>();
      while (pending.length > 0) {
        const key = pending.pop();
        if (key === undefined || seen.has(key)) continue;
        seen.add(key);
        for (const dependency of required(dependencyKeys.get(key))) {
          if (dependency === target) return true;
          pending.push(dependency);
        }
      }
      return false;
    };
    const ownedBase = (path: string) => path.replace(/[\\/]*[*?{[].*$/, "").replace(/[\\/]+$/, "");
    const overlaps = (left: SquadMemberDefinition, right: SquadMemberDefinition) => {
      if (left.ownedPaths.length === 0 || right.ownedPaths.length === 0) return true;
      return left.ownedPaths.some((leftPath) =>
        right.ownedPaths.some((rightPath) => {
          const a = ownedBase(leftPath).toLocaleLowerCase();
          const b = ownedBase(rightPath).toLocaleLowerCase();
          return a.length > 0 && b.length > 0 && (a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`));
        }),
      );
    };
    for (let index = 0; index < definition.members.length; index += 1) {
      const member = required(definition.members[index]);
      if (member.worktree) continue;
      for (let earlier = index - 1; earlier >= 0; earlier -= 1) {
        const owner = required(definition.members[earlier]);
        if (owner.worktree || !overlaps(owner, member)) continue;
        const dependencies = required(dependencyKeys.get(member.key));
        if (dependencyReaches(member.key, owner.key) || dependencyReaches(owner.key, member.key)) continue;
        if (!dependencies.includes(owner.key)) dependencies.push(owner.key);
      }
    }
    const launch: SquadLaunch = {
      id: ids?.launchId ?? crypto.randomUUID(),
      squadId: definition.id,
      name: definition.name,
      goal: goalOverride ?? definition.goal,
      workspaceId,
      createdAt: new Date().toISOString(),
      members: definition.members.map(
        (member): SquadLaunchMember => ({
          key: member.key,
          role: member.role,
          managerKey: member.managerKey,
          operationId: required(operationIds.get(member.key)),
          ownedPaths: [...member.ownedPaths],
        }),
      ),
    };
    const promptFor = (member: SquadMemberDefinition): string | null => {
      if (member.task === null) return null;
      const dependencies = required(dependencyKeys.get(member.key));
      return [
        member.task,
        "",
        `Squad goal: ${launch.goal}`,
        `Member: ${member.key} (${member.role})`,
        `Manager: ${member.managerKey ?? "None"}`,
        `Owned paths: ${member.ownedPaths.length > 0 ? member.ownedPaths.join(", ") : "None declared"}`,
        `Depends on: ${dependencies.length > 0 ? dependencies.join(", ") : "None"}`,
        "Coordinate through the shared Operations, Ownership, Handoffs, Queue, and Needs You state. Preserve provider-native security and never overwrite another member's work.",
      ].join("\n");
    };
    // All member Operations exist before any provider work starts, like the native transaction.
    for (const member of definition.members) {
      const account = options.accountState?.(member) ?? { available: true, accountLabel: null };
      const spec: OperationSpec = {
        name: member.name,
        workspaceId,
        kind: "agent",
        command: null,
        prompt: promptFor(member),
        providerId: member.providerId,
        providerAccountId: member.providerAccountId,
        model: member.model,
        effort: member.effort,
        dependencies: required(dependencyKeys.get(member.key)).map((key) => required(operationIds.get(key))),
        priority: member.managerKey === null ? 8 : 5,
        lane: "next",
        environment: "local",
        urls: [],
        envKeys: [],
      };
      const operationId = required(operationIds.get(member.key));
      options.operations.create(operationId, spec, account.accountLabel);
      if (!account.available) options.operations.unavailable(operationId, account.accountLabel);
    }
    launches = [launch, ...launches];
    launchDefinitions.set(launch.id, clone(definition));
    requests.set(request, { fingerprint, launchId: launch.id });
    await tickLaunch(launch);
    return clone(launch);
  };

  const normalizedGoal = (value: unknown): string | null =>
    value == null ? null : rejectSecret(boundedMultiline(value, "squad_goal_invalid", "Squad goal", 16_384));

  const launchSquad = async (args: Record<string, unknown>, ids?: LaunchIds): Promise<SquadLaunch> => {
    options.requireCore();
    const workspaceId = id(args.workspaceId, "invalid_workspace_id", "That workspace");
    const request = requestId(args.requestId);
    const goalOverride = normalizedGoal(args.goalOverride);
    if (typeof args.squadId === "string" && UUID.test(args.squadId)) {
      const fingerprint = JSON.stringify({ kind: "squad", id: args.squadId, workspaceId, goalOverride });
      const replayed = replayRequest(request, fingerprint);
      if (replayed) return replayed;
    }
    const definition = resolve(args.squadId, squads, "squad");
    const fingerprint = JSON.stringify({ kind: "squad", id: definition.id, workspaceId, goalOverride });
    return makeLaunch(definition, workspaceId, request, fingerprint, goalOverride, ids);
  };

  const launchRecipe = async (args: Record<string, unknown>, ids?: LaunchIds): Promise<SquadLaunch> => {
    options.requireCore();
    const workspaceId = id(args.workspaceId, "invalid_workspace_id", "That workspace");
    const request = requestId(args.requestId);
    const explicitGoal = normalizedGoal(args.goalOverride);
    if (typeof args.recipeId === "string" && UUID.test(args.recipeId)) {
      const fingerprint = JSON.stringify({
        kind: "recipe",
        id: args.recipeId,
        workspaceId,
        goalOverride: explicitGoal,
      });
      const replayed = replayRequest(request, fingerprint);
      if (replayed) return replayed;
    }
    const recipe = resolve(args.recipeId, recipes, "recipe");
    const definition = resolve(recipe.squadId, squads, "squad");
    const goalOverride = explicitGoal ?? recipe.goal;
    const fingerprint = JSON.stringify({ kind: "recipe", id: recipe.id, workspaceId, goalOverride: explicitGoal });
    return makeLaunch(definition, workspaceId, request, fingerprint, goalOverride, ids);
  };

  const ensureOrion = async () => {
    if (!options.seedOrion || launches.some((launch) => launch.id === ORION_FIXTURE.launchId)) return;
    orionSeed ??= launchSquad(
      {
        squadId: ORION_FIXTURE.squadId,
        workspaceId: options.workspaceId(),
        requestId: "ui-test-orion-active",
        goalOverride: null,
      },
      { launchId: ORION_FIXTURE.launchId, operationIds: ORION_FIXTURE.operations },
    ).then(async (launch) => {
      await options.afterOrionSeed?.(launch);
    });
    await orionSeed;
  };

  const handlers: DashboardHandlers = {
    squads_snapshot: async () => {
      options.requireCore();
      await ensureOrion();
      await tick();
      const operationIds = launches.flatMap((launch) => launch.members.map((member) => member.operationId));
      const allOperations = options.operations.exact(operationIds);
      const byId = new Map(allOperations.map((operation) => [operation.id, operation] as const));
      let completed = 0;
      const includedLaunches = launches.filter((launch) => {
        const unfinished = launch.members.some((member) => byId.get(member.operationId)?.endedAt === null);
        if (unfinished) return true;
        completed += 1;
        return completed <= 100;
      });
      const includedOperationIds = new Set(
        includedLaunches.flatMap((launch) => launch.members.map((member) => member.operationId)),
      );
      return clone({
        squads,
        recipes,
        launches: includedLaunches,
        operations: allOperations.filter((operation) => includedOperationIds.has(operation.id)),
      } satisfies SquadsSnapshot);
    },
    squads_save: (args) => {
      options.requireCore();
      const definition = squadDefinition(args.definition);
      const conflict = squads.find(
        (candidate) =>
          candidate.id !== definition.id &&
          candidate.name.localeCompare(definition.name, undefined, { sensitivity: "accent" }) === 0,
      );
      if (conflict) fail("squad_name_exists", "A Squad already uses that name.");
      squads = [...squads.filter((candidate) => candidate.id !== definition.id), definition];
      return clone(definition);
    },
    squads_delete: (args) => {
      options.requireCore();
      const definition = resolve(args.id, squads, "squad");
      const dependent = sortedRecipes(recipes.filter((recipe) => recipe.squadId === definition.id));
      if (!Object.hasOwn(args, "expectedRecipes")) {
        if (dependent.length > 0) {
          fail(
            "squad_recipes_require_confirmation",
            "This Squad has saved Recipes. Review them before deleting the Squad.",
            true,
          );
        }
      } else {
        if (!Array.isArray(args.expectedRecipes)) {
          fail("squad_recipe_confirmation_invalid", "Review the dependent Recipes again before deleting this Squad.");
        }
        const expected = sortedRecipes(args.expectedRecipes.map(confirmedRecipe));
        if (new Set(expected.map((recipe) => recipe.id)).size !== expected.length) {
          fail("squad_recipe_confirmation_duplicate", "The Recipe confirmation contains a duplicate.");
        }
        if (JSON.stringify(expected) !== JSON.stringify(dependent)) {
          fail(
            "squad_recipe_confirmation_stale",
            "Recipes changed while deletion was being reviewed. Refresh and review the latest Recipes.",
            true,
          );
        }
      }
      squads = squads.filter((candidate) => candidate.id !== definition.id);
      recipes = recipes.filter((recipe) => recipe.squadId !== definition.id);
    },
    recipe_save: (args) => {
      options.requireCore();
      if (typeof args.recipe !== "object" || args.recipe === null) fail("recipe_invalid", "Enter a valid Recipe.");
      const source = args.recipe as SquadRecipe;
      const recipe: SquadRecipe = {
        id: id(source.id, "recipe_id_invalid", "That Recipe id"),
        name: text(source.name, "recipe_name_invalid", "Recipe name", 120),
        squadId: resolve(source.squadId, squads, "squad").id,
        goal:
          source.goal == null
            ? null
            : rejectSecret(boundedMultiline(source.goal, "squad_goal_invalid", "Recipe goal", 16_384)) || null,
      };
      if (
        recipes.some(
          (candidate) =>
            candidate.id !== recipe.id &&
            candidate.name.localeCompare(recipe.name, undefined, { sensitivity: "accent" }) === 0,
        )
      ) {
        fail("recipe_name_exists", "A Recipe already uses that name.");
      }
      recipes = [...recipes.filter((candidate) => candidate.id !== recipe.id), recipe];
      return clone(recipe);
    },
    recipe_delete: (args) => {
      options.requireCore();
      const recipe = resolve(args.id, recipes, "recipe");
      recipes = recipes.filter((candidate) => candidate.id !== recipe.id);
    },
    squads_launch: (args) => launchSquad(args),
    recipe_launch: (args) => launchRecipe(args),
    squads_reassign_manager: (args) => {
      options.requireCore();
      const launch = launchById(id(args.launchId, "squad_launch_id_invalid", "That launch"));
      const memberKey = text(args.memberKey, "squad_member_key_invalid", "Member key", 64);
      const member = launch.members.find((candidate) => candidate.key === memberKey);
      if (!member) fail("squad_member_not_found", "That Squad member no longer exists.");
      const managerKey = args.managerKey == null ? null : text(args.managerKey, "squad_manager_invalid", "Manager", 64);
      if (
        managerKey === memberKey ||
        (managerKey !== null && !launch.members.some((candidate) => candidate.key === managerKey))
      ) {
        fail("squad_manager_invalid", "Choose another member of this Squad as manager.");
      }
      const managers = new Map(
        launch.members.map((candidate) => [
          candidate.key,
          candidate.key === memberKey ? managerKey : candidate.managerKey,
        ]),
      );
      for (const key of managers.keys()) {
        const seen = new Set<string>();
        let current: string | null = key;
        while (current !== null) {
          if (seen.has(current)) fail("squad_manager_cycle", "Squad manager relationships cannot contain a cycle.");
          seen.add(current);
          current = managers.get(current) ?? null;
        }
      }
      const updated: SquadLaunch = {
        ...launch,
        members: launch.members.map((candidate) =>
          candidate.key === memberKey ? { ...candidate, managerKey } : candidate,
        ),
      };
      launches = launches.map((candidate) => (candidate.id === launch.id ? updated : candidate));
      return clone(updated);
    },
  };

  return { handlers };
}
