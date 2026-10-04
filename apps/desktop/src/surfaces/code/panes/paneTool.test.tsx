import type { ThreadStatus } from "@kalcode/protocol";
import { act, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaneToolChip } from "./PaneParts.tsx";
import { paneToolActivity } from "./paneLabels.ts";

describe("paneToolActivity", () => {
  it("names the tool family from the shared action summaries, for every provider", () => {
    const cases: [ThreadStatus, string, string][] = [
      ["running_tool", "Search the web for rust async traits", "Search web"],
      ["running_tool", "Fetch https://docs.rs/tokio", "Fetch page"],
      ["running_tool", "Search files for TODO", "Search repo"],
      ["running_tool", "Read src/main.rs", "Read file"],
      ["editing", "Edit src/main.rs", "Edit file"],
      ["running_command", "Run cargo test", "Shell"],
      ["running_tool", "Use mcp__github__create_issue", "MCP · github"],
      ["running_tool", "Use mcp__open_design__render", "MCP · open_design"],
      ["running_tool", "Use Agent", "Agent"],
    ];
    for (const [status, activity, label] of cases) {
      expect(paneToolActivity(status, activity)).toEqual({ label, detail: activity });
    }
  });

  it("shows nothing when no tool is running", () => {
    expect(paneToolActivity("idle", "Run cargo test")).toBeNull();
    expect(paneToolActivity("thinking", null)).toBeNull();
    expect(paneToolActivity("running_tool", "   ")).toBeNull();
  });
});

describe("PaneToolChip", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const chip = (status: ThreadStatus, activity: string | null) => createElement(PaneToolChip, { status, activity });

  it("shows the running tool, then Completed, then steps aside", () => {
    const view = render(chip("running_tool", "Search the web for KalCode"));
    expect(screen.getByText("Tool")).toBeTruthy();
    expect(screen.getByText("Search web")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Running…");

    view.rerender(chip("thinking", null));
    expect(screen.getByRole("status").textContent).toBe("Completed");
    expect(screen.getByText("Search web").closest("[data-phase]")?.getAttribute("data-phase")).toBe("done");

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.queryByText("Search web")).toBeNull();
  });

  it("reports a failed turn truthfully", () => {
    const view = render(chip("running_command", "Run npm test"));
    view.rerender(chip("failed", null));
    expect(screen.getByRole("status").textContent).toBe("Failed");
  });

  it("follows the next tool without flicker", () => {
    const view = render(chip("running_command", "Run cargo build"));
    view.rerender(chip("running_tool", "Use mcp__github__list_issues"));
    expect(screen.getByText("MCP · github")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Running…");
  });
});
