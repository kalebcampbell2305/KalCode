import type { KalVoiceSignal } from "@kalcode/protocol";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { type KalTidyApi, KalTidyContext } from "../surfaces/code/kaltidy/kalTidyContext.ts";
import { KalVoiceProvider, useKalVoice } from "./KalVoiceProvider.tsx";

const mocks = vi.hoisted(() => {
  const talk = vi.fn();
  const request = vi.fn();
  const client = {
    subscribeKalVoice: vi.fn(),
    renewKalVoiceSubscription: vi.fn().mockResolvedValue(undefined),
    kalvoiceStatus: vi.fn().mockResolvedValue(null),
    kalvoiceLatencyRecord: vi.fn().mockResolvedValue(undefined),
    kalvoiceListenCancel: vi.fn().mockResolvedValue(undefined),
    kalvoiceTalk: talk,
    kalvoiceRequest: request,
    kalvoiceMeterUiCommand: vi.fn(async (r: { requestId: string; command: string }) => ({
      requestId: r.requestId,
      intent: `ui_${r.command}`,
      outcome: { kind: "completed", summary: "" },
      usage: { used: 1, allowance: 25, periodStart: "2026-10-01T00:00:00.000Z", resetsAt: "2026-11-01T00:00:00.000Z" },
      counted: true,
      directive: null,
    })),
  };
  return {
    signal: null as ((signal: KalVoiceSignal) => void) | null,
    voice: null as { submit: (text: string) => Promise<void> } | null,
    talk,
    request,
    navigate: vi.fn(),
    toast: { show: vi.fn() },
    client,
  };
});
vi.mock("../runtime/RuntimeProvider.tsx", () => ({
  useRuntime: () => ({ client: mocks.client }),
}));
vi.mock("../runtime/WorkspaceProvider.tsx", () => ({ useWorkspaces: () => ({ active: { id: "workspace" } }) }));
vi.mock("../runtime/uiIntents.tsx", () => ({ useUiIntents: () => ({ focus: vi.fn() }) }));
vi.mock("../shell/navigation.tsx", () => ({ useNavigation: () => ({ current: "code", navigate: mocks.navigate }) }));
vi.mock("../shell/rail/search/SearchProvider.tsx", () => ({ useOptionalSearch: () => null }));
vi.mock("../surfaces/permissions/index.ts", () => ({ usePermissions: () => ({}) }));
vi.mock("@kalcode/ui/components", () => ({ useToast: () => mocks.toast }));

function Probe() {
  const voice = useKalVoice();
  mocks.voice = voice;
  return (
    <output data-testid="kalvoice-state">
      {voice.state.phase}: {voice.state.message}
    </output>
  );
}

function kalTidyApi(): KalTidyApi {
  return {
    openReview: vi.fn(),
    stopIdle: vi.fn().mockResolvedValue({ stopped: 3, kept: 1, failed: 0, summary: "Stopped 3 idle terminals." }),
  };
}

async function start(kalTidy: KalTidyApi | null) {
  const tree = (children: ReactNode) =>
    kalTidy ? <KalTidyContext.Provider value={kalTidy}>{children}</KalTidyContext.Provider> : children;
  const view = render(
    tree(
      <KalVoiceProvider>
        <Probe />
      </KalVoiceProvider>,
    ),
  );
  await waitFor(() => expect(mocks.signal).not.toBeNull());
  return view;
}

