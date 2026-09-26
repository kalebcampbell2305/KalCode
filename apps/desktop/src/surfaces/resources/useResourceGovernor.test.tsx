import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
});
