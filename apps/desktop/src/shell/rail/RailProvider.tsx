import type { RailSection, RailState, RailUpdate, WorkspaceGroup, WorkspaceRailEntry } from "@kalcode/protocol";
import { useToast } from "@kalcode/ui/components";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { type KalCodeError, toKalCodeError } from "../../ipc/errors.ts";
import { useEvents, useRuntime } from "../../runtime/RuntimeProvider.tsx";
import { useUiIntents } from "../../runtime/uiIntents.tsx";
import { useWorkspaces } from "../../runtime/WorkspaceProvider.tsx";
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
  /**
   * Makes a workspace active and shows its project page; `code` (and builds without the project
   * view) goes through the shared focus intent, where the pane system shows it.
   */
  openWorkspace: (workspaceId: string, where?: "project" | "code") => Promise<void>;
  openThread: (threadId: string, workspaceId?: string) => void;
  reveal: (workspaceId: string) => Promise<void>;
}

const RailContext = createContext<RailValue | null>(null);

/** Below this window width the rail starts collapsed to its strip. */
const NARROW_PX = 1400;

/** Event types after which the rail's counts, badges or workspaces may have changed. */
const RELEVANT = /^(thread\.|approval\.|workspace\.|shell\.|agent\.message|settings\.changed)/;

