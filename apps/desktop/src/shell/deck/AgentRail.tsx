/**
 * The Command Deck's right rail: every coding agent (any provider's coding terminal in Code),
 * grouped by the shared agent state — agents that need the person first, then failed, working and
 * waiting; idle agents fold away and the last few that finished stay briefly. Each row opens
 * the agent's terminal in Code. Chat threads live in Threads, not here. Collapses to a narrow
 * strip of live counts: on its own while no agent runs and nothing needs the person, or when the
 * person collapses it.
 */
import { AGENT_STATE_TEXT, AGENT_STATE_TONE, agentStateOf, isAgentBusy, type ThreadSummary } from "@kalcode/protocol";
import { Button, IconButton, ProviderGlyph, Skeleton, Tooltip } from "@kalcode/ui/components";
import { Bot, ChevronRight, PanelRightClose, PanelRightOpen, Plus, RotateCw, X } from "lucide-react";
import { type RefObject, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useOptionalUiIntents } from "../../runtime/uiIntents.tsx";
import { isClearableAgent } from "../../surfaces/code/kaltidy/agents.ts";
import { useKalTidy } from "../../surfaces/code/kaltidy/kalTidyContext.ts";
import { useLaunchAgent } from "../../surfaces/code/useLaunchAgent.ts";
import { useCodingAgents } from "../../surfaces/dashboard/data/DashboardData.tsx";
import { STATUS_META } from "../../surfaces/dashboard/data/status.ts";
import { useNow } from "../../surfaces/dashboard/useNow.ts";
import { useNavigation } from "../navigation.tsx";
import { beginLiveResize } from "../panes/liveResize.ts";
import styles from "./AgentRail.module.css";
import { useDeckUi } from "./DeckUi.tsx";
import { type AgentSections, agentSections, runningAgentCount, shortElapsed } from "./deckModel.ts";

export function AgentRail() {
  const { agentsOpen, setAgentsOpen, setAgentsActive } = useDeckUi();
  const { state, reload } = useCodingAgents();
  const now = useNow(30_000);
  const sections = useMemo(() => (state.status === "ready" ? agentSections(state.data, now) : null), [state, now]);
  // Until the person pins or collapses it, the rail opens while an agent runs or needs them.
  const active = sections ? runningAgentCount(sections) > 0 || sections.needsYou.length > 0 : null;
  useEffect(() => {
    if (active !== null) setAgentsActive(active);
  }, [active, setAgentsActive]);
  const dock = useRef<HTMLElement>(null);
  useWidthTransition(dock, agentsOpen);

  const running = sections ? runningAgentCount(sections) : 0;
  return (
    <aside
      ref={dock}
      className={styles.dock}
      data-open={agentsOpen || undefined}
      data-deck-agents
      {...(agentsOpen
        ? { id: "deck-agents", "aria-labelledby": "deck-agents-heading", tabIndex: -1 }
        : { "aria-label": "Agents (collapsed)" })}
    >
      {agentsOpen ? (
        <div className={styles.rail}>
          <div className={styles.header}>
            <h2 className={styles.heading} id="deck-agents-heading">
              Agents
              {running > 0 ? <span className={styles.headingCount}>{running}</span> : null}
            </h2>
            <Tooltip content="Hide agents" side="left">
              <IconButton
                size="sm"
                label="Hide agents"
                icon={<PanelRightClose />}
                onClick={() => setAgentsOpen(false)}
              />
            </Tooltip>
          </div>
          <div className={styles.body}>
            {state.status === "loading" ? (
              <div className={styles.loading} aria-busy="true">
                <Skeleton width="80%" />
                <Skeleton width="62%" />
                <Skeleton width="70%" />
              </div>
            ) : state.status === "error" ? (
              <div className={styles.problem} role="alert">
                <p>Agents couldn't load. {state.error.message}</p>
                <Button size="sm" variant="secondary" icon={<RotateCw />} onClick={reload}>
                  Try again
                </Button>
              </div>
            ) : sections ? (
              <AgentList sections={sections} now={now} />
            ) : (
              <p className={styles.quiet}>Agents aren't part of this build.</p>
            )}
          </div>
        </div>
      ) : (
        <div className={styles.strip}>
          <Tooltip content="Show agents" side="left">
            <IconButton size="sm" label="Show agents" icon={<PanelRightOpen />} onClick={() => setAgentsOpen(true)} />
          </Tooltip>
          {sections ? <StripCounts sections={sections} onOpen={() => setAgentsOpen(true)} /> : null}
        </div>
      )}
    </aside>
  );
}

