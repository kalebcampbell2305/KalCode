import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  type AccountSnapshot,
  type BillingInterval,
  type PurchasableTier,
  type RuntimeStatus,
  SESSION_EXPIRED_REASON,
} from "../ipc/account.ts";
import { AccountGate } from "./AccountGate.tsx";
import { AccountOnboarding, type AccountOnboardingActions } from "./AccountOnboarding.tsx";
import type { SocialProvider } from "./AccountProvider.tsx";

function snapshot(phase: AccountSnapshot["phase"]): AccountSnapshot {
  const identified = ["authenticated_unactivated", "confirming_plan", "ready", "offline_grace"].includes(phase);
  return {
    phase,
    account: identified
      ? {
          id: "acct_01",
          email: "owner@example.com",
          activatedAt: phase === "ready" ? "2026-09-25T12:00:00Z" : null,
          displayName: null,
        }
      : null,
    tier: phase === "ready" || phase === "offline_grace" ? "pro" : null,
    sessionExpiresAt: identified ? "2026-10-25T12:00:00Z" : null,
    entitlementExpiresAt: phase === "ready" || phase === "offline_grace" ? 1_800_000_000 : null,
    offlineGraceUntil: phase === "offline_grace" ? 1_800_086_400 : null,
    pendingEmail: phase === "email_pending" ? "owner@example.com" : null,
    pendingExpiresAt: ["email_pending", "social_pending"].includes(phase) ? "2026-09-25T12:10:00Z" : null,
    degradedReason: phase === "degraded" ? "service_unavailable" : null,
  };
}

function runtime(phase: RuntimeStatus["phase"]): RuntimeStatus {
  return { phase, ready: phase === "ready" };
}

function actions() {
  return {
    startEmail: vi.fn<(email: string) => Promise<void>>(async () => undefined),
    startSocial: vi.fn<(provider: SocialProvider) => Promise<void>>(async () => undefined),
    pollEmail: vi.fn<() => Promise<void>>(async () => undefined),
    cancelAuth: vi.fn<() => Promise<void>>(async () => undefined),
    activateFree: vi.fn<() => Promise<void>>(async () => undefined),
    checkout: vi.fn<(tier: PurchasableTier, interval: BillingInterval) => Promise<void>>(async () => undefined),
    retry: vi.fn<() => Promise<void>>(async () => undefined),
  } satisfies AccountOnboardingActions;
}

