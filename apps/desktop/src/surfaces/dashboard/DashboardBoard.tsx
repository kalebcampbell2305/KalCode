import type { ApprovalView, ThreadSummary, ThreadWorktreeState } from "@kalcode/protocol";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  ErrorState,
  IconButton,
  ProviderMark,
  SegmentedControl,
  Skeleton,
  TextInput,
} from "@kalcode/ui/components";
import {
  Archive,
  BroomSparkles,
  ChevronDown,
  CircleX,
  Layers,
  ListX,
  Power,
  Rocket,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useOptionalUiIntents } from "../../runtime/uiIntents.tsx";
import { useNavigation } from "../../shell/navigation.tsx";
import { CodingAgentContextMenu } from "../code/CodingAgentContextMenu.tsx";
import { useKalTidy } from "../code/kaltidy/kalTidyContext.ts";
import { useProviderPanesEnabled } from "../code/panes/useProviderPanes.ts";
import { useLaunchAgent } from "../code/useLaunchAgent.ts";
import { usePermissions } from "../permissions/PermissionsProvider.tsx";
import { AgentCard } from "./AgentCard.tsx";
import styles from "./DashboardBoard.module.css";
import {
  FLEET_FILTER_LABELS,
  FLEET_FILTERS,
  FLEET_GROUPS,
  type FleetCounts,
  type FleetFilter,
  filterThreads,
  fleetCounts,
  fleetSummaryLine,
  GROUP_MODE_LABELS,
  GROUP_MODES,
  type GroupMode,
  groupThreads,
  type ThreadGroup,
} from "./data/board.ts";
import { useAgentWorktreeStates, useArchivedCodingAgents, useCodingAgents } from "./data/DashboardData.tsx";
import { canDismiss, useAgentCleanup } from "./fleet/agentCleanup.ts";
import { isFolded, useFleetLayout } from "./fleet/fleetLayout.ts";
import { type MergeReadiness, mergeReadiness } from "./fleet/fleetModel.ts";
import { morphIntoAgent } from "./fleet/morph.ts";
import { useAgentOverlaps } from "./fleet/useAgentOverlaps.ts";
import { useVirtualRows } from "./useVirtualRows.ts";

/** Card sizing: a card never gets narrower than this; wider boards get more columns. */
const CARD_MIN_PX = 284;
const CARD_GAP_PX = 10;
const GROUP_KEY = "kalcode.dashboard.groupBy";
/** The archived view lists the newest this many at a time (hundreds stay usable). */
const ARCHIVED_PAGE = 48;

const EMPTY_FILTER_TEXT: Record<FleetFilter, string> = {
  all: "No agents match.",
  needs_you: "Nothing needs you right now.",
  working: "No agents are working right now.",
  waiting: "No agents are waiting on another task.",
  done: "Nothing has finished yet.",
  idle: "No idle agents.",
  failed: "No failed agents.",
};

const FILTER_ANNOUNCE: Record<FleetFilter, (n: number) => string> = {
  all: (n) => `Showing all ${n} ${n === 1 ? "agent" : "agents"}.`,
  needs_you: (n) => (n === 0 ? "Nothing needs you." : `Showing ${n} that need you.`),
  working: (n) => (n === 0 ? "No agents are working." : `Showing ${n} working.`),
  waiting: (n) => (n === 0 ? "No agents are waiting." : `Showing ${n} waiting.`),
  done: (n) => (n === 0 ? "Nothing has finished." : `Showing ${n} done.`),
  idle: (n) => (n === 0 ? "No idle agents." : `Showing ${n} idle.`),
  failed: (n) => (n === 0 ? "No failed agents." : `Showing ${n} failed.`),
};

function readGroupMode(): GroupMode {
  try {
    const value = localStorage.getItem(GROUP_KEY);
    return GROUP_MODES.includes(value as GroupMode) ? (value as GroupMode) : "status";
  } catch {
    return "status";
  }
}

type BoardRow =
  | { kind: "header"; key: string; group: ThreadGroup; collapsed: boolean }
  | { kind: "cards"; key: string; group: ThreadGroup; threads: ThreadSummary[] };

