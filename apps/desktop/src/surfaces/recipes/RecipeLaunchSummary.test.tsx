import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RecipeLaunchSummary as Summary } from "../../runtime/recipes/model.ts";
import { RecipeLaunchSummary } from "./RecipeLaunchSummary.tsx";

const seams = vi.hoisted(() => ({ api: {} as Record<string, unknown> }));
vi.mock("../../runtime/recipes/RecipeLaunchProvider.tsx", () => ({ useRecipeLaunch: () => seams.api }));

const base: Summary = {
  recipeId: "r",
  recipeName: "Release desk",
  workspaceId: "w",
  started: [
    { key: "agent-1", kind: "agent", label: "Claude Code agent", link: { kind: "squad", launchId: "l1" } },
    { key: "svc", kind: "service", label: "dev server", link: { kind: "service", runId: "run1" }, note: "Port busy" },
  ],
  failed: [],
  skipped: [],
  durationMs: 1234,
  notice: null,
};

function setup(summary: Summary) {
  const api = { phase: { kind: "done", summary }, dismiss: vi.fn(), openLink: vi.fn() };
  seams.api = api;
  return api;
}

describe("RecipeLaunchSummary", () => {
  afterEach(() => vi.useRealTimers());

  it("summarises and links each started part", async () => {
    const api = setup(base);
    render(<RecipeLaunchSummary />);
    expect(screen.getByText("Started 2 of 2 in KalCode · 1.2 s")).toBeInTheDocument();
    expect(screen.getByText("Port busy")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open dev server" }));
    expect(api.openLink).toHaveBeenCalledWith({ kind: "service", runId: "run1" });
  });

  it("lists failed parts with their reason and does not auto-dismiss", () => {
    vi.useFakeTimers();
    const api = setup({ ...base, failed: [{ key: "b", kind: "browser", label: "docs", reason: "Address blocked" }] });
    render(<RecipeLaunchSummary />);
    expect(screen.getByText("Address blocked")).toBeInTheDocument();
    expect(screen.getByText("Started 2 of 3 in KalCode · 1.2 s")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(api.dismiss).not.toHaveBeenCalled();
  });

  it("auto-dismisses after 12 s when everything started cleanly", () => {
    vi.useFakeTimers();
    const first = base.started[0] as Summary["started"][number];
    const api = setup({ ...base, started: [first] });
    render(<RecipeLaunchSummary />);
    act(() => {
      vi.advanceTimersByTime(11_000);
    });
    expect(api.dismiss).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1_500);
    });
    expect(api.dismiss).toHaveBeenCalledTimes(1);
  });

  it("shows a notice for a cancelled launch and keeps it", () => {
    vi.useFakeTimers();
    const api = setup({ ...base, started: [], notice: "Launch cancelled. Everything it started was stopped." });
    render(<RecipeLaunchSummary />);
    expect(screen.getByText(/Launch cancelled/)).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(api.dismiss).not.toHaveBeenCalled();
  });

  it("renders nothing when idle", () => {
    seams.api = { phase: { kind: "idle" }, dismiss: vi.fn(), openLink: vi.fn() };
    const { container } = render(<RecipeLaunchSummary />);
    expect(container).toBeEmptyDOMElement();
  });
});
