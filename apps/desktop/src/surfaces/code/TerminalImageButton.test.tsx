import { ToastProvider, TooltipProvider } from "@kalcode/ui/components";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalImageButton } from "./TerminalImageButton.tsx";
import {
  attachTerminalImage,
  registerTerminalImageTarget,
  resetTerminalImageTargetsForTests,
  terminalImageTargetKey,
} from "./terminalImages.ts";

const ONE_PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+2pYhWQAAAABJRU5ErkJggg==";

function imageFile(): File {
  const bytes = Uint8Array.from(atob(ONE_PIXEL_PNG), (character) => character.charCodeAt(0));
  return new File([bytes.slice().buffer], "pixel.png", { type: "image/png" });
}

function view(targetKey: ReturnType<typeof terminalImageTargetKey>) {
  return render(
    <ToastProvider>
      <TooltipProvider>
        <TerminalImageButton targetKey={targetKey} />
      </TooltipProvider>
    </ToastProvider>,
  );
}

afterEach(() => {
  resetTerminalImageTargetsForTests();
  document.body.replaceChildren();
});

describe("TerminalImageButton", () => {
  it("keeps the hidden picker out of keyboard navigation and restores terminal focus on cancel", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const targetKey = terminalImageTargetKey("terminal", "picker-terminal");
    const focus = vi.fn();
    registerTerminalImageTarget(host, {
      key: targetKey,
      importImage: vi.fn(),
      discardImage: vi.fn(),
      pasteInsertion: vi.fn(),
      focus,
    });
    const rendered = view(targetKey);

    expect(screen.getByRole("button", { name: "Attach image" })).toBeEnabled();
    const input = rendered.container.querySelector('input[type="file"]');
    expect(input).toHaveAttribute("tabindex", "-1");
    expect(input).toHaveAttribute("aria-hidden", "true");
    fireEvent(input as HTMLInputElement, new Event("cancel"));
    expect(focus).toHaveBeenCalledOnce();
  });

  it("shows native import failures immediately", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const targetKey = terminalImageTargetKey("agent", "failing-agent");
    registerTerminalImageTarget(host, {
      key: targetKey,
      importImage: vi.fn(async () => {
        throw new Error("Private image storage is unavailable.");
      }),
      discardImage: vi.fn(),
      pasteInsertion: vi.fn(),
      focus: vi.fn(),
    });
    view(targetKey);

    await attachTerminalImage(targetKey, imageFile());
    expect(await screen.findByText("Couldn't attach image")).toBeVisible();
    expect(screen.getByText("Private image storage is unavailable.")).toBeVisible();
  });
});
