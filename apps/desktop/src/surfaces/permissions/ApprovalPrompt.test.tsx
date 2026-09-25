import type { ApprovalView } from "@kalcode/protocol";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApprovalPrompt } from "./ApprovalPrompt.tsx";
import { actionDetail, statusText } from "./labels.ts";

function request(overrides: Partial<ApprovalView> = {}): ApprovalView {
  return {
    id: "0192f3c4-0000-7000-8000-000000000001",
    action: {
      id: "toolu_1",
      threadId: "0192f3c4-0000-7000-8000-000000000002",
      workspaceId: "0192f3c4-0000-7000-8000-000000000003",
      providerId: "claude-code",
      action: { kind: "command", command: "npm install zod@4", argv: [], cwd: "" },
      summary: "Install zod@4 with npm",
      requestedAt: new Date().toISOString(),
      origin: null,
    },
    decision: {
      effect: "ask",
      scopes: ["package.install"],
      reason: "Installing packages needs your approval in Approve mode.",
      approvable: true,
    },
    permissionMode: "approve",
    status: "pending",
    resolvedDecision: null,
    resolvedAt: null,
    allowedDecisions: ["deny", "approve_once", "approve_for_thread", "approve_for_workspace", "allow_via_rule"],
    grantCoverage: "only installing zod@4 with npm",
    context: { threadName: "Fix the login bug", workspaceName: "kalcode", providerName: "Claude Code" },
    createdAt: new Date().toISOString(),
    expireReason: null,
    ...overrides,
  };
}

describe("ApprovalPrompt", () => {
  it("shows the action verbatim with its context and the allowed answers", () => {
    render(<ApprovalPrompt request={request()} onDecide={vi.fn()} />);
    const prompt = screen.getByRole("region", { name: "Install zod@4 with npm" });
    expect(within(prompt).getByText("npm install zod@4")).toBeInTheDocument();
    expect(within(prompt).getByText("Claude Code")).toBeInTheDocument();
    expect(within(prompt).getByText("Fix the login bug")).toBeInTheDocument();
    const buttons = within(prompt)
      .getAllByRole("button")
      .map((b) => b.textContent);
    // Deny comes first and Approve once (primary) last; "Allow via rule" is never offered.
    expect(buttons).toEqual(["Deny", "Allow for workspace", "Allow for thread", "Approve once"]);
    expect(prompt).toHaveAccessibleDescription("Installing packages needs your approval in Approve mode.");
  });

  it("names KalVoice for a request that came from it (no thread or provider of its own)", () => {
    const base = request();
    render(
      <ApprovalPrompt
        request={request({
          action: {
            ...base.action,
            threadId: "",
            providerId: "",
            action: { kind: "create_threads", providerId: "codex", count: 2, workspaceId: null },
            summary: "Open 2 Codex threads",
            origin: { kind: "kalvoice", requestId: "0192f3c4-0000-7000-8000-000000000009" },
          },
          allowedDecisions: ["deny", "approve_once"],
          context: { threadName: null, workspaceName: null, providerName: null },
        })}
        onDecide={vi.fn()}
      />,
    );
    const prompt = screen.getByRole("region", { name: "Open 2 Codex threads" });
    expect(within(prompt).getByText("KalVoice")).toBeInTheDocument();
    expect(within(prompt).getByText("None")).toBeInTheDocument();
    expect(
      within(prompt)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Deny", "Approve once"]);
  });

  it("offers only what the engine allows", () => {
    render(<ApprovalPrompt request={request({ allowedDecisions: ["deny", "approve_once"] })} onDecide={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Allow for thread" })).toBeNull();
    expect(screen.getByRole("button", { name: "Approve once" })).toBeEnabled();
  });

  it("disables every answer while one is being recorded", async () => {
    let resolve: () => void = () => {};
    const onDecide = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    render(<ApprovalPrompt request={request()} onDecide={onDecide} />);
    await userEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(onDecide).toHaveBeenCalledWith(request().id, "deny");
    expect(screen.getByRole("button", { name: "Approve once" })).toBeDisabled();
    resolve();
  });

  it("resolved and expired requests are read-only", () => {
    const expired = request({ status: "expired", expireReason: "thread_stopped" });
    render(<ApprovalPrompt request={expired} onDecide={vi.fn()} />);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.getByText("Expired: the thread stopped")).toBeInTheDocument();
    expect(statusText(request({ status: "approved", resolvedDecision: "approve_for_thread" }))).toBe(
      "Allowed for this thread",
    );
  });

  it("marks Bypass threads", () => {
    render(<ApprovalPrompt request={request({ permissionMode: "bypass" })} onDecide={vi.fn()} />);
    expect(screen.getByText("Bypass")).toHaveAttribute("data-tone", "danger");
  });
});

describe("actionDetail", () => {
  it("renders every action kind", () => {
    expect(actionDetail({ kind: "file_write", path: "src/a.ts" })).toBe("src/a.ts");
    expect(actionDetail({ kind: "git", operation: "push", remote: "origin" })).toBe("git push origin");
    expect(actionDetail({ kind: "package_install", manager: "pnpm", packages: ["a", "b"] })).toBe("pnpm install a b");
    expect(actionDetail({ kind: "network", host: "docs.rs", url: null })).toBe("docs.rs");
    expect(actionDetail({ kind: "deploy", target: "production" })).toBe("production");
    expect(actionDetail({ kind: "tool", tool: "mcp__x", inputSummary: "y" })).toBe("mcp__x: y");
  });
});
