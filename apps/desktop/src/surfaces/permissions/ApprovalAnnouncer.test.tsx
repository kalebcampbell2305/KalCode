import type { ApprovalView } from "@kalcode/protocol";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApprovalAnnouncer } from "./ApprovalAnnouncer.tsx";

const permissions = vi.hoisted(() => ({
  pending: [] as ApprovalView[],
  pendingState: "ready" as "loading" | "ready" | "error",
}));
vi.mock("./PermissionsProvider.tsx", () => ({ usePermissions: () => permissions }));

function request(id: string, summary: string): ApprovalView {
  return {
    id,
    action: { summary },
    context: { providerName: "Claude Code", threadName: null, workspaceName: null },
  } as unknown as ApprovalView;
}

describe("ApprovalAnnouncer", () => {
  it("announces a new request even when its text matches the previous announcement", () => {
    permissions.pending = [];
    const view = render(<ApprovalAnnouncer />);
    const region = screen.getByRole("alert");
    expect(region.textContent).toBe("");

    permissions.pending = [request("a", "Run npm test")];
    view.rerender(<ApprovalAnnouncer />);
    const first = region.firstElementChild;
    expect(first?.textContent).toBe(
      "Approval needed. Claude Code wants to: Run npm test. Open Approvals in the sidebar to answer.",
    );

    // Denied, then the agent asks for the same command again: a new request, the same words.
    permissions.pending = [];
    view.rerender(<ApprovalAnnouncer />);
    permissions.pending = [request("b", "Run npm test")];
    view.rerender(<ApprovalAnnouncer />);
    const second = region.firstElementChild;
    expect(second?.textContent).toBe(first?.textContent);
    // A fresh node is what makes assistive technology announce it again.
    expect(second).not.toBe(first);
    expect(region.childElementCount).toBe(1);
  });

  it("does not re-announce when the same requests are re-read", () => {
    permissions.pending = [request("a", "Run npm test")];
    const view = render(<ApprovalAnnouncer />);
    const region = screen.getByRole("alert");
    const first = region.firstElementChild;
    expect(first?.textContent).toBe("1 approval is waiting for you.");
    permissions.pending = [request("a", "Run npm test")];
    view.rerender(<ApprovalAnnouncer />);
    expect(region.firstElementChild).toBe(first);
  });
});
