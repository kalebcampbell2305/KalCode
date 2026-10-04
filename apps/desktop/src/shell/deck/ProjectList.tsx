/** Compact Projects view over canonical workspaces and the native rail's persistent pins. */
import type { ThreadSummary } from "@kalcode/protocol";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
  Tooltip,
} from "@kalcode/ui/components";
import { ArrowDown, ArrowUp, ChevronRight, FolderOpen, FolderX, MoreHorizontal, Pin, PinOff } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useWorkspaces } from "../../runtime/WorkspaceProvider.tsx";
import { useCodingAgents } from "../../surfaces/dashboard/data/DashboardData.tsx";
import { STATUS_META } from "../../surfaces/dashboard/data/status.ts";
import { useNavigation } from "../navigation.tsx";
import { useRail } from "../rail/RailProvider.tsx";
import { useDeckUi } from "./DeckUi.tsx";
import styles from "./ProjectList.module.css";

interface Counts {
  working: number;
  needsYou: number;
}
function countsByWorkspace(threads: readonly ThreadSummary[]): Map<string, Counts> {
  const map = new Map<string, Counts>();
  for (const thread of threads) {
    if (thread.archivedAt !== null) continue;
    const group = STATUS_META[thread.status].group;
    if (group !== "working" && group !== "attention") continue;
    const counts = map.get(thread.workspaceId) ?? { working: 0, needsYou: 0 };
    if (group === "working") counts.working += 1;
    else counts.needsYou += 1;
    map.set(thread.workspaceId, counts);
  }
  return map;
}

