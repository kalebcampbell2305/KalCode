import type { TerminalInfo } from "@kalcode/protocol";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaneTerminal } from "../../src/surfaces/code/panes/PaneTerminal.tsx";
import type { PaneChannel } from "../../src/surfaces/code/panes/paneChannel.ts";
import { TerminalView } from "../../src/surfaces/code/TerminalView.tsx";

interface TestTerminal {
  callbacks: (() => void)[];
  writes: (string | Uint8Array)[];
  disposed: boolean;
  onInput: ((data: string) => void) | null;
  queryStatus(): void;
}
const mocks = vi.hoisted(() => {
  const attach = vi.fn();
  const ack = vi.fn();
  const detach = vi.fn();
  const write = vi.fn();
  const resize = vi.fn();
  return {
    terms: [] as TestTerminal[],
    outputs: [] as ((data: Uint8Array) => void)[],
    attach,
    ack,
    detach,
    write,
    resize,
    client: {
      attachTerminal: attach,
      ackTerminal: ack,
      detachTerminal: detach,
      writeTerminal: write,
      resizeTerminal: resize,
    },
    lastSize: { current: { cols: 80, rows: 24 } },
  };
});
vi.mock("@xterm/xterm", () => ({
  Terminal: class implements TestTerminal {
    statusQuery: (() => boolean) | null = null;
    parser = {
      registerCsiHandler: (id: { final: string; prefix?: string }, handler: () => boolean) => {
        if (id.final === "n" && !id.prefix) this.statusQuery = handler;
        return { dispose() {} };
      },
      registerDcsHandler: () => ({ dispose() {} }),
      registerOscHandler: () => ({ dispose() {} }),
    };
    queryStatus() {
      if (!this.statusQuery?.()) this.onInput?.("\x1b[0n");
    }
    options: Record<string, unknown>;
    cols = 80;
    rows = 24;
    textarea = document.createElement("textarea");
    callbacks: (() => void)[] = [];
    writes: (string | Uint8Array)[] = [];
    disposed = false;
    onInput: ((data: string) => void) | null = null;
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
    dispose() {
      this.disposed = true;
    }
    reset() {}
    focus() {}
    write(bytes: string | Uint8Array, done?: () => void) {
      this.writes.push(bytes);
      if (done) this.callbacks.push(done);
    }
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));
vi.mock("../../src/runtime/WorkspaceProvider.tsx", () => ({ useWorkspaces: () => ({ lastSize: mocks.lastSize }) }));
vi.mock("../../src/runtime/RuntimeProvider.tsx", () => ({ useRuntime: () => ({ client: mocks.client }) }));

const REPLAY_BYTES = 64 * 1024;
type Kind = "shell" | "provider";
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
  attach: mocks.attach,
  ack: mocks.ack,
  detach: mocks.detach,
  write: mocks.write,
  resize: mocks.resize,
} as unknown as PaneChannel;

function tree(kind: Kind, running = true, id = "session") {
  return kind === "shell" ? (
    <TerminalView
      terminal={{ ...terminal, id, status: running ? "running" : "exited" }}
      label="Shell"
      visible
      focusRequest={0}
      theme="dark"
    />
  ) : (
    <PaneTerminal
      channel={channel}
      threadId={id}
      providerId="claude-code"
      providerAccountId={null}
      status={running ? "idle" : "completed"}
      providerPromptActive={false}
      label="Provider"
      running={running}
      focusRequest={0}
      theme="dark"
    />
  );
}
function firstTerm() {
  const term = mocks.terms[0];
  if (!term) throw new Error("Expected xterm instance");
  return term;
}
function output(index: number) {
  const listener = mocks.outputs[index];
  if (!listener) throw new Error(`Expected attachment ${index}`);
  act(() => listener(new Uint8Array(REPLAY_BYTES)));
}
function complete(term: TestTerminal, index: number) {
  const done = term.callbacks[index];
  if (!done) throw new Error(`Expected xterm completion ${index}`);
  done();
}

beforeEach(() => {
  mocks.terms = [];
  mocks.outputs = [];
  mocks.attach.mockReset().mockImplementation(async (_id: string, onOutput: (data: Uint8Array) => void) => {
    mocks.outputs.push(onOutput);
    return 16 + mocks.outputs.length;
  });
  mocks.ack.mockReset().mockResolvedValue(true);
  mocks.detach.mockReset().mockResolvedValue(true);
  mocks.write.mockReset().mockResolvedValue(undefined);
  mocks.resize.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

describe.each<Kind>(["shell", "provider"])("%s initial replay completion", (kind) => {
  it.each([true, false])("does not acknowledge or write after disposal (running=%s)", async (running) => {
    const view = render(tree(kind, running));
    await act(async () => {});
    const term = firstTerm();
    output(0);
    expect(term.callbacks).toHaveLength(1);
    view.unmount();
    expect(term.disposed).toBe(true);
    expect(mocks.detach).toHaveBeenCalledWith(17);
    const writes = term.writes.length;
    await act(async () => complete(term, 0));
    expect(mocks.ack).not.toHaveBeenCalled();
    expect(term.writes).toHaveLength(writes);
  });

  it("does not affect a replacement session", async () => {
    const view = render(tree(kind, false, "old"));
    await act(async () => {});
    const old = firstTerm();
    output(0);
    view.rerender(tree(kind, false, "new"));
    await act(async () => {});
    expect(mocks.terms).toHaveLength(2);
    output(1);
    const oldWrites = old.writes.length;
    await act(async () => complete(old, 0));
    expect(mocks.ack).not.toHaveBeenCalled();
    expect(old.writes).toHaveLength(oldWrites);
    const current = mocks.terms[1];
    if (!current) throw new Error("Expected replacement xterm");
    await act(async () => complete(current, 0));
    expect(mocks.ack).toHaveBeenCalledExactlyOnceWith(18, REPLAY_BYTES);
  });

  it("does not release or acknowledge a newer resync replay", async () => {
    render(tree(kind));
    await act(async () => {});
    const term = firstTerm();
    output(0); // Delay the initial replay completion.
    output(0); // A live output completion causes a flow-control resync.
    mocks.ack.mockResolvedValueOnce(false);
    await act(async () => complete(term, 1));
    expect(mocks.attach).toHaveBeenCalledTimes(2);
    expect(mocks.detach).toHaveBeenCalledWith(17);
    output(1); // New attachment's replay remains pending.
    mocks.ack.mockClear();
    const writes = term.writes.length;
    await act(async () => complete(term, 0));
    expect(mocks.ack).not.toHaveBeenCalled();
    expect(term.writes).toHaveLength(writes);
    // A synthetic xterm device report remains suppressed while the NEW replay is pending.
    // This does not claim to repair preservation of human input received during replay.
    await act(async () => term.queryStatus());
    expect(mocks.write).not.toHaveBeenCalled();
    await act(async () => complete(term, 2));
    expect(mocks.ack).toHaveBeenCalledExactlyOnceWith(18, REPLAY_BYTES);
  });

  it.each([true, false])(
    "acknowledges current replay and preserves normal cursor/input behavior (running=%s)",
    async (running) => {
      render(tree(kind, running));
      await act(async () => {});
      const term = firstTerm();
      output(0);
      const writes = term.writes.length;
      await act(async () => complete(term, 0));
      expect(mocks.ack).toHaveBeenCalledExactlyOnceWith(17, REPLAY_BYTES);
      if (kind === "shell" && !running) expect(term.writes.slice(writes)).toEqual(["\x1b[?25l"]);
      else expect(term.writes).toHaveLength(writes);
      await act(async () => term.onInput?.("echo after-replay\r"));
      if (running) expect(mocks.write).toHaveBeenCalledExactlyOnceWith("session", "echo after-replay\r");
      else expect(mocks.write).not.toHaveBeenCalled();
    },
  );
});
