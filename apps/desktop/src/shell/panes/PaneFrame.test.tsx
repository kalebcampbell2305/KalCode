import type { PaneContent } from "@kalcode/protocol";
import { TooltipProvider } from "@kalcode/ui/components";
import { fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { expect, it, vi } from "vitest";
import type { PaneRenderContext, TabInfo } from "./contentRegistry.ts";
import { contentKey, type LeafNode, makeLeaf } from "./model.ts";
import { PaneFrame, type PaneFrameProps } from "./PaneFrame.tsx";

const terminal = (terminalId: string): PaneContent => ({ kind: "terminal", terminalId });
const browser: PaneContent = { kind: "browser", browserId: "web", url: null };

function setup(initial: Partial<PaneFrameProps> = {}) {
  const mounts = new Map<string, number>();
  const contexts = new Map<string, PaneRenderContext>();
  function Body({ id, context }: { id: string; context: PaneRenderContext }) {
    contexts.set(id, context);
    useEffect(() => {
      mounts.set(id, (mounts.get(id) ?? 0) + 1);
    }, [id]);
    return <div data-testid={id}>{id}</div>;
  }
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
    renderContent: (content, context) => <Body id={contentKey(content)} context={context} />,
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
      <PaneFrame {...props(leaf(0), initial)} />
    </TooltipProvider>,
  );
  const show = (next: LeafNode, extra: Partial<PaneFrameProps> = {}) =>
    view.rerender(
      <TooltipProvider>
        <PaneFrame {...props(next, extra)} />
      </TooltipProvider>,
    );
  const visiblePanels = () => [...view.container.querySelectorAll('[role="tabpanel"]:not([hidden])')];
  return { mounts, contexts, leaf, show, view, visiblePanels };
}

it("keeps terminal tabs mounted across tab switches, maximize and collapse, with one visible panel", () => {
  const { mounts, contexts, leaf, show, view, visiblePanels } = setup();
  const a = contentKey(terminal("a"));
  const b = contentKey(terminal("b"));
  show(leaf(1));
  show(leaf(0));
  show(leaf(1));
  expect(mounts.get(a)).toBe(1);
  expect(mounts.get(b)).toBe(1);
  expect(visiblePanels()).toHaveLength(1);
  expect(visiblePanels()[0]?.contains(view.getByTestId(b))).toBe(true);
  expect(visiblePanels()[0]?.id).toBe("pane-pane-panel");
  // The terminal behind the one in front renders throttled and takes no focus requests.
  expect(contexts.get(a)).toMatchObject({ focused: false, focusRequest: 0 });
  expect(contexts.get(b)).toMatchObject({ focused: true });

  show(leaf(1), { hidden: true });
  expect(visiblePanels()).toHaveLength(0);
  show(leaf(1, true));
  expect(visiblePanels()).toHaveLength(0);
  show(leaf(1));
  expect(mounts.get(a)).toBe(1);
  expect(mounts.get(b)).toBe(1);
  expect(visiblePanels()).toHaveLength(1);
});

it("targets the right-clicked inactive terminal tab without switching or remounting terminals", async () => {
  const action = vi.fn();
  const activate = vi.fn();
  const options: Partial<PaneFrameProps> = {
    onActivate: activate,
    contextMenu: (content, paneId) => [
      { id: "stop", label: "Stop terminal", onSelect: () => action(contentKey(content), paneId) },
    ],
  };
  const { leaf, show, mounts, view } = setup(options);
  show(leaf(0), options);
  const inactive = view.container.querySelector('[data-content-key="terminal:b"]');
  expect(inactive).not.toBeNull();
  fireEvent.contextMenu(inactive as Element);
  fireEvent.click(await screen.findByRole("menuitem", { name: "Stop terminal" }));
  expect(action).toHaveBeenCalledWith("terminal:b", "pane");
  expect(activate).not.toHaveBeenCalled();
  expect(mounts.get("terminal:b")).toBeUndefined();
  expect(mounts.get("terminal:a")).toBe(1);
  show(leaf(0), { ...options, contextMenu: () => [] });
  show(leaf(0), options);
  expect(mounts.get("terminal:a")).toBe(1);
});

it("opens terminal actions from the keyboard and preserves its tab role and label", async () => {
  const { leaf, show, view } = setup();
  const action = vi.fn();
  show(leaf(0), {
    contextMenu: (content) => [{ id: "focus", label: "Focus", onSelect: () => action(contentKey(content)) }],
  });
  const tab = view.container.querySelector('[data-content-key="terminal:a"]') as HTMLElement;
  tab.focus();
  fireEvent.keyDown(tab, { key: "F10", shiftKey: true });
  expect(await screen.findByRole("menu", { name: "terminal:a actions" })).toBeVisible();
  fireEvent.click(screen.getByRole("menuitem", { name: "Focus" }));
  expect(action).toHaveBeenCalledWith("terminal:a");
  expect(tab).toHaveAttribute("role", "tab");
});

it("renders other contents only while they are in front", () => {
  const { mounts, leaf, show, view, visiblePanels } = setup();
  const web = contentKey(browser);
  show(leaf(2));
  expect(view.getByTestId(web)).toBeInTheDocument();
  expect(visiblePanels()).toHaveLength(1);
  show(leaf(0));
  expect(view.queryByTestId(web)).toBeNull();
  show(leaf(2));
  expect(mounts.get(web)).toBe(2);
});