export function ProjectList({ collapsed }: { collapsed: boolean }) {
  const { workspaces, active, activate, openFolder, remove, state: loadState } = useWorkspaces();
  const { state } = useCodingAgents();
  const { navigate } = useNavigation();
  const pins = useRail();
  const { projectsCollapsed, setProjectsCollapsed } = useDeckUi();
  const id = useId();
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ id: string; over: string | null } | null>(null);
  const gesture = useRef<{
    id: string;
    pointer: number;
    x: number;
    y: number;
    active: boolean;
    cancelled: boolean;
  } | null>(null);
  const suppressClick = useRef(false);
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const cancel = () => {
      if (gesture.current) gesture.current.cancelled = true;
      setDrag(null);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancel();
    };
    window.addEventListener("keydown", key);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("blur", cancel);
    };
  }, []);
  const counts = useMemo(() => (state.status === "ready" ? countsByWorkspace(state.data) : new Map()), [state]);
  const pinned = pins.rail?.pinned ?? [];
  const ordered = useMemo(() => {
    const byId = new Map(workspaces.map((w) => [w.id, w]));
    const pinnedIds = new Set(pinned.map((e) => e.workspaceId));
    return [
      ...pinned.map((e) => ({
        id: e.workspaceId,
        name: byId.get(e.workspaceId)?.name ?? e.folderName,
        available: byId.get(e.workspaceId)?.available ?? e.available,
        displayPath: e.displayPath,
        pinned: true,
      })),
      ...workspaces
        .filter((w) => !pinnedIds.has(w.id))
        .sort((a, b) => Date.parse(b.lastOpenedAt) - Date.parse(a.lastOpenedAt))
        .map((w) => ({ ...w, pinned: false })),
    ];
  }, [workspaces, pinned]);
  const choose = (workspaceId: string) =>
    void activate(workspaceId).then((ok) => {
      if (ok) navigate("code");
    });
  const open = () =>
    void openFolder().then((workspace) => {
      if (workspace) navigate("code");
    });
  const canPin = pins.state === "ready" && pins.rail?.persistent === true;
  // The narrow sidebar still offers the same section toggle, independently of sidebar width.
  const toggle = (
    <button
      type="button"
      className={collapsed ? styles.tile : styles.toggle}
      aria-label={collapsed ? "Projects" : undefined}
      aria-expanded={!projectsCollapsed}
      aria-controls={`${id}-list`}
      onClick={() => setProjectsCollapsed(!projectsCollapsed)}
    >
      {collapsed ? (
        <FolderOpen aria-hidden="true" />
      ) : (
        <>
          <span>Projects</span>
          <ChevronRight className={styles.chevron} aria-hidden="true" />
        </>
      )}
    </button>
  );
  return (
    <section className={styles.projects} aria-label="Projects" data-section-collapsed={projectsCollapsed || undefined}>
      <div className={styles.header} data-narrow={collapsed || undefined}>
        <h2 className={styles.heading}>
          {collapsed ? (
            <Tooltip content="Projects" side="right">
              {toggle}
            </Tooltip>
          ) : (
            toggle
          )}
        </h2>
        {collapsed ? null : (
          <Tooltip content="Open a project folder">
            <IconButton size="sm" label="Open a project folder" icon={<FolderOpen />} onClick={open} />
          </Tooltip>
        )}
      </div>
      <div id={`${id}-list`} className={styles.body} hidden={projectsCollapsed}>
        {pins.state === "error" ? (
          <button type="button" className={styles.notice} onClick={() => void pins.refresh()}>
            Couldn't load pins. Retry
          </button>
        ) : null}
        {pins.rail && !pins.rail.persistent ? (
          <p className={styles.notice}>Project pins are unavailable in this runtime.</p>
        ) : null}
        {ordered.length === 0 && loadState !== "loading" ? (
          <button
            type="button"
            className={collapsed ? styles.tile : styles.emptyRow}
            onClick={open}
            aria-label="Open a project folder"
          >
            <FolderOpen aria-hidden="true" />
            {collapsed ? null : "Open a project folder"}
          </button>
        ) : (
          <ul className={styles.list} ref={list}>
            {ordered.map((workspace, index) => {
              const c: Counts = counts.get(workspace.id) ?? { working: 0, needsYou: 0 };
              const status = [
                workspace.pinned ? "pinned" : null,
                c.working > 0 ? `${c.working} working` : null,
                c.needsYou > 0 ? `${c.needsYou} ${c.needsYou === 1 ? "needs" : "need"} you` : null,
                workspace.available ? null : "unavailable, folder not found",
              ]
                .filter(Boolean)
                .join(", ");
              const label = status ? `${workspace.name}, ${status}` : workspace.name;
              // A missing folder can't be fixed from here; removing it keeps the list honest.
              const missing = workspace.available ? undefined : workspaces.find((w) => w.id === workspace.id);
              return (
                <li
                  key={workspace.id}
                  className={styles.project}
                  data-project-id={workspace.id}
                  data-pinned={workspace.pinned || undefined}
                  data-dragging={drag?.id === workspace.id || undefined}
                  data-drop={
                    drag?.over === workspace.id && drag.id !== workspace.id
                      ? pinned.findIndex((p) => p.workspaceId === drag.id) < index
                        ? "after"
                        : "before"
                      : undefined
                  }
                >
                  <Tooltip
                    hidden={menuFor !== null || drag !== null}
                    content={workspace.available ? workspace.displayPath : "Unavailable — folder not found"}
                    side="right"
                  >
                    <button
                      type="button"
                      className={collapsed ? styles.tile : styles.row}
                      aria-current={workspace.id === active?.id ? "true" : undefined}
                      aria-label={label}
                      data-unavailable={!workspace.available || undefined}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setMenuFor(workspace.id);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
                          e.preventDefault();
                          setMenuFor(workspace.id);
                        }
                      }}
                      onPointerDown={(e) => {
                        suppressClick.current = false;
                        if (!workspace.pinned || !canPin || e.button !== 0 || !e.isPrimary) return;
                        gesture.current = {
                          id: workspace.id,
                          pointer: e.pointerId,
                          x: e.clientX,
                          y: e.clientY,
                          active: false,
                          cancelled: false,
                        };
                        e.currentTarget.setPointerCapture(e.pointerId);
                      }}
                      onPointerMove={(e) => {
                        const g = gesture.current;
                        if (!g || g.pointer !== e.pointerId || g.cancelled) return;
                        if (!g.active && Math.hypot(e.clientX - g.x, e.clientY - g.y) < 6) return;
                        g.active = true;
                        const hit = document
                          .elementFromPoint(e.clientX, e.clientY)
                          ?.closest<HTMLElement>("[data-project-id][data-pinned]");
                        setDrag({
                          id: g.id,
                          over: hit && list.current?.contains(hit) ? (hit.dataset.projectId ?? null) : null,
                        });
                        // Scroll only this list, so long pin lists remain reorderable.
                        const bounds = list.current?.getBoundingClientRect();
                        if (bounds && list.current) {
                          if (e.clientY < bounds.top + 24) list.current.scrollTop -= 12;
                          else if (e.clientY > bounds.bottom - 24) list.current.scrollTop += 12;
                        }
                      }}
                      onPointerUp={(e) => {
                        const g = gesture.current;
                        if (!g || g.pointer !== e.pointerId) return;
                        suppressClick.current = g.active;
                        if (g.active && !g.cancelled && drag?.over && drag.over !== g.id) {
                          const position = pinned.findIndex((p) => p.workspaceId === drag.over);
                          if (position >= 0) void pins.pinProject(g.id, position);
                        }
                        gesture.current = null;
                        setDrag(null);
                      }}
                      onLostPointerCapture={() => {
                        gesture.current = null;
                        setDrag(null);
                      }}
                      onPointerCancel={() => {
                        gesture.current = null;
                        setDrag(null);
                      }}
                      onClick={() => {
                        if (suppressClick.current) {
                          suppressClick.current = false;
                          return;
                        }
                        // An unavailable project can't open; its menu offers what can be done.
                        if (workspace.available) choose(workspace.id);
                        else setMenuFor(workspace.id);
                      }}
                    >
                      {/* A narrow tile keeps the project's initial (pinned tiles would all look alike)
                          and marks the pin with a small badge. */}
                      <span
                        className={styles.initial}
                        data-pin={(workspace.pinned && !collapsed) || undefined}
                        aria-hidden="true"
                      >
                        {workspace.pinned && !collapsed ? (
                          <Pin />
                        ) : (
                          workspace.name.trim().charAt(0).toUpperCase() || "·"
                        )}
                      </span>
                      {collapsed && workspace.pinned ? (
                        <span className={styles.tilePin} aria-hidden="true">
                          <Pin />
                        </span>
                      ) : null}
                      {collapsed ? (
                        c.needsYou > 0 || c.working > 0 ? (
                          <span
                            className={styles.tileDot}
                            data-tone={c.needsYou > 0 ? "waiting" : "working"}
                            aria-hidden="true"
                          />
                        ) : null
                      ) : (
                        <>
                          <span className={styles.name}>
                            {workspace.name}
                            {workspace.available ? null : <span className={styles.unavailable}>Unavailable</span>}
                          </span>
                          <span className={styles.signals} aria-hidden="true">
                            {c.working > 0 ? (
                              <span className={styles.working}>
                                <span className={styles.workingDot} />
                                {c.working}
                              </span>
                            ) : null}
                            {c.needsYou > 0 ? <span className={styles.needs}>{c.needsYou}</span> : null}
                          </span>
                        </>
                      )}
                    </button>
                  </Tooltip>
                  <DropdownMenu
                    open={menuFor === workspace.id}
                    onOpenChange={(show) => setMenuFor(show ? workspace.id : null)}
                  >
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        className={styles.menuButton}
                        aria-label={`Project options for ${workspace.name}`}
                        data-open={menuFor === workspace.id || undefined}
                      >
                        <MoreHorizontal aria-hidden="true" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent side="right" align="start" aria-label={`${workspace.name} project options`}>
                      <DropdownMenuItem
                        icon={workspace.pinned ? <PinOff /> : <Pin />}
                        disabled={!canPin}
                        onSelect={() => void pins.pinProject(workspace.id, !workspace.pinned)}
                      >
                        {workspace.pinned ? "Unpin Project" : "Pin Project"}
                      </DropdownMenuItem>
                      {workspace.pinned ? (
                        <>
                          <DropdownMenuItem
                            icon={<ArrowUp />}
                            disabled={!canPin || index === 0}
                            onSelect={() => void pins.pinProject(workspace.id, index - 1)}
                          >
                            Move pin up
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            icon={<ArrowDown />}
                            disabled={!canPin || index === pinned.length - 1}
                            onSelect={() => void pins.pinProject(workspace.id, index + 1)}
                          >
                            Move pin down
                          </DropdownMenuItem>
                        </>
                      ) : null}
                      {missing ? (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            icon={<FolderX />}
                            description="The folder isn't changed."
                            onSelect={() => void remove(missing)}
                          >
                            Remove from KalCode
                          </DropdownMenuItem>
                        </>
                      ) : null}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
