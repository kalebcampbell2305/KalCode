import { describe, expect, it } from "vitest";
import { spaceLevelOf } from "./spaceLevel.ts";

describe("spaceLevelOf", () => {
  it("keeps dense work quiet, work surfaces standard and the bridge cinematic", () => {
    expect(spaceLevelOf("settings")).toBe("quiet");
    expect(spaceLevelOf("memory")).toBe("quiet");
    expect(spaceLevelOf("code")).toBe("standard");
    expect(spaceLevelOf("operations")).toBe("standard");
    expect(spaceLevelOf("providers")).toBe("standard");
    expect(spaceLevelOf("threads")).toBe("standard");
    expect(spaceLevelOf("dashboard")).toBe("cinematic");
    expect(spaceLevelOf("kalvoice")).toBe("cinematic");
  });
});
