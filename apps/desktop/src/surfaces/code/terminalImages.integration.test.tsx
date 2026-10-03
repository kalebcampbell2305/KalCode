import type { TerminalInfo } from "@kalcode/protocol";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaneTerminal } from "./panes/PaneTerminal.tsx";
import type { PaneChannel } from "./panes/paneChannel.ts";
import { TerminalView } from "./TerminalView.tsx";
import { resetTerminalImageTargetsForTests, terminalImageState, terminalImageTargetKey } from "./terminalImages.ts";

interface TestTerminal {
  onInput: ((data: string) => void) | null;
  pastes: string[];
}

const mocks = vi.hoisted(() => ({
  terms: [] as TestTerminal[],
  writeTerminal: vi.fn(),
  importTerminalImage: vi.fn(),
  discardTerminalImage: vi.fn(),
  paneWrite: vi.fn(),
  paneWriteVoice: vi.fn(),
  lastSize: { current: { cols: 80, rows: 24 } },
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class implements TestTerminal {
    parser = {
      registerCsiHandler: () => ({ dispose() {} }),
      registerDcsHandler: () => ({ dispose() {} }),
      registerOscHandler: () => ({ dispose() {} }),
    };
    options: Record<string, unknown>;
    cols = 80;
    rows = 24;
    textarea = document.createElement("textarea");
    onInput: ((data: string) => void) | null = null;
    pastes: string[] = [];
    constructor(options: Record<string, unknown>) {
      this.options = options;
      mocks.terms.push(this);
    }
    loadAddon() {}
    open() {}
    attachCustomKeyEventHandler() {}
    onData(callback: (data: string) => void) {
      this.onInput = callback;
    }
    onBinary() {}
    onResize() {}
    dispose() {}
    reset() {}
    focus() {}
    hasSelection() {
      return false;
    }
    paste(data: string) {
      this.pastes.push(data);
      this.onInput?.(`\u001b[200~${data}\u001b[201~`);
    }
    write(_bytes: unknown, done?: () => void) {
      done?.();
    }
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));

const client = {
  attachTerminal: vi.fn(async () => null),
  ackTerminal: vi.fn(async () => true),
  detachTerminal: vi.fn(async () => undefined),
  resizeTerminal: vi.fn(async () => undefined),
  writeTerminal: mocks.writeTerminal,
  importTerminalImage: mocks.importTerminalImage,
  discardTerminalImage: mocks.discardTerminalImage,
};

vi.mock("../../runtime/RuntimeProvider.tsx", () => ({ useRuntime: () => ({ client }) }));
vi.mock("../../runtime/WorkspaceProvider.tsx", () => ({
  useWorkspaces: () => ({ lastSize: mocks.lastSize }),
}));

const ONE_PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+2pYhWQAAAABJRU5ErkJggg==";

function imageFile(): File {
  const bytes = Uint8Array.from(atob(ONE_PIXEL_PNG), (character) => character.charCodeAt(0));
  return new File([bytes.slice().buffer], "pixel.png", { type: "image/png" });
}

function pasteImage(element: Element): ClipboardEvent {
  const file = imageFile();
  const event = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, "clipboardData", {
    value: {
      items: [{ kind: "file", type: file.type, getAsFile: () => file }],
      files: [file],
    },
  });
  element.dispatchEvent(event);
  return event;
}

const terminal: TerminalInfo = {
  id: "terminal-image-shell",
  workspaceId: "workspace",
  shellId: "pwsh",
  title: "Shell",
  position: 0,
  status: "running",
  startedAt: "2026-10-03T12:00:00.000Z",
  endedAt: null,
  exitCode: null,
};

function paneChannel(): PaneChannel {
  return {
    attach: vi.fn(async () => null),
    ack: vi.fn(async () => true),
    detach: vi.fn(async () => true),
    resize: vi.fn(async () => undefined),
    write: mocks.paneWrite,
    writeVoice: mocks.paneWriteVoice,
    importImage: (threadId: string, instanceId: string, pngBase64: string) =>
      mocks.importTerminalImage({ kind: "agent", threadId, instanceId }, pngBase64),
    discardImage: (threadId: string, instanceId: string, imageId: string) =>
      mocks.discardTerminalImage({ kind: "agent", threadId, instanceId }, imageId),
  } as unknown as PaneChannel;
}

beforeEach(() => {
  mocks.terms = [];
  mocks.writeTerminal.mockReset().mockResolvedValue(undefined);
  mocks.importTerminalImage.mockReset();
  mocks.discardTerminalImage.mockReset().mockResolvedValue(undefined);
  mocks.paneWrite.mockReset().mockResolvedValue(undefined);
  mocks.paneWriteVoice.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  resetTerminalImageTargetsForTests();
  vi.unstubAllGlobals();
});

describe("terminal image xterm integration", () => {
  it("uses xterm bracketed paste and the exact shell generation without remounting the PTY", async () => {
    mocks.importTerminalImage.mockResolvedValue({
      imageId: "shell-image",
      path: "C:\\private\\one.png",
      insertion: "'C:\\private\\one.png'",
      terminalGeneration: 7,
    });
    const view = render(<TerminalView terminal={terminal} label="Shell" visible focusRequest={0} theme="dark" />);
    const host = view.container.querySelector(`[data-terminal-id="${terminal.id}"]`);
    if (!host) throw new Error("Missing terminal host");

    expect(pasteImage(host).defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(mocks.writeTerminal).toHaveBeenCalledOnce());
    expect(mocks.writeTerminal).toHaveBeenCalledWith(terminal.id, "\u001b[200~'C:\\private\\one.png'\u001b[201~", 7);
    expect(mocks.writeTerminal.mock.calls[0]?.[1]).not.toContain("\r");
    expect(mocks.terms).toHaveLength(1);

    await act(async () => mocks.terms[0]?.onInput?.("echo normal text\r"));
    expect(mocks.writeTerminal).toHaveBeenLastCalledWith(terminal.id, "echo normal text\r");

    mocks.importTerminalImage.mockResolvedValue({
      imageId: "shell-image-after-restart",
      path: "C:\\private\\two.png",
      insertion: "'C:\\private\\two.png'",
      terminalGeneration: 8,
    });
    view.rerender(
      <TerminalView
        terminal={{ ...terminal, startedAt: "2026-10-03T12:05:00.000Z" }}
        label="Shell"
        visible
        focusRequest={0}
        theme="dark"
      />,
    );
    pasteImage(host);
    await vi.waitFor(() => expect(mocks.writeTerminal).toHaveBeenCalledTimes(3));
    expect(mocks.writeTerminal).toHaveBeenLastCalledWith(
      terminal.id,
      "\u001b[200~'C:\\private\\two.png'\u001b[201~",
      8,
    );
    expect(mocks.terms).toHaveLength(1);
  });

  it("does not deliver an in-flight image selection across a same-id shell restart", async () => {
    let finishImport: (value: {
      imageId: string;
      path: string;
      insertion: string;
      terminalGeneration: number;
    }) => void = () => {
      throw new Error("Import did not start");
    };
    mocks.importTerminalImage.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishImport = resolve;
        }),
    );
    const view = render(<TerminalView terminal={terminal} label="Shell" visible focusRequest={0} theme="dark" />);
    const host = view.container.querySelector(`[data-terminal-id="${terminal.id}"]`);
    if (!host) throw new Error("Missing terminal host");
    pasteImage(host);
    await vi.waitFor(() => expect(mocks.importTerminalImage).toHaveBeenCalledOnce());

    view.rerender(
      <TerminalView
        terminal={{ ...terminal, startedAt: "2026-10-03T12:05:00.000Z" }}
        label="Shell"
        visible
        focusRequest={0}
        theme="dark"
      />,
    );
    finishImport({
      imageId: "old-shell-image",
      path: "C:\\private\\old.png",
      insertion: "'C:\\private\\old.png'",
      terminalGeneration: 7,
    });

    const key = terminalImageTargetKey("terminal", terminal.id);
    await vi.waitFor(() => expect(terminalImageState(key).busy).toBe(false));
    expect(mocks.writeTerminal).not.toHaveBeenCalled();
    expect(mocks.discardTerminalImage).toHaveBeenCalledWith(
      { kind: "terminal", terminalId: terminal.id },
      "old-shell-image",
    );
    expect(mocks.terms).toHaveLength(1);
  });

  it("rejects a shell import when native omits its required generation", async () => {
    mocks.importTerminalImage.mockResolvedValue({
      imageId: "missing-generation",
      path: "C:\\private\\missing-generation.png",
      insertion: "'C:\\private\\missing-generation.png'",
    });
    const view = render(<TerminalView terminal={terminal} label="Shell" visible focusRequest={0} theme="dark" />);
    const host = view.container.querySelector(`[data-terminal-id="${terminal.id}"]`);
    if (!host) throw new Error("Missing terminal host");
    pasteImage(host);

    const key = terminalImageTargetKey("terminal", terminal.id);
    await vi.waitFor(() => expect(terminalImageState(key).busy).toBe(false));
    expect(terminalImageState(key).error).toContain("restarted");
    expect(mocks.writeTerminal).not.toHaveBeenCalled();
    expect(mocks.discardTerminalImage).toHaveBeenCalledWith(
      { kind: "terminal", terminalId: terminal.id },
      "missing-generation",
    );
  });

  it("routes insert-only agent images while working and refuses a confirmed provider prompt", async () => {
    let image = 0;
    mocks.importTerminalImage.mockImplementation(async () => {
      image += 1;
      return {
        imageId: `agent-image-${image}`,
        path: `/private/agent-${image}.png`,
        insertion: `"/private/agent-${image}.png"`,
      };
    });
    const channel = paneChannel();
    const view = render(
      <PaneTerminal
        channel={channel}
        threadId="agent-thread"
        instanceId="agent-instance"
        providerId="codex"
        providerAccountId={null}
        status="active"
        providerPromptActive={false}
        label="Codex"
        running
        focusRequest={0}
        theme="dark"
      />,
    );
    const host = view.container.querySelector('[data-pane-terminal="agent-thread"]');
    if (!host) throw new Error("Missing agent terminal host");

    pasteImage(host);
    await vi.waitFor(() => expect(mocks.paneWriteVoice).toHaveBeenCalledOnce());
    expect(mocks.paneWriteVoice).toHaveBeenCalledWith(
      "agent-thread",
      "agent-instance",
      '\u001b[200~"/private/agent-1.png"\u001b[201~',
    );
    expect(mocks.paneWrite).not.toHaveBeenCalled();

    view.rerender(
      <PaneTerminal
        channel={channel}
        threadId="agent-thread"
        instanceId="agent-instance"
        providerId="codex"
        providerAccountId={null}
        status="paused"
        providerPromptActive={false}
        label="Codex"
        running
        focusRequest={0}
        theme="dark"
      />,
    );
    pasteImage(host);
    await vi.waitFor(() => expect(mocks.paneWriteVoice).toHaveBeenCalledTimes(2));
    expect(mocks.paneWriteVoice).toHaveBeenLastCalledWith(
      "agent-thread",
      "agent-instance",
      '\u001b[200~"/private/agent-2.png"\u001b[201~',
    );

    view.rerender(
      <PaneTerminal
        channel={channel}
        threadId="agent-thread"
        instanceId="agent-instance"
        providerId="codex"
        providerAccountId={null}
        status="waiting_for_permission"
        providerPromptActive
        label="Codex"
        running
        focusRequest={0}
        theme="dark"
      />,
    );
    pasteImage(host);
    const key = terminalImageTargetKey("agent", "agent-thread");
    await vi.waitFor(() => expect(terminalImageState(key).busy).toBe(false));
    expect(mocks.paneWriteVoice).toHaveBeenCalledTimes(2);
    expect(mocks.discardTerminalImage).toHaveBeenCalledWith(
      { kind: "agent", threadId: "agent-thread", instanceId: "agent-instance" },
      "agent-image-3",
    );
    expect(mocks.terms).toHaveLength(1);
  });
});
