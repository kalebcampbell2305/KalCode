import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AccountSnapshot, AccountUsageSnapshot } from "../../ipc/account.ts";
import { SettingsAccountView } from "./SettingsAccount.tsx";

const account: AccountSnapshot = {
  phase: "ready",
  account: { id: "acct_01", email: "owner@example.com", activatedAt: "2026-09-25T12:00:00Z" },
  tier: "pro",
  sessionExpiresAt: "2026-10-25T12:00:00Z",
  entitlementExpiresAt: 1_800_000_000,
  offlineGraceUntil: null,
  pendingEmail: null,
  pendingExpiresAt: null,
  degradedReason: null,
};
const usage: AccountUsageSnapshot = {
  used: 240,
  allowance: 1_500,
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
    expect(screen.getByText("240 of 1,500 requests used")).toBeInTheDocument();
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
});
