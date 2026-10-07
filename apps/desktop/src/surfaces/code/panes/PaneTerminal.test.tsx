import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TERMINAL_THEMES } from "../terminalTheme.ts";
import { PaneTerminal } from "./PaneTerminal.tsx";
import type { PaneChannel } from "./paneChannel.ts";

vi.mock("../../../shell/context/ContentContextMenu.tsx", () => ({
  ContentContextMenu: ({ children }: { children: React.ReactNode }) => children,
}));

const created = vi.hoisted(() => [] as { options: Record<string, unknown>; textarea: HTMLTextAreaElement }[]);

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    parser = {
      registerCsiHandler: () => ({ dispose() {} }),
      registerDcsHandler: () => ({ dispose() {} }),
      registerOscHandler: () => ({ dispose() {} }),
    };
    options: Record<string, unknown>;
    cols = 80;
    rows = 24;
    textarea = document.createElement("textarea");
    constructor(options: Record<string, unknown>) {
      this.options = { ...options };
      created.push(this);
    }
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
  write: vi.fn().mockResolvedValue(undefined),
  attach: vi.fn().mockResolvedValue(7),
  detach: vi.fn().mockResolvedValue(true),
  ack: vi.fn().mockResolvedValue(true),
  resize: vi.fn().mockResolvedValue(undefined),
} as unknown as PaneChannel;

function pane(props: { instanceId: string; theme: "light" | "dark"; label?: string }) {
  return (
    <PaneTerminal
      channel={channel}
      threadId="thread-1"
      instanceId={props.instanceId}
      terminalId="pty-1"
      providerId="claude-code"
      providerAccountId={null}
      status="active"
      providerPromptActive={false}
      label={props.label ?? "Claude A input"}
      running
      focusRequest={0}
      theme={props.theme}
    />
  );
}

beforeEach(() => {
  created.length = 0;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  delete document.documentElement.dataset.textSize;
  vi.unstubAllGlobals();
});

describe("PaneTerminal", () => {
  it("starts a resumed agent's new terminal with the current theme and its accessible name", async () => {
    const view = render(pane({ instanceId: "instance-1", theme: "dark" }));
    await act(async () => {});
    view.rerender(pane({ instanceId: "instance-1", theme: "light" }));
    // Resume: the provider's new instance recreates the terminal.
    view.rerender(pane({ instanceId: "instance-2", theme: "light" }));
    await act(async () => {});

    expect(created).toHaveLength(2);
    const resumed = created[1];
    expect(resumed?.options.theme).toBe(TERMINAL_THEMES.light);
    expect(resumed?.textarea.getAttribute("aria-label")).toBe("Claude A input");
  });

  it("follows the interface text size, as shell terminals do", async () => {
    document.documentElement.dataset.textSize = "larger";
    const view = render(pane({ instanceId: "instance-1", theme: "dark" }));
    await act(async () => {});
    expect(created[0]?.options.fontSize).toBe(16);

    await act(async () => {
      document.documentElement.dataset.textSize = "default";
      // The text-size store listens through a MutationObserver.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(created[0]?.options.fontSize).toBe(13);
    view.unmount();
  });
});
