import type {
  DevelopmentService,
  OperationEnvironmentKind,
  OperationRecord,
  OperationsSnapshot,
} from "@kalcode/protocol";
import type { OperationsApi } from "../ipc/operations.ts";
import type { OperationsTab } from "../surfaces/operations/model.ts";
import { normalizeSpoken } from "./sessionChoice.ts";

export type OperationsVoiceTarget =
  | { kind: "tab"; tab: OperationsTab }
  | { kind: "run"; tab: "runs"; runId: string; workspaceId: string; label: string }
  | { kind: "queue"; tab: "queue"; runId: string; workspaceId: string; label: string }
  | { kind: "service"; tab: "services"; serviceId: string; workspaceId: string; label: string }
  | {
      kind: "environment";
      tab: "environments";
      workspaceId: string | null;
      environment: OperationEnvironmentKind;
      label: string;
    }
  | { kind: "activity"; tab: "activity"; activityId: string; workspaceId: string | null; label: string };

export interface OperationsVoiceChoice {
  id: string;
  label: string;
  target: OperationsVoiceTarget;
  action?: { kind: "restart_service"; serviceId: string };
}

export type OperationsVoiceDecision =
  | { kind: "unhandled" }
  | { kind: "action"; action: "navigate" | "restart_service"; message: string; target: OperationsVoiceTarget }
  | { kind: "query"; message: string; target: OperationsVoiceTarget | null }
  | { kind: "failed"; message: string; target: OperationsVoiceTarget | null }
  | { kind: "ambiguous"; question: string; choices: OperationsVoiceChoice[] };

export type OperationsVoiceResult =
  | { handled: false }
  | {
      handled: true;
      status: "completed" | "needs_choice" | "failed";
      message: string;
      target: OperationsVoiceTarget | null;
      choices?: OperationsVoiceChoice[];
      /** The KalVoice Request was refused (limit reached) and the refusal is already shown. */
      refused?: true;
    };

export interface OperationsVoiceDependencies {
  client: Pick<OperationsApi, "snapshot" | "history" | "serviceAction">;
  /** Opens the canonical Operations surface. */
  navigate(): void;
  /** Focuses the real Operations projection after navigation. */
  focus(target: OperationsVoiceTarget): Promise<boolean> | boolean;
  /** Cancels stale speech work before any UI or service side effect. */
  signal?: AbortSignal;
  /**
   * Takes this command's KalVoice Request immediately before it acts or answers. `false` means
   * it was refused (and the refusal shown), so nothing runs.
   */
  claim?: () => Promise<boolean>;
}

const REFUSED: OperationsVoiceResult = { handled: true, status: "failed", message: "", target: null, refused: true };

async function claimed(deps: OperationsVoiceDependencies): Promise<boolean> {
  return deps.claim ? await deps.claim() : true;
}

const FINISHED = new Set<OperationRecord["status"]>(["succeeded", "failed", "cancelled", "interrupted"]);

const TAB_LABELS: Record<OperationsTab, string> = {
  runs: "Runs",
  queue: "Queue",
  squads: "Squads",
  services: "Services",
  environments: "Environments",
  activity: "Activity",
};

const TAB_ALIASES: Record<string, OperationsTab> = {
  operations: "runs",
  run: "runs",
  runs: "runs",
  queue: "queue",
  squad: "squads",
  squads: "squads",
  team: "squads",
  teams: "squads",
  service: "services",
  services: "services",
  environment: "environments",
  environments: "environments",
  activity: "activity",
};

function withPeriod(text: string): string {
  const value = text.trim();
  return /[.!?]$/.test(value) ? value : `${value}.`;
}

