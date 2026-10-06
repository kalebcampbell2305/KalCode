import type { PaneInfo, ThreadSummary, Workspace } from "@kalcode/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toKalCodeError } from "../../../ipc/errors.ts";
import { useRuntime } from "../../../runtime/RuntimeProvider.tsx";
import { usePermissions } from "../../permissions/PermissionsProvider.tsx";
import { isPaneProvider, PaneChannel, type PaneProviderId, resolvePaneStartMode } from "./paneChannel.ts";

/** How a new coding agent starts: account, exact model and effort (each optional). */
export interface AgentLaunch {
  contextSourceThreadId?: string;
  providerAccountId?: string | null;
  model?: string | null;
  effort?: string | null;
}

export interface ProviderPaneEntry {
  thread: ThreadSummary;
  info: PaneInfo | null;
}

/** Hook-channel changes (waiting → active or limited) carry no thread event; poll while waiting. */
const WAITING_POLL_MS = 1500;
const CODEX_WAITING_POLL_MS = 4000;
const REFRESH_DEBOUNCE_MS = 120;
/** A multi-agent launch starts this many sessions at once (each is still its own fresh session). */
const LAUNCH_CONCURRENCY = 4;
/** Pane-info reads can touch PTY/runtime locks; keep startup hydration bounded. */
const INFO_READ_CONCURRENCY = 4;

/** Which panes a refresh re-reads: all, or only these thread ids (plus any not known yet). */
type RefreshScope = "all" | ReadonlySet<string>;

function widenScope(a: RefreshScope | null, b: RefreshScope | null): RefreshScope | null {
  if (a === null) return b;
  if (b === null) return a;
  if (a === "all" || b === "all") return "all";
  return new Set([...a, ...b]);
}

/** Small IPC records (thread, pane info): equal when their serialized fields are. */
function sameRecord(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/** Whether two id lists are the same ids in the same order. */
function sameIds(previous: readonly string[], next: readonly string[]): boolean {
  return previous.length === next.length && previous.every((id, i) => id === next[i]);
}

async function allSettledBounded<Input, Output>(
  inputs: readonly Input[],
  concurrency: number,
  read: (input: Input) => Promise<Output>,
  isCurrent: () => boolean = () => true,
): Promise<PromiseSettledResult<Output>[]> {
  const results = new Array<PromiseSettledResult<Output>>(inputs.length);
  let next = 0;
  const worker = async () => {
    while (next < inputs.length) {
      // A superseded refresh may finish reads it already owns, but must not keep claiming work
      // from the shared PTY/runtime locks while the current generation hydrates the same panes.
      if (!isCurrent()) return;
      const index = next++;
      try {
        results[index] = { status: "fulfilled", value: await read(inputs[index] as Input) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), inputs.length) }, worker));
  return results;
}

/** Codex and Gemini CLI panes are offered only when threads can use that provider (PROVIDERS-2). */
const OPTIONAL_PANE_PROVIDERS: readonly PaneProviderId[] = ["codex", "cursor", "gemini-cli"];

/** Whether this build offers provider panes (the `provider_panes` feature flag). */
export function useProviderPanesEnabled(): boolean {
  const { info } = useRuntime();
  return info.flags.features?.some((f) => f.id === "provider_panes" && f.visible) ?? false;
}

export interface ProviderPanesOptions {
  /** False while the Code surface is hidden: pauses the waiting poll (events still refresh). Default true. */
  active?: boolean;
}

export interface ProviderPanes {
  enabled: boolean;
  channel: PaneChannel;
  /** This workspace's provider pane threads, oldest first. */
  panes: readonly ProviderPaneEntry[];
  /** Confirmed chat sessions; remove only their obsolete Code layout references. */
  chatIds: readonly string[];
  /** Whether the first read finished (so absence means "not a pane"). */
  loaded: boolean;
  creating: boolean;
  /** Which provider a pane is being started for, while `creating`. */
  creatingProvider: PaneProviderId | null;
  /** Codex / Gemini CLI when `thread_options` offers them (Claude Code is always offered). */
  offered: readonly PaneProviderId[];
  /** A refused launch, else a failed list read (cleared by the next successful read). */
  error: string | null;
  /** Forgets a previous launch's refusal (the launcher opening again starts fresh). */
  clearLaunchError: () => void;
  /** Starts a coding agent (Claude Code by default): the real CLI in a PTY pane. */
  create: (providerId?: PaneProviderId, launch?: AgentLaunch) => Promise<ThreadSummary | null>;
  /**
   * Starts `count` coding agents, each a fresh session, a few at a time; the panes join the list
   * in one update. A refusal stops further starts; sessions already started are kept and returned
   * (oldest first).
   */
  createMany: (providerId: PaneProviderId, launch: AgentLaunch, count: number) => Promise<ThreadSummary[]>;
  /** A thread changed (rename, stop). */
  updated: (thread: ThreadSummary) => void;
  refresh: () => Promise<void>;
}

