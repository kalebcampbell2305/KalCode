import type { RailSection, RailState, RailUpdate, WorkspaceGroup, WorkspaceRailEntry } from "@kalcode/protocol";
import { useToast } from "@kalcode/ui/components";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { type KalCodeError, toKalCodeError } from "../../ipc/errors.ts";
import { useEvents, useRuntime } from "../../runtime/RuntimeProvider.tsx";
import { useWorkspaces } from "../../runtime/WorkspaceProvider.tsx";
import { useThreadsIntent } from "../../surfaces/threads/intent.tsx";
import { useNavigation, viewVisible } from "../navigation.tsx";

type LoadState = "loading" | "ready" | "error";

export interface RailValue {
  /** The rail is part of this build (`workspace_rail` feature visible). */
  enabled: boolean;
  state: LoadState;
  error: KalCodeError | null;
  rail: RailState | null;
  /** The rail column is collapsed to its narrow strip (persisted). */
  hidden: boolean;
  refresh: () => Promise<void>;
  update: (update: RailUpdate) => Promise<WorkspaceRailEntry | null>;
  setSection: (section: RailSection, collapsed: boolean) => Promise<void>;
  toggleHidden: () => void;
  createGroup: (name: string) => Promise<WorkspaceGroup | null>;
  renameGroup: (id: string, name: string) => Promise<boolean>;
  setGroupCollapsed: (id: string, collapsed: boolean) => Promise<void>;
  deleteGroup: (group: WorkspaceGroup) => Promise<void>;
  moveGroup: (id: string, delta: -1 | 1) => Promise<void>;
  /** Makes a workspace active and shows its project page (or Code without the project view). */
  openWorkspace: (workspaceId: string, where?: "project" | "code") => Promise<void>;
  openThread: (threadId: string) => void;
  reveal: (workspaceId: string) => Promise<void>;
}

const RailContext = createContext<RailValue | null>(null);

/** Event types after which the rail's counts, badges or workspaces may have changed. */
const RELEVANT = /^(thread\.|approval\.|workspace\.|shell\.|agent\.message|settings\.changed)/;

