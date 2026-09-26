import type { PaneLayout } from "@kalcode/protocol";
import { expect, it } from "vitest";
import { makeLeaf } from "../../shell/panes/model.ts";
import { resolveBrowserTarget } from "./browserTarget.ts";

const one = { kind: "browser" as const, browserId: "one", url: null };
const two = { kind: "browser" as const, browserId: "two", url: null };
const layout: PaneLayout = {
  schemaVersion: 1,
  root: {
    kind: "split",
    axis: "horizontal",
    ratios: [500, 500],
    children: [makeLeaf([one], "a"), makeLeaf([two], "b")],
  },
  dock: [],
  maximizedPaneId: null,
};
it("routes only to the explicit or focused browser when multiple browsers exist", () => {
  expect(resolveBrowserTarget(layout, "b", null)?.content.browserId).toBe("two");
  expect(resolveBrowserTarget(layout, "b", "one")?.content.browserId).toBe("one");
  expect(resolveBrowserTarget(layout, null, null)).toBeNull();
  expect(resolveBrowserTarget(layout, "b", "missing")).toBeNull();
});
it("permits a sole browser but never treats an inactive tab as focused", () => {
  const single = { ...layout, root: makeLeaf([one, { kind: "dashboard" }], "a", 1) };
  expect(resolveBrowserTarget(single, "a", null)?.content.browserId).toBe("one");
  const multiple = { ...layout, root: makeLeaf([one, two, { kind: "dashboard" }], "a", 2) };
  expect(resolveBrowserTarget(multiple, "a", null)).toBeNull();
});
