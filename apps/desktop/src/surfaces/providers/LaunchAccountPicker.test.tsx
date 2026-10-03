import type { ProviderAccount } from "@kalcode/protocol";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { LaunchAccountPicker } from "./LaunchAccountPicker.tsx";

const auth = vi.hoisted(() => ({
  create: vi.fn(),
  signInAuth: vi.fn(),
  cancelLogin: vi.fn(),
  busyKey: null,
  activeLogin: null,
}));
vi.mock("./useProviderAccounts.ts", () => ({
  isBrowserAuthProvider: () => true,
  useProviderAccounts: () => auth,
}));
vi.mock("./ProviderAccountSessions.tsx", () => ({ useOptionalProviderAccountSessions: () => null }));

const account = {
  id: "work",
  providerId: "codex",
  displayName: "Work",
  isDefault: true,
  authenticationState: "not_authenticated",
  archivedAt: null,
} as ProviderAccount;

describe("launch account recovery", () => {
  it("clears sign-in busy state if an account-load error removes inline authentication", async () => {
    let finish!: () => void;
    auth.signInAuth.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const onBusyChange = vi.fn();
    const props = {
      providerId: "codex",
      providerName: "Codex",
      accounts: [account],
      value: account.id,
      onChange: vi.fn(),
      onReload: vi.fn(async () => undefined),
      onBusyChange,
    };
    const view = render(<LaunchAccountPicker {...props} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Sign in to Work" }));
    await waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(true));
    view.rerender(<LaunchAccountPicker {...props} error="Account registry unavailable" />);
    await waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(false));
    expect(screen.getByRole("alert")).toHaveTextContent("Accounts unavailable");
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
    await act(async () => {
      finish();
    });
  });

  it("catches retry failures and leaves recovery available", async () => {
    const onReload = vi.fn(async () => {
      throw {
        category: "internal",
        code: "accounts_unavailable",
        message: "Account registry is unavailable",
        retryable: true,
      };
    });
    render(
      <LaunchAccountPicker
        providerId="codex"
        providerName="Codex"
        accounts={null}
        value=""
        onChange={vi.fn()}
        onReload={onReload}
        error="Accounts unavailable"
      />,
    );
    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled());
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Account registry is unavailable")).toBeVisible();
  });
});
