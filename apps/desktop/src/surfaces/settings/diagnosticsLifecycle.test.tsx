import type { Diagnostics, SecureStoreCheck } from "@kalcode/protocol";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDiagnostics } from "../../runtime/useDiagnostics.ts";
import { useDiagnosticsActions } from "./useDiagnosticsActions.ts";

const runtime = vi.hoisted(() => ({ client: {} as ReturnType<typeof makeClient>, events: [] }));
const toast = vi.hoisted(() => ({ show: vi.fn() }));
vi.mock("../../runtime/RuntimeProvider.tsx", () => ({ useRuntime: () => runtime, useEvents: () => runtime }));
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
const snapshot = { generatedAt: "runtime-a" } as Diagnostics;
const checked: SecureStoreCheck = { ok: true, backend: "fixture", checkedAt: "now", message: null };
function makeClient() {
  return {
    getDiagnostics: vi.fn(async () => snapshot),
    checkSecureStore: vi.fn(async () => checked),
    openLogFolder: vi.fn(async () => {}),
  };
}
const writeText = vi.fn(async (_report: string) => {});
beforeEach(() => {
  vi.clearAllMocks();
  runtime.client = makeClient();
  runtime.events = [];
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
});

describe("diagnostics runtime lifetime", () => {
  it("keeps a newer refresh when an earlier read finishes last", async () => {
    const old = deferred<Diagnostics>();
    runtime.client.getDiagnostics.mockReturnValueOnce(old.promise);
    const { result } = renderHook(useDiagnostics);
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.data).toEqual(snapshot));
    await act(async () => {
      old.reject(new Error("obsolete"));
    });
    expect(result.current.data).toEqual(snapshot);
    expect(result.current.error).toBeNull();
  });

  it("uses the live root StrictMode read and ignores the discarded setup", async () => {
    const old = deferred<Diagnostics>();
    runtime.client.getDiagnostics.mockReturnValueOnce(old.promise);
    const { result } = renderHook(useDiagnostics, { reactStrictMode: true });
    expect(runtime.client.getDiagnostics).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(result.current.data).toEqual(snapshot));
    await act(async () => {
      old.reject(new Error("discarded"));
    });
    expect(result.current.error).toBeNull();
  });
  it("hides previous health data until the replacement runtime answers", async () => {
    const { result, rerender } = renderHook(useDiagnostics);
    await waitFor(() => expect(result.current.data).toEqual(snapshot));
    runtime.client = makeClient();
    runtime.client.getDiagnostics.mockReturnValue(deferred<Diagnostics>().promise);
    rerender();
    expect(result.current.data).toBeNull();
  });

  it("hides previous errors and rejects a retained refresh after runtime replacement", async () => {
    runtime.client.getDiagnostics.mockRejectedValue(new Error("old failure"));
    const { result, rerender } = renderHook(useDiagnostics);
    await waitFor(() => expect(result.current.error).not.toBeNull());
    const refresh = result.current.refresh;
    runtime.client = makeClient();
    runtime.client.getDiagnostics.mockReturnValue(deferred<Diagnostics>().promise);
    rerender();
    expect(result.current.error).toBeNull();
    act(refresh);
    expect(runtime.client.getDiagnostics).toHaveBeenCalledTimes(1);
  });

  it("does not restore a previous snapshot when the same client returns", async () => {
    const first = runtime.client;
    const { result, rerender } = renderHook(useDiagnostics);
    await waitFor(() => expect(result.current.data).toEqual(snapshot));
    runtime.client = makeClient();
    runtime.client.getDiagnostics.mockReturnValue(deferred<Diagnostics>().promise);
    rerender();
    runtime.client = first;
    first.getDiagnostics.mockReturnValue(deferred<Diagnostics>().promise);
    rerender();
    expect(result.current.data).toBeNull();
  });
});

