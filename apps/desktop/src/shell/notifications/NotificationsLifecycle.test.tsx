import type { Notification, NotificationPage } from "@kalcode/protocol";
import { act, renderHook, waitFor } from "@testing-library/react";
import { Activity, type ReactNode, StrictMode, useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationsProvider, useNotifications } from "./NotificationsProvider.tsx";

const runtime = vi.hoisted(() => ({
  client: {} as ReturnType<typeof makeClient>,
  events: [] as { type: string; seq: number }[],
}));
const toast = vi.hoisted(() => ({ show: vi.fn() }));
const intents = vi.hoisted(() => ({ focus: vi.fn(async () => {}) }));
vi.mock("../../runtime/RuntimeProvider.tsx", () => ({ useRuntime: () => runtime, useEvents: () => runtime }));
vi.mock("../../runtime/uiIntents.tsx", () => ({ useUiIntents: () => intents }));
vi.mock("@kalcode/ui/components", () => ({ useToast: () => toast }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function notice(id = "current"): Notification {
  return {
    id,
    kind: "thread_completed",
    severity: "info",
    title: id,
    body: "Review result",
    entityKind: "thread",
    entityId: `thread-${id}`,
    workspaceId: `workspace-${id}`,
    createdAt: "2026-09-25T00:00:00Z",
    updatedAt: "2026-09-25T00:00:00Z",
    readAt: null,
    count: 1,
  };
}
function page(id: string, count = 1, nextCursor: string | null = null): NotificationPage {
  return {
    notifications: Array.from({ length: count }, (_, index) => notice(`${id}-${index}`)),
    unreadCount: count,
    nextCursor,
  };
}
function makeClient(id = "current") {
  return {
    listNotifications: vi.fn(async (_args: { limit: number; before?: string | null }) => page(id)),
    markNotifications: vi.fn(async (_ids: readonly string[] | null, _mark: string) => {}),
  };
}
function wrapper({ children }: { children: ReactNode }) {
  return (
    <StrictMode>
      <NotificationsProvider>{children}</NotificationsProvider>
    </StrictMode>
  );
}

function mountActivity() {
  let visible = true;
  const commits: ReturnType<typeof useNotifications>[] = [];
  const view = renderHook(
    () => {
      const value = useNotifications();
      useLayoutEffect(() => {
        commits.push(value);
      });
      return value;
    },
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <StrictMode>
          <Activity mode={visible ? "visible" : "hidden"}>
            <NotificationsProvider>{children}</NotificationsProvider>
          </Activity>
        </StrictMode>
      ),
    },
  );
  return {
    ...view,
    commits,
    hide() {
      visible = false;
      view.rerender();
    },
    show() {
      visible = true;
      commits.length = 0;
      view.rerender();
    },
  };
}
beforeEach(() => {
  runtime.client = makeClient();
  runtime.events = [];
  toast.show.mockReset();
  intents.focus.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("notification runtime lifetime", () => {
  it("masks the prior panel, list and live announcement in the first Activity reconnect commit", async () => {
    const view = mountActivity();
    await waitFor(() => expect(view.result.current.state).toBe("ready"));
    runtime.client.listNotifications.mockResolvedValue(page("live", 50, "cursor"));
    await act(() => view.result.current.refresh());
    act(() => view.result.current.setPanelOpen(true));
    expect(view.result.current.latest?.id).toBe("live-0");
    view.hide();
    const next = deferred<NotificationPage>();
    runtime.client.listNotifications.mockReturnValue(next.promise);
    view.show();
    expect(view.commits[0]).toMatchObject({
      state: "loading",
      error: null,
      notifications: [],
      unreadCount: 0,
      hasMore: false,
      panelOpen: false,
      latest: null,
    });
    await act(async () => {
      next.resolve(page("history"));
    });
    expect(view.result.current.notifications[0]?.id).toBe("history-0");
    expect(view.result.current.latest).toBeNull();
    runtime.client.listNotifications.mockResolvedValue(page("fresh"));
    await act(() => view.result.current.refresh());
    expect(view.result.current.latest?.id).toBe("fresh-0");
    act(() => view.result.current.setPanelOpen(true));
    expect(view.result.current.panelOpen).toBe(true);
  });

  it("does not expose a retired read error in the first Activity reconnect commit", async () => {
    runtime.client.listNotifications.mockRejectedValue(new Error("Retired read"));
    const view = mountActivity();
    await waitFor(() => expect(view.result.current.state).toBe("error"));
    view.hide();
    runtime.client.listNotifications.mockReturnValue(new Promise(() => {}));
    view.show();
    expect(view.commits[0]).toMatchObject({ state: "loading", error: null });
  });

  it("retires old callback handles across Activity reconnection while current actions still work", async () => {
    const view = mountActivity();
    await waitFor(() => expect(view.result.current.state).toBe("ready"));
    const retained = view.result.current;
    view.hide();
    view.show();
    await waitFor(() => expect(view.result.current.state).toBe("ready"));
    runtime.client.listNotifications.mockClear();
    await act(async () => {
      await retained.refresh();
      await retained.loadMore();
      await retained.mark(null, "dismissed");
      await retained.open(notice("retired"));
      retained.setPanelOpen(true);
      retained.panelReturnFocus();
    });
    expect(runtime.client.listNotifications).not.toHaveBeenCalled();
    expect(runtime.client.markNotifications).not.toHaveBeenCalled();
    expect(intents.focus).not.toHaveBeenCalled();
    expect(view.result.current.panelOpen).toBe(false);
    await act(() => view.result.current.open(notice("current")));
    expect(runtime.client.markNotifications).toHaveBeenCalledWith(["current"], "read");
    expect(intents.focus).toHaveBeenCalledWith({
      kind: "thread",
      threadId: "thread-current",
      workspaceId: "workspace-current",
    });
  });

  it("loads a replacement runtime after the previous one lacked notification commands", async () => {
    runtime.client.listNotifications.mockRejectedValue({
      category: "internal",
      code: "command_unavailable",
      message: "Unavailable",
      retryable: false,
    });
    const { result, rerender } = renderHook(useNotifications, { wrapper });
    await waitFor(() => expect(result.current.state).toBe("unavailable"));
    runtime.client = makeClient("next");
    rerender();
    await waitFor(() => expect(result.current.notifications[0]?.id).toBe("next-0"));
    expect(result.current.state).toBe("ready");
  });

  it("hides notifications, unread count and panel while a replacement runtime loads", async () => {
    const { result, rerender } = renderHook(useNotifications, { wrapper });
    await waitFor(() => expect(result.current.state).toBe("ready"));
    act(() => result.current.setPanelOpen(true));
    runtime.client = makeClient();
    runtime.client.listNotifications.mockReturnValue(new Promise(() => {}));
    rerender();
    expect(result.current.notifications).toEqual([]);
    expect(result.current.state).toBe("loading");
    expect(result.current.unreadCount).toBe(0);
    expect(result.current.panelOpen).toBe(false);
    expect(result.current.latest).toBeNull();
  });

  it.each([false, true])(
    "ignores old mark completion (rejects=%s) without starting another old-client read",
    async (rejects) => {
      const old = runtime.client;
      const mutation = deferred<void>();
      old.markNotifications.mockReturnValue(mutation.promise);
      const { result, rerender } = renderHook(useNotifications, { wrapper });
      await waitFor(() => expect(result.current.state).toBe("ready"));
      let marking!: Promise<void>;
      act(() => {
        marking = result.current.mark(null, "read");
      });
      runtime.client = makeClient("next");
      rerender();
      await waitFor(() => expect(result.current.notifications[0]?.id).toBe("next-0"));
      const reads = old.listNotifications.mock.calls.length;
      await act(async () => {
        if (rejects) mutation.reject(new Error("obsolete failure"));
        else mutation.resolve();
        await marking;
      });
      expect(old.listNotifications).toHaveBeenCalledTimes(reads);
      expect(result.current.notifications[0]?.id).toBe("next-0");
      expect(toast.show).not.toHaveBeenCalled();
    },
  );

  it("blocks native and navigation callbacks retained from the previous runtime", async () => {
    const old = runtime.client;
    const { result, rerender } = renderHook(useNotifications, { wrapper });
    await waitFor(() => expect(result.current.state).toBe("ready"));
    const retained = result.current;
    runtime.client = makeClient("next");
    rerender();
    await waitFor(() => expect(result.current.notifications[0]?.id).toBe("next-0"));
    const reads = old.listNotifications.mock.calls.length;
    await act(async () => {
      await retained.refresh();
      await retained.loadMore();
      await retained.mark(null, "dismissed");
      await retained.open(notice("old"));
      retained.setPanelOpen(true);
      retained.panelReturnFocus();
    });
    expect(old.listNotifications).toHaveBeenCalledTimes(reads);
    expect(old.markNotifications).not.toHaveBeenCalled();
    expect(intents.focus).not.toHaveBeenCalled();
    expect(result.current.panelOpen).toBe(false);
  });

  it("allows pagination in the new runtime while an old runtime page is still pending", async () => {
    const oldPage = deferred<NotificationPage>();
    runtime.client.listNotifications.mockImplementation(({ before }) =>
      before ? oldPage.promise : Promise.resolve(page("old", 50, "old-cursor")),
    );
    const { result, rerender } = renderHook(useNotifications, { wrapper });
    await waitFor(() => expect(result.current.hasMore).toBe(true));
    let reading!: Promise<void>;
    act(() => {
      reading = result.current.loadMore();
    });
    runtime.client = makeClient();
    runtime.client.listNotifications.mockImplementation(async ({ before }) =>
      before ? page("new-older") : page("new", 50, "new-cursor"),
    );
    rerender();
    await waitFor(() => expect(result.current.notifications[0]?.id).toBe("new-0"));
    await act(() => result.current.loadMore());
    expect(result.current.notifications.at(-1)?.id).toBe("new-older-0");
    await act(async () => {
      oldPage.resolve(page("old-older"));
      await reading;
    });
    expect(result.current.notifications.at(-1)?.id).toBe("new-older-0");
  });

  it("treats a new runtime's initial list as history, not a new live announcement", async () => {
    const { result, rerender } = renderHook(useNotifications, { wrapper });
    await waitFor(() => expect(result.current.state).toBe("ready"));
    runtime.client = makeClient("next");
    rerender();
    await waitFor(() => expect(result.current.notifications[0]?.id).toBe("next-0"));
    expect(result.current.latest).toBeNull();
  });

  it("accepts restarted event sequence numbers and cancels an old runtime's debounce", async () => {
    const old = runtime.client;
    runtime.events = [{ type: "notification.created", seq: 100 }];
    const { result, rerender } = renderHook(useNotifications, { wrapper });
    await waitFor(() => expect(result.current.state).toBe("ready"));
    vi.useFakeTimers();
    runtime.events = [{ type: "notification.created", seq: 101 }];
    rerender();
    runtime.client = makeClient("next");
    runtime.events = [];
    rerender();
    await act(async () => {});
    const oldReads = old.listNotifications.mock.calls.length;
    runtime.client.listNotifications.mockResolvedValue(page("event"));
    runtime.events = [{ type: "notification.created", seq: 1 }];
    rerender();
    await act(() => vi.advanceTimersByTimeAsync(301));
    expect(old.listNotifications).toHaveBeenCalledTimes(oldReads);
    expect(result.current.notifications[0]?.id).toBe("event-0");
    expect(result.current.latest?.id).toBe("event-0");
  });

  it("ignores failed mark completion after unmount", async () => {
    const mutation = deferred<void>();
    runtime.client.markNotifications.mockReturnValue(mutation.promise);
    const { result, unmount } = renderHook(useNotifications, { wrapper });
    await waitFor(() => expect(result.current.state).toBe("ready"));
    let marking!: Promise<void>;
    act(() => {
      marking = result.current.mark(null, "read");
    });
    const reads = runtime.client.listNotifications.mock.calls.length;
    unmount();
    mutation.reject(new Error("disposed runtime"));
    await marking;
    expect(runtime.client.listNotifications).toHaveBeenCalledTimes(reads);
    expect(toast.show).not.toHaveBeenCalled();
  });

  it("does not let discarded pagination completion unlock a newer page request", async () => {
    const old = deferred<NotificationPage>();
    const current = deferred<NotificationPage>();
    runtime.client.listNotifications.mockResolvedValue(page("root", 50, "cursor"));
    const { result } = renderHook(useNotifications, { wrapper });
    await waitFor(() => expect(result.current.hasMore).toBe(true));
    runtime.client.listNotifications.mockReturnValueOnce(old.promise);
    let discarded!: Promise<void>;
    act(() => {
      discarded = result.current.loadMore();
    });
    await act(() => result.current.refresh());
    runtime.client.listNotifications.mockReturnValueOnce(current.promise);
    let loading!: Promise<void>;
    act(() => {
      loading = result.current.loadMore();
    });
    await act(async () => {
      old.resolve(page("discarded"));
      await discarded;
    });
    const reads = runtime.client.listNotifications.mock.calls.length;
    await act(() => result.current.loadMore());
    expect(runtime.client.listNotifications).toHaveBeenCalledTimes(reads);
    await act(async () => {
      current.resolve(page("current-older"));
      await loading;
    });
    expect(result.current.notifications.at(-1)?.id).toBe("current-older-0");
  });

  it("reports current mark failures and reconciles actual unread state", async () => {
    const { result } = renderHook(useNotifications, { wrapper });
    await waitFor(() => expect(result.current.state).toBe("ready"));
    runtime.client.markNotifications.mockRejectedValueOnce({
      category: "database",
      code: "write_failed",
      message: "Could not save",
      retryable: true,
    });
    await act(() => result.current.mark(null, "read"));
    expect(toast.show).toHaveBeenCalledWith(expect.objectContaining({ title: "Couldn't update notifications" }));
    expect(result.current.notifications[0]?.readAt).toBeNull();
    expect(result.current.unreadCount).toBe(1);
  });

  it("opens current notifications at their exact workspace and thread", async () => {
    const { result } = renderHook(useNotifications, { wrapper });
    await waitFor(() => expect(result.current.state).toBe("ready"));
    act(() => result.current.setPanelOpen(true));
    const row = notice("exact");
    await act(() => result.current.open(row));
    expect(runtime.client.markNotifications).toHaveBeenCalledWith(["exact"], "read");
    expect(intents.focus).toHaveBeenCalledWith({
      kind: "thread",
      threadId: "thread-exact",
      workspaceId: "workspace-exact",
    });
    expect(result.current.panelOpen).toBe(false);
  });

  it("rejects the discarded StrictMode setup's initial page", async () => {
    const old = deferred<NotificationPage>();
    runtime.client.listNotifications.mockReturnValueOnce(old.promise);
    const { result } = renderHook(useNotifications, { wrapper, reactStrictMode: true });
    await waitFor(() => expect(result.current.state).toBe("ready"));
    await act(async () => {
      old.resolve(page("discarded"));
    });
    expect(result.current.notifications[0]?.id).toBe("current-0");
    expect(result.current.latest).toBeNull();
  });
});
