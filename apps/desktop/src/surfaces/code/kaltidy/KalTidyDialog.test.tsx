import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { TidyEntry, TidyScan } from "./classify.ts";
import { KalTidyDialog } from "./KalTidyDialog.tsx";
import type { KalTidyClass } from "./kalTidyContext.ts";

function entry(id: string, cls: KalTidyClass, reason: string): TidyEntry {
  return {
    cls,
    reason,
    root: null,
    terminal: {
      id,
      workspaceId: "w1",
      shellId: "pwsh",
      title: "PowerShell 7",
      position: 0,
      status: "running",
      startedAt: null,
      endedAt: null,
      exitCode: null,
      label: id,
      workspaceName: "site",
    },
  };
}

const SCAN: TidyScan = {
  at: 0,
  blocked: null,
  entries: [
    entry("Idle one", "idle", "At its prompt, quiet for 14 min"),
    entry("Idle two", "idle", "Shell ended 1 h ago"),
    entry("Typing", "waiting", "Unsent input at the prompt"),
    entry("Vite", "background", "Running vite dev server on :5173"),
    entry("Build", "active", "Running cargo.exe (12.0% CPU)"),
    entry("Deploy", "protected", "Deploy “web” is running"),
  ],
};

function mount(scan: TidyScan | null = SCAN) {
  const onConfirm = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <KalTidyDialog
      open
      onOpenChange={onOpenChange}
      scan={scan}
      scanning={false}
      stopping={false}
      onRescan={() => undefined}
      onConfirm={onConfirm}
    />,
  );
  return { user: userEvent.setup(), onConfirm, onOpenChange, dialog: screen.getByRole("dialog") };
}

describe("KalTidy review dialog", () => {
  it("groups terminals by class with their reasons and preselects only idle ones", () => {
    const { dialog } = mount();
    expect(within(dialog).getByRole("heading", { name: "KalTidy — Stop idle terminals" })).toBeInTheDocument();
    for (const title of ["Idle", "Waiting for you", "Background", "Active", "Protected"]) {
      expect(within(dialog).getByRole("region", { name: new RegExp(`^${title}`) })).toBeInTheDocument();
    }
    expect(within(dialog).getByRole("checkbox", { name: /Idle one/ })).toBeChecked();
    expect(within(dialog).getByRole("checkbox", { name: /Idle two/ })).toBeChecked();
    for (const name of [/Typing/, /Vite/, /Build/]) {
      expect(within(dialog).getByRole("checkbox", { name })).not.toBeChecked();
    }
    expect(within(dialog).getByRole("checkbox", { name: /Typing/ })).toHaveAccessibleDescription(
      "Unsent input at the prompt",
    );
    expect(within(dialog).getByRole("button", { name: "Stop 2 terminals" })).toBeEnabled();
  });

  it("never lets a protected terminal be chosen", async () => {
    const { dialog, user } = mount();
    const deploy = within(dialog).getByRole("checkbox", { name: /Deploy/ });
    expect(deploy).toBeDisabled();
    await user.click(within(dialog).getByText("Deploy “web” is running"));
    expect(deploy).not.toBeChecked();
    expect(within(dialog).getByRole("button", { name: "Stop 2 terminals" })).toBeInTheDocument();
  });

  it("stops only what is selected, including explicit opt-ins", async () => {
    const { dialog, user, onConfirm } = mount();
    await user.click(within(dialog).getByRole("checkbox", { name: /Idle two/ })); // opt out
    await user.click(within(dialog).getByRole("checkbox", { name: /Vite/ })); // opt in
    await user.keyboard(" "); // keyboard toggles too: Vite back off
    await user.click(within(dialog).getByRole("checkbox", { name: /Typing/ }));
    await user.click(within(dialog).getByRole("button", { name: "Stop 2 terminals" }));
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith(["Idle one", "Typing"]);
  });

  it("can't confirm with nothing selected", async () => {
    const { dialog, user } = mount();
    await user.click(within(dialog).getByRole("checkbox", { name: /Idle one/ }));
    await user.click(within(dialog).getByRole("checkbox", { name: /Idle two/ }));
    expect(within(dialog).getByRole("button", { name: "Stop 0 terminals" })).toBeDisabled();
  });

  it("says when nothing is idle", () => {
    const { dialog } = mount({ ...SCAN, entries: SCAN.entries.filter((e) => e.cls !== "idle") });
    expect(within(dialog).getByText("Nothing is idle right now")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Stop 0 terminals" })).toBeDisabled();
  });

  it("shows an empty state with no terminals and a warning when the scan failed", () => {
    const { dialog } = mount({ at: 0, entries: [], blocked: "KalCode couldn't check: Operations didn't answer." });
    expect(within(dialog).getByText("No terminals open")).toBeInTheDocument();
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Operations didn't answer");
  });
});
