// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Activity } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import type { WidgetDefinition } from "./registry.tsx";
import { WidgetFrame } from "./WidgetFrame.tsx";

const widget: WidgetDefinition = {
  id: "sample",
  title: "Sample widget",
  anchor: "sample-widget",
  description: "Sample activity",
  icon: Activity,
  Body: () => <p>Activity</p>,
  defaultHeight: 200,
  defaultVisible: true,
};

function pointer(target: HTMLElement, type: string, clientY = 100) {
  const event = new MouseEvent(type, { bubbles: true, button: 0, clientY });
  Object.defineProperty(event, "pointerId", { value: 1 });
  fireEvent(target, event);
}

function captureApi(target: HTMLElement) {
  Object.assign(target, {
    setPointerCapture: vi.fn(),
    hasPointerCapture: vi.fn(() => false),
    releasePointerCapture: vi.fn(),
  });
}

function mount() {
  const onMove = vi.fn();
  const onResize = vi.fn();
  const { container } = render(
    <WidgetFrame
      widget={widget}
      height={200}
      index={0}
      total={2}
      onMove={onMove}
      onResize={onResize}
      onHide={vi.fn()}
      indexAt={() => 1}
    />,
  );
  return { frame: container.querySelector("[data-widget-id]"), onMove, onResize };
}

describe("WidgetFrame pointer lifecycle", () => {
  it("stops moving when the drag handle loses pointer capture", () => {
    const { frame, onMove } = mount();
    const handle = screen.getByRole("button", { name: "Move Sample widget" });
    captureApi(handle);
    pointer(handle, "pointerdown");
    expect(frame).toHaveAttribute("data-dragging", "true");
    pointer(handle, "pointermove");
    expect(onMove).toHaveBeenCalledWith(1);
    onMove.mockClear();
    act(() => {
      pointer(handle, "lostpointercapture");
      pointer(handle, "pointermove");
    });
    expect(onMove).not.toHaveBeenCalled();
    expect(frame).not.toHaveAttribute("data-dragging");
  });

  it("stops resizing after capture loss and allows a new resize", () => {
    const { frame, onResize } = mount();
    const handle = screen.getByRole("separator", { name: "Resize Sample widget" });
    captureApi(handle);
    pointer(handle, "pointerdown");
    expect(frame).toHaveAttribute("data-resizing", "true");
    pointer(handle, "lostpointercapture");
    pointer(handle, "pointermove", 250);
    expect(onResize).not.toHaveBeenCalled();
    expect(frame).not.toHaveAttribute("data-resizing");
    pointer(handle, "pointerdown");
    pointer(handle, "pointermove", 150);
    expect(onResize).toHaveBeenCalledWith(250);
    pointer(handle, "pointerup");
    expect(frame).not.toHaveAttribute("data-resizing");
  });
});
