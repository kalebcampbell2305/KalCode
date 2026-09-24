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
  const generation = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const id = ++generation.current;
    const [workspaces, active, running] = await Promise.all([
      client.listWorkspaces(),
      client.activeWorkspace(),
      client.runningTerminals(),
    ]);
    const terminals = active ? await client.listTerminals(active.id) : [];
    // A slower, older refresh must never overwrite a newer one.
    if (id !== generation.current) return;
    setSnapshot({ workspaces, active, terminals, running });
  }, [client]);

  const refresh = useCallback(async () => {
    try {
      await load();
    } catch (err) {
      // A live refresh failing keeps the last good state; the next event retries.
      if (import.meta.env.DEV) console.warn("workspace refresh failed", err);
    }
  }, [load]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` re-runs the initial load on retry.
  useEffect(() => {
    let cancelled = false;
    setState("loading");
    Promise.all([load(), client.listShells().then(setShells)])
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
  }, [client, load, attempt]);

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
    setPicking(true);
    try {
      const workspace = await client.openWorkspaceDialog();
      if (workspace) await refresh();
      return workspace;
    } catch (err) {
      fail("Couldn't open that folder", err);
      return null;
    } finally {
      setPicking(false);
    }
  }, [client, refresh, fail]);

  const activate = useCallback(
    async (workspaceId: string) => {
      try {
        await client.activateWorkspace(workspaceId);
        await refresh();
        return true;
      } catch (err) {
        fail("Couldn't switch workspace", err);
        return false;
      }
    },
    [client, refresh, fail],
  );

  const remove = useCallback(
    async (workspace: Workspace) => {
      try {
        await client.removeWorkspace(workspace.id);
        await refresh();
        toast.show({
          tone: "success",
          title: `${workspace.name} removed from KalCode`,
          description: "The folder and its files were not changed.",
        });
        return true;
      } catch (err) {
        fail("Couldn't remove workspace", err);
        return false;
      }
    },
    [client, refresh, fail, toast],
  );

  const selectTerminal = useCallback(
    (terminalId: string, focus = false, workspaceId: string | undefined = active?.id) => {
      if (!workspaceId) return;
      setSelected({ workspaceId, terminalId });
      if (focus) requestFocus(terminalId);
      // Remembered natively so the same tab is in front after a restart.
      client.setActiveTerminal(workspaceId, terminalId).catch(() => undefined);
    },
    [client, active, requestFocus],
  );

  const createTerminal = useCallback(
    async (shellId: string | null = null) => {
      if (!active) return null;
      try {
        const terminal = await client.createTerminal(active.id, shellId, lastSize.current);
        setSelected({ workspaceId: active.id, terminalId: terminal.id });
        requestFocus(terminal.id);
        await refresh();
        return terminal;
      } catch (err) {
        fail("Couldn't start a terminal", err);
        return null;
      }
    },
    [client, active, refresh, fail, requestFocus],
  );

  const closeTerminal = useCallback(
    async (terminalId: string) => {
      // The neighbouring tab comes to the front when the tab in front closes.
      const next = neighbourAfterClose(snapshot.terminals, terminalId);
      if (active && terminalId === activeTerminalId && next) setSelected({ workspaceId: active.id, terminalId: next });
      try {
        await client.closeTerminal(terminalId);
      } catch (err) {
        fail("Couldn't close the terminal", err);
      }
      await refresh();
    },
    [client, refresh, fail, snapshot.terminals, active, activeTerminalId],
  );

  const restartTerminal = useCallback(
    async (terminalId: string) => {
      try {
        const terminal = await client.restartTerminal(terminalId, lastSize.current);
        requestFocus(terminal.id);
        await refresh();
        return terminal;
      } catch (err) {
        fail("Couldn't restart the terminal", err);
        return null;
      }
    },
    [client, refresh, fail, requestFocus],
  );

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

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
