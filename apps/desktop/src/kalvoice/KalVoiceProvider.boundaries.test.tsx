import type { KalVoiceSignal } from "@kalcode/protocol";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { registerDictationSink } from "./dictation.ts";
import { KalVoiceProvider, useKalVoice } from "./KalVoiceProvider.tsx";

const mocks = vi.hoisted(() => ({
  signal: null as ((signal: KalVoiceSignal) => void) | null,
  talk: vi.fn(),
  request: vi.fn(),
  navigate: vi.fn(),
  client: {
    subscribeKalVoice: vi.fn(),
    renewKalVoiceSubscription: vi.fn().mockResolvedValue(undefined),
    kalvoiceStatus: vi.fn().mockResolvedValue(null),
    kalvoiceLatencyRecord: vi.fn().mockResolvedValue(undefined),
    kalvoiceTypeInstead: vi.fn().mockResolvedValue(false),
    kalvoiceListenCancel: vi.fn().mockResolvedValue(undefined),
  },
  toast: { show: vi.fn() },
}));
vi.mock("../runtime/RuntimeProvider.tsx", () => {
  const client = { ...mocks.client, kalvoiceRequest: mocks.request, kalvoiceTalk: mocks.talk };
  return { useRuntime: () => ({ client }) };
});
vi.mock("../runtime/WorkspaceProvider.tsx", () => ({ useWorkspaces: () => ({ active: { id: "workspace" } }) }));
vi.mock("../runtime/uiIntents.tsx", () => ({ useUiIntents: () => ({ focus: vi.fn() }) }));
vi.mock("../shell/navigation.tsx", () => ({ useNavigation: () => ({ current: "code", navigate: mocks.navigate }) }));
vi.mock("../shell/rail/search/SearchProvider.tsx", () => ({ useOptionalSearch: () => null }));
vi.mock("../surfaces/permissions/index.ts", () => ({ usePermissions: () => ({}) }));
vi.mock("@kalcode/ui/components", () => ({ useToast: () => mocks.toast }));

