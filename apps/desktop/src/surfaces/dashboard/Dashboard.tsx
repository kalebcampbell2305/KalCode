import { Button, Sparkline } from "@kalcode/ui/components";
import { Bot } from "lucide-react";
import { type CSSProperties, type KeyboardEvent, type PointerEvent, useMemo, useRef } from "react";
import { useKalActions } from "../../runtime/actions.ts";
import { useEvents } from "../../runtime/RuntimeProvider.tsx";
import { AttentionList } from "../../shell/attention/AttentionList.tsx";
import { attentionSummary } from "../../shell/attention/model.ts";
import { useAttention } from "../../shell/attention/useAttention.ts";
import { Page } from "../../shell/Page.tsx";
import { WidgetDock } from "../../shell/widgets/WidgetDock.tsx";
import { Announcer } from "./Announcer.tsx";
import styles from "./Dashboard.module.css";
import { DashboardBoard } from "./DashboardBoard.tsx";
import { activityBuckets, fleetCounts, fleetSummaryLine } from "./data/board.ts";
import { DashboardDataBoundary, useCodingAgents } from "./data/DashboardData.tsx";
import { clampDock, DOCK_DEFAULT_PX, DOCK_MAX_PX, DOCK_MIN_PX, useFleetLayout } from "./fleet/fleetLayout.ts";
import { useNow } from "./useNow.ts";

/**
 * Activity (the Dashboard surface, Z7-W3): what needs the person on top, then the Agent Fleet
 * beside the widget dock. It reuses the shell's
 * always-on board data (no reload from scratch on each visit) and only creates its own provider
 * when rendered without one. On wide windows a splitter sets the Agents panel's width
 * (remembered per device).
 */
export function Dashboard() {
  return (
    <DashboardDataBoundary>
      <DashboardPage />
    </DashboardDataBoundary>
  );
}

function DashboardPage() {
  const { state } = useCodingAgents();
  const summary = useMemo(
    () => (state.status === "ready" && state.data.length > 0 ? fleetSummaryLine(fleetCounts(state.data)) : null),
    [state],
  );
  const { layout, setDockWidth } = useFleetLayout();
  const dockWidth = layout.dockWidth;
  return (
    <Page
      title="Activity"
      description={summary ?? "Every coding agent KalCode runs, live: what it is doing, and what needs you."}
      actions={
        <>
          <ActivityTrend />
          <NewAgentAction />
        </>
      }
    >
      <div className={styles.surface}>
        <NeedsYouSection />
        <div
          className={styles.layout}
          style={dockWidth !== null ? ({ "--dock-w": `${dockWidth}px` } as CSSProperties) : undefined}
        >
          <div className={styles.board} id="fleet-agents-panel">
            <DashboardBoard />
          </div>
          <PanelSplitter width={dockWidth} onResize={setDockWidth} />
          <div className={styles.dock}>
            <WidgetDock />
          </div>
        </div>
      </div>
      <Announcer />
    </Page>
  );
}

/** Activity's own New agent: the same canonical action as Code's button and KalVoice. */
function NewAgentAction() {
  const actions = useKalActions();
  return (
    <Button size="sm" variant="primary" icon={<Bot />} onClick={() => actions.newAgent()}>
      New agent
    </Button>
  );
}

/** Activity shows the most urgent few; the inbox holds the rest. The Fleet stays in view. */
const ACTIVITY_LIMIT = 6;

/**
 * Needs You at the top of Activity: the same items as the inbox, so nothing that needs the person
 * hides below the fleet. When nothing does, one quiet line says so.
 */
