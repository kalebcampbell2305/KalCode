import type { EventEnvelope, ProviderAccount } from "@kalcode/protocol";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KalCodeClient } from "../../ipc/client.ts";
import { EventFeed } from "../../runtime/eventFeed.ts";
import { ProviderAccountSessionsProvider, useOptionalProviderAccountSessions } from "./ProviderAccountSessions.tsx";

const runtime = vi.hoisted(() => ({ client: null as unknown as KalCodeClient, feed: null as EventFeed | null }));
vi.mock("../../runtime/RuntimeProvider.tsx", () => ({ useRuntime: () => runtime }));

beforeEach(() => {
  runtime.feed = new EventFeed();
});

function account(id: string, providerId: ProviderAccount["providerId"], name: string): ProviderAccount {
  return {
    id,
    providerId,
    displayName: name,
    providerReportedIdentity: `${name.toLowerCase()}@example.com`,
    authenticationState: "authenticated",
    isDefault: id.endsWith("a"),
    createdAt: "2026-10-01T00:00:00.000Z",
    lastUsedAt: null,
    lastCheckedAt: "2026-10-01T01:00:00.000Z",
    lastErrorCode: null,
    archivedAt: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function providerError(seq: number, providerId: string, code: string): EventEnvelope {
  return { seq, type: "provider.error", payload: { providerId, code, message: code } } as EventEnvelope;
}

function threadFailed(seq: number, code: string): EventEnvelope {
  return { seq, type: "thread.failed", payload: { threadId: "thread-1", code, message: code } } as EventEnvelope;
}

const wrapper = ({ children }: { children: ReactNode }) => (
  <ProviderAccountSessionsProvider>{children}</ProviderAccountSessionsProvider>
);

describe("provider account session restoration", () => {
  it("does not let an earlier metadata reload undo provider-confirmed expiration", async () => {
    const saved = account("codex-b", "codex", "Codex B");
    const check = deferred<ProviderAccount>();
    const staleList = deferred<ProviderAccount[]>();
    runtime.client = {
      listProviderAccounts: vi
        .fn()
        .mockResolvedValueOnce([saved])
        .mockImplementationOnce(() => staleList.promise),
      refreshCodexAccount: vi.fn(() => check.promise),
    } as unknown as KalCodeClient;
    const view = renderHook(useOptionalProviderAccountSessions, { wrapper });
    await waitFor(() => expect(view.result.current?.checking.has(saved.id)).toBe(true));
    let reload: Promise<ProviderAccount[] | null> | undefined;
    act(() => {
      reload = view.result.current?.reload();
    });
    const expired = { ...saved, authenticationState: "not_authenticated" as const };
    await act(async () => {
      check.resolve(expired);
    });
    await waitFor(() => expect(view.result.current?.states.get(saved.id)?.health.state).toBe("expired"));
    await act(async () => {
      staleList.resolve([saved]);
      await reload;
    });
    expect(view.result.current?.states.get(saved.id)).toMatchObject({ account: expired, health: { usable: false } });
  });

  it("shows the account the native store promoted to default after the default is removed", async () => {
    const first = account("codex-a", "codex", "Codex A");
    const second = account("codex-b", "codex", "Codex B");
    const list = vi
      .fn()
      .mockResolvedValueOnce([first, second])
      .mockResolvedValue([{ ...second, isDefault: true }]);
    runtime.client = {
      listProviderAccounts: list,
      refreshCodexAccount: vi.fn(async (id: string) => (id === first.id ? first : second)),
    } as unknown as KalCodeClient;
    const view = renderHook(useOptionalProviderAccountSessions, { wrapper });
    await waitFor(() => expect(view.result.current?.accounts).toHaveLength(2));
    await waitFor(() => expect(view.result.current?.checking.size).toBe(0));

    act(() => {
      view.result.current?.replace({ ...first, isDefault: false, archivedAt: "2026-10-06T00:00:00.000Z" });
    });

    await waitFor(() =>
      expect(view.result.current?.accounts).toEqual([expect.objectContaining({ id: second.id, isDefault: true })]),
    );
  });

  it("publishes models for the identity confirmed by the same Cursor response", async () => {
    const saved = account("cursor-a", "cursor", "Work");
    const checked = { ...saved, providerReportedIdentity: "verified@example.com" };
    runtime.client = {
      listProviderAccounts: vi.fn(async () => [saved]),
      refreshCursorAccount: vi.fn(async () => ({ account: checked, models: [], modelsError: null })),
    } as unknown as KalCodeClient;
    const view = renderHook(useOptionalProviderAccountSessions, { wrapper });
    await waitFor(() => expect(view.result.current?.accounts).toEqual([saved]));
    await act(async () => {
      await view.result.current?.discoverModels(saved.id);
    });
    expect(view.result.current?.states.get(saved.id)).toMatchObject({
      account: checked,
      models: { status: "available" },
    });
  });

  it.each(["codex", "claude-code", "cursor", "gemini-cli"] as const)(
    "keeps persisted %s authentication usable across metadata failures and restart",
    async (providerId) => {
      const saved = account("saved-account", providerId, "Work");
      runtime.client = {
        listProviderAccounts: vi.fn(async () => [saved]),
        refreshCodexAccount: vi.fn(async () => saved),
        refreshGeminiAccount: vi.fn(async () => saved),
        refreshCursorAccount: vi.fn(async () => {
          throw new Error("Models unavailable");
        }),
        threadOptions: vi.fn(async () => {
          throw new Error("Models unavailable");
        }),
        providerAccountUsage: vi.fn(async () => {
          throw new Error("Usage unavailable");
        }),
      } as unknown as KalCodeClient;
      const first = renderHook(useOptionalProviderAccountSessions, { wrapper });
      await waitFor(() => expect(first.result.current?.states.get(saved.id)?.health.state).toBe("connected"));
      await act(async () => {
        await first.result.current?.discoverModels(saved.id);
      });
      expect(first.result.current?.states.get(saved.id)).toMatchObject({
        account: saved,
        health: { state: "connected", usable: true },
        plan: { status: "unavailable", name: null },
        models: { status: "unavailable", items: [] },
      });
      first.unmount();
      const restarted = renderHook(useOptionalProviderAccountSessions, { wrapper });
      await waitFor(() =>
        expect(restarted.result.current?.states.get(saved.id)).toMatchObject({
          account: saved,
          health: { state: "connected", usable: true },
          models: null,
        }),
      );
      expect(runtime.client.listProviderAccounts).toHaveBeenCalledTimes(2);
    },
  );

  it("coalesces model discovery and discards results after the same account changes identity", async () => {
    const original = account("cursor-a", "cursor", "Work");
    const discovered = deferred<Awaited<ReturnType<KalCodeClient["refreshCursorAccount"]>>>();
    const list = vi.fn(async () => [original]);
    runtime.client = {
      listProviderAccounts: list,
      refreshCursorAccount: vi.fn(() => discovered.promise),
    } as unknown as KalCodeClient;
    const view = renderHook(useOptionalProviderAccountSessions, { wrapper });
    await waitFor(() => expect(view.result.current?.accounts).toEqual([original]));
    let request: Promise<void> | undefined;
    act(() => {
      request = view.result.current?.discoverModels(original.id);
      expect(view.result.current?.discoverModels(original.id)).toBe(request);
    });
    await waitFor(() => expect(runtime.client.refreshCursorAccount).toHaveBeenCalledTimes(1));
    const changed = { ...original, providerReportedIdentity: "other@example.com" };
    list.mockResolvedValue([changed]);
    await act(async () => {
      await view.result.current?.reload();
    });
    await act(async () => {
      discovered.resolve({ account: original, models: [], modelsError: null });
      await request;
    });
    expect(view.result.current?.states.get(original.id)).toMatchObject({ account: changed, models: null });
  });

  it("clears model state when the runtime changes and ignores the old client's response", async () => {
    const original = account("cursor-a", "cursor", "Work");
    const discovered = deferred<Awaited<ReturnType<KalCodeClient["refreshCursorAccount"]>>>();
    runtime.client = {
      listProviderAccounts: vi.fn(async () => [original]),
      refreshCursorAccount: vi.fn(() => discovered.promise),
    } as unknown as KalCodeClient;
    const view = renderHook(useOptionalProviderAccountSessions, { wrapper });
    await waitFor(() => expect(view.result.current?.accounts).toEqual([original]));
    let request: Promise<void> | undefined;
    act(() => {
      request = view.result.current?.discoverModels(original.id);
    });
    await waitFor(() => expect(runtime.client.refreshCursorAccount).toHaveBeenCalledTimes(1));
    const changed = { ...original, providerReportedIdentity: "other@example.com" };
    runtime.client = { listProviderAccounts: vi.fn(async () => [changed]) } as unknown as KalCodeClient;
    view.rerender();
    await waitFor(() => expect(view.result.current?.accounts).toEqual([changed]));
    await act(async () => {
      discovered.resolve({ account: original, models: [], modelsError: null });
      await request;
    });
    expect(view.result.current?.states.get(original.id)).toMatchObject({ account: changed, models: null });
  });

  it("restores Cursor native identity without running a credential-refreshing observer", async () => {
    const cursor = account("cursor-native", "cursor", "Cursor A");
    runtime.client = {
      listProviderAccounts: vi.fn(async () => [cursor]),
      refreshCursorAccount: vi.fn(),
      loginCursorAccount: vi.fn(),
    } as unknown as KalCodeClient;
    const view = renderHook(useOptionalProviderAccountSessions, { wrapper, reactStrictMode: true });
    await waitFor(() => expect(view.result.current?.accounts).toEqual([cursor]));
    await act(async () => {
      await view.result.current?.reload();
    });
    expect(runtime.client.refreshCursorAccount).not.toHaveBeenCalled();
    expect(runtime.client.loginCursorAccount).not.toHaveBeenCalled();
    expect(view.result.current?.checking.size).toBe(0);
    expect(view.result.current?.accounts?.[0]?.lastCheckedAt).toBe(cursor.lastCheckedAt);
  });

  it("quietly retries a failed startup metadata read and validates the restored account once", async () => {
    const codex = account("codex-a", "codex", "Codex A");
    runtime.client = {
      listProviderAccounts: vi
        .fn<() => Promise<ProviderAccount[]>>()
        .mockRejectedValueOnce(new Error("Runtime starting"))
        .mockResolvedValueOnce([codex]),
      refreshClaudeAccount: vi.fn(),
      refreshCodexAccount: vi.fn(async () => codex),
      refreshGeminiAccount: vi.fn(),
    } as unknown as KalCodeClient;

    const view = renderHook(useOptionalProviderAccountSessions, { wrapper });
    await waitFor(() => expect(view.result.current?.accounts).toEqual([codex]));
    await waitFor(() => expect(view.result.current?.checking.has(codex.id)).toBe(false));
    expect(runtime.client.listProviderAccounts).toHaveBeenCalledTimes(2);
    expect(runtime.client.refreshCodexAccount).toHaveBeenCalledTimes(1);
    expect(view.result.current?.loadError).toBeNull();
  });

  it("cancels a pending metadata retry when the StrictMode provider unmounts", async () => {
    vi.useFakeTimers();
    try {
      const list = vi.fn(async () => {
        throw new Error("Runtime starting");
      });
      runtime.client = {
        listProviderAccounts: list,
        refreshClaudeAccount: vi.fn(),
        refreshCodexAccount: vi.fn(),
        refreshGeminiAccount: vi.fn(),
      } as unknown as KalCodeClient;

      const view = renderHook(useOptionalProviderAccountSessions, { wrapper, reactStrictMode: true });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(list).toHaveBeenCalledTimes(1);

      view.unmount();
      await act(async () => vi.advanceTimersByTimeAsync(1_000));
      expect(list).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores every account before background validation settles and validates once under StrictMode", async () => {
    const claude = account("claude-a", "claude-code", "Claude A");
    const codex = account("codex-a", "codex", "Codex A");
    const codexCheck = deferred<ProviderAccount>();
    runtime.client = {
      listProviderAccounts: vi.fn(async () => [claude, codex]),
      refreshClaudeAccount: vi.fn(),
      refreshCodexAccount: vi.fn(() => codexCheck.promise),
      refreshGeminiAccount: vi.fn(),
    } as unknown as KalCodeClient;

    const view = renderHook(useOptionalProviderAccountSessions, { wrapper, reactStrictMode: true });
    await waitFor(() =>
      expect(view.result.current?.accounts?.map((item) => item.displayName)).toEqual(["Claude A", "Codex A"]),
    );
    await waitFor(() => expect([...(view.result.current?.checking ?? [])]).toEqual(["codex-a"]));
    expect(runtime.client.listProviderAccounts).toHaveBeenCalledTimes(1);
    expect(runtime.client.refreshClaudeAccount).not.toHaveBeenCalled();
    expect(runtime.client.refreshCodexAccount).toHaveBeenCalledTimes(1);
    const unchangedClaude = await view.result.current?.validate(claude);
    expect(unchangedClaude).toEqual(claude);
    expect(runtime.client.refreshClaudeAccount).not.toHaveBeenCalled();
    expect(view.result.current?.checking.has(claude.id)).toBe(false);

    act(() => codexCheck.resolve({ ...codex, lastCheckedAt: "2026-10-02T01:00:00.000Z" }));
    await waitFor(() => expect(view.result.current?.checking.has("codex-a")).toBe(false));
    expect(view.result.current?.accounts?.find((item) => item.id === "claude-a")?.authenticationState).toBe(
      "authenticated",
    );
    expect(view.result.current?.accounts?.find((item) => item.id === "claude-a")?.lastCheckedAt).toBe(
      claude.lastCheckedAt,
    );
  });

  it("bounds startup validation while preserving every restored identity", async () => {
    const accounts = Array.from({ length: 5 }, (_, index) => account(`codex-${index}`, "codex", `Codex ${index + 1}`));
    const checks = new Map(accounts.map((item) => [item.id, deferred<ProviderAccount>()]));
    const refresh = vi.fn((id: string) => {
      const check = checks.get(id);
      if (!check) throw new Error(`Missing check for ${id}`);
      return check.promise;
    });
    runtime.client = {
      listProviderAccounts: vi.fn(async () => accounts),
      refreshClaudeAccount: vi.fn(),
      refreshCodexAccount: refresh,
      refreshGeminiAccount: vi.fn(),
    } as unknown as KalCodeClient;
    const view = renderHook(useOptionalProviderAccountSessions, { wrapper });
    await waitFor(() => expect(view.result.current?.accounts).toHaveLength(5));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(3));

    const first = refresh.mock.calls[0]?.[0];
    if (!first) throw new Error("No validation started");
    const firstAccount = accounts.find((item) => item.id === first);
    if (!firstAccount) throw new Error(`Missing account for ${first}`);
    act(() => checks.get(first)?.resolve(firstAccount));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(4));
  });

  it("keeps a last-known connected session usable when validation has a transient error", async () => {
    const codex = account("codex-a", "codex", "Codex A");
    const check = deferred<ProviderAccount>();
    runtime.client = {
      listProviderAccounts: vi.fn(async () => [codex]),
      refreshClaudeAccount: vi.fn(),
      refreshCodexAccount: vi.fn(() => check.promise),
      refreshGeminiAccount: vi.fn(),
    } as unknown as KalCodeClient;
    const view = renderHook(useOptionalProviderAccountSessions, { wrapper });
    await waitFor(() => expect(view.result.current?.checking.has(codex.id)).toBe(true));

    act(() =>
      check.reject({ category: "provider", code: "network", message: "Provider unavailable", retryable: true }),
    );
    await waitFor(() => expect(view.result.current?.validationErrors.get(codex.id)).toBe("Provider unavailable"));
    expect(view.result.current?.accounts?.[0]?.authenticationState).toBe("authenticated");
    expect(view.result.current?.accounts?.[0]?.providerReportedIdentity).toBe("codex a@example.com");
  });

  it("treats a foreground-preempted validation that returns the safe account as a clean check", async () => {
    const codex = account("codex-a", "codex", "Codex A");
    const check = deferred<ProviderAccount>();
    runtime.client = {
      listProviderAccounts: vi.fn(async () => [codex]),
      refreshClaudeAccount: vi.fn(),
      refreshCodexAccount: vi.fn(() => check.promise),
      refreshGeminiAccount: vi.fn(),
    } as unknown as KalCodeClient;
    const view = renderHook(useOptionalProviderAccountSessions, { wrapper });
    await waitFor(() => expect(view.result.current?.checking.has(codex.id)).toBe(true));

    act(() => check.resolve(codex));
    await waitFor(() => expect(view.result.current?.checking.has(codex.id)).toBe(false));
    expect(view.result.current?.validationErrors.has(codex.id)).toBe(false);
    expect(view.result.current?.accounts?.[0]).toMatchObject({
      id: codex.id,
      authenticationState: "authenticated",
      providerReportedIdentity: codex.providerReportedIdentity,
    });
  });

  it("applies provider-confirmed expiration without probing or changing another account", async () => {
    const codexA = account("codex-a", "codex", "Codex A");
    const codexB = { ...account("codex-b", "codex", "Codex B"), isDefault: false };
    const expiredA = {
      ...codexA,
      displayName: "Stale native label",
      authenticationState: "not_authenticated" as const,
      isDefault: false,
      lastCheckedAt: "2026-10-03T04:00:00.000Z",
      lastErrorCode: "provider_authentication_failed",
    };
    const checkA = deferred<ProviderAccount>();
    const checkB = deferred<ProviderAccount>();
    const list = vi
      .fn<(providerId?: string) => Promise<ProviderAccount[]>>()
      .mockResolvedValueOnce([codexA, codexB])
      .mockResolvedValueOnce([expiredA, codexB]);
    runtime.client = {
      listProviderAccounts: list,
      refreshClaudeAccount: vi.fn(),
      refreshCodexAccount: vi.fn((id: string) => (id === codexA.id ? checkA.promise : checkB.promise)),
      refreshGeminiAccount: vi.fn(),
    } as unknown as KalCodeClient;
    const view = renderHook(useOptionalProviderAccountSessions, { wrapper });
    await waitFor(() => expect(view.result.current?.checking.size).toBe(2));

    act(() =>
      checkB.reject({
        category: "provider",
        code: "network",
        message: "Temporary provider failure",
        retryable: true,
      }),
    );
    await waitFor(() => expect(view.result.current?.validationErrors.has(codexB.id)).toBe(true));
    const unchangedB = view.result.current?.accounts?.find((item) => item.id === codexB.id);
    act(() => {
      runtime.feed?.merge([providerError(1, "codex", "rate_limited")]);
    });
    await Promise.resolve();
    expect(list).toHaveBeenCalledTimes(1);

    act(() => {
      runtime.feed?.merge([providerError(2, "codex", "provider_authentication_failed")]);
    });
    await waitFor(() =>
      expect(view.result.current?.accounts?.find((item) => item.id === codexA.id)?.authenticationState).toBe(
        "not_authenticated",
      ),
    );
    expect(list).toHaveBeenLastCalledWith();
    expect(view.result.current?.checking.has(codexA.id)).toBe(false);
    expect(view.result.current?.accounts?.find((item) => item.id === codexA.id)).toMatchObject({
      displayName: codexA.displayName,
      isDefault: codexA.isDefault,
      authenticationState: "not_authenticated",
      lastErrorCode: "provider_authentication_failed",
    });
    expect(view.result.current?.accounts?.find((item) => item.id === codexB.id)).toBe(unchangedB);
    expect(view.result.current?.validationErrors.has(codexB.id)).toBe(true);

    act(() => checkA.resolve(codexA));
    await Promise.resolve();
    await Promise.resolve();
    expect(view.result.current?.accounts?.find((item) => item.id === codexA.id)?.authenticationState).toBe(
      "not_authenticated",
    );
    expect(runtime.client.refreshCodexAccount).toHaveBeenCalledTimes(2);
  });

  it("reconciles a nonrecoverable headless authentication failure from thread.failed", async () => {
    const claude = account("claude-a", "claude-code", "Claude A");
    const expired = {
      ...claude,
      authenticationState: "not_authenticated" as const,
      lastErrorCode: "api_authentication_failed",
    };
    const list = vi
      .fn<() => Promise<ProviderAccount[]>>()
      .mockResolvedValueOnce([claude])
      .mockResolvedValueOnce([expired]);
    runtime.client = {
      listProviderAccounts: list,
      refreshClaudeAccount: vi.fn(),
      refreshCodexAccount: vi.fn(),
      refreshGeminiAccount: vi.fn(),
    } as unknown as KalCodeClient;
    const view = renderHook(useOptionalProviderAccountSessions, { wrapper });
    await waitFor(() => expect(view.result.current?.accounts).toEqual([claude]));

    act(() => runtime.feed?.merge([threadFailed(1, "api_authentication_failed")]));
    await waitFor(() => expect(view.result.current?.accounts?.[0]?.authenticationState).toBe("not_authenticated"));
    expect(list).toHaveBeenCalledTimes(2);

    act(() => runtime.feed?.merge([threadFailed(2, "turn_failed")]));
    await Promise.resolve();
    expect(list).toHaveBeenCalledTimes(2);
    expect(runtime.client.refreshClaudeAccount).not.toHaveBeenCalled();
  });

  it("reconciles an expiry the native launch persisted when a coding agent fails to start", async () => {
    // A launch that finds the native session gone marks that account not authenticated and fails
    // the agent with `provider_not_authenticated`. Without this reread the account kept showing
    // Connected (no Sign in) and stayed selectable for new agents until KalCode restarted.
    const codex = account("codex-a", "codex", "Codex A");
    const expired = { ...codex, authenticationState: "not_authenticated" as const, providerReportedIdentity: null };
    const list = vi
      .fn<() => Promise<ProviderAccount[]>>()
      .mockResolvedValueOnce([codex])
      .mockResolvedValueOnce([expired]);
    runtime.client = {
      listProviderAccounts: list,
      refreshClaudeAccount: vi.fn(),
      refreshCodexAccount: vi.fn().mockResolvedValue(codex),
      refreshGeminiAccount: vi.fn(),
    } as unknown as KalCodeClient;
    const view = renderHook(useOptionalProviderAccountSessions, { wrapper });
    await waitFor(() => expect(view.result.current?.accounts).toEqual([codex]));
    await waitFor(() => expect(view.result.current?.checking.size).toBe(0));

    act(() => runtime.feed?.merge([threadFailed(1, "provider_not_authenticated")]));
    await waitFor(() => expect(view.result.current?.accounts?.[0]?.authenticationState).toBe("not_authenticated"));
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("coalesces simultaneous provider expirations and retries across metadata mutations", async () => {
    const claude = account("claude-a", "claude-code", "Claude A");
    const codexA = account("codex-a", "codex", "Codex A");
    const codexB = { ...account("codex-b", "codex", "Codex B"), isDefault: false };
    const expiredClaude = {
      ...claude,
      authenticationState: "not_authenticated" as const,
      lastErrorCode: "provider_oauth_org_not_allowed",
    };
    const expiredCodex = {
      ...codexA,
      authenticationState: "not_authenticated" as const,
      lastErrorCode: "api_authentication_failed",
    };
    const eventRead = deferred<ProviderAccount[]>();
    const checkA = deferred<ProviderAccount>();
    const list = vi
      .fn<() => Promise<ProviderAccount[]>>()
      .mockResolvedValueOnce([claude, codexA, codexB])
      .mockReturnValueOnce(eventRead.promise)
      .mockResolvedValueOnce([expiredClaude, expiredCodex, codexB]);
    runtime.client = {
      listProviderAccounts: list,
      refreshClaudeAccount: vi.fn(),
      refreshCodexAccount: vi.fn((id: string) => (id === codexA.id ? checkA.promise : Promise.resolve(codexB))),
      refreshGeminiAccount: vi.fn(),
    } as unknown as KalCodeClient;
    const view = renderHook(useOptionalProviderAccountSessions, { wrapper });
    await waitFor(() => expect(view.result.current?.checking.has(codexA.id)).toBe(true));

    act(() => {
      runtime.feed?.merge([
        providerError(10, "claude-code", "provider_oauth_org_not_allowed"),
        threadFailed(11, "api_authentication_failed"),
      ]);
    });
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    const sessions = view.result.current;
    if (!sessions) throw new Error("Provider account sessions were not mounted");
    act(() => {
      sessions.supersede(claude.id);
      sessions.replace({ ...claude, displayName: "Renamed Claude" });
      sessions.supersede(codexB.id);
      sessions.replace({ ...codexB, isDefault: true });
    });
    act(() => eventRead.resolve([expiredClaude, expiredCodex, codexB]));

    await waitFor(() => expect(list).toHaveBeenCalledTimes(3));
    await waitFor(() => {
      expect(view.result.current?.accounts?.find((item) => item.id === claude.id)).toMatchObject({
        displayName: "Renamed Claude",
        authenticationState: "not_authenticated",
      });
      expect(view.result.current?.accounts?.find((item) => item.id === codexA.id)).toMatchObject({
        isDefault: false,
        authenticationState: "not_authenticated",
      });
      expect(view.result.current?.accounts?.find((item) => item.id === codexB.id)?.isDefault).toBe(true);
    });

    act(() => checkA.resolve(codexA));
    await Promise.resolve();
    await Promise.resolve();
    expect(view.result.current?.accounts?.find((item) => item.id === codexA.id)?.authenticationState).toBe(
      "not_authenticated",
    );
  });

  it("starts a fresh bounded batch when an auth event arrives during the final read attempt", async () => {
    const claude = account("claude-a", "claude-code", "Claude A");
    const expired = {
      ...claude,
      authenticationState: "not_authenticated" as const,
      lastErrorCode: "provider_authentication_failed",
    };
    const finalRead = deferred<ProviderAccount[]>();
    const list = vi
      .fn<() => Promise<ProviderAccount[]>>()
      .mockResolvedValueOnce([claude])
      .mockRejectedValueOnce(new Error("local read failed"))
      .mockRejectedValueOnce(new Error("local read failed"))
      .mockReturnValueOnce(finalRead.promise)
      .mockResolvedValueOnce([expired]);
    runtime.client = {
      listProviderAccounts: list,
      refreshClaudeAccount: vi.fn(),
      refreshCodexAccount: vi.fn(),
      refreshGeminiAccount: vi.fn(),
    } as unknown as KalCodeClient;
    const view = renderHook(useOptionalProviderAccountSessions, { wrapper });
    await waitFor(() => expect(view.result.current?.accounts).toEqual([claude]));

    act(() => runtime.feed?.merge([providerError(1, "claude-code", "provider_authentication_failed")]));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(4));
    act(() => runtime.feed?.merge([providerError(2, "claude-code", "provider_authentication_failed")]));
    act(() => finalRead.resolve([claude]));

    await waitFor(() => expect(list).toHaveBeenCalledTimes(5));
    await waitFor(() => expect(view.result.current?.accounts?.[0]?.authenticationState).toBe("not_authenticated"));
    expect(runtime.client.refreshClaudeAccount).not.toHaveBeenCalled();
  });

  it("does not let an older validation resurrect an account after logout or archive wins", async () => {
    const codex = account("codex-a", "codex", "Codex A");
    const check = deferred<ProviderAccount>();
    runtime.client = {
      listProviderAccounts: vi.fn(async () => [codex]),
      refreshClaudeAccount: vi.fn(),
      refreshCodexAccount: vi.fn(() => check.promise),
      refreshGeminiAccount: vi.fn(),
    } as unknown as KalCodeClient;
    const view = renderHook(useOptionalProviderAccountSessions, { wrapper });
    await waitFor(() => expect(view.result.current?.checking.has(codex.id)).toBe(true));

    act(() => {
      view.result.current?.supersede(codex.id);
      view.result.current?.replace({ ...codex, authenticationState: "not_authenticated", archivedAt: null });
    });
    act(() => check.resolve(codex));
    await waitFor(() => expect(view.result.current?.checking.has(codex.id)).toBe(false));
    expect(view.result.current?.accounts?.[0]?.authenticationState).toBe("not_authenticated");

    act(() => {
      view.result.current?.replace({ ...codex, archivedAt: "2026-10-02T02:00:00.000Z" });
    });
    expect(view.result.current?.accounts).toEqual([]);
  });

  it("marks a session expired only after a successful check confirms sign-in is gone", async () => {
    const codex = account("codex-a", "codex", "Codex A");
    const expired = { ...codex, authenticationState: "not_authenticated" as const };
    runtime.client = {
      listProviderAccounts: vi.fn(async () => [codex]),
      refreshClaudeAccount: vi.fn(),
      refreshCodexAccount: vi.fn(async () => expired),
      refreshGeminiAccount: vi.fn(),
    } as unknown as KalCodeClient;
    const view = renderHook(useOptionalProviderAccountSessions, { wrapper });
    await waitFor(() => expect(view.result.current?.accounts?.[0]?.authenticationState).toBe("not_authenticated"));
    expect(view.result.current?.validationErrors.size).toBe(0);
  });

  it("does not let an older list overwrite a newer default-account mutation", async () => {
    const claudeA = account("claude-a", "claude-code", "Claude A");
    const claudeB = { ...account("claude-b", "claude-code", "Claude B"), isDefault: false };
    const staleList = deferred<ProviderAccount[]>();
    const list = vi.fn().mockResolvedValueOnce([claudeA, claudeB]).mockReturnValueOnce(staleList.promise);
    runtime.client = {
      listProviderAccounts: list,
      refreshClaudeAccount: vi.fn(async (id: string) => (id === claudeA.id ? claudeA : claudeB)),
      refreshCodexAccount: vi.fn(),
      refreshGeminiAccount: vi.fn(),
    } as unknown as KalCodeClient;
    const view = renderHook(useOptionalProviderAccountSessions, { wrapper });
    await waitFor(() => expect(view.result.current?.accounts).toHaveLength(2));

    const sessions = view.result.current;
    if (!sessions) throw new Error("Provider account sessions were not mounted");
    let reload = Promise.resolve<ProviderAccount[] | null>(null);
    act(() => {
      reload = sessions.reload();
      sessions.supersede(claudeB.id);
      sessions.replace({ ...claudeB, isDefault: true });
    });
    act(() => staleList.resolve([claudeA, claudeB]));
    await reload;
    expect(view.result.current?.accounts?.find((item) => item.id === claudeB.id)?.isDefault).toBe(true);
    expect(view.result.current?.accounts?.find((item) => item.id === claudeA.id)?.isDefault).toBe(false);
  });

  it("merges validation facts without reverting a default-account change on another account", async () => {
    const codexA = account("codex-a", "codex", "Codex A");
    const codexB = { ...account("codex-b", "codex", "Codex B"), isDefault: false };
    const checkA = deferred<ProviderAccount>();
    const checkB = deferred<ProviderAccount>();
    runtime.client = {
      listProviderAccounts: vi.fn(async () => [codexA, codexB]),
      refreshClaudeAccount: vi.fn(),
      refreshCodexAccount: vi.fn((id: string) => (id === codexA.id ? checkA.promise : checkB.promise)),
      refreshGeminiAccount: vi.fn(),
    } as unknown as KalCodeClient;
    const view = renderHook(useOptionalProviderAccountSessions, { wrapper });
    await waitFor(() => expect(view.result.current?.checking.size).toBe(2));
    const sessions = view.result.current;
    if (!sessions) throw new Error("Provider account sessions were not mounted");

    act(() => {
      sessions.supersede(codexB.id);
      sessions.replace({ ...codexB, isDefault: true });
    });
    act(() => checkA.resolve({ ...codexA, isDefault: true, lastCheckedAt: "2026-10-03T00:00:00.000Z" }));
    await waitFor(() => expect(view.result.current?.checking.has(codexA.id)).toBe(false));
    expect(view.result.current?.accounts?.find((item) => item.id === codexA.id)?.isDefault).toBe(false);
    expect(view.result.current?.accounts?.find((item) => item.id === codexB.id)?.isDefault).toBe(true);
  });

  it("drops a previous runtime client's late restore and validation work", async () => {
    const oldAccount = account("claude-a", "claude-code", "Old");
    const newAccount = account("codex-a", "codex", "New");
    const oldList = deferred<ProviderAccount[]>();
    const oldRefresh = vi.fn(async () => oldAccount);
    runtime.client = {
      listProviderAccounts: vi.fn(() => oldList.promise),
      refreshClaudeAccount: oldRefresh,
      refreshCodexAccount: vi.fn(),
      refreshGeminiAccount: vi.fn(),
    } as unknown as KalCodeClient;
    const view = renderHook(useOptionalProviderAccountSessions, { wrapper });

    runtime.client = {
      listProviderAccounts: vi.fn(async () => [newAccount]),
      refreshClaudeAccount: vi.fn(),
      refreshCodexAccount: vi.fn(async () => newAccount),
      refreshGeminiAccount: vi.fn(),
    } as unknown as KalCodeClient;
    view.rerender();
    await waitFor(() => expect(view.result.current?.accounts?.map((item) => item.displayName)).toEqual(["New"]));

    act(() => oldList.resolve([oldAccount]));
    await waitFor(() => expect(view.result.current?.accounts?.map((item) => item.displayName)).toEqual(["New"]));
    expect(oldRefresh).not.toHaveBeenCalled();
  });

  it("drops a validation that started under a previous runtime client", async () => {
    const oldAccount = account("codex-a", "codex", "Old");
    const oldCheck = deferred<ProviderAccount>();
    const oldClient = {
      listProviderAccounts: vi.fn(async () => [oldAccount]),
      refreshClaudeAccount: vi.fn(),
      refreshCodexAccount: vi.fn(() => oldCheck.promise),
      refreshGeminiAccount: vi.fn(),
    } as unknown as KalCodeClient;
    runtime.client = oldClient;
    const view = renderHook(useOptionalProviderAccountSessions, { wrapper });
    await waitFor(() => expect(view.result.current?.checking.has(oldAccount.id)).toBe(true));

    const newAccount = {
      ...oldAccount,
      displayName: "New",
      authenticationState: "not_authenticated" as const,
    };
    runtime.client = {
      listProviderAccounts: vi.fn(async () => [newAccount]),
      refreshClaudeAccount: vi.fn(),
      refreshCodexAccount: vi.fn(async () => newAccount),
      refreshGeminiAccount: vi.fn(),
    } as unknown as KalCodeClient;
    view.rerender();
    await waitFor(() => expect(view.result.current?.accounts?.[0]).toMatchObject(newAccount));

    act(() => oldCheck.resolve(oldAccount));
    await Promise.resolve();
    await Promise.resolve();
    expect(view.result.current?.accounts?.[0]).toMatchObject(newAccount);
  });

  it("does not validate a restore that completes after unmount", async () => {
    const claude = account("claude-a", "claude-code", "Claude A");
    const list = deferred<ProviderAccount[]>();
    const refresh = vi.fn(async () => claude);
    runtime.client = {
      listProviderAccounts: vi.fn(() => list.promise),
      refreshClaudeAccount: refresh,
      refreshCodexAccount: vi.fn(),
      refreshGeminiAccount: vi.fn(),
    } as unknown as KalCodeClient;
    const view = renderHook(useOptionalProviderAccountSessions, { wrapper });
    view.unmount();
    list.resolve([claude]);
    await Promise.resolve();
    await Promise.resolve();
    expect(refresh).not.toHaveBeenCalled();
  });
});
