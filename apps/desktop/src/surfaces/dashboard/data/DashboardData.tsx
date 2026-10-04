import type { TerminalInfo, ThreadSummary } from "@kalcode/protocol";
import { useToast } from "@kalcode/ui/components";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { toKalCodeError } from "../../../ipc/errors.ts";
import { useEvents, useRuntime } from "../../../runtime/RuntimeProvider.tsx";
import { ACTION_LABELS, type ThreadAction } from "./actions.ts";
import { isCodingAgent } from "./agents.ts";
import { fleetCounts } from "./board.ts";
import { type DashboardResource, RefreshTracker } from "./refresh.ts";
import { type Resource, type ResourceState, useResource } from "./resource.ts";

/** Coalesces bursts of events (a busy thread emits many) into one read per source. */
const REFRESH_DEBOUNCE_MS = 120;

export interface Announcement {
  id: number;
  text: string;
}

interface DashboardDataValue {
  /** Open (non-archived) threads: what the board, widgets and summary show. */
  threads: Resource<ThreadSummary[]>;
  /** Archived threads, from the same read (shown read-only, restorable with Unarchive). */
  archived: Resource<ThreadSummary[]>;
  terminals: Resource<TerminalInfo[]>;
  /** Thread id → action in flight. */
  pendingActions: ReadonlyMap<string, ThreadAction>;
  runAction: (thread: ThreadSummary, action: Exclude<ThreadAction, "open">) => Promise<void>;
  /** Many agents at once (Fleet cleanup): see `BulkStep`. */
  runBulk: (steps: readonly BulkStep[]) => Promise<BulkResult>;
  /** Screen-reader announcements (new approvals are announced app-wide by ApprovalAnnouncer). */
  urgent: Announcement | null;
  polite: Announcement | null;
}

/**
 * One agent's part of a bulk cleanup: the contract commands to run, in order (for example
 * `["stop", "archive"]` for an agent that is still working). A step stops at its first failure.
 */
export interface BulkStep {
  thread: ThreadSummary;
  commands: readonly ("stop" | "archive" | "unarchive")[];
}

export interface BulkResult {
  /** Agents whose every command succeeded, as native returned them. */
  done: ThreadSummary[];
  /** Agents with a failed command (left as they were after it). */
  failed: number;
}

/** Bulk cleanup runs this many agents at once: fast for hundreds, gentle on the runtime. */
const BULK_CONCURRENCY = 8;

const DashboardDataContext = createContext<DashboardDataValue | null>(null);

function createSession() {
  return {
    active: true,
    tracker: null as RefreshTracker | null,
    pending: new Set<DashboardResource>(),
    timer: null as ReturnType<typeof setTimeout> | null,
    actions: new Map<string, symbol>(),
  };
}

type Session = ReturnType<typeof createSession>;
type Lifetime = { session: Session };

function useInvalidation(lifetime: Lifetime, isCurrent: (session: Session) => boolean) {
  const [versions, setVersions] = useState<Record<DashboardResource, number>>({
    threads: 0,
    approvals: 0,
    terminals: 0,
  });
  const invalidate = useCallback(
    (stale: Iterable<DashboardResource>, session = lifetime.session) => {
      if (!isCurrent(session)) return;
      for (const resource of stale) session.pending.add(resource);
      if (session.pending.size === 0 || session.timer) return;
      session.timer = setTimeout(() => {
        session.timer = null;
        if (!isCurrent(session)) return;
        const batch = [...session.pending];
        session.pending.clear();
        setVersions((v) => {
          if (!isCurrent(session)) return v;
          const next = { ...v };
          for (const resource of batch) next[resource] += 1;
          return next;
        });
      }, REFRESH_DEBOUNCE_MS);
    },
    [lifetime, isCurrent],
  );

  return [versions, invalidate] as const;
}

const isArchived = (thread: ThreadSummary) => thread.archivedAt !== null;

/**
 * One side of the thread list: the open threads or the archived ones. Both come from one
 * `thread_list` read (archived included), so the two can never disagree about a thread.
 */
function useThreadSide(source: Resource<ThreadSummary[]>, archived: boolean): Resource<ThreadSummary[]> {
  const { state, reload, update } = source;
  const side = useMemo<ResourceState<ThreadSummary[]>>(
    () => (state.status === "ready" ? { ...state, data: state.data.filter((t) => isArchived(t) === archived) } : state),
    [state, archived],
  );
  const updateSide = useCallback(
    (change: (data: ThreadSummary[]) => ThreadSummary[]) =>
      update((list) => [
        ...change(list.filter((t) => isArchived(t) === archived)),
        ...list.filter((t) => isArchived(t) !== archived),
      ]),
    [update, archived],
  );
  return useMemo(() => ({ state: side, reload, update: updateSide }), [side, reload, updateSide]);
}

