import { act, render, screen } from "@testing-library/react";
import { StrictMode, useCallback } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useVirtualRows } from "./useVirtualRows.ts";

class TestResizeObserver {
  static instances: TestResizeObserver[] = [];
  readonly targets = new Set<Element>();
  constructor(private readonly callback: ResizeObserverCallback) {
    TestResizeObserver.instances.push(this);
  }
  observe(target: Element) {
    this.targets.add(target);
  }
  unobserve(target: Element) {
    this.targets.delete(target);
  }
  disconnect() {
    this.targets.clear();
  }
  static resize(target: Element) {
    for (const observer of TestResizeObserver.instances) {
      if (observer.targets.has(target)) {
        observer.callback([{ target } as ResizeObserverEntry], observer as unknown as ResizeObserver);
      }
    }
  }
}

function List({ keys }: { keys: string[] }) {
  const getKey = useCallback((index: number) => keys[index] ?? "", [keys]);
  const estimate = useCallback(() => 100, []);
  const virtual = useVirtualRows({ count: keys.length, getKey, estimate });
  return (
    <div ref={virtual.containerRef}>
      <output data-testid="total">{virtual.total}</output>
      {virtual.rows.map((row) => (
        <div key={row.key} ref={virtual.measureRef(row.key)} data-testid={row.key} data-height="100">
          {row.start}
        </div>
      ))}
    </div>
  );
}

beforeEach(() => {
  TestResizeObserver.instances = [];
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return Number(this.dataset.height ?? 0);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useVirtualRows", () => {
  it("estimates a removed row anew when it returns outside the visible window", () => {
    const view = render(<List keys={["returning"]} />);
    const returning = screen.getByTestId("returning");
    act(() => {
      returning.dataset.height = "500";
      TestResizeObserver.resize(returning);
    });
    expect(screen.getByTestId("total")).toHaveTextContent("500");

    view.rerender(<List keys={[]} />);
    const keys = Array.from({ length: 30 }, (_, index) => `other-${index}`);
    view.rerender(<List keys={[...keys, "returning"]} />);
    expect(screen.queryByTestId("returning")).not.toBeInTheDocument();
    expect(screen.getByTestId("total")).toHaveTextContent("3100");

    act(() => TestResizeObserver.resize(returning));
    expect(screen.getByTestId("total")).toHaveTextContent("3100");
  });

  it("retains measured heights for existing rows that move outside the visible window", () => {
    const view = render(<List keys={["retained"]} />);
    const retained = screen.getByTestId("retained");
    act(() => {
      retained.dataset.height = "500";
      TestResizeObserver.resize(retained);
    });
    const keys = Array.from({ length: 30 }, (_, index) => `other-${index}`);
    view.rerender(<List keys={[...keys, "retained"]} />);
    expect(screen.queryByTestId("retained")).not.toBeInTheDocument();
    expect(screen.getByTestId("total")).toHaveTextContent("3500");
  });

  it("continues measuring rows after StrictMode effect replay", () => {
    render(
      <StrictMode>
        <List keys={["first", "second"]} />
      </StrictMode>,
    );
    const first = screen.getByTestId("first");
    act(() => {
      first.dataset.height = "180";
      TestResizeObserver.resize(first);
    });
    expect(screen.getByTestId("total")).toHaveTextContent("280");
    expect(screen.getByTestId("second")).toHaveTextContent("180");
  });
});