export function RailProvider({ children }: { children: ReactNode }) {
  const { client, info } = useRuntime();
  const { events } = useEvents();
  const workspaces = useWorkspaces();
  const intents = useUiIntents();
  const { navigate } = useNavigation();
  const toast = useToast();
  const enabled = viewVisible("folder", info.flags.features);
  const folderVisible = enabled;
  // A replacement client (or a newly enabled rail) owns fresh reads, actions and events.
  // biome-ignore lint/correctness/useExhaustiveDependencies: client and feature identity define the lifetime.
  const lifetime = useMemo(
    () => ({ mounted: false, epoch: 0, request: 0, seen: 0, timer: null as ReturnType<typeof setTimeout> | null }),
    [client, enabled],
  );
  const currentLifetime = useRef(lifetime);
  currentLifetime.current = lifetime;
  const captureLifetime = useCallback(() => {
    const epoch = lifetime.epoch;
    return () => lifetime.mounted && currentLifetime.current === lifetime && lifetime.epoch === epoch;
  }, [lifetime]);
  const captureRailLifetime = useCallback(() => {
    const isCurrent = captureLifetime();
    return () => enabled && isCurrent();
  }, [enabled, captureLifetime]);
  const [snapshot, setSnapshot] = useState<{
    owner: typeof lifetime;
    epoch: number;
    rail: RailState | null;
    state: LoadState;
    error: KalCodeError | null;
  }>({ owner: lifetime, epoch: lifetime.epoch, rail: null, state: "loading", error: null });
  const ownsSnapshot = snapshot.owner === lifetime && snapshot.epoch === lifetime.epoch;
  const rail = ownsSnapshot ? snapshot.rail : null;
  const state = ownsSnapshot ? snapshot.state : "loading";
  const error = ownsSnapshot ? snapshot.error : null;
  const setRail = useCallback(
    (next: RailState | ((rail: RailState | null) => RailState | null)) => {
      setSnapshot((current) => ({
        ...current,
        owner: lifetime,
        epoch: lifetime.epoch,
        rail:
          typeof next === "function"
            ? next(current.owner === lifetime && current.epoch === lifetime.epoch ? current.rail : null)
            : next,
      }));
    },
    [lifetime],
  );

  useEffect(() => {
    lifetime.mounted = true;
    setSnapshot({ owner: lifetime, epoch: lifetime.epoch, rail: null, state: "loading", error: null });
    return () => {
      lifetime.mounted = false;
      lifetime.epoch += 1;
      lifetime.request += 1;
      lifetime.seen = 0;
      if (lifetime.timer !== null) clearTimeout(lifetime.timer);
      lifetime.timer = null;
    };
  }, [lifetime]);

  const refresh = useCallback(async () => {
    const isCurrent = captureRailLifetime();
    if (!isCurrent()) return;
    const id = ++lifetime.request;
    try {
      const next = await client.railState();
      if (!isCurrent() || id !== lifetime.request) return;
      setSnapshot({ owner: lifetime, epoch: lifetime.epoch, rail: next, state: "ready", error: null });
    } catch (cause) {
      if (!isCurrent() || id !== lifetime.request) return;
      setSnapshot((current) => ({
        ...current,
        owner: lifetime,
        epoch: lifetime.epoch,
        error: toKalCodeError(cause),
        state: "error",
      }));
    }
  }, [client, captureRailLifetime, lifetime]);

  // First load, and whenever Z1's workspace list changes (open, remove, activate).
  const workspaceKey = `${workspaces.workspaces.map((w) => `${w.id}:${w.lastOpenedAt}:${w.available}`).join("|")}#${workspaces.active?.id ?? ""}`;
  useEffect(() => {
    void workspaceKey;
    void refresh();
  }, [refresh, workspaceKey]);

  // Live counts and badges: refresh (debounced) after thread, approval and workspace events.
  const newest = events[0]?.seq ?? 0;
  useEffect(() => {
    const isCurrent = captureRailLifetime();
    if (!isCurrent()) return;
    const fresh = events.filter((e) => e.seq > lifetime.seen);
    lifetime.seen = Math.max(lifetime.seen, newest);
    if (!fresh.some((e) => RELEVANT.test(e.type))) return;
    if (lifetime.timer !== null) clearTimeout(lifetime.timer);
    lifetime.timer = setTimeout(() => {
      lifetime.timer = null;
      if (isCurrent()) void refresh();
    }, 150);
    // Unrelated events must not cancel an already scheduled relevant refresh.
    // Lifetime cleanup above releases the timer on replacement/unmount.
  }, [events, newest, refresh, captureRailLifetime, lifetime]);

  const fail = useCallback(
    (title: string, cause: unknown) => {
      toast.show({ tone: "danger", title, description: toKalCodeError(cause).message });
    },
    [toast],
  );

  const update = useCallback(
    async (change: RailUpdate) => {
      const isCurrent = captureRailLifetime();
      if (!isCurrent()) return null;
      try {
        const entry = await client.railUpdate(change);
        if (!isCurrent()) return null;
        await refresh();
        return isCurrent() ? entry : null;
      } catch (cause) {
        if (isCurrent()) fail("Couldn't update the workspace rail", cause);
        return null;
      }
    },
    [client, refresh, fail, captureRailLifetime],
  );

  const setSection = useCallback(
    async (section: RailSection, collapsed: boolean) => {
      const isCurrent = captureRailLifetime();
      if (!isCurrent()) return;
      // A read started before this choice must not undo its optimistic state.
      lifetime.request += 1;
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
        const next = await client.railSectionSet(section, collapsed);
        if (isCurrent()) {
          // The committed response supersedes reads begun while this write was pending.
          lifetime.request += 1;
          setRail(next);
        }
      } catch (cause) {
        if (!isCurrent()) return;
        fail("Couldn't save that", cause);
        void refresh();
      }
    },
    [client, refresh, fail, captureRailLifetime, setRail, lifetime],
  );

  // Narrow windows (under 1400 px, e.g. 1366×768) start with the collapsed strip so the page keeps
  // its width; expanding it there lasts for the session. Wider windows use the saved choice.
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.innerWidth < NARROW_PX);
  const [openWhileNarrow, setOpenWhileNarrow] = useState(false);
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < NARROW_PX);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const savedHidden = rail?.collapsedSections.includes("rail") ?? false;
  const hidden = savedHidden || (narrow && !openWhileNarrow);
  const toggleHidden = useCallback(() => {
    if (!captureRailLifetime()()) return;
    if (hidden) {
      if (savedHidden) void setSection("rail", false);
      if (narrow) setOpenWhileNarrow(true);
    } else if (narrow) {
      setOpenWhileNarrow(false);
    } else {
      void setSection("rail", true);
    }
  }, [setSection, hidden, savedHidden, narrow, captureRailLifetime]);

  const createGroup = useCallback(
    async (name: string) => {
      const isCurrent = captureRailLifetime();
      if (!isCurrent()) return null;
      try {
        const group = await client.railGroupCreate(name);
        if (!isCurrent()) return null;
        await refresh();
        return isCurrent() ? group : null;
      } catch (cause) {
        if (isCurrent()) fail("Couldn't create the folder", cause);
        return null;
      }
    },
    [client, refresh, fail, captureRailLifetime],
  );

  const renameGroup = useCallback(
    async (id: string, name: string) => {
      const isCurrent = captureRailLifetime();
      if (!isCurrent()) return false;
      try {
        await client.railGroupUpdate(id, { name });
        if (!isCurrent()) return false;
        await refresh();
        return isCurrent();
      } catch (cause) {
        if (isCurrent()) fail("Couldn't rename the folder", cause);
        return false;
      }
    },
    [client, refresh, fail, captureRailLifetime],
  );

  const setGroupCollapsed = useCallback(
    async (id: string, collapsed: boolean) => {
      const isCurrent = captureRailLifetime();
      if (!isCurrent()) return;
      lifetime.request += 1;
      setRail((r) =>
        r
          ? { ...r, groups: r.groups.map((g) => (g.group.id === id ? { ...g, group: { ...g.group, collapsed } } : g)) }
          : r,
      );
      try {
        await client.railGroupUpdate(id, { collapsed });
      } catch (cause) {
        if (isCurrent()) fail("Couldn't save that", cause);
      }
      if (isCurrent()) await refresh();
    },
    [client, refresh, fail, captureRailLifetime, setRail, lifetime],
  );

  const deleteGroup = useCallback(
    async (group: WorkspaceGroup) => {
      const isCurrent = captureRailLifetime();
      if (!isCurrent()) return;
      try {
        await client.railGroupDelete(group.id);
        if (!isCurrent()) return;
        await refresh();
        if (!isCurrent()) return;
        toast.show({
          tone: "success",
          title: `Folder “${group.name}” removed`,
          description: "Its workspaces moved to Recent.",
        });
      } catch (cause) {
        if (isCurrent()) fail("Couldn't remove the folder", cause);
      }
    },
    [client, refresh, fail, toast, captureRailLifetime],
  );

  const moveGroup = useCallback(
    async (id: string, delta: -1 | 1) => {
      const isCurrent = captureRailLifetime();
      if (!isCurrent()) return;
      const ids = rail?.groups.map((g) => g.group.id) ?? [];
      const at = ids.indexOf(id);
      const to = at + delta;
      if (at < 0 || to < 0 || to >= ids.length) return;
      [ids[at], ids[to]] = [ids[to] as string, ids[at] as string];
      try {
        await client.railGroupReorder(ids);
        if (isCurrent()) await refresh();
      } catch (cause) {
        if (isCurrent()) fail("Couldn't move the folder", cause);
      }
    },
    [client, rail, refresh, fail, captureRailLifetime],
  );

  const live = useRef({ workspaces, intents });
  live.current = { workspaces, intents };
  const openWorkspace = useCallback(
    async (workspaceId: string, where: "project" | "code" = "project") => {
      const isCurrent = captureLifetime();
      if (!isCurrent()) return;
      if (where === "project" && folderVisible) {
        if ((await live.current.workspaces.activate(workspaceId)) && isCurrent()) navigate("folder");
        return;
      }
      await live.current.intents.focus({ kind: "workspace", workspaceId });
    },
    [navigate, folderVisible, captureLifetime],
  );

  const openThread = useCallback(
    (threadId: string, workspaceId?: string) => {
      if (captureLifetime()())
        void live.current.intents.focus({ kind: "thread", threadId, workspaceId: workspaceId ?? null });
    },
    [captureLifetime],
  );

  const reveal = useCallback(
    async (workspaceId: string) => {
      const isCurrent = captureLifetime();
      if (!isCurrent()) return;
      try {
        await client.revealWorkspace(workspaceId);
      } catch (cause) {
        if (isCurrent()) fail("Couldn't show the folder", cause);
      }
    },
    [client, fail, captureLifetime],
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