describe("diagnostic actions", () => {
  it("ignores callbacks retained across an A to B to A runtime transition", async () => {
    const first = runtime.client;
    const { result, rerender } = renderHook(useDiagnosticsActions);
    const retained = result.current;
    runtime.client = makeClient();
    rerender();
    runtime.client = first;
    rerender();
    await retained.copyReport();
    await retained.openLogs();
    expect(await retained.checkSecureStore()).toBeNull();
    expect(first.getDiagnostics).not.toHaveBeenCalled();
    expect(first.openLogFolder).not.toHaveBeenCalled();
    expect(first.checkSecureStore).not.toHaveBeenCalled();
  });

  it("suppresses obsolete failures while keeping current failures visible and retryable", async () => {
    const old = deferred<void>();
    runtime.client.openLogFolder.mockReturnValue(old.promise);
    const { result, rerender } = renderHook(useDiagnosticsActions);
    const opening = result.current.openLogs();
    runtime.client = makeClient();
    rerender();
    await act(async () => {
      old.reject(new Error("old logs"));
      await opening;
    });
    expect(toast.show).not.toHaveBeenCalled();
    runtime.client.checkSecureStore.mockRejectedValueOnce(new Error("store unavailable"));
    await act(() => result.current.checkSecureStore());
    expect(result.current.checking).toBe(false);
    expect(toast.show).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: "Couldn't run the credential store check" }),
    );
    await act(() => result.current.checkSecureStore());
    expect(toast.show).toHaveBeenLastCalledWith(expect.objectContaining({ title: "Credential store verified" }));
  });

  it("ignores a check from discarded StrictMode setup without unlocking the live check", async () => {
    const old = deferred<SecureStoreCheck>();
    const current = deferred<SecureStoreCheck>();
    runtime.client.checkSecureStore.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const calls: Promise<SecureStoreCheck | null>[] = [];
    const { result } = renderHook(
      () => {
        const actions = useDiagnosticsActions();
        useEffect(() => {
          calls.push(actions.checkSecureStore());
        }, [actions.checkSecureStore]);
        return actions;
      },
      { reactStrictMode: true },
    );
    expect(calls).toHaveLength(2);
    await act(async () => {
      old.resolve(checked);
      expect(await calls[0]).toBeNull();
    });
    expect(result.current.checking).toBe(true);
    expect(toast.show).not.toHaveBeenCalled();
    await act(async () => {
      current.resolve(checked);
      await calls[1];
    });
    expect(result.current.checking).toBe(false);
    expect(toast.show).toHaveBeenCalledTimes(1);
  });
  it.each(["replace", "unmount"])("does not copy a late report after %s", async (change) => {
    const report = deferred<Diagnostics>();
    runtime.client.getDiagnostics.mockReturnValue(report.promise);
    const { result, rerender, unmount } = renderHook(useDiagnosticsActions);
    let copying!: Promise<void>;
    act(() => {
      copying = result.current.copyReport();
    });
    if (change === "replace") {
      runtime.client = makeClient();
      rerender();
    } else unmount();
    await act(async () => {
      report.resolve(snapshot);
      await copying;
    });
    expect(writeText).not.toHaveBeenCalled();
    expect(toast.show).not.toHaveBeenCalled();
  });

  it("ignores retained action callbacks after unmount", async () => {
    const { result, unmount } = renderHook(useDiagnosticsActions);
    const retained = result.current;
    unmount();
    await retained.copyReport();
    await retained.openLogs();
    await retained.checkSecureStore();
    expect(runtime.client.getDiagnostics).not.toHaveBeenCalled();
    expect(runtime.client.openLogFolder).not.toHaveBeenCalled();
    expect(runtime.client.checkSecureStore).not.toHaveBeenCalled();
  });

  it("starts a fresh check on a new runtime without an old completion clearing it", async () => {
    const old = deferred<SecureStoreCheck>();
    runtime.client.checkSecureStore.mockReturnValue(old.promise);
    const { result, rerender } = renderHook(useDiagnosticsActions);
    let first!: Promise<SecureStoreCheck | null>;
    act(() => {
      first = result.current.checkSecureStore();
    });
    runtime.client = makeClient();
    const fresh = deferred<SecureStoreCheck>();
    runtime.client.checkSecureStore.mockReturnValue(fresh.promise);
    rerender();
    expect(result.current.checking).toBe(false);
    let second!: Promise<SecureStoreCheck | null>;
    act(() => {
      second = result.current.checkSecureStore();
    });
    await act(async () => {
      old.resolve(checked);
      expect(await first).toBeNull();
    });
    expect(result.current.checking).toBe(true);
    expect(toast.show).not.toHaveBeenCalled();
    await act(async () => {
      fresh.resolve(checked);
      expect(await second).toEqual(checked);
    });
    expect(result.current.checking).toBe(false);
    expect(toast.show).toHaveBeenCalledTimes(1);
  });

  it("does not run overlapping credential-store probes on the same runtime", async () => {
    const check = deferred<SecureStoreCheck>();
    runtime.client.checkSecureStore.mockReturnValue(check.promise);
    const { result } = renderHook(useDiagnosticsActions);
    let first!: Promise<SecureStoreCheck | null>;
    let duplicate!: Promise<SecureStoreCheck | null>;
    act(() => {
      first = result.current.checkSecureStore();
      duplicate = result.current.checkSecureStore();
    });
    expect(runtime.client.checkSecureStore).toHaveBeenCalledTimes(1);
    await act(async () => {
      check.resolve(checked);
      await Promise.all([first, duplicate]);
    });
    expect(toast.show).toHaveBeenCalledTimes(1);
    expect(result.current.checking).toBe(false);
  });

  it("prevents an older report from overwriting a newer copy request", async () => {
    const old = deferred<Diagnostics>();
    runtime.client.getDiagnostics.mockReturnValueOnce(old.promise);
    const { result } = renderHook(useDiagnosticsActions);
    let first!: Promise<void>;
    act(() => {
      first = result.current.copyReport();
    });
    await act(() => result.current.copyReport());
    await act(async () => {
      old.resolve(snapshot);
      await first;
    });
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(toast.show).toHaveBeenCalledTimes(1);
  });
});
