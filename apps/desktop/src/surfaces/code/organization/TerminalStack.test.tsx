import { TooltipProvider } from "@kalcode/ui/components";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeLeaf } from "../../../shell/panes/model.ts";
import type { PaneController } from "../../../shell/panes/usePaneController.ts";
import type { OrgItem } from "./model.ts";
import { useOrgPrefs } from "./prefs.ts";
import { TerminalStack } from "./TerminalStack.tsx";
import type { Organization } from "./useOrganization.ts";

const item = (id: string): OrgItem => ({
  key: `terminal:${id}`,
  content: { kind: "terminal", terminalId: id },
  kind: "terminal",
  title: `Shell ${id}`,
  status: { badge: "working", detail: "Running" },
  group: "Terminals",
  glyph: "shell",
  order: id,
});

const controller = {
  layout: { root: makeLeaf([]) },
  focusedPaneId: null,
  show: vi.fn(),
} as unknown as PaneController;

function Stack({ items }: { items: OrgItem[] }) {
  const prefs = useOrgPrefs("ws-stack");
  const organization = { items, prefs } as unknown as Organization;
  return (
    <TooltipProvider>
      <TerminalStack organization={organization} controller={controller} />
    </TooltipProvider>
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("TerminalStack", () => {
  it("moves focus into the narrow-canvas overlay and back to the rail when Escape closes it", async () => {
    const user = userEvent.setup();
    render(<Stack items={["1", "2", "3", "4"].map(item)} />);
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

  it("offers New group… only while the stack is grouped", async () => {
    const user = userEvent.setup();
    render(<Stack items={["1", "2", "3", "4"].map(item)} />);
    await user.click(screen.getByRole("button", { name: "Show one stack" }));
    await user.click(screen.getByRole("button", { name: "More for Shell 1" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).queryByRole("menuitem", { name: "New group…" })).not.toBeInTheDocument();
  });
});
