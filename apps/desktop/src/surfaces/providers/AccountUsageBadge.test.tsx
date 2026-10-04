import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccountUsageBadge, UsageMeter } from "./AccountUsageBadge.tsx";
import type { AccountUsageState } from "./accountUsage.ts";

const usage = vi.hoisted(() => ({ map: new Map<string, AccountUsageState>() }));
vi.mock("./accountUsage.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./accountUsage.ts")>();
  return {
    ...actual,
    useAccountUsages: () => usage.map,
    useAccountUsage: (id: string) => usage.map.get(id) ?? actual.notChecked(id),
  };
});

const account = { id: "claude-a", displayName: "Claude A", providerId: "claude-code" } as const;
const inTwoHours = () => new Date(Date.now() + (2 * 60 + 14) * 60_000 + 20_000).toISOString();

beforeEach(() => {
  usage.map = new Map();
});

describe("account usage badge", () => {
  it("shows the canonical remaining quota, and says so when it isn't known", () => {
    const { rerender } = render(<AccountUsageBadge account={account} />);
    expect(screen.getByText("Usage unavailable")).toBeVisible();
    usage.map = new Map([
      [
        account.id,
        {
          accountId: account.id,
          status: "fresh",
          windows: [{ id: "five_hour", label: "5-hour", remainingPercent: 64, resetsAt: null }],
          checkedAt: new Date().toISOString(),
          reason: null,
        },
      ],
    ]);
    rerender(<AccountUsageBadge account={account} size="xs" />);
    expect(screen.getByText("64% left")).toBeVisible();
    expect(screen.getByText("64% left").parentElement).toHaveAttribute("data-tone", "ok");
  });

  it("does not warn about stale usage as if it were current", () => {
    usage.map = new Map([
      [
        account.id,
        {
          accountId: account.id,
          status: "stale",
          windows: [{ id: "weekly", label: "Weekly", remainingPercent: 8, resetsAt: null }],
          checkedAt: new Date().toISOString(),
          reason: null,
        },
      ],
    ]);
    render(<UsageMeter usage={usage.map.get(account.id) as AccountUsageState} />);
    const meter = screen.getByText("Usage unavailable").parentElement;
    expect(meter).toHaveAttribute("data-tone", "muted");
    expect(meter).toHaveAttribute("data-stale");
  });

  it("opens every usage window, plan and freshness when interactive", async () => {
    usage.map = new Map([
      [
        account.id,
        {
          accountId: account.id,
          status: "fresh",
          windows: [
            { id: "five_hour", label: "5-hour", remainingPercent: 64, resetsAt: inTwoHours() },
            { id: "weekly", label: "Weekly", remainingPercent: 42, resetsAt: null },
          ],
          checkedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
          reason: null,
          plan: "Max",
        },
      ],
    ]);
    render(<AccountUsageBadge account={account} interactive />);
    await userEvent.setup().click(screen.getByRole("button", { name: /Claude A usage: 42% left/ }));
    expect(await screen.findByRole("heading", { name: "Claude A" })).toBeVisible();
    expect(screen.getByText(/Claude Code · Max/)).toBeVisible();
    expect(screen.getByText("5-hour")).toBeVisible();
    expect(screen.getByText("Resets in 2h 14m")).toBeVisible();
    expect(screen.getByText("Weekly")).toBeVisible();
    expect(screen.getByText(/Updated 3 minutes ago/)).toBeVisible();
  });
});
