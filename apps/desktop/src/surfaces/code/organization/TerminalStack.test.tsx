import type { PaneContent } from "@kalcode/protocol";
import { TooltipProvider } from "@kalcode/ui/components";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeLeaf } from "../../../shell/panes/model.ts";
import type { PaneController } from "../../../shell/panes/usePaneController.ts";
import type { OrgItem } from "./model.ts";
import { useOrgPrefs } from "./prefs.ts";
import { TerminalStack } from "./TerminalStack.tsx";
import type { Organization } from "./useOrganization.ts";

const item = (id: string, group: OrgItem["group"] = "Terminals"): OrgItem => ({
  key: `terminal:${id}`,
  content: { kind: "terminal", terminalId: id },
  kind: "terminal",
  title: `Shell ${id}`,
  status: { badge: "working", detail: "Running" },
  group,
  glyph: "shell",
  order: id,
});

const controller = {
  layout: { root: makeLeaf([]) },
  focusedPaneId: null,
  show: vi.fn(),
  announce: vi.fn(),
} as unknown as PaneController;

function Stack({ initial, rename }: { initial: OrgItem[]; rename?: (c: PaneContent, n: string) => Promise<void> }) {
  const prefs = useOrgPrefs("ws-stack");
  const [items, setItems] = useState(initial);
  const organization = { items, prefs } as unknown as Organization;
  // The real rename path updates the live title; mirror that here.
  const renameAndUpdate = rename
    ? async (content: PaneContent, name: string) => {
        await rename(content, name);
        setItems((current) =>
          current.map((i) => (JSON.stringify(i.content) === JSON.stringify(content) ? { ...i, title: name } : i)),
        );
      }
    : undefined;
  return (
    <TooltipProvider>
      <TerminalStack organization={organization} controller={controller} rename={renameAndUpdate} />
    </TooltipProvider>
  );
}

const stored = () => JSON.parse(window.localStorage.getItem("kalcode.code.organization.ws-stack") ?? "{}");
const four = () => ["1", "2", "3", "4"].map((id) => item(id));
const rowNames = () =>
  screen
    .getAllByRole("button", { name: /^Shell \d, terminal/ })
    .map((b) => b.getAttribute("aria-label")?.split(",")[0]);

beforeEach(() => {
  window.localStorage.clear();
  vi.mocked(controller.show).mockClear();
});

