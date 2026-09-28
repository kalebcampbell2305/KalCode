import type { KalVoiceSignal } from "@kalcode/protocol";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { registerDictationSink } from "./dictation.ts";
import { KalVoiceProvider, useKalVoice } from "./KalVoiceProvider.tsx";

const mocks = vi.hoisted(() => ({
  signal: null as ((signal: KalVoiceSignal) => void) | null,
  talk: vi.fn(),
  navigate: vi.fn(),
  client: {
    subscribeKalVoice: vi.fn(),
    renewKalVoiceSubscription: vi.fn().mockResolvedValue(undefined),
    kalvoiceStatus: vi.fn().mockResolvedValue(null),
    kalvoiceLatencyRecord: vi.fn().mockResolvedValue(undefined),
    kalvoiceTypeInstead: vi.fn().mockResolvedValue(false),
  },
  toast: { show: vi.fn() },
}));
vi.mock("../runtime/RuntimeProvider.tsx", () => ({
  useRuntime: () => ({ client: { ...mocks.client, kalvoiceTalk: mocks.talk } }),
}));
vi.mock("../runtime/WorkspaceProvider.tsx", () => ({ useWorkspaces: () => ({ active: { id: "workspace" } }) }));
vi.mock("../runtime/uiIntents.tsx", () => ({ useUiIntents: () => ({ focus: vi.fn() }) }));
vi.mock("../shell/navigation.tsx", () => ({ useNavigation: () => ({ current: "code", navigate: mocks.navigate }) }));
vi.mock("../shell/rail/search/SearchProvider.tsx", () => ({ useOptionalSearch: () => null }));
vi.mock("../surfaces/permissions/index.ts", () => ({ usePermissions: () => ({}) }));
vi.mock("@kalcode/ui/components", () => ({ useToast: () => mocks.toast }));

function Probe() {
  const { state, typeInstead } = useKalVoice();
  return (
    <div>
      <output data-testid="kalvoice-state">
        {state.phase}: {state.message}
      </output>
      <button type="button" onClick={() => void typeInstead()}>
        Type instead
      </button>
    </div>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.signal = null;
  mocks.client.subscribeKalVoice.mockImplementation(async (signal) => {
    mocks.signal = signal;
    return () => undefined;
  });
  mocks.talk.mockResolvedValue({ route: "dictation", response: null, recognizedMs: 1 });
});

function destination(providerId: string, account = "work") {
  const element = document.createElement("textarea");
  document.body.append(element);
  const deliver = vi.fn().mockResolvedValue(undefined);
  const unregister = registerDictationSink(element, {
    destination: {
      kind: "provider_pane",
      providerId,
      providerAccountId: account,
      threadId: `${providerId}-${account}`,
    },
    label: `${providerId} ${account}`,
    deliver,
  });
  return {
    element,
    deliver,
    dispose: () => {
      unregister();
      element.remove();
    },
  };
}

async function start() {
  const view = render(
    <KalVoiceProvider>
      <Probe />
    </KalVoiceProvider>,
  );
  await waitFor(() => expect(mocks.signal).not.toBeNull());
  return view;
}

function capture() {
  act(() => mocks.signal?.({ kind: "listening_started", sessionId: "capture", mode: "talk" }));
}

async function transcript(text: string) {
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

it.each(["claude-code", "codex", "gemini-cli"])(
  "keeps %s dictation on the captured account/session after focus switches",
  async (providerId) => {
    const first = destination(providerId);
    const later = destination(providerId === "codex" ? "claude-code" : "codex", "personal");
    try {
      const view = await start();
      act(() => first.element.focus());
      capture();
      act(() => later.element.focus());
      await transcript("Review the authentication implementation.");
      expect(first.deliver).toHaveBeenCalledExactlyOnceWith(
        "Review the authentication implementation.",
        expect.any(Object),
      );
      expect(later.deliver).not.toHaveBeenCalled();
      expect(mocks.talk).toHaveBeenCalledWith(
        expect.objectContaining({ target: "terminal", workspaceId: "workspace" }),
      );
      expect(view.getByTestId("kalvoice-state")).toHaveTextContent("done:");
      // Provider output belongs to its session; it is not a KalVoice signal.
      first.element.value = "You've hit your weekly limit";
      expect(view.getByTestId("kalvoice-state")).not.toHaveTextContent("weekly limit");
    } finally {
      first.dispose();
      later.dispose();
    }
  },
);

it.each(["dashboard", "browser"])(
  "applies a local %s directive without sending text to the focused provider",
  async (surface) => {
    const provider = destination("claude-code");
    try {
      mocks.talk.mockImplementation(async (request) => ({
        route: "command",
        recognizedMs: 1,
        response: {
          requestId: request.requestId,
          outcome: { kind: "completed", summary: `Opened ${surface}.` },
          directive: { kind: "navigate", surface },
        },
      }));
      await start();
      act(() => provider.element.focus());
      capture();
      await transcript(`Open ${surface}`);
      expect(mocks.navigate).toHaveBeenCalledWith(surface);
      expect(provider.deliver).not.toHaveBeenCalled();
    } finally {
      provider.dispose();
    }
  },
);

it("attributes delivery failure to its provider destination without copying provider error prose into KalVoice", async () => {
  const provider = destination("claude-code");
  provider.deliver.mockRejectedValue(new Error("You've hit your weekly limit"));
  try {
    const view = await start();
    act(() => provider.element.focus());
    capture();
    await transcript("Review the implementation");
    expect(view.getByTestId("kalvoice-state")).toHaveTextContent("claude-code work couldn't accept the dictated text");
    expect(view.getByTestId("kalvoice-state")).not.toHaveTextContent("weekly limit");
  } finally {
    provider.dispose();
  }
});

it("does not promise a refund when an account-counted command is typed instead", async () => {
  const provider = destination("codex");
  try {
    mocks.talk.mockImplementation(async (request) => ({
      route: "command",
      recognizedMs: 1,
      response: {
        requestId: request.requestId,
        counted: true,
        outcome: { kind: "completed", summary: "Opened dashboard." },
        directive: { kind: "navigate", surface: "dashboard" },
      },
    }));
    const view = await start();
    act(() => provider.element.focus());
    capture();
    await transcript("Open dashboard");
    fireEvent.click(view.getByRole("button", { name: "Type instead" }));
    await waitFor(() => expect(mocks.client.kalvoiceTypeInstead).toHaveBeenCalledOnce());
    expect(provider.deliver).toHaveBeenCalledExactlyOnceWith("Open dashboard", expect.any(Object));
    expect(view.getByTestId("kalvoice-state")).toHaveTextContent("Its KalVoice Request remains counted.");
  } finally {
    provider.dispose();
  }
});
