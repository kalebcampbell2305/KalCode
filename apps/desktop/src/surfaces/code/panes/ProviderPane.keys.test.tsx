import type { PaneInfo, ThreadSummary } from "@kalcode/protocol";
import { TooltipProvider } from "@kalcode/ui/components";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { ProviderPane } from "./ProviderPane.tsx";
import type { PaneChannel } from "./paneChannel.ts";

const seams = vi.hoisted(() => ({ focusRequests: [] as number[], renameThread: vi.fn() }));

vi.mock("../../../runtime/RuntimeProvider.tsx", () => ({
  useRuntime: () => ({ client: { renameThread: seams.renameThread } }),
}));
vi.mock("../../permissions/PermissionsProvider.tsx", () => ({
  usePermissions: () => ({ pending: [], decide: vi.fn() }),
}));
vi.mock("../kaltidy/kalTidyContext.ts", () => ({ useKalTidy: () => null }));
vi.mock("../../dashboard/outcome/AgentOutcome.tsx", () => ({ AgentOutcome: () => null }));
vi.mock("../../providers/AccountUsageBadge.tsx", () => ({ AccountUsageBadge: () => null }));
// The real terminal is xterm.js; its focus requests are what this pane decides.
vi.mock("./PaneTerminal.tsx", () => ({
  PaneTerminal: ({ focusRequest, threadId }: { focusRequest: number; threadId: string }) => {
    seams.focusRequests.push(focusRequest);
    return (
      <div data-pane-terminal={threadId}>
        <textarea aria-label="Agent terminal input" />
      </div>
    );
  },
}));

const thread = {
  id: "agent-1",
  name: "Fix login",
  providerId: "claude-code",
  providerName: "Claude Code",
  providerAccountId: null,
  accountLabel: null,
  workspaceId: "ws",
  workspaceName: "Project",
  status: "idle",
  currentActivity: null,
  permissionMode: "bypass",
  model: null,
  terminalId: null,
  error: null,
  pendingApprovals: 0,
  createdAt: "2026-10-01T00:00:00.000Z",
  lastActivityAt: "2026-10-01T00:00:00.000Z",
  runtimeKind: "interactive_pty",
} as unknown as ThreadSummary;

const info: PaneInfo = {
  threadId: "agent-1",
  providerId: "claude-code",
  instanceId: "instance-1",
  hookChannel: "active",
  decisionRouting: "engine",
  kalcodeAnswersApprovals: false,
  running: true,
  exitCode: null,
};

beforeEach(() => {
  seams.focusRequests.length = 0;
  seams.renameThread.mockReset();
  seams.renameThread.mockResolvedValue(thread);
});

const leaveTerminal = (target: Element) =>
  fireEvent.keyDown(target, { key: "E", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });

it("lets Ctrl+Shift+E leave an agent's terminal, as it does a shell's", () => {
  render(
    <TooltipProvider>
      <ProviderPane
        thread={thread}
        info={info}
        channel={{} as PaneChannel}
        account={null}
        theme="dark"
        focusRequest={0}
      />
    </TooltipProvider>,
  );
  const input = screen.getByRole("textbox", { name: "Agent terminal input" });
  input.focus();
  // Not consumed here: Code's window-level shortcut moves focus to the pane's tab.
  expect(leaveTerminal(input)).toBe(true);
  expect(seams.focusRequests.at(-1)).toBe(0);

  // From the pane header, the same keys go back into the terminal.
  const more = screen.getByRole("button", { name: "More actions for Fix login" });
  expect(leaveTerminal(more)).toBe(false);
  expect(seams.focusRequests.at(-1)).toBe(1);
});

it("keeps the task title first and presents exact runtime identity inline for every provider", () => {
  const cursor = {
    ...thread,
    providerId: "cursor",
    providerName: "Cursor",
    providerAccountId: "cursor-work",
    accountLabel: "Cursor Work",
    model: "selected/model-v1",
    effort: "high",
    activeModel: "cursor/model-v2[reasoning=max]",
    activeEffort: "X-High",
  } as ThreadSummary;
  const { container } = render(
    <TooltipProvider>
      <ProviderPane
        thread={cursor}
        info={{ ...info, providerId: "cursor" }}
        channel={{} as PaneChannel}
        account={{ label: "Cursor Work", state: "active" }}
        theme="dark"
        focusRequest={0}
      />
    </TooltipProvider>,
  );

  const title = screen.getByRole("button", { name: "Fix login. Rename agent" });
  const identity = container.querySelector<HTMLElement>("[data-pane-identity]");
  const model = container.querySelector<HTMLElement>("[data-pane-model]");
  expect(identity).toHaveTextContent("Cursor");
  expect(identity).toHaveTextContent("Cursor Work");
  expect(identity).toHaveTextContent("cursor/model-v2[reasoning=max]");
  expect(identity).toHaveTextContent("X-High");
  expect(identity).toContainElement(model);
  expect(container.querySelectorAll("[data-pane-model]")).toHaveLength(1);
  expect(title.compareDocumentPosition(identity as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(identity).toHaveAttribute("title", expect.stringContaining("Selected model: selected/model-v1."));
  expect(container.querySelector("[data-pane-identity-detail]")).toHaveAccessibleName(
    expect.stringContaining("Selected model: selected/model-v1."),
  );
});

it("says when model and reasoning remain controlled by the provider", () => {
  const { container } = render(
    <TooltipProvider>
      <ProviderPane
        thread={thread}
        info={info}
        channel={{} as PaneChannel}
        account={null}
        theme="dark"
        focusRequest={0}
      />
    </TooltipProvider>,
  );
  const identity = container.querySelector<HTMLElement>("[data-pane-identity]");
  expect(container.querySelector("[data-pane-account]")).toHaveTextContent("Account unavailable");
  expect(identity).toHaveTextContent("Model controlled by provider");
  expect(identity).toHaveTextContent("Reasoning controlled by provider");
});

it("pins a provider-generated title as manual when the user explicitly saves it unchanged", () => {
  render(
    <TooltipProvider>
      <ProviderPane
        thread={thread}
        info={info}
        channel={{} as PaneChannel}
        account={null}
        theme="dark"
        focusRequest={0}
      />
    </TooltipProvider>,
  );

  fireEvent.click(screen.getByRole("button", { name: "Fix login. Rename agent" }));
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Agent name" }), { key: "Enter" });
  expect(seams.renameThread).toHaveBeenCalledWith(thread.id, thread.name);
});