/**
 * The rail's width eases between its strip and its full width. Terminals beside it fit once when
 * the change settles (the pane divider's live-resize path) instead of re-flowing every frame.
 */
function useWidthTransition(dock: RefObject<HTMLElement | null>, open: boolean) {
  const first = useRef(true);
  useEffect(() => {
    void open;
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
  }, [dock, open]);
}

function StripCounts({ sections, onOpen }: { sections: AgentSections; onOpen: () => void }) {
  const counts = [
    { tone: "waiting", value: sections.needsYou.length, label: "need you" },
    { tone: "working", value: sections.working.length, label: "working" },
    { tone: "muted", value: sections.blocked.length, label: "waiting" },
    { tone: "failed", value: sections.failed.length, label: "failed" },
  ].filter((c) => c.value > 0);
  return (
    <div className={styles.stripCounts}>
      {counts.map((c) => (
        <Tooltip key={c.label} content={`${c.value} ${c.label}`} side="left">
          <button
            type="button"
            className={styles.stripCount}
            data-tone={c.tone}
            onClick={onOpen}
            aria-label={`${c.value} ${c.value === 1 && c.label === "need you" ? "needs you" : c.label}. Show agents`}
          >
            {c.value}
          </button>
        </Tooltip>
      ))}
    </div>
  );
}