describe("TerminalStack", () => {
  it("saves an unchanged agent name to preserve explicit manual ownership", async () => {
    const user = userEvent.setup();
    const rename = vi.fn(async () => {});
    const agent = {
      ...item("1"),
      key: "agent:a",
      content: { kind: "agent", agentId: "a" } as PaneContent,
      kind: "agent" as const,
      title: "Codex",
    };
    render(<Stack initial={[agent]} rename={rename} />);
    await user.click(screen.getByRole("button", { name: /^Show the terminal stack/ }));
    await user.dblClick(screen.getByRole("button", { name: /^Codex, coding agent/ }));
    await user.keyboard("{Enter}");
    expect(rename).toHaveBeenCalledWith({ kind: "agent", agentId: "a" }, "Codex");
  });

  it("moves focus into the narrow-canvas overlay and back to the rail when Escape closes it", async () => {
    const user = userEvent.setup();
    render(<Stack initial={four()} />);
    const rail = screen.getByRole("button", { name: /^Show the terminal stack/ });
    const stack = screen.getByRole("complementary", { name: "Terminal stack" });

    await user.click(rail);
    expect(rail).toHaveAttribute("aria-expanded", "true");
    await waitFor(() => expect(stack).toHaveFocus());
    await user.keyboard("{Escape}");
    expect(rail).toHaveAttribute("aria-expanded", "false");
    expect(rail).toHaveFocus();

    // Escape also closes it while focus is still on the rail.
    await user.click(rail);
    rail.focus();
    await user.keyboard("{Escape}");
    expect(rail).toHaveAttribute("aria-expanded", "false");
  });

  it("offers Move to group only while the stack is grouped", async () => {
    const user = userEvent.setup();
    render(<Stack initial={four()} rename={async () => {}} />);
    await user.click(screen.getByRole("button", { name: "Show one stack" }));
    await user.click(screen.getByRole("button", { name: "More for Shell 1" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).queryByRole("menuitem", { name: "Move to group" })).not.toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Rename" })).toBeInTheDocument();
  });

  it("renames an item inline on double-click; Enter saves through the canonical rename", async () => {
    const user = userEvent.setup();
    const rename = vi.fn(async () => {});
    render(<Stack initial={four()} rename={rename} />);
    await user.dblClick(screen.getByRole("button", { name: /^Shell 2, terminal/ }));
    const field = screen.getByRole("textbox", { name: "Name of Shell 2" });
    expect(field).toHaveFocus();
    await user.keyboard("Test PC{Enter}");
    expect(rename).toHaveBeenCalledWith({ kind: "terminal", terminalId: "2" }, "Test PC");
    expect(await screen.findByRole("button", { name: /^Test PC, terminal/ })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("F2 renames the focused item; Escape cancels without saving", async () => {
    const user = userEvent.setup();
    const rename = vi.fn(async () => {});
    render(<Stack initial={four()} rename={rename} />);
    screen.getByRole("button", { name: /^Shell 3, terminal/ }).focus();
    await user.keyboard("{F2}");
    await user.keyboard("Nope{Escape}");
    expect(rename).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: /^Shell 3, terminal/ })).toHaveFocus());
  });

  it("renames a group inline, and the name persists by id", async () => {
    const user = userEvent.setup();
    render(<Stack initial={four()} />);
    screen.getByRole("button", { name: /^Terminals/ }).focus();
    await user.keyboard("{F2}");
    await user.keyboard("Backend shells{Enter}");
    expect(screen.getByRole("button", { name: /^Backend shells/ })).toBeInTheDocument();
    expect(stored().groupLabels).toEqual({ Terminals: "Backend shells" });
  });

  it("+ New group creates a group with its name ready to type", async () => {
    const user = userEvent.setup();
    render(<Stack initial={four()} />);
    await user.click(screen.getByRole("button", { name: "New group" }));
    const field = screen.getByRole("textbox", { name: "Name of the New group group" });
    expect(field).toHaveFocus();
    await user.keyboard("Website{Enter}");
    expect(screen.getByRole("region", { name: "Website group" })).toHaveTextContent("Empty. Drag items here.");
    expect(stored().customGroups).toEqual([{ id: expect.stringMatching(/^g:/), name: "Website" }]);
  });

  it("Alt+Arrow reorders items by keyboard and the order persists", async () => {
    const user = userEvent.setup();
    render(<Stack initial={four()} />);
    expect(rowNames()).toEqual(["Shell 1", "Shell 2", "Shell 3", "Shell 4"]);
    screen.getByRole("button", { name: /^Shell 3, terminal/ }).focus();
    await user.keyboard("{Alt>}{ArrowUp}{/Alt}");
    expect(rowNames()).toEqual(["Shell 1", "Shell 3", "Shell 2", "Shell 4"]);
    expect(stored().itemOrder).toEqual(["terminal:1", "terminal:3", "terminal:2", "terminal:4"]);
  });

  it("drags an item into an empty group past a movement threshold, without showing the pane", async () => {
    const user = userEvent.setup();
    render(<Stack initial={four()} />);
    await user.click(screen.getByRole("button", { name: "New group" }));
    await user.keyboard("Website{Enter}");
    const source = screen.getByRole("button", { name: /^Shell 4, terminal/ });
    const target = screen.getByRole("region", { name: "Website group" });
    // jsdom has no layout: every point is over the Website group.
    document.elementFromPoint = () => target;
    try {
      fireEvent.pointerDown(source, { pointerId: 1, button: 0, buttons: 1, isPrimary: true, clientX: 10, clientY: 10 });
      // A wobble under the threshold never starts a drag.
      fireEvent.pointerMove(source, { pointerId: 1, buttons: 1, clientX: 12, clientY: 11 });
      expect(screen.getByRole("complementary", { name: "Terminal stack" })).not.toHaveAttribute("data-dragging");
      fireEvent.pointerMove(source, { pointerId: 1, buttons: 1, clientX: 10, clientY: 60 });
      expect(screen.getByRole("complementary", { name: "Terminal stack" })).toHaveAttribute("data-dragging", "item");
      // The empty group offers one large, labelled target.
      expect(within(target).getByText("Move to Website")).toBeInTheDocument();
      fireEvent.pointerUp(source, { pointerId: 1, clientX: 10, clientY: 60 });
      fireEvent.click(source);
    } finally {
      // @ts-expect-error restoring jsdom, which has no elementFromPoint
      delete document.elementFromPoint;
    }
    await act(async () => {});
    const website = screen.getByRole("region", { name: "Website group" });
    expect(within(website).getByRole("button", { name: /^Shell 4, terminal in Website/ })).toBeInTheDocument();
    expect(controller.show).not.toHaveBeenCalled();
    const groupId = stored().customGroups[0].id;
    expect(stored().groupOf).toEqual({ "terminal:4": groupId });
  });
});
