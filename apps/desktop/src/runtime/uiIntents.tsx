import type { DashboardChip } from "@kalcode/protocol";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useNavigation } from "../shell/navigation.tsx";
import { usePermissions } from "../surfaces/permissions/PermissionsProvider.tsx";
import { useThreadsIntent } from "../surfaces/threads/intent.tsx";
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
}

const UiIntentsContext = createContext<UiIntents | null>(null);

/**
 * Cross-surface intents (Z7-W3). Must sit inside the navigation, workspace, permission and
 * threads-intent providers, whose actions the default focus handler uses.
 */
export function UiIntentsProvider({ children }: { children: ReactNode }) {
  const { client, info } = useRuntime();
  const { navigate } = useNavigation();
  const workspaces = useWorkspaces();
  const permissions = usePermissions();
  const threadsIntent = useThreadsIntent();
  const handlers = useRef<FocusHandler[]>([]);
  const focusGeneration = useRef(0);
  const [dashboardFilter, setDashboardFilter] = useState<DashboardFilterRequest | null>(null);
  const [paneFocus, setPaneFocus] = useState<PaneFocusRequest | null>(null);

  // The latest context values, read by the stable callbacks below.
  const live = useRef({ navigate, workspaces, permissions, threadsIntent, client, info });
  live.current = { navigate, workspaces, permissions, threadsIntent, client, info };

  useEffect(
    () => () => {
      focusGeneration.current += 1;
    },
    [],
  );

  const filterDashboard = useCallback((chip: DashboardChip) => {
    focusGeneration.current += 1;
    setPaneFocus(null);
    live.current.navigate("dashboard");
    setDashboardFilter((current) => ({ chip, nonce: (current?.nonce ?? 0) + 1 }));
  }, []);

  const registerFocusHandler = useCallback((handler: FocusHandler) => {
    handlers.current = [handler, ...handlers.current];
    return () => {
      handlers.current = handlers.current.filter((h) => h !== handler);
    };
  }, []);

  const focus = useCallback(
    async (target: FocusTarget) => {
      const generation = ++focusGeneration.current;
      const originClient = live.current.client;
      const isCurrent = () => generation === focusGeneration.current && originClient === live.current.client;
      setPaneFocus(null);
      for (const handler of handlers.current) {
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
            const ok = workspaces.active?.id === workspaceId || (await workspaces.activate(workspaceId));
            if (!isCurrent()) return;
            if (ok) {
              navigate("code");
              setPaneFocus({ threadId: target.threadId, nonce: generation });
              return;
            }
          }
          navigate("threads");
          threadsIntent.request("open", target.threadId);
          return;
        }
      }
    },
    [filterDashboard],
  );

  const consumePaneFocus = useCallback((nonce: number) => {
    setPaneFocus((current) => (current?.nonce === nonce ? null : current));
  }, []);

  const value = useMemo<UiIntents>(
    () => ({ focus, registerFocusHandler, filterDashboard, dashboardFilter, paneFocus, consumePaneFocus }),
    [focus, registerFocusHandler, filterDashboard, dashboardFilter, paneFocus, consumePaneFocus],
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
