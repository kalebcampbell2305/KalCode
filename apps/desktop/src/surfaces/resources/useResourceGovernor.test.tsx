import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResourceReport } from "../../ipc/resources.ts";
import { getResourceReport, setResourceMode, setResourceViewOpen } from "../../ipc/resources.ts";
import { useResourceGovernor } from "./useResourceGovernor.ts";

vi.mock("../../ipc/resources.ts", () => ({
  getResourceReport: vi.fn(),
  setResourceMode: vi.fn(),
  setResourceViewOpen: vi.fn(),
}));

const getReport = vi.mocked(getResourceReport);
const setMode = vi.mocked(setResourceMode);
const setViewOpen = vi.mocked(setResourceViewOpen);

describe("useResourceGovernor", () => {
  beforeEach(() => {
    getReport.mockReset().mockResolvedValue({} as ResourceReport);
    setMode.mockReset().mockResolvedValue({} as ResourceReport);
    setViewOpen.mockReset().mockResolvedValue(undefined);
  });

  it("refreshes without briefly releasing visible-view activity ownership", async () => {
    const { result, unmount } = renderHook(() => useResourceGovernor());
    await waitFor(() => expect(getReport).toHaveBeenCalledTimes(1));
    expect(setViewOpen).toHaveBeenCalledWith(true);

    act(() => result.current.refresh());
    await waitFor(() => expect(getReport).toHaveBeenCalledTimes(2));
    expect(setViewOpen).not.toHaveBeenCalledWith(false);

    unmount();
    expect(setViewOpen).toHaveBeenLastCalledWith(false);
  });

  describe("shared poller", () => {
    const setVisibility = (state: DocumentVisibilityState) => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
      document.dispatchEvent(new Event("visibilitychange"));
    };
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => {
      vi.useRealTimers();
      setVisibility("visible");
    });

    it("reads once a second for every mounted view, and one view closing keeps the other open", async () => {
      const first = renderHook(() => useResourceGovernor());
      const second = renderHook(() => useResourceGovernor());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_050);
      });
      // One immediate read plus one per second: not doubled by the second view.
      expect(getReport.mock.calls.length).toBeGreaterThanOrEqual(10);
      expect(getReport.mock.calls.length).toBeLessThanOrEqual(12);
      expect(second.result.current.report).toBe(first.result.current.report);
      expect(setViewOpen.mock.calls).toEqual([[true]]);

      first.unmount();
      expect(setViewOpen).not.toHaveBeenCalledWith(false);
      second.unmount();
      expect(setViewOpen).toHaveBeenLastCalledWith(false);
      getReport.mockClear();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(getReport).not.toHaveBeenCalled();
    });

    it("pauses while the window is hidden and reads at once when it is shown", async () => {
      const view = renderHook(() => useResourceGovernor());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      act(() => setVisibility("hidden"));
      expect(setViewOpen).toHaveBeenLastCalledWith(false);
      getReport.mockClear();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(getReport).not.toHaveBeenCalled();

      act(() => setVisibility("visible"));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });
      expect(getReport).toHaveBeenCalledTimes(1);
      expect(setViewOpen).toHaveBeenLastCalledWith(true);
      view.unmount();
    });
  });
});
