import type { ShellOption, Workspace } from "@kalcode/protocol";
import { ToastProvider } from "@kalcode/ui/components";
import { act, renderHook, screen, waitFor } from "@testing-library/react";
import { type ReactNode, StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";
import { KalCodeClient } from "../ipc/client.ts";
import { createMemoryTransport } from "../ipc/memoryTransport.ts";
import { RuntimeProvider } from "./RuntimeProvider.tsx";
import { useWorkspaces, WorkspaceProvider } from "./WorkspaceProvider.tsx";

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
  const view = renderHook(useWorkspaces, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <StrictMode>
        <ToastProvider>
          <RuntimeProvider client={current.client} info={current.boot.info} initialSettings={current.settings}>
            <WorkspaceProvider>{children}</WorkspaceProvider>
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
  };
}

describe("WorkspaceProvider lifecycle", () => {
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
