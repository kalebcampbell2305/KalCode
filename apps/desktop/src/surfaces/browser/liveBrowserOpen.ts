import type { PaneContent, PaneLayout, PaneNode } from "@kalcode/protocol";
import {
  addTab,
  allContents,
  findContent,
  insertBeside,
  leaves,
  makeLeaf,
  normalizeNode,
  pathOf,
  validateLayout,
} from "../../shell/panes/model.ts";
import { dispatchPaneCommand, type PaneCommand, type PaneCommandResult } from "../../shell/panes/paneCommands.ts";
import type { PaneController } from "../../shell/panes/usePaneController.ts";
import {
  type BrowserPaneContent,
  browserContent,
  normalizeBrowserAddress,
  persistableBrowserUrl,
} from "./browserModel.ts";

/** The pane command Code handles with `handleOpenLiveBrowser`. */
export type OpenLiveBrowserCommand = Extract<PaneCommand, { kind: "open-live-browser" }>;

/** What a new Live Browser opens beside: a pane, or the pane showing an agent or a terminal. */
export type LiveBrowserAnchor = NonNullable<OpenLiveBrowserCommand["beside"]>;

export interface OpenLiveBrowserRequest {
  workspaceId: string;
  /** Full runtime URL to open (query and fragment kept for this session only). */
  url?: string | null;
  beside?: LiveBrowserAnchor | null;
}

/** A browser column narrower than this is cramped; the Browser then opens as a tab instead. */
export const MIN_LIVE_BROWSER_WIDTH = 440;
/** Share of the canvas a new far-right Live Browser column takes. */
const COLUMN_SHARE = 0.42;

function anchorPaneId(layout: PaneLayout, anchor: LiveBrowserAnchor | null): string | null {
  if (!anchor) return null;
  if ("paneId" in anchor)
    return leaves(layout.root).some((leaf) => leaf.paneId === anchor.paneId) ? anchor.paneId : null;
  const content: PaneContent =
    "agentId" in anchor
      ? { kind: "agent", agentId: anchor.agentId }
      : { kind: "terminal", terminalId: anchor.terminalId };
  const key = content.kind === "agent" ? `agent:${content.agentId}` : `terminal:${content.terminalId}`;
  return findContent(layout, key)?.paneId ?? null;
}

/** Width of a leaf in pixels, from the split ratios along its path. */
export function leafWidth(layout: PaneLayout, paneId: string, canvasWidth: number): number {
  const path = pathOf(layout.root, paneId);
  if (!path) return 0;
  let node: PaneNode = layout.root;
  let width = canvasWidth;
  for (const index of path) {
    if (node.kind !== "split") break;
    if (node.axis === "horizontal") width *= (node.ratios[index] ?? 0) / 1000;
    node = node.children[index] as PaneNode;
  }
  return width;
}

/**
 * Places a new Live Browser: beside the anchor pane when one is given, otherwise as a new column
 * on the far right of the canvas. When there isn't room for a usable column (or the pane limits
 * are reached) it opens as a tab in the anchor (or rightmost) pane instead.
 */
