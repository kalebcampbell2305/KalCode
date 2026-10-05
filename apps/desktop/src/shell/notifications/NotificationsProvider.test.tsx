import type { Notification, NotificationPage } from "@kalcode/protocol";
import { ToastProvider } from "@kalcode/ui/components";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationCenter } from "./NotificationCenter.tsx";
import { NotificationsProvider, useNotifications } from "./NotificationsProvider.tsx";

const runtime = vi.hoisted(() => ({
  client: {
    listNotifications: vi.fn(),
    markNotifications: vi.fn(),
    // The Needs you sheet reads the coding agents (none here) beside the history.
    listThreads: vi.fn(async () => []),
    runningTerminals: vi.fn(async () => []),
  },
  events: [],
}));
vi.mock("../../runtime/RuntimeProvider.tsx", () => ({
  useRuntime: () => runtime,
  useEvents: () => runtime,
}));
vi.mock("../../runtime/uiIntents.tsx", () => ({ useUiIntents: () => ({ focus: vi.fn() }) }));
// The Needs you items run canonical app actions (navigation, Code); this test covers only the history.
vi.mock("../../runtime/actions.ts", () => ({ useKalActions: () => ({ runAttention: vi.fn() }) }));

function wrapper({ children }: { children: ReactNode }) {
  return (
    <ToastProvider>
      <NotificationsProvider>{children}</NotificationsProvider>
    </ToastProvider>
  );
}

function fixture(count: number): Notification[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `notice-${index}`,
    kind: "thread_completed",
    severity: "info",
    title: `Completed thread ${index}`,
    body: "Open to review the result.",
    entityKind: "thread",
    entityId: `thread-${index}`,
    workspaceId: null,
    createdAt: new Date(Date.UTC(2026, 8, 25) - index * 1000).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 8, 25) - index * 1000).toISOString(),
    readAt: null,
    count: 1,
  }));
}

function serve(rows: Notification[]) {
  const list = ({ limit, before }: { limit: number; before?: string | null }): NotificationPage => {
    const start = before ? rows.findIndex((n) => n.id === before) + 1 : 0;
    const notifications = rows.slice(start, start + limit);
    return {
      notifications,
      unreadCount: rows.filter((n) => n.readAt === null).length,
      nextCursor: start + limit < rows.length ? (notifications.at(-1)?.id ?? null) : null,
    };
  };
  runtime.client.listNotifications.mockImplementation(async (args) => list(args));
  return list;
}

beforeEach(() => vi.resetAllMocks());

describe("notification pagination", () => {
  it("lets the unread view reach an unread notice beyond a fully read first page", async () => {
    const rows = fixture(51);
    for (const row of rows.slice(0, 50)) row.readAt = row.createdAt;
    serve(rows);
    function OpenCenter() {
      const center = useNotifications();
      return (
        <button type="button" onClick={() => center.setPanelOpen(true)}>
          Open notifications
        </button>
      );
    }
    render(
      <>
        <OpenCenter />
        <NotificationCenter />
      </>,
      { wrapper },
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Open notifications" }));
    await user.click(await screen.findByRole("radio", { name: "Unread (1)" }));
    expect(screen.queryByRole("heading", { name: "Nothing unread" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show older notifications" }));
    expect(await screen.findByRole("article", { name: /Completed thread 50/ })).toBeInTheDocument();
  });

  it("preserves loaded history beyond the native page limit when refreshed and continues from it", async () => {
    serve(fixture(300));
    const { result } = renderHook(useNotifications, { wrapper });
    await waitFor(() => expect(result.current.notifications).toHaveLength(50));
    for (let page = 0; page < 4; page++) await act(() => result.current.loadMore());
    expect(result.current.notifications).toHaveLength(250);
    await act(() => result.current.refresh());
    expect(result.current.notifications).toHaveLength(250);
    expect(result.current.notifications.at(-1)?.id).toBe("notice-249");
    await act(() => result.current.loadMore());
    expect(result.current.notifications).toHaveLength(300);
    expect(result.current.hasMore).toBe(false);
  });

  it("does not append an old page after a refresh dismisses its notifications", async () => {
    const rows = fixture(100);
    const list = serve(rows);
    const { result } = renderHook(useNotifications, { wrapper });
    await waitFor(() => expect(result.current.notifications).toHaveLength(50));
    const stale = list({ limit: 50, before: "notice-49" });
    let resolve!: (page: NotificationPage) => void;
    runtime.client.listNotifications.mockImplementationOnce(
      () =>
        new Promise<NotificationPage>((done) => {
          resolve = done;
        }),
    );
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.loadMore();
    });
    rows.splice(50);
    await act(() => result.current.refresh());
    await act(async () => {
      resolve(stale);
      await pending;
    });
    expect(result.current.notifications).toHaveLength(50);
    expect(result.current.hasMore).toBe(false);
  });

  it("counts a concurrently requested older page only once when retaining loaded depth", async () => {
    serve(fixture(200));
    const { result } = renderHook(useNotifications, { wrapper });
    await waitFor(() => expect(result.current.notifications).toHaveLength(50));
    await act(async () => {
      await Promise.all([result.current.loadMore(), result.current.loadMore()]);
    });
    expect(result.current.notifications).toHaveLength(100);
    await act(() => result.current.refresh());
    expect(result.current.notifications).toHaveLength(100);
  });
});
