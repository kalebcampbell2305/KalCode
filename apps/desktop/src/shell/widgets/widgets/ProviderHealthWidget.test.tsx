import type { ProviderAccount, ProviderHealth } from "@kalcode/protocol";
import { ToastProvider } from "@kalcode/ui/components";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KalCodeClient } from "../../../ipc/client.ts";
import { createMemoryTransport } from "../../../ipc/memoryTransport.ts";
import { RuntimeProvider } from "../../../runtime/RuntimeProvider.tsx";
import { accountSignInState, ProviderHealthWidget } from "./ProviderHealthWidget.tsx";

const navigation = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("../../navigation.tsx", () => ({ useNavigation: () => navigation }));

beforeEach(() => navigation.navigate.mockReset());

const account = (overrides: Partial<ProviderAccount>) =>
  ({ providerId: "codex", authenticationState: "unknown", archivedAt: null, ...overrides }) as ProviderAccount;

describe("accountSignInState", () => {
  it("is signed in when any active account is, signed out when every one is", () => {
    expect(accountSignInState([account({ authenticationState: "authenticated" })], "codex")).toBe("signed_in");
    expect(
      accountSignInState(
        [account({ authenticationState: "not_authenticated" }), account({ authenticationState: "authenticated" })],
        "codex",
      ),
    ).toBe("signed_in");
    expect(accountSignInState([account({ authenticationState: "not_authenticated" })], "codex")).toBe("signed_out");
    // Archived accounts, other providers and unknown sign-in say nothing.
    expect(
      accountSignInState(
        [account({ authenticationState: "authenticated", archivedAt: "2026-10-01T00:00:00Z" })],
        "codex",
      ),
    ).toBeNull();
    expect(accountSignInState([account({ authenticationState: "authenticated" })], "claude-code")).toBeNull();
    expect(accountSignInState([account({})], "codex")).toBeNull();
    expect(accountSignInState([], "codex")).toBeNull();
  });
});

describe("ProviderHealthWidget", () => {
  it("shows account sign-in for unchecked providers and checks them on Check now", async () => {
    const client = new KalCodeClient(createMemoryTransport("default"));
    const boot = await client.boot();
    const settings = await client.getSettings();
    const base = (await client.listProviderHealth())[0] as ProviderHealth;
    const unchecked = (providerId: ProviderHealth["providerId"], displayName: string): ProviderHealth => ({
      ...base,
      providerId,
      displayName,
      state: "unknown",
      detection: null,
      auth: "unknown",
      reasonCode: "not_checked",
      reason: `${displayName} hasn't been checked yet.`,
      checkedAt: null,
    });
    vi.spyOn(client, "listProviderHealth").mockResolvedValue([
      unchecked("claude-code", "Claude Code"),
      unchecked("codex", "Codex"),
      unchecked("gemini-cli", "Gemini CLI"),
    ]);
    vi.spyOn(client, "listProviderAccounts").mockResolvedValue([
      account({ providerId: "claude-code", authenticationState: "authenticated" }),
      account({ providerId: "codex", authenticationState: "not_authenticated" }),
    ]);
    const detect = vi.spyOn(client, "detectProviders").mockResolvedValue([]);

    render(
      <ToastProvider>
        <RuntimeProvider client={client} info={boot.info} initialSettings={settings}>
          <ProviderHealthWidget />
        </RuntimeProvider>
      </ToastProvider>,
    );

    const row = (id: string) => document.querySelector<HTMLElement>(`[data-provider-health="${id}"]`);
    await waitFor(() => expect(row("claude-code")).not.toBeNull());
    await waitFor(() => expect(within(row("claude-code") as HTMLElement).getByText("Signed in")).toBeInTheDocument());
    expect(within(row("codex") as HTMLElement).getByText(/Signed out/)).toBeInTheDocument();
    expect(within(row("gemini-cli") as HTMLElement).getByText("Not checked yet")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Sign in to Codex" }));
    expect(navigation.navigate).toHaveBeenCalledWith("providers");

    fireEvent.click(screen.getByRole("button", { name: "Check now" }));
    await waitFor(() => expect(detect).toHaveBeenCalledTimes(1));
  });
});
