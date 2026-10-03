import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { RenamePaneDialog } from "./RenamePaneDialog.tsx";

it("renames the captured object, trims the name, and keeps failures editable", async () => {
  const onSave = vi
    .fn()
    .mockRejectedValueOnce({
      category: "terminal",
      code: "terminal_missing",
      message: "Terminal is unavailable",
      retryable: false,
    })
    .mockResolvedValueOnce(undefined);
  const onClose = vi.fn();
  render(<RenamePaneDialog name="Shell" kind="terminal" onSave={onSave} onClose={onClose} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Terminal name" }), { target: { value: "  Build output  " } });
  fireEvent.click(screen.getByRole("button", { name: "Save name" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Terminal is unavailable");
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Save name" }));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(onSave).toHaveBeenLastCalledWith("Build output");
});
