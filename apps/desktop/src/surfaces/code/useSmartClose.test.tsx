import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useSmartClose } from "./useSmartClose.tsx";

function setup(active = true) {
  const stop = vi.fn().mockResolvedValue(undefined);
  const closed = vi.fn();
  const inspect = vi.fn().mockResolvedValue(active);
  const view = renderHook(() => useSmartClose({ inspect, stop }));
  const items = [{ kind: "terminal" as const, terminalId: "shell" }];
  return { ...view, stop, closed, inspect, items };
}

it("closes ended work immediately after cleanup succeeds", async () => {
  const f = setup(false);
  await act(async () => f.result.current.request(f.items, f.closed));
  expect(f.stop).toHaveBeenCalledOnce();
  expect(f.closed).toHaveBeenCalledOnce();
  expect(f.result.current.pending).toBeNull();
});

it("Cancel keeps active work and its pane intact", async () => {
  const f = setup();
  await act(async () => f.result.current.request(f.items, f.closed));
  act(() => f.result.current.cancel());
  expect(f.stop).not.toHaveBeenCalled();
  expect(f.closed).not.toHaveBeenCalled();
});

it("does not offer a close path that leaves active work running", async () => {
  const f = setup();
  await act(async () => f.result.current.request(f.items, f.closed));
  expect(f.result.current).not.toHaveProperty("keepRunning");
  expect(f.stop).not.toHaveBeenCalled();
  expect(f.closed).not.toHaveBeenCalled();
});

it("retains the pane and reports stop failure in the same dialog", async () => {
  const f = setup();
  f.stop.mockRejectedValue({
    category: "terminal",
    code: "terminal_close_failed",
    message: "process still running",
    retryable: true,
  });
  await act(async () => f.result.current.request(f.items, f.closed));
  await act(async () => f.result.current.stopAndClose());
  expect(f.closed).not.toHaveBeenCalled();
  expect(f.result.current.pending?.error).toContain("process still running");
  f.stop.mockResolvedValue(undefined);
  await act(async () => f.result.current.stopAndClose());
  expect(f.closed).toHaveBeenCalledOnce();
});

it("coalesces repeat closes while inspecting and while confirming", async () => {
  const f = setup();
  let finish!: (value: boolean) => void;
  f.inspect.mockImplementation(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  act(() => {
    f.result.current.request(f.items, f.closed);
    f.result.current.request(f.items, f.closed);
  });
  expect(f.inspect).toHaveBeenCalledOnce();
  await act(async () => finish(true));
  act(() => {
    void f.result.current.request(f.items, f.closed);
  });
  expect(f.inspect).toHaveBeenCalledOnce();
  expect(f.stop).not.toHaveBeenCalled();
});

it("unknown activity asks once and unmount cancels pending inspection", async () => {
  const f = setup();
  f.inspect.mockRejectedValue(new Error("offline"));
  await act(async () => f.result.current.request(f.items, f.closed));
  expect(f.result.current.pending).not.toBeNull();
  expect(f.stop).not.toHaveBeenCalled();
  act(() => f.result.current.cancel());
  let finish!: (value: boolean) => void;
  f.inspect.mockImplementation(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  act(() => {
    void f.result.current.request(f.items, f.closed);
  });
  f.unmount();
  await act(async () => finish(false));
  expect(f.closed).not.toHaveBeenCalled();
  expect(f.stop).not.toHaveBeenCalled();
});

it("waits for every stop before closing a multi-tab pane", async () => {
  const f = setup();
  const items = [...f.items, { kind: "agent" as const, agentId: "agent" }];
  await act(async () => f.result.current.request(items, f.closed));
  let finish!: () => void;
  f.stop.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  act(() => {
    void f.result.current.stopAndClose();
  });
  expect(f.closed).not.toHaveBeenCalled();
  await act(async () => finish());
  await waitFor(() => expect(f.stop).toHaveBeenCalledTimes(2));
  expect(f.closed).not.toHaveBeenCalled();
  await act(async () => finish());
  expect(f.closed).toHaveBeenCalledOnce();
});

it("a restarted terminal is protected during automatic close, then stops only after the choice", async () => {
  const f = setup(false);
  f.stop.mockRejectedValueOnce({
    category: "terminal",
    code: "terminal_still_running",
    message: "Running",
    retryable: true,
  });
  await act(async () => f.result.current.request(f.items, f.closed));
  expect(f.stop).toHaveBeenLastCalledWith(f.items[0], false);
  expect(f.result.current.pending?.error).toBeNull();
  expect(f.closed).not.toHaveBeenCalled();
  await act(async () => f.result.current.stopAndClose());
  expect(f.stop).toHaveBeenLastCalledWith(f.items[0], true);
  expect(f.closed).toHaveBeenCalledOnce();
});

it("a partial close retry only stops the remaining work", async () => {
  const f = setup();
  const agent = { kind: "agent" as const, agentId: "agent" };
  f.stop
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce({ category: "terminal", code: "stop_failed", message: "Still running", retryable: true });
  await act(async () => f.result.current.request([...f.items, agent], f.closed));
  await act(async () => f.result.current.stopAndClose());
  expect(f.closed).not.toHaveBeenCalled();
  await act(async () => f.result.current.stopAndClose());
  expect(f.stop.mock.calls.map(([content]) => content)).toEqual([f.items[0], agent, agent]);
  expect(f.closed).toHaveBeenCalledOnce();
});
