import type { EventEnvelope, RailState } from "@kalcode/protocol";
import { ToastProvider } from "@kalcode/ui/components";
import { act, renderHook, screen, waitFor } from "@testing-library/react";
import { Activity, type ReactNode, StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KalCodeClient } from "../../ipc/client.ts";
import { createMemoryTransport } from "../../ipc/memoryTransport.ts";
import { RuntimeProvider, useRuntime } from "../../runtime/RuntimeProvider.tsx";
import { RailProvider, type RailValue, useRail } from "./RailProvider.tsx";

// Keep unrelated navigation/workspace providers stable while exercising the real rail,
// runtime event feed and IPC client against controlled memory responses.
const contexts = vi.hoisted(() => ({
  workspaces: { workspaces: [], active: null, activate: vi.fn(async () => true) },
  intents: { focus: vi.fn(async () => {}) },
  navigate: vi.fn(),
  enabled: true,
}));
vi.mock("../../runtime/WorkspaceProvider.tsx", () => ({ useWorkspaces: () => contexts.workspaces }));
vi.mock("../../runtime/uiIntents.tsx", () => ({ useUiIntents: () => contexts.intents }));
vi.mock("../navigation.tsx", () => ({ useNavigation: () => contexts, viewVisible: () => contexts.enabled }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function fixture() {
  const client = new KalCodeClient(createMemoryTransport("rail"));
  const boot = await client.boot();
  const settings = await client.getSettings();
  const rail = await client.railState();
  const seed = (await client.recentEvents(1))[0];
  if (!seed) throw new Error("Expected fixture event");
  vi.spyOn(client, "recentEvents").mockResolvedValue([]);
  const read = vi.spyOn(client, "railState").mockResolvedValue(rail);
  return {
    client,
    boot,
    settings,
    rail,
    read,
    // These feed probes exercise sequence/type routing only; rail does not inspect payloads.
    event: (seq: number, type: EventEnvelope["type"] = "settings.changed"): EventEnvelope =>
      ({ ...seed, id: `event-${seq}`, seq, type }) as EventEnvelope,
  };
}

async function mount(first: Awaited<ReturnType<typeof fixture>>, observe?: (rail: RailValue) => void) {
  let current = first;
  let visible = true;
  const view = renderHook(
    () => {
      const rail = useRail();
      observe?.(rail);
      return { rail, runtime: useRuntime() };
    },
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <StrictMode>
          <ToastProvider>
            <RuntimeProvider client={current.client} info={current.boot.info} initialSettings={current.settings}>
              <Activity mode={visible ? "visible" : "hidden"}>
                <RailProvider>{children}</RailProvider>
              </Activity>
            </RuntimeProvider>
          </ToastProvider>
        </StrictMode>
      ),
    },
  );
  await waitFor(() => expect(view.result.current.rail.state).toBe("ready"));
  return {
    ...view,
    replace(next: typeof first) {
      current = next;
      view.rerender();
    },
    visibility(next: boolean) {
      visible = next;
      view.rerender();
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  contexts.enabled = true;
  vi.clearAllMocks();
});

const mutations = [
  "update",
  "setSection",
  "createGroup",
  "renameGroup",
  "setGroupCollapsed",
  "deleteGroup",
  "moveGroup",
  "reveal",
] as const;
type Mutation = (typeof mutations)[number];
function invoke(rail: RailValue, action: Mutation, f: Awaited<ReturnType<typeof fixture>>) {
  const group = f.rail.groups[0]?.group;
  const entry = f.rail.pinned[0];
  if (!group || !entry) throw new Error("Expected rail fixtures");
  switch (action) {
    case "update":
      return rail.update({ workspaceId: entry.workspaceId, pinned: false });
    case "setSection":
      return rail.setSection("rail", true);
    case "createGroup":
      return rail.createGroup("New folder");
    case "renameGroup":
      return rail.renameGroup(group.id, "Renamed");
    case "setGroupCollapsed":
      return rail.setGroupCollapsed(group.id, true);
    case "deleteGroup":
      return rail.deleteGroup(group);
    case "moveGroup":
      return rail.moveGroup(group.id, 1);
    case "reveal":
      return rail.reveal(entry.workspaceId);
  }
}
function stubMutations(f: Awaited<ReturnType<typeof fixture>>, gate = Promise.resolve()) {
  const group = f.rail.groups[0]?.group;
  const entry = f.rail.pinned[0];
  if (!group || !entry) throw new Error("Expected rail fixtures");
  f.rail.groups.push({ workspaces: [], group: { ...group, id: "second-group" } });
  return [
    vi.spyOn(f.client, "railUpdate").mockImplementation(async () => {
      await gate;
      return entry;
    }),
    vi.spyOn(f.client, "railSectionSet").mockImplementation(async () => {
      await gate;
      return f.rail;
    }),
    vi.spyOn(f.client, "railGroupCreate").mockImplementation(async () => {
      await gate;
      return group;
    }),
    vi.spyOn(f.client, "railGroupUpdate").mockImplementation(async () => {
      await gate;
      return group;
    }),
    vi.spyOn(f.client, "railGroupDelete").mockImplementation(async () => {
      await gate;
    }),
    vi.spyOn(f.client, "railGroupReorder").mockImplementation(async () => {
      await gate;
      return f.rail.groups.map((g) => g.group);
    }),
    vi.spyOn(f.client, "revealWorkspace").mockImplementation(async () => {
      await gate;
    }),
  ];
}

describe("RailProvider runtime isolation", () => {
  it.each(["setSection", "setGroupCollapsed"] as const)(
    "retires a read started during %s when its authoritative write completes",
    async (action) => {
      const f = await fixture();
      const view = await mount(f);
      const write = deferred<void>();
      const page = deferred<RailState>();
      const committed: RailState =
        action === "setSection"
          ? { ...f.rail, collapsedSections: ["rail"] }
          : {
              ...f.rail,
              groups: f.rail.groups.map((group) => ({ ...group, group: { ...group.group, collapsed: true } })),
            };
      vi.spyOn(f.client, "railSectionSet").mockImplementation(async () => {
        await write.promise;
        return committed;
      });
      vi.spyOn(f.client, "railGroupUpdate").mockImplementation(async () => {
        await write.promise;
        const group = committed.groups[0]?.group;
        if (!group) throw new Error("Expected group");
        return group;
      });
      f.read.mockReturnValueOnce(page.promise).mockResolvedValue(committed);
      let writing!: ReturnType<typeof invoke>;
      let reading!: Promise<void>;
      act(() => {
        writing = invoke(view.result.current.rail, action, f);
      });
      act(() => {
        reading = view.result.current.rail.refresh();
      });
      await act(async () => {
        write.resolve();
        await writing;
      });
      expect(view.result.current.rail.rail).toEqual(committed);
      await act(async () => {
        page.resolve(f.rail);
        await reading;
      });
      expect(view.result.current.rail.rail).toEqual(committed);
    },
  );

  it("masks a disconnected snapshot before the reconnect refresh resolves", async () => {
    const f = await fixture();
    const renders: RailValue[] = [];
    const view = await mount(f, (rail) => renders.push(rail));
    view.visibility(false);
    const page = deferred<RailState>();
    f.read.mockReturnValue(page.promise);
    renders.length = 0;
    view.visibility(true);
    expect(renders.length).toBeGreaterThan(0);
    for (const rail of renders) expect(rail).toMatchObject({ rail: null, state: "loading", error: null });
    await act(async () => {
      page.resolve(f.rail);
    });
    expect(view.result.current.rail.rail).toEqual(f.rail);
  });

  it("masks the old snapshot in the replacement client's first render", async () => {
    const old = await fixture();
    const next = await fixture();
    const page = deferred<RailState>();
    next.read.mockReturnValue(page.promise);
    const renders: RailValue[] = [];
    const view = await mount(old, (rail) => renders.push(rail));
    renders.length = 0;
    view.replace(next);
    expect(renders.length).toBeGreaterThan(0);
    for (const rail of renders) expect(rail).toMatchObject({ rail: null, state: "loading", error: null });
    await act(async () => {
      page.resolve(next.rail);
    });
    expect(view.result.current.rail.rail).toEqual(next.rail);
  });

  it("blocks disabled callbacks and recovers with fresh handlers", async () => {
    const f = await fixture();
    const spies = stubMutations(f);
    const view = await mount(f);
    const retained = view.result.current.rail;
    contexts.enabled = false;
    view.rerender();
    f.read.mockClear();
    await act(async () => {
      await retained.refresh();
      await retained.createGroup("Old");
      await view.result.current.rail.createGroup("Disabled");
    });
    expect(f.read).not.toHaveBeenCalled();
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(view.result.current.rail.rail).toBeNull();
    contexts.enabled = true;
    view.rerender();
    await waitFor(() => expect(view.result.current.rail.state).toBe("ready"));
    await act(async () => {
      expect(await view.result.current.rail.createGroup("Current")).not.toBeNull();
    });
  });

  it("keeps current errors visible and recovers on refresh", async () => {
    const f = await fixture();
    const view = await mount(f);
    f.read.mockRejectedValueOnce(new Error("read failed"));
    await act(async () => view.result.current.rail.refresh());
    expect(view.result.current.rail.state).toBe("error");
    await act(async () => view.result.current.rail.refresh());
    expect(view.result.current.rail).toMatchObject({ state: "ready", error: null });
    vi.spyOn(f.client, "railGroupCreate").mockRejectedValueOnce(new Error("create failed"));
    await act(async () => {
      expect(await view.result.current.rail.createGroup("New")).toBeNull();
    });
    expect(screen.getByText("Couldn't create the folder")).toBeInTheDocument();
  });

  it("preserves the shared navigation fallback when the rail feature is disabled", async () => {
    const f = await fixture();
    const view = await mount(f);
    contexts.enabled = false;
    view.rerender();
    await act(async () => {
      await view.result.current.rail.openWorkspace("project", "project");
      await view.result.current.rail.openWorkspace("code", "code");
      view.result.current.rail.openThread("thread", "workspace");
    });
    expect(contexts.workspaces.activate).not.toHaveBeenCalled();
    expect(contexts.navigate).not.toHaveBeenCalled();
    expect(contexts.intents.focus.mock.calls).toEqual([
      [{ kind: "workspace", workspaceId: "project" }],
      [{ kind: "workspace", workspaceId: "code" }],
      [{ kind: "thread", threadId: "thread", workspaceId: "workspace" }],
    ]);
  });

  it("fences retained navigation and late activation completion", async () => {
    const old = await fixture();
    const next = await fixture();
    const view = await mount(old);
    const retained = view.result.current.rail;
    const activation = deferred<boolean>();
    contexts.workspaces.activate.mockReturnValueOnce(activation.promise);
    let pending!: Promise<void>;
    act(() => {
      pending = retained.openWorkspace("old");
    });
    view.replace(next);
    await waitFor(() => expect(view.result.current.rail.rail).toEqual(next.rail));
    await act(async () => {
      activation.resolve(true);
      await pending;
    });
    expect(contexts.navigate).not.toHaveBeenCalled();
    contexts.workspaces.activate.mockClear();
    await act(async () => {
      await retained.openWorkspace("old");
      await retained.openWorkspace("old", "code");
      retained.openThread("old-thread");
      retained.toggleHidden();
    });
    expect(contexts.workspaces.activate).not.toHaveBeenCalled();
    expect(contexts.intents.focus).not.toHaveBeenCalled();
    await act(async () => view.result.current.rail.openWorkspace("current"));
    expect(contexts.navigate).toHaveBeenCalledWith("folder");
    await act(async () => view.result.current.rail.openWorkspace("current", "code"));
    expect(contexts.intents.focus).toHaveBeenCalledWith({ kind: "workspace", workspaceId: "current" });
  });

  it.each(["setSection", "setGroupCollapsed"] as const)(
    "does not roll back optimistic %s with an older read",
    async (action) => {
      const f = await fixture();
      const write = deferred<void>();
      stubMutations(f, write.promise);
      const view = await mount(f);
      const page = deferred<RailState>();
      f.read.mockReturnValue(page.promise);
      let read!: Promise<void>;
      let mutation!: ReturnType<typeof invoke>;
      act(() => {
        read = view.result.current.rail.refresh();
      });
      act(() => {
        mutation = invoke(view.result.current.rail, action, f);
      });
      const optimistic = view.result.current.rail.rail;
      await act(async () => {
        page.resolve(f.rail);
        await read;
      });
      expect(view.result.current.rail.rail).toEqual(optimistic);
      await act(async () => {
        write.resolve();
        await mutation;
      });
    },
  );

  it.each(mutations)("blocks a retained %s callback after replacement and unmount", async (action) => {
    const old = await fixture();
    const next = await fixture();
    const spies = stubMutations(old);
    const nextSpies = stubMutations(next);
    const view = await mount(old);
    const retained = view.result.current.rail;
    view.replace(next);
    await waitFor(() => expect(view.result.current.rail.rail).toEqual(next.rail));
    await act(async () => {
      await invoke(retained, action, old);
    });
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    const unmounted = view.result.current.rail;
    view.unmount();
    await invoke(unmounted, action, next);
    for (const spy of nextSpies) expect(spy).not.toHaveBeenCalled();
  });

  it.each(mutations)("suppresses late %s errors without old reads or toast", async (action) => {
    const old = await fixture();
    const next = await fixture();
    const gate = deferred<void>();
    stubMutations(old, gate.promise);
    const view = await mount(old);
    let pending!: ReturnType<typeof invoke>;
    act(() => {
      pending = invoke(view.result.current.rail, action, old);
    });
    view.replace(next);
    await waitFor(() => expect(view.result.current.rail.rail).toEqual(next.rail));
    old.read.mockClear();
    await act(async () => {
      gate.reject(new Error("old client failed"));
      await pending;
    });
    expect(old.read).not.toHaveBeenCalled();
    expect(screen.queryByText("old client failed")).toBeNull();
    expect(view.result.current.rail.rail).toEqual(next.rail);
  });

  it.each(["update", "createGroup", "renameGroup", "deleteGroup"] as const)(
    "fences %s results after its refresh",
    async (action) => {
      const old = await fixture();
      const next = await fixture();
      stubMutations(old);
      const view = await mount(old);
      const page = deferred<RailState>();
      old.read.mockClear().mockReturnValue(page.promise);
      let pending!: ReturnType<typeof invoke>;
      act(() => {
        pending = invoke(view.result.current.rail, action, old);
      });
      await waitFor(() => expect(old.read).toHaveBeenCalled());
      view.replace(next);
      await waitFor(() => expect(view.result.current.rail.rail).toEqual(next.rail));
      await act(async () => {
        page.resolve(old.rail);
        expect(await pending).toBe(action === "renameGroup" ? false : action === "deleteGroup" ? undefined : null);
      });
      expect(screen.queryByText("Its workspaces moved to Recent.")).toBeNull();
    },
  );

  it("preserves current memory IPC mutations and result contracts", async () => {
    const f = await fixture();
    f.read.mockRestore();
    const view = await mount(f);
    let group!: NonNullable<Awaited<ReturnType<RailValue["createGroup"]>>>;
    await act(async () => {
      const created = await view.result.current.rail.createGroup("New folder");
      expect(created).not.toBeNull();
      if (!created) throw new Error("Expected created group");
      group = created;
    });
    await act(async () => {
      expect(await view.result.current.rail.renameGroup(group.id, "Renamed")).toBe(true);
    });
    await act(async () => {
      await view.result.current.rail.setGroupCollapsed(group.id, true);
    });
    expect(view.result.current.rail.rail?.groups.find((g) => g.group.id === group.id)?.group).toMatchObject({
      name: "Renamed",
      collapsed: true,
    });
    await act(async () => {
      await view.result.current.rail.setSection("recent", true);
    });
    expect(view.result.current.rail.rail?.collapsedSections).toContain("recent");
    await act(async () => {
      await view.result.current.rail.deleteGroup(group);
    });
    expect(view.result.current.rail.rail?.groups.some((g) => g.group.id === group.id)).toBe(false);
    expect(screen.getByText("Its workspaces moved to Recent.")).toBeInTheDocument();
  });

  it("clears scheduled refreshes on replacement and unmount", async () => {
    const old = await fixture();
    const next = await fixture();
    const view = await mount(old);
    vi.useFakeTimers();
    act(() => view.result.current.runtime.feed.merge([old.event(100)]));
    await act(async () => view.replace(next));
    old.read.mockClear();
    next.read.mockClear();
    act(() => view.result.current.runtime.feed.merge([next.event(1)]));
    view.unmount();
    await act(async () => vi.advanceTimersByTimeAsync(150));
    expect(old.read).not.toHaveBeenCalled();
    expect(next.read).not.toHaveBeenCalled();
  });
  it("does not let a retained refresh read the replaced client", async () => {
    const old = await fixture();
    const next = await fixture();
    next.rail = { ...next.rail, collapsedSections: ["rail"] };
    next.read.mockResolvedValue(next.rail);
    const view = await mount(old);
    const retained = view.result.current.rail.refresh;
    view.replace(next);
    await waitFor(() => expect(view.result.current.rail.rail).toEqual(next.rail));
    old.read.mockClear();
    await act(async () => retained());
    expect(old.read).not.toHaveBeenCalled();
    expect(view.result.current.rail.rail).toEqual(next.rail);
  });

  it("suppresses a stale mutation response and its follow-up read", async () => {
    const old = await fixture();
    const next = await fixture();
    const group = old.rail.groups[0]?.group;
    if (!group) throw new Error("Expected group");
    const gate = deferred<typeof group>();
    vi.spyOn(old.client, "railGroupCreate").mockReturnValue(gate.promise);
    const view = await mount(old);
    let pending!: ReturnType<typeof view.result.current.rail.createGroup>;
    act(() => {
      pending = view.result.current.rail.createGroup("New folder");
    });
    view.replace(next);
    await waitFor(() => expect(next.read).toHaveBeenCalled());
    old.read.mockClear();
    await act(async () => {
      gate.resolve(group);
      expect(await pending).toBeNull();
    });
    expect(old.read).not.toHaveBeenCalled();
  });

  it("does not revive an unfinished mutation when effects reconnect", async () => {
    const f = await fixture();
    const gate = deferred<RailState>();
    vi.spyOn(f.client, "railSectionSet").mockReturnValue(gate.promise);
    const view = await mount(f);
    let pending!: Promise<void>;
    act(() => {
      pending = view.result.current.rail.setSection("rail", true);
    });
    view.visibility(false);
    view.visibility(true);
    await waitFor(() => expect(view.result.current.rail.rail).toEqual(f.rail));
    await act(async () => {
      gate.resolve({ ...f.rail, collapsedSections: ["rail"] });
      await pending;
    });
    expect(view.result.current.rail.rail).toEqual(f.rail);
  });

  it("keeps a relevant refresh scheduled when an unrelated event arrives", async () => {
    const f = await fixture();
    const view = await mount(f);
    vi.useFakeTimers();
    f.read.mockClear();
    act(() => view.result.current.runtime.feed.merge([f.event(1000)]));
    act(() => view.result.current.runtime.feed.merge([f.event(1001, "app.started")]));
    await act(async () => vi.advanceTimersByTimeAsync(150));
    expect(f.read).toHaveBeenCalledTimes(1);
  });

  it("starts a fresh event watermark for a replacement runtime", async () => {
    const old = await fixture();
    const next = await fixture();
    const view = await mount(old);
    vi.useFakeTimers();
    act(() => view.result.current.runtime.feed.merge([old.event(1000)]));
    await act(async () => vi.advanceTimersByTimeAsync(150));
    await act(async () => view.replace(next));
    next.read.mockClear();
    act(() => view.result.current.runtime.feed.merge([next.event(1)]));
    await act(async () => vi.advanceTimersByTimeAsync(150));
    expect(next.read).toHaveBeenCalledTimes(1);
  });
});
