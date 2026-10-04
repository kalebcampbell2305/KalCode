import type { ProviderAccount, ThreadSummary } from "@kalcode/protocol";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import type { AccountUsageState } from "../../providers/accountUsage.ts";
import { PaneAccountSuggestion } from "./PaneAccountSuggestion.tsx";

const state = vi.hoisted(() => ({
  accounts: [] as ProviderAccount[],
  usage: new Map<string, AccountUsageState>(),
  checking: new Set<string>(),
  validationErrors: new Map<string, string>(),
  loadError: null as string | null,
  reload: vi.fn(async () => []),
  refreshUsage: vi.fn(),
  setDefault: vi.fn(),
}));
vi.mock("../../providers/ProviderAccountSessions.tsx", () => ({ useOptionalProviderAccountSessions: () => state }));
vi.mock("../../../runtime/RuntimeProvider.tsx", () => ({
  useRuntime: () => ({ client: { setDefaultProviderAccount: state.setDefault } }),
}));
const thread = {
  id: "source",
  providerId: "codex",
  providerName: "Codex",
  providerAccountId: "a",
  archivedAt: null,
  permissionMode: "plan",
  model: "gpt-5.3-codex",
} as ThreadSummary;
const account = (id: string): ProviderAccount =>
  ({
    id,
    providerId: "codex",
    displayName: id.toUpperCase(),
    authenticationState: "authenticated",
    isDefault: false,
    lastErrorCode: null,
    archivedAt: null,
  }) as ProviderAccount;
beforeEach(() => {
  vi.clearAllMocks();
  state.accounts = [{ ...account("a"), authenticationState: "not_authenticated" }, account("b")];
  state.loadError = null;
});

it("offers advice without launching, previews on click, and starts only on explicit confirmation", async () => {
  const onContinue = vi.fn(async () => {});
  const user = userEvent.setup();
  const { rerender } = render(<PaneAccountSuggestion thread={thread} account={null} onContinue={onContinue} />);
  expect(screen.getByText("A needs sign-in.")).toBeVisible();
  expect(screen.getByText(/B · Signed in · Usage unavailable/)).toBeVisible();
  expect(onContinue).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Continue with B?" }));
  expect(screen.getByText(/starts a fresh coding session/)).toBeVisible();
  expect(onContinue).not.toHaveBeenCalled();
  // Account expires while the confirmation is open: the action disappears immediately.
  state.accounts = state.accounts.map((a) => (a.id === "b" ? { ...a, authenticationState: "not_authenticated" } : a));
  rerender(<PaneAccountSuggestion thread={thread} account={null} onContinue={onContinue} />);
  expect(screen.queryByRole("button", { name: "Start with B" })).not.toBeInTheDocument();
  state.accounts = [state.accounts[0] as ProviderAccount, account("b")];
  rerender(<PaneAccountSuggestion thread={thread} account={null} onContinue={onContinue} />);
  await user.click(screen.getByRole("button", { name: "Start with B" }));
  expect(onContinue).toHaveBeenCalledExactlyOnceWith("source", "b");
  expect(state.setDefault).not.toHaveBeenCalled();
});

it("dismisses the current condition but surfaces a different account failure", async () => {
  const onContinue = vi.fn();
  const user = userEvent.setup();
  const { rerender } = render(<PaneAccountSuggestion thread={thread} account={null} onContinue={onContinue} />);
  await user.click(screen.getByRole("button", { name: "Dismiss account suggestion" }));
  expect(screen.queryByRole("complementary", { name: "Account suggestion" })).not.toBeInTheDocument();
  rerender(<PaneAccountSuggestion thread={thread} account={null} onContinue={onContinue} />);
  expect(onContinue).not.toHaveBeenCalled();
  expect(screen.queryByRole("complementary", { name: "Account suggestion" })).not.toBeInTheDocument();
  state.accounts = [account("a"), account("b")];
  rerender(
    <PaneAccountSuggestion
      thread={{ ...thread, status: "failed", error: { code: "provider_billing_error", message: "Billing" } }}
      account={null}
      onContinue={onContinue}
    />,
  );
  expect(screen.getByText("A has a provider-reported billing or account hold.")).toBeVisible();
  expect(onContinue).not.toHaveBeenCalled();
});

it("does not interpret a failed registry load as a removed account", () => {
  state.accounts = [];
  state.loadError = "unavailable";
  render(<PaneAccountSuggestion thread={thread} account={null} onContinue={vi.fn()} />);
  expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
});
