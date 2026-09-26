// @vitest-environment jsdom
import type { LocatorEntityKind, LocatorResponse } from "@kalcode/protocol";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLocatorSearch } from "./useLocatorSearch.ts";

const runtime = vi.hoisted(() => ({ client: { locatorSearch: vi.fn() } }));
vi.mock("../../../runtime/RuntimeProvider.tsx", () => ({ useRuntime: () => runtime }));
const response: LocatorResponse = {
  results: { items: [], nextCursor: null, totalEstimate: 0 },
  interpreted: {
    terms: ["old"],
    expanded: [],
    kinds: [],
    statuses: [],
    recency: null,
    providerId: null,
    activeOnly: false,
  },
  index: { entries: 0, ready: true, persistent: true },
};
const tick = async () => act(async () => vi.advanceTimersByTimeAsync(90));

describe("locator search result identity", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    runtime.client = { locatorSearch: vi.fn().mockResolvedValue(response) };
  });
  afterEach(() => vi.useRealTimers());

  it.each(["query", "filter", "client"])("clears old results while the next %s is debounced", async (change) => {
    const { result, rerender } = renderHook(({ query, kinds }) => useLocatorSearch(query, { kinds }), {
      initialProps: { query: "old", kinds: [] as LocatorEntityKind[] },
    });
    await tick();
    expect(result.current.response).toBe(response);
    if (change === "client") runtime.client = { locatorSearch: vi.fn().mockResolvedValue(response) };
    rerender({ query: change === "query" ? "new" : "old", kinds: change === "filter" ? ["thread"] : [] });
    expect(result.current.response).toBeNull();
    expect(result.current.loading).toBe(true);
    await tick();
    expect(result.current.loading).toBe(false);
  });

  it("clears the old error while a new query is pending", async () => {
    runtime.client.locatorSearch.mockRejectedValueOnce({
      category: "validation",
      code: "search_failed",
      message: "Old failure",
      retryable: false,
    });
    const { result, rerender } = renderHook(({ query }) => useLocatorSearch(query), { initialProps: { query: "old" } });
    await tick();
    expect(result.current.error).not.toBeNull();
    rerender({ query: "new" });
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(true);
  });

  it("discards late responses when searching is disabled", async () => {
    let finish!: (value: LocatorResponse) => void;
    runtime.client.locatorSearch.mockReturnValueOnce(
      new Promise<LocatorResponse>((resolve) => {
        finish = resolve;
      }),
    );
    const { result, rerender } = renderHook(({ enabled }) => useLocatorSearch("old", { enabled }), {
      initialProps: { enabled: true },
    });
    await tick();
    rerender({ enabled: false });
    await act(async () => finish(response));
    expect(result.current).toEqual({ response: null, forText: "", loading: false, error: null });
  });
});
