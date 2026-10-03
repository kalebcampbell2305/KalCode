import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaneTerminal } from "../surfaces/code/panes/PaneTerminal.tsx";
import type { PaneChannel } from "../surfaces/code/panes/paneChannel.ts";
import {
  deliverToProviderTerminal,
  deliverToProviderThread,
  resetDictationSinkRegistryForTests,
  submitProviderThread,
} from "./dictation.ts";

const mocks = vi.hoisted(() => ({
  write: vi.fn(),
  attach: vi.fn(),
  detach: vi.fn(),
  ack: vi.fn(),
  resize: vi.fn(),
  voiceWrite: vi.fn(),
  output: vi.fn(),
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    parser = {
      registerCsiHandler: () => ({ dispose() {} }),
      registerDcsHandler: () => ({ dispose() {} }),
      registerOscHandler: () => ({ dispose() {} }),
    };
    options: Record<string, unknown> = {};
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
    write(_data: unknown, done?: () => void) {
      mocks.output(_data);
      done?.();
    }
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));

const channel = {
  write: mocks.write,
  writeVoice: (threadId: string, instanceId: string, data: string) => {
    mocks.voiceWrite(threadId, instanceId, data);
    return mocks.write(threadId, data);
  },
  attach: mocks.attach,
  detach: mocks.detach,
  ack: mocks.ack,
  resize: mocks.resize,
} as unknown as PaneChannel;

function pane(
  status: "waiting_for_user" | "active" = "waiting_for_user",
  providerPromptActive = false,
  instanceId = "instance-1",
) {
  return (
    <PaneTerminal
      channel={channel}
      threadId="thread-1"
      instanceId={instanceId}
      terminalId="pty-1"
      providerId="claude-code"
      providerAccountId="personal"
      status={status}
      providerPromptActive={providerPromptActive}
      label="Claude A"
      running
      focusRequest={0}
      theme="dark"
    />
  );
}

beforeEach(() => {
  mocks.write.mockReset().mockResolvedValue(undefined);
  mocks.attach.mockReset().mockResolvedValue(17);
  mocks.detach.mockReset().mockResolvedValue(true);
  mocks.ack.mockReset().mockResolvedValue(true);
  mocks.resize.mockReset().mockResolvedValue(undefined);
  mocks.voiceWrite.mockReset();
  mocks.output.mockReset();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  resetDictationSinkRegistryForTests();
  vi.unstubAllGlobals();
});

describe("PaneTerminal voice delivery", () => {
  it("shows a new session's actual startup failure instead of claiming it is historical", async () => {
    mocks.attach.mockResolvedValue(null);
    render(
      <PaneTerminal
        {...pane().props}
        instanceId={null}
        running={false}
        status="failed"
        errorMessage="KalCode's hook helper is missing, so the pane can't start safely."
      />,
    );
    await act(async () => {});
    const output = mocks.output.mock.calls.flat().join("");
    expect(output).toContain("hook helper is missing");
    expect(output).not.toContain("earlier run");
  });

  it("keeps queued launches distinct from historical sessions and updates a delayed failure", async () => {
    mocks.attach.mockResolvedValue(null);
    const view = render(
      <PaneTerminal {...pane().props} instanceId={null} running={false} status="waiting_for_dependency" />,
    );
    await act(async () => {});
    expect(mocks.output.mock.calls.flat().join("")).not.toContain("earlier run");
    view.rerender(
      <PaneTerminal
        {...pane().props}
        instanceId={null}
        running={false}
        status="failed"
        errorMessage="Provider could not start."
      />,
    );
    await act(async () => {});
    expect(mocks.output.mock.calls.flat().join("")).toContain("Provider could not start.");
    expect(mocks.attach).toHaveBeenCalledTimes(1);
  });

  it("offers the historical resume explanation only for a stopped session", async () => {
    mocks.attach.mockResolvedValue(null);
    render(<PaneTerminal {...pane().props} instanceId={null} running={false} status="interrupted" />);
    await act(async () => {});
    expect(mocks.output.mock.calls.flat().join("")).toContain("Resume the agent");
  });

  it("inserts without Enter, sends with one Enter, and submits only through the provider sink", async () => {
    const view = render(pane());
    await act(async () => {});

    await act(async () => {
      await deliverToProviderThread("thread-1", "draft\ntext", { mode: "insert" });
      await deliverToProviderTerminal("pty-1", "run tests\r", { mode: "send" });
      await submitProviderThread("thread-1");
    });

    expect(mocks.write.mock.calls).toEqual([
      ["thread-1", "draft text"],
      ["thread-1", "run tests\r"],
      ["thread-1", "\r"],
    ]);
    view.unmount();
    await expect(deliverToProviderThread("thread-1", "after close")).rejects.toMatchObject({
      code: "target_closed",
    });
  });

  it("routes steering while active but refuses a native approval prompt", async () => {
    const view = render(pane("active"));
    await act(async () => {});
    await expect(deliverToProviderThread("thread-1", "finish the current task")).resolves.toBe(23);

    view.rerender(pane("waiting_for_user", true));
    await expect(submitProviderThread("thread-1")).rejects.toMatchObject({
      code: "provider_permission_prompt",
    });
    expect(mocks.write.mock.calls).toEqual([["thread-1", "finish the current task\r"]]);
  });

  it("does not enqueue a cancelled prompt", async () => {
    render(pane());
    await act(async () => {});
    const abort = new AbortController();
    abort.abort();

    await expect(
      deliverToProviderThread("thread-1", "cancelled", { mode: "send", signal: abort.signal }),
    ).rejects.toMatchObject({ code: "dictation_cancelled" });
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("rebinds guarded voice writes to a new provider instance after same-thread resume", async () => {
    const view = render(pane("waiting_for_user", false, "instance-old"));
    await act(async () => {});
    await deliverToProviderThread("thread-1", "first", { mode: "insert" });

    view.rerender(pane("waiting_for_user", false, "instance-new"));
    await act(async () => {});
    await deliverToProviderThread("thread-1", "second", { mode: "insert" });

    expect(mocks.voiceWrite.mock.calls).toEqual([
      ["thread-1", "instance-old", "first"],
      ["thread-1", "instance-new", "second"],
    ]);
  });
});
