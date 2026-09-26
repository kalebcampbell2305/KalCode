import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, listenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));

import { createBrowserBridge } from "./browserBridge.ts";

const browserId = "550e8400-e29b-41d4-a716-446655440000";
const bounds = { x: 10, y: 20, width: 800, height: 600 };

describe("native Browser page authority", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "browser_page_lease") return 42;
      if (command === "browser_focus" || command === "browser_close") return true;
      if (command === "browser_hide_all") return 1;
      return {
        browserId,
        workspaceId: "550e8400-e29b-41d4-a716-446655440001",
        url: "https://example.com/",
        title: "Example",
        loading: false,
        visible: true,
        bounds,
      };
    });
  });

  it("binds every renderer-originated Browser effect to the bootstrapped page lease", async () => {
    const bridge = createBrowserBridge();

    await bridge.attach({
      browserId,
      workspaceId: "550e8400-e29b-41d4-a716-446655440001",
      url: "https://example.com/",
      bounds,
      visible: true,
      visibilityVersion: 1,
    });
    await bridge.setView({ browserId, bounds, visible: false, visibilityVersion: 2 });
    await bridge.navigate(browserId, "https://example.com/next");
    await bridge.action(browserId, "reload");
    await bridge.focus(browserId);
    await bridge.info(browserId);
    await bridge.close(browserId);
    await bridge.hideAll();
    await bridge.openExternal("https://example.com/");

    expect(invokeMock.mock.calls.filter(([command]) => command === "browser_page_lease")).toHaveLength(1);
    for (const [command, payload] of invokeMock.mock.calls) {
      if (command === "browser_page_lease") continue;
      const request = command === "browser_attach" || command === "browser_set_view"
        ? (payload as { request: { pageLease: number } }).request
        : payload as { pageLease: number };
      expect(request.pageLease, command).toBe(42);
    }
  });
});
