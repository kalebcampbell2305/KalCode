import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  agents: { state: { status: "ready", data: [] } as { status: string; data?: never[]; error?: unknown } },
  ownership: { overlaps: [], ready: true, failed: false, incomplete: false },
  deck: {
    operations: {
      data: null as null | {
        revision: number;
        paused: boolean;
        items: never[];
        services: never[];
        environments: never[];
        activity: never[];
        observedAt: string;
        warnings: string[];
      },
      failed: false,
    },
  },
}));

vi.mock("../../surfaces/dashboard/data/DashboardData.tsx", () => ({
  useCodingAgents: () => mocks.agents,
}));
vi.mock("../../surfaces/dashboard/fleet/useAgentOverlaps.ts", () => ({
  useAgentOverlaps: () => mocks.ownership,
}));
vi.mock("../../surfaces/dashboard/useNow.ts", () => ({ useNow: () => Date.parse("2026-10-05T12:00:00Z") }));
vi.mock("../../surfaces/permissions/PermissionsProvider.tsx", () => ({ useOptionalPermissions: () => null }));
vi.mock("../notifications/NotificationsProvider.tsx", () => ({ useOptionalNotifications: () => null }));
vi.mock("../deck/DeckData.tsx", () => ({ useOptionalDeckData: () => mocks.deck }));

import { useAttention } from "./useAttention.ts";

describe("useAttention Operations truth", () => {
  beforeEach(() => {
    mocks.agents.state = { status: "ready", data: [] };
    mocks.ownership.overlaps = [];
    mocks.ownership.ready = true;
    mocks.ownership.failed = false;
    mocks.ownership.incomplete = false;
    mocks.deck.operations.data = null;
    mocks.deck.operations.failed = false;
  });

  it("waits for the shared Operations read, reports failure, and clears after recovery", () => {
    const { result, rerender } = renderHook(() => useAttention());
    expect(result.current).toEqual({ items: [], ready: false });

    mocks.deck.operations.failed = true;
    rerender();
    expect(result.current.ready).toBe(true);
    expect(result.current.items).toEqual([
      expect.objectContaining({ key: "operations:unavailable", what: "Couldn't check runs and queue" }),
    ]);

    mocks.deck.operations.data = {
      revision: 2,
      paused: false,
      items: [],
      services: [],
      environments: [],
      activity: [],
      observedAt: "2026-10-05T12:00:00Z",
      warnings: [],
    };
    mocks.deck.operations.failed = false;
    rerender();
    expect(result.current).toEqual({ items: [], ready: true });
  });

  it("turns an agent read failure into a retryable item instead of permanent loading", () => {
    mocks.deck.operations.data = {
      revision: 2,
      paused: false,
      items: [],
      services: [],
      environments: [],
      activity: [],
      observedAt: "2026-10-05T12:00:00Z",
      warnings: [],
    };
    mocks.agents.state = { status: "error", error: new Error("offline") };
    const { result } = renderHook(() => useAttention());
    expect(result.current.ready).toBe(true);
    expect(result.current.items).toEqual([
      expect.objectContaining({ key: "agents:unavailable", actions: [{ id: "retry-agents", label: "Try again" }] }),
    ]);
  });

  it("waits for the shared ownership read before it can report all-clear", () => {
    mocks.deck.operations.data = {
      revision: 2,
      paused: false,
      items: [],
      services: [],
      environments: [],
      activity: [],
      observedAt: "2026-10-05T12:00:00Z",
      warnings: [],
    };
    mocks.ownership.ready = false;
    const { result } = renderHook(() => useAttention());
    expect(result.current).toEqual({ items: [], ready: false });
  });
});
