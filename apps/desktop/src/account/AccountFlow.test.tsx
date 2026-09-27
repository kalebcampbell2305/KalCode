import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountClient, type AccountSnapshot, type RuntimeStatus } from "../ipc/account.ts";
import { createAccountMemory } from "../ipc/accountMemory.ts";
import { ConnectedAccountGate } from "./AccountGate.tsx";
import { type AccountOperations, AccountProvider, useAccount } from "./AccountProvider.tsx";

function snapshot(phase: "bootstrapping" | "ready"): AccountSnapshot {
  return {
    phase,
    account:
      phase === "ready" ? { id: "acct_01", email: "owner@example.com", activatedAt: "2026-09-25T12:00:00Z" } : null,
    tier: phase === "ready" ? "pro" : null,
    sessionExpiresAt: phase === "ready" ? "2026-10-25T12:00:00Z" : null,
    entitlementExpiresAt: phase === "ready" ? 1_800_000_000 : null,
    offlineGraceUntil: null,
    pendingEmail: null,
    pendingExpiresAt: null,
    degradedReason: null,
  };
}

function runtime(phase: "starting" | "ready"): RuntimeStatus {
  return { phase, ready: phase === "ready" };
}

function Workspace() {
  const { actions } = useAccount();
  return (
    <section aria-label="Workspace">
      <h1>Workspace ready</h1>
      <button type="button" onClick={() => void actions.logout()}>
        Sign out here
      </button>
    </section>
  );
}

async function completeFreeOnboarding(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Continue with email" }));
  await user.type(screen.getByLabelText("Email"), "owner@example.com");
  await user.click(screen.getByRole("button", { name: "Email me a sign-in link" }));
  expect(await screen.findByRole("heading", { name: "Check your email" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "I've verified my email" }));
  expect(await screen.findByRole("heading", { name: "Choose your plan" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Continue with Free" }));
  expect(await screen.findByRole("heading", { name: "Workspace ready" })).toBeInTheDocument();
}

afterEach(() => vi.useRealTimers());

describe("account onboarding integration", () => {
  it("opens the connected gate after the real AccountClient adapter observes cold bootstrap completion", async () => {
    vi.useFakeTimers();
    let accountReads = 0;
    let runtimeReads = 0;
    const invoke = vi.fn(async (command: string) => {
      switch (command) {
        case "account_status":
          accountReads += 1;
          return snapshot(accountReads === 1 ? "bootstrapping" : "ready");
        case "runtime_status":
          runtimeReads += 1;
          return runtime(runtimeReads === 1 ? "starting" : "ready");
        case "account_usage":
          return { used: 0, allowance: 1_500, periodStart: "2026-09-01T00:00:00Z", resetsAt: "2026-10-01T00:00:00Z" };
        default:
          throw new Error(`Unexpected account IPC command: ${command}`);
      }
    });
    const client = new AccountClient({ invoke });

    render(
      <AccountProvider client={client} runtimePollMs={10}>
        <ConnectedAccountGate>
          <Workspace />
        </ConnectedAccountGate>
      </AccountProvider>,
    );

    await act(async () => undefined);
    expect(screen.getByRole("heading", { name: "Restoring your session" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Workspace" })).toBeNull();

    await act(async () => vi.advanceTimersByTimeAsync(10));
    expect(screen.getByRole("heading", { name: "Workspace ready" })).toBeInTheDocument();
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      "account_status",
      "runtime_status",
      "account_status",
      "runtime_status",
      "account_usage",
    ]);
  });

  it("onboards, revokes the workspace on logout, and permits a clean relogin", async () => {
    const memory = createAccountMemory("fresh");
    const client = new AccountClient({ invoke: (command, args) => memory.handlers[command](args) });
    const user = userEvent.setup();
    render(
      <AccountProvider client={client}>
        <ConnectedAccountGate>
          <Workspace />
        </ConnectedAccountGate>
      </AccountProvider>,
    );

    expect(await screen.findByRole("heading", { name: "Welcome to KalCode" })).toBeInTheDocument();
    await completeFreeOnboarding(user);
    await user.click(screen.getByRole("button", { name: "Sign out here" }));
    expect(await screen.findByRole("heading", { name: "Welcome to KalCode" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Workspace" })).toBeNull();
    await completeFreeOnboarding(user);
    expect(memory.effects).toEqual({ emails: 0, checkouts: 0, browserOpens: 0 });
  });

  it("keeps the workspace locked and shows a redacted native error", async () => {
    const signedOut: AccountSnapshot = {
      phase: "signed_out",
      account: null,
      tier: null,
      sessionExpiresAt: null,
      entitlementExpiresAt: null,
      offlineGraceUntil: null,
      pendingEmail: null,
      pendingExpiresAt: null,
      degradedReason: null,
    };
    const client: AccountOperations = {
      status: vi.fn(async () => signedOut),
      runtimeStatus: vi.fn<() => Promise<RuntimeStatus>>(async () => ({ phase: "signed_out", ready: false })),
      startEmail: vi.fn(async () => {
        throw { code: "service_unavailable", message: "Account service is unavailable.", retryable: true };
      }),
      startSocial: vi.fn(async () => signedOut),
      pollEmail: vi.fn(async () => signedOut),
      cancelAuth: vi.fn(async () => signedOut),
      activateFree: vi.fn(async () => signedOut),
      checkout: vi.fn(async () => signedOut),
      portal: vi.fn(async () => ({ opened: true as const })),
      refresh: vi.fn(async () => signedOut),
      logout: vi.fn(async () => signedOut),
      usage: vi.fn(async () => null),
    };
    const user = userEvent.setup();
    render(
      <AccountProvider client={client}>
        <ConnectedAccountGate>
          <Workspace />
        </ConnectedAccountGate>
      </AccountProvider>,
    );
    await user.click(await screen.findByRole("button", { name: "Continue with email" }));
    await user.type(screen.getByLabelText("Email"), "owner@example.com");
    await user.click(screen.getByRole("button", { name: "Email me a sign-in link" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Account service is unavailable.");
    expect(screen.queryByRole("region", { name: "Workspace" })).toBeNull();
    expect(document.body.textContent).not.toMatch(/token|secret|verifier|receipt/i);
  });
});