function useColumns(): [(el: HTMLElement | null) => void, number] {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [columns, setColumns] = useState(3);
  useEffect(() => {
    if (!el) return;
    const measure = () => {
      const width = el.clientWidth;
      if (width <= 0) return;
      setColumns(Math.max(1, Math.floor((width + CARD_GAP_PX) / (CARD_MIN_PX + CARD_GAP_PX))));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  return [setEl, columns];
}

export interface DashboardBoardProps {
  /** Rendered in a pane (Z7-W1): shows its own one-line summary instead of the page header's. */
  inPane?: boolean;
}

/**
 * Agent Fleet: the live command surface for coding agents (any provider's coding terminal in a
 * Code pane; chat threads stay in Threads). A summary with a status bar, the shared agent-state
 * filters with real counts across every provider (All, Needs you, Working, Waiting, Idle, Done,
 * Failed), an optional provider filter, instant search, grouping, cleanup
 * and a virtualized grid of compact cards that gains columns on wide windows. A card opens its
 * agent's terminal in Code; nothing here duplicates a terminal.
 */
export function DashboardBoard({ inPane = false }: DashboardBoardProps) {
  const { state, reload, pendingActions, runAction } = useCodingAgents();
  const archivedThreads = useArchivedCodingAgents();
  const permissions = usePermissions();
  const intents = useOptionalUiIntents();
  const launchAgent = useLaunchAgent();
  const kalTidy = useKalTidy();
  const cleanup = useAgentCleanup();
  const { navigate } = useNavigation();
  // Provider panes are how a coding agent runs: a real CLI in a Code terminal pane.
  const providerPanes = useProviderPanesEnabled();
  const [showArchived, setShowArchived] = useState(false);
  const [archivedShown, setArchivedShown] = useState(ARCHIVED_PAGE);
  const [confirmCloseAll, setConfirmCloseAll] = useState(false);
  const archivedId = useId();
  const { layout, setFolded, toggleCard } = useFleetLayout();
  const expanded = useMemo(() => new Set(layout.expanded), [layout.expanded]);

  const [filter, setFilter] = useState<FleetFilter>("all");
  // A provider narrows the list separately; the status filters stay global across providers.
  const [providerFilter, setProviderFilter] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [groupMode, setGroupModeState] = useState<GroupMode>(readGroupMode);
  const [announcement, setAnnouncement] = useState<{ id: number; text: string } | null>(null);
  const announceSeq = useRef(0);
  const chipsRef = useRef<HTMLDivElement>(null);
  const closeAllRef = useRef<HTMLButtonElement>(null);
  const cleanupRef = useRef<HTMLButtonElement>(null);

  const allThreads = state.status === "ready" ? state.data : null;
  // Every provider that has an agent here, for the provider filter (name from the agent itself).
  const providers = useMemo(() => {
    const byId = new Map<string, string>();
    for (const t of allThreads ?? [])
      if (!byId.has(t.providerId)) byId.set(t.providerId, t.providerName || t.providerId);
    return [...byId].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [allThreads]);
  const activeProvider =
    providerFilter !== null && providers.some((p) => p.id === providerFilter) ? providerFilter : null;
  const threads = useMemo(
    () => (allThreads && activeProvider ? allThreads.filter((t) => t.providerId === activeProvider) : allThreads),
    [allThreads, activeProvider],
  );
  const counts: FleetCounts = useMemo(() => fleetCounts(threads ?? []), [threads]);
  const archived = archivedThreads.state.status === "ready" ? archivedThreads.state.data : NO_THREADS;
  // Nothing left to show once the last archived session is restored: close the archived view.
  useEffect(() => {
    if (archived.length === 0) setShowArchived(false);
  }, [archived.length]);
  useEffect(() => {
    if (confirmCloseAll) closeAllRef.current?.focus();
  }, [confirmCloseAll]);

  const announce = useCallback((text: string) => {
    announceSeq.current += 1;
    setAnnouncement({ id: announceSeq.current, text });
  }, []);

  const selectFilter = useCallback(
    (next: FleetFilter, fromIntent = false, shown: FleetCounts = counts) => {
      setFilter(next);
      if (fromIntent) setQuery("");
      announce(FILTER_ANNOUNCE[next](shown[next]));
    },
    [announce, counts],
  );

  const selectProvider = useCallback(
    (providerId: string | null) => {
      setProviderFilter(providerId);
      const shown = (allThreads ?? []).filter((t) => providerId === null || t.providerId === providerId);
      const name = providers.find((p) => p.id === providerId)?.name;
      announce(name ? `Showing ${name} agents: ${shown.length}.` : `Showing agents from every provider.`);
    },
    [allThreads, providers, announce],
  );

  // KalVoice ("Show only agents that are working") and notifications set the filter.
  const request = intents?.dashboardFilter ?? null;
  const handledRequest = useRef(request?.nonce ?? 0);
  useEffect(() => {
    if (!request || request.nonce === handledRequest.current || !allThreads) return;
    handledRequest.current = request.nonce;
    const next = request.filter;
    setProviderFilter(request.providerId);
    const shown = request.providerId ? allThreads.filter((t) => t.providerId === request.providerId) : allThreads;
    selectFilter(next, true, fleetCounts(shown));
    chipsRef.current?.querySelector<HTMLElement>(`[data-chip="${next}"]`)?.focus({ preventScroll: true });
  }, [request, allThreads, selectFilter]);

  const setGroupMode = (mode: GroupMode) => {
    setGroupModeState(mode);
    try {
      localStorage.setItem(GROUP_KEY, mode);
    } catch {
      // Remembering the grouping is a convenience.
    }
  };

  const groups = useMemo(
    () => (threads ? groupThreads(filterThreads(threads, filter, query), groupMode) : []),
    [threads, filter, query, groupMode],
  );

  const approvalsByThread = useMemo(() => {
    const map = new Map<string, ApprovalView[]>();
    for (const request of [...permissions.pending].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      const id = request.action.threadId;
      if (!id) continue;
      const list = map.get(id) ?? [];
      list.push(request);
      map.set(id, list);
    }
    return map;
  }, [permissions.pending]);

  // An agent always opens in Code (its terminal pane), never Threads: the explicit agent intent
  // can't fall back to a chat view even when a metadata read fails.
  const onFocus = useCallback(
    (thread: ThreadSummary) => {
      const card = document.querySelector<HTMLElement>(`[data-thread-id="${CSS.escape(thread.id)}"]`);
      morphIntoAgent(card, thread.id, () => {
        if (intents) return intents.focus({ kind: "agent", agentId: thread.id, workspaceId: thread.workspaceId });
        flushSync(() => {
          navigate("code");
        });
      });
    },
    [intents, navigate],
  );

  const { states: worktrees, apply: applyWorktree } = useAgentWorktreeStates();
  const overlaps = useAgentOverlaps().byAgent;
  const onReviewApprovals = useCallback(() => permissions.setPanelOpen(true), [permissions.setPanelOpen]);
  const onDismiss = useCallback((thread: ThreadSummary) => void cleanup.dismissAgent(thread.id), [cleanup]);

  const [measureRef, columns] = useColumns();

  const rows = useMemo(() => {
    const list: BoardRow[] = [];
    for (const group of groups) {
      // A filter or search shows what it found: only the board's own view folds groups.
      const isCollapsed =
        filter === "all" && !query.trim() && isFolded(layout, `${group.mode}:${group.key}`, group.threads.length);
      list.push({ kind: "header", key: `h:${group.mode}:${group.key}`, group, collapsed: isCollapsed });
      if (isCollapsed) continue;
      for (let i = 0; i < group.threads.length; i += columns) {
        list.push({
          kind: "cards",
          key: `c:${group.mode}:${group.key}:${i / columns}:${columns}`,
          group,
          threads: group.threads.slice(i, i + columns),
        });
      }
    }
    return list;
  }, [groups, columns, layout, filter, query]);

  const getKey = useCallback((index: number) => rows[index]?.key ?? String(index), [rows]);
  const estimate = useCallback(
    (index: number) => {
      const row = rows[index];
      if (!row || row.kind === "header") return 44;
      const tallest = row.threads.reduce((max, t) => {
        const extra =
          (t.status === "waiting_for_permission" && approvalsByThread.has(t.id)
            ? 150
            : t.status === "failed" || t.status === "waiting_for_user"
              ? 18
              : 0) + (expanded.has(t.id) ? 150 : 0);
        return Math.max(max, extra);
      }, 0);
      return 158 + tallest + CARD_GAP_PX;
    },
    [rows, approvalsByThread, expanded],
  );
  const virtual = useVirtualRows({ count: rows.length, getKey, estimate });

  const toggleGroup = (group: ThreadGroup, collapsed: boolean) => setFolded(`${group.mode}:${group.key}`, !collapsed);

  const groupAction = (group: ThreadGroup) => {
    if (group.mode !== "status") return null;
    if (group.status === "failed" && cleanup.counts.failed > 0)
      return { label: "Clear failed", run: cleanup.clearFailed, icon: <CircleX /> };
    if (group.status === "done" && cleanup.counts.finished > 0)
      return { label: "Clear finished", run: cleanup.clearFinished, icon: <ListX /> };
    if (group.status === "idle" && cleanup.counts.idle > 0)
      return { label: "Close idle", run: cleanup.closeIdle, icon: <Power /> };
    return null;
  };

  const renderRow = (row: BoardRow) =>
    row.kind === "header" ? (
      <GroupHeader
        group={row.group}
        collapsed={row.collapsed}
        onToggle={() => toggleGroup(row.group, row.collapsed)}
        action={groupAction(row.group)}
      />
    ) : (
      <div className={styles.cardRow} style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
        {row.threads.map((thread) => (
          <CodingAgentContextMenu key={thread.id} thread={thread}>
            <div tabIndex={-1} style={{ minWidth: 0 }}>
              <AgentCard
                thread={thread}
                approvals={approvalsByThread.get(thread.id) ?? NO_APPROVALS}
                pendingAction={pendingActions.get(thread.id)}
                onFocus={onFocus}
                onAction={runAction}
                onDecide={permissions.decide}
                onReviewApprovals={onReviewApprovals}
                worktree={worktrees.get(thread.id)}
                readiness={thread.worktreeId ? readinessOf(thread, worktrees.get(thread.id)) : undefined}
                onCommitted={applyWorktree}
                expanded={expanded.has(thread.id)}
                onToggleExpanded={toggleCard}
                onDismiss={canDismiss(thread) ? onDismiss : undefined}
                overlaps={overlaps.get(thread.id)}
              />
            </div>
          </CodingAgentContextMenu>
        ))}
      </div>
    );

  let body: React.ReactNode;
  if (state.status === "unavailable") {
    body = (
      <EmptyState title="Agents arrive with provider support" className={styles.state}>
        <p>
          When coding agents run in your projects, each one appears here with its provider, model, what it is doing now
          and its status. This build doesn't run threads yet, so there's nothing to show.
        </p>
      </EmptyState>
    );
  } else if (state.status === "loading") {
    body = (
      <div className={styles.skeleton} role="status" aria-busy="true">
        <span className="visually-hidden">Loading agents</span>
        {[0, 1, 2].map((i) => (
          <div key={i} className={styles.skeletonCard}>
            <Skeleton width="45%" />
            <Skeleton width={`${70 - i * 10}%`} height="0.9375rem" />
            <Skeleton width="80%" />
            <Skeleton width="30%" />
          </div>
        ))}
      </div>
    );
  } else if (state.status === "error") {
    body = (
      <ErrorState
        title="Agents couldn't load"
        code={`${state.error.category}/${state.error.code}`}
        actions={<Button onClick={reload}>Try again</Button>}
        className={styles.state}
      >
        <p>{state.error.message} Your agents keep running; this only affects what the Dashboard shows.</p>
      </ErrorState>
    );
  } else if (counts.all === 0) {
    const newAgent = providerPanes ? (
      <Button variant="primary" onClick={launchAgent}>
        Launch an agent
      </Button>
    ) : null;
    body =
      archived.length > 0 ? (
        <EmptyState
          title={archived.length === 1 ? "Your only agent is archived" : `All ${archived.length} agents are archived`}
          className={styles.state}
          actions={
            <>
              {newAgent}
              <Button
                aria-pressed={showArchived}
                aria-controls={showArchived ? archivedId : undefined}
                onClick={() => setShowArchived((shown) => !shown)}
              >
                Show archived
              </Button>
            </>
          }
        >
          <p>Archived agents stay off the Dashboard. Show them to look back, or unarchive one to bring it back.</p>
        </EmptyState>
      ) : (
        <EmptyState
          title="No agents yet"
          className={`${styles.state} ${styles.launch}`}
          art={<Rocket />}
          align="center"
          actions={newAgent}
        >
          {providerPanes ? (
            <p>
              Launch a <ProviderMark provider="claude-code" size="sm" className={styles.inlineMark} />,{" "}
              <ProviderMark provider="codex" size="sm" className={styles.inlineMark} />,{" "}
              <ProviderMark provider="cursor" name="Cursor" size="sm" className={styles.inlineMark} /> or{" "}
              <ProviderMark provider="gemini-cli" name="Gemini" size="sm" className={styles.inlineMark} /> agent from
              Code and it shows up here with what it's doing and whether it needs you. A CLI you type into a plain
              terminal isn't tracked here.
            </p>
          ) : (
            <p>Coding agents aren't part of this build. Threads keep their own list in Threads.</p>
          )}
        </EmptyState>
      );
  } else if (groups.length === 0) {
    body = (
      <div className={styles.noMatch} role="status">
        <p>{query ? `No agents match “${query.trim()}”.` : EMPTY_FILTER_TEXT[filter]}</p>
        <Button
          size="sm"
          onClick={() => {
            setQuery("");
            selectFilter("all");
          }}
        >
          Show all agents
        </Button>
      </div>
    );
  } else {
    body = (
      <div
        ref={(el) => {
          virtual.containerRef(el);
          measureRef(el);
        }}
        className={styles.rows}
        data-virtualized={virtual.virtualized || undefined}
        style={virtual.virtualized ? { height: virtual.total } : undefined}
      >
        {virtual.rows.map((vr) => {
          const row = rows[vr.index];
          if (!row) return null;
          return (
            <div
              key={vr.key}
              ref={virtual.measureRef(vr.key)}
              className={styles.row}
              data-kind={row.kind}
              style={virtual.virtualized ? { transform: `translateY(${vr.start}px)` } : undefined}
            >
              {renderRow(row)}
            </div>
          );
        })}
      </div>
    );
  }

  const ready = state.status === "ready" && (allThreads?.length ?? 0) > 0;
  const archivedList = useMemo(
    () => [...archived].sort((a, b) => (b.archivedAt ?? "").localeCompare(a.archivedAt ?? "")),
    [archived],
  );

  return (
    <section className={styles.board} aria-label="Agents" data-in-pane={inPane || undefined}>
      {ready ? (
        <div className={styles.head}>
          {/* Decoration on inert elements, not pseudo-elements (see DashboardBoard.module.css). */}
          <div className={styles.headGrid} aria-hidden="true" />
          <div className={styles.overview}>
            <p className={styles.total}>
              <span className={styles.totalCount}>{counts.all}</span>
              <span className={styles.totalLabel}>{counts.all === 1 ? "agent" : "agents"}</span>
            </p>
            {inPane ? <p className={styles.paneSummary}>{fleetSummaryLine(counts)}</p> : null}
            <StatusBar counts={counts} />
          </div>
          <div className={styles.toolbar}>
            {/* biome-ignore lint/a11y/useSemanticElements: a labelled group of buttons, not form fields. */}
            <div className={styles.chips} role="group" aria-label="Filter agents" ref={chipsRef}>
              {FLEET_FILTERS.map((value) => (
                <button
                  key={value}
                  type="button"
                  className={styles.chip}
                  data-chip={value}
                  data-empty={(value !== "all" && counts[value] === 0) || undefined}
                  aria-pressed={filter === value}
                  aria-label={`${FLEET_FILTER_LABELS[value]}, ${counts[value]}`}
                  onClick={() => selectFilter(value)}
                >
                  <span className={styles.chipDot} data-chip={value} aria-hidden="true" />
                  <span className={styles.chipLabel}>{FLEET_FILTER_LABELS[value]}</span>
                  <span className={styles.chipCount}>{counts[value]}</span>
                </button>
              ))}
            </div>
            <div className={styles.controls}>
              <div className={styles.search}>
                <Search className={styles.searchGlyph} aria-hidden="true" />
                <TextInput
                  type="search"
                  aria-label="Search agents"
                  placeholder="Search agents, accounts, projects…"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape" && query) {
                      event.preventDefault();
                      setQuery("");
                    }
                  }}
                  className={styles.searchInput}
                />
                {query ? (
                  <IconButton
                    size="sm"
                    label="Clear search"
                    icon={<X />}
                    className={styles.searchClear}
                    onClick={() => setQuery("")}
                  />
                ) : null}
              </div>
              <div className={styles.groupBy}>
                <span className={styles.groupLabel} id="dashboard-group-label">
                  Group by
                </span>
                <SegmentedControl<GroupMode>
                  aria-labelledby="dashboard-group-label"
                  value={groupMode}
                  options={GROUP_MODES.map((mode) => ({ value: mode, label: GROUP_MODE_LABELS[mode] }))}
                  onValueChange={setGroupMode}
                />
              </div>
              {providers.length > 1 || activeProvider ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      size="sm"
                      variant="secondary"
                      icon={
                        activeProvider ? (
                          <ProviderMark provider={activeProvider} size="sm" />
                        ) : (
                          <Layers aria-hidden="true" />
                        )
                      }
                      className={styles.providerFilter}
                      data-active={activeProvider ? true : undefined}
                      aria-label={`Provider: ${providers.find((p) => p.id === activeProvider)?.name ?? "All providers"}`}
                    >
                      {providers.find((p) => p.id === activeProvider)?.name ?? "All providers"}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuRadioGroup
                      value={activeProvider ?? ""}
                      onValueChange={(value) => selectProvider(value === "" ? null : value)}
                    >
                      <DropdownMenuRadioItem value="">All providers</DropdownMenuRadioItem>
                      {providers.map((p) => (
                        <DropdownMenuRadioItem key={p.id} value={p.id}>
                          {p.name}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button ref={cleanupRef} size="sm" variant="secondary" icon={<Sparkles />} className={styles.cleanup}>
                    Clean up
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className={styles.cleanupMenu}>
                  <DropdownMenuItem
                    icon={<CircleX />}
                    disabled={cleanup.counts.failed === 0}
                    description="Removes failed agents; restore them from Archived"
                    onSelect={() => void cleanup.clearFailed()}
                  >
                    Clear failed ({cleanup.counts.failed})
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    icon={<ListX />}
                    disabled={cleanup.counts.finished === 0}
                    description="Removes finished, stopped and offline agents"
                    onSelect={() => void cleanup.clearFinished()}
                  >
                    Clear finished ({cleanup.counts.finished})
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    icon={<Power />}
                    disabled={cleanup.counts.idle === 0}
                    description="Closes agents idle at their prompt; paused ones keep their turn"
                    onSelect={() => void cleanup.closeIdle()}
                  >
                    Close idle ({cleanup.counts.idle})
                  </DropdownMenuItem>
                  {kalTidy ? (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        icon={<BroomSparkles />}
                        description="Stops terminals that are idle; never ones in use"
                        onSelect={() => void kalTidy.stopIdle()}
                      >
                        KalTidy: stop idle terminals
                      </DropdownMenuItem>
                    </>
                  ) : null}
                  {archived.length > 0 ? (
                    <DropdownMenuItem icon={<Archive />} onSelect={() => setShowArchived((shown) => !shown)}>
                      {showArchived ? "Hide archived" : `Show archived (${archived.length})`}
                    </DropdownMenuItem>
                  ) : null}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    icon={<Power />}
                    tone="danger"
                    disabled={cleanup.counts.all === 0}
                    onSelect={() => (cleanup.canonical ? void cleanup.closeAll() : setConfirmCloseAll(true))}
                  >
                    {cleanup.canonical ? "Close all terminals and agents…" : "Close all agents…"}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
          {confirmCloseAll ? (
            // biome-ignore lint/a11y/useSemanticElements: a labelled group of buttons, not form fields.
            <div className={styles.confirm} role="group" aria-label="Close all agents?">
              {/* The one confirmation cleanup asks (AGENTS.md agent cleanup rule). */}
              <p className={styles.confirmText}>
                <strong>Close all {cleanup.counts.all} agents?</strong> Active agents, builds, tests, and running
                processes will be stopped.
              </p>
              <div className={styles.confirmActions}>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setConfirmCloseAll(false);
                    cleanupRef.current?.focus();
                  }}
                >
                  Cancel
                </Button>
                <Button
                  ref={closeAllRef}
                  size="sm"
                  variant="danger"
                  onClick={() => {
                    setConfirmCloseAll(false);
                    void cleanup.closeAll();
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      setConfirmCloseAll(false);
                      cleanupRef.current?.focus();
                    }
                  }}
                >
                  Close all
                </Button>
              </div>
            </div>
          ) : null}
          <div className={styles.headHorizon} aria-hidden="true" />
        </div>
      ) : null}
      {body}
      {showArchived && archived.length > 0 ? (
        <section id={archivedId} className={styles.archived} aria-labelledby={`${archivedId}-heading`}>
          <div className={styles.archivedHead}>
            <h2 className={styles.archivedTitle} id={`${archivedId}-heading`}>
              Archived <span className={styles.groupCount}>{archived.length}</span>
            </h2>
            <Button size="sm" variant="ghost" onClick={() => setShowArchived(false)}>
              Hide archived
            </Button>
          </div>
          <div className={styles.archivedGrid}>
            {archivedList.slice(0, archivedShown).map((thread) => (
              <AgentCard
                key={thread.id}
                thread={thread}
                archived
                approvals={NO_APPROVALS}
                pendingAction={archivedThreads.pendingActions.get(thread.id)}
                onFocus={onFocus}
                onAction={archivedThreads.runAction}
                onDecide={permissions.decide}
                onReviewApprovals={onReviewApprovals}
              />
            ))}
          </div>
          {archivedList.length > archivedShown ? (
            <Button size="sm" variant="ghost" onClick={() => setArchivedShown((n) => n + ARCHIVED_PAGE)}>
              Show {Math.min(ARCHIVED_PAGE, archivedList.length - archivedShown)} more of{" "}
              {archivedList.length - archivedShown}
            </Button>
          ) : null}
        </section>
      ) : null}
      <div className="visually-hidden" aria-live="polite" aria-atomic="true">
        {announcement ? <p key={announcement.id}>{announcement.text}</p> : null}
      </div>
    </section>
  );
}

const NO_APPROVALS: readonly ApprovalView[] = [];

/** The last readiness worked out per agent record, kept while its worktree facts are the same. */
const readinessCache = new WeakMap<
  ThreadSummary,
  { worktree: ThreadWorktreeState | undefined; readiness: MergeReadiness }
>();

/** The card's merge readiness, the same object while the agent and its worktree facts are (so the card's memo holds). */
function readinessOf(thread: ThreadSummary, worktree: ThreadWorktreeState | undefined): MergeReadiness {
  const cached = readinessCache.get(thread);
  if (cached && cached.worktree === worktree) return cached.readiness;
  const readiness = mergeReadiness(thread, worktree);
  readinessCache.set(thread, { worktree, readiness });
  return readiness;
}
const NO_THREADS: readonly ThreadSummary[] = [];

/** The fleet at a glance: one segment per state, sized by its share (decorative; chips say it). */
function StatusBar({ counts }: { counts: FleetCounts }) {
  return (
    <div className={styles.statusBar} aria-hidden="true" title={fleetSummaryLine(counts)}>
      {FLEET_GROUPS.filter((group) => counts[group] > 0).map((group) => (
        <span
          key={group}
          className={styles.segment}
          data-chip={group}
          style={{ flexGrow: counts[group], flexBasis: 0 }}
        />
      ))}
    </div>
  );
}

function GroupHeader({
  group,
  collapsed,
  onToggle,
  action,
}: {
  group: ThreadGroup;
  collapsed: boolean;
  onToggle: () => void;
  action: { label: string; run: () => Promise<void>; icon: React.ReactNode } | null;
}) {
  const count = group.threads.length;
  return (
    <div className={styles.groupRow} data-chip={group.status}>
      <h2 className={styles.groupHeading} data-chip={group.status}>
        <button type="button" className={styles.groupToggle} aria-expanded={!collapsed} onClick={onToggle}>
          <ChevronDown className={styles.groupChevron} aria-hidden="true" data-collapsed={collapsed || undefined} />
          {group.status ? <span className={styles.groupDot} data-chip={group.status} aria-hidden="true" /> : null}
          {group.providerId ? (
            <ProviderMark provider={group.providerId} name={group.label} size="sm" className={styles.groupMark} />
          ) : (
            <span className={styles.groupName}>{group.label}</span>
          )}
          <span className={styles.groupCount}>
            <span className="visually-hidden">, </span>
            {count}
            <span className="visually-hidden">{count === 1 ? " agent" : " agents"}</span>
          </span>
          {group.mode !== "status" && group.needsYou > 0 ? (
            <span className={styles.groupNeeds}>{group.needsYou} need you</span>
          ) : null}
        </button>
      </h2>
      <span className={styles.groupRule} aria-hidden="true" />
      {action ? (
        <Button
          size="sm"
          variant="ghost"
          icon={action.icon}
          className={styles.groupAction}
          onClick={() => void action.run()}
        >
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}