function AgentList({ sections, now }: { sections: AgentSections; now: number }) {
  const { navigate } = useNavigation();
  const intents = useOptionalUiIntents();
  const launchAgent = useLaunchAgent();
  const [showIdle, setShowIdle] = useState(false);
  const idleId = useId();
  const running = runningAgentCount(sections);
  // An agent whose session is over can be cleared from its row (KalTidy's canonical removal).
  // The row leaves at once; it comes back, with a toast, only if the removal fails.
  const kalTidy = useKalTidy();
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(() => new Set());
  const dismiss = useCallback(
    (thread: ThreadSummary) => {
      if (!kalTidy) return;
      setLeaving((current) => new Set(current).add(thread.id));
      void kalTidy.dismissAgent(thread.id).then((removed) => {
        if (removed) return;
        setLeaving((current) => {
          const next = new Set(current);
          next.delete(thread.id);
          return next;
        });
      });
    },
    [kalTidy],
  );
  const rowActions = { leaving, onDismiss: kalTidy ? dismiss : undefined };
  // An agent opens its own terminal pane in Code (the focus intent finds and focuses it).
  const open = (thread: ThreadSummary) => {
    if (intents) void intents.focus({ kind: "agent", agentId: thread.id, workspaceId: thread.workspaceId });
    else navigate("code");
  };

  if (
    running === 0 &&
    sections.needsYou.length === 0 &&
    sections.failed.length === 0 &&
    sections.finished.length === 0 &&
    sections.idle.length === 0
  ) {
    return (
      <div className={styles.empty}>
        <span className={styles.emptyArt} aria-hidden="true">
          <Bot />
        </span>
        <p className={styles.emptyTitle}>No agents running</p>
        <p className={styles.emptyText}>Launch a coding agent in Code and it shows up here while it works.</p>
        <Button size="sm" variant="secondary" icon={<Plus />} onClick={launchAgent}>
          Launch an agent
        </Button>
      </div>
    );
  }

  return (
    <>
      {running === 0 ? <p className={styles.quiet}>Nothing running right now.</p> : null}
      <Group
        title="Needs you"
        tone="waiting"
        threads={sections.needsYou}
        now={now}
        onOpen={open}
        {...rowActions}
      />
      <Group
        title="Failed"
        tone="failed"
        threads={sections.failed}
        now={now}
        onOpen={open}
        {...rowActions}
      />
      <Group title="Working" tone="working" threads={sections.working} now={now} onOpen={open} />
      <Group title="Waiting" tone="muted" threads={sections.blocked} now={now} onOpen={open} />
      {sections.idle.length > 0 ? (
        <section className={styles.group}>
          <button
            type="button"
            className={styles.foldToggle}
            aria-expanded={showIdle}
            aria-controls={idleId}
            onClick={() => setShowIdle((v) => !v)}
          >
            <ChevronRight className={styles.foldIcon} data-open={showIdle || undefined} aria-hidden="true" />
            Idle
            <span className={styles.groupCount}>{sections.idle.length}</span>
          </button>
          {showIdle ? (
            <ul id={idleId} className={styles.list}>
              {sections.idle.map((thread) => (
                <AgentRow key={thread.id} thread={thread} now={now} onOpen={open} {...rowActions} />
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
      <Group title="Just finished" tone="done" threads={sections.finished} now={now} onOpen={open} {...rowActions} />
    </>
  );
}

interface GroupProps {
  title: string;
  tone: string;
  threads: ThreadSummary[];
  now: number;
  onOpen: (thread: ThreadSummary) => void;
  leaving?: ReadonlySet<string>;
  onDismiss?: (thread: ThreadSummary) => void;
}

function Group({ title, tone, threads, now, onOpen, leaving, onDismiss }: GroupProps) {
  const headingId = useId();
  if (threads.length === 0) return null;
  return (
    <section className={styles.group} aria-labelledby={headingId} data-tone={tone}>
      <h3 className={styles.groupTitle} id={headingId}>
        {title}
        <span className={styles.groupCount}>{threads.length}</span>
      </h3>
      <ul className={styles.list}>
        {threads.map((thread) => (
          <AgentRow key={thread.id} thread={thread} now={now} onOpen={onOpen} leaving={leaving} onDismiss={onDismiss} />
        ))}
      </ul>
    </section>
  );
}

function AgentRow({
  thread,
  now,
  onOpen,
  leaving,
  onDismiss,
}: {
  thread: ThreadSummary;
  now: number;
  onOpen: (t: ThreadSummary) => void;
  leaving?: ReadonlySet<string>;
  /** Present for agents whose session is over: the row's X clears them. */
  onDismiss?: (t: ThreadSummary) => void;
}) {
  const state = agentStateOf(thread);
  const tone = AGENT_STATE_TONE[state];
  const label = AGENT_STATE_TEXT[state];
  const since = Date.parse(thread.lastActivityAt);
  const elapsed = Number.isNaN(since) ? null : shortElapsed(now - since);
  const live = isAgentBusy(state);
  const detail = live && thread.currentActivity ? `${label} · ${thread.currentActivity}` : label;
  const dismissible = onDismiss !== undefined && isClearableAgent(thread);
  const isLeaving = leaving?.has(thread.id) ?? false;
  return (
    <li
      className={styles.rowItem}
      data-dismissible={dismissible || undefined}
      data-leaving={isLeaving || undefined}
      aria-hidden={isLeaving || undefined}
    >
      <button
        type="button"
        className={styles.row}
        data-tone={tone}
        data-group={state === "needs_you" ? "attention" : state}
        data-state={state}
        onClick={() => onOpen(thread)}
        aria-label={`${thread.name}, ${label}, ${thread.providerName} in ${thread.workspaceName}. Open agent`}
      >
        <span className={styles.rowGlyph} aria-hidden="true">
          <ProviderGlyph provider={thread.providerId} size="sm" />
          <span className={styles.rowDot} data-pulse={live || undefined} />
        </span>
        <span className={styles.rowText}>
          <span className={styles.rowTop}>
            <span className={styles.rowName}>{thread.name}</span>
            {elapsed ? <span className={styles.rowTime}>{elapsed}</span> : null}
          </span>
          <span className={styles.rowDetail}>{detail}</span>
          <span className={styles.rowMeta}>
            {thread.providerName} · {thread.workspaceName}
            {thread.pendingApprovals > 0 && thread.status !== "waiting_for_permission" ? (
              <span className={styles.rowFlag}>
                {thread.pendingApprovals} {thread.pendingApprovals === 1 ? "approval" : "approvals"}
              </span>
            ) : null}
          </span>
        </span>
      </button>
      {dismissible ? (
        <button
          type="button"
          className={styles.rowDismiss}
          aria-label={`Clear ${thread.name}`}
          title="Clear agent"
          disabled={isLeaving}
          onClick={() => onDismiss?.(thread)}
        >
          <X aria-hidden="true" />
        </button>
      ) : null}
    </li>
  );
}
