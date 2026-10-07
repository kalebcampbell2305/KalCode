import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args), isTauri: () => true }));

const { INTEGRATIONS_CHANGED, integrationDispatch } = await import("./integrationClient.ts");

describe("integrationDispatch", () => {
  beforeEach(() => invoke.mockReset().mockResolvedValue({}));

  it("tells KalVoice routing the integrations changed after an OAuth reconnect", async () => {
    const changed = vi.fn();
    window.addEventListener(INTEGRATIONS_CHANGED, changed);
    try {
      await integrationDispatch("oauth", { id: "integration-1", config: {} });
      expect(changed).toHaveBeenCalledTimes(1);
      await integrationDispatch("list");
      expect(changed).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(INTEGRATIONS_CHANGED, changed);
    }
  });
});
