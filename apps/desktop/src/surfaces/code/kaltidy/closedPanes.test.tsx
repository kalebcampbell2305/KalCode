import { render } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { announceClosedPane, useKalTidyClosedPanes } from "./closedPanes.ts";

function Canvas({ forget }: { forget: (keys: ReadonlySet<string>) => void }) {
  useKalTidyClosedPanes(forget);
  return null;
}

it("tells the Code canvas which panes to close, until it unmounts", () => {
  const forget = vi.fn();
  const view = render(<Canvas forget={forget} />);
  announceClosedPane({ kind: "terminal", id: "t1" });
  announceClosedPane({ kind: "agent", id: "a1" });
  expect(forget.mock.calls.map(([keys]) => [...keys])).toEqual([["terminal:t1"], ["agent:a1"]]);

  view.unmount();
  announceClosedPane({ kind: "terminal", id: "t2" });
  expect(forget).toHaveBeenCalledTimes(2);
});
