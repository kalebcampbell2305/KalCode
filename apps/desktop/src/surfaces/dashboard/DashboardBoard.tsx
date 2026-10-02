import type { ApprovalView, DashboardChip, ThreadSummary } from "@kalcode/protocol";
import {
  Button,
  EmptyState,
  ErrorState,
  IconButton,
  ProviderMark,
  SegmentedControl,
  Skeleton,
  TextInput,
} from "@kalcode/ui/components";
import { ChevronDown, Search, X } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useOptionalUiIntents } from "../../runtime/uiIntents.tsx";
import { useNavigation } from "../../shell/navigation.tsx";
import { useProviderPanesEnabled } from "../code/panes/useProviderPanes.ts";
import { usePermissions } from "../permissions/PermissionsProvider.tsx";
import { useThreadsIntent } from "../threads/intent.tsx";
import { AgentCard } from "./AgentCard.tsx";
import styles from "./DashboardBoard.module.css";
import {
  CHIP_LABELS,
  CHIPS,
  type ChipCounts,
  chipCounts,
  filterThreads,
  GROUP_MODE_LABELS,
  GROUP_MODES,
  type GroupMode,
  groupThreads,
  summaryLine,
  type ThreadGroup,
} from "./data/board.ts";
import { useArchivedThreads, useThreadSummaries } from "./data/DashboardData.tsx";
import { fleetHandles, mergeReadiness } from "./fleet/fleetModel.ts";
import { morphIntoThread } from "./fleet/morph.ts";
import { useWorktreeStates } from "./fleet/useWorktreeStates.ts";
import { useNow } from "./useNow.ts";
import { useVirtualRows } from "./useVirtualRows.ts";

/** Card sizing: a card never gets narrower than this; wider boards get more columns. */
const CARD_MIN_PX = 300;
const CARD_GAP_PX = 12;
const GROUP_KEY = "kalcode.dashboard.groupBy";

const EMPTY_FILTER_TEXT: Record<DashboardChip, string> = {
  all: "No agents match.",
  waiting_for_you: "Nothing is waiting for you.",
  working: "No agents are working right now.",
  done: "Nothing has finished yet.",
  idle: "No idle agents.",
};