export function placeLiveBrowser(
  layout: PaneLayout,
  content: BrowserPaneContent,
  options: { anchorPaneId?: string | null; canvasWidth: number },
): { layout: PaneLayout; paneId: string } {
  const all = leaves(layout.root);
  const rightmost = all.at(-1);
  const lone = all.length === 1 && rightmost && rightmost.tabs.length === 0 ? rightmost : null;
  // An empty canvas simply shows the Browser.
  if (lone) return { layout: addTab(layout, lone.paneId, content), paneId: lone.paneId };
  const leaf = makeLeaf([content]);
  const anchor = options.anchorPaneId ?? null;
  const fallbackPane = anchor ?? rightmost?.paneId ?? null;
  const tab = () =>
    fallbackPane
      ? { layout: addTab(layout, fallbackPane, content), paneId: fallbackPane }
      : { layout, paneId: leaf.paneId };

  if (anchor) {
    if (leafWidth(layout, anchor, options.canvasWidth) / 2 < MIN_LIVE_BROWSER_WIDTH) return tab();
    const next = insertBeside(layout, anchor, leaf, "right");
    return next === layout ? tab() : { layout: next, paneId: leaf.paneId };
  }
  if (options.canvasWidth * COLUMN_SHARE < MIN_LIVE_BROWSER_WIDTH) return tab();
  const root = layout.root;
  const share = Math.round(COLUMN_SHARE * 1000);
  const candidate: PaneNode =
    root.kind === "split" && root.axis === "horizontal"
      ? {
          kind: "split",
          axis: "horizontal",
          ratios: [...root.ratios.map((ratio) => Math.round((ratio * (1000 - share)) / 1000)), share],
          children: [...root.children, leaf],
        }
      : { kind: "split", axis: "horizontal", ratios: [1000 - share, share], children: [root, leaf] };
  const normalized = normalizeNode(candidate);
  // Ratios must sum to exactly 1000 after rounding.
  if (normalized.kind === "split") {
    const sum = normalized.ratios.reduce((total, ratio) => total + ratio, 0);
    const last = normalized.ratios.length - 1;
    normalized.ratios[last] = (normalized.ratios[last] ?? 0) + (1000 - sum);
  }
  const next: PaneLayout = { ...layout, root: normalized, maximizedPaneId: null };
  return validateLayout(next) === null ? { layout: next, paneId: leaf.paneId } : tab();
}

/**
 * Opens a Live Browser in the Code canvas of `workspaceId`, beside an agent, terminal or pane
 * when given (far right otherwise). Works from anywhere: it queues until that canvas is on screen.
 */
export function openLiveBrowser(request: OpenLiveBrowserRequest): PaneCommandResult {
  let url: string | null = null;
  if (request.url) {
    try {
      url = normalizeBrowserAddress(request.url);
    } catch {
      return { handled: false, message: "That address can't open in Live Browser." };
    }
  }
  const command: OpenLiveBrowserCommand = { kind: "open-live-browser", url, beside: request.beside ?? null };
  return dispatchPaneCommand(command, {
    scope: request.workspaceId,
    queue: true,
    onResult: (result) => {
      // A canvas that predates Live Browser placement still opens one with the classic command.
      if (!result.handled && result.message === UNHANDLED) {
        dispatchPaneCommand(
          { kind: "browser-control", command: { kind: "open", url, newPane: true } },
          { scope: request.workspaceId, queue: true },
        );
      }
    },
  });
}

/** What PaneCanvas answers when its host doesn't handle `open-live-browser` yet. */
const UNHANDLED = "Live Browser isn't available here.";

/**
 * Code's handler for `open-live-browser`: shows an existing Live Browser for the same address,
 * else places a new one (see `placeLiveBrowser`) and focuses it. `initialUrls` receives the full
 * runtime URL; the persisted layout keeps only its query-free form.
 */
export function handleOpenLiveBrowser(
  command: OpenLiveBrowserCommand,
  controller: PaneController,
  initialUrls: Map<string, string>,
): PaneCommandResult {
  const layout = controller.layout;
  if (command.url) {
    const wanted = persistableBrowserUrl(command.url);
    const existing = allContents(layout).find(
      (content): content is BrowserPaneContent => content.kind === "browser" && content.url === wanted,
    );
    if (existing) {
      const found = findContent(layout, `browser:${existing.browserId}`);
      if (found) {
        controller.show(existing, { paneId: found.paneId, focus: true });
        return { handled: true, message: "Live Browser is already showing that page." };
      }
    }
  }
  const content = browserContent(undefined, command.url ? persistableBrowserUrl(command.url) : null);
  if (command.url) initialUrls.set(content.browserId, command.url);
  const placed = placeLiveBrowser(layout, content, {
    anchorPaneId: anchorPaneId(layout, command.beside),
    canvasWidth: controller.size.current.width,
  });
  if (placed.layout === layout) {
    controller.show(content, { focus: true, placement: "split" });
  } else {
    controller.replace(placed.layout, "Opened Live Browser.");
    controller.focusPane(placed.paneId);
  }
  return { handled: true };
}
