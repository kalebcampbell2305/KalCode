import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { IconButton } from "./Button.tsx";
import { Tooltip, TooltipProvider } from "./Tooltip.tsx";

describe("Tooltip", () => {
  it("adds its keyboard hint to an existing accessible description until dismissed", async () => {
    const user = userEvent.setup();
    render(
      <TooltipProvider>
        <p id="description">The folder stays on disk.</p>
        <Tooltip content="Remove this folder from KalCode.">
          <button type="button" aria-describedby="description">
            Remove folder
          </button>
        </Tooltip>
      </TooltipProvider>,
    );

    const trigger = screen.getByRole("button", { name: "Remove folder" });
    expect(trigger).toHaveAccessibleDescription("The folder stays on disk.");
    await user.tab();
    expect(screen.getByRole("tooltip")).toHaveTextContent("Remove this folder from KalCode.");
    expect(trigger).toHaveAccessibleDescription("The folder stays on disk. Remove this folder from KalCode.");

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-describedby", "description");
    expect(trigger).toHaveAccessibleDescription("The folder stays on disk.");
  });

  it("keeps updated description IDs when focus leaves an open tooltip", async () => {
    const user = userEvent.setup();
    const view = (description: string, content: string) => (
      <TooltipProvider>
        <p id="location">Current folder.</p>
        <p id="read-only">Read only.</p>
        <p id="editable">You can edit it.</p>
        <Tooltip content={content}>
          <button type="button" aria-describedby={description}>
            Folder details
          </button>
        </Tooltip>
        <button type="button">Next</button>
      </TooltipProvider>
    );
    const { rerender } = render(view("location read-only", "View folder details."));
    const trigger = screen.getByRole("button", { name: "Folder details" });
    await user.tab();
    expect(trigger).toHaveAccessibleDescription("Current folder. Read only. View folder details.");

    rerender(view("location editable", "Edit folder details."));
    expect(trigger).toHaveAccessibleDescription("Current folder. You can edit it. Edit folder details.");
    await user.tab();
    expect(screen.getByRole("button", { name: "Next" })).toHaveFocus();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-describedby", "location editable");
    expect(trigger).toHaveAccessibleDescription("Current folder. You can edit it.");
  });

  it("preserves a component trigger's ref and handlers and removes the hint after activation", async () => {
    const user = userEvent.setup();
    const ref = createRef<HTMLButtonElement>();
    const onFocus = vi.fn();
    const onClick = vi.fn();
    render(
      <TooltipProvider>
        <Tooltip content="Show workspace settings.">
          <IconButton ref={ref} label="Settings" icon={<span>+</span>} onFocus={onFocus} onClick={onClick} />
        </Tooltip>
      </TooltipProvider>,
    );
    const trigger = screen.getByRole("button", { name: "Settings" });
    expect(ref.current).toBe(trigger);
    expect(trigger).not.toHaveAttribute("aria-describedby");
    await user.tab();
    expect(onFocus).toHaveBeenCalledOnce();
    expect(trigger).toHaveAccessibleDescription("Show workspace settings.");
    await user.keyboard("{Enter}");
    expect(onClick).toHaveBeenCalledOnce();
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(trigger).not.toHaveAttribute("aria-describedby");
  });

  it("stays closed while hidden", async () => {
    const user = userEvent.setup();
    const view = (hidden: boolean) => (
      <TooltipProvider>
        <Tooltip content="Account details" hidden={hidden}>
          <button type="button">Account</button>
        </Tooltip>
      </TooltipProvider>
    );
    const { rerender } = render(view(true));
    await user.tab();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Account" })).not.toHaveAttribute("aria-describedby");
    rerender(view(false));
    expect(screen.getByRole("tooltip")).toHaveTextContent("Account details");
  });
});