/**
 * The Dashboard's data layer. Reads threads (Z3 `thread_list`) and running terminals (Z1
 * `terminals_running`) through KalCodeClient, and re-reads each whenever the event log records
 * something that can change it. Thread actions go through the contract commands; results are
 * applied immediately and then reconciled by the event-driven refresh. Pending approvals come
 * from the permission engine's shared state (`usePermissions`, Z4), like the Approvals panel.
 */
export function DashboardDataProvider({ children }: { children: ReactNode }) {
  const { client } = useRuntime();
  const { events, state: eventsState } = useEvents();
  const toast = useToast();
  // Client object equality alone cannot distinguish A -> B -> A or effect reconnection.
  // biome-ignore lint/correctness/useExhaustiveDependencies: client defines this resource lifetime.
  const lifetime = useMemo<Lifetime>(() => ({ session: createSession() }), [client]);
  const current = useRef(lifetime);
  current.current = lifetime;
  const [, reconnect] = useState(0);
  const isCurrent = useCallback(
    (session: Session) => current.current === lifetime && lifetime.session === session && session.active,
    [lifetime],
  );
  useEffect(() => {
    if (!lifetime.session.active) {
      lifetime.session = createSession();
      reconnect((version) => version + 1);
    }
    const session = lifetime.session;
    return () => {
      session.active = false;
      if (session.timer) clearTimeout(session.timer);
      session.timer = null;
      session.pending.clear();
      session.actions.clear();
    };
  }, [lifetime]);
  const [versions, invalidate] = useInvalidation(lifetime, isCurrent);

  // useResource resets its loader in an effect; hide the previous client's snapshot
  // during the first replacement commit without remounting Dashboard consumers.
  const [resourceOwner, setResourceOwner] = useState(lifetime);
  useEffect(() => setResourceOwner(lifetime), [lifetime]);

  // Archived threads are read too: the empty state says when everything is archived, and the
  // archived view restores them. The board and widgets only ever see the open side.
  const allThreads = useResource(
    useCallback(() => client.listThreads({ includeArchived: true }), [client]),
    versions.threads,
  );
  const threads = useThreadSide(allThreads, false);
  const archived = useThreadSide(allThreads, true);
  const terminals = useResource(
    useCallback(() => client.runningTerminals(), [client]),
    versions.terminals,
  );

  // Event-driven refresh: each new event invalidates the sources it can change. The tracker starts
  // once the event history has loaded, at its newest event. The first thread read can run before
  // that history arrives, so an event recorded in between would sit under the watermark and never
  // refresh the list: read threads once more when the tracker starts.
  useEffect(() => {
    if (eventsState !== "ready") return;
    const session = lifetime.session;
    if (!isCurrent(session)) return;
    if (!session.tracker) {
      session.tracker = new RefreshTracker(events[0]?.seq ?? 0);
      invalidate(["threads"], session);
      return;
    }
    const stale = session.tracker.observe(events);
    if (stale.size > 0) invalidate(stale, session);
  }, [events, eventsState, invalidate, lifetime, isCurrent]);

  const [actionState, setActionState] = useState(() => ({
    owner: lifetime,
    session: lifetime.session,
    pending: new Map<string, ThreadAction>(),
    polite: null as Announcement | null,
  }));
  const emptyActions = useMemo(() => new Map<string, ThreadAction>(), []);
  const ownsState = actionState.owner === lifetime && isCurrent(actionState.session);
  const pendingActions = ownsState ? actionState.pending : emptyActions;
  const polite = ownsState ? actionState.polite : null;
  const urgent = null;
  const announceSeq = useRef(0);
  const actionSession = lifetime.session;

  const runAction = useCallback(
    async (thread: ThreadSummary, action: Exclude<ThreadAction, "open">) => {
      const session = actionSession;
      if (!isCurrent(session)) return;
      // A newer explicit action (including Stop) can run immediately. Its completion
      // owns this row; an older request cannot clear or overwrite its visible state.
      const request = Symbol();
      session.actions.set(thread.id, request);
      const ownsAction = () => isCurrent(session) && session.actions.get(thread.id) === request;
      setActionState((state) =>
        ownsAction()
          ? {
              owner: lifetime,
              session,
              pending: new Map(state.owner === lifetime && state.session === session ? state.pending : []).set(
                thread.id,
                action,
              ),
              polite: state.owner === lifetime && state.session === session ? state.polite : null,
            }
          : state,
      );
      try {
        const updated =
          action === "interrupt"
            ? await client.interruptThread(thread.id)
            : action === "stop"
              ? await client.stopThread(thread.id)
              : action === "archive"
                ? await client.archiveThread(thread.id)
                : action === "unarchive"
                  ? await client.unarchiveThread(thread.id)
                  : await client.resumeThread(thread.id); // resume and retry
        if (!isCurrent(session)) return;
        // Reconcile even a superseded current-client command: native effects already happened.
        invalidate(["threads"], session);
        if (!ownsAction()) return;
        // Archive and unarchive move the thread between the open and archived sides.
        // Commands other than thread_list/thread_get don't say how the provider runs: keep what
        // the list knew, so a coding agent never drops off agent surfaces until the next read.
        allThreads.update((list) =>
          list.map((t) =>
            t.id === updated.id
              ? updated.runtimeKind === null
                ? { ...updated, runtimeKind: t.runtimeKind }
                : updated
              : t,
          ),
        );
        const announcement = {
          id: ++announceSeq.current,
          text:
            action === "archive"
              ? `${thread.name} archived`
              : action === "unarchive"
                ? `${thread.name} restored`
                : `${thread.name}: ${ACTION_LABELS[action].toLowerCase()} requested`,
        };
        setActionState((state) => (ownsAction() ? { ...state, polite: announcement } : state));
      } catch (raw) {
        if (!isCurrent(session)) return;
        invalidate(["threads"], session);
        if (!ownsAction()) return;
        const error = toKalCodeError(raw);
        toast.show({
          tone: "danger",
          title: `Couldn't ${ACTION_LABELS[action].toLowerCase()} ${thread.name}`,
          description: error.message,
        });
      } finally {
        if (ownsAction()) {
          setActionState((state) => {
            if (!ownsAction() || state.owner !== lifetime) return state;
            const next = new Map(state.pending);
            next.delete(thread.id);
            return { ...state, pending: next };
          });
        }
      }
    },
    [client, allThreads.update, invalidate, toast, lifetime, isCurrent, actionSession],
  );

  // Fleet cleanup ("Clear failed", "Close all"): every agent's commands run with bounded
  // concurrency; each card shows its action in flight, the list updates once at the end, and the
  // caller reports one outcome (never a toast per agent).
  const runBulk = useCallback(
    async (steps: readonly BulkStep[]): Promise<BulkResult> => {
      const session = actionSession;
      if (!isCurrent(session) || steps.length === 0) return { done: [], failed: 0 };
      const marker: ThreadAction = steps[0]?.commands.includes("unarchive") ? "unarchive" : "archive";
      setActionState((state) => {
        if (!isCurrent(session)) return state;
        const own = state.owner === lifetime && state.session === session;
        const pending = new Map(own ? state.pending : []);
        for (const step of steps) pending.set(step.thread.id, marker);
        return { owner: lifetime, session, pending, polite: own ? state.polite : null };
      });
      const done: ThreadSummary[] = [];
      let failed = 0;
      const queue = [...steps];
      const worker = async () => {
        for (let step = queue.shift(); step; step = queue.shift()) {
          let latest: ThreadSummary | null = null;
          try {
            for (const command of step.commands) {
              if (command === "stop") latest = await client.stopThread(step.thread.id);
              else if (command === "unarchive") latest = await client.unarchiveThread(step.thread.id);
              else {
                try {
                  latest = await client.archiveThread(step.thread.id);
                } catch (refused) {
                  // Native refuses to archive an agent whose session still runs: end it through the
                  // canonical stop (what closing its pane in Code does), then archive. No orphans.
                  if (toKalCodeError(refused).code !== "thread_running") throw refused;
                  await client.stopThread(step.thread.id);
                  latest = await client.archiveThread(step.thread.id);
                }
              }
            }
            if (latest) done.push(latest);
          } catch {
            failed += 1;
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(BULK_CONCURRENCY, steps.length) }, worker));
      if (!isCurrent(session)) return { done, failed };
      const byId = new Map(done.map((t) => [t.id, t]));
      // Commands other than thread_list/thread_get don't say how the provider runs: keep what the
      // list knew, so an agent never drops off agent surfaces before the next read.
      allThreads.update((list) =>
        list.map((t) => {
          const updated = byId.get(t.id);
          if (!updated) return t;
          return updated.runtimeKind === null ? { ...updated, runtimeKind: t.runtimeKind } : updated;
        }),
      );
      invalidate(["threads"], session);
      setActionState((state) => {
        if (!isCurrent(session) || state.owner !== lifetime) return state;
        const pending = new Map(state.pending);
        for (const step of steps) if (pending.get(step.thread.id) === marker) pending.delete(step.thread.id);
        return { ...state, pending };
      });
      return { done, failed };
    },
    [client, allThreads.update, invalidate, lifetime, isCurrent, actionSession],
  );

  const value = useMemo<DashboardDataValue>(
    () => ({
      threads: resourceOwner === lifetime ? threads : { ...threads, state: { status: "loading" } },
      archived: resourceOwner === lifetime ? archived : { ...archived, state: { status: "loading" } },
      terminals: resourceOwner === lifetime ? terminals : { ...terminals, state: { status: "loading" } },
      pendingActions,
      runAction,
      runBulk,
      urgent,
      polite,
    }),
    [threads, archived, terminals, pendingActions, runAction, runBulk, polite, resourceOwner, lifetime],
  );

  return <DashboardDataContext.Provider value={value}>{children}</DashboardDataContext.Provider>;
}

