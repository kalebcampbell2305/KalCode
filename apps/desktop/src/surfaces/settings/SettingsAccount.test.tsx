import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { type AccountOperations, AccountProvider } from "../../account/AccountProvider.tsx";
import type { AccountSnapshot, AccountUsageSnapshot, RuntimeStatus } from "../../ipc/account.ts";
import { SettingsAccount, SettingsAccountView } from "./SettingsAccount.tsx";

const account: AccountSnapshot = {
  phase: "ready",
  account: { id: "acct_01", email: "owner@example.com", activatedAt: "2026-09-25T12:00:00Z", displayName: null },
  tier: "pro",
  sessionExpiresAt: "2026-10-25T12:00:00Z",
  entitlementExpiresAt: 1_800_000_000,
  offlineGraceUntil: null,
  pendingEmail: null,
  pendingExpiresAt: null,
  degradedReason: null,
};
const usage: AccountUsageSnapshot = {
  used: 40,
  allowance: 150,
  periodStart: "2026-09-01T00:00:00Z",
  resetsAt: "2026-10-01T00:00:00Z",
};

describe("SettingsAccountView", () => {
  it("shows only public identity, verified plan, and usage", () => {
    render(
      <SettingsAccountView
        account={account}
        usage={usage}
        busy={false}
        error={null}
        onManage={vi.fn()}
        onLogout={vi.fn()}
      />,
    );
    expect(screen.getByRole("region", { name: "KalCode account" })).toHaveTextContent("owner@example.com");
    expect(screen.getByText("Pro")).toBeInTheDocument();
    expect(screen.getByText("110 remaining · 40 / 150 used · resets Oct 1")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/token|receipt|verifier|acct_01/i);
  });

  it("uses the governed native actions for plan management and logout", async () => {
    const onManage = vi.fn(async () => undefined);
    const onLogout = vi.fn(async () => undefined);
    render(
      <SettingsAccountView
        account={account}
        usage={usage}
        busy={false}
        error={null}
        onManage={onManage}
        onLogout={onLogout}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Manage plan" }));
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(onManage).toHaveBeenCalledOnce();
    expect(onLogout).toHaveBeenCalledOnce();
  });

  it("shows a Free plan where to compare paid plans, without a portal button", () => {
    render(
      <SettingsAccountView
        account={{ ...account, tier: "free" }}
        usage={{ ...usage, allowance: 75 }}
        busy={false}
        error={null}
        onManage={vi.fn()}
        onLogout={vi.fn()}
      />,
    );
    expect(screen.getByText("Free")).toBeInTheDocument();
    // Plan names come from the canonical catalog (packages/protocol/src/plans.ts), never hand-typed.
    expect(screen.getByText(/No subscription\. Pro, MAX and MAX 2X add more/)).toHaveTextContent(
      "kalcoded.com/pricing",
    );
    expect(screen.queryByRole("button", { name: "Manage plan" })).not.toBeInTheDocument();
  });

  it("shows OWNER as unlimited private access without subscription billing", () => {
    render(
      <SettingsAccountView
        account={{ ...account, tier: "owner" }}
        usage={{ ...usage, allowance: null }}
        busy={false}
        error={null}
        onManage={vi.fn()}
        onLogout={vi.fn()}
      />,
    );
    expect(screen.getByText("Owner")).toBeInTheDocument();
    expect(screen.getByText("Unlimited requests")).toBeInTheDocument();
    expect(screen.getByText("No subscription payment required")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Manage plan" })).not.toBeInTheDocument();
  });
});

describe("SettingsAccount", () => {
  it("reads fresh usage when it opens, so requests used this session show", async () => {
    const usageCall = vi
      .fn<() => Promise<AccountUsageSnapshot | null>>()
      .mockResolvedValueOnce(usage)
      .mockResolvedValue({ ...usage, used: 45 });
    const client = {
      status: vi.fn(async () => account),
      runtimeStatus: vi.fn<() => Promise<RuntimeStatus>>(async () => ({ phase: "ready", ready: true })),
      usage: usageCall,
    } as unknown as AccountOperations;
    function Harness() {
      const [open, setOpen] = useState(false);
      return open ? (
        <SettingsAccount />
      ) : (
        <button type="button" onClick={() => setOpen(true)}>
          Open settings
        </button>
      );
    }
    render(
      <AccountProvider client={client}>
        <Harness />
      </AccountProvider>,
    );
    await waitFor(() => expect(usageCall).toHaveBeenCalledOnce());
    await userEvent.click(screen.getByRole("button", { name: "Open settings" }));
    expect(await screen.findByText("105 remaining · 45 / 150 used · resets Oct 1")).toBeInTheDocument();
    expect(usageCall).toHaveBeenCalledTimes(2);
  });
});
