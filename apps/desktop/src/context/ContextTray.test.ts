import type { FeatureFlag } from "@kalcode/protocol";
import { describe, expect, it } from "vitest";
import { contextDropAvailable } from "./ContextTray.tsx";

function feature(
  id: "context_drop" | "context_firewall",
  state: FeatureFlag["state"] = "available",
  visible = true,
): FeatureFlag {
  return { id, state, visible };
}

describe("contextDropAvailable", () => {
  it("requires both the sharing surface and firewall authority", () => {
    expect(contextDropAvailable(undefined)).toBe(false);
    expect(contextDropAvailable([feature("context_drop")])).toBe(false);
    expect(contextDropAvailable([feature("context_firewall")])).toBe(false);
    expect(contextDropAvailable([feature("context_drop"), feature("context_firewall")])).toBe(true);
  });

  it("does not render gated, preview, or hidden capability", () => {
    expect(contextDropAvailable([feature("context_drop", "gated"), feature("context_firewall")])).toBe(false);
    expect(contextDropAvailable([feature("context_drop", "preview"), feature("context_firewall")])).toBe(false);
    expect(contextDropAvailable([feature("context_drop"), feature("context_firewall", "available", false)])).toBe(
      false,
    );
  });
});
