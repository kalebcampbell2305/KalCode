import type { ThreadSummary } from "@kalcode/protocol";
import { TooltipProvider } from "@kalcode/ui/components";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Profiler } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetAllowedOverlaps } from "../../runtime/ownership/allowed.ts";
import type { AgentOverlap, OwnershipOverlap } from "../../runtime/ownership/model.ts";
import { AgentCard, type AgentCardProps, sameAgentCardProps, startedText } from "./AgentCard.tsx";

function thread(accountLabel: string | null): ThreadSummary {
  return {
    id: "0192f3c4-0000-7000-8000-000000000005",
    name: "Research",
    providerId: "gemini-cli",
    providerName: "Gemini CLI",
    model: null,
    effort: null,
    providerAccountId: accountLabel ? "0192f3c4-0000-7000-8000-000000000b02" : null,
    accountLabel,
    workspaceId: "0192f3c4-0000-7000-8000-00000000a001",
    workspaceName: "kalcode",
    permissionMode: "approve",
    status: "idle",
    currentActivity: null,
    createdAt: "2026-09-28T12:00:00Z",
    lastActivityAt: "2026-09-28T12:00:00Z",
    pendingApprovals: 0,
    unreadMessages: 0,
    filesChanged: null,
    branch: null,
    error: null,
    archivedAt: null,
    resumable: false,
    permissionProfileId: null,
    runtimeKind: null,
    terminalId: null,
    worktreeId: null,
  };
}

function mount(summary: ThreadSummary, extra: Partial<Parameters<typeof AgentCard>[0]> = {}) {
  return render(
    <AgentCard
      thread={summary}
      now={Date.parse("2026-09-28T12:01:00Z")}
      approvals={[]}
      pendingAction={undefined}
      onFocus={vi.fn()}
      onAction={vi.fn()}
      onDecide={vi.fn()}
      onReviewApprovals={vi.fn()}
      {...extra}
    />,
  );
}

describe("AgentCard account label", () => {
  it("leads with the provider account, then the provider and workspace", () => {
    mount(thread("Gemini B"));
    const card = screen.getByRole("article", { name: "Research" });
    expect(card.textContent).toContain("Gemini CLI·kalcode");
    const account = screen.getByTitle("Account: Gemini B");
    expect(account.textContent).toBe("account Gemini B");
    expect(card.contains(account)).toBe(true);
  });

  it("tells same-named sessions on different accounts apart", () => {
    const { unmount } = mount(thread("Gemini A"));
    expect(screen.getByTitle("Account: Gemini A")).toBeTruthy();
    unmount();
    mount(thread("Gemini B"));
    expect(screen.queryByTitle("Account: Gemini A")).toBeNull();
    expect(screen.getByTitle("Account: Gemini B")).toBeTruthy();
  });

  it("keeps the task title and clean provider identity without an account", () => {
    const { unmount } = mount(thread(null));
    expect(screen.queryByTitle(/^Account:/)).toBeNull();
    expect(screen.getByRole("heading", { name: "Research" })).toBeTruthy();
    expect(screen.getAllByText("Gemini CLI").length).toBeGreaterThan(0);
    expect(screen.queryByText(/^Gemini [A-Z]$/)).toBeNull();
    unmount();
    mount(thread("   "));
    expect(screen.queryByTitle(/^Account:/)).toBeNull();
  });
});

describe("AgentCard start time", () => {
  it("shows how long it has run, and when it started in its details", () => {
    mount(
      { ...thread(null), createdAt: "2026-09-28T11:18:00Z", lastActivityAt: "2026-09-28T12:00:30Z" },
      { expanded: true, onToggleExpanded: vi.fn() },
    );
    const card = screen.getByRole("article", { name: "Research" });
    expect(card.querySelector('time[data-kind="elapsed"]')?.textContent).toBe("Running time 43 min");
    const started = card.querySelector('time[data-kind="started"]');
    expect(started?.textContent).toBe("Started 43 min ago");
    expect(started?.getAttribute("dateTime")).toBe("2026-09-28T11:18:00Z");
    expect(started?.getAttribute("title")).toMatch(/^Started /);
    // Last activity stays its own, separately labelled time.
    const last = card.querySelector('time[data-kind="last-activity"]');
    expect(last?.textContent).toBe("Last activity just now");
  });

  it("says just now for a new thread and hides an unreadable start", () => {
    const now = Date.parse("2026-09-28T12:01:00Z");
    expect(startedText("2026-09-28T12:00:30Z", now)).toBe("Started just now");
    expect(startedText("2026-09-26T09:01:00Z", now)).toBe("Started 2 d 3 h ago");
    expect(startedText("not a date", now)).toBeNull();
    mount({ ...thread(null), createdAt: "not a date" }, { expanded: true, onToggleExpanded: vi.fn() });
    const card = screen.getByRole("article", { name: "Research" });
    expect(card.querySelector('time[data-kind="started"]')).toBeNull();
    expect(card.querySelector('time[data-kind="elapsed"]')).toBeNull();
  });
});

