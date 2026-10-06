import type { PaneInfo, ThreadSummary } from "@kalcode/protocol";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { ProviderPane } from "./ProviderPane.tsx";
import type { PaneChannel } from "./paneChannel.ts";

const seams = vi.hoisted(() => ({ focusRequests: [] as number[] }));

vi.mock("../../../runtime/RuntimeProvider.tsx", () => ({ useRuntime: () => ({ client: {} }) }));
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
});

const leaveTerminal = (target: Element) =>
  fireEvent.keyDown(target, { key: "E", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });

it("lets Ctrl+Shift+E leave an agent's terminal, as it does a shell's", () => {
  render(
    <ProviderPane
      thread={thread}
      info={info}
      channel={{} as PaneChannel}
      account={null}
      theme="dark"
      focusRequest={0}
    />,
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
