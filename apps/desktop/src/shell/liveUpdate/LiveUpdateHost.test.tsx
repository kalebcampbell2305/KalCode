import { ToastProvider } from "@kalcode/ui/components";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publishUpdated, resetAnnouncements } from "./announce.ts";
import { LiveUpdateHost, QUIET_MS } from "./LiveUpdateHost.tsx";
import { HANDOFF_KEY, RELOAD_KEY, saveSnapshot } from "./snapshot.ts";

const handlers: { staged?: (version: string) => void; handoff?: (version: string | null) => void } = {};
const ipc = vi.hoisted(() => ({
  beginLiveReload: vi.fn(async () => undefined),
  reportHandoffReady: vi.fn(async () => undefined),
}));

vi.mock("../../ipc/liveUpdate.ts", () => ({
  beginLiveReload: ipc.beginLiveReload,
  reportHandoffReady: ipc.reportHandoffReady,
  onUiStaged: async (handler: (version: string) => void) => {
    handlers.staged = handler;
    return () => undefined;
  },
  onHandoff: async (handler: (version: string | null) => void) => {
    handlers.handoff = handler;
    return () => undefined;
  },
}));

const navigation = vi.hoisted(() => ({ current: "code", navigate: vi.fn() }));
vi.mock("../navigation.tsx", () => ({ useNavigation: () => navigation }));

function mount(reload = vi.fn()) {
  render(
    <ToastProvider>
      <LiveUpdateHost onOpenDetails={() => undefined} reload={reload} />
    </ToastProvider>,
  );
  return reload;
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  resetAnnouncements();
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  sessionStorage.clear();
  localStorage.clear();
  document.body.innerHTML = "";
});

describe("LiveUpdateHost", () => {
  it("reloads into a staged UI only at a quiet moment, saving drafts first", async () => {
    const reload = mount();
    await act(async () => {});
    const composer = document.createElement("textarea");
    composer.setAttribute("aria-label", "Message the agent");
    composer.value = "half-written prompt";
    document.body.append(composer);

    act(() => handlers.staged?.("0.1.9+1900"));
    // Typing keeps postponing the reload.
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
        await vi.advanceTimersByTimeAsync(QUIET_MS - 1000);
      });
    }
    expect(reload).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(QUIET_MS + 1000);
    });
    expect(ipc.beginLiveReload).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(sessionStorage.getItem(RELOAD_KEY) ?? "null");
    expect(saved.destination).toBe("code");
    expect(saved.drafts).toEqual([{ key: "textarea:Message the agent#0", value: "half-written prompt" }]);
  });

  it("waits while a dialog is open", async () => {
    const reload = mount();
    await act(async () => {});
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.dataset.state = "open";
    document.body.append(dialog);
    act(() => handlers.staged?.("0.1.9+1900"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(QUIET_MS * 3);
    });
    expect(reload).not.toHaveBeenCalled();
    dialog.remove();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("shows the handoff progress, saves state for the new process and acknowledges", async () => {
    mount();
    await act(async () => {});
    act(() => handlers.handoff?.("0.1.9+1901"));
    expect(screen.getByText("Applying KalCode update…")).toBeTruthy();
    expect(screen.getByText(/0\.1\.9 build 1901/)).toBeTruthy();
    expect(ipc.reportHandoffReady).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem(HANDOFF_KEY) ?? "null").destination).toBe("code");
    // Called off (the gate closed): the overlay goes away.
    act(() => handlers.handoff?.(null));
    expect(screen.queryByText("Applying KalCode update…")).toBeNull();
  });

  it("returns to the saved place after a reload and announces the update once", async () => {
    saveSnapshot(RELOAD_KEY, { version: 1, savedAt: Date.now(), destination: "settings", drafts: [] });
    publishUpdated({ version: "0.1.9+1900", class: "ui", at: Date.now() });
    mount();
    await act(async () => {});
    expect(navigation.navigate).toHaveBeenCalledWith("settings");
    expect(screen.getByText("KalCode updated")).toBeTruthy();
    expect(screen.getByText(/Your terminals and agents kept running/)).toBeTruthy();
  });
});
