import type { PaneContent } from "@kalcode/protocol";
import type { BuiltinPreset } from "../../shell/panes/model.ts";
import type { PaneCommandResult } from "../../shell/panes/paneCommands.ts";
import type {
  FailedComponent,
  PlannedComponent,
  RecipeLaunchSummary,
  RecipeLink,
  RecipePreflight,
  StartedComponent,
} from "./model.ts";

/**
 * Executes a preflighted Recipe through canonical KalCode paths only (provider panes, terminals,
 * Operations, Squads, the pane command bus). Independent parts start concurrently; a part that
 * fails is cleaned up on its own and never takes down the parts that started. A cancelled launch
 * stops everything it started, so no terminal, agent or Service is left running unseen.
 */

type AgentPart = Extract<PlannedComponent, { kind: "agent" }>;

export interface RecipePorts {
  /** Starts one real coding terminal. Must leave nothing behind when it rejects. */
  createAgent(part: AgentPart, workspaceId: string): Promise<{ threadId: string }>;
  /** Sends the first task once the provider accepts input (native revalidates readiness). */
  deliverTask(threadId: string, task: string, signal: AbortSignal): Promise<void>;
  stopAgent(threadId: string): Promise<void>;
  createTerminal(workspaceId: string, name: string | null): Promise<{ terminalId: string }>;
  runInTerminal(terminalId: string, command: string): Promise<void>;
  closeTerminal(terminalId: string): Promise<void>;
  /** A Service already running in this project under this name (reused, never duplicated). */
  runningService(workspaceId: string, name: string): Promise<{ runId: string } | null>;
  startService(workspaceId: string, name: string, command: string): Promise<{ runId: string }>;
  stopService(runId: string): Promise<void>;
  launchSquad(
    squadId: string,
    workspaceId: string,
    goal: string | null,
    requestId: string,
  ): Promise<{ launchId: string; operationIds: string[] }>;
  /** Cancels canonical Operations (a cancelled Squad launch's members). */
  cancelOperations(operationIds: string[]): Promise<void>;
  browserContent(url: string): PaneContent;
  widgetContent(widget: string): PaneContent;
  openDesk(workspaceId: string, contents: PaneContent[], preset: BuiltinPreset | null): Promise<PaneCommandResult>;
  newRequestId(): string;
  now(): number;
}

export interface ExecuteOptions {
  signal?: AbortSignal;
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
}

type Outcome =
  | { ok: true; started: StartedComponent; content: PaneContent | null; undo: (() => Promise<void>) | null }
  | { ok: false; failed: FailedComponent };

const reasonOf = (cause: unknown): string => {
  if (cause instanceof Error && cause.message) return cause.message;
  if (typeof cause === "object" && cause && "message" in cause && typeof cause.message === "string")
    return cause.message;
  return "It didn't start. Try again.";
};

class Cancelled extends Error {
  constructor() {
    super("Launch cancelled.");
  }
}

async function startPart(
  part: PlannedComponent,
  workspaceId: string,
  ports: RecipePorts,
  signal: AbortSignal,
): Promise<Outcome> {
  const started = (link: RecipeLink | null, extra: Partial<StartedComponent> = {}): StartedComponent => ({
    key: part.key,
    kind: part.kind,
    label: part.label,
    link,
    ...extra,
  });
  const fail = (cause: unknown): Outcome => ({
    ok: false,
    failed: { key: part.key, kind: part.kind, label: part.label, reason: reasonOf(cause) },
  });
  try {
    switch (part.kind) {
      case "agent": {
        const { threadId } = await ports.createAgent(part, workspaceId);
        // From here the session is real: on Cancel the executor undoes it with every other part.
        const undo = () => ports.stopAgent(threadId);
        const content: PaneContent = { kind: "agent", agentId: threadId };
        let note: string | undefined;
        if (part.task && !signal.aborted) {
          // The agent is real and running; an undelivered first task is reported, not undone.
          await ports.deliverTask(threadId, part.task, signal).catch((cause) => {
            if (!signal.aborted) note = `Started, but the first task wasn't sent: ${reasonOf(cause)}`;
          });
        }
        return { ok: true, started: started({ kind: "pane", content }, note ? { note } : {}), content, undo };
      }
      case "terminal": {
        const { terminalId } = await ports.createTerminal(workspaceId, part.name);
        const undo = () => ports.closeTerminal(terminalId);
        const content: PaneContent = { kind: "terminal", terminalId };
        if (part.command && !signal.aborted) {
          try {
            await ports.runInTerminal(terminalId, part.command);
          } catch (cause) {
            // A shell that can't run its command is closed; if even that fails, say it's still open.
            const closed = await undo().then(
              () => true,
              () => false,
            );
            throw new Error(
              closed ? reasonOf(cause) : `${reasonOf(cause)} The terminal is still open; close it from the Stack.`,
            );
          }
        }
        return { ok: true, started: started({ kind: "pane", content }), content, undo };
      }
      case "browser": {
        const content = ports.browserContent(part.url);
        return { ok: true, started: started({ kind: "pane", content }), content, undo: null };
      }
      case "widget": {
        const content = ports.widgetContent(part.widget);
        return { ok: true, started: started({ kind: "pane", content }), content, undo: null };
      }
      case "service": {
        const running = await ports.runningService(workspaceId, part.name);
        if (running) {
          return {
            ok: true,
            started: started({ kind: "service", runId: running.runId }, { reused: true }),
            content: null,
            undo: null,
          };
        }
        if (signal.aborted) throw new Cancelled();
        const { runId } = await ports.startService(workspaceId, part.name, part.command);
        return {
          ok: true,
          started: started({ kind: "service", runId }),
          content: null,
          undo: () => ports.stopService(runId),
        };
      }
      case "squad": {
        if (signal.aborted) throw new Cancelled();
        const { launchId, operationIds } = await ports.launchSquad(
          part.squadId,
          workspaceId,
          part.goal,
          ports.newRequestId(),
        );
        // Members are canonical Operations: undo cancels exactly this launch's members.
        return {
          ok: true,
          started: started({ kind: "squad", launchId }),
          content: null,
          undo: () => ports.cancelOperations(operationIds),
        };
      }
    }
  } catch (cause) {
    return fail(cause);
  }
}

