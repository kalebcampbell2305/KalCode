import type { ShellOption, TerminalInfo, Workspace } from "@kalcode/protocol";
import { ToastProvider } from "@kalcode/ui/components";
import { act, renderHook, screen, waitFor } from "@testing-library/react";
import { Activity, type ReactNode, StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";
import { KalCodeClient } from "../ipc/client.ts";
import { createMemoryTransport } from "../ipc/memoryTransport.ts";
import { RuntimeProvider } from "./RuntimeProvider.tsx";
import { useWorkspaces, WorkspaceProvider, type WorkspaceValue } from "./WorkspaceProvider.tsx";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function workspace(id: string): Workspace {
  return {
    id,
    name: id,
    rootPath: `/projects/${id}`,
    displayPath: `/projects/${id}`,
    createdAt: "2026-09-25T00:00:00Z",
    lastOpenedAt: "2026-09-25T00:00:00Z",
    activeTerminalId: null,
    available: true,
  };
}

const terminal: TerminalInfo = {
  id: "created",
  workspaceId: "old",
  shellId: "sh",
  title: "Shell",
  position: 0,
  status: "running",
  startedAt: null,
  endedAt: null,
  exitCode: null,
};
const actions = ["openFolder", "createTerminal", "restartTerminal", "remove", "closeTerminal"] as const;
type Action = (typeof actions)[number];
function dispatch(value: WorkspaceValue, action: Action) {
  switch (action) {
    case "openFolder":
      return value.openFolder();
    case "createTerminal":
      return value.createTerminal();
    case "restartTerminal":
      return value.restartTerminal("old-terminal");
    case "remove":
      return value.remove(workspace("old"));
    case "closeTerminal":
      return value.closeTerminal("old-terminal");
  }
}
function mockActions(client: KalCodeClient, gate = Promise.resolve()) {
  return [
    vi.spyOn(client, "openWorkspaceDialog").mockImplementation(async () => {
      await gate;
      return workspace("old");
    }),
    vi.spyOn(client, "createTerminal").mockImplementation(async () => {
      await gate;
      return terminal;
    }),
    vi.spyOn(client, "restartTerminal").mockImplementation(async () => {
      await gate;
      return terminal;
    }),
    vi.spyOn(client, "removeWorkspace").mockImplementation(async () => {
      await gate;
    }),
    vi.spyOn(client, "closeTerminal").mockImplementation(async () => {
      await gate;
    }),
    vi.spyOn(client, "setActiveTerminal").mockResolvedValue(undefined),
  ];
}

async function fixture(id = "initial") {
  const client = new KalCodeClient(createMemoryTransport("default"));
  const boot = await client.boot();
  const settings = await client.getSettings();
  const native = { active: workspace(id) };
  vi.spyOn(client, "listWorkspaces").mockImplementation(async () => [native.active]);
  vi.spyOn(client, "activeWorkspace").mockImplementation(async () => native.active);
  vi.spyOn(client, "runningTerminals").mockResolvedValue([]);
  vi.spyOn(client, "listTerminals").mockResolvedValue([]);
  vi.spyOn(client, "listShells").mockResolvedValue([{ id, name: id, isDefault: true }]);
  return { client, boot, native, settings };
}

async function mount(initial: Awaited<ReturnType<typeof fixture>>, ready = true) {
  let current = initial;
  let visible = true;
  const view = renderHook(useWorkspaces, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <StrictMode>
        <ToastProvider>
          <RuntimeProvider client={current.client} info={current.boot.info} initialSettings={current.settings}>
            <Activity mode={visible ? "visible" : "hidden"}>
              <WorkspaceProvider>{children}</WorkspaceProvider>
            </Activity>
          </RuntimeProvider>
        </ToastProvider>
      </StrictMode>
    ),
  });
  if (ready) await waitFor(() => expect(view.result.current.state).toBe("ready"));
  return {
    ...view,
    replace(next: typeof initial) {
      current = next;
      view.rerender();
    },
    setVisible(next: boolean) {
      visible = next;
      view.rerender();
    },
  };
}

