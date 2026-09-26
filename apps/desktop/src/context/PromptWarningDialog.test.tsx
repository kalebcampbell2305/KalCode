import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PromptWarningDialog } from "./PromptWarningDialog.tsx";

describe("PromptWarningDialog", () => {
  it("shows content-free detector counts and requires an explicit choice", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const { rerender } = render(
      <PromptWarningDialog
        warning={{ detectors: { password_assignment: 2, api_key_assignment: 1 } }}
        busy={false}
        confirmLabel="Send anyway"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    expect(screen.getByRole("alertdialog")).toHaveTextContent("password assignment");
    expect(screen.getByRole("alertdialog")).toHaveTextContent("api key assignment");
    expect(screen.queryByText("opaque-review-id")).not.toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Go back" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();

    rerender(
      <PromptWarningDialog
        warning={{ detectors: { password_assignment: 1 } }}
        busy={false}
        confirmLabel="Send anyway"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Send anyway" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