function NeedsYouSection() {
  const { items, ready } = useAttention();
  const { state } = useCodingAgents();
  const actions = useKalActions();
  // With no agents at all, the board's own empty state (Launch an agent) is the one message.
  if (!ready || (items.length === 0 && state.status === "ready" && state.data.length === 0)) return null;
  return (
    <section
      className={styles.needsYou}
      aria-labelledby="activity-needs-you"
      data-empty={items.length === 0 || undefined}
    >
      <h2 id="activity-needs-you" className={styles.needsYouTitle}>
        Needs you
        <span className={styles.needsYouCount}>{attentionSummary(items)}</span>
      </h2>
      {items.length > 0 ? <AttentionList items={items.slice(0, ACTIVITY_LIMIT)} ready={ready} /> : null}
      {items.length > ACTIVITY_LIMIT ? (
        <Button size="sm" variant="ghost" className={styles.needsYouMore} onClick={() => actions.openInbox()}>
          Show all {items.length} in Needs you
        </Button>
      ) : null}
    </section>
  );
}

const STEP = 24;
const BIG_STEP = 96;

/**
 * The window splitter between the Agents panel and the widget dock (WAI-ARIA separator): drag it,
 * or focus it and use the arrow keys (Shift for bigger steps), Home / End for the widest / narrowest
 * Agents panel, Enter or a double-click for the default. Only shown when the two sit side by side.
 */
function PanelSplitter({
  width,
  onResize,
}: {
  width: number | null;
  onResize: (px: number | null, persist?: boolean) => void;
}) {
  const drag = useRef<{ right: number; frame: number; last: number } | null>(null);
  const current = width ?? DOCK_DEFAULT_PX;
  const agentsShare = Math.round(((DOCK_MAX_PX - current) / (DOCK_MAX_PX - DOCK_MIN_PX)) * 100);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const layout = event.currentTarget.parentElement?.getBoundingClientRect();
    if (!layout) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus({ preventScroll: true });
    drag.current = { right: layout.right, frame: 0, last: current };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state) return;
    const next = clampDock(state.right - event.clientX - 6);
    state.last = next;
    cancelAnimationFrame(state.frame);
    state.frame = requestAnimationFrame(() => onResize(next, false));
  };
  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    cancelAnimationFrame(state.frame);
    onResize(state.last);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? BIG_STEP : STEP;
    let next: number | null | undefined;
    // The separator moves: left makes the Agents panel narrower (the dock wider).
    if (event.key === "ArrowLeft") next = current + step;
    else if (event.key === "ArrowRight") next = current - step;
    else if (event.key === "Home") next = DOCK_MAX_PX;
    else if (event.key === "End") next = DOCK_MIN_PX;
    else if (event.key === "Enter") next = null;
    if (next === undefined || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    onResize(next);
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable window splitter (separator role with a value) has no native element.
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label="Resize the Agents panel"
      aria-controls="fleet-agents-panel"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={agentsShare}
      aria-valuetext={`Widgets ${current} pixels wide`}
      className={styles.splitter}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={() => onResize(null)}
      onKeyDown={onKeyDown}
    >
      <span className={styles.splitterLine} aria-hidden="true" />
    </div>
  );
}

/**
 * The Dashboard's activity trend: events recorded in the last hour, in five-minute bars. Real data
 * only (KalCode's event log); nothing is drawn when nothing happened.
 */
function ActivityTrend() {
  const { events } = useEvents();
  const now = useNow(60_000);
  const buckets = useMemo(() => activityBuckets(events, now), [events, now]);
  if (!buckets) return null;
  const total = buckets.reduce((sum, n) => sum + n, 0);
  return (
    <p className={styles.trend}>
      <span className={styles.trendLabel}>Last hour</span>
      <Sparkline values={buckets} variant="bars" width={96} height={24} />
      <span className={styles.trendValue}>
        {total} {total === 1 ? "event" : "events"}
      </span>
    </p>
  );
}

/**
 * The Dashboard as pane content (`PaneContent::Dashboard`, Z7-W1): the same live board, sized by
 * its pane (columns follow the pane's width), with its own one-line summary. The pane scrolls.
 */
export function DashboardPane() {
  return (
    <DashboardDataBoundary>
      <div className={styles.pane} data-dashboard-pane>
        <DashboardBoard inPane />
      </div>
      <Announcer />
    </DashboardDataBoundary>
  );
}
