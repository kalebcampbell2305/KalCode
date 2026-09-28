import type { ThreadSummary } from "@kalcode/protocol";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentCard } from "./AgentCard.tsx";

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