const CHIP_ANNOUNCE: Record<DashboardChip, (n: number) => string> = {
  all: (n) => `Showing all ${n} ${n === 1 ? "agent" : "agents"}.`,
  waiting_for_you: (n) => (n === 0 ? "Nothing is waiting for you." : `Showing ${n} waiting for you.`),
  working: (n) => (n === 0 ? "No agents are working." : `Showing ${n} working.`),
  done: (n) => (n === 0 ? "Nothing has finished." : `Showing ${n} done.`),
  idle: (n) => (n === 0 ? "No idle agents." : `Showing ${n} idle.`),
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
 * The live board of agents (threads): filter chips with real counts, search, grouping, and a
 * virtualized grid of cards that gains columns on wide windows instead of stretching. The same
 * board renders in the Dashboard surface and in a Dashboard pane.
 */
export function DashboardBoard({ inPane = false }: DashboardBoardProps) {
  const { state, reload, pendingActions, runAction } = useThreadSummaries();
  const archivedThreads = useArchivedThreads();
  const permissions = usePermissions();
  const intents = useOptionalUiIntents();
  const threadsIntent = useThreadsIntent();
  const { navigate } = useNavigation();
  // Provider panes (gated on Stable) are the only way a CLI started from Code becomes a session.
  const providerPanes = useProviderPanesEnabled();
  const now = useNow(30_000);
  const [showArchived, setShowArchived] = useState(false);
  const archivedId = useId();

  const [chip, setChip] = useState<DashboardChip>("all");
  const [query, setQuery] = useState("");
  const [groupMode, setGroupModeState] = useState<GroupMode>(readGroupMode);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [announcement, setAnnouncement] = useState<{ id: number; text: string } | null>(null);
  const announceSeq = useRef(0);
  const chipsRef = useRef<HTMLDivElement>(null);

  const threads = state.status === "ready" ? state.data : null;
  const counts: ChipCounts = useMemo(() => chipCounts(threads ?? []), [threads]);
  const archived = archivedThreads.state.status === "ready" ? archivedThreads.state.data : NO_THREADS;
  // Nothing left to show once the last archived session is restored: close the archived view.
  useEffect(() => {
    if (archived.length === 0) setShowArchived(false);
  }, [archived.length]);

  const announce = useCallback((text: string) => {
    announceSeq.current += 1;
    setAnnouncement({ id: announceSeq.current, text });
  }, []);

  const selectChip = useCallback(
    (next: DashboardChip, fromIntent = false) => {
      setChip(next);
      if (fromIntent) setQuery("");
      announce(CHIP_ANNOUNCE[next](next === "all" ? counts.all : counts[next]));
    },
    [announce, counts],
  );

  // KalVoice ("Show only agents that are working") and notifications set the filter.
  const request = intents?.dashboardFilter ?? null;
  const handledRequest = useRef(request?.nonce ?? 0);
  useEffect(() => {
    if (!request || request.nonce === handledRequest.current || !threads) return;
    handledRequest.current = request.nonce;
    selectChip(request.chip, true);
    chipsRef.current?.querySelector<HTMLElement>(`[data-chip="${request.chip}"]`)?.focus({ preventScroll: true });
  }, [request, threads, selectChip]);

  const setGroupMode = (mode: GroupMode) => {
    setGroupModeState(mode);
    try {
      localStorage.setItem(GROUP_KEY, mode);
    } catch {
      // Remembering the grouping is a convenience.
    }
  };

  const groups = useMemo(
    () => (threads ? groupThreads(filterThreads(threads, chip, query), groupMode) : []),
    [threads, chip, query, groupMode],
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

  const onFocus = useCallback(
    (thread: ThreadSummary) => {
      const card = document.querySelector<HTMLElement>(`[data-thread-id="${CSS.escape(thread.id)}"]`);
      morphIntoThread(card, thread.id, () => {
        if (intents) return intents.focus({ kind: "thread", threadId: thread.id, workspaceId: thread.workspaceId });
        flushSync(() => {
          navigate("threads");
          threadsIntent.request("open", thread.id);
        });
      });
    },
    [intents, navigate, threadsIntent],
  );

  // Agent Fleet: call signs, worktree facts and merge readiness for every card.
  // Archived agents keep their letters, so a call sign never moves to another agent.
  const handles = useMemo(() => fleetHandles([...(threads ?? []), ...archived]), [threads, archived]);
  const { states: worktrees, apply: applyWorktree } = useWorktreeStates(threads);
  const onReviewApprovals = useCallback(() => permissions.setPanelOpen(true), [permissions.setPanelOpen]);

  const [measureRef, columns] = useColumns();

  const rows = useMemo(() => {
    const list: BoardRow[] = [];
    for (const group of groups) {
      const isCollapsed = collapsed.has(`${group.mode}:${group.key}`);
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
  }, [groups, columns, collapsed]);

  const getKey = useCallback((index: number) => rows[index]?.key ?? String(index), [rows]);
  const estimate = useCallback(
    (index: number) => {
      const row = rows[index];
      if (!row || row.kind === "header") return 48;
      const tallest = row.threads.reduce((max, t) => {
        const extra =
          t.status === "waiting_for_permission" && approvalsByThread.has(t.id)
            ? 150
            : t.status === "completed"
              ? 60
              : t.status === "failed" || t.status === "waiting_for_user"
                ? 44
                : 0;
        return Math.max(max, extra);
      }, 0);
      return 196 + tallest + CARD_GAP_PX;
    },
    [rows, approvalsByThread],
  );
  const virtual = useVirtualRows({ count: rows.length, getKey, estimate });

  const toggleGroup = (group: ThreadGroup) => {
    const key = `${group.mode}:${group.key}`;
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const renderRow = (row: BoardRow) =>
    row.kind === "header" ? (
      <GroupHeader group={row.group} collapsed={row.collapsed} onToggle={() => toggleGroup(row.group)} />
    ) : (
      <div className={styles.cardRow} style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
        {row.threads.map((thread) => (
          <AgentCard
            key={thread.id}
            thread={thread}
            now={now}
            approvals={approvalsByThread.get(thread.id) ?? NO_APPROVALS}
            pendingAction={pendingActions.get(thread.id)}
            onFocus={onFocus}
            onAction={runAction}
            onDecide={permissions.decide}
            onReviewApprovals={onReviewApprovals}
            handle={handles.get(thread.id)}
            worktree={worktrees.get(thread.id)}
            readiness={thread.worktreeId ? mergeReadiness(thread, worktrees.get(thread.id)) : undefined}
            onCommitted={applyWorktree}
          />
        ))}
      </div>
    );

  let body: React.ReactNode;
  if (state.status === "unavailable") {
    body = (
      <EmptyState title="Agents arrive with provider support" className={styles.state}>
        <p>
          When Claude Code, Codex or Gemini CLI run in your projects, each one appears here with its provider, model,
          what it is doing now and its status. This build doesn't run threads yet, so there's nothing to show.
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
        <p>{state.error.message} Your threads keep running; this only affects what the Dashboard shows.</p>
      </ErrorState>
    );
  } else if (counts.all === 0) {
    const newSession = (
      <Button
        variant="primary"
        onClick={() => {
          navigate("threads");
          threadsIntent.request("new");
        }}
      >
        New Session
      </Button>
    );
    body =
      archived.length > 0 ? (
        <EmptyState
          title={
            archived.length === 1 ? "Your only session is archived" : `All ${archived.length} sessions are archived`
          }
          className={styles.state}
          actions={
            <>
              {newSession}
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
          <p>Archived sessions stay off the Dashboard. Show them to look back, or unarchive one to bring it back.</p>
        </EmptyState>
      ) : (
        <EmptyState
          title="No sessions yet"
          className={styles.state}
          actions={
            <>
              {newSession}
              {providerPanes ? <Button onClick={() => navigate("code")}>Open Code</Button> : null}
            </>
          }
        >
          {providerPanes ? (
            <p>
              Start a session, or open <ProviderMark provider="claude-code" size="sm" />,{" "}
              <ProviderMark provider="codex" size="sm" /> or{" "}
              <ProviderMark provider="gemini-cli" name="Gemini" size="sm" /> in a provider pane from Code. A CLI you
              type into a plain terminal isn't tracked here.
            </p>
          ) : (
            <p>
              Start a session and it shows up here with what it's doing and whether it needs you. This build tracks
              sessions started from Threads; a CLI you run yourself in a Code terminal isn't tracked.
            </p>
          )}
        </EmptyState>
      );
  } else if (groups.length === 0) {
    body = (
      <div className={styles.noMatch} role="status">
        <p>{query ? `No agents match “${query.trim()}”.` : EMPTY_FILTER_TEXT[chip]}</p>
        <Button
          size="sm"
          onClick={() => {
            setQuery("");
            selectChip("all");
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

  const ready = state.status === "ready" && counts.all > 0;

  return (
    <section className={styles.board} aria-label="Agents" data-in-pane={inPane || undefined}>
      {inPane && ready ? <p className={styles.paneSummary}>{summaryLine(counts)}</p> : null}
      {ready ? (
        <div className={styles.toolbar}>
          {/* biome-ignore lint/a11y/useSemanticElements: a labelled group of buttons, not form fields. */}
          <div className={styles.chips} role="group" aria-label="Filter agents" ref={chipsRef}>
            {CHIPS.map((value) => (
              <button
                key={value}
                type="button"
                className={styles.chip}
                data-chip={value}
                aria-pressed={chip === value}
                aria-label={`${CHIP_LABELS[value]}, ${value === "all" ? counts.all : counts[value]}`}
                onClick={() => selectChip(value)}
              >
                <span className={styles.chipDot} data-chip={value} aria-hidden="true" />
                <span className={styles.chipLabel}>{CHIP_LABELS[value]}</span>
                <span className={styles.chipCount}>{value === "all" ? counts.all : counts[value]}</span>
              </button>
            ))}
          </div>
          <div className={styles.controls}>
            <div className={styles.search}>
              <Search className={styles.searchGlyph} aria-hidden="true" />
              <TextInput
                type="search"
                aria-label="Search agents"
                placeholder="Search agents"
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
          </div>
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
            {archived.map((thread) => (
              <AgentCard
                key={thread.id}
                thread={thread}
                now={now}
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
        </section>
      ) : null}
      <div className="visually-hidden" aria-live="polite" aria-atomic="true">
        {announcement ? <p key={announcement.id}>{announcement.text}</p> : null}
      </div>
    </section>
  );
}

const NO_APPROVALS: readonly ApprovalView[] = [];
const NO_THREADS: readonly ThreadSummary[] = [];

function GroupHeader({ group, collapsed, onToggle }: { group: ThreadGroup; collapsed: boolean; onToggle: () => void }) {
  const count = group.threads.length;
  return (
    <h2 className={styles.groupHeading} data-chip={group.chip}>
      <button type="button" className={styles.groupToggle} aria-expanded={!collapsed} onClick={onToggle}>
        <ChevronDown className={styles.groupChevron} aria-hidden="true" data-collapsed={collapsed || undefined} />
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
  );
}
