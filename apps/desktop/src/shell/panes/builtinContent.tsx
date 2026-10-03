/**
 * What the canvas shows for contents no surface has registered yet. Honest states only: a pane
 * never pretends to be something that isn't built (ADVANCED.md §16.4: browser and Git panes are
 * "unavailable until built"; the Dashboard pane is provided by Z7-W3 through the registry).
 */
import type { PaneContent } from "@kalcode/protocol";
import { Badge, Button } from "@kalcode/ui/components";
import { CircleSlash, GitBranch, Globe, LayoutDashboard, Puzzle } from "lucide-react";
import type { ReactNode } from "react";
import { useNavigation } from "../navigation.tsx";
import type { TabInfo } from "./contentRegistry.ts";
import styles from "./PaneCanvas.module.css";

export function describeBuiltin(content: PaneContent): TabInfo {
  switch (content.kind) {
    case "dashboard":
      return { title: "Dashboard", glyph: <LayoutDashboard />, statusText: "Opens the Dashboard" };
    case "browser":
      return { title: "Browser", glyph: <Globe />, stateLabel: "Coming", statusText: "Not in this build" };
    case "git":
      return { title: "Git", glyph: <GitBranch />, stateLabel: "Coming", statusText: "Not in this build" };
    case "widget":
      return { title: "Widget", glyph: <Puzzle />, stateLabel: "Unavailable", statusText: "Not in this build" };
    case "thread":
      return { title: "Thread", glyph: <CircleSlash />, stateLabel: "Unavailable", statusText: "Not found" };
    case "agent":
      return { title: "Coding agent", glyph: <CircleSlash />, stateLabel: "Unavailable", statusText: "Not found" };
    case "terminal":
      return { title: "Terminal", glyph: <CircleSlash />, stateLabel: "Unavailable", statusText: "Not found" };
    default:
      return { title: "Unavailable", glyph: <CircleSlash />, stateLabel: "Unavailable" };
  }
}

export function PaneNotice({
  icon,
  title,
  badge,
  children,
  actions,
}: {
  icon: ReactNode;
  title: string;
  badge?: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className={styles.notice}>
      <span className={styles.noticeArt} aria-hidden="true">
        {icon}
      </span>
      <div className={styles.noticeText}>
        <h3 className={styles.noticeTitle}>
          {title}
          {badge ? <Badge tone="outline">{badge}</Badge> : null}
        </h3>
        <div className={styles.noticeBody}>{children}</div>
        {actions ? <div className={styles.noticeActions}>{actions}</div> : null}
      </div>
    </div>
  );
}

function DashboardNotice() {
  const { navigate } = useNavigation();
  return (
    <PaneNotice
      icon={<LayoutDashboard />}
      title="Dashboard"
      actions={
        <Button size="sm" onClick={() => navigate("dashboard")}>
          Open Dashboard
        </Button>
      }
    >
      <p>
        The live Dashboard docks into panes once its pane view is part of this build. Until then it opens as a page.
      </p>
    </PaneNotice>
  );
}

export function renderBuiltin(content: PaneContent): ReactNode {
  switch (content.kind) {
    case "dashboard":
      return <DashboardNotice />;
    case "browser":
      return (
        <PaneNotice icon={<Globe />} title="Browser preview" badge="Coming">
          <p>Previewing a local app in a pane isn't in this build yet. This pane keeps its place in the layout.</p>
        </PaneNotice>
      );
    case "git":
      return (
        <PaneNotice icon={<GitBranch />} title="Git" badge="Coming">
          <p>The Git pane isn't in this build yet. This pane keeps its place in the layout.</p>
        </PaneNotice>
      );
    case "widget":
      return (
        <PaneNotice icon={<Puzzle />} title="Widget unavailable">
          <p>This widget isn't part of this build. Close the tab or replace it.</p>
        </PaneNotice>
      );
    default:
      return (
        <PaneNotice icon={<CircleSlash />} title="Unavailable">
          <p>What this tab showed no longer exists. Close the tab to tidy up.</p>
        </PaneNotice>
      );
  }
}
