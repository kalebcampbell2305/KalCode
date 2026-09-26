// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { COMMAND_UNAVAILABLE, KalCodeError } from "../../../ipc/errors.ts";
import { useResource } from "./resource.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const unavailable = new KalCodeError({
  category: "internal",
  code: COMMAND_UNAVAILABLE,
  message: "Command unavailable",
  retryable: false,
});
const failure = new KalCodeError({
  category: "network",
  code: "offline",
  message: "Offline",
  retryable: true,
});

describe("useResource", () => {
  it("replaces old client data immediately and reads the new source without a version change", async () => {
    const first = vi.fn().mockResolvedValue("first client");
    const next = deferred<string>();
    const second = vi.fn(() => next.promise);
    const { result, rerender } = renderHook(({ load }) => useResource(load, 0), {
      initialProps: { load: first as () => Promise<string> },
    });
    await waitFor(() => expect(result.current.state).toEqual({ status: "ready", data: "first client", error: null }));
    rerender({ load: second });
    expect(result.current.state).toEqual({ status: "loading" });
    expect(second).toHaveBeenCalledTimes(1);
    await act(async () => next.resolve("second client"));
    expect(result.current.state).toEqual({ status: "ready", data: "second client", error: null });
  });

  it("latches unavailable only for that source and retries a replacement", async () => {
    const first = vi.fn().mockRejectedValue(unavailable);
    const second = vi.fn().mockResolvedValue("available");
    const { result, rerender } = renderHook(({ load, version }) => useResource(load, version), {
      initialProps: { load: first as () => Promise<string>, version: 0 },
    });
    await waitFor(() => expect(result.current.state.status).toBe("unavailable"));
    rerender({ load: first, version: 1 });
    act(() => result.current.reload());
    expect(first).toHaveBeenCalledTimes(1);
    rerender({ load: second, version: 1 });
    await waitFor(() => expect(result.current.state).toEqual({ status: "ready", data: "available", error: null }));
    expect(second).toHaveBeenCalledTimes(1);
  });

  it.each(["success", "failure", "unavailable"] as const)(
    "ignores stale %s after client replacement",
    async (outcome) => {
      const pending = deferred<string>();
      const first = vi.fn(() => pending.promise);
      const second = vi.fn().mockResolvedValue("current");
      const { result, rerender } = renderHook(({ load, version }) => useResource(load, version), {
        initialProps: { load: first as () => Promise<string>, version: 0 },
      });
      rerender({ load: second, version: 0 });
      await waitFor(() => expect(result.current.state).toEqual({ status: "ready", data: "current", error: null }));
      await act(async () => {
        if (outcome === "success") pending.resolve("obsolete");
        else pending.reject(outcome === "unavailable" ? unavailable : failure);
      });
      expect(result.current.state).toEqual({ status: "ready", data: "current", error: null });
      rerender({ load: second, version: 1 });
      await waitFor(() => expect(second).toHaveBeenCalledTimes(2));
    },
  );

  it("does not refetch stable sources on rerender or local updates", async () => {
    const load = vi.fn().mockResolvedValue("loaded");
    const { result, rerender } = renderHook(() => useResource(load, 0));
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    rerender();
    act(() => result.current.update((data) => `${data} locally`));
    expect(result.current.state).toEqual({ status: "ready", data: "loaded locally", error: null });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("ignores an action's captured update after its client has been replaced", async () => {
    const first = vi.fn().mockResolvedValue("first client");
    const second = vi.fn().mockResolvedValue("second client");
    const { result, rerender } = renderHook(({ load }) => useResource(load, 0), {
      initialProps: { load: first as () => Promise<string> },
    });
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    const oldActionUpdate = result.current.update;
    rerender({ load: second });
    await waitFor(() => expect(result.current.state).toEqual({ status: "ready", data: "second client", error: null }));
    const staleChange = vi.fn(() => "first client's action result");
    act(() => oldActionUpdate(staleChange));
    expect(staleChange).not.toHaveBeenCalled();
    expect(result.current.state).toEqual({ status: "ready", data: "second client", error: null });
    act(() => result.current.update(() => "second client's action result"));
    expect(result.current.state).toEqual({ status: "ready", data: "second client's action result", error: null });
  });

  it("preserves data on a failed same-source refresh and recovers on reload", async () => {
    const load = vi.fn().mockResolvedValueOnce("loaded").mockRejectedValueOnce(failure).mockResolvedValueOnce("fresh");
    const { result, rerender } = renderHook(({ version }) => useResource(load, version), {
      initialProps: { version: 0 },
    });
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    rerender({ version: 1 });
    await waitFor(() => expect(result.current.state).toEqual({ status: "ready", data: "loaded", error: failure }));
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.state).toEqual({ status: "ready", data: "fresh", error: null }));
    expect(load).toHaveBeenCalledTimes(3);
  });
});
