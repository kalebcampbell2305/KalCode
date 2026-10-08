import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { allowOverlap, disallowOverlap, resetAllowedOverlaps, useAllowedOverlaps } from "./allowed.ts";

afterEach(() => {
  resetAllowedOverlaps();
  localStorage.clear();
});

describe("allowed overlaps", () => {
  it("remembers the files allowed per pair, persists, and forgets on warn-again", () => {
    const { result } = renderHook(() => useAllowedOverlaps());
    act(() => allowOverlap("ownership:a:b", ["x.ts"], "area"));
    expect(result.current.get("ownership:a:b")).toEqual({ files: ["x.ts"], risk: "area" });
    act(() => allowOverlap("ownership:a:b", ["y.ts"], "same-files"));
    expect(result.current.get("ownership:a:b")).toEqual({ files: ["x.ts", "y.ts"], risk: "same-files" });
    expect(JSON.parse(localStorage.getItem("kalcode.ownership.allowed.v2") ?? "[]")).toEqual([
      ["ownership:a:b", { files: ["x.ts", "y.ts"], risk: "same-files" }],
    ]);
    act(() => disallowOverlap("ownership:a:b"));
    expect(result.current.has("ownership:a:b")).toBe(false);
  });
});
