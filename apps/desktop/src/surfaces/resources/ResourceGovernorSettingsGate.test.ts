import { describe, expect, it } from "vitest";
import { resourceGovernorAvailable } from "./ResourceGovernorSettingsGate.tsx";

describe("Resource Governor Settings truth gate", () => {
  it("requires the native resource capability to be visible and available", () => {
    expect(resourceGovernorAvailable([{ id: "resource_governor", state: "available", visible: true }])).toBe(true);
    expect(resourceGovernorAvailable([{ id: "resource_governor", state: "gated", visible: true }])).toBe(false);
    expect(resourceGovernorAvailable([{ id: "resource_governor", state: "available", visible: false }])).toBe(false);
  });
});
