import type { EventEnvelope, Settings } from "@kalcode/protocol";
import { SegmentedControl, ToastProvider } from "@kalcode/ui/components";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, StrictMode, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { KalCodeClient } from "../ipc/client.ts";
import { createMemoryTransport, type MemoryTransport } from "../ipc/memoryTransport.ts";
import type { CommandName } from "../ipc/transport.ts";
import { RuntimeProvider, useEvents, useRuntime } from "./RuntimeProvider.tsx";

const INITIAL: Settings = { theme: "dark", motion: "system", density: "comfortable", sidebarCollapsed: false };

function Probe() {
  const { settings, updateSettings } = useRuntime();
  const { events } = useEvents();
  return (
    <div>
      <output data-testid="theme">{settings.theme}</output>
      <output data-testid="density">{settings.density}</output>
      <output data-testid="events">{events.length}</output>
      <button type="button" onClick={() => void updateSettings({ theme: "light" })}>
        light
      </button>
      <button type="button" onClick={() => void updateSettings({ density: "compact" })}>
        compact
      </button>
    </div>
  );
}

async function mount(transport: MemoryTransport) {
  const client = new KalCodeClient(transport);
  const boot = await client.boot();
  const view = render(
    <StrictMode>
      <ToastProvider>
        <RuntimeProvider client={client} info={boot.info} initialSettings={INITIAL}>
          <Probe />
        </RuntimeProvider>
      </ToastProvider>
    </StrictMode>,
  );
  await waitFor(() => expect(Number(screen.getByTestId("events").textContent)).toBeGreaterThan(0));
  return { ...view, client, boot };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const SAVE_ERROR = { category: "database", code: "database_error", message: "Disk full.", retryable: false };

async function isolatedClient(firstSeq: number) {
  const client = new KalCodeClient(createMemoryTransport("default"));
  const boot = await client.boot();
  const seed = (await client.recentEvents(1))[0];
  if (!seed) throw new Error("Expected a fixture event");
  const event = (seq: number): EventEnvelope => ({ ...seed, id: `event-${seq}`, seq });
  const callbacks: ((event: EventEnvelope) => void)[] = [];
  const subscribe = vi.spyOn(client, "subscribeEvents").mockImplementation(async (listener) => {
    callbacks.push(listener);
    return async () => {};
  });
  const page = Array.from({ length: 100 }, (_, index) => event(firstSeq + 99 - index));
  const recent = vi.spyOn(client, "recentEvents").mockResolvedValue(page);
  return { client, boot, event, callbacks, subscribe, recent };
}

function exposeRuntime(
  first: Awaited<ReturnType<typeof isolatedClient>>,
  onCapture?: (runtime: ReturnType<typeof useRuntime>) => void,
) {
  let current!: ReturnType<typeof useRuntime>;
  const renders: ReturnType<typeof useRuntime>[] = [];
  function Capture() {
    current = useRuntime();
    renders.push(current);
    onCapture?.(current);
    return null;
  }
  function tree(fixture: typeof first | null, settings = INITIAL) {
    return (
      <StrictMode>
        <ToastProvider>
          {fixture && (
            <RuntimeProvider client={fixture.client} info={fixture.boot.info} initialSettings={settings}>
              <Capture />
            </RuntimeProvider>
          )}
        </ToastProvider>
      </StrictMode>
    );
  }
  const view = render(tree(first));
  return {
    current: () => current,
    renders,
    replace: (fixture: typeof first, settings = INITIAL) => view.rerender(tree(fixture, settings)),
    // Keep the toast host alive so late errors after runtime unmount remain observable.
    removeRuntime: () => view.rerender(tree(null)),
  };
}

describe("RuntimeProvider client isolation", () => {
  it("reports persisted, failed and retired settings writes explicitly", async () => {
    const first = await isolatedClient(100);
    const view = exposeRuntime(first);
    await waitFor(() => expect(view.current().eventsState).toBe("ready"));
    vi.spyOn(first.client, "updateSettings").mockRejectedValueOnce(SAVE_ERROR);
    await act(async () => {
      expect(await view.current().updateSettings({ theme: "light" })).toBe(false);
    });
    await act(async () => {
      expect(await view.current().updateSettings({ theme: "light" })).toBe(true);
    });
    const retained = view.current().updateSettings;
    view.removeRuntime();
    expect(await retained({ theme: "dark" })).toBe(false);
  });
  it("exposes a fresh feed, initial settings and loading state on the first replacement render", async () => {
    const first = await isolatedClient(100);
    first.recent.mockRejectedValueOnce(SAVE_ERROR);
    const view = exposeRuntime(first);
    await waitFor(() => expect(view.current().eventsState).toBe("error"));
    act(() => view.current().feed.merge([first.event(900)]));
    const oldFeed = view.current().feed;
    const replacement = await isolatedClient(1);
    const read = deferred<EventEnvelope[]>();
    replacement.recent.mockReturnValue(read.promise);
    view.replace(replacement, { ...INITIAL, theme: "light" });
    const firstReplacement = view.renders.find((runtime) => runtime.client === replacement.client);
    expect(firstReplacement?.feed).not.toBe(oldFeed);
    expect(firstReplacement?.feed.getSnapshot().events).toEqual([]);
    expect(firstReplacement?.settings.theme).toBe("light");
    expect(firstReplacement?.eventsState).toBe("loading");
    expect(firstReplacement?.eventsError).toBeNull();
    await act(async () => read.resolve([replacement.event(1)]));
    expect(
      view
        .current()
        .feed.getSnapshot()
        .events.map((event) => event.seq),
    ).toEqual([1]);
    // Initial settings are consumed once for this client lifetime.
    view.replace(replacement, { ...INITIAL, theme: "dark" });
    expect(view.current().settings.theme).toBe("light");
  });

  it("does not reuse the first lifetime when the same client is selected again", async () => {
    const first = await isolatedClient(100);
    const replacement = await isolatedClient(1);
    const view = exposeRuntime(first);
    await waitFor(() => expect(view.current().eventsState).toBe("ready"));
    const oldFeed = view.current().feed;
    await act(() => view.current().updateSettings({ theme: "light" }));
    view.replace(replacement);
    await waitFor(() => expect(view.current().eventsState).toBe("ready"));
    first.recent.mockResolvedValue([first.event(2)]);
    view.replace(first);
    await waitFor(() => expect(view.current().eventsState).toBe("ready"));
    expect(view.current().feed).not.toBe(oldFeed);
    expect(
      view
        .current()
        .feed.getSnapshot()
        .events.map((event) => event.seq),
    ).toEqual([2]);
    expect(view.current().settings.theme).toBe("dark");
  });

  it("rejects discarded StrictMode subscription callbacks before registration resolves", async () => {
    const first = await isolatedClient(100);
    const registration = deferred<() => Promise<void>>();
    first.subscribe.mockImplementation((listener) => {
      first.callbacks.push(listener);
      return registration.promise;
    });
    const view = exposeRuntime(first);
    expect(first.callbacks).toHaveLength(2);
    act(() => first.callbacks[0]?.(first.event(900)));
    expect(view.current().feed.getSnapshot().events).toEqual([]);
    act(() => first.callbacks[1]?.(first.event(901)));
    expect(
      view
        .current()
        .feed.getSnapshot()
        .events.map((event) => event.seq),
    ).toEqual([901]);
    const oldFeed = view.current().feed;
    const snapshot = oldFeed.getSnapshot();
    view.replace(await isolatedClient(1));
    act(() => first.callbacks[1]?.(first.event(902)));
    expect(oldFeed.getSnapshot()).toBe(snapshot);
    const unsubscribe = vi.fn(async () => {});
    await act(async () => registration.resolve(unsubscribe));
    expect(unsubscribe).toHaveBeenCalledTimes(2);
  });

  it.each(["replace", "retry", "unmount"] as const)("ignores live callbacks after %s", async (transition) => {
    const first = await isolatedClient(100);
    const view = exposeRuntime(first);
    await waitFor(() => expect(view.current().eventsState).toBe("ready"));
    const oldFeed = view.current().feed;
    const listener = first.callbacks.at(-1);
    if (transition === "replace") view.replace(await isolatedClient(1));
    else if (transition === "retry") act(() => view.current().retryEvents());
    else view.removeRuntime();
    if (transition !== "unmount") await waitFor(() => expect(view.current().eventsState).toBe("ready"));
    const snapshot = oldFeed.getSnapshot();
    act(() => listener?.(first.event(900)));
    expect(oldFeed.getSnapshot()).toBe(snapshot);
  });

  it.each(["replace", "retry", "unmount"] as const)("discards pending older pages after %s", async (transition) => {
    const first = await isolatedClient(100);
    const view = exposeRuntime(first);
    await waitFor(() => expect(view.current().eventsState).toBe("ready"));
    const oldFeed = view.current().feed;
    const read = deferred<EventEnvelope[]>();
    first.recent.mockReturnValueOnce(read.promise);
    let pending!: Promise<void>;
    act(() => {
      pending = view.current().loadOlderEvents();
    });
    if (transition === "replace") view.replace(await isolatedClient(1000));
    else if (transition === "retry") act(() => view.current().retryEvents());
    else view.removeRuntime();
    if (transition !== "unmount") await waitFor(() => expect(view.current().eventsState).toBe("ready"));
    const snapshot = oldFeed.getSnapshot();
    await act(async () => {
      read.resolve([first.event(1)]);
      await pending;
    });
    expect(oldFeed.getSnapshot()).toBe(snapshot);
  });

  it.each(["replace", "retry", "unmount"] as const)(
    "suppresses obsolete history errors and callbacks after %s",
    async (transition) => {
      const first = await isolatedClient(100);
      const view = exposeRuntime(first);
      await waitFor(() => expect(view.current().eventsState).toBe("ready"));
      const loadOlder = view.current().loadOlderEvents;
      const read = deferred<EventEnvelope[]>();
      first.recent.mockReturnValueOnce(read.promise);
      let pending!: Promise<void>;
      act(() => {
        pending = loadOlder();
      });
      if (transition === "replace") view.replace(await isolatedClient(1000));
      else if (transition === "retry") act(() => view.current().retryEvents());
      else view.removeRuntime();
      if (transition !== "unmount") await waitFor(() => expect(view.current().eventsState).toBe("ready"));
      await act(async () => {
        read.reject(SAVE_ERROR);
        await pending;
      });
      expect(screen.queryByText("Couldn't load older activity")).toBeNull();
      const calls = first.recent.mock.calls.length;
      await act(() => loadOlder());
      expect(first.recent).toHaveBeenCalledTimes(calls);
    },
  );
});

describe("RuntimeProvider retained actions", () => {
  it("does not dispatch a retained settings updater after runtime unmount", async () => {
    const first = await isolatedClient(100);
    const save = vi.spyOn(first.client, "updateSettings");
    const view = exposeRuntime(first);
    await waitFor(() => expect(view.current().eventsState).toBe("ready"));
    const update = view.current().updateSettings;
    view.removeRuntime();
    await act(() => update({ theme: "light" }));
    expect(save).not.toHaveBeenCalled();
  });

  it("does not toast or reconcile a settings failure after runtime unmount", async () => {
    const first = await isolatedClient(100);
    const write = deferred<Settings>();
    vi.spyOn(first.client, "updateSettings").mockReturnValueOnce(write.promise);
    const read = vi.spyOn(first.client, "getSettings");
    const view = exposeRuntime(first);
    await waitFor(() => expect(view.current().eventsState).toBe("ready"));
    let pending!: Promise<boolean>;
    act(() => {
      pending = view.current().updateSettings({ theme: "light" });
    });
    view.removeRuntime();
    await act(async () => {
      write.reject(SAVE_ERROR);
      await pending;
    });
    expect(screen.queryByText("Settings not saved")).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it("keeps StrictMode's discarded settings session separate from the live session", async () => {
    const first = await isolatedClient(100);
    const oldWrite = deferred<Settings>();
    vi.spyOn(first.client, "updateSettings").mockReturnValueOnce(oldWrite.promise);
    const read = vi.spyOn(first.client, "getSettings");
    let runtime!: ReturnType<typeof useRuntime>;
    let pending: Promise<boolean> | undefined;
    first.subscribe.mockImplementation(async (listener) => {
      first.callbacks.push(listener);
      // Registration follows the settings effect, before StrictMode cleanup.
      if (first.callbacks.length === 1) pending = runtime.updateSettings({ theme: "light" });
      return async () => {};
    });
    const view = exposeRuntime(first, (value) => {
      runtime = value;
    });
    await waitFor(() => expect(view.current().eventsState).toBe("ready"));
    await act(() => view.current().updateSettings({ density: "compact" }));
    expect(view.current().settings).toMatchObject({ theme: "dark", density: "compact" });
    await act(async () => {
      oldWrite.reject(SAVE_ERROR);
      await pending;
    });
    expect(screen.queryByText("Settings not saved")).toBeNull();
    expect(read).not.toHaveBeenCalled();
    expect(view.current().settings).toMatchObject({ theme: "dark", density: "compact" });
  });

  it.each(["replace", "retry", "unmount"] as const)("ignores a retained retry action after %s", async (transition) => {
    const first = await isolatedClient(100);
    const replacement = await isolatedClient(1000);
    const view = exposeRuntime(first);
    await waitFor(() => expect(view.current().eventsState).toBe("ready"));
    const retry = view.current().retryEvents;
    if (transition === "replace") view.replace(replacement);
    else if (transition === "retry") act(() => retry());
    else view.removeRuntime();
    if (transition !== "unmount") await waitFor(() => expect(view.current().eventsState).toBe("ready"));
    const firstCalls = first.recent.mock.calls.length;
    const replacementCalls = replacement.recent.mock.calls.length;
    await act(async () => retry());
    expect(first.recent).toHaveBeenCalledTimes(firstCalls);
    expect(replacement.recent).toHaveBeenCalledTimes(replacementCalls);
  });
});

describe("RuntimeProvider", () => {
  it.each([
    { name: "short page after live eviction", initial: 2, live: 501, evicted: true },
    { name: "empty page after live eviction", initial: 0, live: 501, evicted: true },
    { name: "short page causing eviction when merged", initial: 2, live: 499, evicted: true },
    { name: "short page with retained live events", initial: 2, live: 20, evicted: false },
    { name: "empty page with retained live events", initial: 0, live: 20, evicted: false },
    { name: "short page without live events", initial: 2, live: 0, evicted: false },
    { name: "empty page without live events", initial: 0, live: 0, evicted: false },
  ])("keeps initial history exhaustion accurate: $name", async ({ initial, live, evicted }) => {
    const client = new KalCodeClient(createMemoryTransport("default"));
    const boot = await client.boot();
    const seed = (await client.recentEvents(1))[0];
    if (!seed) throw new Error("Expected a fixture event");
    const event = (seq: number): EventEnvelope => ({ ...seed, id: `event-${seq}`, seq });
    const history = Array.from({ length: initial }, (_, index) => event(100 + index));
    const initialPage = [...history].reverse();
    const read = deferred<EventEnvelope[]>();
    const subscribers = new Set<(event: EventEnvelope) => void>();
    vi.spyOn(client, "subscribeEvents").mockImplementation(async (listener) => {
      subscribers.add(listener);
      return async () => {
        subscribers.delete(listener);
      };
    });
    const recent = vi
      .spyOn(client, "recentEvents")
      .mockImplementation(async (limit, before) =>
        [...history]
          .reverse()
          .filter((event) => before === undefined || event.seq < before)
          .slice(0, limit),
      )
      .mockImplementationOnce(() => read.promise);
    const { result } = renderHook(useRuntime, {
      wrapper: ({ children }: { children: ReactNode }) => (
        <StrictMode>
          <ToastProvider>
            <RuntimeProvider client={client} info={boot.info} initialSettings={INITIAL}>
              {children}
            </RuntimeProvider>
          </ToastProvider>
        </StrictMode>
      ),
    });
    await waitFor(() => expect(recent).toHaveBeenCalledOnce());
    act(() => {
      for (let index = 0; index < live; index++) {
        const incoming = event(200 + index);
        history.push(incoming);
        for (const listener of subscribers) listener(incoming);
      }
    });
    await act(async () => read.resolve(initialPage));
    expect(result.current.eventsState).toBe("ready");
    expect(result.current.feed.reachedStart).toBe(!evicted);
    if (evicted) {
      expect(result.current.feed.getSnapshot().events).toHaveLength(500);
      await act(() => result.current.loadOlderEvents());
      expect(result.current.feed.reachedStart).toBe(true);
    }
    expect(result.current.feed.getSnapshot().events.map((event) => event.seq)).toEqual(
      [...history].reverse().map((event) => event.seq),
    );
  });

  it("holds exactly one live event subscription under StrictMode", async () => {
    const transport = createMemoryTransport("default");
    await mount(transport);
    // Allow any late subscribe from the discarded StrictMode pass to resolve and release.
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(transport.subscriberCount()).toBe(1);
  });

  it.each([
    { name: "full", initial: 1000 },
    { name: "short", initial: 550 },
    { name: "empty", initial: 500 },
  ])("discards a stale $name older page and backfills again from the current cursor", async ({ initial }) => {
    const client = new KalCodeClient(createMemoryTransport("default"));
    const boot = await client.boot();
    const seed = (await client.recentEvents(1))[0];
    if (!seed) throw new Error("Expected a fixture event");
    const event = (seq: number): EventEnvelope => ({ ...seed, id: `event-${seq}`, seq });
    const history = Array.from({ length: initial }, (_, index) => event(index + 1));
    const subscribers = new Set<(event: EventEnvelope) => void>();
    vi.spyOn(client, "subscribeEvents").mockImplementation(async (listener) => {
      subscribers.add(listener);
      return async () => {
        subscribers.delete(listener);
      };
    });
    const page = (limit: number, before?: number) =>
      [...history]
        .reverse()
        .filter((event) => before === undefined || event.seq < before)
        .slice(0, limit);
    const recent = vi.spyOn(client, "recentEvents").mockImplementation(async (limit, before) => page(limit, before));
    const { result } = renderHook(useRuntime, {
      wrapper: ({ children }: { children: ReactNode }) => (
        <StrictMode>
          <ToastProvider>
            <RuntimeProvider client={client} info={boot.info} initialSettings={INITIAL}>
              {children}
            </RuntimeProvider>
          </ToastProvider>
        </StrictMode>
      ),
    });
    await waitFor(() => expect(result.current.eventsState).toBe("ready"));
    for (let n = 0; n < 4; n++) await act(() => result.current.loadOlderEvents());
    expect(result.current.feed.getSnapshot().events).toHaveLength(500);
    const stalePage = page(100, result.current.feed.oldestSeq);
    const read = deferred<EventEnvelope[]>();
    recent.mockImplementationOnce(() => read.promise);
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.loadOlderEvents();
    });
    act(() => {
      for (let index = 1; index <= 501; index++) {
        const incoming = event(initial + index);
        history.push(incoming);
        for (const listener of subscribers) listener(incoming);
      }
    });
    const currentCursor = result.current.feed.oldestSeq;
    const currentSnapshot = result.current.feed.getSnapshot();
    await act(async () => {
      read.resolve(stalePage);
      await pending;
    });
    expect(result.current.feed.getSnapshot()).toBe(currentSnapshot);
    expect(result.current.feed.oldestSeq).toBe(currentCursor);
    expect(result.current.feed.reachedStart).toBe(false);

    // A later user action starts at the retained cursor and can recover the entire gap.
    for (let n = 0; n < 20 && !result.current.feed.reachedStart; n++) {
      await act(() => result.current.loadOlderEvents());
    }
    expect(result.current.feed.reachedStart).toBe(true);
    expect(result.current.feed.getSnapshot().events.map((event) => event.seq)).toEqual(
      [...history].reverse().map((event) => event.seq),
    );
  });

  it("converges on saved settings when responses arrive out of order", async () => {
    const transport = createMemoryTransport("default");
    // Delay the first settings_update response so the second one resolves first.
    let calls = 0;
    const invoke = transport.invoke.bind(transport);
    transport.invoke = (async <T,>(command: CommandName, args?: Record<string, unknown>) => {
      if (command === "settings_update" && calls++ === 0) {
        const result = await invoke<T>(command, args);
        await new Promise((r) => setTimeout(r, 30));
        return result;
      }
      return invoke<T>(command, args);
    }) as MemoryTransport["invoke"];
    await mount(transport);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "light" }));
    await user.click(screen.getByRole("button", { name: "compact" }));

    await waitFor(() => {
      expect(screen.getByTestId("theme").textContent).toBe("light");
      expect(screen.getByTestId("density").textContent).toBe("compact");
    });
    const saved = await new KalCodeClient(transport).getSettings();
    expect(saved).toMatchObject({ theme: "light", density: "compact" });
  });

  it("re-reads saved settings after a failed update instead of guessing", async () => {
    const transport = createMemoryTransport("default");
    const invoke = transport.invoke.bind(transport);
    transport.invoke = (async <T,>(command: CommandName, args?: Record<string, unknown>) => {
      if (command === "settings_update" && (args?.patch as { theme?: string })?.theme === "light") {
        throw { category: "database", code: "database_error", message: "Disk full.", retryable: false };
      }
      return invoke<T>(command, args);
    }) as MemoryTransport["invoke"];
    await mount(transport);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "light" }));
    await waitFor(() => expect(screen.getByTestId("theme").textContent).toBe("dark"));
    expect(await screen.findByText("Settings not saved")).toBeInTheDocument();
  });

  it("ignores an old reconciliation that finishes after a newer successful save", async () => {
    const { client } = await mount(createMemoryTransport("default"));
    const oldRead = deferred<Settings>();
    vi.spyOn(client, "updateSettings").mockRejectedValueOnce(SAVE_ERROR);
    vi.spyOn(client, "getSettings").mockImplementationOnce(() => oldRead.promise);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "compact" }));
    expect(await screen.findByText("Settings not saved")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "light" }));
    await waitFor(() => expect(screen.getByTestId("density")).toHaveTextContent("comfortable"));
    expect(await client.getSettings()).toMatchObject({ theme: "light", density: "comfortable" });
    await act(async () => oldRead.resolve(INITIAL));
    expect(screen.getByTestId("theme")).toHaveTextContent("light");
    expect(screen.getByTestId("density")).toHaveTextContent("comfortable");
  });

  it("still reconciles a new failed write while an older reconciliation is pending", async () => {
    const { client } = await mount(createMemoryTransport("default"));
    const oldRead = deferred<Settings>();
    const write = vi.spyOn(client, "updateSettings").mockRejectedValueOnce(SAVE_ERROR);
    vi.spyOn(client, "getSettings").mockImplementationOnce(() => oldRead.promise);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "compact" }));
    await user.click(screen.getByRole("button", { name: "light" }));
    await waitFor(() => expect(screen.getByTestId("density")).toHaveTextContent("comfortable"));
    write.mockRejectedValueOnce(SAVE_ERROR);
    await user.click(screen.getByRole("button", { name: "compact" }));
    await waitFor(() => expect(screen.getByTestId("density")).toHaveTextContent("comfortable"));
    expect(screen.getByTestId("theme")).toHaveTextContent("light");
    await act(async () => oldRead.resolve(INITIAL));
    expect(screen.getByTestId("theme")).toHaveTextContent("light");
  });

  it("reconciles the current client independently of a previous client's unfinished write", async () => {
    const { client, rerender } = await mount(createMemoryTransport("default"));
    const oldWrite = deferred<Settings>();
    vi.spyOn(client, "updateSettings").mockImplementationOnce(() => oldWrite.promise);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "light" }));
    const replacement = new KalCodeClient(createMemoryTransport("default"));
    const boot = await replacement.boot();
    vi.spyOn(replacement, "updateSettings").mockRejectedValueOnce(SAVE_ERROR);
    rerender(
      <StrictMode>
        <ToastProvider>
          <RuntimeProvider client={replacement} info={boot.info} initialSettings={INITIAL}>
            <Probe />
          </RuntimeProvider>
        </ToastProvider>
      </StrictMode>,
    );
    await user.click(screen.getByRole("button", { name: "compact" }));
    await waitFor(() => expect(screen.getByTestId("density")).toHaveTextContent("comfortable"));
    expect(screen.getByTestId("theme")).toHaveTextContent("dark");
    await act(async () => oldWrite.resolve({ ...INITIAL, theme: "light" }));
    expect(screen.getByTestId("theme")).toHaveTextContent("dark");
  });
});

describe("SegmentedControl", () => {
  it("reports an arrow-key selection exactly once", async () => {
    const onChange = vi.fn();
    function Harness() {
      const [value, setValue] = useState<"a" | "b" | "c">("a");
      return (
        <SegmentedControl
          aria-label="Choice"
          value={value}
          onValueChange={(next) => {
            onChange(next);
            setValue(next);
          }}
          options={[
            { value: "a", label: "A" },
            { value: "b", label: "B" },
            { value: "c", label: "C" },
          ]}
        />
      );
    }
    render(<Harness />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: "A" }));
    onChange.mockClear();
    await user.keyboard("{ArrowRight}");
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("b");
    expect(screen.getByRole("radio", { name: "B" })).toHaveAttribute("aria-checked", "true");
  });
});
