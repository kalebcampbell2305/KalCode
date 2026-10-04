import type { ProviderAccount, ThreadSummary } from "@kalcode/protocol";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import type { AccountUsageState } from "../../providers/accountUsage.ts";
import { PaneAccountPicker } from "./PaneAccountPicker.tsx";

const state = vi.hoisted(() => ({
  accounts: [] as ProviderAccount[],
  usage: new Map<string, AccountUsageState>(),
  checking: new Set<string>(),
  validationErrors: new Map<string, string>(),
  reload: vi.fn(() => new Promise(() => {})),
  refreshUsage: vi.fn(),
  loadError: null,
}));
vi.mock("../../providers/ProviderAccountSessions.tsx", () => ({ useOptionalProviderAccountSessions: () => state }));
const thread = {
  id: "original",
  providerId: "codex",
  providerName: "Codex",
  providerAccountId: "work",
  archivedAt: null,
  permissionMode: "plan",
} as ThreadSummary;
const account = (id: string, overrides: Partial<ProviderAccount> = {}) =>
  ({
    id,
    displayName: id,
    providerId: "codex",
    authenticationState: "authenticated",
    archivedAt: null,
    lastErrorCode: null,
    lastCheckedAt: null,
    isDefault: false,
    ...overrides,
  }) as ProviderAccount;
beforeEach(() => {
  vi.clearAllMocks();
  state.accounts = [
    account("work"),
    account("personal", { isDefault: true }),
    account("expired", { authenticationState: "not_authenticated" }),
    account("foreign", { providerId: "claude-code" }),
    account("archived", { archivedAt: "yesterday" }),
  ];
  state.usage = new Map([
    [
      "work",
      {
        accountId: "work",
        status: "fresh",
        windows: [
          {
            id: "weekly",
            label: "Weekly",
            remainingPercent: 42,
            resetsAt: new Date(Date.now() + 3600000).toISOString(),
          },
        ],
        checkedAt: new Date().toISOString(),
        reason: null,
      },
    ],
  ]);
});
async function open(onContinue = vi.fn(async () => {})) {
  const user = userEvent.setup();
  render(<PaneAccountPicker thread={thread} account={{ label: "work", state: "active" }} onContinue={onContinue} />);
  await user.click(screen.getByRole("button", { name: "work. Switch Codex account" }));
  return { user, onContinue };
}

it("opens cached compatible accounts without waiting for refresh, and marks the bound account rather than the default", async () => {
  const { onContinue } = await open();
  expect(screen.getByRole("heading", { name: "Account & usage" })).toBeVisible();
  const current = screen.getByRole("button", { name: /work.*Current.*Codex/ });
  expect(current).toHaveAttribute("aria-pressed", "true");
  expect(within(current).getByText("42% left")).toBeVisible();
  expect(within(current).getByText(/Resets in/)).toBeVisible();
  expect(screen.queryByText("foreign")).not.toBeInTheDocument();
  expect(screen.queryByText("archived")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /expired.*Codex/ })).toBeDisabled();
  expect(state.reload).toHaveBeenCalledOnce();
  expect(state.refreshUsage).toHaveBeenCalledOnce();
  expect(onContinue).not.toHaveBeenCalled();
});

it("previews and cancels without switching; confirmation uses the exact selected id once", async () => {
  const { user, onContinue } = await open();
  await user.click(screen.getByRole("button", { name: /personal.*Codex/ }));
  expect(screen.getByText(/starts a fresh coding session/)).toBeVisible();
  expect(screen.getByText(/Conversation history and provider sign-in stay/)).toBeVisible();
  expect(onContinue).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("button", { name: "Start with personal" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: /personal.*Codex/ }));
  await user.click(screen.getByRole("button", { name: "Start with personal" }));
  expect(onContinue).toHaveBeenCalledExactlyOnceWith("original", "personal");
  expect(screen.queryByRole("heading", { name: "Account & usage" })).not.toBeInTheDocument();
});

it("keeps the original bound identity and shows launch failures without claiming a switch", async () => {
  const { user } = await open(
    vi.fn(async () => {
      throw {
        code: "provider_account_not_found",
        category: "validation",
        message: "Account no longer available",
        retryable: false,
      };
    }),
  );
  await user.click(screen.getByRole("button", { name: /personal.*Codex/ }));
  await user.click(screen.getByRole("button", { name: "Start with personal" }));
  expect(screen.getByRole("alert")).toHaveTextContent("Account no longer available");
  expect(screen.getByRole("button", { name: "work. Switch Codex account" })).toBeVisible();
  expect(screen.getByText("Current")).toBeVisible();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("heading", { name: "Account & usage" })).not.toBeInTheDocument();
});