describe("AccountOnboarding", () => {
  it("shows each catalog plan with its monthly price, stage and KalVoice allowance by default", async () => {
    const accountActions = actions();
    render(
      <AccountOnboarding
        snapshot={snapshot("authenticated_unactivated")}
        busy={false}
        error={null}
        actions={accountActions}
      />,
    );
    const card = (name: string) => {
      const article = screen.getByRole("heading", { name }).closest("article");
      if (!article) throw new Error(`${name} card missing`);
      return article;
    };
    expect(card("Free")).toHaveTextContent("TRY");
    expect(within(card("Free")).getByText("25 KalVoice", { exact: true })).toBeInTheDocument();
    expect(card("Free")).toHaveTextContent("$0No checkout");
    expect(card("Free")).not.toHaveTextContent("per year");
    expect(screen.getByRole("radio", { name: "Monthly" })).toBeChecked();
    expect(card("Pro")).toHaveTextContent("$10per month");
    expect(card("Pro")).not.toHaveTextContent("per year");
    expect(within(card("Pro")).getByText("150 KalVoice", { exact: true })).toBeInTheDocument();
    expect(card("MAX")).toHaveTextContent("ORCHESTRATE");
    expect(card("MAX")).toHaveTextContent("$25per month");
    expect(within(card("MAX 2X")).getByText("1,000 KalVoice", { exact: true })).toBeInTheDocument();
    expect(card("MAX 2X")).toHaveTextContent("$50per month");

    await userEvent.click(screen.getByRole("button", { name: "Choose MAX" }));
    expect(accountActions.checkout).toHaveBeenCalledWith("max", "month");
    await userEvent.click(screen.getByRole("button", { name: "Continue with Free" }));
    expect(accountActions.activateFree).toHaveBeenCalledOnce();
  });

  it("switches paid prices to yearly and checks out the yearly plan, leaving Free unchanged", async () => {
    const accountActions = actions();
    render(
      <AccountOnboarding
        snapshot={snapshot("authenticated_unactivated")}
        busy={false}
        error={null}
        actions={accountActions}
      />,
    );
    const card = (name: string) => {
      const article = screen.getByRole("heading", { name }).closest("article");
      if (!article) throw new Error(`${name} card missing`);
      return article;
    };
    const billing = screen.getByRole("radiogroup", { name: "Billing interval" });
    expect(billing).toBeInTheDocument();

    await userEvent.click(screen.getByRole("radio", { name: "Yearly" }));
    expect(screen.getByRole("radio", { name: "Yearly" })).toBeChecked();
    expect(card("Pro")).toHaveTextContent("$100per year · save $20");
    expect(card("MAX")).toHaveTextContent("$250per year · save $50");
    expect(card("MAX 2X")).toHaveTextContent("$500per year · save $100");
    expect(card("MAX")).not.toHaveTextContent("per month");
    expect(card("Free")).toHaveTextContent("$0No checkout");

    await userEvent.click(screen.getByRole("button", { name: "Choose MAX 2X" }));
    expect(accountActions.checkout).toHaveBeenCalledWith("max2x", "year");
    await userEvent.click(screen.getByRole("button", { name: "Continue with Free" }));
    expect(accountActions.activateFree).toHaveBeenCalledOnce();

    await userEvent.click(screen.getByRole("radio", { name: "Monthly" }));
    expect(card("MAX")).toHaveTextContent("$25per month");
    await userEvent.click(screen.getByRole("button", { name: "Choose Pro" }));
    expect(accountActions.checkout).toHaveBeenLastCalledWith("pro", "month");
  });

  it("offers an explicit retry when native session restoration times out", async () => {
    const accountActions = actions();
    render(
      <AccountOnboarding
        snapshot={snapshot("bootstrapping")}
        busy={false}
        error={{
          code: "account_bootstrap_timeout",
          message: "KalCode couldn't finish restoring your session. Try again.",
          retryable: true,
        }}
        actions={accountActions}
      />,
    );

    expect(screen.getByRole("heading", { name: "Restoring your session" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "false");
    expect(screen.getByRole("alert")).toHaveTextContent("couldn't finish restoring your session");
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(accountActions.retry).toHaveBeenCalledOnce();
  });

  it("uses the same private email flow for sign in and account creation", async () => {
    const accountActions = actions();
    const { rerender } = render(
      <AccountOnboarding snapshot={snapshot("signed_out")} busy={false} error={null} actions={accountActions} />,
    );
    expect(screen.getByRole("heading", { name: "Welcome to KalCode" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Continue with email" }));
    await userEvent.type(screen.getByLabelText("Email"), "OWNER@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Email me a sign-in link" }));
    expect(accountActions.startEmail).toHaveBeenCalledWith("owner@example.com");

    rerender(
      <AccountOnboarding snapshot={snapshot("signed_out")} busy={false} error={null} actions={accountActions} />,
    );
    // One email entry serves new and returning people alike.
    expect(screen.getAllByRole("button", { name: /with email/ })).toHaveLength(1);
  });

  it("checks the email link when KalCode regains focus, and keeps the manual button", async () => {
    const accountActions = actions();
    const { rerender, unmount } = render(
      <AccountOnboarding snapshot={snapshot("email_pending")} busy={false} error={null} actions={accountActions} />,
    );
    expect(screen.getByRole("button", { name: "I've verified my email" })).toBeInTheDocument();
    window.dispatchEvent(new Event("focus"));
    expect(accountActions.pollEmail).toHaveBeenCalledOnce();
    // Not while a check is already running.
    rerender(
      <AccountOnboarding snapshot={snapshot("email_pending")} busy={true} error={null} actions={accountActions} />,
    );
    window.dispatchEvent(new Event("focus"));
    expect(accountActions.pollEmail).toHaveBeenCalledOnce();
    // Nor once the email step is over.
    rerender(
      <AccountOnboarding snapshot={snapshot("signed_out")} busy={false} error={null} actions={accountActions} />,
    );
    window.dispatchEvent(new Event("focus"));
    expect(accountActions.pollEmail).toHaveBeenCalledOnce();
    unmount();
  });

  it("tells a returning person their session expired instead of showing the first-run welcome", async () => {
    const accountActions = actions();
    render(
      <AccountOnboarding
        snapshot={{ ...snapshot("signed_out"), degradedReason: SESSION_EXPIRED_REASON }}
        busy={false}
        error={null}
        actions={accountActions}
      />,
    );
    expect(screen.getByRole("heading", { name: "Your session expired — sign in again" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Welcome to KalCode" })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Sign in again to keep working.");
    await userEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
    expect(accountActions.startSocial).toHaveBeenCalledWith("google");
    await userEvent.click(screen.getByRole("button", { name: "Continue with email" }));
    await userEvent.type(screen.getByLabelText("Email"), "owner@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Email me a sign-in link" }));
    expect(accountActions.startEmail).toHaveBeenCalledWith("owner@example.com");
  });

  it("starts fixed native social providers and shows a cancellable browser handoff", async () => {
    const accountActions = actions();
    const { rerender } = render(
      <AccountOnboarding snapshot={snapshot("signed_out")} busy={false} error={null} actions={accountActions} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
    expect(accountActions.startSocial).toHaveBeenCalledWith("google");

    rerender(
      <AccountOnboarding snapshot={snapshot("social_pending")} busy={false} error={null} actions={accountActions} />,
    );
    expect(screen.getByRole("heading", { name: "Finish in your browser" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(accountActions.cancelAuth).toHaveBeenCalledOnce();
  });

  it("keeps paid access gated and permits a bounded confirmation retry", async () => {
    const accountActions = actions();
    render(
      <AccountOnboarding
        snapshot={snapshot("confirming_plan")}
        busy={false}
        error={{ code: "plan_confirmation_timeout", message: "Still waiting.", retryable: true }}
        actions={accountActions}
      />,
    );
    expect(screen.getByRole("heading", { name: "Confirming plan" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(accountActions.retry).toHaveBeenCalledOnce();
  });
});

describe("AccountGate", () => {
  it("opens the workspace only after both account and runtime are ready", () => {
    const accountActions = actions();
    const { rerender } = render(
      <AccountGate
        snapshot={snapshot("ready")}
        runtime={runtime("starting")}
        busy={false}
        error={null}
        actions={accountActions}
      >
        <p>Workspace</p>
      </AccountGate>,
    );
    expect(screen.queryByText("Workspace")).toBeNull();
    expect(screen.getByRole("heading", { name: "Starting your workspace" })).toBeInTheDocument();

    rerender(
      <AccountGate
        snapshot={snapshot("ready")}
        runtime={runtime("ready")}
        busy={false}
        error={null}
        actions={accountActions}
      >
        <p>Workspace</p>
      </AccountGate>,
    );
    expect(screen.getByText("Workspace")).toBeInTheDocument();
  });

  it("shows cleanup truth after logout instead of presenting a relogin form", () => {
    const accountActions = actions();
    const { rerender } = render(
      <AccountGate
        snapshot={snapshot("signed_out")}
        runtime={runtime("draining")}
        busy={false}
        error={null}
        actions={accountActions}
      >
        <p>Workspace</p>
      </AccountGate>,
    );
    expect(screen.getByRole("heading", { name: "Signing out securely" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Welcome to KalCode" })).toBeNull();

    rerender(
      <AccountGate
        snapshot={snapshot("signed_out")}
        runtime={runtime("blocked_unclean")}
        busy={false}
        error={null}
        actions={accountActions}
      >
        <p>Workspace</p>
      </AccountGate>,
    );
    expect(screen.getByRole("heading", { name: "Workspace recovery paused" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
    expect(screen.queryByRole("heading", { name: "Welcome to KalCode" })).toBeNull();
  });

  it("allows signed offline authority only after the runtime reports ready", () => {
    render(
      <AccountGate
        snapshot={snapshot("offline_grace")}
        runtime={runtime("ready")}
        busy={false}
        error={null}
        actions={actions()}
      >
        <p>Workspace</p>
      </AccountGate>,
    );
    expect(screen.getByText("Workspace")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/verified offline access/i);
  });
});
