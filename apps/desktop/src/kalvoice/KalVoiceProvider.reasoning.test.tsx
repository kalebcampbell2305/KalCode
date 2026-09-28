import type { KalVoiceSignal, KalVoiceStatus } from "@kalcode/protocol";
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { createMemoryKalVoice } from "../ipc/memoryKalVoice.ts";
import { KalVoiceProvider, useKalVoice } from "./KalVoiceProvider.tsx";

const mocks = vi.hoisted(() => ({
  signal: null as ((signal: KalVoiceSignal) => void) | null,
  client: {
    subscribeKalVoice: vi.fn(),
    renewKalVoiceSubscription: vi.fn().mockResolvedValue(undefined),
    kalvoiceStatus: vi.fn(),
    kalvoiceLatencyRecord: vi.fn().mockResolvedValue(undefined),
  },
  toast: { show: vi.fn() },
}));
vi.mock("../runtime/RuntimeProvider.tsx", () => ({ useRuntime: () => ({ client: mocks.client }) }));
vi.mock("../runtime/WorkspaceProvider.tsx", () => ({ useWorkspaces: () => ({ active: null }) }));
vi.mock("../runtime/uiIntents.tsx", () => ({ useUiIntents: () => ({ focus: vi.fn() }) }));
vi.mock("../shell/navigation.tsx", () => ({ useNavigation: () => ({ current: "kalvoice", navigate: vi.fn() }) }));
vi.mock("../shell/rail/search/SearchProvider.tsx", () => ({ useOptionalSearch: () => null }));
vi.mock("../surfaces/permissions/index.ts", () => ({ usePermissions: () => ({}) }));
vi.mock("@kalcode/ui/components", () => ({ useToast: () => mocks.toast }));

function baseStatus(localReasoning: KalVoiceStatus["localReasoning"]): KalVoiceStatus {
  const voice = createMemoryKalVoice(() => undefined, "");
  return { ...(voice.handlers.kalvoice_status?.({}) as KalVoiceStatus), localReasoning };
}

function Probe() {
  const { status } = useKalVoice();
  return (
    <output data-testid="reasoning">
      {status ? `${status.localReasoning}:${status.localReasoningIssue ?? ""}` : "none"}
    </output>
  );
}

function shown() {
  return screen.getByTestId("reasoning").textContent;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.signal = null;
  mocks.client.subscribeKalVoice.mockImplementation(async (signal) => {
    mocks.signal = signal;
    return () => undefined;
  });
});

it("a page subscribed before startup follows every transition to ready", async () => {
  mocks.client.kalvoiceStatus.mockResolvedValue(baseStatus("installed"));
  render(
    <KalVoiceProvider>
      <Probe />
    </KalVoiceProvider>,
  );
  await waitFor(() => expect(shown()).toBe("installed:"));
  act(() => mocks.signal?.({ kind: "local_reasoning_status", status: "waiting", issue: "resource_monitor_starting" }));
  expect(shown()).toBe("waiting:resource_monitor_starting");
  act(() => mocks.signal?.({ kind: "local_reasoning_status", status: "warming" }));
  expect(shown()).toBe("warming:");
  act(() => mocks.signal?.({ kind: "local_reasoning_status", status: "ready" }));
  expect(shown()).toBe("ready:");
});

it("a status read computed before the ready signal cannot undo it", async () => {
  // Native answers subscribe with the current state; a status read issued earlier can still
  // resolve afterwards. The newer signal wins, so the page never sticks at "not running".
  let resolveRead: (status: KalVoiceStatus) => void = () => undefined;
  mocks.client.kalvoiceStatus.mockImplementation(
    () =>
      new Promise<KalVoiceStatus>((resolve) => {
        resolveRead = resolve;
      }),
  );
  render(
    <KalVoiceProvider>
      <Probe />
    </KalVoiceProvider>,
  );
  await waitFor(() => expect(mocks.signal).not.toBeNull());
  act(() => mocks.signal?.({ kind: "local_reasoning_status", status: "ready" }));
  await act(async () => resolveRead(baseStatus("installed")));
  await waitFor(() => expect(shown()).toBe("ready:"));
});
