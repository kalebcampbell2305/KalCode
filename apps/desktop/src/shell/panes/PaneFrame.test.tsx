import type { PaneContent } from "@kalcode/protocol";
import { TooltipProvider } from "@kalcode/ui/components";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { FAVORITES_STORAGE_KEY } from "../favorites/store.ts";
import type { TabInfo } from "./contentRegistry.ts";
import { contentKey, type LeafNode, makeLeaf } from "./model.ts";
import { PaneFrame, type PaneFrameProps } from "./PaneFrame.tsx";

const terminal = (terminalId: string): PaneContent => ({ kind: "terminal", terminalId });
const browser: PaneContent = { kind: "browser", browserId: "web", url: null };

it("pins a terminal tab using its canvas workspace without activating or closing it", async () => {
  localStorage.removeItem(FAVORITES_STORAGE_KEY);
  const activate = vi.fn();
  const close = vi.fn();
  const drag = vi.fn();
  setup({ workspaceId: "canvas-workspace", onActivate: activate, onCloseTab: close, onTabPointerDown: drag });
  const favorite = screen.getByRole("button", { name: "Pin globally: terminal:a" });
  expect(favorite.closest('[role="tab"]')).toBeNull();
  fireEvent.pointerDown(favorite);
  fireEvent.mouseDown(favorite, { button: 1 });
  fireEvent.keyDown(favorite, { key: "Delete" });
  fireEvent.click(favorite);
  expect(JSON.parse(localStorage.getItem(FAVORITES_STORAGE_KEY) ?? "{}").entries).toEqual([
    expect.objectContaining({ target: { kind: "terminal", id: "a", workspaceId: "canvas-workspace" }, scopeId: null }),
  ]);
  expect(activate).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
  expect(drag).not.toHaveBeenCalled();
  fireEvent.keyDown(favorite, { key: "F10", shiftKey: true });
  expect(await screen.findByRole("menuitem", { name: "Unpin globally" })).toBeInTheDocument();
});

function setup(initial: Partial<PaneFrameProps> = {}) {
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
      <PaneFrame {...props(leaf(0), initial)} />
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

it("targets the right-clicked inactive terminal tab without switching tabs", async () => {
  const action = vi.fn();
  const activate = vi.fn();
  const { view } = setup({
    onActivate: activate,
    contextMenu: (content, paneId) => [
      { id: "stop", label: "Stop terminal", onSelect: () => action(contentKey(content), paneId) },
    ],
  });
  const inactive = view.container.querySelector('[data-content-key="terminal:b"]');
  expect(inactive).not.toBeNull();
  fireEvent.contextMenu(inactive as Element);
  fireEvent.click(await screen.findByRole("menuitem", { name: "Stop terminal" }));
  expect(action).toHaveBeenCalledWith("terminal:b", "pane");
  expect(activate).not.toHaveBeenCalled();
});

it("opens terminal actions from the keyboard and preserves its tab role and label", async () => {
  const action = vi.fn();
  const { view } = setup({
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

it("highlights a completed inactive agent without changing selection or keyboard focus", () => {
  const activate = vi.fn();
  const focus = vi.fn();
  const seen = vi.fn();
  const { leaf, show, view } = setup();
  const input = document.createElement("input");
  document.body.append(input);
  input.value = "unfinished prompt";
  input.focus();
  input.setSelectionRange(3, 8);
  show(leaf(0), {
    focused: false,
    onActivate: activate,
    onFocus: focus,
    tabs: [
      { title: "Current terminal", glyph: null, terminal: true },
      { title: "Finished agent", glyph: null, terminal: true, attention: "completed", onAttentionSeen: seen },
      { title: "Browser", glyph: null },
    ],
  });
  const tab = view.getByRole("tab", { name: "Finished agent Done" });
  expect(tab).toHaveAttribute("data-attention", "completed");
  expect(tab).toHaveAttribute("aria-selected", "false");
  expect(view.container.querySelector("[data-pane-id]")).toHaveAttribute("data-attention", "completed");
  expect(document.activeElement).toBe(input);
  expect(input.selectionStart).toBe(3);
  expect(input.selectionEnd).toBe(8);
  expect(activate).not.toHaveBeenCalled();
  expect(focus).not.toHaveBeenCalled();
  expect(seen).not.toHaveBeenCalled();
  fireEvent.click(tab);
  expect(seen).toHaveBeenCalledOnce();
  expect(activate).toHaveBeenCalledWith(1, true);
  input.remove();
});

it("keeps Needs You visible in a collapsed pane without expanding it", () => {
  const expand = vi.fn();
  const { leaf, show, view } = setup();
  show(leaf(0, true), {
    onCollapse: expand,
    tabs: [
      { title: "Current terminal", glyph: null },
      { title: "Waiting agent", glyph: null, attention: "needs-you" },
    ],
  });
  expect(view.getByText("Needs You")).toHaveAttribute("title", "Waiting agent: Needs You");
  expect(view.container.querySelector("[data-pane-id]")).toHaveAttribute("data-attention", "needs-you");
  expect(expand).not.toHaveBeenCalled();
});