async function say(text: string) {
  act(() => mocks.signal?.({ kind: "listening_started", sessionId: "capture", mode: "talk" }));
  await act(async () =>
    mocks.signal?.({
      kind: "result",
      timings: {
        keyDownToMic: null,
        speechToPartial: null,
        keyUpToFinal: null,
        finalToRecognized: null,
        recognizedToAction: null,
        finalSource: null,
      },
      result: { kind: "transcript", sessionId: "capture", mode: "talk", text, durationMs: 500 },
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.signal = null;
  mocks.voice = null;
  mocks.client.subscribeKalVoice.mockImplementation(async (signal) => {
    mocks.signal = signal;
    return () => undefined;
  });
  mocks.talk.mockResolvedValue({ route: "dictation", response: null, recognizedMs: 1 });
});

it('"close all idle terminals" runs KalTidy and shows its summary', async () => {
  const kalTidy = kalTidyApi();
  const view = await start(kalTidy);
  await say("Close all idle terminals.");
  expect(kalTidy.stopIdle).toHaveBeenCalledOnce();
  expect(kalTidy.openReview).not.toHaveBeenCalled();
  expect(mocks.talk).not.toHaveBeenCalled();
  expect(view.getByTestId("kalvoice-state")).toHaveTextContent("done: Stopped 3 idle terminals.");
});

it('"which terminals are idle" opens the review and stops nothing', async () => {
  const kalTidy = kalTidyApi();
  const view = await start(kalTidy);
  await say("Which terminals are idle?");
  expect(kalTidy.openReview).toHaveBeenCalledOnce();
  expect(kalTidy.stopIdle).not.toHaveBeenCalled();
  expect(mocks.talk).not.toHaveBeenCalled();
  expect(view.getByTestId("kalvoice-state")).toHaveTextContent("done: Opened KalTidy review.");
});

it("says KalTidy isn't available when it isn't mounted", async () => {
  const view = await start(null);
  await say("kill idle terminals");
  expect(mocks.talk).not.toHaveBeenCalled();
  expect(mocks.client.kalvoiceMeterUiCommand).not.toHaveBeenCalled();
  expect(view.getByTestId("kalvoice-state")).toHaveTextContent("error: KalTidy isn't available here.");
});

it("other terminal words still go to native routing", async () => {
  const kalTidy = kalTidyApi();
  await start(kalTidy);
  await say("close this terminal");
  expect(mocks.talk).toHaveBeenCalledOnce();
  expect(kalTidy.stopIdle).not.toHaveBeenCalled();
  expect(kalTidy.openReview).not.toHaveBeenCalled();
});

it("a typed request on the KalVoice page runs KalTidy too, as one KalVoice Request", async () => {
  const kalTidy = kalTidyApi();
  const view = await start(kalTidy);
  await act(async () => mocks.voice?.submit("tidy up terminals"));
  expect(kalTidy.stopIdle).toHaveBeenCalledOnce();
  expect(mocks.request).not.toHaveBeenCalled();
  expect(mocks.client.kalvoiceMeterUiCommand).toHaveBeenCalledOnce();
  expect(mocks.client.kalvoiceMeterUiCommand).toHaveBeenCalledWith(
    expect.objectContaining({ command: "kaltidy", input: "text", workspaceId: "workspace" }),
  );
  expect(view.getByTestId("kalvoice-state")).toHaveTextContent("done: Stopped 3 idle terminals.");
});

it("a spoken KalTidy command takes one KalVoice Request before it runs", async () => {
  const kalTidy = kalTidyApi();
  await start(kalTidy);
  await say("kill idle terminals");
  expect(mocks.client.kalvoiceMeterUiCommand).toHaveBeenCalledOnce();
  expect(mocks.client.kalvoiceMeterUiCommand).toHaveBeenCalledWith(
    expect.objectContaining({ command: "kaltidy", input: "voice" }),
  );
  expect(kalTidy.stopIdle).toHaveBeenCalledOnce();
});

it("KalTidy does not run once the monthly KalVoice limit is reached", async () => {
  const kalTidy = kalTidyApi();
  mocks.client.kalvoiceMeterUiCommand.mockImplementationOnce(async (r: { requestId: string; command: string }) => ({
    requestId: r.requestId,
    intent: `ui_${r.command}`,
    outcome: { kind: "limit_reached", resetsAt: "2026-11-01T00:00:00.000Z" },
    usage: { used: 25, allowance: 25, periodStart: "2026-10-01T00:00:00.000Z", resetsAt: "2026-11-01T00:00:00.000Z" },
    counted: false,
    directive: null,
  }));
  await start(kalTidy);
  await say("kill idle terminals");
  expect(kalTidy.stopIdle).not.toHaveBeenCalled();
  expect(kalTidy.openReview).not.toHaveBeenCalled();
});

it("keeps pending KalTidy cleanup exclusive and preserves its outcome", async () => {
  const kalTidy = kalTidyApi();
  let finishStop!: () => void;
  vi.mocked(kalTidy.stopIdle).mockImplementation(
    () =>
      new Promise((resolve) => {
        finishStop = () => resolve({ stopped: 2, kept: 1, failed: 0, summary: "Stopped 2 idle terminals." });
      }),
  );
  const view = await start(kalTidy);

  await say("Close all idle terminals.");
  await waitFor(() => expect(kalTidy.stopIdle).toHaveBeenCalledOnce());

  await act(async () => mocks.voice?.submit("open dashboard"));
  act(() => mocks.signal?.({ kind: "listening_started", sessionId: "replacement", mode: "talk" }));
  fireEvent.keyDown(window, { key: "Escape" });

  expect(view.getByTestId("kalvoice-state")).toHaveTextContent("thinking:");
  expect(view.getByTestId("kalvoice-state")).not.toHaveTextContent("Cancelled");
  expect(kalTidy.stopIdle).toHaveBeenCalledOnce();
  expect(mocks.request).not.toHaveBeenCalled();
  expect(mocks.talk).not.toHaveBeenCalled();
  expect(mocks.navigate).not.toHaveBeenCalled();
  expect(mocks.client.kalvoiceListenCancel).toHaveBeenCalledOnce();
  expect(mocks.toast.show).toHaveBeenCalledWith(
    expect.objectContaining({
      title: "KalVoice is already executing",
      description: "It can't be cancelled now. Wait for its final result before starting another request.",
    }),
  );

  await act(async () => finishStop());

  await waitFor(() => expect(view.getByTestId("kalvoice-state")).toHaveTextContent("done: Stopped 2 idle terminals."));
});
