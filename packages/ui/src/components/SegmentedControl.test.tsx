import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { type ReactNode, StrictMode, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SegmentedControl } from "./SegmentedControl.tsx";

const OPTIONS = [
  { value: "system", label: "System" },
  { value: "custom", label: "Custom" },
];

function mount(ui: ReactNode) {
  return render(ui, { wrapper: StrictMode });
}

function radio(group: string, name: string) {
  return within(screen.getByRole("radiogroup", { name: group })).getByRole("radio", { name });
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("SegmentedControl", () => {
  it("does not apply another group's focused value after an arrow", () => {
    const themeChange = vi.fn();
    mount(
      <>
        <SegmentedControl aria-label="Theme" value="custom" options={OPTIONS} onValueChange={themeChange} />
        <SegmentedControl aria-label="Motion" value="system" options={OPTIONS} onValueChange={() => {}} />
      </>,
    );
    act(() => radio("Theme", "Custom").focus());
    fireEvent.keyDown(radio("Theme", "Custom"), { key: "ArrowDown" });
    act(() => radio("Motion", "System").focus());
    act(() => vi.runAllTimers());
    expect(radio("Motion", "System")).toHaveFocus();
    expect(themeChange).not.toHaveBeenCalled();
    expect(radio("Theme", "Custom")).toHaveAttribute("aria-checked", "true");
  });

  it("does not report a selection after the original group is removed", () => {
    const themeChange = vi.fn();
    const content = (showTheme: boolean) => (
      <>
        {showTheme ? (
          <SegmentedControl
            key="theme"
            aria-label="Theme"
            value="custom"
            options={OPTIONS}
            onValueChange={themeChange}
          />
        ) : null}
        <SegmentedControl key="motion" aria-label="Motion" value="system" options={OPTIONS} onValueChange={() => {}} />
      </>
    );
    const { rerender } = mount(content(true));
    act(() => radio("Theme", "Custom").focus());
    fireEvent.keyDown(radio("Theme", "Custom"), { key: "ArrowRight" });
    rerender(content(false));
    act(() => radio("Motion", "System").focus());
    act(() => vi.runAllTimers());
    expect(radio("Motion", "System")).toHaveFocus();
    expect(themeChange).not.toHaveBeenCalled();
  });

  it("cancels the fallback when its group is disabled before the timer runs", () => {
    const change = vi.fn();
    const content = (disabled: boolean) => (
      <SegmentedControl
        aria-label="Theme"
        value="custom"
        options={OPTIONS}
        onValueChange={change}
        disabled={disabled}
      />
    );
    const { rerender } = mount(content(false));
    act(() => radio("Theme", "Custom").focus());
    act(() => vi.advanceTimersByTime(0));
    fireEvent.keyDown(radio("Theme", "Custom"), { key: "ArrowDown" });
    rerender(content(true));
    expect(vi.getTimerCount()).toBe(0);
    act(() => vi.runAllTimers());
    expect(change).not.toHaveBeenCalled();
    expect(radio("Theme", "Custom")).toBeDisabled();
  });

  it("cleans up pending fallback timers on unmount", () => {
    const { unmount } = mount(
      <SegmentedControl aria-label="Theme" value="custom" options={OPTIONS} onValueChange={() => {}} />,
    );
    act(() => radio("Theme", "Custom").focus());
    act(() => vi.advanceTimersByTime(0));
    fireEvent.keyDown(radio("Theme", "Custom"), { key: "ArrowDown" });
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("selects and focuses each arrow destination exactly once, including wraparound", () => {
    const change = vi.fn();
    function Controlled() {
      const [value, setValue] = useState("system");
      return (
        <SegmentedControl
          aria-label="Theme"
          value={value}
          options={OPTIONS}
          onValueChange={(next) => {
            change(next);
            setValue(next);
          }}
        />
      );
    }
    mount(<Controlled />);
    act(() => radio("Theme", "System").focus());
    for (const [key, label, value] of [
      ["ArrowRight", "Custom", "custom"],
      ["ArrowLeft", "System", "system"],
      ["ArrowLeft", "Custom", "custom"],
    ]) {
      change.mockClear();
      const focused = document.activeElement as HTMLElement;
      fireEvent.keyDown(focused, { key });
      fireEvent.keyUp(focused, { key });
      act(() => vi.runAllTimers());
      expect(radio("Theme", label ?? "")).toHaveFocus();
      expect(radio("Theme", label ?? "")).toHaveAttribute("aria-checked", "true");
      expect(change).toHaveBeenCalledExactlyOnceWith(value);
    }
  });

  it("keeps disabled options inert", () => {
    const change = vi.fn();
    mount(<SegmentedControl aria-label="Theme" value="system" options={OPTIONS} onValueChange={change} disabled />);
    fireEvent.click(radio("Theme", "Custom"));
    fireEvent.keyDown(radio("Theme", "Custom"), { key: "ArrowRight" });
    act(() => vi.runAllTimers());
    expect(change).not.toHaveBeenCalled();
    expect(radio("Theme", "System")).toHaveAttribute("aria-checked", "true");
    expect(radio("Theme", "Custom")).toBeDisabled();
  });
});
