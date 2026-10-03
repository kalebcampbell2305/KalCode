import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ObjectContextMenu } from "./ObjectContextMenu.tsx";

describe("ObjectContextMenu", () => {
  it("opens immediately for the clicked object without activating it", async () => {
    const selected = vi.fn();
    const activated = vi.fn();
    render(
      <ObjectContextMenu
        label="Actions for second thread"
        items={[{ id: "rename", label: "Rename", onSelect: selected }]}
      >
        <button type="button" onClick={activated}>
          Second thread
        </button>
      </ObjectContextMenu>,
    );
    fireEvent.contextMenu(screen.getByRole("button"), { clientX: 120, clientY: 80 });
    expect(screen.getByRole("menu", { name: "Actions for second thread" })).toBeInTheDocument();
    expect(activated).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    expect(selected).toHaveBeenCalledOnce();
  });

  it.each(["{Shift>}{F10}{/Shift}", "{ContextMenu}"])("supports %s and returns focus on Escape", async (keys) => {
    const user = userEvent.setup();
    render(
      <ObjectContextMenu label="Workspace actions" items={[{ id: "open", label: "Open Browser", onSelect: vi.fn() }]}>
        <button type="button">Workspace</button>
      </ObjectContextMenu>,
    );
    const trigger = screen.getByRole("button");
    trigger.focus();
    await user.keyboard(keys);
    expect(screen.getByRole("menu", { name: "Workspace actions" })).toBeInTheDocument();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem")).toHaveFocus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("keeps nested content actions from opening the containing pane menu", () => {
    render(
      <ObjectContextMenu label="Pane actions" items={[{ id: "close", label: "Close", onSelect: vi.fn() }]}>
        <div>
          <ObjectContextMenu label="File actions" items={[{ id: "open", label: "Open", onSelect: vi.fn() }]}>
            <button type="button">File</button>
          </ObjectContextMenu>
        </div>
      </ObjectContextMenu>,
    );
    fireEvent.contextMenu(screen.getByRole("button"));
    expect(screen.getByRole("menu", { name: "File actions" })).toBeInTheDocument();
    expect(screen.queryByRole("menu", { name: "Pane actions" })).not.toBeInTheDocument();
  });

  it("does not replace the browser menu when no actions apply", () => {
    render(
      <ObjectContextMenu label="No actions" items={[]}>
        <button type="button">Unavailable</button>
      </ObjectContextMenu>,
    );
    expect(fireEvent.contextMenu(screen.getByRole("button"))).toBe(true);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("preserves the mounted surface when its available actions change", () => {
    const child = <button type="button">Terminal</button>;
    const { rerender } = render(
      <ObjectContextMenu label="Terminal actions" items={[]}>
        {child}
      </ObjectContextMenu>,
    );
    const terminal = screen.getByRole("button");
    rerender(
      <ObjectContextMenu label="Terminal actions" items={[{ id: "copy", label: "Copy", onSelect: vi.fn() }]}>
        {child}
      </ObjectContextMenu>,
    );
    expect(screen.getByRole("button")).toBe(terminal);
    rerender(
      <ObjectContextMenu label="Terminal actions" items={[]}>
        {child}
      </ObjectContextMenu>,
    );
    expect(screen.getByRole("button")).toBe(terminal);
  });

  it("selects a submenu destination with the pointer", async () => {
    const user = userEvent.setup();
    const move = vi.fn();
    render(
      <ObjectContextMenu
        label="Thread actions"
        items={[
          {
            id: "move",
            label: "Move to workspace",
            children: [{ id: "target", label: "Destination", onSelect: move }],
          },
        ]}
      >
        <button type="button">Thread</button>
      </ObjectContextMenu>,
    );
    fireEvent.contextMenu(screen.getByRole("button"));
    await user.hover(screen.getByRole("menuitem", { name: "Move to workspace" }));
    // jsdom has no pointer geometry; real hover travel is covered by the browser test.
    fireEvent.click(await screen.findByRole("menuitem", { name: "Destination" }));
    expect(move).toHaveBeenCalledOnce();
  });

  it("invokes the innermost menu with the keyboard", async () => {
    const user = userEvent.setup();
    render(
      <ObjectContextMenu label="Pane actions" items={[{ id: "close", label: "Close", onSelect: vi.fn() }]}>
        <div>
          <ObjectContextMenu label="File actions" items={[{ id: "open", label: "Open", onSelect: vi.fn() }]}>
            <button type="button">File</button>
          </ObjectContextMenu>
        </div>
      </ObjectContextMenu>,
    );
    screen.getByRole("button").focus();
    await user.keyboard("{Shift>}{F10}{/Shift}");
    expect(screen.getByRole("menu", { name: "File actions" })).toBeInTheDocument();
    expect(screen.queryByRole("menu", { name: "Pane actions" })).not.toBeInTheDocument();
  });
});