function useDashboardData(): DashboardDataValue {
  const value = useContext(DashboardDataContext);
  if (!value) throw new Error("Dashboard data hooks must be used inside <DashboardDataProvider>");
  return value;
}

/** Threads from Z3 `thread_list`, refreshed on thread/tool/file/approval events. */
export function useThreadSummaries() {
  const { threads, pendingActions, runAction, runBulk } = useDashboardData();
  return { ...threads, pendingActions, runAction, runBulk };
}

/** Archived threads (read-only on the Dashboard; `runAction(thread, "unarchive")` restores one). */
export function useArchivedThreads() {
  const { archived, pendingActions, runAction, runBulk } = useDashboardData();
  return { ...archived, pendingActions, runAction, runBulk };
}

function useAgentsOnly(state: ResourceState<ThreadSummary[]>): ResourceState<ThreadSummary[]> {
  return useMemo(
    () => (state.status === "ready" ? { ...state, data: state.data.filter(isCodingAgent) } : state),
    [state],
  );
}

/**
 * Open coding agents only (Claude Code, Codex or Gemini CLI in a Code terminal pane): what the
 * Agents rail, the Agent Fleet and agent counts show. Chat threads stay in Threads.
 */
export function useCodingAgents() {
  const threads = useThreadSummaries();
  const state = useAgentsOnly(threads.state);
  return { ...threads, state };
}

