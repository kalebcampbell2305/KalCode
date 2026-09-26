import { isValidElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { MemoryUtilityApi } from "../../ipc/memory/utilities.ts";
import { registeredRenderer } from "../../shell/panes/contentRegistry.ts";
import { registerUtilityDock, UTILITY_DOCK_WIDGET_ID, utilityDockAvailable } from "./UtilityDockPane.tsx";

describe("Utility Dock pane registration", () => {
  it("advertises the widget only when native capability is available", () => {
    expect(utilityDockAvailable([{ id: "utility_dock", state: "available", visible: true }])).toBe(true);
    expect(utilityDockAvailable([{ id: "utility_dock", state: "gated", visible: true }])).toBe(false);
    expect(utilityDockAvailable([{ id: "utility_dock", state: "available", visible: false }])).toBe(false);
  });

  it("registers one real widget renderer and removes it cleanly", () => {
    const content = { kind: "widget" as const, widgetId: UTILITY_DOCK_WIDGET_ID };
    expect(registeredRenderer(content)).toBeNull();

    const unregister = registerUtilityDock(new MemoryUtilityApi(), vi.fn());
    const renderer = registeredRenderer(content);

    expect(renderer?.describe(content)).toMatchObject({
      title: "Utility Dock",
      statusText: "Bounded local tools and governed native actions",
    });
    expect(
      isValidElement(
        renderer?.render(content, {
          paneId: "pane-1",
          tabId: "tab-1",
          focused: true,
          focusRequest: 0,
        }),
      ),
    ).toBe(true);

    unregister();
    expect(registeredRenderer(content)).toBeNull();
  });
});
