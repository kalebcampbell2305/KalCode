import type { FeatureFlag } from "@kalcode/protocol";
import { describe, expect, it } from "vitest";
import { doctorAvailable } from "./DoctorSettings.tsx";

function feature(state: FeatureFlag["state"], visible = true): FeatureFlag {
  return {
    id: "environment_doctor",
    state,
    visible,
  };
}

describe("Doctor Settings truth gate", () => {
  it("shows Doctor only when native capability is visible and available", () => {
    expect(doctorAvailable([feature("available")])).toBe(true);
    expect(doctorAvailable([feature("gated")])).toBe(false);
    expect(doctorAvailable([feature("available", false)])).toBe(false);
    expect(doctorAvailable(undefined)).toBe(false);
  });
});
