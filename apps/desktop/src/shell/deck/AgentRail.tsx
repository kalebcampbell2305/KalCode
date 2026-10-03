/**
 * The Command Deck's right rail: every coding agent (Claude Code, Codex or Gemini CLI in a Code
 * terminal pane), grouped by what it needs — agents waiting on the person first, then working,
 * then blocked; idle agents fold away and the last few that finished stay briefly. Each row opens
 * the agent's terminal in Code. Chat threads live in Threads, not here. Collapses to a narrow
 * strip of live counts.
 */
import type { ThreadSummary } from "@kalcode/protocol";
import { Button, IconButton, ProviderGlyph, Skeleton, Tooltip } from "@kalcode/ui/components";
import { Bot, ChevronRight, PanelRightClose, PanelRightOpen, Plus, RotateCw } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { useOptionalUiIntents } from "../../runtime/uiIntents.tsx";
import { useLaunchAgent } from "../../surfaces/code/useLaunchAgent.ts";
import { useArchivedCodingAgents, useCodingAgents } from "../../surfaces/dashboard/data/DashboardData.tsx";
import { STATUS_META } from "../../surfaces/dashboard/data/status.ts";
import { fleetHandles } from "../../surfaces/dashboard/fleet/fleetModel.ts";
import { useNow } from "../../surfaces/dashboard/useNow.ts";
import { useNavigation } from "../navigation.tsx";
import styles from "./AgentRail.module.css";
import { useDeckUi } from "./DeckUi.tsx";
import { type AgentSections, agentSections, runningAgentCount, shortElapsed } from "./deckModel.ts";

export function AgentRail() {
  const { agentsOpen, setAgentsOpen } = useDeckUi();
  const { state, reload } = useCodingAgents();
  const now = useNow(30_000);
  const sections = useMemo(() => (state.status === "ready" ? agentSections(state.data, now) : null), [state, now]);
  const archived = useArchivedCodingAgents().state;
  // The same call signs as the Fleet (archived agents keep their letters).
  const handles = useMemo(
    () =>
      fleetHandles([
        ...(state.status === "ready" ? state.data : []),
        ...(archived.status === "ready" ? archived.data : []),
      ]),
    [state, archived],
  );

  if (!agentsOpen) {
    return (
      <aside className={styles.strip} aria-label="Agents (collapsed)" data-deck-agents>
        <Tooltip content="Show agents" side="left">
          <IconButton size="sm" label="Show agents" icon={<PanelRightOpen />} onClick={() => setAgentsOpen(true)} />
        </Tooltip>
        {sections ? <StripCounts sections={sections} onOpen={() => setAgentsOpen(true)} /> : null}
      </aside>
    );
  }

  const running = sections ? runningAgentCount(sections) : 0;
  return (
    <aside
      id="deck-agents"
      className={styles.rail}
      aria-labelledby="deck-agents-heading"
      tabIndex={-1}
      data-deck-agents
    >
      <div className={styles.header}>
        <h2 className={styles.heading} id="deck-agents-heading">
          Agents
          {running > 0 ? <span className={styles.headingCount}>{running}</span> : null}
        </h2>
        <Tooltip content="Hide agents" side="left">
          <IconButton size="sm" label="Hide agents" icon={<PanelRightClose />} onClick={() => setAgentsOpen(false)} />
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
          <AgentList sections={sections} now={now} handles={handles} />
        ) : (
          <p className={styles.quiet}>Agents aren't part of this build.</p>
        )}
      </div>
    </aside>
  );
}

function StripCounts({ sections, onOpen }: { sections: AgentSections; onOpen: () => void }) {
  const counts = [
    { tone: "waiting", value: sections.needsYou.length, label: "need you" },
    { tone: "working", value: sections.working.length, label: "working" },
    { tone: "muted", value: sections.blocked.length, label: "blocked" },
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

function AgentList({
  sections,
  now,
  handles,
}: {
  sections: AgentSections;
  now: number;
  handles: ReadonlyMap<string, string>;
}) {
  const { navigate } = useNavigation();
  const intents = useOptionalUiIntents();
  const launchAgent = useLaunchAgent();
  const [showIdle, setShowIdle] = useState(false);
  const idleId = useId();
  const running = runningAgentCount(sections);
  // An agent opens its own terminal pane in Code (the focus intent finds and focuses it).
  const open = (thread: ThreadSummary) => {
    if (intents) void intents.focus({ kind: "agent", agentId: thread.id, workspaceId: thread.workspaceId });
    else navigate("code");
  };

  if (running === 0 && sections.needsYou.length === 0 && sections.finished.length === 0 && sections.idle.length === 0) {
    return (
      <div className={styles.empty}>
        <span className={styles.emptyArt} aria-hidden="true">
          <Bot />
        </span>
        <p className={styles.emptyTitle}>No agents running</p>
        <p className={styles.emptyText}>
          Launch a Claude Code or Codex agent in Code and it shows up here while it works.
        </p>
        <Button size="sm" variant="secondary" icon={<Plus />} onClick={launchAgent}>
          Launch an agent
        </Button>
      </div>
    );
  }

  return (
    <>
      {running === 0 ? <p className={styles.quiet}>Nothing running right now.</p> : null}
      <Group title="Needs you" tone="waiting" threads={sections.needsYou} now={now} onOpen={open} handles={handles} />
      <Group title="Working" tone="working" threads={sections.working} now={now} onOpen={open} handles={handles} />
      <Group title="Blocked" tone="muted" threads={sections.blocked} now={now} onOpen={open} handles={handles} />
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
                <AgentRow key={thread.id} thread={thread} now={now} onOpen={open} handle={handles.get(thread.id)} />
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
      <Group title="Just finished" tone="done" threads={sections.finished} now={now} onOpen={open} handles={handles} />
    </>
  );
}

interface GroupProps {
  title: string;
  tone: string;
  threads: ThreadSummary[];
  now: number;
  onOpen: (thread: ThreadSummary) => void;
  handles: ReadonlyMap<string, string>;
}

function Group({ title, tone, threads, now, onOpen, handles }: GroupProps) {
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
          <AgentRow key={thread.id} thread={thread} now={now} onOpen={onOpen} handle={handles.get(thread.id)} />
        ))}
      </ul>
    </section>
  );
}

function AgentRow({
  thread,
  now,
  onOpen,
  handle,
}: {
  thread: ThreadSummary;
  now: number;
  onOpen: (t: ThreadSummary) => void;
  handle?: string;
}) {
  const meta = STATUS_META[thread.status];
  const since = Date.parse(thread.lastActivityAt);
  const elapsed = Number.isNaN(since) ? null : shortElapsed(now - since);
  const live = meta.group === "working";
  const detail = meta.group === "working" && thread.currentActivity ? thread.currentActivity : meta.label;
  return (
    <li>
      <button
        type="button"
        className={styles.row}
        data-tone={meta.tone}
        data-group={meta.group}
        onClick={() => onOpen(thread)}
        aria-label={`${thread.name}, ${meta.label}, ${thread.providerName} in ${thread.workspaceName}. Open agent`}
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
            {handle ?? thread.providerName} · {thread.workspaceName}
            {thread.pendingApprovals > 0 && thread.status !== "waiting_for_permission" ? (
              <span className={styles.rowFlag}>
                {thread.pendingApprovals} {thread.pendingApprovals === 1 ? "approval" : "approvals"}
              </span>
            ) : null}
          </span>
        </span>
      </button>
    </li>
  );
}
