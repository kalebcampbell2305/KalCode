import type { TerminalInfo } from "@kalcode/protocol";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PaneTerminal } from "../../src/surfaces/code/panes/PaneTerminal.tsx";
import type { PaneChannel } from "../../src/surfaces/code/panes/paneChannel.ts";
import { TerminalView } from "../../src/surfaces/code/TerminalView.tsx";

const mocks = vi.hoisted(() => ({
  renderDone: [] as (() => void)[],
  output: null as null | ((data: Uint8Array) => void),
  ack: vi.fn(),
  detach: vi.fn(),
  lastSize: { current: { cols: 80, rows: 24 } },
}));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options = {};
    cols = 80;
    rows = 24;
    textarea = document.createElement("textarea");
    loadAddon() {}
    open() {}
    attachCustomKeyEventHandler() {}
    onData() {}
    onBinary() {}
    onResize() {}
    dispose() {}
    reset() {}
    focus() {}
    write(_bytes: unknown, done?: () => void) {
      if (done) mocks.renderDone.push(done);
    }
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));
vi.mock("../../src/runtime/WorkspaceProvider.tsx", () => ({ useWorkspaces: () => ({ lastSize: mocks.lastSize }) }));
vi.mock("../../src/runtime/RuntimeProvider.tsx", () => ({
  useRuntime: () => ({
    client: {
      attachTerminal: async (_id: string, onOutput: (data: Uint8Array) => void) => {
        mocks.output = onOutput;
        return 17;
      },
      ackTerminal: mocks.ack,
      detachTerminal: mocks.detach,
    },
  }),
}));

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  mocks.renderDone = [];
  mocks.output = null;
  mocks.ack.mockReset().mockResolvedValue(true);
  mocks.detach.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllGlobals());

it.each(["shell", "provider"])("ignores a late %s replay completion after detachment", async (kind) => {
  const terminal: TerminalInfo = {
    id: "terminal",
    workspaceId: "workspace",
    shellId: "shell",
    title: "Shell",
    position: 0,
    status: "running",
    startedAt: null,
    endedAt: null,
    exitCode: null,
  };
  const channel = {
    attach: async (_id: string, onOutput: (data: Uint8Array) => void) => {
      mocks.output = onOutput;
      return 17;
    },
    ack: mocks.ack,
    detach: mocks.detach,
  } as unknown as PaneChannel;
  const view = render(
    kind === "shell" ? (
      <TerminalView terminal={terminal} label="Shell" visible focusRequest={0} theme="dark" />
    ) : (
      <PaneTerminal channel={channel} threadId="thread" label="Provider" running focusRequest={0} theme="dark" />
    ),
  );
  await act(async () => {});
  act(() => mocks.output?.(new Uint8Array(64 * 1024)));
  expect(mocks.renderDone).toHaveLength(1);
  view.unmount();
  expect(mocks.detach).toHaveBeenCalledWith(17);
  act(() => mocks.renderDone[0]?.());
  expect(mocks.ack).not.toHaveBeenCalled();
});