/**
 * The provider pane threads of a workspace (Z7-W4), kept current from thread and approval
 * events. The pane canvas (Z7-W1) shows each one with `ProviderPane`.
 */
export function useProviderPanes(workspace: Workspace, { active = true }: ProviderPanesOptions = {}): ProviderPanes {
  const enabled = useProviderPanesEnabled() && workspace.available;
  const { client, feed } = useRuntime();
  const { settings } = usePermissions();
  const channel = useMemo(() => new PaneChannel(client), [client]);
  const [panes, setPanes] = useState<ProviderPaneEntry[]>([]);
  const [chatIds, setChatIds] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [creating, setCreating] = useState<PaneProviderId | null>(null);
  const [offered, setOffered] = useState<readonly PaneProviderId[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [launchError, setLaunchError] = useState<string | null>(null);
  /** Panes whose last info read answered "no live pane" (ended/restored): no info will arrive by polling. */
  const [settled, setSettled] = useState<string[]>([]);
  const generation = useRef(0);
  // What the latest render knows, so a scoped refresh can keep the panes it doesn't re-read.
  const known = useRef({ panes, settled });
  known.current = { panes, settled };
  /** The scope of the refresh in flight: a newer refresh supersedes it, so it inherits its scope. */
  const inflightScope = useRef<RefreshScope | null>(null);

  /**
   * Re-reads the list and pane info. A thread event re-reads only the panes it names (`only`);
   * unknown threads are always read, and the others keep their last info.
   */
  const refreshScoped = useCallback(
    async (only?: ReadonlySet<string>) => {
      if (!enabled) return;
      const current = ++generation.current;
      const scope = widenScope(inflightScope.current, only ?? "all") as RefreshScope;
      inflightScope.current = scope;
      try {
        const threads = await client.listThreads({ workspaceId: workspace.id });
        const candidates = threads.filter((t) => isPaneProvider(t.providerId));
        if (current !== generation.current) return;
        // Interactive thread identity is durable and sufficient to restore its saved pane frame.
        // Publish it before slower runtime-info reads; legacy headless rows still wait for a
        // positive pane-info answer so chat sessions are never presented as coding agents.
        setPanes((previous) => {
          const next = candidates.flatMap((thread): ProviderPaneEntry[] => {
            const before = previous.find((entry) => entry.thread.id === thread.id);
            if (thread.runtimeKind !== "interactive_pty" && !before?.info) return [];
            const entry = { thread, info: before?.info ?? null };
            return [before && sameRecord(before.thread, thread) ? before : entry];
          });
          next.sort((a, b) => a.thread.createdAt.localeCompare(b.thread.createdAt));
          return next.length === previous.length && next.every((entry, i) => entry === previous[i]) ? previous : next;
        });
        const { panes: knownPanes, settled: knownSettled } = known.current;
        const infos = await allSettledBounded(
          candidates,
          INFO_READ_CONCURRENCY,
          (t) => {
            if (scope !== "all" && !scope.has(t.id)) {
              const before = knownPanes.find((entry) => entry.thread.id === t.id)?.info;
              if (before) return Promise.resolve(before);
              if (knownSettled.includes(t.id)) return Promise.resolve(null);
            }
            return channel.info(t.id);
          },
          () => current === generation.current,
        );
        if (current !== generation.current) return;
        inflightScope.current = null;
        const answeredNone = (index: number) => {
          const result = infos[index];
          return result?.status === "fulfilled" && result.value === null;
        };
        const nextChatIds = candidates
          .filter((thread, index) => thread.runtimeKind !== "interactive_pty" && answeredNone(index))
          .map((thread) => thread.id);
        setChatIds((previous) => (sameIds(previous, nextChatIds) ? previous : nextChatIds));
        const nextSettled = candidates.filter((_, index) => answeredNone(index)).map((thread) => thread.id);
        setSettled((previous) => (sameIds(previous, nextSettled) ? previous : nextSettled));
        // Unchanged entries keep their identity, and an unchanged list stays the same array, so a
        // quiet poll re-renders nothing.
        setPanes((previous) => {
          const next: ProviderPaneEntry[] = [];
          candidates.forEach((thread, i) => {
            const result = infos[i];
            const before = previous.find((entry) => entry.thread.id === thread.id);
            const info = result?.status === "fulfilled" ? result.value : before?.info;
            if (!info && thread.runtimeKind !== "interactive_pty") return;
            const entry = { thread, info: info ?? null };
            next.push(
              before && sameRecord(before.thread, thread) && sameRecord(before.info, entry.info) ? before : entry,
            );
          });
          next.sort((a, b) => a.thread.createdAt.localeCompare(b.thread.createdAt));
          return next.length === previous.length && next.every((entry, i) => entry === previous[i]) ? previous : next;
        });
        const failed = infos.find((result) => result.status === "rejected");
        setListError(failed?.status === "rejected" ? toKalCodeError(failed.reason).message : null);
        setLoaded(true);
      } catch (cause) {
        if (current === generation.current) {
          inflightScope.current = null;
          setListError(toKalCodeError(cause).message);
          setLoaded(true);
        }
      }
    },
    [client, channel, workspace.id, enabled],
  );
  const refresh = useCallback(() => refreshScoped(), [refreshScoped]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // PROVIDERS-2: which optional providers are usable, re-read when a provider event lands.
  const [providerSeq, setProviderSeq] = useState(0);
  useEffect(() => {
    void providerSeq;
    if (!enabled) return;
    let cancelled = false;
    client.threadOptions().then(
      (options) => {
        if (cancelled) return;
        const usable = new Set(options.providers.map((p) => p.id));
        setOffered(OPTIONAL_PANE_PROVIDERS.filter((id) => id === "cursor" || usable.has(id)));
      },
      () => {
        if (!cancelled) setOffered([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, enabled, providerSeq]);

  // Thread and approval events for this workspace (or its panes) refresh the list; each event
  // is looked at once and refreshes are coalesced. The feed is read directly, so unrelated
  // runtime events don't re-render the Code canvas.
  // An event naming a thread re-reads that pane only; a workspace-wide event re-reads them all.
  // While a multi-agent launch runs, events only widen the scope: one refresh follows the batch.
  const paneIds = useRef(new Set<string>());
  paneIds.current = new Set(panes.map((p) => p.thread.id));
  const scheduled = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingScope = useRef<RefreshScope | null>(null);
  const launching = useRef(0);
  const flushScheduled = useCallback(() => {
    if (scheduled.current || launching.current > 0 || pendingScope.current === null) return;
    scheduled.current = setTimeout(() => {
      scheduled.current = null;
      const scope = pendingScope.current;
      pendingScope.current = null;
      if (scope !== null) void refreshScoped(scope === "all" ? undefined : scope);
    }, REFRESH_DEBOUNCE_MS);
  }, [refreshScoped]);
  useEffect(() => {
    if (!enabled) return;
    let lastSeq = feed.getSnapshot().events[0]?.seq ?? 0;
    return feed.subscribe(() => {
      const { events } = feed.getSnapshot();
      const fresh = events.filter((e) => e.seq > lastSeq);
      lastSeq = Math.max(lastSeq, events[0]?.seq ?? 0);
      const provider = fresh.find((e) => e.type.startsWith("provider."));
      if (provider) setProviderSeq(provider.seq);
      let scope: RefreshScope | null = null;
      for (const e of fresh) {
        const threadId = e.correlation.threadId;
        if (threadId !== null && (paneIds.current.has(threadId) || e.correlation.workspaceId === workspace.id))
          scope = widenScope(scope, new Set([threadId]));
        else if (e.correlation.workspaceId === workspace.id) scope = "all";
      }
      if (scope === null) return;
      pendingScope.current = widenScope(pendingScope.current, scope);
      flushScheduled();
    });
  }, [feed, flushScheduled, workspace.id, enabled]);
  useEffect(
    () => () => {
      if (scheduled.current) clearTimeout(scheduled.current);
    },
    [],
  );

  // Claude Code's hook channel connects on its own, soon after start. A Codex pane's channel
  // becomes active with its first `notify` (a finished turn), which may produce no thread event
  // (idle → idle), so it is polled too, more slowly (an in-memory read, no provider process).
  // A pane without info is awaited (just launched, or a failed read) unless native already
  // answered that it has no live pane: an ended or restored agent never gains info by polling.
  // The poll pauses while the Code surface is hidden; thread events still refresh.
  const waiting =
    loaded &&
    panes.some(
      (p) =>
        (!p.info && !settled.includes(p.thread.id)) ||
        (p.info?.hookChannel === "waiting" && p.thread.providerId === "claude-code"),
    );
  const codexWaiting = panes.some((p) => p.info?.hookChannel === "waiting" && p.thread.providerId === "codex");
  // Only the panes still waiting are polled; the others keep their info until an event names them.
  useEffect(() => {
    if (!active || (!waiting && !codexWaiting)) return;
    const timer = setInterval(
      () => {
        const { panes: current, settled: done } = known.current;
        const polled = current.filter(
          (p) => (!p.info && !done.includes(p.thread.id)) || p.info?.hookChannel === "waiting",
        );
        void refreshScoped(new Set(polled.map((p) => p.thread.id)));
      },
      waiting ? WAITING_POLL_MS : CODEX_WAITING_POLL_MS,
    );
    return () => clearInterval(timer);
  }, [active, waiting, codexWaiting, refreshScoped]);

  const createMany = useCallback(
    async (providerId: PaneProviderId = "claude-code", launch: AgentLaunch = {}, count = 1) => {
      setCreating(providerId);
      setLaunchError(null);
      launching.current += 1;
      try {
        // The spinner is already visible. If the provider-wide settings read is still in flight,
        // read the canonical local value now rather than guessing Auto or Approve and widening a
        // saved Plan preference. A read failure is surfaced below and no pane is created.
        const permissionMode = await resolvePaneStartMode(settings, () => client.getPermissionSettings());
        const input = {
          ...(launch.contextSourceThreadId ? { contextSourceThreadId: launch.contextSourceThreadId } : {}),
          providerId,
          providerAccountId: launch.providerAccountId ?? null,
          model: launch.model ?? null,
          effort: launch.effort ?? null,
          workspaceId: workspace.id,
          permissionMode,
        };
        // Every agent is its own fresh session. A refusal stops further starts; sessions already
        // starting finish and are kept, so a retry never duplicates them.
        const started: ThreadSummary[] = [];
        let refusal: { cause: unknown } | null = null;
        let next = 0;
        const worker = async () => {
          while (refusal === null && next < count) {
            next += 1;
            try {
              started.push(await channel.create(input));
            } catch (cause) {
              refusal ??= { cause };
            }
          }
        };
        await Promise.all(Array.from({ length: Math.max(0, Math.min(LAUNCH_CONCURRENCY, count)) }, worker));
        const threads = started.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        if (threads.length > 0) {
          // Creation owns these exact terminal identities. A list read can still describe
          // the instant before creation; never drop a fresh terminal on that snapshot.
          generation.current += 1;
          const ids = new Set(threads.map((thread) => thread.id));
          const infos = await allSettledBounded(threads, INFO_READ_CONCURRENCY, (thread) => channel.info(thread.id));
          setSettled((previous) =>
            previous.some((id) => ids.has(id)) ? previous.filter((id) => !ids.has(id)) : previous,
          );
          setPanes((previous) => [
            ...previous.filter((entry) => !ids.has(entry.thread.id)),
            ...threads.map((thread, i) => {
              const result = infos[i];
              return { thread, info: result?.status === "fulfilled" ? result.value : null };
            }),
          ]);
          // A session already exists even when its metadata read failed. That read cannot undo
          // it or make the launcher offer to create a duplicate; keep its terminal identity.
          const failed = infos.find((result) => result.status === "rejected");
          if (failed?.status === "rejected") setListError(toKalCodeError(failed.reason).message);
        }
        if (refusal !== null) setLaunchError(toKalCodeError((refusal as { cause: unknown }).cause).message);
        return threads;
      } catch (cause) {
        setLaunchError(toKalCodeError(cause).message);
        return [];
      } finally {
        setCreating(null);
        launching.current -= 1;
        flushScheduled();
      }
    },
    [channel, client, workspace.id, settings, flushScheduled],
  );
  const create = useCallback(
    async (providerId: PaneProviderId = "claude-code", launch: AgentLaunch = {}) =>
      (await createMany(providerId, launch, 1))[0] ?? null,
    [createMany],
  );

  const clearLaunchError = useCallback(() => setLaunchError(null), []);

  const updated = useCallback(
    (thread: ThreadSummary) => {
      setPanes((list) => list.map((p) => (p.thread.id === thread.id ? { ...p, thread } : p)));
      void refresh();
    },
    [refresh],
  );

  const error = launchError ?? listError;
  const isLoaded = loaded || !enabled;
  return useMemo(
    () => ({
      enabled,
      channel,
      panes,
      chatIds,
      loaded: isLoaded,
      creating: creating !== null,
      creatingProvider: creating,
      offered,
      error,
      clearLaunchError,
      create,
      createMany,
      updated,
      refresh,
    }),
    [
      enabled,
      channel,
      panes,
      chatIds,
      isLoaded,
      creating,
      offered,
      error,
      clearLaunchError,
      create,
      createMany,
      updated,
      refresh,
    ],
  );
}
