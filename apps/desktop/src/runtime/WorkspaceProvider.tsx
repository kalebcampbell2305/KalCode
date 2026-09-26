import type { ShellOption, TerminalInfo, Workspace } from "@kalcode/protocol";
import { useToast } from "@kalcode/ui/components";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { TerminalSize } from "../ipc/client.ts";
import { type KalCodeError, toKalCodeError } from "../ipc/errors.ts";
import { useRuntime } from "./RuntimeProvider.tsx";
import { isWorkspaceEvent, neighbourAfterClose, pickActiveTerminal } from "./workspaceState.ts";

type LoadState = "loading" | "ready" | "error";

export interface WorkspaceValue {
  state: LoadState;
  error: KalCodeError | null;
  /** Most recently opened first. */
  workspaces: readonly Workspace[];
  active: Workspace | null;
  shells: readonly ShellOption[];
  /** Tabs of the active workspace, in order. */
  terminals: readonly TerminalInfo[];
  /** The tab in front in the active workspace. */
  activeTerminalId: string | null;
  /** Running terminals in every workspace (Dashboard). */
  running: readonly TerminalInfo[];
  /** True while the native folder picker is open. */
  picking: boolean;
  /** Last measured terminal size, used to start new shells at the right size. */
  lastSize: React.RefObject<TerminalSize>;
  retry: () => void;
  /** Re-reads workspaces and terminals (folder availability changes without events). */
  refresh: () => Promise<void>;
  openFolder: () => Promise<Workspace | null>;
  activate: (workspaceId: string) => Promise<boolean>;
  remove: (workspace: Workspace) => Promise<boolean>;
  createTerminal: (shellId?: string | null) => Promise<TerminalInfo | null>;
  closeTerminal: (terminalId: string) => Promise<void>;
  restartTerminal: (terminalId: string) => Promise<TerminalInfo | null>;
  /**
   * Selects a tab; `focus` also moves keyboard focus into its terminal. Pass `workspaceId` when
   * the tab belongs to a workspace being activated in the same step.
   */
  selectTerminal: (terminalId: string, focus?: boolean, workspaceId?: string) => void;
  /** The terminal that should take keyboard focus; `n` changes on every request. */
  focusRequest: { terminalId: string; n: number };
}

const WorkspaceContext = createContext<WorkspaceValue | null>(null);

interface Snapshot {
  workspaces: Workspace[];
  active: Workspace | null;
  terminals: TerminalInfo[];
  running: TerminalInfo[];
}

const EMPTY: Snapshot = { workspaces: [], active: null, terminals: [], running: [] };

