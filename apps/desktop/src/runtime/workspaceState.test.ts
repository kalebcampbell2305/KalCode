import type { EventEnvelope, TerminalInfo, Workspace } from "@kalcode/protocol";
import { describe, expect, it } from "vitest";
import {
  cycleTerminal,
  describeTerminalStatus,
  groupRunning,
  isWorkspaceEvent,
  neighbourAfterClose,
  pickActiveTerminal,
  tabLabels,
} from "./workspaceState.ts";

const tab = (id: string, title = "PowerShell 7", extra: Partial<TerminalInfo> = {}): TerminalInfo => ({
  id,
  workspaceId: "w1",
  shellId: "pwsh",
  title,
  position: 0,
  status: "running",
  startedAt: "2026-09-24T10:00:00.000Z",
  endedAt: null,
  exitCode: null,
  ...extra,
});

const workspace = (id: string, name: string): Workspace => ({
  id,
  name,
  rootPath: `C:\\p\\${name}`,
  displayPath: `~\\p\\${name}`,
  createdAt: "",
  lastOpenedAt: "",
  activeTerminalId: null,
  available: true,
});

describe("workspace state helpers", () => {
  it("refreshes on workspace and shell events only", () => {
    const e = (type: string) => ({ type }) as EventEnvelope;
    expect(isWorkspaceEvent(e("workspace.opened"))).toBe(true);
    expect(isWorkspaceEvent(e("shell.failed"))).toBe(true);
    expect(isWorkspaceEvent(e("settings.changed"))).toBe(false);
  });

  it("picks the chosen tab, then the persisted one, then the first", () => {
    const tabs = [tab("a"), tab("b"), tab("c")];
    expect(pickActiveTerminal(tabs, "b", "c")).toBe("b");
    expect(pickActiveTerminal(tabs, "gone", "c")).toBe("c");
    expect(pickActiveTerminal(tabs, null, "gone")).toBe("a");
    expect(pickActiveTerminal([], "a", "b")).toBeNull();
  });

  it("numbers tabs of the same shell", () => {
    const labels = tabLabels([tab("a"), tab("b", "Git Bash"), tab("c"), tab("d")]);
    expect([...labels.values()]).toEqual(["PowerShell 7", "Git Bash", "PowerShell 7 (2)", "PowerShell 7 (3)"]);
  });

  it("brings the right neighbour forward on close, else the left", () => {
    const tabs = [tab("a"), tab("b"), tab("c")];
    expect(neighbourAfterClose(tabs, "b")).toBe("c");
    expect(neighbourAfterClose(tabs, "c")).toBe("b");
    expect(neighbourAfterClose([tab("a")], "a")).toBeNull();
    expect(neighbourAfterClose(tabs, "x")).toBeNull();
  });

  it("cycles through tabs in both directions, wrapping", () => {
    const tabs = [tab("a"), tab("b"), tab("c")];
    expect(cycleTerminal(tabs, "c", 1)).toBe("a");
    expect(cycleTerminal(tabs, "a", -1)).toBe("c");
    expect(cycleTerminal(tabs, null, 1)).toBe("a");
    expect(cycleTerminal([], null, 1)).toBeNull();
  });

  it("describes statuses in plain language", () => {
    expect(describeTerminalStatus(tab("a"))).toBe("Running");
    expect(describeTerminalStatus(tab("a", "x", { status: "exited", exitCode: 0 }))).toBe("Exited");
    expect(describeTerminalStatus(tab("a", "x", { status: "exited", exitCode: 3 }))).toBe("Exited with code 3");
    expect(describeTerminalStatus(tab("a", "x", { status: "ended_by_app" }))).toBe("Ended when KalCode closed");
  });

  it("groups running terminals by workspace in list order", () => {
    const groups = groupRunning(
      [
        tab("a", "x", { workspaceId: "w2" }),
        tab("b", "x", { workspaceId: "w1" }),
        tab("c", "x", { workspaceId: "w2" }),
      ],
      [workspace("w1", "site"), workspace("w2", "api")],
    );
    expect(groups.map((g) => [g.workspace?.name, g.terminals.map((t) => t.id)])).toEqual([
      ["site", ["b"]],
      ["api", ["a", "c"]],
    ]);
  });
});
