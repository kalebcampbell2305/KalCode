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
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const SAVE_ERROR = { category: "database", code: "database_error", message: "Disk full.", retryable: false };

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