function Probe() {
  const { cancel, state, submit, typeInstead } = useKalVoice();
  return (
    <div>
      <output data-testid="kalvoice-state">
        {state.phase}: {state.message}
      </output>
      <button type="button" onClick={() => void typeInstead()}>
        Type instead
      </button>
      <button type="button" onClick={() => void submit("open dashboard")}>
        Submit replacement
      </button>
      <button type="button" onClick={() => void submit("explain the current state")}>
        Ask native
      </button>
      <button type="button" onClick={() => void cancel()}>
        Cancel
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
  const submit = vi.fn().mockResolvedValue(undefined);
  const unregister = registerDictationSink(element, {
    destination: {
      kind: "provider_pane",
      providerId,
      providerAccountId: account,
      threadId: `${providerId}-${account}`,
      instanceId: `${providerId}-${account}-instance`,
    },
    label: `${providerId} ${account}`,
    deliver,
    submit,
  });
  return {
    element,
    deliver,
    submit,
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

function capture(sessionId = "capture") {
  act(() => mocks.signal?.({ kind: "listening_started", sessionId, mode: "talk" }));
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

it("Type inserts verbatim without sending or routing the embedded navigation words", async () => {
  const provider = destination("codex");
  try {
    await start();
    act(() => provider.element.focus());
    capture();
    await transcript("Type Open Dashboard and explain it.");
    expect(mocks.talk).not.toHaveBeenCalled();
    expect(provider.deliver).toHaveBeenCalledWith(
      "Open Dashboard and explain it.",
      expect.objectContaining({ mode: "insert" }),
    );
  } finally {
    provider.dispose();
  }
});

it("routes and cancels normally when the WebKit runtime has no AbortSignal.any", async () => {
  const nativeAny = Object.getOwnPropertyDescriptor(AbortSignal, "any");
  Object.defineProperty(AbortSignal, "any", { configurable: true, value: undefined, writable: true });
  const provider = destination("codex");
  try {
    await start();
    act(() => provider.element.focus());
    capture();
    await transcript("Review the compatibility path.");

    await waitFor(() => expect(provider.deliver).toHaveBeenCalledOnce());
    capture("replacement");
    const options = provider.deliver.mock.calls[0]?.[1] as { signal?: AbortSignal };
    expect(options.signal?.aborted).toBe(true);
  } finally {
    provider.dispose();
    if (nativeAny) Object.defineProperty(AbortSignal, "any", nativeAny);
  }
});

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
        expect.objectContaining({
          target: "provider_pane",
          workspaceId: "workspace",
          threadId: `${providerId}-work`,
        }),
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

it.each(["compose_in_thread", "submit_composer"] as const)(
  "cancels a queued provider %s directive before its native send",
  async (kind) => {
    const provider = destination("claude-code");
    const nativeSend = vi.fn();
    let queuedSignal: AbortSignal | undefined;
    let releaseQueue!: () => void;
    const queued = kind === "compose_in_thread" ? provider.deliver : provider.submit;
    queued.mockImplementation((...args: unknown[]) => {
      const options = args.at(-1) as { signal?: AbortSignal };
      queuedSignal = options.signal;
      return new Promise<void>((resolve) => {
        releaseQueue = () => {
          if (!options.signal?.aborted) nativeSend();
          resolve();
        };
      });
    });
    mocks.talk.mockImplementation(async (request) => ({
      route: "command",
      recognizedMs: 1,
      response: {
        requestId: request.requestId,
        outcome: { kind: "completed", summary: "Provider action queued." },
        directive:
          kind === "compose_in_thread"
            ? {
                kind,
                threadId: "claude-code-work",
                text: "Review the release.",
                submit: true,
              }
            : { kind, threadId: "claude-code-work" },
      },
    }));

    try {
      await start();
      act(() => provider.element.focus());
      capture();
      await transcript("Send the provider action");
      await waitFor(() => expect(queued).toHaveBeenCalledOnce());

      capture("replacement");
      expect(queuedSignal?.aborted).toBe(true);
      releaseQueue();

      expect(nativeSend).not.toHaveBeenCalled();
    } finally {
      provider.dispose();
    }
  },
);

it("keeps native talk exclusive and preserves its final truth when replacement and Escape race it", async () => {
  const provider = destination("claude-code");
  let finishTalk!: () => void;
  mocks.talk.mockImplementation(
    (request) =>
      new Promise((resolve) => {
        finishTalk = () =>
          resolve({
            route: "command",
            recognizedMs: 1,
            response: {
              requestId: request.requestId,
              outcome: { kind: "completed", summary: "Native action finished." },
              directive: { kind: "navigate", surface: "browser" },
            },
          });
      }),
  );

  try {
    const view = await start();
    act(() => provider.element.focus());
    capture();
    await transcript("Run the native action");
    await waitFor(() => expect(mocks.talk).toHaveBeenCalledOnce());

    capture("replacement");
    fireEvent.click(view.getByRole("button", { name: "Submit replacement" }));
    fireEvent.keyDown(window, { key: "Escape" });

    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(view.getByTestId("kalvoice-state")).toHaveTextContent("thinking:");
    expect(view.getByTestId("kalvoice-state")).not.toHaveTextContent("Cancelled");

    await act(async () => finishTalk());

    await waitFor(() => expect(view.getByTestId("kalvoice-state")).toHaveTextContent("done: Native action finished."));
    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith("browser");
    expect(mocks.talk).toHaveBeenCalledOnce();
  } finally {
    provider.dispose();
  }
});

it("keeps a typed native request exclusive and preserves its final truth", async () => {
  let finishRequest!: () => void;
  mocks.request.mockImplementation(
    (request) =>
      new Promise((resolve) => {
        finishRequest = () =>
          resolve({
            requestId: request.requestId,
            outcome: { kind: "completed", summary: "Typed native request finished." },
            directive: { kind: "navigate", surface: "threads" },
          });
      }),
  );

  const view = await start();
  fireEvent.click(view.getByRole("button", { name: "Ask native" }));
  await waitFor(() => expect(mocks.request).toHaveBeenCalledOnce());

  capture("replacement");
  fireEvent.click(view.getByRole("button", { name: "Submit replacement" }));
  fireEvent.click(view.getByRole("button", { name: "Cancel" }));

  expect(mocks.navigate).not.toHaveBeenCalled();
  expect(view.getByTestId("kalvoice-state")).toHaveTextContent("thinking:");
  expect(view.getByTestId("kalvoice-state")).not.toHaveTextContent("Cancelled");

  await act(async () => finishRequest());

  await waitFor(() =>
    expect(view.getByTestId("kalvoice-state")).toHaveTextContent("done: Typed native request finished."),
  );
  expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith("threads");
  expect(mocks.request).toHaveBeenCalledOnce();
});

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
    expect(provider.deliver).toHaveBeenCalledExactlyOnceWith(
      "Open dashboard",
      expect.objectContaining({ mode: "insert" }),
    );
    expect(view.getByTestId("kalvoice-state")).toHaveTextContent("Its KalVoice Request remains counted.");
  } finally {
    provider.dispose();
  }
});
