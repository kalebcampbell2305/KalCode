import { ToastProvider, TooltipProvider } from "@kalcode/ui/components";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KalCodeClient } from "../../ipc/client.ts";
import { createMemoryTransport } from "../../ipc/memoryTransport.ts";
import type { CommandName } from "../../ipc/transport.ts";
import { ProviderAccountsView } from "./ProviderAccountsView.tsx";

// The account card must sign a Gemini account in through the native, account-scoped command on
// every build channel. Stable ships without provider panes, so nothing here may depend on one.
const runtime = vi.hoisted(() => ({ client: null as unknown as KalCodeClient }));
vi.mock("../../runtime/RuntimeProvider.tsx", () => ({ useRuntime: () => runtime }));

let calls: CommandName[] = [];

beforeEach(() => {
  calls = [];
  const transport = createMemoryTransport("default", { detectDelayMs: 0 });
  const invoke = transport.invoke.bind(transport);
  transport.invoke = (<T,>(command: CommandName, args?: Record<string, unknown>): Promise<T> => {
    calls.push(command);
    return invoke<T>(command, args);
  }) as typeof transport.invoke;
  runtime.client = new KalCodeClient(transport);
});

function mount() {
  return render(
    <ToastProvider>
      <TooltipProvider>
        <ProviderAccountsView enabled statuses={null} />
      </TooltipProvider>
    </ToastProvider>,
  );
}

describe("Gemini account card", () => {
  it("signs in and out with Gemini's own sign-in, never a provider pane", async () => {
    const user = userEvent.setup();
    mount();
    const card = await screen.findByRole("region", { name: "Gemini CLI account Personal" });
    expect(within(card).queryByRole("button", { name: /auth pane/i })).toBeNull();
    expect(within(card).getByText("Not checked", { exact: true })).toBeTruthy();

    await user.click(within(card).getByRole("button", { name: "Sign in Personal" }));
    await waitFor(() => expect(within(card).getByText("Signed in", { exact: true })).toBeTruthy());
    expect(calls).toContain("provider_gemini_login_start");
    expect(calls).toContain("provider_gemini_login_wait");

    await user.click(within(card).getByRole("button", { name: "Sign out Personal" }));
    await waitFor(() => expect(within(card).getByText("Signed out", { exact: true })).toBeTruthy());
    expect(calls).toContain("provider_gemini_logout");

    await user.click(within(card).getByRole("button", { name: "Refresh Personal sign-in status" }));
    await waitFor(() => expect(calls).toContain("provider_gemini_account_refresh"));

    const paneOrWorkspace = calls.filter(
      (command) => command.startsWith("provider_pane_") || command.startsWith("workspace"),
    );
    expect(paneOrWorkspace).toEqual([]);
    // Claude Code and Codex keep their own commands.
    expect(calls.some((command) => command.startsWith("provider_claude_"))).toBe(false);
    expect(calls.some((command) => command.startsWith("provider_codex_"))).toBe(false);
  });

  it("explains that Gemini sign-in stays with the provider and the account", async () => {
    mount();
    await screen.findByRole("region", { name: "Gemini CLI account Personal" });
    expect(screen.getByText(/Gemini CLI opens Google sign-in in your browser/)).toBeTruthy();
    expect(screen.queryByText(/\/auth/)).toBeNull();
  });
});
