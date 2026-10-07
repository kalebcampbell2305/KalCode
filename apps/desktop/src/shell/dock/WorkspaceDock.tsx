/**
 * Code's Workspace Dock: the right side of the Command Deck. Agents stays its default tab; the +
 * picker adds Browser, Dashboard (Mission Control), Needs You, Runs, Queue, Services, Environments,
 * Activity, Provider Usage, KalVoice, Git and Tests / Build beside the terminals. The dock is a VIEW:
 * every tab renders an existing canonical surface (the real agent state, the real Live Browser and
 * its native session, the shared Operations feed, the attention inbox, the account authority,
 * KalVoice), and the dock itself remembers only its arrangement, per workspace (`layout.ts`).
 *
 * It resizes from its left edge (terminals fit once the drag settles), collapses to a rail of tab
 * icons with live badges, and, until the person chooses, follows the agents the way the agents
 * rail always has: open while one works or needs them, the rail otherwise.
 */
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  IconButton,
  ObjectContextMenu,
  type ObjectMenuItem,
  Tooltip,
  useToast,
} from "@kalcode/ui/components";
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Globe,
  Maximize2,
  Minimize2,
  PanelRightClose,
  PanelRightOpen,
  PanelsTopLeft,
  Pin,
  PinOff,
  Plus,
  RotateCcw,
  X,
} from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent,
  memo,
  type PointerEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useOptionalRuntime } from "../../runtime/RuntimeProvider.tsx";
import { useWorkspaces } from "../../runtime/WorkspaceProvider.tsx";
import { BrowserPane, browserContent, createBrowserBridge } from "../../surfaces/browser/index.ts";
import { filteredSnapshot, isActiveRun } from "../../surfaces/operations/model.ts";
import { useAttention } from "../attention/useAttention.ts";
import { AgentsView, useAgentSections } from "../deck/AgentRail.tsx";
import { useDeckData } from "../deck/DeckData.tsx";
import { useDeckUi } from "../deck/DeckUi.tsx";
import { DOCK_SURFACE_META, DockSurface, type DockSurfaceId } from "../deck/DockSurfaces.tsx";
import { railWantsOpen } from "../deck/deckModel.ts";
import { beginLiveResize } from "../panes/liveResize.ts";
import { useOpenInPane } from "../panes/useOpenInPane.ts";
import {
  applyDockLayout,
  BROWSER_START_WIDTH,
  clampDockWidth,
  DEFAULT_DOCK_WIDTH,
  type DockLayout,
  type DockLayoutChange,
  type DockTabId,
  EXPANDED_DOCK_WIDTH,
  loadDockLayout,
  MAX_DOCK_WIDTH,
  MIN_DOCK_WIDTH,
  rememberDefaultCollapsed,
  saveDockLayout,
} from "./layout.ts";
import styles from "./WorkspaceDock.module.css";

/** Terminals keep at least this much width beside the dock while it is dragged wider. */
const MIN_MAIN_CANVAS = 480;
const RESIZE_STEP = 24;
/** A tab press becomes a drag after this much movement (a click never reorders). */
const DRAG_THRESHOLD = 4;

interface DockMeta {
  id: DockTabId;
  label: string;
  icon: typeof Bot;
}

const META: readonly DockMeta[] = [
  { id: "agents", label: "Agents", icon: Bot },
  { id: "browser", label: "Browser", icon: Globe },
  ...DOCK_SURFACE_META,
];

function metaFor(id: DockTabId): DockMeta {
  return META.find((item) => item.id === id) ?? { id, label: id, icon: Bot };
}

type SurfaceFlags = readonly { id: string; state: string; visible: boolean }[] | undefined;

function usable(flags: SurfaceFlags, id: string): boolean {
  if (!flags) return true;
  return flags.some((flag) => flag.id === id && flag.visible && flag.state === "available");
}