/**
 * Workspace and terminal state for the whole shell (Code surface, sidebar switcher, palette,
 * Dashboard). Loaded from native on start and refreshed whenever a `workspace.*` or `shell.*`
 * event is recorded, so every view stays in step with the runtime.
 */
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { client, feed } = useRuntime();
  const toast = useToast();
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY);
  const [shells, setShells] = useState<ShellOption[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState<KalCodeError | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [picking, setPicking] = useState(false);
  const [selected, setSelected] = useState<{ workspaceId: string; terminalId: string } | null>(null);
  const [focusRequest, setFocusRequest] = useState({ terminalId: "", n: 0 });
  const requestFocus = useCallback((terminalId: string) => setFocusRequest((f) => ({ terminalId, n: f.n + 1 })), []);
  const lastSize = useRef<TerminalSize>({ cols: 120, rows: 30 });
  const lifecycle = useMemo(
    () => ({
      client,
      mounted: false,
      epoch: 0,
      pickers: 0,
      generation: 0,
      activation: 0,
      focusIntent: 0,
      pendingFocus: null as { intent: number; epoch: number; terminalId: string; workspaceId: string } | null,
      workspaceId: null as string | null,
      tail: Promise.resolve(),
    }),
    [client],
  );
  const currentLifecycle = useRef(lifecycle);
  currentLifecycle.current = lifecycle;
  const isCurrent = useCallback(() => lifecycle.mounted && currentLifecycle.current === lifecycle, [lifecycle]);
  const captureLifetime = useCallback(() => {
    const epoch = lifecycle.epoch;
    return () => isCurrent() && lifecycle.epoch === epoch;
  }, [lifecycle, isCurrent]);

  useEffect(() => {
    lifecycle.mounted = true;
    setSnapshot(EMPTY);
    setShells([]);
    setSelected(null);
    setFocusRequest({ terminalId: "", n: 0 });
    setPicking(false);
    return () => {
      lifecycle.mounted = false;
      lifecycle.epoch += 1;
      lifecycle.pickers = 0;
      lifecycle.pendingFocus = null;
      lifecycle.generation += 1;
      lifecycle.activation += 1;
    };
  }, [lifecycle]);

  const load = useCallback(async (): Promise<void> => {
    if (!isCurrent()) return;
    const id = ++lifecycle.generation;
    const [workspaces, active, running] = await Promise.all([
      client.listWorkspaces(),
      client.activeWorkspace(),
      client.runningTerminals(),
    ]);
    if (!isCurrent() || id !== lifecycle.generation) return;
    const terminals = active ? await client.listTerminals(active.id) : [];
    // A slower, older refresh must never overwrite a newer one.
    if (!isCurrent() || id !== lifecycle.generation) return;
    if (lifecycle.workspaceId !== (active?.id ?? null)) lifecycle.focusIntent += 1;
    lifecycle.workspaceId = active?.id ?? null;
    setSnapshot({ workspaces, active, terminals, running });
  }, [client, lifecycle, isCurrent]);

  const refresh = useCallback(async () => {
    try {
      await load();
    } catch (err) {
      // A live refresh failing keeps the last good state; the next event retries.
      if (isCurrent() && import.meta.env.DEV) console.warn("workspace refresh failed", err);
    }
  }, [load, isCurrent]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` re-runs the initial load on retry.
  useEffect(() => {
    let cancelled = false;
    setState("loading");
    Promise.all([
      load(),
      client.listShells().then((next) => {
        if (!cancelled && isCurrent()) setShells(next);
      }),
    ])
      .then(() => {
        if (cancelled) return;
        setState("ready");
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(toKalCodeError(err));
        setState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [client, load, attempt, isCurrent]);

  // Folders can be moved or deleted while KalCode is in the background.
  useEffect(() => {
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  // Live updates: refresh once per burst of workspace/shell events.
  useEffect(() => {
    let lastSeq = feed.getSnapshot().events[0]?.seq ?? 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = feed.subscribe(() => {
      const { events } = feed.getSnapshot();
      const fresh = events.filter((e) => e.seq > lastSeq);
      lastSeq = Math.max(lastSeq, events[0]?.seq ?? 0);
      if (!fresh.some(isWorkspaceEvent)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void refresh();
      }, 25);
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [feed, refresh]);

  const fail = useCallback(
    (title: string, err: unknown) => {
      toast.show({ tone: "danger", title, description: toKalCodeError(err).message });
    },
    [toast],
  );

  const active = snapshot.active;
  const activeTerminalId = pickActiveTerminal(
    snapshot.terminals,
    selected && selected.workspaceId === active?.id ? selected.terminalId : null,
    active?.activeTerminalId ?? null,
  );

  const openFolder = useCallback(async () => {
    const current = captureLifetime();
    if (!current()) return null;
    lifecycle.pickers += 1;
    setPicking(true);
    try {
      const workspace = await client.openWorkspaceDialog();
      if (!current()) return null;
      if (workspace) await refresh();
      return current() ? workspace : null;
    } catch (err) {
      if (current()) fail("Couldn't open that folder", err);
      return null;
    } finally {
      if (current()) {
        lifecycle.pickers -= 1;
        setPicking(lifecycle.pickers > 0);
      }
    }
  }, [client, refresh, fail, lifecycle, captureLifetime]);

  const activate = useCallback(
    async (workspaceId: string) => {
      if (!isCurrent()) return false;
      lifecycle.focusIntent += 1;
      const id = ++lifecycle.activation;
      const latest = () => isCurrent() && id === lifecycle.activation;
      // Native writes cannot be undone by a UI generation check. Finish the dispatched
      // write before sending the latest queued intent; obsolete queued intents do no IPC.
      const result = lifecycle.tail.then(async () => {
        if (!latest()) return false;
        try {
          await client.activateWorkspace(workspaceId);
          return latest();
        } catch (err) {
          if (latest()) fail("Couldn't switch workspace", err);
          return false;
        }
      });
      lifecycle.tail = result.then(
        () => undefined,
        () => undefined,
      );
      // Reads are outside the write queue: a slow obsolete refresh must not delay
      // the next workspace switch. The load generation still fences its snapshot.
      if (!(await result) || !latest()) return false;
      await refresh();
      return latest();
    },
    [client, refresh, fail, lifecycle, isCurrent],
  );

  const remove = useCallback(
    async (workspace: Workspace) => {
      const current = captureLifetime();
      if (!current()) return false;
      try {
        await client.removeWorkspace(workspace.id);
        if (!current()) return false;
        await refresh();
        if (!current()) return false;
        toast.show({
          tone: "success",
          title: `${workspace.name} removed from KalCode`,
          description: "The folder and its files were not changed.",
        });
        return true;
      } catch (err) {
        if (current()) fail("Couldn't remove workspace", err);
        return false;
      }
    },
    [client, refresh, fail, toast, captureLifetime],
  );

  const selectTerminal = useCallback(
    (terminalId: string, focus = false, workspaceId: string | undefined = active?.id) => {
      if (!isCurrent() || !workspaceId) return;
      const pending = lifecycle.pendingFocus;
      // The canvas synchronizes its newly displayed tab before a mutation's refresh
      // settles. That same-target, non-focusing report belongs to the pending intent.
      const reconcilesPending =
        !focus &&
        pending?.intent === lifecycle.focusIntent &&
        pending.epoch === lifecycle.epoch &&
        pending.workspaceId === workspaceId &&
        pending.terminalId === terminalId;
      if (!reconcilesPending) lifecycle.focusIntent += 1;
      setSelected({ workspaceId, terminalId });
      if (focus) requestFocus(terminalId);
      // Remembered natively so the same tab is in front after a restart.
      client.setActiveTerminal(workspaceId, terminalId).catch(() => undefined);
    },
    [client, active, requestFocus, isCurrent, lifecycle],
  );

  const createTerminal = useCallback(
    async (shellId: string | null = null) => {
      const current = captureLifetime();
      if (!current() || !active) return null;
      const intent = ++lifecycle.focusIntent;
      const mayFocus = () => current() && intent === lifecycle.focusIntent && lifecycle.workspaceId === active.id;
      try {
        const terminal = await client.createTerminal(active.id, shellId, lastSize.current);
        if (!current()) return null;
        const pending = { intent, epoch: lifecycle.epoch, terminalId: terminal.id, workspaceId: active.id };
        if (mayFocus()) lifecycle.pendingFocus = pending;
        // Keep the native session visible in history without overriding a newer
        // workspace or terminal choice while creation/refresh was pending.
        try {
          await refresh();
          if (!mayFocus()) return null;
          setSelected({ workspaceId: active.id, terminalId: terminal.id });
          requestFocus(terminal.id);
          return terminal;
        } finally {
          if (lifecycle.pendingFocus === pending) lifecycle.pendingFocus = null;
        }
      } catch (err) {
        if (mayFocus()) fail("Couldn't start a terminal", err);
        return null;
      }
    },
    [client, active, refresh, fail, requestFocus, captureLifetime, lifecycle],
  );

  const closeTerminal = useCallback(
    async (terminalId: string) => {
      const current = captureLifetime();
      if (!current()) return;
      // The neighbouring tab comes to the front when the tab in front closes.
      const next = neighbourAfterClose(snapshot.terminals, terminalId);
      if (active && terminalId === activeTerminalId && next) {
        lifecycle.focusIntent += 1;
        setSelected({ workspaceId: active.id, terminalId: next });
      }
      try {
        await client.closeTerminal(terminalId);
      } catch (err) {
        if (current()) fail("Couldn't close the terminal", err);
      }
      if (current()) await refresh();
    },
    [client, refresh, fail, snapshot.terminals, active, activeTerminalId, captureLifetime, lifecycle],
  );

  const restartTerminal = useCallback(
    async (terminalId: string) => {
      const current = captureLifetime();
      if (!current()) return null;
      const intent = ++lifecycle.focusIntent;
      const mayFocus = () => current() && intent === lifecycle.focusIntent;
      try {
        const terminal = await client.restartTerminal(terminalId, lastSize.current);
        if (!current()) return null;
        const pending = { intent, epoch: lifecycle.epoch, terminalId: terminal.id, workspaceId: terminal.workspaceId };
        if (mayFocus() && lifecycle.workspaceId === terminal.workspaceId) lifecycle.pendingFocus = pending;
        try {
          await refresh();
          if (!mayFocus() || lifecycle.workspaceId !== terminal.workspaceId) return null;
          requestFocus(terminal.id);
          return terminal;
        } finally {
          if (lifecycle.pendingFocus === pending) lifecycle.pendingFocus = null;
        }
      } catch (err) {
        if (mayFocus()) fail("Couldn't restart the terminal", err);
        return null;
      }
    },
    [client, refresh, fail, requestFocus, captureLifetime, lifecycle],
  );

  const retry = useCallback(() => {
    if (isCurrent()) setAttempt((n) => n + 1);
  }, [isCurrent]);

  const value = useMemo<WorkspaceValue>(
    () => ({
      state,
      error,
      workspaces: snapshot.workspaces,
      active,
      shells,
      terminals: snapshot.terminals,
      activeTerminalId,
      running: snapshot.running,
      picking,
      lastSize,
      retry,
      refresh,
      openFolder,
      activate,
      remove,
      createTerminal,
      closeTerminal,
      restartTerminal,
      selectTerminal,
      focusRequest,
    }),
    [
      state,
      error,
      snapshot,
      active,
      shells,
      activeTerminalId,
      picking,
      retry,
      refresh,
      openFolder,
      activate,
      remove,
      createTerminal,
      closeTerminal,
      restartTerminal,
      selectTerminal,
      focusRequest,
    ],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspaces(): WorkspaceValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("useWorkspaces must be used inside <WorkspaceProvider>");
  return value;
}