/**
 * Every coding agent, open and archived, when a Dashboard data provider is mounted (the Shell
 * mounts one); null otherwise or until threads load. Used when choosing existing agents.
 */
export function useOptionalAllCodingAgents(): readonly ThreadSummary[] | null {
  const value = useContext(DashboardDataContext);
  return useMemo(() => {
    if (value?.threads.state.status !== "ready") return null;
    const archived = value.archived.state.status === "ready" ? value.archived.state.data : [];
    return [...value.threads.state.data, ...archived].filter(isCodingAgent);
  }, [value]);
}

/** Archived coding agents, retaining their persisted task or manual names. */
export function useArchivedCodingAgents() {
  const archived = useArchivedThreads();
  const state = useAgentsOnly(archived.state);
  return { ...archived, state };
}

/**
 * How many open agents wait for the person (an approval or a reply): the Fleet's "Needs you"
 * count, from the same thread list. Failed runs have their own group and never inflate it.
 * 0 until the list has loaded (and when it can't be read).
 */
export function useWaitingForYouCount(): number {
  // The Dashboard's badge counts what its Fleet shows: coding agents.
  const { state } = useCodingAgents();
  return useMemo(() => (state.status === "ready" ? fleetCounts(state.data).needs_you : 0), [state]);
}

/** Running terminals from Z1 `terminals_running`, refreshed on shell events. */
export function useRunningTerminals() {
  return useDashboardData().terminals;
}

export function useDashboardAnnouncements() {
  const { urgent, polite } = useDashboardData();
  return { urgent, polite };
}

/**
 * Provides Dashboard data to its children unless an ancestor already does: widgets and the
 * Dashboard pane (Z7-W1) render inside or outside the Dashboard surface.
 */
export function DashboardDataBoundary({ children }: { children: ReactNode }) {
  const existing = useContext(DashboardDataContext);
  return existing ? children : <DashboardDataProvider>{children}</DashboardDataProvider>;
}
