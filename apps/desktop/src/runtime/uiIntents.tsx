import type { DashboardChip } from "@kalcode/protocol";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useNavigation } from "../shell/navigation.tsx";
import { usePermissions } from "../surfaces/permissions/PermissionsProvider.tsx";
import { expireRebindRequest, useSelectedThread } from "../surfaces/threads/accountIntent.ts";
import { useThreadsIntent } from "../surfaces/threads/intent.tsx";
import { focusHistory, forgetFocus, recordFocus } from "./focusHistory.ts";
import { useRuntime } from "./RuntimeProvider.tsx";
import { useWorkspaces } from "./WorkspaceProvider.tsx";

/**
 * Where a Dashboard card, a notification, a widget or KalVoice wants to take the person.
 * A navigation intent, not a route: the pane system (Z7-W1) registers a handler that focuses the
 * pane showing the target (opening it if needed); until then the default handler below opens the
 * surface that shows it today.
 */
export type FocusTarget =
  | { kind: "thread"; threadId: string; workspaceId?: string | null }
  | { kind: "workspace"; workspaceId: string }
  | { kind: "provider"; providerId: string }
  | { kind: "approvals" }
  | { kind: "dashboard"; chip?: DashboardChip };

/** Returns true when it handled the request (later handlers and the default are skipped). */
export type FocusHandler = (target: FocusTarget) => boolean | Promise<boolean>;

/** A request for a provider pane (Code surface) to select and focus its thread. */
export interface PaneFocusRequest {
  threadId: string;
  nonce: number;
}

export interface DashboardFilterRequest {
  chip: DashboardChip;
  nonce: number;
}

export interface UiIntents {
  /** Focus a thread, workspace, provider, the approvals queue or the Dashboard. */
  focus: (target: FocusTarget) => Promise<void>;
  /** Claim focus requests first (the pane system). Returns the unregister function. */
  registerFocusHandler: (handler: FocusHandler) => () => void;
  /** Ask the Dashboard to show one filter chip (KalVoice, notifications). */
  filterDashboard: (chip: DashboardChip) => void;
  dashboardFilter: DashboardFilterRequest | null;
  /** The latest unhandled request for a provider pane to take focus. */
  paneFocus: PaneFocusRequest | null;
  /** Marks a pane-focus request handled (it is then cleared). */
  consumePaneFocus: (nonce: number) => void;
  /**
   * Focuses the thread or terminal used before the current one ("go back to the terminal I was
   * just using"). Skips targets that no longer exist. Resolves false when there is none.
   */
  focusPrevious: () => Promise<boolean>;
}

const UiIntentsContext = createContext<UiIntents | null>(null);

function createSession() {
  return { active: true, handlers: [] as FocusHandler[] };
}
type IntentSession = ReturnType<typeof createSession>;

/**
 * Cross-surface intents (Z7-W3). Must sit inside the navigation, workspace, permission and
 * threads-intent providers, whose actions the default focus handler uses.
 */
