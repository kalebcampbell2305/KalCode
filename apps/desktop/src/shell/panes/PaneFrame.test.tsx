import type { PaneContent } from "@kalcode/protocol";
import { TooltipProvider } from "@kalcode/ui/components";
import { render } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { TabInfo } from "./contentRegistry.ts";
import { contentKey, type LeafNode, makeLeaf } from "./model.ts";
import { PaneFrame, type PaneFrameProps } from "./PaneFrame.tsx";

const terminal = (terminalId: string): PaneContent => ({ kind: "terminal", terminalId });
const browser: PaneContent = { kind: "browser", browserId: "web", url: null };

function setup() {
  const describe = (content: PaneContent): TabInfo => ({
    title: contentKey(content),
    glyph: null,
    terminal: content.kind === "terminal",
  });
  const props = (leaf: LeafNode, extra: Partial<PaneFrameProps> = {}): PaneFrameProps => ({
    leaf,
    index: 0,
    count: 2,
    rect: { x: 0, y: 0, width: 800, height: 600 },
    collapsedStrip: false,
    hidden: false,
    maximized: false,
    focused: true,
    kalVoiceTarget: false,
    focusRequest: 0,
    canSplit: true,
    canCollapse: true,
    multiple: true,
    dropTarget: false,
    tabs: leaf.tabs.map(describe),
    renderEmpty: () => <p>Empty</p>,
    addMenu: () => null,
    onFocus: vi.fn(),
    onActivate: vi.fn(),
    onCloseTab: vi.fn(),
    onSplit: vi.fn(),
    onMaximize: vi.fn(),
    onCollapse: vi.fn(),
    onClose: vi.fn(),
    onDock: vi.fn(),
    onSwap: vi.fn(),
    onTabPointerDown: vi.fn(),
    onHeaderPointerDown: vi.fn(),
    consumeClick: () => false,
    ...extra,
  });
  const tabs = [terminal("a"), terminal("b"), browser];
  const leaf = (activeTab: number, collapsed = false): LeafNode => ({
    ...makeLeaf(tabs, "pane", activeTab),
    collapsed,
  });
  const view = render(
    <TooltipProvider>
      <PaneFrame {...props(leaf(0))} />
    </TooltipProvider>,
  );
  const show = (next: LeafNode, extra: Partial<PaneFrameProps> = {}) =>
    view.rerender(
      <TooltipProvider>
        <PaneFrame {...props(next, extra)} />
      </TooltipProvider>,
    );
  return { leaf, show, view };
}

it("keeps the content slot in the pane while minimizing, hiding and restoring", () => {
  const { leaf, show, view } = setup();
  const slot = view.container.querySelector("[data-pane-body]");
  expect(slot).toHaveAttribute("id", "pane-pane-body");
  show(leaf(1));
  expect(view.container.querySelector("[data-pane-body]")).toBe(slot);
  show(leaf(1), { hidden: true });
  expect(slot).toHaveAttribute("hidden");
  show(leaf(1, true));
  expect(view.container.querySelector("[data-pane-body]")).toBe(slot);
  expect(slot).toHaveAttribute("hidden");
  show(leaf(1));
  expect(slot).not.toHaveAttribute("hidden");
});

it("exposes the selected tab and its persistent content panel relationship", () => {
  const { leaf, show, view } = setup();
  show(leaf(2));
  const tab = view.getByRole("tab", { name: "browser:web" });
  expect(tab).toHaveAttribute("aria-selected", "true");
  expect(tab).toHaveAttribute("aria-controls", "pane-pane-panel");
});
