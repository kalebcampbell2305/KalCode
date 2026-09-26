import type { PaneContent, PaneLayout } from "@kalcode/protocol";
import { findLeaf, leaves } from "../../shell/panes/model.ts";

export type BrowserTarget = { paneId: string; content: Extract<PaneContent, { kind: "browser" }> };

/** Resolve explicit or focused identity; multiple unfocused browsers never imply a target. */
export function resolveBrowserTarget(
  layout: PaneLayout,
  focusedPaneId: string | null,
  browserId: string | null,
): BrowserTarget | null {
  const candidates = leaves(layout.root).flatMap((pane) =>
    pane.tabs.flatMap((content) => (content.kind === "browser" ? [{ paneId: pane.paneId, content }] : [])),
  );
  if (browserId) return candidates.find((item) => item.content.browserId === browserId) ?? null;
  const focused = focusedPaneId ? findLeaf(layout, focusedPaneId) : null;
  const active = focused?.tabs[focused.activeTab];
  if (focused && active?.kind === "browser") return { paneId: focused.paneId, content: active };
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}
