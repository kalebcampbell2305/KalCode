import type { KalVoiceSignal } from "@kalcode/protocol";
import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { KalVoiceProvider, useKalVoice } from "./KalVoiceProvider.tsx";

const mocks = vi.hoisted(() => ({
  signal: null as ((signal: KalVoiceSignal) => void) | null,
  voice: null as ReturnType<typeof useKalVoice> | null,
  client: {
    subscribeKalVoice: vi.fn(),
    renewKalVoiceSubscription: vi.fn().mockResolvedValue(undefined),
    kalvoiceStatus: vi.fn().mockResolvedValue(null),
    kalvoiceLatencyRecord: vi.fn().mockResolvedValue(undefined),
    kalvoiceListenStart: vi.fn(),
    kalvoiceListenStop: vi.fn().mockResolvedValue(undefined),
    kalvoiceListenCancel: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("../runtime/RuntimeProvider.tsx", () => ({ useRuntime: () => ({ client: mocks.client }) }));
vi.mock("../runtime/WorkspaceProvider.tsx", () => ({ useWorkspaces: () => ({ active: { id: "workspace" } }) }));
vi.mock("../runtime/uiIntents.tsx", () => ({ useUiIntents: () => ({ focus: vi.fn() }) }));
vi.mock("../shell/navigation.tsx", () => ({ useNavigation: () => ({ current: "code", navigate: vi.fn() }) }));
vi.mock("../shell/rail/search/SearchProvider.tsx", () => ({ useOptionalSearch: () => null }));
vi.mock("../surfaces/permissions/index.ts", () => ({ usePermissions: () => ({}) }));
vi.mock("@kalcode/ui/components", () => ({ useToast: () => ({ show: vi.fn() }) }));

function Probe() {
  mocks.voice = useKalVoice();
  return <input aria-label="Dictation target" />;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.signal = null;
  mocks.client.subscribeKalVoice.mockImplementation(async (signal) => {
    mocks.signal = signal;
    return () => undefined;
  });
});

it("a release before the microphone opens still stops the session it started", async () => {
  let open: (sessionId: string) => void = () => undefined;
  mocks.client.kalvoiceListenStart.mockReturnValue(new Promise<string>((resolve) => (open = resolve)));
  const view = render(
    <KalVoiceProvider>
      <Probe />
    </KalVoiceProvider>,
  );
  await waitFor(() => expect(mocks.signal).not.toBeNull());
  act(() => view.getByRole("textbox", { name: "Dictation target" }).focus());

  let started: Promise<void> = Promise.resolve();
  let stopped: Promise<void> = Promise.resolve();
  act(() => {
    started = mocks.voice?.startListening() ?? started;
    stopped = mocks.voice?.stopListening() ?? stopped;
  });
  expect(mocks.client.kalvoiceListenStop).not.toHaveBeenCalled();

  await act(async () => {
    open("tap");
    await Promise.all([started, stopped]);
  });
  expect(mocks.client.kalvoiceListenStop).toHaveBeenCalledExactlyOnceWith("tap");
});

it("a failed start leaves nothing to stop", async () => {
  mocks.client.kalvoiceListenStart.mockRejectedValue(new Error("microphone unavailable"));
  render(
    <KalVoiceProvider>
      <Probe />
    </KalVoiceProvider>,
  );
  await waitFor(() => expect(mocks.signal).not.toBeNull());

  await act(async () => {
    const started = mocks.voice?.startListening();
    await mocks.voice?.stopListening();
    await started;
  });
  expect(mocks.client.kalvoiceListenStop).not.toHaveBeenCalled();
});

it("Escape cancels native startup without stealing Escape and fences a late orb start", async () => {
  let open: (sessionId: string) => void = () => undefined;
  mocks.client.kalvoiceListenStart.mockReturnValue(new Promise<string>((resolve) => (open = resolve)));
  const view = render(
    <KalVoiceProvider>
      <Probe />
    </KalVoiceProvider>,
  );
  await waitFor(() => expect(mocks.signal).not.toBeNull());

  const keyboardEscape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  act(() => window.dispatchEvent(keyboardEscape));
  expect(keyboardEscape.defaultPrevented).toBe(false);
  expect(mocks.client.kalvoiceListenCancel).toHaveBeenCalledOnce();

  act(() => view.getByRole("textbox", { name: "Dictation target" }).focus());
  let started: Promise<void> = Promise.resolve();
  act(() => {
    started = mocks.voice?.startListening() ?? started;
  });
  const orbEscape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  act(() => window.dispatchEvent(orbEscape));
  expect(orbEscape.defaultPrevented).toBe(false);
  expect(mocks.client.kalvoiceListenCancel).toHaveBeenCalledTimes(2);
  await act(async () => {
    await mocks.voice?.stopListening();
  });

  act(() => mocks.signal?.({ kind: "listening_started", sessionId: "late-orb", mode: "talk" }));
  expect(mocks.voice?.state.phase).not.toBe("listening");

  await act(async () => {
    open("late-orb");
    await started;
  });
  expect(mocks.voice?.dictationTarget).toBeNull();
  expect(mocks.voice?.state.phase).not.toBe("listening");
  expect(mocks.client.kalvoiceListenCancel).toHaveBeenLastCalledWith("late-orb");
  act(() => mocks.signal?.({ kind: "listening_started", sessionId: "late-orb", mode: "talk" }));
  expect(mocks.voice?.state.phase).not.toBe("listening");
  expect(mocks.client.kalvoiceListenStop).not.toHaveBeenCalled();
});