export function RailProvider({ children }: { children: ReactNode }) {
  const { client, info } = useRuntime();
  const { events } = useEvents();
  const workspaces = useWorkspaces();
  const threadsIntent = useThreadsIntent();
  const { navigate } = useNavigation();
  const toast = useToast();
  const enabled = viewVisible("folder", info.flags.features);
  const folderVisible = enabled;
  const [rail, setRail] = useState<RailState | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState<KalCodeError | null>(null);
  const request = useRef(0);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    const id = ++request.current;
    try {
      const next = await client.railState();
      if (id !== request.current) return;
      setRail(next);
      setState("ready");
      setError(null);
    } catch (cause) {
      if (id !== request.current) return;
      setError(toKalCodeError(cause));
      setState("error");
    }
  }, [client, enabled]);

  // First load, and whenever Z1's workspace list changes (open, remove, activate).
  const workspaceKey = `${workspaces.workspaces.map((w) => `${w.id}:${w.lastOpenedAt}:${w.available}`).join("|")}#${workspaces.active?.id ?? ""}`;
  useEffect(() => {
    void workspaceKey;
    void refresh();
  }, [refresh, workspaceKey]);

  // Live counts and badges: refresh (debounced) after thread, approval and workspace events.
  const newest = events[0]?.seq ?? 0;
  const seen = useRef(newest);
  useEffect(() => {
    const fresh = events.filter((e) => e.seq > seen.current);
    seen.current = Math.max(seen.current, newest);
    if (!fresh.some((e) => RELEVANT.test(e.type))) return;
    const timer = setTimeout(() => void refresh(), 150);
    return () => clearTimeout(timer);
  }, [events, newest, refresh]);

  const fail = useCallback(
    (title: string, cause: unknown) => {
      toast.show({ tone: "danger", title, description: toKalCodeError(cause).message });
    },
    [toast],
  );

  const update = useCallback(
    async (change: RailUpdate) => {
      try {
        const entry = await client.railUpdate(change);
        await refresh();
        return entry;
      } catch (cause) {
        fail("Couldn't update the workspace rail", cause);
        return null;
      }
    },
    [client, refresh, fail],
  );

  const setSection = useCallback(
    async (section: RailSection, collapsed: boolean) => {
      // Optimistic: collapsing is instant; the native answer is the truth.
      setRail((r) =>
        r
          ? {
              ...r,
              collapsedSections: collapsed
                ? [...r.collapsedSections.filter((s) => s !== section), section]
                : r.collapsedSections.filter((s) => s !== section),
            }
          : r,
      );
      try {
        setRail(await client.railSectionSet(section, collapsed));
      } catch (cause) {
        fail("Couldn't save that", cause);
        void refresh();
      }
    },
    [client, refresh, fail],
  );

  const hidden = rail?.collapsedSections.includes("rail") ?? false;
  const toggleHidden = useCallback(() => {
    void setSection("rail", !hidden);
  }, [setSection, hidden]);

  const createGroup = useCallback(
    async (name: string) => {
      try {
        const group = await client.railGroupCreate(name);
        await refresh();
        return group;
      } catch (cause) {
        fail("Couldn't create the folder", cause);
        return null;
      }
    },
    [client, refresh, fail],
  );

  const renameGroup = useCallback(
    async (id: string, name: string) => {
      try {
        await client.railGroupUpdate(id, { name });
        await refresh();
        return true;
      } catch (cause) {
        fail("Couldn't rename the folder", cause);
        return false;
      }
    },
    [client, refresh, fail],
  );

  const setGroupCollapsed = useCallback(
    async (id: string, collapsed: boolean) => {
      setRail((r) =>
        r
          ? { ...r, groups: r.groups.map((g) => (g.group.id === id ? { ...g, group: { ...g.group, collapsed } } : g)) }
          : r,
      );
      try {
        await client.railGroupUpdate(id, { collapsed });
      } catch (cause) {
        fail("Couldn't save that", cause);
      }
      await refresh();
    },
    [client, refresh, fail],
  );

  const deleteGroup = useCallback(
    async (group: WorkspaceGroup) => {
      try {
        await client.railGroupDelete(group.id);
        await refresh();
        toast.show({
          tone: "success",
          title: `Folder “${group.name}” removed`,
          description: "Its workspaces moved to Recent.",
        });
      } catch (cause) {
        fail("Couldn't remove the folder", cause);
      }
    },
    [client, refresh, fail, toast],
  );

  const moveGroup = useCallback(
    async (id: string, delta: -1 | 1) => {
      const ids = rail?.groups.map((g) => g.group.id) ?? [];
      const at = ids.indexOf(id);
      const to = at + delta;
      if (at < 0 || to < 0 || to >= ids.length) return;
      [ids[at], ids[to]] = [ids[to] as string, ids[at] as string];
      try {
        await client.railGroupReorder(ids);
        await refresh();
      } catch (cause) {
        fail("Couldn't move the folder", cause);
      }
    },
    [client, rail, refresh, fail],
  );

  const live = useRef({ workspaces, threadsIntent });
  live.current = { workspaces, threadsIntent };
  const openWorkspace = useCallback(
    async (workspaceId: string, where: "project" | "code" = "project") => {
      if (await live.current.workspaces.activate(workspaceId)) {
        navigate(where === "project" && folderVisible ? "folder" : "code");
      }
    },
    [navigate, folderVisible],
  );

  const openThread = useCallback(
    (threadId: string) => {
      navigate("threads");
      live.current.threadsIntent.request("open", threadId);
    },
    [navigate],
  );

  const reveal = useCallback(
    async (workspaceId: string) => {
      try {
        await client.revealWorkspace(workspaceId);
      } catch (cause) {
        fail("Couldn't show the folder", cause);
      }
    },
    [client, fail],
  );

  const value = useMemo<RailValue>(
    () => ({
      enabled,
      state,
      error,
      rail,
      hidden,
      refresh,
      update,
      setSection,
      toggleHidden,
      createGroup,
      renameGroup,
      setGroupCollapsed,
      deleteGroup,
      moveGroup,
      openWorkspace,
      openThread,
      reveal,
    }),
    [
      enabled,
      state,
      error,
      rail,
      hidden,
      refresh,
      update,
      setSection,
      toggleHidden,
      createGroup,
      renameGroup,
      setGroupCollapsed,
      deleteGroup,
      moveGroup,
      openWorkspace,
      openThread,
      reveal,
    ],
  );
  return <RailContext.Provider value={value}>{children}</RailContext.Provider>;
}

export function useRail(): RailValue {
  const value = useContext(RailContext);
  if (!value) throw new Error("useRail must be used inside <RailProvider>");
  return value;
}

export function useOptionalRail(): RailValue | null {
  return useContext(RailContext);
}
