/**
 * What a pane can show, and how. The surface hosting the canvas (Code) describes and renders the
 * contents it owns (terminals, threads); other surfaces plug their contents in here without
 * touching the pane system:
 *
 *   registerPaneContent("dashboard", { describe, render })       // Z7-W3: the live Dashboard
 *   registerPaneWidget("approvals", { describe, render })         // Z7-W3: dockable widgets
 *
 * Until something is registered for a kind, the canvas shows an honest built-in state for it.
 */
import type { PaneContent, StatusTone } from "@kalcode/protocol";
import type { ReactNode } from "react";

export type PaneAttention = "completed" | "needs-you";

/** How a content item looks in its pane's tab strip. */
export interface TabInfo {
  /** Visible and accessible name of the tab (for example "PowerShell 7"). */
  title: string;
  /** Decorative glyph (provider identity or an icon). */
  glyph: ReactNode;
  /** Status tone for the tab's dot (paired with `stateLabel` / `statusText`, never alone). */
  tone?: StatusTone;
  /** Short state word shown in the tab (for example "Ended"). */
  stateLabel?: string;
  /** An unseen lifecycle change. Visual emphasis only; never a keyboard or native focus request. */
  attention?: PaneAttention;
  /** Called only when the person interacts with this tab or its visible content. */
  onAttentionSeen?: () => void;
  /** Longer status for the tab's tooltip and the pane's label (for example "Running"). */
  statusText?: string;
  /** The content draws on the terminal background (terminals, provider TUIs). */
  terminal?: boolean;
  /** Contextual controls beside the active tab (for example terminal image input). */
  actions?: ReactNode;
  /** An explicit stop for the content's process, offered in the pane menu (never on close). */
  stop?: { label: string; run: () => void };
  /**
   * What closing the tab does. Default: the tab leaves the layout and anything it runs keeps
   * running in the background. Contents with nothing running (an exited shell) may clean up.
   */
  onClose?: () => void;
  /** Running in the background when not shown (listed under "Running in the background"). */
  running?: boolean;
}

/** What a content body gets from the canvas. */
export interface PaneRenderContext {
  paneId: string;
  /** DOM id of the tab that labels this content's panel. */
  tabId: string;
  /** The pane has focus: output renders live. Unfocused panes are throttled. */
  focused: boolean;
  /** False while tabbed behind other work, minimized, docked or covered by a maximized pane. */
  visible?: boolean;
  /** Changes whenever the content should take keyboard focus. */
  focusRequest: number;
}

export interface PaneContentRenderer<C extends PaneContent = PaneContent> {
  describe(content: C): TabInfo;
  render(content: C, context: PaneRenderContext): ReactNode;
}

type Kind = PaneContent["kind"];
type ContentOf<K extends Kind> = Extract<PaneContent, { kind: K }>;

const renderers = new Map<Kind, PaneContentRenderer>();
const widgets = new Map<string, PaneContentRenderer<ContentOf<"widget">>>();
const listeners = new Set<() => void>();

function changed() {
  for (const listener of listeners) listener();
}

/**
 * Registers how a content kind is shown in panes (for kinds the hosting surface doesn't own,
 * such as the Dashboard). Returns a function that removes the registration.
 */
export function registerPaneContent<K extends Exclude<Kind, "widget">>(
  kind: K,
  renderer: PaneContentRenderer<ContentOf<K>>,
): () => void {
  renderers.set(kind, renderer as unknown as PaneContentRenderer);
  changed();
  return () => {
    if (renderers.get(kind) === (renderer as unknown as PaneContentRenderer)) {
      renderers.delete(kind);
      changed();
    }
  };
}

/** Registers a widget (Z7-W3's widget framework) so it can be shown in a pane or the dock. */
export function registerPaneWidget(widgetId: string, renderer: PaneContentRenderer<ContentOf<"widget">>): () => void {
  widgets.set(widgetId, renderer);
  changed();
  return () => {
    if (widgets.get(widgetId) === renderer) {
      widgets.delete(widgetId);
      changed();
    }
  };
}

export function registeredRenderer(content: PaneContent): PaneContentRenderer | null {
  if (content.kind === "widget") return (widgets.get(content.widgetId) as PaneContentRenderer | undefined) ?? null;
  return renderers.get(content.kind) ?? null;
}

/** Registered widgets (for "add to pane" menus). */
export function registeredWidgets(): { widgetId: string; title: string }[] {
  return [...widgets.entries()].map(([widgetId, r]) => ({
    widgetId,
    title: r.describe({ kind: "widget", widgetId }).title,
  }));
}

export function isRegistered(kind: Exclude<Kind, "widget">): boolean {
  return renderers.has(kind);
}

/** Subscribes to registration changes (the canvas re-renders when a surface registers). */
export function subscribeRegistry(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
