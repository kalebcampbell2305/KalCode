import type { PaneInfo, ThreadSummary, Workspace } from "@kalcode/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toKalCodeError } from "../../../ipc/errors.ts";
import { useEvents, useRuntime } from "../../../runtime/RuntimeProvider.tsx";
import { usePermissions } from "../../permissions/PermissionsProvider.tsx";
import { PaneChannel, paneStartMode } from "./paneChannel.ts";

export interface ProviderPaneEntry {
  thread: ThreadSummary;
  info: PaneInfo;
}

/** Hook-channel changes (waiting → active or limited) carry no thread event; poll while waiting. */
const WAITING_POLL_MS = 1500;
const REFRESH_DEBOUNCE_MS = 120;

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
  error: string | null;
  /** Starts Claude Code in a new pane thread (the real CLI in a PTY). */
  create: () => Promise<ThreadSummary | null>;
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
  const { client } = useRuntime();
  const { events } = useEvents();
  const { settings } = usePermissions();
  const channel = useMemo(() => new PaneChannel(client), [client]);
  const [panes, setPanes] = useState<ProviderPaneEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    const current = ++generation.current;
    try {
      const threads = await client.listThreads({ workspaceId: workspace.id });
      const candidates = threads.filter((t) => t.providerId === "claude-code");
      const infos = await Promise.all(candidates.map((t) => channel.info(t.id).catch(() => null)));
      if (current !== generation.current) return;
      const next: ProviderPaneEntry[] = [];
      candidates.forEach((thread, i) => {
        const info = infos[i];
        if (info) next.push({ thread, info });
      });
      next.sort((a, b) => a.thread.createdAt.localeCompare(b.thread.createdAt));
      setPanes(next);
      setLoaded(true);
    } catch (cause) {
      if (current === generation.current) {
        setError(toKalCodeError(cause).message);
        setLoaded(true);
      }
    }
  }, [client, channel, workspace.id, enabled]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Thread and approval events for this workspace (or its panes) refresh the list; each event
  // is looked at once and refreshes are coalesced.
  const lastEvent = events[0];
  const handledSeq = useRef(0);
  const paneIds = useRef(new Set<string>());
  paneIds.current = new Set(panes.map((p) => p.thread.id));
  const scheduled = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!enabled || !lastEvent || lastEvent.seq <= handledSeq.current) return;
    handledSeq.current = lastEvent.seq;
    const threadId = lastEvent.correlation.threadId;
    const related =
      lastEvent.correlation.workspaceId === workspace.id || (threadId !== null && paneIds.current.has(threadId));
    if (!related || scheduled.current) return;
    scheduled.current = setTimeout(() => {
      scheduled.current = null;
      void refresh();
    }, REFRESH_DEBOUNCE_MS);
  }, [lastEvent, refresh, workspace.id, enabled]);
  useEffect(
    () => () => {
      if (scheduled.current) clearTimeout(scheduled.current);
    },
    [],
  );

  const waiting = panes.some((p) => p.info.hookChannel === "waiting");
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => void refresh(), WAITING_POLL_MS);
    return () => clearInterval(timer);
  }, [waiting, refresh]);

  const create = useCallback(async () => {
    setCreating(true);
    setError(null);
    try {
      const thread = await channel.create({
        workspaceId: workspace.id,
        permissionMode: paneStartMode(settings?.defaultMode),
      });
      await refresh();
      return thread;
    } catch (cause) {
      setError(toKalCodeError(cause).message);
      return null;
    } finally {
      setCreating(false);
    }
  }, [channel, workspace.id, settings?.defaultMode, refresh]);

  const updated = useCallback(
    (thread: ThreadSummary) => {
      setPanes((list) => list.map((p) => (p.thread.id === thread.id ? { ...p, thread } : p)));
      void refresh();
    },
    [refresh],
  );

  return { enabled, channel, panes, loaded: loaded || !enabled, creating, error, create, updated, refresh };
}