/** Only surfaces this build actually ships are offered; Browser and Git need a project. */
function availableTabs(runtime: ReturnType<typeof useOptionalRuntime>, hasWorkspace: boolean): DockTabId[] {
  const surfaces = runtime?.info.flags.surfaces;
  const features = runtime?.info.flags.features;
  const available = new Set<DockTabId>(["agents"]);
  if (hasWorkspace) available.add("browser");
  for (const meta of DOCK_SURFACE_META) {
    if (meta.requires && !usable(surfaces, meta.requires)) continue;
    if (meta.id === "git" && (!hasWorkspace || !usable(features, "git_core"))) continue;
    available.add(meta.id);
  }
  return META.map(({ id }) => id).filter((id) => available.has(id));
}

/** The dock for whichever project is active. Its own subtree, so Shell re-renders skip it. */
export const ShellDock = memo(function ShellDock() {
  const { active } = useWorkspaces();
  const workspaceId = active?.id ?? null;
  // A key boundary per project: each one has its own arrangement and its own Browser session.
  return <WorkspaceDock key={workspaceId ?? "_"} workspaceId={workspaceId} />;
});

interface TabDrag {
  id: DockTabId;
  pointerId: number;
  startX: number;
  dragging: boolean;
  to: number;
}

export function WorkspaceDock({ workspaceId }: { workspaceId: string | null }) {
  const runtime = useOptionalRuntime();
  const toast = useToast();
  const available = useMemo(() => availableTabs(runtime, workspaceId !== null), [runtime, workspaceId]);
  const [layout, setLayout] = useState<DockLayout>(() => loadDockLayout(workspaceId, available));
  const [bridge] = useState(createBrowserBridge);
  const openInPane = useOpenInPane();
  const deck = useDeckUi();
  const agents = useAgentSections();
  const attention = useAttention();
  const { operations } = useDeckData();
  const [expanded, setExpanded] = useState(false);
  // Shown by the top bar's "working" signal without pinning it open (cleared by a collapse).
  const [revealed, setRevealed] = useState(false);
  // Tabs render on first view and then stay mounted (hidden), so switching back is instant and the
  // Browser keeps its page; tabs never opened this session cost nothing.
  const [visited, setVisited] = useState<ReadonlySet<DockTabId>>(() => new Set([layout.active]));
  if (!visited.has(layout.active)) setVisited(new Set(visited).add(layout.active));
  const [drag, setDrag] = useState<{ id: DockTabId; to: number; dx: number } | null>(null);
  const tabDrag = useRef<TabDrag | null>(null);
  const suppressClick = useRef(false);
  const tabsRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLElement>(null);
  const resize = useRef<{ pointer: number; startX: number; width: number; current: number; end: () => void } | null>(
    null,
  );
  const baseId = useId().replaceAll(":", "");

  const follows = agents.sections ? railWantsOpen(agents.sections) : false;
  const open = deck.onDashboard
    ? deck.dashboardDockOpen
    : revealed || (layout.collapsed !== null ? !layout.collapsed : follows && deck.wide);
  const active = layout.active;
  const shownWidth = expanded ? Math.max(layout.width, EXPANDED_DOCK_WIDTH) : layout.width;

  const update = useCallback(
    (step: (current: DockLayout) => DockLayout) => {
      setLayout((current) => {
        const next = step(current);
        if (next !== current) saveDockLayout(workspaceId, next);
        return next;
      });
    },
    [workspaceId],
  );
  const change = useCallback(
    (next: DockLayoutChange) => update((current) => applyDockLayout(current, next, available)),
    [available, update],
  );

  const setOpen = useCallback(
    (next: boolean) => {
      if (!next) setExpanded(false);
      if (deck.onDashboard) {
        deck.setDashboardDockOpen(next);
        return;
      }
      setRevealed(false);
      change({ kind: "collapsed", collapsed: !next });
      rememberDefaultCollapsed(!next);
    },
    [change, deck],
  );

  const add = useCallback(
    (id: DockTabId) => {
      setExpanded(false);
      if (deck.onDashboard) deck.setDashboardDockOpen(true);
      update((current) => {
        let next = applyDockLayout(current, { kind: "add", id }, available);
        if (id === "browser" && next.width < BROWSER_START_WIDTH) {
          next = applyDockLayout(next, { kind: "resize", width: BROWSER_START_WIDTH }, available);
        }
        return next;
      });
    },
    [available, deck, update],
  );

  // A tab picked from the rail opens the dock on it.
  const show = useCallback(
    (id: DockTabId) => {
      change({ kind: "activate", id });
      if (!open) setOpen(true);
    },
    [change, open, setOpen],
  );

  const openBrowser = useCallback(
    (url?: string | null) => {
      add("browser");
      if (url) change({ kind: "browser-url", url });
    },
    [add, change],
  );

  const close = useCallback(
    (id: DockTabId) => {
      if (layout.pinned.includes(id) || layout.tabs.length === 1) return;
      if (id === "browser") void bridge.close(layout.browser.browserId).catch(() => undefined);
      change({ kind: "close", id });
    },
    [bridge, change, layout.browser.browserId, layout.pinned, layout.tabs.length],
  );

  /** Moves the dock's Browser — the same native session and page — into a full Code pane. */
  const moveBrowserToCode = useCallback(() => {
    if (!workspaceId) return;
    const content = browserContent(layout.browser.browserId, layout.browser.url);
    update((current) => {
      let next =
        current.tabs.length === 1 ? applyDockLayout(current, { kind: "add", id: "agents" }, available) : current;
      next = { ...next, pinned: next.pinned.filter((id) => id !== "browser") };
      // Closing releases the session id: the dock's next Browser starts its own.
      return applyDockLayout(next, { kind: "close", id: "browser" }, available);
    });
    // The dock's view hides on unmount first; the Code pane then shows the same session.
    requestAnimationFrame(() => {
      void openInPane(content, { workspaceId })
        .then((result) => {
          if (!result.handled && result.message)
            toast.show({ tone: "danger", title: "Browser couldn't move", description: result.message });
        })
        .catch(() =>
          toast.show({ tone: "danger", title: "Browser couldn't move", description: "Open it from Code's + menu." }),
        );
    });
  }, [available, layout.browser.browserId, layout.browser.url, openInPane, toast, update, workspaceId]);

  // The top bar's "N agents working" signal: Agents, shown now, with focus in the dock.
  const lastReveal = useRef(deck.revealRequest);
  useEffect(() => {
    if (deck.revealRequest === lastReveal.current) return;
    lastReveal.current = deck.revealRequest;
    change({ kind: "activate", id: "agents" });
    if (!layout.tabs.includes("agents")) add("agents");
    if (deck.onDashboard) deck.setDashboardDockOpen(true);
    else setRevealed(true);
    requestAnimationFrame(() => dockRef.current?.focus({ preventScroll: true }));
  }, [add, change, deck, layout.tabs]);

  useDockWidthTransition(dockRef, `${open}:${expanded}`);

  // ---- Resize from the left edge: the width follows the pointer on the element itself (no React
  // render per frame); terminals beside it fit once when the drag ends.
  const startResize = (event: PointerEvent<HTMLHRElement>) => {
    if (event.button !== 0 || !event.isPrimary) return;
    const element = dockRef.current;
    if (!element) return;
    event.preventDefault();
    resize.current?.end();
    const width = element.getBoundingClientRect().width;
    resize.current = { pointer: event.pointerId, startX: event.clientX, width, current: width, end: beginLiveResize() };
    element.dataset.resizing = "true";
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveResize = (event: PointerEvent<HTMLHRElement>) => {
    const session = resize.current;
    const element = dockRef.current;
    if (!session || !element || session.pointer !== event.pointerId) return;
    const mainLeft = document.getElementById("main")?.getBoundingClientRect().left ?? 0;
    const room = element.getBoundingClientRect().right - mainLeft - MIN_MAIN_CANVAS;
    const maximum = Math.min(MAX_DOCK_WIDTH, Math.max(MIN_DOCK_WIDTH, room));
    session.current = Math.round(
      Math.max(MIN_DOCK_WIDTH, Math.min(maximum, session.width + session.startX - event.clientX)),
    );
    element.style.setProperty("--workspace-dock-width", `${session.current}px`);
  };
  const endResize = (event: PointerEvent<HTMLHRElement>, keep: boolean) => {
    const session = resize.current;
    if (!session || session.pointer !== event.pointerId) return;
    resize.current = null;
    const element = dockRef.current;
    if (element) delete element.dataset.resizing;
    // The element keeps the final width itself: React writes the style only when its value changes.
    const width = keep ? clampDockWidth(session.current) : shownWidth;
    element?.style.setProperty("--workspace-dock-width", `${width}px`);
    if (keep) {
      setExpanded(false);
      change({ kind: "resize", width });
    }
    requestAnimationFrame(session.end);
  };
  const resizeFromKeyboard = (event: KeyboardEvent<HTMLHRElement>) => {
    if (event.key === "Home") {
      event.preventDefault();
      setExpanded(false);
      change({ kind: "reset-width" });
    } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      setExpanded(false);
      change({ kind: "resize", width: shownWidth + (event.key === "ArrowLeft" ? RESIZE_STEP : -RESIZE_STEP) });
    }
  };

  // ---- Tab reorder: whole-tab pointer drag past a small threshold, an insertion line, a lifted
  // tab that follows the pointer, Escape cancels. Drag state stays inside the dock.
  const insertionIndex = (id: DockTabId, clientX: number): number => {
    const slots = [...(tabsRef.current?.querySelectorAll<HTMLElement>("[data-dock-tab]") ?? [])].filter(
      (slot) => slot.dataset.dockTab !== id,
    );
    let index = 0;
    for (const slot of slots) {
      const rect = slot.getBoundingClientRect();
      if (clientX > rect.left + rect.width / 2) index++;
    }
    return index;
  };
  const tabPointerDown = (event: PointerEvent<HTMLButtonElement>, id: DockTabId) => {
    if (event.button !== 0 || !event.isPrimary) return;
    tabDrag.current = { id, pointerId: event.pointerId, startX: event.clientX, dragging: false, to: 0 };
  };
  const tabPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const session = tabDrag.current;
    if (!session || session.pointerId !== event.pointerId) return;
    const dx = event.clientX - session.startX;
    if (!session.dragging) {
      if (Math.abs(dx) < DRAG_THRESHOLD) return;
      session.dragging = true;
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    session.to = insertionIndex(session.id, event.clientX);
    setDrag({ id: session.id, to: session.to, dx });
  };
  const tabPointerUp = (event: PointerEvent<HTMLButtonElement>) => {
    const session = tabDrag.current;
    if (!session || session.pointerId !== event.pointerId) return;
    tabDrag.current = null;
    if (!session.dragging) return;
    suppressClick.current = true;
    setDrag(null);
    change({ kind: "move", id: session.id, to: session.to });
  };
  const cancelTabDrag = useCallback(() => {
    if (tabDrag.current?.dragging) suppressClick.current = true;
    tabDrag.current = null;
    setDrag(null);
  }, []);
  useEffect(() => {
    if (!drag) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") cancelTabDrag();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [cancelTabDrag, drag]);

  // Where the insertion line shows: before the tab now at that position, or after the last one.
  const others = drag ? layout.tabs.filter((id) => id !== drag.id) : [];
  const dropBefore = drag ? (others[drag.to] ?? null) : null;
  const dropAfter = drag && dropBefore === null ? (others.at(-1) ?? null) : null;

  // ---- Live badges, all from canonical state.
  const sections = agents.sections;
  const workspaceRuns = useMemo(
    () => (operations.data && workspaceId ? filteredSnapshot(operations.data, workspaceId).items : null),
    [operations.data, workspaceId],
  );
  const badgeFor = (id: DockTabId): { count: number; tone: string; detail: string } | null => {
    if (id === "agents" && sections) {
      // The same words as the top bar: "working" counts working agents; others wait on something.
      const working = sections.working.length;
      const waiting = sections.blocked.length;
      const needs = sections.needsYou.length;
      const count = working + waiting + needs;
      if (count === 0)
        return sections.failed.length > 0
          ? { count: sections.failed.length, tone: "failed", detail: `${sections.failed.length} failed` }
          : null;
      const detail = [
        needs > 0 ? `${needs} ${needs === 1 ? "needs" : "need"} you` : "",
        working > 0 ? `${working} working` : "",
        waiting > 0 ? `${waiting} waiting` : "",
      ]
        .filter(Boolean)
        .join(", ");
      return { count, tone: needs > 0 ? "waiting" : "working", detail };
    }
    if (id === "needs-you" && attention.ready && attention.items.length > 0) {
      const n = attention.items.length;
      return { count: n, tone: "waiting", detail: `${n} ${n === 1 ? "needs" : "need"} you` };
    }
    if ((id === "runs" || id === "tests") && workspaceRuns) {
      const running = workspaceRuns.filter(isActiveRun).length;
      if (running > 0) return { count: running, tone: "working", detail: `${running} running` };
      const failed = workspaceRuns.filter((run) => run.status === "failed").length;
      if (failed > 0) return { count: failed, tone: "failed", detail: `${failed} failed` };
    }
    return null;
  };

  const picker = available.filter((id) => !layout.tabs.includes(id));
  const addMenu = (side: "bottom" | "left") => (
    <DropdownMenu>
      <Tooltip content="Add to dock" side={side}>
        <DropdownMenuTrigger asChild>
          <IconButton size="sm" label="Add to dock" icon={<Plus />} />
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent align="end" minWidth={14}>
        <DropdownMenuLabel>Add to dock</DropdownMenuLabel>
        {picker.length === 0 ? (
          <DropdownMenuItem disabled>Everything is in the dock</DropdownMenuItem>
        ) : (
          picker.map((id) => {
            const meta = metaFor(id);
            const Icon = meta.icon;
            return (
              <DropdownMenuItem key={id} icon={<Icon />} onSelect={() => add(id)}>
                {meta.label}
              </DropdownMenuItem>
            );
          })
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const wantsRoom = active === "browser" || active === "dashboard";
  const style = open ? ({ "--workspace-dock-width": `${shownWidth}px` } as CSSProperties) : undefined;
  return (
    <aside
      ref={dockRef}
      id="deck-agents"
      className={styles.dock}
      style={style}
      data-deck-agents
      data-open={open || undefined}
      data-expanded={(open && expanded) || undefined}
      tabIndex={-1}
      aria-label={open ? `Workspace dock, ${metaFor(active).label}` : "Workspace dock (collapsed)"}
    >
      {open ? (
        <>
          <hr
            className={styles.resize}
            aria-label="Resize workspace dock"
            aria-orientation="vertical"
            aria-valuemin={MIN_DOCK_WIDTH}
            aria-valuemax={MAX_DOCK_WIDTH}
            aria-valuenow={shownWidth}
            tabIndex={0}
            onPointerDown={startResize}
            onPointerMove={moveResize}
            onPointerUp={(event) => endResize(event, true)}
            onPointerCancel={(event) => endResize(event, false)}
            onDoubleClick={() => {
              setExpanded(false);
              change({ kind: "reset-width" });
            }}
            onKeyDown={resizeFromKeyboard}
          />
          <div className={styles.header}>
            <div ref={tabsRef} className={styles.tabs} role="tablist" aria-label="Dock views">
              {layout.tabs.map((id, index) => {
                const meta = metaFor(id);
                const Icon = meta.icon;
                const selected = active === id;
                const pinned = layout.pinned.includes(id);
                const closable = !pinned && layout.tabs.length > 1;
                const badge = badgeFor(id);
                const menu: ObjectMenuItem[] = [
                  ...(index > 0
                    ? [
                        {
                          id: "left",
                          label: "Move left",
                          icon: <ArrowLeft />,
                          onSelect: () => change({ kind: "move", id, to: index - 1 }),
                        },
                      ]
                    : []),
                  ...(index < layout.tabs.length - 1
                    ? [
                        {
                          id: "right",
                          label: "Move right",
                          icon: <ArrowRight />,
                          onSelect: () => change({ kind: "move", id, to: index + 1 }),
                        },
                      ]
                    : []),
                  {
                    id: "pin",
                    label: pinned ? "Unpin" : "Pin",
                    icon: pinned ? <PinOff /> : <Pin />,
                    onSelect: () => change({ kind: "pin", id, pinned: !pinned }),
                  },
                  {
                    id: "expand",
                    label: expanded ? "Restore width" : "Expand",
                    icon: expanded ? <Minimize2 /> : <Maximize2 />,
                    onSelect: () => {
                      change({ kind: "activate", id });
                      setExpanded((value) => !value);
                    },
                  },
                  ...(id === "browser" && workspaceId
                    ? [
                        {
                          id: "to-code",
                          label: "Move to a Code pane",
                          icon: <PanelsTopLeft />,
                          onSelect: moveBrowserToCode,
                        },
                      ]
                    : []),
                  ...(layout.width !== DEFAULT_DOCK_WIDTH || expanded
                    ? [
                        {
                          id: "reset",
                          label: "Reset size",
                          icon: <RotateCcw />,
                          onSelect: () => {
                            setExpanded(false);
                            change({ kind: "reset-width" });
                          },
                        },
                      ]
                    : []),
                  ...(closable
                    ? [
                        { id: "separator", separator: true } as const,
                        { id: "close", label: "Close", icon: <X />, onSelect: () => close(id) },
                      ]
                    : []),
                ];
                const dragging = drag?.id === id;
                return (
                  <div
                    key={id}
                    className={styles.tabSlot}
                    data-dock-tab={id}
                    data-dragging={dragging || undefined}
                    data-drop={dropBefore === id ? "before" : dropAfter === id ? "after" : undefined}
                    style={dragging ? ({ "--drag-x": `${drag.dx}px` } as CSSProperties) : undefined}
                  >
                    <ObjectContextMenu label={`${meta.label} tab`} items={menu}>
                      <button
                        type="button"
                        role="tab"
                        id={`${baseId}-${id}-tab`}
                        aria-controls={`${baseId}-${id}-panel`}
                        aria-selected={selected}
                        aria-label={`${meta.label}${badge ? `, ${badge.detail}` : ""}${pinned ? ", pinned" : ""}`}
                        tabIndex={selected ? 0 : -1}
                        className={styles.tab}
                        data-closable={closable || undefined}
                        onPointerDown={(event) => tabPointerDown(event, id)}
                        onPointerMove={tabPointerMove}
                        onPointerUp={tabPointerUp}
                        onPointerCancel={cancelTabDrag}
                        onClick={() => {
                          if (suppressClick.current) {
                            suppressClick.current = false;
                            return;
                          }
                          change({ kind: "activate", id });
                        }}
                        onKeyDown={(event) => {
                          const step = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
                          if (step === 0) return;
                          event.preventDefault();
                          if (event.altKey) {
                            change({ kind: "move", id, to: index + step });
                            requestAnimationFrame(() => document.getElementById(`${baseId}-${id}-tab`)?.focus());
                            return;
                          }
                          const next = layout.tabs[(index + step + layout.tabs.length) % layout.tabs.length];
                          if (!next) return;
                          change({ kind: "activate", id: next });
                          requestAnimationFrame(() => document.getElementById(`${baseId}-${next}-tab`)?.focus());
                        }}
                      >
                        <Icon aria-hidden="true" />
                        <span className={styles.tabLabel}>{meta.label}</span>
                        {badge ? (
                          <span className={styles.tabCount} data-tone={badge.tone} aria-hidden="true">
                            {badge.count > 99 ? "99+" : badge.count}
                          </span>
                        ) : null}
                        {pinned ? <Pin className={styles.pin} aria-hidden="true" /> : null}
                      </button>
                    </ObjectContextMenu>
                    {closable ? (
                      <button
                        type="button"
                        className={styles.close}
                        aria-label={`Close ${meta.label}`}
                        tabIndex={-1}
                        onClick={() => close(id)}
                      >
                        <X aria-hidden="true" />
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </div>
            <div className={styles.headerActions}>
              {addMenu("bottom")}
              {wantsRoom ? (
                <Tooltip content={expanded ? "Restore width" : "Expand"} side="bottom">
                  <IconButton
                    size="sm"
                    label={expanded ? "Restore dock width" : "Expand dock"}
                    icon={expanded ? <Minimize2 /> : <Maximize2 />}
                    onClick={() => setExpanded((value) => !value)}
                  />
                </Tooltip>
              ) : null}
              <Tooltip content="Collapse dock" side="bottom">
                <IconButton size="sm" label="Collapse dock" icon={<PanelRightClose />} onClick={() => setOpen(false)} />
              </Tooltip>
            </div>
          </div>
        </>
      ) : (
        <div className={styles.rail}>
          <Tooltip content="Show dock" side="left">
            <IconButton size="sm" label="Show dock" icon={<PanelRightOpen />} onClick={() => setOpen(true)} />
          </Tooltip>
          <fieldset className={styles.railTabs} aria-label="Dock views">
            {layout.tabs.map((id) => {
              const meta = metaFor(id);
              const Icon = meta.icon;
              const badge = badgeFor(id);
              return (
                <Tooltip key={id} content={badge ? `${meta.label} · ${badge.detail}` : meta.label} side="left">
                  <button
                    type="button"
                    className={styles.railTab}
                    data-active={active === id || undefined}
                    aria-label={`${meta.label}${badge ? `, ${badge.detail}` : ""}`}
                    onClick={() => show(id)}
                  >
                    <Icon aria-hidden="true" />
                    {badge ? (
                      <span className={styles.badge} data-tone={badge.tone} aria-hidden="true">
                        {badge.count > 99 ? "99+" : badge.count}
                      </span>
                    ) : null}
                  </button>
                </Tooltip>
              );
            })}
          </fieldset>
          {addMenu("left")}
        </div>
      )}
      <div className={styles.panels} hidden={!open}>
        {layout.tabs.map((id) => {
          if (!visited.has(id)) return null;
          const selected = active === id;
          const shown = open && selected;
          return (
            <section
              key={id === "browser" ? `browser:${layout.browser.browserId}` : id}
              id={`${baseId}-${id}-panel`}
              role="tabpanel"
              aria-labelledby={`${baseId}-${id}-tab`}
              className={styles.panel}
              data-surface={id}
              hidden={!shown}
            >
              {id === "agents" ? (
                <AgentsView agents={agents} />
              ) : id === "browser" && workspaceId ? (
                <BrowserPane
                  content={{ kind: "browser", browserId: layout.browser.browserId, url: layout.browser.url }}
                  workspaceId={workspaceId}
                  context={{
                    paneId: `workspace-dock-${layout.browser.browserId}`,
                    tabId: `${baseId}-browser-tab`,
                    focused: shown,
                    visible: shown,
                    focusRequest: 0,
                  }}
                  bridge={bridge}
                  visible={shown}
                  onRequestFocus={() => change({ kind: "activate", id: "browser" })}
                  onUrlChange={(url) => change({ kind: "browser-url", url })}
                />
              ) : id !== "browser" ? (
                <DockSurface id={id as DockSurfaceId} workspaceId={workspaceId} onOpenBrowser={openBrowser} />
              ) : null}
            </section>
          );
        })}
      </div>
    </aside>
  );
}

/**
 * The dock's width eases between its rail and its full width. Terminals beside it fit once when
 * the change settles (the pane divider's live-resize path) instead of re-flowing every frame.
 */
function useDockWidthTransition(dock: { current: HTMLElement | null }, shape: string) {
  const first = useRef(true);
  useEffect(() => {
    void shape;
    if (first.current) {
      first.current = false;
      return;
    }
    const element = dock.current;
    if (!element) return;
    const end = beginLiveResize();
    const finish = (event?: TransitionEvent) => {
      if (event && (event.target !== element || event.propertyName !== "width")) return;
      end();
    };
    element.addEventListener("transitionend", finish);
    // Reduced motion (no transition) or an interrupted one still ends the live resize.
    const timer = window.setTimeout(() => finish(), 400);
    return () => {
      element.removeEventListener("transitionend", finish);
      window.clearTimeout(timer);
      end();
    };
  }, [dock, shape]);
}
