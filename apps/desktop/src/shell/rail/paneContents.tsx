/**
 * Z7-W2 surfaces hosted by the pane system (Z7-W1): Home, the project page and the workspace
 * list as widgets, and the read-only Git status as the canvas's Git content. Registered once,
 * when the shell loads; W1's canvas lists the widgets in its "add to pane" menu and restores
 * them from saved layouts. Opening them from elsewhere goes through `useOpenInPane`.
 */
import { FolderGit2, FolderTree, GitCommitHorizontal, House } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";
import { FolderSurface, GitPane } from "../../surfaces/folder/FolderSurface.tsx";
import { HomeSurface } from "../../surfaces/home/HomeSurface.tsx";
import type { PaneRenderContext } from "../panes/contentRegistry.ts";
import { registerPaneContent, registerPaneWidget } from "../panes/contentRegistry.ts";
import styles from "./PaneHost.module.css";
import { HOME_WIDGET, PROJECT_WIDGET, WORKSPACES_WIDGET } from "./paneIds.ts";
import { InPane } from "./surfaceScope.tsx";
import { WorkspacesPane } from "./WorkspaceRail.tsx";

/**
 * A scrolling pane body that takes focus when the canvas asks it to. A read-only body (nothing
 * focusable inside) is a tab stop itself, so the keyboard can scroll it.
 */
function PaneScroll({
  context,
  fill,
  readOnly,
  children,
}: {
  context: PaneRenderContext;
  fill?: boolean;
  readOnly?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (context.focusRequest > 0) ref.current?.focus({ preventScroll: true });
  }, [context.focusRequest]);
  const className = fill ? styles.fill : styles.scroll;
  return readOnly ? (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region with nothing focusable inside must take focus to scroll.
    <section ref={ref} className={className} tabIndex={0} aria-label={readOnly} data-pane-surface>
      <InPane>{children}</InPane>
    </section>
  ) : (
    <div ref={ref} className={className} tabIndex={-1} data-pane-surface>
      <InPane>{children}</InPane>
    </div>
  );
}

registerPaneWidget(HOME_WIDGET, {
  describe: () => ({ title: "Home", glyph: <House />, statusText: "What needs you and recent work" }),
  render: (_content, context) => (
    <PaneScroll context={context}>
      <HomeSurface />
    </PaneScroll>
  ),
});

registerPaneWidget(PROJECT_WIDGET, {
  describe: () => ({ title: "Project", glyph: <FolderGit2 />, statusText: "Files, Git and threads of this workspace" }),
  render: (_content, context) => (
    <PaneScroll context={context}>
      <FolderSurface />
    </PaneScroll>
  ),
});

registerPaneWidget(WORKSPACES_WIDGET, {
  describe: () => ({ title: "Workspaces", glyph: <FolderTree />, statusText: "Pinned, folders and recent workspaces" }),
  render: (_content, context) => (
    <PaneScroll context={context} fill>
      <WorkspacesPane />
    </PaneScroll>
  ),
});

registerPaneContent("git", {
  describe: () => ({ title: "Git", glyph: <GitCommitHorizontal />, statusText: "Read-only status" }),
  render: (content, context) => (
    <PaneScroll context={context} readOnly="Git status">
      <GitPane workspaceId={content.workspaceId} />
    </PaneScroll>
  ),
});
