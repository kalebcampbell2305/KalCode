import { act, cleanup, fireEvent, renderHook, screen } from "@testing-library/react";
import { type ReactNode, StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider, useToast } from "./Toast.tsx";

function wrapper({ children }: { children: ReactNode }) {
  return (
    <StrictMode>
      <ToastProvider>
        <button type="button">Outside the toast</button>
        {children}
      </ToastProvider>
    </StrictMode>
  );
}

function advance(ms: number) {
  act(() => vi.advanceTimersByTime(ms));
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ToastProvider", () => {
  it("keeps notification list semantics inside its polite live region", () => {
    const { result } = renderHook(useToast, { wrapper });
    act(() => result.current.show({ title: "Saved" }));
    const status = screen.getByRole("status", { name: "Notifications" });
    const list = screen.getByRole("list");
    expect(status).toContainElement(list);
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(list).toContainElement(screen.getByRole("listitem"));
  });

  it("runs its one action and dismisses itself", () => {
    const onSelect = vi.fn();
    const { result } = renderHook(useToast, { wrapper });
    act(() =>
      result.current.show({ title: "Stopped 2 idle terminals.", action: { label: "Review terminals", onSelect } }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Review terminals" }));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(screen.queryByText("Stopped 2 idle terminals.")).not.toBeInTheDocument();
  });

  it("keeps a focused toast alive and resumes only its remaining duration after focus leaves", () => {
    const { result } = renderHook(useToast, { wrapper });
    act(() => result.current.show({ title: "Saved" }));
    advance(1000);
    const dismiss = screen.getByRole("button", { name: "Dismiss notification" });
    act(() => dismiss.focus());
    advance(10_000);
    expect(dismiss).toHaveFocus();
    expect(screen.getByText("Saved")).toBeInTheDocument();

    act(() => screen.getByRole("button", { name: "Outside the toast" }).focus());
    advance(3499);
    expect(screen.getByText("Saved")).toBeInTheDocument();
    advance(1);
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
  });

  it("keeps a toast under the pointer alive, so its action can still be reached", () => {
    const onSelect = vi.fn();
    const { result } = renderHook(useToast, { wrapper });
    act(() =>
      result.current.show({ title: "Stopped 2 idle terminals.", action: { label: "Review terminals", onSelect } }),
    );
    advance(4000);
    const toast = screen.getByText("Stopped 2 idle terminals.").closest("li") as HTMLElement;
    fireEvent.pointerEnter(toast);
    advance(10_000);
    expect(screen.getByText("Stopped 2 idle terminals.")).toBeInTheDocument();

    // Focus moving in and out while the pointer stays does not restart the timer.
    const dismiss = screen.getByRole("button", { name: "Dismiss notification" });
    act(() => dismiss.focus());
    act(() => screen.getByRole("button", { name: "Outside the toast" }).focus());
    advance(10_000);
    expect(screen.getByText("Stopped 2 idle terminals.")).toBeInTheDocument();

    fireEvent.pointerLeave(toast);
    advance(499);
    expect(screen.getByText("Stopped 2 idle terminals.")).toBeInTheDocument();
    advance(1);
    expect(screen.queryByText("Stopped 2 idle terminals.")).not.toBeInTheDocument();
  });

  it.each(["info", "success"] as const)("expires an unfocused %s toast normally", (tone) => {
    const { result } = renderHook(useToast, { wrapper });
    act(() => result.current.show({ title: "Finished", tone }));
    advance(4499);
    expect(screen.getByText("Finished")).toBeInTheDocument();
    advance(1);
    expect(screen.queryByText("Finished")).not.toBeInTheDocument();
  });

  it("supports repeated focus pauses without extending the original remaining duration", () => {
    const { result } = renderHook(useToast, { wrapper });
    act(() => result.current.show({ title: "Finished", duration: 2000 }));
    const dismiss = screen.getByRole("button", { name: "Dismiss notification" });
    const outside = screen.getByRole("button", { name: "Outside the toast" });
    advance(500);
    act(() => dismiss.focus());
    advance(3000);
    act(() => outside.focus());
    advance(500);
    act(() => dismiss.focus());
    advance(3000);
    expect(dismiss).toHaveFocus();
    act(() => outside.focus());
    advance(999);
    expect(screen.getByText("Finished")).toBeInTheDocument();
    advance(1);
    expect(screen.queryByText("Finished")).not.toBeInTheDocument();
  });

  it("still lets the person manually dismiss a paused toast", () => {
    const { result } = renderHook(useToast, { wrapper });
    act(() => result.current.show({ title: "Saved" }));
    const dismiss = screen.getByRole("button", { name: "Dismiss notification" });
    act(() => dismiss.focus());
    fireEvent.click(dismiss);
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
    advance(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears an evicted toast's timer while retaining the newest four toasts", () => {
    const { result } = renderHook(useToast, { wrapper });
    act(() => {
      for (let n = 1; n <= 4; n++) result.current.show({ title: `Notice ${n}`, duration: 20_000 });
    });
    act(() => result.current.show({ title: "Notice 5", duration: 20_000 }));
    expect(screen.queryByText("Notice 1")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Dismiss notification" })).toHaveLength(4);
    expect(vi.getTimerCount()).toBe(4);
    advance(20_000);
    expect(screen.queryByText("Notice 5")).not.toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains keyboard focus during overflow, then restores FIFO after focus leaves", () => {
    const { result } = renderHook(useToast, { wrapper });
    act(() => {
      for (let n = 1; n <= 4; n++) result.current.show({ title: `Notice ${n}`, duration: 20_000 });
    });
    const focused = screen.getAllByRole("button", { name: "Dismiss notification" })[0];
    if (!focused) throw new Error("Expected a dismiss button");
    act(() => focused.focus());
    advance(0);
    for (let n = 5; n <= 7; n++) {
      act(() => result.current.show({ title: `Notice ${n}`, duration: 20_000 }));
      expect(focused).toHaveFocus();
      expect(screen.getByText("Notice 1")).toBeInTheDocument();
      expect(screen.queryByText(`Notice ${n - 3}`)).not.toBeInTheDocument();
      expect(screen.getAllByRole("button", { name: "Dismiss notification" })).toHaveLength(4);
      expect(vi.getTimerCount()).toBe(3);
    }
    act(() => screen.getByRole("button", { name: "Outside the toast" }).focus());
    act(() => result.current.show({ title: "Notice 8", duration: 20_000 }));
    advance(0);
    expect(screen.queryByText("Notice 1")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Dismiss notification" })).toHaveLength(4);
    expect(vi.getTimerCount()).toBe(4);
    advance(20_000);
    expect(screen.queryAllByRole("button", { name: "Dismiss notification" })).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears both running and paused toast timers when unmounted", () => {
    const { result, unmount } = renderHook(useToast, { wrapper });
    act(() => result.current.show({ title: "Paused" }));
    act(() => screen.getByRole("button", { name: "Dismiss notification" }).focus());
    act(() => result.current.show({ title: "Running" }));
    unmount();
    advance(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("protects a focused toast through a batched burst and permits its explicit dismissal", () => {
    const { result, unmount } = renderHook(useToast, { wrapper });
    act(() => result.current.show({ title: "Reading", duration: 20_000 }));
    const focused = screen.getByRole("button", { name: "Dismiss notification" });
    act(() => focused.focus());
    advance(0);
    act(() => {
      for (let n = 1; n <= 10; n++) result.current.show({ title: `Burst ${n}`, duration: 20_000 });
    });
    expect(focused).toHaveFocus();
    expect(screen.getAllByRole("button", { name: "Dismiss notification" })).toHaveLength(4);
    for (const n of [8, 9, 10]) expect(screen.getByText(`Burst ${n}`)).toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(3);
    fireEvent.click(focused);
    expect(screen.queryByText("Reading")).not.toBeInTheDocument();
    act(() => {
      result.current.show({ title: "Next 1", duration: 20_000 });
      result.current.show({ title: "Next 2", duration: 20_000 });
    });
    expect(screen.queryByText("Burst 8")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Dismiss notification" })).toHaveLength(4);
    expect(vi.getTimerCount()).toBe(4);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps default error toasts persistent after focus leaves", () => {
    const { result } = renderHook(useToast, { wrapper });
    act(() => result.current.show({ title: "Save failed", tone: "danger" }));
    act(() => screen.getByRole("button", { name: "Dismiss notification" }).focus());
    act(() => screen.getByRole("button", { name: "Outside the toast" }).focus());
    advance(30_000);
    expect(screen.getByText("Save failed")).toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(0);
  });
});
