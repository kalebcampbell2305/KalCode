import type { PaneInfo, ThreadSummary, Workspace } from "@kalcode/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toKalCodeError } from "../../../ipc/errors.ts";
import { useRuntime } from "../../../runtime/RuntimeProvider.tsx";
import { usePermissions } from "../../permissions/PermissionsProvider.tsx";
import { isPaneProvider, PaneChannel, type PaneProviderId, paneStartMode } from "./paneChannel.ts";

/** How a new coding agent starts: account, exact model and effort (each optional). */
export interface AgentLaunch {
  providerAccountId?: string | null;
  model?: string | null;
  effort?: string | null;
}

export interface ProviderPaneEntry {
  thread: ThreadSummary;
  info: PaneInfo;
}

/** Hook-channel changes (waiting → active or limited) carry no thread event; poll while waiting. */
const WAITING_POLL_MS = 1500;
const CODEX_WAITING_POLL_MS = 4000;
const REFRESH_DEBOUNCE_MS = 120;

/** Codex and Gemini CLI panes are offered only when threads can use that provider (PROVIDERS-2). */
const OPTIONAL_PANE_PROVIDERS: readonly PaneProviderId[] = ["codex", "gemini-cli"];

/** Whether this build offers provider panes (the `provider_panes` feature flag). */
export function useProviderPanesEnabled(): boolean {
  const { info } = useRuntime();
  return info.flags.features?.some((f) => f.id === "provider_panes" && f.visible) ?? false;
}

export interface ProviderPanes {
  enabled: boolean;
  channel: PaneChannel;
  /** This workspace's provider pane threads, oldest first. */
  panes: readonly ProviderPaneEntry[];
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
  /** A thread changed (rename, stop). */
  updated: (thread: ThreadSummary) => void;
  refresh: () => Promise<void>;
}

/**
 * The provider pane threads of a workspace (Z7-W4), kept current from thread and approval
 * events. The pane canvas (Z7-W1) shows each one with `ProviderPane`.
 */
export function useProviderPanes(workspace: Workspace): ProviderPanes {
  const enabled = useProviderPanesEnabled() && workspace.available;
  const { client, feed } = useRuntime();
  const { settings } = usePermissions();
  const channel = useMemo(() => new PaneChannel(client), [client]);
  const [panes, setPanes] = useState<ProviderPaneEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [creating, setCreating] = useState<PaneProviderId | null>(null);
  const [offered, setOffered] = useState<readonly PaneProviderId[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    const current = ++generation.current;
    try {
      const threads = await client.listThreads({ workspaceId: workspace.id });
      const candidates = threads.filter((t) => isPaneProvider(t.providerId));
      const infos = await Promise.all(candidates.map((t) => channel.info(t.id).catch(() => null)));
      if (current !== generation.current) return;
      const next: ProviderPaneEntry[] = [];
      candidates.forEach((thread, i) => {
        const info = infos[i];
        if (info) next.push({ thread, info });
      });
      next.sort((a, b) => a.thread.createdAt.localeCompare(b.thread.createdAt));
      setPanes(next);
      setListError(null);
      setLoaded(true);
    } catch (cause) {
      if (current === generation.current) {
        setListError(toKalCodeError(cause).message);
        setLoaded(true);
      }
    }
  }, [client, channel, workspace.id, enabled]);

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
        setOffered(OPTIONAL_PANE_PROVIDERS.filter((id) => usable.has(id)));
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
  const paneIds = useRef(new Set<string>());
  paneIds.current = new Set(panes.map((p) => p.thread.id));
  const scheduled = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let lastSeq = feed.getSnapshot().events[0]?.seq ?? 0;
    return feed.subscribe(() => {
      const { events } = feed.getSnapshot();
      const fresh = events.filter((e) => e.seq > lastSeq);
      lastSeq = Math.max(lastSeq, events[0]?.seq ?? 0);
      const provider = fresh.find((e) => e.type.startsWith("provider."));
      if (provider) setProviderSeq(provider.seq);
      const related = fresh.some((e) => {
        const threadId = e.correlation.threadId;
        return e.correlation.workspaceId === workspace.id || (threadId !== null && paneIds.current.has(threadId));
      });
      if (!related || scheduled.current) return;
      scheduled.current = setTimeout(() => {
        scheduled.current = null;
        void refresh();
      }, REFRESH_DEBOUNCE_MS);
    });
  }, [feed, refresh, workspace.id, enabled]);
  useEffect(
    () => () => {
      if (scheduled.current) clearTimeout(scheduled.current);
    },
    [],
  );

  // Claude Code's hook channel connects on its own, soon after start. A Codex pane's channel
  // becomes active with its first `notify` (a finished turn), which may produce no thread event
  // (idle → idle), so it is polled too, more slowly (an in-memory read, no provider process).
  const waiting = panes.some((p) => p.info.hookChannel === "waiting" && p.thread.providerId === "claude-code");
  const codexWaiting = panes.some((p) => p.info.hookChannel === "waiting" && p.thread.providerId === "codex");
  useEffect(() => {
    if (!waiting && !codexWaiting) return;
    const timer = setInterval(() => void refresh(), waiting ? WAITING_POLL_MS : CODEX_WAITING_POLL_MS);
    return () => clearInterval(timer);
  }, [waiting, codexWaiting, refresh]);

  const create = useCallback(
    async (providerId: PaneProviderId = "claude-code", launch: AgentLaunch = {}) => {
      setCreating(providerId);
      setLaunchError(null);
      try {
        const thread = await channel.create({
          providerId,
          providerAccountId: launch.providerAccountId ?? null,
          model: launch.model ?? null,
          effort: launch.effort ?? null,
          workspaceId: workspace.id,
          permissionMode: paneStartMode(settings?.defaultMode),
        });
        await refresh();
        return thread;
      } catch (cause) {
        setLaunchError(toKalCodeError(cause).message);
        return null;
      } finally {
        setCreating(null);
      }
    },
    [channel, workspace.id, settings?.defaultMode, refresh],
  );

  const clearLaunchError = useCallback(() => setLaunchError(null), []);

  const updated = useCallback(
    (thread: ThreadSummary) => {
      setPanes((list) => list.map((p) => (p.thread.id === thread.id ? { ...p, thread } : p)));
      void refresh();
    },
    [refresh],
  );

  return {
    enabled,
    channel,
    panes,
    loaded: loaded || !enabled,
    creating: creating !== null,
    creatingProvider: creating,
    offered,
    error: launchError ?? listError,
    clearLaunchError,
    create,
    updated,
    refresh,
  };
}
