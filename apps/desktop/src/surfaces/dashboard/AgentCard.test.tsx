import type { ThreadSummary } from "@kalcode/protocol";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AgentCard, startedText } from "./AgentCard.tsx";

function thread(accountLabel: string | null): ThreadSummary {
  return {
    id: "0192f3c4-0000-7000-8000-000000000005",
    name: "Research",
    providerId: "gemini-cli",
    providerName: "Gemini CLI",
    model: null,
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
  };
}

function mount(summary: ThreadSummary) {
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
    />,
  );
}

describe("AgentCard account label", () => {
  it("shows the provider account as text next to the workspace", () => {
    mount(thread("Gemini B"));
    const card = screen.getByRole("article", { name: "Research" });
    expect(card.textContent).toContain("kalcode");
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

  it("shows nothing for a thread without an account (or a blank label)", () => {
    const { unmount } = mount(thread(null));
    expect(screen.queryByTitle(/^Account:/)).toBeNull();
    unmount();
    mount(thread("   "));
    expect(screen.queryByTitle(/^Account:/)).toBeNull();
  });
});

describe("AgentCard start time", () => {
  it("shows when the thread started, from its real createdAt", () => {
    mount({ ...thread(null), createdAt: "2026-09-28T11:18:00Z", lastActivityAt: "2026-09-28T12:00:30Z" });
    const card = screen.getByRole("article", { name: "Research" });
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
    mount({ ...thread(null), createdAt: "not a date" });
    expect(screen.getByRole("article", { name: "Research" }).querySelector('time[data-kind="started"]')).toBeNull();
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