export function UiIntentsProvider({ children }: { children: ReactNode }) {
  const { client, info } = useRuntime();
  const { navigate, current: surface } = useNavigation();
  const workspaces = useWorkspaces();
  const permissions = usePermissions();
  const threadsIntent = useThreadsIntent();
  // A reused client object must not revive callbacks from an earlier visit or effect session.
  // biome-ignore lint/correctness/useExhaustiveDependencies: client defines the intent lifetime.
  const lifetime = useMemo(() => ({ session: createSession() }), [client]);
  const currentLifetime = useRef(lifetime);
  currentLifetime.current = lifetime;
  const session = lifetime.session;
  const [, reconnect] = useState(0);
  const isLive = useCallback(
    () => currentLifetime.current === lifetime && lifetime.session === session && session.active,
    [lifetime, session],
  );
  const focusGeneration = useRef(0);
  const [filterState, setFilterState] = useState<{ owner: IntentSession; request: DashboardFilterRequest } | null>(
    null,
  );
  const [paneState, setPaneState] = useState<{ owner: IntentSession; request: PaneFocusRequest } | null>(null);
  const dashboardFilter = isLive() && filterState?.owner === session ? filterState.request : null;
  const paneFocus = isLive() && paneState?.owner === session ? paneState.request : null;

  // The latest context values, read by the stable callbacks below.
  const live = useRef({ navigate, workspaces, permissions, threadsIntent, client, info });
  live.current = { navigate, workspaces, permissions, threadsIntent, client, info };

  useEffect(() => {
    if (!lifetime.session.active) {
      lifetime.session = createSession();
      reconnect((version) => version + 1);
    }
    const activeSession = lifetime.session;
    return () => {
      activeSession.active = false;
      activeSession.handlers = [];
      focusGeneration.current += 1;
    };
  }, [lifetime]);

  const filterDashboard = useCallback(
    (chip: DashboardChip) => {
      if (!isLive()) return;
      const nonce = ++focusGeneration.current;
      setPaneState(null);
      live.current.navigate("dashboard");
      setFilterState({ owner: session, request: { chip, nonce } });
    },
    [isLive, session],
  );

  const registerFocusHandler = useCallback(
    (handler: FocusHandler) => {
      if (!isLive()) return () => undefined;
      session.handlers = [handler, ...session.handlers];
      return () => {
        session.handlers = session.handlers.filter((h) => h !== handler);
      };
    },
    [isLive, session],
  );

  const focus = useCallback(
    async (target: FocusTarget) => {
      if (!isLive()) return;
      if (target.kind === "thread") {
        recordFocus({ kind: "thread", threadId: target.threadId, workspaceId: target.workspaceId ?? null });
      }
      const generation = ++focusGeneration.current;
      const isCurrent = () => isLive() && generation === focusGeneration.current;
      setPaneState(null);
      for (const handler of session.handlers) {
        try {
          if (await handler(target)) return;
        } catch {
          // A failing handler never blocks the default behaviour.
        }
        if (!isCurrent()) return;
      }
      const { navigate, workspaces, permissions, threadsIntent, client, info } = live.current;
      switch (target.kind) {
        case "approvals":
          permissions.setPanelOpen(true);
          return;
        case "provider":
          navigate("providers");
          return;
        case "dashboard":
          if (target.chip) filterDashboard(target.chip);
          else navigate("dashboard");
          return;
        case "workspace":
          if ((await workspaces.activate(target.workspaceId)) && isCurrent()) navigate("code");
          return;
        case "thread": {
          // Interactive provider threads live in a provider pane in the Code surface (Z7-W4);
          // everything else opens in Threads.
          const panesOn = info.flags.features?.some((f) => f.id === "provider_panes" && f.visible) ?? false;
          let workspaceId = target.workspaceId ?? null;
          let isPane = false;
          if (panesOn) {
            try {
              const thread = await client.getThread(target.threadId);
              if (!isCurrent()) return;
              workspaceId = thread.workspaceId;
              isPane =
                thread.runtimeKind === "interactive_pty" ||
                thread.terminalId !== null ||
                (await client.transport
                  .invoke("provider_pane_info", { threadId: target.threadId })
                  // `null`: not a provider-pane thread (native answers None for headless threads).
                  .then((info) => info !== null && info !== undefined)
                  .catch(() => false));
            } catch {
              isPane = false;
            }
          }
          if (!isCurrent()) return;
          if (isPane && workspaceId) {
            // Even the displayed workspace must supersede an older activation still in flight.
            const ok = await workspaces.activate(workspaceId);
            if (!isCurrent()) return;
            if (ok) {
              navigate("code");
              setPaneState({ owner: session, request: { threadId: target.threadId, nonce: generation } });
              return;
            }
          }
          navigate("threads");
          threadsIntent.request("open", target.threadId);
          return;
        }
      }
    },
    [filterDashboard, isLive, session],
  );

  const consumePaneFocus = useCallback(
    (nonce: number) => {
      if (!isLive()) return;
      setPaneState((current) =>
        isLive() && current?.owner === session && current.request.nonce === nonce ? null : current,
      );
    },
    [isLive, session],
  );

  // A rebind request (palette, KalVoice) is answered on Threads; leaving Threads drops it, so a
  // stale request can never open the Rebind dialog later.
  const shownSurface = useRef(surface);
  useEffect(() => {
    if (shownSurface.current === surface) return;
    shownSurface.current = surface;
    if (surface !== "threads") expireRebindRequest();
  }, [surface]);

  // The thread the Threads surface shows counts as used, however it was opened.
  const shownThread = useSelectedThread()?.threadId ?? null;
  useEffect(() => {
    if (shownThread && isLive()) recordFocus({ kind: "thread", threadId: shownThread, workspaceId: null });
  }, [shownThread, isLive]);

  const focusPrevious = useCallback(async () => {
    // The newest entry is the current target; walk back past anything that no longer exists.
    for (const entry of focusHistory().slice(1)) {
      if (!isLive()) return false;
      const { navigate, workspaces, client } = live.current;
      if (entry.kind === "terminal") {
        if (!workspaces.running.some((t) => t.id === entry.terminalId)) {
          forgetFocus("terminal", entry.terminalId);
          continue;
        }
        if (workspaces.active?.id !== entry.workspaceId && !(await workspaces.activate(entry.workspaceId)))
          return false;
        if (!isLive()) return false;
        navigate("code");
        workspaces.selectTerminal(entry.terminalId, true, entry.workspaceId);
        return true;
      }
      const open = await client
        .getThread(entry.threadId)
        .then((thread) => thread.archivedAt === null)
        .catch(() => false);
      if (!open) {
        forgetFocus("thread", entry.threadId);
        continue;
      }
      await focus({ kind: "thread", threadId: entry.threadId, workspaceId: entry.workspaceId });
      return true;
    }
    return false;
  }, [focus, isLive]);

  const value = useMemo<UiIntents>(
    () => ({
      focus,
      registerFocusHandler,
      filterDashboard,
      dashboardFilter,
      paneFocus,
      consumePaneFocus,
      focusPrevious,
    }),
    [focus, registerFocusHandler, filterDashboard, dashboardFilter, paneFocus, consumePaneFocus, focusPrevious],
  );
  return <UiIntentsContext.Provider value={value}>{children}</UiIntentsContext.Provider>;
}

export function useUiIntents(): UiIntents {
  const value = useContext(UiIntentsContext);
  if (!value) throw new Error("useUiIntents must be used inside <UiIntentsProvider>");
  return value;
}

/** For components that may render outside the shell (tests, a detached pane). */
export function useOptionalUiIntents(): UiIntents | null {
  return useContext(UiIntentsContext);
}

/**
 * Offers each pending pane-focus request to `onRequest`, which returns true when it shows that
 * thread and focused it (provider panes in the Code surface; the pane system later).
 */
export function usePaneFocusRequests(onRequest: (threadId: string) => boolean) {
  const intents = useOptionalUiIntents();
  const request = intents?.paneFocus ?? null;
  const consume = intents?.consumePaneFocus;
  const callback = useRef(onRequest);
  callback.current = onRequest;
  // Re-offered after every render: the caller's list of threads may still be loading.
  useEffect(() => {
    if (!request || !consume) return;
    // Only a component that shows the thread consumes the request.
    if (callback.current(request.threadId)) consume(request.nonce);
  });
}
