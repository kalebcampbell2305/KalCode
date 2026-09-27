import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountSnapshot, RuntimeStatus } from "../ipc/account.ts";
import {
  type AccountOperations,
  AccountProvider,
  MAX_CONFIRMATION_POLLS,
  MAX_RUNTIME_STATUS_POLLS,
  type SocialProvider,
  useAccount,
} from "./AccountProvider.tsx";

function snapshot(phase: AccountSnapshot["phase"]): AccountSnapshot {
  const identified = ["authenticated_unactivated", "confirming_plan", "ready"].includes(phase);
  return {
    phase,
    account: identified
      ? { id: "acct_01", email: "owner@example.com", activatedAt: phase === "ready" ? "2026-09-25T12:00:00Z" : null }
      : null,
    tier: phase === "ready" ? "pro" : null,
    sessionExpiresAt: identified ? "2026-10-25T12:00:00Z" : null,
    entitlementExpiresAt: phase === "ready" ? 1_800_000_000 : null,
    offlineGraceUntil: null,
    pendingEmail: phase === "email_pending" ? "owner@example.com" : null,
    pendingExpiresAt: ["email_pending", "social_pending"].includes(phase) ? "2026-09-25T12:10:00Z" : null,
    degradedReason: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function operations(overrides: Partial<AccountOperations> = {}): AccountOperations {
  return {
    status: vi.fn(async () => snapshot("signed_out")),
    runtimeStatus: vi.fn<() => Promise<RuntimeStatus>>(async () => ({ phase: "signed_out", ready: false })),
    retryRuntime: vi.fn(async () => undefined),
    startEmail: vi.fn(async () => snapshot("email_pending")),
    startSocial: vi.fn<(provider: SocialProvider) => Promise<AccountSnapshot>>(async () => snapshot("social_pending")),
    pollEmail: vi.fn(async () => snapshot("authenticated_unactivated")),
    cancelAuth: vi.fn(async () => snapshot("signed_out")),
    activateFree: vi.fn(async () => snapshot("ready")),
    checkout: vi.fn(async () => snapshot("confirming_plan")),
    portal: vi.fn(async () => ({ opened: true as const })),
    refresh: vi.fn(async () => snapshot("ready")),
    logout: vi.fn(async () => snapshot("signed_out")),
    usage: vi.fn(async () => null),
    ...overrides,
  };
}

function Harness() {
  const account = useAccount();
  return (
    <div>
      <output aria-label="phase">{account.snapshot.phase}</output>
      <output aria-label="runtime">{account.runtime.phase}</output>
      <output aria-label="error">{account.error?.code ?? "none"}</output>
      <button type="button" onClick={() => void account.actions.startEmail("owner@example.com")}>
        start
      </button>
      <button type="button" onClick={() => void account.actions.startSocial("google")}>
        social
      </button>
      <button type="button" onClick={() => void account.actions.logout()}>
        logout
      </button>
      <button type="button" onClick={() => void account.actions.checkout("pro")}>
        checkout
      </button>
    </div>
  );
}

afterEach(() => vi.useRealTimers());

describe("AccountProvider", () => {
  it("refreshes account authority when persisted-session bootstrap finishes after the UI mounts", async () => {
    vi.useFakeTimers();
    const status = vi
      .fn<() => Promise<AccountSnapshot>>()
      .mockResolvedValueOnce(snapshot("bootstrapping"))
      .mockResolvedValue(snapshot("ready"));
    const runtimeStatus = vi
      .fn<() => Promise<RuntimeStatus>>()
      .mockResolvedValueOnce({ phase: "starting", ready: false })
      .mockResolvedValue({ phase: "ready", ready: true });
    const client = operations({ status, runtimeStatus });
    render(
      <AccountProvider client={client} runtimePollMs={10}>
        <Harness />
      </AccountProvider>,
    );
    await act(async () => undefined);
    expect(screen.getByLabelText("phase")).toHaveTextContent("bootstrapping");
    await act(async () => vi.advanceTimersByTimeAsync(20));
    expect(screen.getByLabelText("phase")).toHaveTextContent("ready");
    expect(client.startSocial).not.toHaveBeenCalled();
    expect(client.startEmail).not.toHaveBeenCalled();
  });

  it("boots from account and runtime authority without deriving a local plan", async () => {
    const client = operations({
      status: vi.fn(async () => snapshot("ready")),
      runtimeStatus: vi.fn<() => Promise<RuntimeStatus>>(async () => ({ phase: "ready", ready: true })),
    });
    render(
      <AccountProvider client={client}>
        <Harness />
      </AccountProvider>,
    );
    await waitFor(() => expect(screen.getByLabelText("phase")).toHaveTextContent("ready"));
    expect(client.status).toHaveBeenCalledOnce();
    expect(client.runtimeStatus).toHaveBeenCalledOnce();
  });

  it("does not stop observing bootstrap just because the workspace is initially signed out", async () => {
    vi.useFakeTimers();
    const status = vi
      .fn<() => Promise<AccountSnapshot>>()
      .mockResolvedValueOnce(snapshot("bootstrapping"))
      .mockResolvedValueOnce(snapshot("bootstrapping"))
      .mockResolvedValue(snapshot("signed_out"));
    render(
      <AccountProvider client={operations({ status })} runtimePollMs={10}>
        <Harness />
      </AccountProvider>,
    );
    await act(async () => vi.advanceTimersByTimeAsync(20));
    expect(status).toHaveBeenCalledTimes(3);
    expect(screen.getByLabelText("phase")).toHaveTextContent("signed_out");
  });

  it("continues restored social attempts through canonical status into ready", async () => {
    vi.useFakeTimers();
    const status = vi
      .fn<() => Promise<AccountSnapshot>>()
      .mockResolvedValueOnce(snapshot("bootstrapping"))
      .mockResolvedValueOnce(snapshot("social_pending"))
      .mockResolvedValue(snapshot("ready"));
    const runtimeStatus = vi
      .fn<() => Promise<RuntimeStatus>>()
      .mockResolvedValueOnce({ phase: "starting", ready: false })
      .mockResolvedValueOnce({ phase: "signed_out", ready: false })
      .mockResolvedValue({ phase: "ready", ready: true });
    render(
      <AccountProvider client={operations({ status, runtimeStatus })} runtimePollMs={10} socialStatusPollMs={10}>
        <Harness />
      </AccountProvider>,
    );
    await act(async () => vi.advanceTimersByTimeAsync(20));
    expect(screen.getByLabelText("phase")).toHaveTextContent("ready");
  });

  it("does not resurrect an account from an in-flight bootstrap status after logout", async () => {
    vi.useFakeTimers();
    const pending = deferred<AccountSnapshot>();
    const status = vi
      .fn<() => Promise<AccountSnapshot>>()
      .mockResolvedValueOnce(snapshot("bootstrapping"))
      .mockImplementationOnce(() => pending.promise);
    render(
      <AccountProvider client={operations({ status })} runtimePollMs={10}>
        <Harness />
      </AccountProvider>,
    );
    await act(async () => vi.advanceTimersByTimeAsync(10));
    await act(async () => screen.getByRole("button", { name: "logout" }).click());
    await act(async () => pending.resolve(snapshot("ready")));
    expect(screen.getByLabelText("phase")).toHaveTextContent("signed_out");
  });

  it("bounds bootstrap observation and reports a recoverable error without inventing authority", async () => {
    vi.useFakeTimers();
    const status = vi.fn(async () => snapshot("bootstrapping"));
    render(
      <AccountProvider client={operations({ status })} runtimePollMs={10}>
        <Harness />
      </AccountProvider>,
    );
    await act(async () => vi.runAllTimersAsync());
    expect(status).toHaveBeenCalledTimes(MAX_RUNTIME_STATUS_POLLS + 1);
    expect(screen.getByLabelText("phase")).toHaveTextContent("bootstrapping");
    expect(screen.getByLabelText("error")).toHaveTextContent("account_bootstrap_timeout");
  });

  it("generation-fences late account and runtime results after logout", async () => {
    const email = deferred<AccountSnapshot>();
    const oldRuntime = deferred<RuntimeStatus>();
    const runtimeStatus = vi
      .fn<() => Promise<RuntimeStatus>>()
      .mockResolvedValueOnce({ phase: "signed_out", ready: false })
      .mockImplementationOnce(() => oldRuntime.promise)
      .mockResolvedValue({ phase: "signed_out", ready: false });
    const client = operations({ startEmail: vi.fn(() => email.promise), runtimeStatus });
    render(
      <AccountProvider client={client}>
        <Harness />
      </AccountProvider>,
    );
    await waitFor(() => expect(screen.getByLabelText("phase")).toHaveTextContent("signed_out"));
    await userEvent.click(screen.getByRole("button", { name: "start" }));
    await act(async () => email.resolve(snapshot("email_pending")));
    await userEvent.click(screen.getByRole("button", { name: "logout" }));
    expect(screen.getByLabelText("phase")).toHaveTextContent("signed_out");
    await act(async () => oldRuntime.resolve({ phase: "ready", ready: true }));
    expect(screen.getByLabelText("phase")).toHaveTextContent("signed_out");
    expect(screen.getByLabelText("runtime")).toHaveTextContent("signed_out");
  });

  it("polls a starting runtime until it becomes ready", async () => {
    vi.useFakeTimers();
    const runtimeStatus = vi
      .fn<() => Promise<RuntimeStatus>>()
      .mockResolvedValueOnce({ phase: "starting", ready: false })
      .mockResolvedValueOnce({ phase: "ready", ready: true });
    const client = operations({ status: vi.fn(async () => snapshot("ready")), runtimeStatus });
    render(
      <AccountProvider client={client} runtimePollMs={10}>
        <Harness />
      </AccountProvider>,
    );
    await act(async () => undefined);
    expect(screen.getByLabelText("runtime")).toHaveTextContent("starting");
    await act(async () => vi.advanceTimersByTimeAsync(10));
    expect(screen.getByLabelText("runtime")).toHaveTextContent("ready");
  });

  it("polls checkout confirmation only to the native bounded limit", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn(async () => snapshot("confirming_plan"));
    const client = operations({ refresh });
    render(
      <AccountProvider client={client} confirmationPollMs={10}>
        <Harness />
      </AccountProvider>,
    );
    await act(async () => undefined);
    screen.getByRole("button", { name: "checkout" }).click();
    await act(async () => vi.runAllTimersAsync());
    expect(refresh).toHaveBeenCalledTimes(MAX_CONFIRMATION_POLLS);
    expect(screen.getByLabelText("phase")).toHaveTextContent("confirming_plan");
    expect(screen.getByLabelText("error")).toHaveTextContent("plan_confirmation_timeout");
  });

  it("polls native status after browser handoff and converges on the completed account", async () => {
    vi.useFakeTimers();
    const status = vi
      .fn<() => Promise<AccountSnapshot>>()
      .mockResolvedValueOnce(snapshot("signed_out"))
      .mockResolvedValueOnce(snapshot("social_pending"))
      .mockResolvedValueOnce(snapshot("authenticated_unactivated"));
    const client = operations({ status });
    render(
      <AccountProvider client={client} socialStatusPollMs={10}>
        <Harness />
      </AccountProvider>,
    );
    await act(async () => undefined);
    screen.getByRole("button", { name: "social" }).click();
    await act(async () => undefined);
    expect(screen.getByLabelText("phase")).toHaveTextContent("social_pending");
    await act(async () => vi.advanceTimersByTimeAsync(20));
    expect(screen.getByLabelText("phase")).toHaveTextContent("authenticated_unactivated");
    expect(status).toHaveBeenCalledTimes(3);
  });
});
