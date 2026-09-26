import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "./DropdownMenu.tsx";

describe("DropdownMenu child composition", () => {
  it("keeps a composed action focusable and selectable with the keyboard", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onClick = vi.fn();
    const childRef = createRef<HTMLButtonElement>();
    const ref = createRef<HTMLDivElement>();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Actions</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem asChild ref={ref} onSelect={onSelect} description="Project settings" shortcut="Ctrl+,">
            <button type="button" ref={childRef} onClick={onClick}>
              Settings
            </button>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    const trigger = screen.getByRole("button", { name: "Actions" });
    trigger.focus();
    await user.keyboard("{ArrowDown}");
    const action = screen.getByRole("menuitem", { name: /Settings/ });
    expect(action.tagName).toBe("BUTTON");
    expect(ref.current).toBe(action);
    expect(childRef.current).toBe(action);
    expect(action).toHaveFocus();
    expect(action).toHaveTextContent("Project settings");
    expect(action).toHaveTextContent("Ctrl+,");
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onClick).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("keeps a composed radio choice operable and exposes its checked state", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger>Theme</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuRadioGroup value="light" onValueChange={onValueChange}>
            <DropdownMenuRadioItem asChild value="dark" description="Dim appearance">
              <button type="button">Dark</button>
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    const choice = screen.getByRole("menuitemradio", { name: /Dark/ });
    expect(choice.tagName).toBe("BUTTON");
    expect(choice).toHaveAttribute("aria-checked", "false");
    expect(choice).toHaveTextContent("Dim appearance");
    await user.click(choice);
    expect(onValueChange).toHaveBeenCalledWith("dark");
  });

  it("preserves ordinary items, selected indicators and disabled-item keyboard skipping", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Actions</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem asChild disabled onSelect={onSelect}>
            <button type="button">Unavailable</button>
          </DropdownMenuItem>
          <DropdownMenuItem description="Project settings">Settings</DropdownMenuItem>
          <DropdownMenuRadioGroup value="dark">
            <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    const trigger = screen.getByRole("button", { name: "Actions" });
    trigger.focus();
    await user.keyboard("{ArrowDown}");
    const disabled = screen.getByRole("menuitem", { name: "Unavailable" });
    expect(disabled).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("menuitem", { name: /Settings/ })).toHaveFocus();
    const selected = screen.getByRole("menuitemradio", { name: "Dark" });
    expect(selected).toHaveAttribute("aria-checked", "true");
    expect(selected.querySelector("svg")).toBeInTheDocument();
    await user.keyboard("{ArrowDown}");
    expect(selected).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(onSelect).not.toHaveBeenCalled();
  });
});
