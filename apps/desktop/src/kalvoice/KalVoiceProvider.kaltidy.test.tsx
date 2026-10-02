import type { KalVoiceSignal } from "@kalcode/protocol";
import { act, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { type KalTidyApi, KalTidyContext } from "../surfaces/code/kaltidy/kalTidyContext.ts";
import { KalVoiceProvider, useKalVoice } from "./KalVoiceProvider.tsx";

const mocks = vi.hoisted(() => ({
  signal: null as ((signal: KalVoiceSignal) => void) | null,
  voice: null as { submit: (text: string) => Promise<void> } | null,
  talk: vi.fn(),
  request: vi.fn(),
  client: {
    subscribeKalVoice: vi.fn(),
    renewKalVoiceSubscription: vi.fn().mockResolvedValue(undefined),
    kalvoiceStatus: vi.fn().mockResolvedValue(null),
    kalvoiceLatencyRecord: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("../runtime/RuntimeProvider.tsx", () => ({
  useRuntime: () => ({ client: { ...mocks.client, kalvoiceTalk: mocks.talk, kalvoiceRequest: mocks.request } }),
}));
vi.mock("../runtime/WorkspaceProvider.tsx", () => ({ useWorkspaces: () => ({ active: { id: "workspace" } }) }));
vi.mock("../runtime/uiIntents.tsx", () => ({ useUiIntents: () => ({ focus: vi.fn() }) }));
vi.mock("../shell/navigation.tsx", () => ({ useNavigation: () => ({ current: "code", navigate: vi.fn() }) }));
vi.mock("../shell/rail/search/SearchProvider.tsx", () => ({ useOptionalSearch: () => null }));
vi.mock("../surfaces/permissions/index.ts", () => ({ usePermissions: () => ({}) }));
vi.mock("@kalcode/ui/components", () => ({ useToast: () => ({ show: vi.fn() }) }));

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

it("a typed request on the KalVoice page runs KalTidy too, without a KalVoice Request", async () => {
  const kalTidy = kalTidyApi();
  const view = await start(kalTidy);
  await act(async () => mocks.voice?.submit("tidy up terminals"));
  expect(kalTidy.stopIdle).toHaveBeenCalledOnce();
  expect(mocks.request).not.toHaveBeenCalled();
  expect(view.getByTestId("kalvoice-state")).toHaveTextContent("done: Stopped 3 idle terminals.");
});
