import type { ProviderAccount } from "@kalcode/protocol";
import { ToastProvider } from "@kalcode/ui/components";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { KalCodeClient } from "../../ipc/client.ts";
import { useProviderAccounts } from "./useProviderAccounts.ts";

const runtime = vi.hoisted(() => ({ client: null as unknown as KalCodeClient }));
vi.mock("../../runtime/RuntimeProvider.tsx", () => ({ useRuntime: () => runtime }));
const wrapper = ({ children }: { children: ReactNode }) => <ToastProvider>{children}</ToastProvider>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

describe("provider authentication runtime isolation", () => {
  it.each(["start", "wait", "cursor"])(
    "discards old-client %s authentication after runtime replacement",
    async (stage) => {
      const providerId = stage === "cursor" ? "cursor" : "codex";
      const account = {
        id: "account-b",
        providerId,
        displayName: "Coding B",
        authenticationState: "not_authenticated",
      } as ProviderAccount;
      const connected = { ...account, authenticationState: "authenticated" as const };
      const start = deferred<{ loginHandle: string }>();
      const wait = deferred<ProviderAccount>();
      const cursor = deferred<{ account: ProviderAccount; models: []; modelsError: null }>();
      const firstClient = {
        startCodexLogin: vi.fn(() =>
          stage === "start" ? start.promise : Promise.resolve({ loginHandle: "old-handle" }),
        ),
        waitForCodexLogin: vi.fn(() => wait.promise),
        cancelCodexLogin: vi.fn(async () => undefined),
        loginCursorAccount: vi.fn(() => cursor.promise),
      } as unknown as KalCodeClient;
      runtime.client = firstClient;
      const { result, rerender } = renderHook(() => useProviderAccounts(false), { wrapper });
      let completion!: Promise<ProviderAccount | null>;
      await act(async () => {
        completion = result.current.signInAuth(account);
      });
      runtime.client = {} as KalCodeClient;
      rerender();
      await act(async () => {
        start.resolve({ loginHandle: "old-handle" });
        wait.resolve(connected);
        cursor.resolve({ account: connected, models: [], modelsError: null });
        expect(await completion).toBeNull();
      });
      expect(result.current.accounts).toBeNull();
      if (stage !== "cursor") expect(firstClient.cancelCodexLogin).toHaveBeenCalledWith("old-handle");
      if (stage === "start") expect(firstClient.waitForCodexLogin).not.toHaveBeenCalled();
    },
  );
});