function recordTime(record: OperationRecord): number {
  const parsed = Date.parse(record.endedAt ?? record.startedAt ?? record.createdAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

function latest(records: readonly OperationRecord[]): OperationRecord | null {
  return records.toSorted((left, right) => recordTime(right) - recordTime(left))[0] ?? null;
}

function runTarget(record: OperationRecord): OperationsVoiceTarget {
  return {
    kind: "run",
    tab: "runs",
    runId: record.id,
    workspaceId: record.spec.workspaceId,
    label: record.spec.name,
  };
}

function queueTarget(record: OperationRecord): OperationsVoiceTarget {
  return {
    kind: "queue",
    tab: "queue",
    runId: record.id,
    workspaceId: record.spec.workspaceId,
    label: record.spec.name,
  };
}

function serviceTarget(service: DevelopmentService): OperationsVoiceTarget {
  return {
    kind: "service",
    tab: "services",
    serviceId: service.id,
    workspaceId: service.workspaceId,
    label: service.name,
  };
}

function navigationTab(spoken: string): OperationsTab | null {
  const direct = spoken.match(
    /^(?:(?:open|show|show me|go to|take me to)(?: the)? )?(operations|runs?|queue|squads?|teams?|services?|environments?|activity)$/,
  );
  return direct?.[1] ? (TAB_ALIASES[direct[1]] ?? null) : null;
}

function navigationDecision(
  spoken: string,
  previousTarget: OperationsVoiceTarget | null,
): Extract<OperationsVoiceDecision, { kind: "action" }> | null {
  if (/^(?:open|show|focus)(?: it| that| this)$/.test(spoken) && previousTarget) {
    const label = previousTarget.kind === "tab" ? TAB_LABELS[previousTarget.tab] : previousTarget.label;
    return { kind: "action", action: "navigate", message: `Opened ${label}.`, target: previousTarget };
  }
  const tab = navigationTab(spoken);
  if (!tab) return null;
  return {
    kind: "action",
    action: "navigate",
    message: tab === "runs" && /operations/.test(spoken) ? "Opened Operations." : `Opened ${TAB_LABELS[tab]}.`,
    target: { kind: "tab", tab },
  };
}

function isLastFailedRequest(spoken: string): boolean {
  return /^(?:open|show|show me)(?: the)? (?:last|latest|most recent) failed (?:run|task)$/.test(spoken);
}

function isJustFinishedRequest(spoken: string): boolean {
  return /^(?:what|which)(?: has|'s)? just finished(?: running)?$/.test(spoken);
}

function statusRequest(spoken: string): "running" | "blocked" | null {
  const match = spoken.match(
    /^(?:what(?: is|'s)|which (?:run|task|thing) is) (?:currently )?(running|blocked)(?: right now)?$/,
  );
  return (match?.[1] as "running" | "blocked" | undefined) ?? null;
}

function restartQuery(spoken: string): string | null {
  const match = spoken.match(/^(?:restart|relaunch)(?: the)? (.+?)(?: service)?$/);
  return match?.[1]?.trim() || null;
}

function displayServiceQuery(query: string): string {
  return query
    .split(" ")
    .map((word) => (word.length <= 3 ? word.toUpperCase() : word))
    .join(" ");
}

/** Cheap shape check used before any native snapshot I/O, so terminal dictation stays untouched. */
export function isOperationsVoiceText(text: string, previousTarget: OperationsVoiceTarget | null = null): boolean {
  const spoken = normalizeSpoken(text);
  if (!spoken) return false;
  if (/^(?:open|show|focus)(?: it| that| this)$/.test(spoken)) return previousTarget !== null;
  return (
    navigationTab(spoken) !== null ||
    /^(?:open|show|show me|go to|take me to)(?: the)? production(?: environment)?$/.test(spoken) ||
    isLastFailedRequest(spoken) ||
    isJustFinishedRequest(spoken) ||
    statusRequest(spoken) !== null ||
    restartQuery(spoken) !== null
  );
}

const GENERIC_SERVICE_WORDS = new Set(["service", "server", "process", "app", "application"]);

function meaningfulServiceName(value: string): string {
  return normalizeSpoken(value)
    .split(" ")
    .filter((word) => !GENERIC_SERVICE_WORDS.has(word))
    .join(" ");
}

function serviceAliases(service: DevelopmentService): Set<string> {
  const aliases = [service.id, service.name, service.processName].flatMap((value) => [
    normalizeSpoken(value),
    meaningfulServiceName(value),
  ]);
  for (const url of service.urls) {
    try {
      const parsed = new URL(url);
      aliases.push(normalizeSpoken(parsed.hostname), normalizeSpoken(`${parsed.hostname} ${parsed.port}`));
    } catch {
      // Native Operations already validates URLs. A stale malformed observation is ignored here.
    }
  }
  for (const port of service.ports) aliases.push(String(port));
  return new Set(aliases.filter(Boolean));
}

function matchingServices(query: string, services: readonly DevelopmentService[]): DevelopmentService[] {
  const normalized = normalizeSpoken(query);
  const meaningful = meaningfulServiceName(query);
  const keys = new Set([normalized, meaningful].filter(Boolean));
  return services.filter((service) => {
    const aliases = serviceAliases(service);
    return [...keys].some((key) => aliases.has(key));
  });
}

function serviceChoices(services: readonly DevelopmentService[]): OperationsVoiceChoice[] {
  const baseLabels = services.map((service) => `${service.name} — ${service.workspaceName}`);
  const qualifiedLabels = services.map((service, index) => {
    const base = baseLabels[index] as string;
    if (baseLabels.filter((label) => label === base).length === 1) return base;
    const qualifier = service.ports[0] ? `:${service.ports[0]}` : service.processName || service.id;
    return `${base} · ${qualifier}`;
  });
  return services.map((service, index) => {
    const qualified = qualifiedLabels[index] as string;
    const label =
      qualifiedLabels.filter((candidate) => candidate === qualified).length > 1
        ? `${qualified} · ${service.id}`
        : qualified;
    return {
      id: service.id,
      label,
      target: serviceTarget(service),
      action: { kind: "restart_service", serviceId: service.id },
    };
  });
}

function workspaceLabel(snapshot: OperationsSnapshot, workspaceId: string): string {
  return (
    snapshot.items.find((record) => record.spec.workspaceId === workspaceId)?.workspaceName ??
    snapshot.services.find((service) => service.workspaceId === workspaceId)?.workspaceName ??
    workspaceId
  );
}

function productionChoices(snapshot: OperationsSnapshot): OperationsVoiceChoice[] {
  const workspaces = new Set(
    snapshot.environments
      .filter((environment) => environment.kind === "production")
      .map((environment) => environment.workspaceId),
  );
  return [...workspaces].map((workspaceId) => {
    const workspace = workspaceLabel(snapshot, workspaceId);
    return {
      id: `environment:production:${workspaceId}`,
      label: `Production — ${workspace}`,
      target: {
        kind: "environment",
        tab: "environments",
        workspaceId,
        environment: "production",
        label: `${workspace} Production`,
      },
    };
  });
}

function listNames(records: readonly OperationRecord[]): string {
  if (records.length === 1) return records[0]?.spec.name ?? "One run";
  if (records.length === 2) return `${records[0]?.spec.name} and ${records[1]?.spec.name}`;
  return `${records
    .slice(0, -1)
    .map((record) => record.spec.name)
    .join(", ")}, and ${records.at(-1)?.spec.name}`;
}

function conciseNames(records: readonly OperationRecord[]): string {
  if (records.length <= 3) return listNames(records);
  return `${listNames(records.slice(0, 3))}, and ${records.length - 3} more`;
}

/** Resolves only bounded, deterministic Operations language against one canonical snapshot. */
export function resolveOperationsVoice(
  text: string,
  snapshot: OperationsSnapshot,
  previousTarget: OperationsVoiceTarget | null = null,
): OperationsVoiceDecision {
  const spoken = normalizeSpoken(text);
  if (!spoken) return { kind: "unhandled" };

  const navigation = navigationDecision(spoken, previousTarget);
  if (navigation) return navigation;

  if (/^(?:open|show|show me|go to|take me to)(?: the)? production(?: environment)?$/.test(spoken)) {
    const observed = snapshot.environments.filter((environment) => environment.kind === "production");
    if (new Set(observed.map((environment) => environment.workspaceId)).size > 1) {
      return {
        kind: "ambiguous",
        question: "Which workspace's Production environment?",
        choices: productionChoices(snapshot),
      };
    }
    const workspaceId = observed.length === 1 ? (observed[0]?.workspaceId ?? null) : null;
    return {
      kind: "action",
      action: "navigate",
      message:
        observed.length === 0
          ? "Opened Production. No production environment is currently observed."
          : "Opened Production.",
      target: {
        kind: "environment",
        tab: "environments",
        workspaceId,
        environment: "production",
        label: "Production",
      },
    };
  }

  if (isLastFailedRequest(spoken)) {
    const failed = latest(snapshot.items.filter((record) => record.status === "failed"));
    if (!failed)
      return { kind: "failed", message: "No failed run was found in recent Operations history.", target: null };
    return {
      kind: "action",
      action: "navigate",
      message: `Opened ${failed.spec.name}, the latest failed run.`,
      target: runTarget(failed),
    };
  }

  if (isJustFinishedRequest(spoken)) {
    const finished = latest(snapshot.items.filter((record) => FINISHED.has(record.status) && record.endedAt !== null));
    if (!finished)
      return { kind: "query", message: "Nothing has finished in recent Operations history.", target: null };
    const outcome = finished.outcome?.trim();
    return {
      kind: "query",
      message: outcome
        ? `${finished.spec.name} finished: ${withPeriod(outcome)}`
        : `${finished.spec.name} finished ${finished.status}.`,
      target: runTarget(finished),
    };
  }

  const requestedStatus = statusRequest(spoken);
  if (requestedStatus === "running") {
    const running = snapshot.items
      .filter((record) => record.status === "running" || record.status === "starting")
      .toSorted((left, right) => recordTime(right) - recordTime(left));
    if (running.length === 0) return { kind: "query", message: "No Operations runs are running.", target: null };
    if (running.length === 1) {
      const current = running[0] as OperationRecord;
      return {
        kind: "query",
        message: current.currentAction
          ? `${current.spec.name} is running: ${withPeriod(current.currentAction)}`
          : `${current.spec.name} is running.`,
        target: runTarget(current),
      };
    }
    return {
      kind: "query",
      message: `${running.length} runs are running: ${conciseNames(running)}.`,
      target: { kind: "tab", tab: "runs" },
    };
  }

  if (requestedStatus === "blocked") {
    const blocked = snapshot.items.filter((record) => record.status === "blocked");
    if (blocked.length === 0) return { kind: "query", message: "No Operations work is blocked.", target: null };
    if (blocked.length === 1) {
      const current = blocked[0] as OperationRecord;
      const dependencies = current.blockers.length;
      return {
        kind: "query",
        message:
          dependencies > 0
            ? `${current.spec.name} is blocked by ${dependencies} ${dependencies === 1 ? "dependency" : "dependencies"}.`
            : `${current.spec.name} is blocked.`,
        target: queueTarget(current),
      };
    }
    return {
      kind: "query",
      message: `${blocked.length} runs are blocked: ${conciseNames(blocked)}.`,
      target: { kind: "tab", tab: "queue" },
    };
  }

  const restart = restartQuery(spoken);
  if (restart) {
    const matches = matchingServices(restart, snapshot.services);
    if (matches.length === 0) {
      return { kind: "failed", message: `I couldn't find a service named ${restart}.`, target: null };
    }
    if (matches.length > 1) {
      return {
        kind: "ambiguous",
        question: `Which ${displayServiceQuery(restart)} service?`,
        choices: serviceChoices(matches),
      };
    }
    const service = matches[0] as DevelopmentService;
    const target = serviceTarget(service);
    if (!service.canRestart) {
      return {
        kind: "failed",
        message: service.actionReason ?? `${service.name} cannot be restarted safely from Operations.`,
        target,
      };
    }
    return {
      kind: "action",
      action: "restart_service",
      message: `${service.name} restart started.`,
      target,
    };
  }

  return { kind: "unhandled" };
}

function targetStillExists(snapshot: OperationsSnapshot, target: OperationsVoiceTarget): boolean {
  switch (target.kind) {
    case "tab":
      return true;
    case "run":
    case "queue":
      return snapshot.items.some((record) => record.id === target.runId);
    case "service":
      return snapshot.services.some((service) => service.id === target.serviceId);
    case "environment":
      return snapshot.environments.some(
        (environment) =>
          environment.kind === target.environment &&
          (target.workspaceId === null || environment.workspaceId === target.workspaceId),
      );
    case "activity":
      return snapshot.activity.some((activity) => activity.id === target.activityId);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : "Operations could not complete that action.";
}

async function openTarget(deps: OperationsVoiceDependencies, target: OperationsVoiceTarget): Promise<boolean> {
  if (deps.signal?.aborted) return false;
  deps.navigate();
  if (deps.signal?.aborted) return false;
  return await deps.focus(target);
}

async function executeAction(
  decision: Extract<OperationsVoiceDecision, { kind: "action" }>,
  deps: OperationsVoiceDependencies,
): Promise<OperationsVoiceResult> {
  try {
    if (!(await claimed(deps))) return REFUSED;
    const focused = await openTarget(deps, decision.target);
    if (!focused) {
      if (deps.signal?.aborted) {
        return { handled: true, status: "failed", message: "Voice request cancelled.", target: decision.target };
      }
      return {
        handled: true,
        status: "failed",
        message: "Operations opened, but the requested item is no longer visible.",
        target: decision.target,
      };
    }
    if (decision.action === "restart_service" && decision.target.kind === "service") {
      if (deps.signal?.aborted) {
        return { handled: true, status: "failed", message: "Voice request cancelled.", target: decision.target };
      }
      // The native Operations command owns the required confirmation and the exact service claim.
      await deps.client.serviceAction(decision.target.serviceId, "restart");
    }
    return { handled: true, status: "completed", message: decision.message, target: decision.target };
  } catch (error) {
    return { handled: true, status: "failed", message: errorMessage(error), target: decision.target };
  }
}

/** Fetches current Operations truth, resolves a bounded intent, and dispatches through canonical APIs. */
export async function handleOperationsVoice(
  text: string,
  deps: OperationsVoiceDependencies,
  previousTarget: OperationsVoiceTarget | null = null,
): Promise<OperationsVoiceResult> {
  if (!isOperationsVoiceText(text, previousTarget)) return { handled: false };
  if (deps.signal?.aborted) {
    return { handled: true, status: "failed", message: "Voice request cancelled.", target: null };
  }
  const directNavigation = navigationDecision(normalizeSpoken(text), previousTarget);
  if (directNavigation) return await executeAction(directNavigation, deps);
  let snapshot: OperationsSnapshot;
  try {
    snapshot = await deps.client.snapshot();
  } catch (error) {
    return { handled: true, status: "failed", message: errorMessage(error), target: null };
  }

  if (deps.signal?.aborted) {
    return { handled: true, status: "failed", message: "Voice request cancelled.", target: null };
  }

  let decision = resolveOperationsVoice(text, snapshot, previousTarget);
  if (decision.kind === "failed" && isLastFailedRequest(normalizeSpoken(text))) {
    try {
      const history = await deps.client.history(null);
      decision = resolveOperationsVoice(
        text,
        { ...snapshot, items: [...snapshot.items, ...history.items] },
        previousTarget,
      );
    } catch (error) {
      return { handled: true, status: "failed", message: errorMessage(error), target: null };
    }
  }

  if (decision.kind === "unhandled") return { handled: false };
  if (decision.kind === "ambiguous") {
    return {
      handled: true,
      status: "needs_choice",
      message: decision.question,
      target: null,
      choices: decision.choices,
    };
  }
  if (decision.kind === "query") {
    if (!(await claimed(deps))) return REFUSED;
    return { handled: true, status: "completed", message: decision.message, target: decision.target };
  }
  if (decision.kind === "failed") {
    return { handled: true, status: "failed", message: decision.message, target: decision.target };
  }

  return await executeAction(decision, deps);
}

/** Executes one short-lived chooser result after revalidating its stable id in a fresh snapshot. */
export async function executeOperationsVoiceChoice(
  choice: OperationsVoiceChoice,
  deps: OperationsVoiceDependencies,
): Promise<OperationsVoiceResult> {
  if (deps.signal?.aborted)
    return { handled: true, status: "failed", message: "Voice request cancelled.", target: null };
  try {
    const snapshot = await deps.client.snapshot();
    if (deps.signal?.aborted) {
      return { handled: true, status: "failed", message: "Voice request cancelled.", target: choice.target };
    }
    const action = choice.action;
    if (!action) {
      if (!targetStillExists(snapshot, choice.target)) {
        return {
          handled: true,
          status: "failed",
          message: "That Operations item is no longer available.",
          target: choice.target,
        };
      }
      if (!(await claimed(deps))) return REFUSED;
      const focused = await openTarget(deps, choice.target);
      if (!focused && deps.signal?.aborted) {
        return { handled: true, status: "failed", message: "Voice request cancelled.", target: choice.target };
      }
      return {
        handled: true,
        status: focused ? "completed" : "failed",
        message: focused
          ? `Opened ${choice.label}.`
          : "Operations opened, but the requested item is no longer visible.",
        target: choice.target,
      };
    }
    const service = snapshot.services.find((candidate) => candidate.id === action.serviceId);
    if (!service) {
      return { handled: true, status: "failed", message: "That service is no longer available.", target: null };
    }
    const target = serviceTarget(service);
    if (!service.canRestart) {
      return {
        handled: true,
        status: "failed",
        message: service.actionReason ?? `${service.name} cannot be restarted safely from Operations.`,
        target,
      };
    }
    if (!(await claimed(deps))) return REFUSED;
    if (!(await openTarget(deps, target))) {
      return {
        handled: true,
        status: "failed",
        message: "Operations opened, but the requested service is no longer visible.",
        target,
      };
    }
    if (deps.signal?.aborted) return { handled: true, status: "failed", message: "Voice request cancelled.", target };
    // The chooser binds only the target id. Native confirmation remains mandatory and current.
    await deps.client.serviceAction(service.id, "restart");
    return {
      handled: true,
      status: "completed",
      message: `${service.name} restart started.`,
      target,
    };
  } catch (error) {
    return { handled: true, status: "failed", message: errorMessage(error), target: choice.target };
  }
}

export const OPERATIONS_VOICE_FOCUS_EVENT = "kalcode:operations-voice-focus";

export interface OperationsFocusOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface OperationsVoiceFocusRequest {
  target: OperationsVoiceTarget;
  expiresAt: number;
  isActive(): boolean;
  acknowledge(focused: boolean): void;
}

export interface OperationsVoiceFocusLease {
  expiresAt: number;
  isActive(): boolean;
}

/** Waits for the Operations view to mount, then hands it one typed, ephemeral focus intent. */
export async function focusOperationsTarget(
  target: OperationsVoiceTarget,
  options: OperationsFocusOptions = {},
): Promise<boolean> {
  if (typeof window === "undefined" || typeof document === "undefined") return false;
  const timeoutMs = options.timeoutMs ?? 3_000;
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    let dispatched = false;
    const expiresAt = Date.now() + timeoutMs;
    const finish = (focused: boolean) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(deadline);
      options.signal?.removeEventListener("abort", cancel);
      resolve(focused);
    };
    const cancel = () => finish(false);
    const poll = () => {
      if (settled || dispatched) return;
      if (options.signal?.aborted) {
        finish(false);
        return;
      }
      const ready = document.querySelector('[data-operations-view][data-operations-voice-ready="true"]');
      if (ready) {
        dispatched = true;
        const detail: OperationsVoiceFocusRequest = {
          target,
          expiresAt,
          isActive: () => !settled,
          acknowledge: finish,
        };
        window.dispatchEvent(new CustomEvent<OperationsVoiceFocusRequest>(OPERATIONS_VOICE_FOCUS_EVENT, { detail }));
        return;
      }
      window.setTimeout(poll, 16);
    };
    const deadline = window.setTimeout(() => finish(false), timeoutMs);
    options.signal?.addEventListener("abort", cancel, { once: true });
    poll();
  });
}

/** Installs the Operations view side of the ephemeral focus-intent handoff. */
export function subscribeOperationsVoiceFocus(
  listener: (
    target: OperationsVoiceTarget,
    acknowledge: (focused: boolean) => void,
    lease: OperationsVoiceFocusLease,
  ) => void,
): () => void {
  const receive = (event: Event) => {
    const request = (event as CustomEvent<OperationsVoiceFocusRequest>).detail;
    if (
      request?.target &&
      typeof request.acknowledge === "function" &&
      typeof request.expiresAt === "number" &&
      typeof request.isActive === "function"
    ) {
      listener(request.target, request.acknowledge, {
        expiresAt: request.expiresAt,
        isActive: request.isActive,
      });
    }
  };
  window.addEventListener(OPERATIONS_VOICE_FOCUS_EVENT, receive);
  return () => window.removeEventListener(OPERATIONS_VOICE_FOCUS_EVENT, receive);
}