describe("WorkspaceProvider lifecycle", () => {
  it("keeps the latest of two creations focused without closing the earlier native session", async () => {
    const f = await fixture("old");
    const a = deferred<TerminalInfo>();
    const b = deferred<TerminalInfo>();
    const sessions: TerminalInfo[] = [];
    mockActions(f.client);
    vi.mocked(f.client.createTerminal)
      .mockImplementationOnce(async () => {
        const created = await a.promise;
        sessions.push(created);
        return created;
      })
      .mockImplementationOnce(async () => {
        const created = await b.promise;
        sessions.push(created);
        return created;
      });
    vi.mocked(f.client.listTerminals).mockImplementation(async () => [...sessions]);
    const view = await mount(f);
    let first!: Promise<TerminalInfo | null>;
    let second!: Promise<TerminalInfo | null>;
    act(() => {
      first = view.result.current.createTerminal();
      second = view.result.current.createTerminal();
    });
    await act(async () => {
      b.resolve({ ...terminal, id: "second" });
      await second;
    });
    await act(async () => {
      a.resolve({ ...terminal, id: "first" });
      await first;
    });
    expect(await first).toBeNull();
    expect((await second)?.id).toBe("second");
    expect(view.result.current.activeTerminalId).toBe("second");
    expect(view.result.current.focusRequest.terminalId).toBe("second");
    expect(view.result.current.terminals).toHaveLength(2);
    expect(f.client.closeTerminal).not.toHaveBeenCalled();
  });

  it("preserves explicit workspace selection while activation has not rendered", async () => {
    const f = await fixture("old");
    mockActions(f.client);
    const gate = deferred<Workspace>();
    vi.spyOn(f.client, "activateWorkspace").mockImplementation(async () => {
      f.native.active = await gate.promise;
      return f.native.active;
    });
    const view = await mount(f);
    let pending!: Promise<boolean>;
    act(() => {
      pending = view.result.current.activate("next");
    });
    act(() => view.result.current.selectTerminal("target", true, "next"));
    expect(f.client.setActiveTerminal).toHaveBeenCalledWith("next", "target");
    expect(view.result.current.focusRequest.terminalId).toBe("target");
    await act(async () => {
      gate.resolve(workspace("next"));
      await pending;
    });
    expect(view.result.current.focusRequest.terminalId).toBe("target");
  });

  it.each(["createTerminal", "restartTerminal"] as const)(
    "does not supersede current %s focus on an ordinary refresh",
    async (action) => {
      const f = await fixture("old");
      const gate = deferred<void>();
      mockActions(f.client, gate.promise);
      const view = await mount(f);
      let pending!: ReturnType<typeof dispatch>;
      act(() => {
        pending = dispatch(view.result.current, action);
      });
      await act(async () => {
        await view.result.current.refresh();
      });
      let result: unknown;
      await act(async () => {
        gate.resolve();
        result = await pending;
      });
      expect(result).toEqual(terminal);
      expect(view.result.current.focusRequest.terminalId).toBe(terminal.id);
    },
  );

  it.each(["createTerminal", "restartTerminal"] as const)(
    "does not leave a latent focus request after an external workspace change during %s",
    async (action) => {
      const f = await fixture("old");
      const gate = deferred<void>();
      mockActions(f.client, gate.promise);
      const view = await mount(f);
      let pending!: ReturnType<typeof dispatch>;
      act(() => {
        pending = dispatch(view.result.current, action);
      });
      f.native.active = workspace("next");
      await act(async () => {
        await view.result.current.refresh();
      });
      await act(async () => {
        gate.resolve();
        expect(await pending).toBeNull();
      });
      f.native.active = workspace("old");
      await act(async () => {
        await view.result.current.refresh();
      });
      expect(view.result.current.focusRequest.terminalId).toBe("");
    },
  );

  it.each(["createTerminal", "restartTerminal"] as const)(
    "preserves a later non-focusing pane selection during %s",
    async (action) => {
      const f = await fixture("old");
      const gate = deferred<void>();
      mockActions(f.client, gate.promise);
      vi.mocked(f.client.listTerminals).mockResolvedValue([{ ...terminal, id: "chosen" }, terminal]);
      const view = await mount(f);
      let pending!: ReturnType<typeof dispatch>;
      act(() => {
        pending = dispatch(view.result.current, action);
      });
      act(() => view.result.current.selectTerminal("chosen", false));
      await act(async () => {
        gate.resolve();
        expect(await pending).toBeNull();
      });
      expect(view.result.current.activeTerminalId).toBe("chosen");
      expect(view.result.current.focusRequest.terminalId).toBe("");
    },
  );

  it("preserves the neighbour selected by close while creation is pending", async () => {
    const f = await fixture("old");
    f.native.active.activeTerminalId = "closing";
    const gate = deferred<void>();
    mockActions(f.client, gate.promise);
    vi.mocked(f.client.closeTerminal).mockResolvedValue(undefined);
    vi.mocked(f.client.listTerminals).mockResolvedValue([
      { ...terminal, id: "closing" },
      { ...terminal, id: "neighbour" },
      terminal,
    ]);
    const view = await mount(f);
    let pending!: Promise<TerminalInfo | null>;
    act(() => {
      pending = view.result.current.createTerminal();
    });
    await act(async () => {
      await view.result.current.closeTerminal("closing");
    });
    let result: TerminalInfo | null = terminal;
    await act(async () => {
      gate.resolve();
      result = await pending;
    });
    expect(result).toBeNull();
    expect(view.result.current.activeTerminalId).toBe("neighbour");
    expect(view.result.current.focusRequest.terminalId).toBe("");
    expect(f.client.closeTerminal).toHaveBeenCalledExactlyOnceWith("closing");
  });

  it.each(["createTerminal", "restartTerminal"] as const)(
    "keeps a newer terminal selection when pending %s completes",
    async (action) => {
      const f = await fixture("old");
      const gate = deferred<void>();
      const calls = mockActions(f.client, gate.promise);
      const chosen = { ...terminal, id: "chosen" };
      vi.mocked(f.client.listTerminals).mockResolvedValue([chosen, terminal]);
      const view = await mount(f);
      let pending!: ReturnType<typeof dispatch>;
      act(() => {
        pending = dispatch(view.result.current, action);
      });
      act(() => view.result.current.selectTerminal("chosen", true));
      let result: unknown;
      await act(async () => {
        gate.resolve();
        result = await pending;
      });
      expect(result).toBeNull();
      expect(view.result.current.activeTerminalId).toBe("chosen");
      expect(view.result.current.focusRequest.terminalId).toBe("chosen");
      expect(f.client.closeTerminal).not.toHaveBeenCalled();
      expect(calls[action === "createTerminal" ? 1 : 2]).toHaveBeenCalledTimes(1);
      expect(view.result.current.terminals).toContainEqual(terminal);
    },
  );

  it.each(["createTerminal", "restartTerminal"] as const)(
    "does not focus the old workspace when pending %s completes after activation",
    async (action) => {
      const f = await fixture("old");
      const gate = deferred<void>();
      mockActions(f.client, gate.promise);
      vi.spyOn(f.client, "activateWorkspace").mockImplementation(async (id) => {
        f.native.active = workspace(id);
        return f.native.active;
      });
      const view = await mount(f);
      let pending!: ReturnType<typeof dispatch>;
      act(() => {
        pending = dispatch(view.result.current, action);
      });
      await act(async () => {
        expect(await view.result.current.activate("new")).toBe(true);
      });
      let result: unknown;
      await act(async () => {
        gate.resolve();
        result = await pending;
      });
      expect(result).toBeNull();
      expect(view.result.current.active?.id).toBe("new");
      expect(view.result.current.focusRequest.terminalId).toBe("");
      expect(f.client.closeTerminal).not.toHaveBeenCalled();
    },
  );

  it("does not revive an old action when effects reconnect on the same client", async () => {
    const f = await fixture("old");
    const gate = deferred<void>();
    mockActions(f.client, gate.promise);
    const view = await mount(f);
    let pending!: Promise<TerminalInfo | null>;
    act(() => {
      pending = view.result.current.createTerminal();
    });
    view.setVisible(false);
    view.setVisible(true);
    await waitFor(() => expect(view.result.current.state).toBe("ready"));
    let result: TerminalInfo | null = terminal;
    await act(async () => {
      gate.resolve();
      result = await pending;
    });
    expect(result).toBeNull();
    expect(view.result.current.focusRequest.terminalId).toBe("");
  });

  it.each(actions)("keeps current-client %s behavior", async (action) => {
    const f = await fixture("old");
    mockActions(f.client);
    const view = await mount(f);
    let result: unknown;
    await act(async () => {
      result = await dispatch(view.result.current, action);
    });
    if (action === "remove") {
      expect(result).toBe(true);
      expect(screen.getByText("old removed from KalCode")).toBeInTheDocument();
    } else if (action === "openFolder") expect(result).toEqual(workspace("old"));
    else if (action === "closeTerminal") expect(result).toBeUndefined();
    else {
      expect(result).toEqual(terminal);
      expect(view.result.current.focusRequest.terminalId).toBe(terminal.id);
    }
    expect(view.result.current.picking).toBe(false);
    act(() => view.result.current.selectTerminal("selected", true));
    expect(f.client.setActiveTerminal).toHaveBeenCalledWith("old", "selected");
    expect(view.result.current.focusRequest.terminalId).toBe("selected");
  });

  it("keeps picking true until overlapping current pickers have settled", async () => {
    const f = await fixture();
    const first = deferred<Workspace | null>();
    const second = deferred<Workspace | null>();
    vi.spyOn(f.client, "openWorkspaceDialog").mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const view = await mount(f);
    let a!: Promise<Workspace | null>;
    let b!: Promise<Workspace | null>;
    act(() => {
      a = view.result.current.openFolder();
      b = view.result.current.openFolder();
    });
    await act(async () => {
      first.resolve(null);
      await a;
    });
    expect(view.result.current.picking).toBe(true);
    await act(async () => {
      second.resolve(null);
      await b;
    });
    expect(view.result.current.picking).toBe(false);
  });

  it.each(actions)("suppresses an in-flight %s result after unmount", async (action) => {
    const f = await fixture("old");
    const gate = deferred<void>();
    mockActions(f.client, gate.promise);
    const view = await mount(f);
    let pending!: ReturnType<typeof dispatch>;
    act(() => {
      pending = dispatch(view.result.current, action);
    });
    view.unmount();
    let result: unknown;
    await act(async () => {
      gate.resolve();
      result = await pending;
    });
    expect(result).toBe(action === "remove" ? false : action === "closeTerminal" ? undefined : null);
  });

  it.each(["openFolder", "createTerminal", "restartTerminal", "remove"] as const)(
    "rechecks %s lifetime after its pending refresh",
    async (action) => {
      const old = await fixture("old");
      const next = await fixture("next");
      const read = deferred<Workspace | null>();
      mockActions(old.client);
      const view = await mount(old);
      vi.mocked(old.client.activeWorkspace).mockClear().mockReturnValue(read.promise);
      let pending!: ReturnType<typeof dispatch>;
      act(() => {
        pending = dispatch(view.result.current, action);
      });
      await waitFor(() => expect(old.client.activeWorkspace).toHaveBeenCalled());
      view.replace(next);
      await waitFor(() => expect(view.result.current.active?.id).toBe("next"));
      let result: unknown;
      await act(async () => {
        read.resolve(workspace("old"));
        result = await pending;
      });
      expect(result).toBe(action === "remove" ? false : null);
      expect(view.result.current.focusRequest.terminalId).toBe("");
      expect(screen.queryByText("old removed from KalCode")).not.toBeInTheDocument();
    },
  );

  it.each(["replace", "unmount"] as const)("rejects all retained mutation callbacks after %s", async (transition) => {
    const old = await fixture("old");
    const next = await fixture("next");
    const calls = mockActions(old.client);
    const view = await mount(old);
    const retained = view.result.current;
    if (transition === "replace") {
      view.replace(next);
      await waitFor(() => expect(view.result.current.active?.id).toBe("next"));
    } else view.unmount();
    const nextReads = vi.mocked(next.client.listWorkspaces).mock.calls.length;
    await act(async () => {
      for (const action of actions) await dispatch(retained, action);
      retained.selectTerminal("old-terminal", true, "old");
      retained.retry();
    });
    for (const call of calls) expect(call).not.toHaveBeenCalled();
    expect(next.client.listWorkspaces).toHaveBeenCalledTimes(nextReads);
    if (transition === "replace") {
      expect(view.result.current.focusRequest.terminalId).toBe("");
      expect(view.result.current.picking).toBe(false);
    }
  });

  it.each(
    actions.flatMap((action) => [
      { action, rejects: false },
      { action, rejects: true },
    ]),
  )("ignores obsolete $action completion (rejects=$rejects)", async ({ action, rejects }) => {
    const old = await fixture("old");
    const next = await fixture("next");
    const gate = deferred<void>();
    const nextPicker = deferred<Workspace | null>();
    mockActions(old.client, gate.promise);
    vi.spyOn(next.client, "openWorkspaceDialog").mockReturnValue(nextPicker.promise);
    const view = await mount(old);
    let pending!: ReturnType<typeof dispatch>;
    act(() => {
      pending = dispatch(view.result.current, action);
    });
    view.replace(next);
    await waitFor(() => expect(view.result.current.active?.id).toBe("next"));
    expect(view.result.current.picking).toBe(false);
    let picking!: Promise<Workspace | null>;
    act(() => {
      picking = view.result.current.openFolder();
    });
    expect(view.result.current.picking).toBe(true);
    let result: unknown;
    await act(async () => {
      if (rejects)
        gate.reject({ category: "database", code: "database_error", message: "Old failure", retryable: false });
      else gate.resolve();
      result = await pending;
    });
    expect(result).toBe(action === "remove" ? false : action === "closeTerminal" ? undefined : null);
    expect(view.result.current.focusRequest.terminalId).toBe("");
    expect(view.result.current.active?.id).toBe("next");
    expect(view.result.current.picking).toBe(true);
    expect(screen.queryByText("Old failure")).not.toBeInTheDocument();
    expect(screen.queryByText("old removed from KalCode")).not.toBeInTheDocument();
    await act(async () => {
      nextPicker.resolve(null);
      await picking;
    });
    expect(view.result.current.picking).toBe(false);
  });

  it("does not hold a newer native activation behind an obsolete refresh", async () => {
    const f = await fixture();
    const read = deferred<Workspace | null>();
    const activate = vi.spyOn(f.client, "activateWorkspace").mockImplementation(async (id) => {
      f.native.active = workspace(id);
      return f.native.active;
    });
    const view = await mount(f);
    vi.mocked(f.client.activeWorkspace).mockImplementation(async () =>
      f.native.active.id === "a" ? read.promise : f.native.active,
    );
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      first = view.result.current.activate("a");
    });
    await waitFor(() => expect(activate).toHaveBeenCalledWith("a"));
    act(() => {
      second = view.result.current.activate("b");
    });
    try {
      await waitFor(() => expect(activate).toHaveBeenCalledWith("b"));
      await act(async () => {
        expect(await second).toBe(true);
      });
      expect(view.result.current.active?.id).toBe("b");
    } finally {
      await act(async () => {
        read.resolve(workspace("a"));
        await Promise.all([first, second]);
      });
    }
    expect(await first).toBe(false);
    expect(view.result.current.active?.id).toBe("b");
  });

  it("serializes native activation so a slower earlier intent cannot overwrite the latest", async () => {
    const f = await fixture();
    const a = deferred<Workspace>();
    const b = deferred<Workspace>();
    const activate = vi.spyOn(f.client, "activateWorkspace").mockImplementation(async (id) => {
      const next = await (id === "a" ? a.promise : b.promise);
      f.native.active = next;
      return next;
    });
    const view = await mount(f);
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      first = view.result.current.activate("a");
    });
    await waitFor(() => expect(activate).toHaveBeenCalledWith("a"));
    act(() => {
      second = view.result.current.activate("b");
    });
    await act(async () => {
      b.resolve(workspace("b"));
    });
    await act(async () => {
      a.resolve(workspace("a"));
      await Promise.all([first, second]);
    });
    expect(f.native.active.id).toBe("b");
    expect(view.result.current.active?.id).toBe("b");
    expect(await first).toBe(false);
    expect(await second).toBe(true);
  });

  it("skips superseded queued intents and drains the queue after an obsolete failure", async () => {
    const f = await fixture();
    const a = deferred<Workspace>();
    const activate = vi.spyOn(f.client, "activateWorkspace").mockImplementation(async (id) => {
      if (id === "a") return a.promise;
      f.native.active = workspace(id);
      return f.native.active;
    });
    const view = await mount(f);
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    let third!: Promise<boolean>;
    act(() => {
      first = view.result.current.activate("a");
    });
    await waitFor(() => expect(activate).toHaveBeenCalledWith("a"));
    act(() => {
      second = view.result.current.activate("b");
      third = view.result.current.activate("c");
    });
    await act(async () => {
      a.reject(new Error("Obsolete failure"));
      await Promise.all([first, second, third]);
    });
    expect(activate.mock.calls.map(([id]) => id)).toEqual(["a", "c"]);
    expect(await first).toBe(false);
    expect(await second).toBe(false);
    expect(await third).toBe(true);
    expect(screen.queryByText("Couldn't switch workspace")).not.toBeInTheDocument();
  });

  it("rejects retained refresh and activation callbacks after client replacement", async () => {
    const old = await fixture("old");
    const next = await fixture("next");
    const activation = vi.spyOn(old.client, "activateWorkspace");
    const view = await mount(old);
    const retained = view.result.current;
    view.replace(next);
    await waitFor(() => expect(view.result.current.active?.id).toBe("next"));
    const reads = vi.mocked(old.client.listWorkspaces).mock.calls.length;
    await act(async () => {
      await retained.refresh();
    });
    expect(view.result.current.active?.id).toBe("next");
    expect(old.client.listWorkspaces).toHaveBeenCalledTimes(reads);
    await act(async () => {
      expect(await retained.activate("old")).toBe(false);
    });
    expect(activation).not.toHaveBeenCalled();
  });

  it("ignores late shell discovery from an obsolete client", async () => {
    const old = await fixture("old");
    const next = await fixture("next");
    const shells = deferred<ShellOption[]>();
    vi.mocked(old.client.listShells).mockReturnValue(shells.promise);
    const view = await mount(old, false);
    view.replace(next);
    await waitFor(() => expect(view.result.current.shells[0]?.id).toBe("next"));
    await act(async () => {
      shells.resolve([{ id: "old", name: "Old", isDefault: true }]);
    });
    expect(view.result.current.shells[0]?.id).toBe("next");
  });

  it("does not start obsolete terminal reads after a delayed workspace refresh", async () => {
    const old = await fixture("old");
    const next = await fixture("next");
    const read = deferred<Workspace | null>();
    const view = await mount(old);
    vi.mocked(old.client.activeWorkspace).mockReturnValue(read.promise);
    const terminalReads = vi.mocked(old.client.listTerminals).mock.calls.length;
    let pending!: Promise<void>;
    act(() => {
      pending = view.result.current.refresh();
    });
    view.replace(next);
    await waitFor(() => expect(view.result.current.active?.id).toBe("next"));
    await act(async () => {
      read.resolve(workspace("old"));
      await pending;
    });
    expect(old.client.listTerminals).toHaveBeenCalledTimes(terminalReads);
    expect(view.result.current.active?.id).toBe("next");
  });

  it("discards an old client's queued activation while the replacement client works independently", async () => {
    const old = await fixture("old");
    const next = await fixture("next");
    const pending = deferred<Workspace>();
    const activate = vi.spyOn(old.client, "activateWorkspace").mockReturnValue(pending.promise);
    vi.spyOn(next.client, "activateWorkspace").mockImplementation(async (id) => {
      next.native.active = workspace(id);
      return next.native.active;
    });
    const view = await mount(old);
    let first!: Promise<boolean>;
    let queued!: Promise<boolean>;
    act(() => {
      first = view.result.current.activate("a");
    });
    await waitFor(() => expect(activate).toHaveBeenCalledTimes(1));
    act(() => {
      queued = view.result.current.activate("b");
    });
    view.replace(next);
    await waitFor(() => expect(view.result.current.active?.id).toBe("next"));
    await act(async () => {
      expect(await view.result.current.activate("new")).toBe(true);
    });
    await act(async () => {
      pending.reject(new Error("Old client failure"));
      await Promise.all([first, queued]);
    });
    expect(await first).toBe(false);
    expect(await queued).toBe(false);
    expect(activate).toHaveBeenCalledTimes(1);
    expect(view.result.current.active?.id).toBe("new");
    expect(screen.queryByText("Couldn't switch workspace")).not.toBeInTheDocument();
  });

  it("reports a current activation failure and allows the next activation to succeed", async () => {
    const f = await fixture();
    vi.spyOn(f.client, "activateWorkspace")
      .mockRejectedValueOnce({ category: "database", code: "database_error", message: "Busy", retryable: true })
      .mockImplementation(async (id) => {
        f.native.active = workspace(id);
        return f.native.active;
      });
    const view = await mount(f);
    await act(async () => {
      expect(await view.result.current.activate("bad")).toBe(false);
    });
    expect(screen.getByText("Couldn't switch workspace")).toBeInTheDocument();
    await act(async () => {
      expect(await view.result.current.activate("good")).toBe(true);
    });
    expect(view.result.current.active?.id).toBe("good");
  });

  it("invalidates queued activations and retained callbacks when unmounted", async () => {
    const f = await fixture();
    const pending = deferred<Workspace>();
    const activate = vi.spyOn(f.client, "activateWorkspace").mockReturnValue(pending.promise);
    const view = await mount(f);
    const retained = view.result.current;
    let first!: Promise<boolean>;
    let queued!: Promise<boolean>;
    act(() => {
      first = retained.activate("a");
    });
    await waitFor(() => expect(activate).toHaveBeenCalledTimes(1));
    act(() => {
      queued = retained.activate("b");
    });
    view.unmount();
    await act(async () => {
      pending.resolve(workspace("a"));
      await Promise.all([first, queued]);
    });
    expect(await first).toBe(false);
    expect(await queued).toBe(false);
    expect(await retained.activate("c")).toBe(false);
    expect(activate).toHaveBeenCalledTimes(1);
  });
});