describe("AgentCard stopped activity", () => {
  it("distinguishes historical and provider-resumable stopped agents", () => {
    const { unmount } = mount({ ...thread(null), status: "interrupted", resumable: false });
    expect(screen.getByText("Stopped · historical")).toBeTruthy();
    unmount();
    mount({ ...thread(null), status: "interrupted", resumable: true });
    expect(screen.getByText("Stopped · resumable")).toBeTruthy();
  });
});

describe("AgentCard archived (read-only)", () => {
  it("offers only Unarchive: no focus, menu or follow-ups", async () => {
    const onAction = vi.fn();
    const onFocus = vi.fn();
    const summary: ThreadSummary = { ...thread("Gemini B"), status: "completed", archivedAt: "2026-09-28T11:59:00Z" };
    render(
      <AgentCard
        thread={summary}
        now={Date.parse("2026-09-28T12:01:00Z")}
        archived
        approvals={[]}
        pendingAction={undefined}
        onFocus={onFocus}
        onAction={onAction}
        onDecide={vi.fn()}
        onReviewApprovals={vi.fn()}
      />,
    );
    const card = screen.getByRole("article", { name: "Research" });
    expect(card.textContent).toContain("Archived");
    expect(card.textContent).not.toContain("Completed");
    expect(screen.queryByRole("button", { name: "Research" })).toBeNull();
    expect(screen.queryByRole("button", { name: /More actions/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open" })).toBeNull();
    await userEvent.click(card);
    expect(onFocus).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Unarchive Research" }));
    expect(onAction).toHaveBeenCalledWith(summary, "unarchive");
  });
});

describe("AgentCard waiting states", () => {
  const WAITING: Partial<ThreadSummary> = {
    status: "waiting_for_dependency",
    currentActivity: "Waiting to start: memory is critically low (412 MB free)",
    error: {
      code: "waiting_for_resources",
      message:
        "Memory is critically low (412 MB free). KalCode is holding Codex so your system stays usable; it starts as soon as this clears. Run KalTidy to free resources, or choose Start Anyway.",
    },
  };

  it("a launch held by hard pressure says so with the real reason, not 'waiting on another task'", () => {
    mount({ ...thread(null), ...WAITING });
    const card = screen.getByRole("article", { name: "Research" });
    expect(card.textContent).toContain("Waiting to start");
    expect(card.textContent).toContain("memory is critically low");
    expect(card.textContent).not.toContain("CPU busy");
    expect(card.textContent).not.toMatch(/waiting on another task/i);
    expect(card.textContent).not.toMatch(/\bIdle\b/);
    expect(card.getAttribute("data-tone")).toBe("waiting");
  });

  it("without an activity, the held launch reads the runtime's own message", () => {
    mount({ ...thread(null), ...WAITING, currentActivity: null });
    const card = screen.getByRole("article", { name: "Research" });
    expect(card.textContent).toContain("Memory is critically low (412 MB free).");
    expect(card.textContent).not.toMatch(/waiting on another task/i);
  });

  it("a wait on another task keeps the shared qualifier (nothing is invented)", () => {
    mount({ ...thread(null), status: "waiting_for_dependency", currentActivity: null });
    const card = screen.getByRole("article", { name: "Research" });
    expect(card.textContent).toMatch(/waiting on another task/i);
    expect(card.textContent).not.toContain("system resources");
  });

  it("a held launch offers Start Anyway and Stop, never Pause or Archive", async () => {
    mount({ ...thread(null), ...WAITING });
    await userEvent.click(screen.getByRole("button", { name: "More actions for Research" }));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Open",
      "Pin globally",
      "Start Anyway",
      "Stop…",
    ]);
  });

  it("a held launch shows its real reason with Start Anyway on the card, which starts it", async () => {
    const onAction = vi.fn();
    const summary = { ...thread(null), ...WAITING };
    mount(summary, { onAction });
    const card = screen.getByRole("article", { name: "Research" });
    expect(card.textContent).toContain("memory is critically low");
    await userEvent.click(screen.getByRole("button", { name: "Start Research anyway" }));
    expect(onAction).toHaveBeenCalledWith(summary, "start_anyway");
  });

  it("Start Anyway in flight shows on its own button, not the menu", () => {
    mount({ ...thread(null), ...WAITING }, { pendingAction: "start_anyway" });
    expect(screen.getByRole("button", { name: "Start Research anyway" }).getAttribute("aria-busy")).toBe("true");
    expect(screen.getByRole("button", { name: "More actions for Research" }).getAttribute("aria-busy")).not.toBe(
      "true",
    );
  });

  it("a launch whose wait ran out keeps Resume on the card and offers Start Anyway in the menu", async () => {
    const onAction = vi.fn();
    const summary: ThreadSummary = {
      ...thread(null),
      status: "interrupted",
      error: {
        code: "resources_unavailable",
        message: "Codex didn't start: memory stayed critically low after 90 s. Your message is saved.",
      },
    };
    mount(summary, { onAction });
    expect(screen.getByRole("button", { name: "Resume Research" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "More actions for Research" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Start Anyway" }));
    expect(onAction).toHaveBeenCalledWith(summary, "start_anyway");
  });

  it("a wait on another task never offers Start Anyway", () => {
    mount({ ...thread(null), status: "waiting_for_dependency", currentActivity: null });
    expect(screen.queryByRole("button", { name: "Start Research anyway" })).toBeNull();
  });

  it("an idle thread offers Archive, not Stop", async () => {
    mount(thread(null));
    await userEvent.click(screen.getByRole("button", { name: "More actions for Research" }));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Open",
      "Pin globally",
      "Archive",
    ]);
  });
});

describe("AgentCard Fleet controls", () => {
  it("expands its details in place and says so", async () => {
    const onToggle = vi.fn();
    const { rerender } = mount(
      { ...thread("Claude A"), model: "claude-opus-4-1", effort: "high" },
      { onToggleExpanded: onToggle },
    );
    const card = screen.getByRole("article", { name: "Research" });
    expect(card.textContent).toContain("claude-opus-4-1");
    expect(card.textContent).toContain("effort high");
    const toggle = screen.getByRole("button", { name: "Show details for Research" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledWith("0192f3c4-0000-7000-8000-000000000005");
    rerender(
      <AgentCard
        thread={{ ...thread("Claude A"), model: "claude-opus-4-1", effort: "high" }}
        now={Date.parse("2026-09-28T12:01:00Z")}
        approvals={[]}
        pendingAction={undefined}
        onFocus={vi.fn()}
        onAction={vi.fn()}
        onDecide={vi.fn()}
        onReviewApprovals={vi.fn()}
        expanded
        onToggleExpanded={onToggle}
      />,
    );
    expect(screen.getByRole("button", { name: "Hide details for Research" })).toHaveAttribute("aria-expanded", "true");
    expect(card.textContent).toContain("Permission mode Approve");
    expect(card.textContent).toContain("claude-opus-4-1 · high effort");
  });

  it("a failed agent offers Retry and the one-click clear, and clicking the clear never opens it", async () => {
    const onDismiss = vi.fn();
    const onFocus = vi.fn();
    const onAction = vi.fn();
    const failed: ThreadSummary = {
      ...thread("Claude A"),
      status: "failed",
      error: { code: "provider_exited", message: "Claude Code exited (exit code 1)." },
    };
    mount(failed, { onDismiss, onFocus, onAction });
    const card = screen.getByRole("article", { name: "Research" });
    expect(card.textContent).toContain("Failed");
    expect(card.textContent).toContain("Claude Code exited (exit code 1).");
    await userEvent.click(screen.getByRole("button", { name: "Clear Research" }));
    expect(onDismiss).toHaveBeenCalledWith(failed);
    expect(onFocus).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onAction).toHaveBeenCalledWith(failed, "retry");
  });

  it("names its state in the shared agent-state words: working, needs you, stopped, done", () => {
    const cases: [ThreadSummary["status"], string][] = [
      ["running_command", "Working"],
      ["testing", "Testing"],
      ["waiting_for_user", "Needs you"],
      ["interrupted", "Stopped"],
      ["completed", "Done"],
      ["waiting_for_permission", "Needs you"],
      ["waiting_for_dependency", "Waiting"],
    ];
    for (const [status, label] of cases) {
      const { unmount } = mount({ ...thread(null), status });
      const card = screen.getByRole("article", { name: "Research" });
      expect(card.querySelector('[data-kind="state"]')?.textContent).toBe(label);
      unmount();
    }
  });

  it("clicking the card opens the agent (its terminal in Code)", async () => {
    const onFocus = vi.fn();
    const summary = thread("Claude A");
    mount(summary, { onFocus });
    await userEvent.click(screen.getByRole("article", { name: "Research" }));
    expect(onFocus).toHaveBeenCalledWith(summary);
  });
});

describe("AgentCard clock ticks", () => {
  const props = (summary: ThreadSummary, now: string, extra: Partial<AgentCardProps> = {}): AgentCardProps => ({
    thread: summary,
    now: Date.parse(now),
    approvals: [],
    pendingAction: undefined,
    onFocus: () => {},
    onAction: () => {},
    onDecide: async () => {},
    onReviewApprovals: () => {},
    ...extra,
  });

  it("skips a tick that changes none of the times the card shows", () => {
    const t = thread(null);
    const base = props(t, "2026-09-28T12:01:05Z");
    const same = { ...base, now: Date.parse("2026-09-28T12:01:25Z") };
    expect(sameAgentCardProps(base, same)).toBe(true);
  });

  it("re-renders when the elapsed or last-activity text changes", () => {
    const t = thread(null);
    const base = props(t, "2026-09-28T12:01:40Z");
    expect(sameAgentCardProps(base, { ...base, now: Date.parse("2026-09-28T12:02:10Z") })).toBe(false);
  });

  it("re-renders when any other prop changes", () => {
    const t = thread(null);
    const base = props(t, "2026-09-28T12:01:10Z");
    expect(sameAgentCardProps(base, { ...base, thread: { ...t, status: "active" } })).toBe(false);
    expect(sameAgentCardProps(base, { ...base, expanded: true })).toBe(false);
    const { expanded: _, ...withoutExpanded } = { ...base, expanded: false };
    expect(sameAgentCardProps({ ...base, expanded: false }, withoutExpanded)).toBe(false);
  });

  it("updates the archived time when its relative text changes", () => {
    const t = { ...thread(null), archivedAt: "2026-09-28T12:00:00Z" };
    const base = props(t, "2026-09-28T13:10:05Z", { archived: true });
    expect(sameAgentCardProps(base, { ...base, now: Date.parse("2026-09-28T13:10:20Z") })).toBe(true);
    expect(sameAgentCardProps(base, { ...base, now: Date.parse("2026-09-28T14:40:00Z") })).toBe(false);
  });
});

describe("AgentCard on the shared clock", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("without a given time, re-renders on a tick only when a time it shows changes", () => {
    vi.useFakeTimers();
    // 12:00:40: started 40 s ago ("Started just now", "<1 min").
    vi.setSystemTime(Date.parse("2026-09-28T12:00:40Z"));
    const t = { ...thread(null), status: "active" as const };
    const onRender = vi.fn();
    render(
      <Profiler id="card" onRender={onRender}>
        <AgentCard
          thread={t}
          approvals={[]}
          pendingAction={undefined}
          onFocus={vi.fn()}
          onAction={vi.fn()}
          onDecide={vi.fn()}
          onReviewApprovals={vi.fn()}
        />
      </Profiler>,
    );
    onRender.mockClear();
    act(() => vi.advanceTimersByTime(20_000)); // 12:01:00: one minute, the texts change
    expect(onRender).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("article", { name: "Research" }).textContent).toContain("1 min");
    onRender.mockClear();
    act(() => vi.advanceTimersByTime(30_000)); // 12:01:30: still one minute
    expect(onRender).not.toHaveBeenCalled();
  });
});

describe("AgentCard ownership", () => {
  const other = { ...thread(null), id: "0192f3c4-0000-7000-8000-000000000006", name: "Pricing Update" };
  const entry = (patch: Partial<OwnershipOverlap> = {}): AgentOverlap => ({
    other,
    overlap: {
      key: "ownership:a:b",
      agentIds: ["0192f3c4-0000-7000-8000-000000000005", other.id],
      workspaceId: "w1",
      risk: "same-files",
      files: ["a.ts", "b.ts"],
      incomplete: false,
      area: null,
      allowed: false,
      ...patch,
    },
  });

  afterEach(() => resetAllowedOverlaps());

  function mountTip(summary: ThreadSummary, extra: Partial<AgentCardProps> = {}) {
    return render(
      <TooltipProvider>
        <AgentCard
          thread={summary}
          now={Date.parse("2026-09-28T12:01:00Z")}
          approvals={[]}
          pendingAction={undefined}
          onFocus={vi.fn()}
          onAction={vi.fn()}
          onDecide={vi.fn()}
          onReviewApprovals={vi.fn()}
          {...extra}
        />
      </TooltipProvider>,
    );
  }

  it("words each risk, tones it, and opens the other agent", async () => {
    const onFocus = vi.fn();
    mountTip(thread(null), { overlaps: [entry()], onFocus });
    const chip = screen.getByRole("button", { name: /Overlaps with Pricing Update/ });
    expect(chip.textContent).toContain("Overlaps with Pricing Update · 2 files");
    await userEvent.click(chip);
    expect(onFocus).toHaveBeenCalledWith(other);
  });

  it.each([
    ["conflict", "Conflicts with Pricing Update", "conflict"],
    ["live", "Editing the same files as Pricing Update", "live"],
    ["compatible", "Merges cleanly with Pricing Update", "quiet"],
  ] as const)("shows %s", (risk, text, tone) => {
    mountTip(thread(null), { overlaps: [entry({ risk })] });
    const chip = screen.getByRole("button", { name: new RegExp(text) });
    expect(chip.getAttribute("data-tone")).toBe(tone);
  });

  it("names whose area was entered", () => {
    mountTip(thread(null), {
      overlaps: [entry({ risk: "area", area: { owner: other.id, entrant: "x", pattern: "src/billing/**" } })],
    });
    expect(screen.getByRole("button", { name: /In Pricing Update's area/ })).toBeTruthy();
  });

  it("allows both, then offers to warn again; compatible offers neither", async () => {
    const view1 = mountTip(thread(null), { overlaps: [entry()] });
    await userEvent.click(screen.getByRole("button", { name: /^Allow both to edit these files/ }));
    expect(allowedKeys()).toContain("ownership:a:b");
    view1.unmount();
    mountTip(thread(null), { overlaps: [entry({ allowed: true })] });
    expect(screen.getByRole("button", { name: /Allowed with Pricing Update/ }).getAttribute("data-tone")).toBe("quiet");
    await userEvent.click(screen.getByRole("button", { name: /^Warn again about these files/ }));
    expect(allowedKeys()).not.toContain("ownership:a:b");
  });

  it("collapses merge-clean overlaps into one quiet chip", () => {
    mountTip(thread(null), {
      overlaps: [
        entry({ risk: "compatible", key: "ownership:1" }),
        { ...entry({ risk: "compatible", key: "ownership:2" }), other: { ...other, id: "other-2", name: "Docs" } },
      ],
    });
    expect(screen.getAllByRole("button", { name: /Merges cleanly/ })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /^Allow both to edit these files/ })).toBeNull();
  });
});

function allowedKeys(): string[] {
  const raw = globalThis.localStorage?.getItem("kalcode.ownership.allowed.v2");
  return raw ? (JSON.parse(raw) as [string, string[]][]).map(([key]) => key) : [];
}
