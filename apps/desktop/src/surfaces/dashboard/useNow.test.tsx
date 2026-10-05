import { act, render } from "@testing-library/react";
import { Profiler } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createShownStore } from "../code/codeShown.ts";
import { CLOCK_TICK_MS, useClock, useNow } from "./useNow.ts";

// 12:00:10, ten seconds past a 30 s boundary.
const START = Date.parse("2026-10-05T12:00:10.000Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});

afterEach(() => {
  vi.useRealTimers();
});

function Reader({ id, renders }: { id: string; renders: Map<string, number> }) {
  const now = useNow();
  renders.set(id, (renders.get(id) ?? 0) + 1);
  return <span data-testid={id}>{now}</span>;
}

it("ticks every reader on the same wall-clock boundary, in one commit", () => {
  const renders = new Map<string, number>();
  let commits = 0;
  const onRender = (_id: string, phase: string) => {
    if (phase === "update") commits++;
  };
  const view = render(
    <Profiler id="a" onRender={onRender}>
      <Reader id="a" renders={renders} />
    </Profiler>,
  );
  // A second reader mounts 7 s later; a timer each would tick 7 s apart.
  act(() => vi.advanceTimersByTime(7_000));
  view.rerender(
    <Profiler id="a" onRender={onRender}>
      <Reader id="a" renders={renders} />
      <Reader id="b" renders={renders} />
    </Profiler>,
  );
  commits = 0;
  act(() => vi.advanceTimersByTime(13_000)); // 12:00:30
  expect(commits).toBe(1);
  const boundary = Date.parse("2026-10-05T12:00:30.000Z");
  expect(view.getByTestId("a").textContent).toBe(String(boundary));
  expect(view.getByTestId("b").textContent).toBe(String(boundary));
});

it("reads no earlier than the reader mounted, and stops its timer with the last reader", () => {
  const renders = new Map<string, number>();
  const view = render(<Reader id="a" renders={renders} />);
  expect(view.getByTestId("a").textContent).toBe(String(START));
  expect(vi.getTimerCount()).toBe(1);
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it("useNow(60 s) changes on minute boundaries only", () => {
  function Minute() {
    return <span data-testid="m">{useNow(60_000)}</span>;
  }
  const view = render(<Minute />);
  act(() => vi.advanceTimersByTime(20_000)); // 12:00:30
  expect(view.getByTestId("m").textContent).toBe(String(START));
  act(() => vi.advanceTimersByTime(CLOCK_TICK_MS)); // 12:01:00
  expect(view.getByTestId("m").textContent).toBe(String(Date.parse("2026-10-05T12:01:00.000Z")));
});

it("useClock re-renders only when the text it derives from the time changes", () => {
  let renders = 0;
  const since = START - 50_000; // 50 s ago
  function Age() {
    const now = useClock((at) => Math.floor((at - since) / 60_000));
    renders++;
    return <span data-testid="age">{Math.floor((now - since) / 60_000)}m</span>;
  }
  const view = render(<Age />);
  expect(view.getByTestId("age").textContent).toBe("0m");
  act(() => vi.advanceTimersByTime(20_000)); // 12:00:30: 70 s, now "1m"
  expect(view.getByTestId("age").textContent).toBe("1m");
  const after = renders;
  act(() => vi.advanceTimersByTime(CLOCK_TICK_MS)); // 12:01:00: 100 s, still "1m"
  expect(renders).toBe(after);
  act(() => vi.advanceTimersByTime(CLOCK_TICK_MS)); // 12:01:30: 130 s, "2m"
  expect(view.getByTestId("age").textContent).toBe("2m");
  expect(renders).toBe(after + 1);
});

it("a gated reader doesn't tick while hidden and catches up when shown", () => {
  // Later than every earlier test, so the clock's last boundary is behind this reader's mount.
  vi.setSystemTime(Date.parse("2026-10-05T13:00:10.000Z"));
  const shown = createShownStore(false);
  let renders = 0;
  function Hidden() {
    const now = useClock((at) => at, shown);
    renders++;
    return <span data-testid="t">{now}</span>;
  }
  const view = render(<Hidden />);
  const first = renders;
  act(() => vi.advanceTimersByTime(3 * CLOCK_TICK_MS));
  expect(renders).toBe(first);
  act(() => shown.set(true));
  expect(renders).toBe(first + 1);
  expect(Number(view.getByTestId("t").textContent)).toBe(Date.parse("2026-10-05T13:01:30.000Z"));
  act(() => vi.advanceTimersByTime(CLOCK_TICK_MS));
  expect(renders).toBe(first + 2);
});
