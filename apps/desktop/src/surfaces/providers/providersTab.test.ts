import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  consumeProviderAccountsRequest,
  consumeProvidersTab,
  openProviderAccounts,
  useOpenProviderAccounts,
  useProviderAccountsRequest,
  useProvidersTabRequest,
} from "./providersTab.ts";

const navigate = vi.hoisted(() => vi.fn());
vi.mock("../../shell/navigation.tsx", () => ({ useNavigation: () => ({ navigate }) }));

afterEach(() => navigate.mockReset());

describe("openProviderAccounts", () => {
  it("requests the Accounts tab and records the provider and connect intent until consumed", () => {
    const tab = renderHook(() => useProvidersTabRequest());
    const accounts = renderHook(() => useProviderAccountsRequest());
    act(() => openProviderAccounts({ providerId: "gemini-cli", connect: true }));
    expect(tab.result.current?.tab).toBe("accounts");
    expect(accounts.result.current).toMatchObject({ providerId: "gemini-cli", connect: true });

    const nonce = accounts.result.current?.nonce ?? -1;
    act(() => consumeProviderAccountsRequest(nonce + 1000));
    expect(accounts.result.current?.nonce).toBe(nonce);
    act(() => consumeProviderAccountsRequest(nonce));
    expect(accounts.result.current).toBeNull();
    act(() => consumeProvidersTab(tab.result.current?.nonce ?? -1));
    expect(tab.result.current).toBeNull();
  });

  it("defaults connect to false", () => {
    const accounts = renderHook(() => useProviderAccountsRequest());
    act(() => openProviderAccounts({ providerId: "codex" }));
    expect(accounts.result.current).toMatchObject({ providerId: "codex", connect: false });
    act(() => consumeProviderAccountsRequest(accounts.result.current?.nonce ?? -1));
  });

  it("useOpenProviderAccounts records the request and navigates to Providers", () => {
    const open = renderHook(() => useOpenProviderAccounts());
    const accounts = renderHook(() => useProviderAccountsRequest());
    act(() => open.result.current({ providerId: "claude-code", connect: true }));
    expect(navigate).toHaveBeenCalledWith("providers");
    expect(accounts.result.current).toMatchObject({ providerId: "claude-code", connect: true });
    act(() => consumeProviderAccountsRequest(accounts.result.current?.nonce ?? -1));
  });
});
