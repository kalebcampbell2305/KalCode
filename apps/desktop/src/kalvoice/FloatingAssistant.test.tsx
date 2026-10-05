import type { KalVoiceStatus } from "@kalcode/protocol";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryKalVoice } from "../ipc/memoryKalVoice.ts";
import { INITIAL_STATE } from "./assistantState.ts";
import { FloatingAssistant, MAX_ORB_LISTENING_MS } from "./FloatingAssistant.tsx";

const seams = vi.hoisted(() => ({ value: {} as Record<string, unknown>, navigate: vi.fn() }));
vi.mock("./KalVoiceProvider.tsx", () => ({ useKalVoice: () => seams.value }));
vi.mock("../shell/navigation.tsx", () => ({ useNavigation: () => ({ navigate: seams.navigate }) }));

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.setPointerCapture ??= () => undefined;
  Element.prototype.releasePointerCapture ??= () => undefined;
  Element.prototype.hasPointerCapture ??= () => false;

  const voice = createMemoryKalVoice(() => undefined, "");
  const status = voice.handlers.kalvoice_status?.({}) as KalVoiceStatus;
  seams.navigate.mockReset();
  seams.value = {
    status,
    statusError: null,
    signalsError: null,
    talkKey: { active: true, reason: null, accelerator: "F8" },
    state: INITIAL_STATE,
    panel: { visible: true, view: "compact", anchor: "top", x: 500, y: 0 },
    setPanel: vi.fn(),
    setPanelVisible: vi.fn(),
    levelRef: { current: 0 },
    startListening: vi.fn().mockResolvedValue(undefined),
    stopListening: vi.fn().mockResolvedValue(undefined),
    retryConnection: vi.fn().mockResolvedValue(undefined),
    dismiss: vi.fn(),
    canTypeInstead: false,
    showResult: () => undefined,
  };
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function mount() {
  render(
    <>
      <button type="button">Outside the orb</button>
      <FloatingAssistant />
    </>,
  );
  return {
    orb: screen.getByRole("button", { name: "Hold to talk" }),
    outside: screen.getByRole("button", { name: "Outside the orb" }),
    start: seams.value.startListening as ReturnType<typeof vi.fn>,
    stop: seams.value.stopListening as ReturnType<typeof vi.fn>,
  };
}

it("commits the latest drag point when move and release arrive before a render", () => {
  mount();
  const handle = screen.getByRole("button", { name: "Move the widget" });
  fireEvent.pointerDown(handle, { button: 0, pointerId: 23, clientX: 500, clientY: 100 });
  act(() => {
    fireEvent.pointerMove(handle, { pointerId: 23, clientX: 600, clientY: 300 });
    fireEvent.pointerMove(handle, { pointerId: 23, clientX: -1000, clientY: -1000 });
    fireEvent.pointerUp(handle, { button: 0, pointerId: 23 });
  });
  expect(seams.value.setPanel).toHaveBeenCalledExactlyOnceWith({ anchor: "top_left", x: 0, y: 0 });
});

describe("KalVoice orb hold", () => {
  it("ends listening when the pointer is released off the orb", () => {
    const { orb, outside, start, stop } = mount();
    fireEvent.pointerDown(orb, { button: 0, pointerId: 7 });
    expect(start).toHaveBeenCalledOnce();

    fireEvent.pointerUp(outside, { button: 0, pointerId: 7 });
    expect(stop).toHaveBeenCalledOnce();
  });

  it("ends listening when the pointer is cancelled", () => {
    const { orb, outside, stop } = mount();
    fireEvent.pointerDown(orb, { button: 0, pointerId: 11 });

    fireEvent.pointerCancel(outside, { pointerId: 11 });
    expect(stop).toHaveBeenCalledOnce();
  });

  it("ends listening when the orb loses pointer capture", () => {
    const { orb, stop } = mount();
    fireEvent.pointerDown(orb, { button: 0, pointerId: 17 });

    fireEvent.lostPointerCapture(orb, { pointerId: 17 });
    expect(stop).toHaveBeenCalledOnce();
  });

  it("ends a pointer or keyboard hold when the window loses focus", () => {
    const { orb, start, stop } = mount();
    fireEvent.pointerDown(orb, { button: 0, pointerId: 19 });
    fireEvent.blur(window);
    expect(stop).toHaveBeenCalledOnce();

    fireEvent.keyDown(orb, { key: " " });
    expect(start).toHaveBeenCalledTimes(2);
    fireEvent.blur(window);
    expect(stop).toHaveBeenCalledTimes(2);
    fireEvent.pointerUp(orb, { button: 0, pointerId: 19 });
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it("stops listening at the native 120-second recording limit", () => {
    vi.useFakeTimers();
    const { orb, stop } = mount();
    fireEvent.pointerDown(orb, { button: 0, pointerId: 13 });

    act(() => vi.advanceTimersByTime(MAX_ORB_LISTENING_MS - 1));
    expect(stop).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(stop).toHaveBeenCalledOnce();
  });
});