/** Runs `tasks` with at most `limit` in flight, preserving result order. */
async function bounded<T>(tasks: (() => Promise<T>)[], limit: number, onDone: () => void): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const index = next++;
      results[index] = await (tasks[index] as () => Promise<T>)();
      onDone();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

export async function executeRecipe(
  preflight: RecipePreflight,
  ports: RecipePorts,
  { signal = new AbortController().signal, concurrency = 4, onProgress }: ExecuteOptions = {},
): Promise<RecipeLaunchSummary> {
  const startedAt = ports.now();
  const workspaceId = preflight.workspace?.id;
  const base = {
    recipeId: preflight.recipe.id,
    recipeName: preflight.recipe.name,
    workspaceId: workspaceId ?? "",
    // A blocked part the person didn't fix or skip is skipped too, and the summary says why.
    skipped: [
      ...preflight.skipped,
      ...preflight.blockers.flatMap((blocker) =>
        blocker.componentKey ? [{ key: blocker.componentKey, label: blocker.title, reason: blocker.detail }] : [],
      ),
    ],
  };
  if (!workspaceId || preflight.blockers.some((blocker) => !blocker.skippable)) {
    return {
      ...base,
      started: [],
      failed: [],
      notice: preflight.blockers[0]?.detail ?? "Open a project first.",
      durationMs: 0,
    };
  }
  const total = preflight.plan.length;
  let done = 0;
  onProgress?.(0, total);
  const outcomes = await bounded(
    preflight.plan.map((part) => () => startPart(part, workspaceId, ports, signal)),
    Math.max(1, concurrency),
    () => onProgress?.(++done, total),
  );
  if (signal.aborted) {
    // Cancel means undo: stop every process this launch started, and say exactly what survived.
    const undone = outcomes.flatMap((outcome) => (outcome.ok && outcome.undo ? [outcome] : []));
    const results = await Promise.allSettled(undone.map((outcome) => (outcome.undo as () => Promise<void>)()));
    const survivors = undone.flatMap((outcome, index) =>
      results[index]?.status === "rejected" ? [outcome.started] : [],
    );
    return {
      ...base,
      // Whatever couldn't be stopped is still running, so it stays listed with its link.
      started: survivors.map((part) => ({ ...part, note: "Still running: it couldn't be stopped. Close it here." })),
      failed: [],
      notice:
        survivors.length === 0
          ? "Launch cancelled. Everything it started was stopped."
          : `Launch cancelled. ${survivors.length} of ${undone.length} couldn't be stopped and are still running.`,
      durationMs: ports.now() - startedAt,
    };
  }
  const started = outcomes.flatMap((outcome) => (outcome.ok ? [outcome.started] : []));
  const failed = outcomes.flatMap((outcome) => (outcome.ok ? [] : [outcome.failed]));
  const contents = outcomes.flatMap((outcome) => (outcome.ok && outcome.content ? [outcome.content] : []));
  let notice: string | null = null;
  if (contents.length > 0) {
    const shown = await ports.openDesk(workspaceId, contents, preflight.layout as BuiltinPreset | null);
    // Sessions keep running when the canvas can't show them; they're one click away in the stack.
    if (!shown.handled) notice = `${shown.message} Everything started is listed in the Stack.`;
  }
  return { ...base, started, failed, notice, durationMs: ports.now() - startedAt };
}
