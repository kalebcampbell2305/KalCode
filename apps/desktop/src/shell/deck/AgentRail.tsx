/**
 * The Workspace Dock's Agents view: every coding agent (any provider's coding terminal in Code),
 * grouped by the shared agent state — agents that need the person first, then failed, working and
 * waiting; idle agents fold away and the last few that finished stay briefly. Each row opens the
 * agent's terminal in Code. Chat threads live in Threads, not here. The dock (`shell/dock/`) owns
 * the frame, tabs and collapsed rail; this module owns the agent list and its live grouping.
 */
import { AGENT_STATE_TEXT, AGENT_STATE_TONE, agentStateOf, isAgentBusy, type ThreadSummary } from "@kalcode/protocol";
import { Button, ProviderGlyph, Skeleton } from "@kalcode/ui/components";
import { Bot, ChevronRight, Plus, RotateCw, X } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { useOptionalUiIntents } from "../../runtime/uiIntents.tsx";
import { isClearableAgent } from "../../surfaces/code/kaltidy/agents.ts";
import { useKalTidy } from "../../surfaces/code/kaltidy/kalTidyContext.ts";
import { useLaunchAgent } from "../../surfaces/code/useLaunchAgent.ts";
import { useCodingAgents } from "../../surfaces/dashboard/data/DashboardData.tsx";
import { useClock } from "../../surfaces/dashboard/useNow.ts";
import { useSessionIdentity } from "../../surfaces/providers/useSessionIdentity.ts";
import { useNavigation } from "../navigation.tsx";
import styles from "./AgentRail.module.css";
import { type AgentSections, agentSections, runningAgentCount, shortElapsed } from "./deckModel.ts";

/** Which agents "Just finished" shows: the one part of the grouping that moves with time. */
function finishedKey(sections: AgentSections): string {
  return sections.finished.map((thread) => thread.id).join(",");
}

/**
 * The canonical coding agents grouped for the dock. A tick re-renders only when an agent leaves
 * "Just finished"; each row's own time follows the clock by itself.
 */
export function useAgentSections() {
  const { state, reload } = useCodingAgents();
  const now = useClock((at) => (state.status === "ready" ? finishedKey(agentSections(state.data, at)) : ""));
  const sections = useMemo(() => (state.status === "ready" ? agentSections(state.data, now) : null), [state, now]);
  return { state, reload, sections };
}

/** The Agents tab's content. */
export function AgentsView({ agents }: { agents: ReturnType<typeof useAgentSections> }) {
  const { state, reload, sections } = agents;
  return (
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
        <AgentList sections={sections} />
      ) : (
        <p className={styles.quiet}>Agents aren't part of this build.</p>
      )}
    </div>
  );
}

function AgentList({ sections }: { sections: AgentSections }) {
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
  // A cleared agent stays "leaving" only until it is gone from the rail: one restored later
  // (Unarchive) must come back as a normal, visible row with its X, not stay hidden.
  const shown = useMemo(
    () =>
      new Set(
        [
          ...sections.needsYou,
          ...sections.failed,
          ...sections.working,
          ...sections.blocked,
          ...sections.idle,
          ...sections.finished,
        ].map((thread) => thread.id),
      ),
    [sections],
  );
  useEffect(() => {
    setLeaving((current) => {
      if ([...current].every((id) => shown.has(id))) return current;
      return new Set([...current].filter((id) => shown.has(id)));
    });
  }, [shown]);
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
      <Group title="Needs you" tone="waiting" threads={sections.needsYou} onOpen={open} {...rowActions} />
      <Group title="Failed" tone="failed" threads={sections.failed} onOpen={open} {...rowActions} />
      <Group title="Working" tone="working" threads={sections.working} onOpen={open} />
      <Group title="Waiting" tone="muted" threads={sections.blocked} onOpen={open} />
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
                <AgentRow key={thread.id} thread={thread} onOpen={open} {...rowActions} />
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
      <Group title="Just finished" tone="done" threads={sections.finished} onOpen={open} {...rowActions} />
    </>
  );
}

interface GroupProps {
  title: string;
  tone: string;
  threads: ThreadSummary[];
  onOpen: (thread: ThreadSummary) => void;
  leaving?: ReadonlySet<string>;
  onDismiss?: (thread: ThreadSummary) => void;
}

function Group({ title, tone, threads, onOpen, leaving, onDismiss }: GroupProps) {
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
          <AgentRow key={thread.id} thread={thread} onOpen={onOpen} leaving={leaving} onDismiss={onDismiss} />
        ))}
      </ul>
    </section>
  );
}

function AgentRow({
  thread,
  onOpen,
  leaving,
  onDismiss,
}: {
  thread: ThreadSummary;
  onOpen: (t: ThreadSummary) => void;
  leaving?: ReadonlySet<string>;
  /** Present for agents whose session is over: the row's X clears them. */
  onDismiss?: (t: ThreadSummary) => void;
}) {
  const identity = useSessionIdentity(thread);
  const state = agentStateOf(thread);
  const tone = AGENT_STATE_TONE[state];
  const label = AGENT_STATE_TEXT[state];
  const since = Date.parse(thread.lastActivityAt);
  const now = useClock((at) => (Number.isNaN(since) ? null : shortElapsed(at - since)));
  const elapsed = Number.isNaN(since) ? null : shortElapsed(now - since);
  const live = isAgentBusy(state);
  const detail = live && thread.currentActivity ? `${label} · ${thread.currentActivity}` : label;
  const identityDetail = `${identity.detail} Workspace: ${thread.workspaceName}.`;
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
        aria-label={`${thread.name}, ${label}, ${identity.compact} in ${thread.workspaceName}. Open agent`}
        aria-description={identityDetail}
        title={identityDetail}
      >
        {/* The warm edge on an inert element, not ::before (see AgentRail.module.css). */}
        {state === "needs_you" ? <span className={styles.attentionEdge} aria-hidden="true" /> : null}
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
            {identity.compact} · {thread.workspaceName}
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
