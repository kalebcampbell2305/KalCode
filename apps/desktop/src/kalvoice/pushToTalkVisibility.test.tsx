import type { KalVoiceSignal, KalVoiceStatus, SurfaceFlag } from "@kalcode/protocol";
import { ToastProvider, TooltipProvider } from "@kalcode/ui/components";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Fragment, StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountProvider } from "../account/AccountProvider.tsx";
import { AccountClient } from "../ipc/account.ts";
import { KalCodeClient } from "../ipc/client.ts";
import { createMemoryTransport } from "../ipc/memoryTransport.ts";
import { RuntimeProvider } from "../runtime/RuntimeProvider.tsx";
import nativeStableSurfaces from "../shell/fixtures/stable-native-surfaces.json";
import { Shell } from "../shell/Shell.tsx";

// Push to talk from the whole shell (Stable flags, memory runtime): the key must always produce
// something visible, and "Ready" must mean the native key is really registered.
vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  // jsdom has no pointer capture; the widget's drag handlers use it.
  for (const name of ["setPointerCapture", "releasePointerCapture"] as const) {
    Element.prototype[name] ??= () => undefined;
  }
  Element.prototype.hasPointerCapture ??= () => false;
  // The memory recognizer "hears" this transcript: a local command, no provider needed.
  window.history.replaceState(null, "", "/?transcript=open%20settings");
});
afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

interface MountOptions {
  statusPatch?: () => Partial<KalVoiceStatus>;
  strict?: boolean;
  /** Native `kalvoice_status` refuses (e.g. the KalVoice runtime did not start). */
  statusFailure?: object;
}

async function mount({ statusPatch, strict = false, statusFailure }: MountOptions = {}) {
  const transport = createMemoryTransport("account-ready", { detectDelayMs: 0 });
  let deliver: ((signal: KalVoiceSignal) => void) | null = null;
  const nativeSubscribe = transport.subscribeKalVoice.bind(transport);
  const subscribe = vi.fn(async (onSignal: (signal: KalVoiceSignal) => void) => {
    deliver = onSignal;
    await nativeSubscribe(onSignal);
  });
  transport.subscribeKalVoice = subscribe;
  if (statusPatch || statusFailure) {
    const invoke = transport.invoke.bind(transport);
    transport.invoke = (async (command: string, args?: Record<string, unknown>) => {
      if (statusFailure && command === "kalvoice_status") throw statusFailure;
      const result = await invoke(command as never, args);
      return command === "kalvoice_status" || command === "kalvoice_update_preferences"
        ? { ...(result as object), ...statusPatch?.() }
        : result;
    }) as typeof transport.invoke;
  }
  const client = new KalCodeClient(transport);
  const boot = await client.boot();
  boot.info.channel = "stable";
  boot.info.flags.surfaces = (nativeStableSurfaces as SurfaceFlag[]).map((flag) => ({ ...flag }));
  boot.info.flags.features = boot.info.flags.features.map((flag) => ({ ...flag, visible: flag.state === "available" }));
  const Root = strict ? StrictMode : Fragment;
  render(
    <Root>
      <ToastProvider>
        <TooltipProvider>
          <AccountProvider client={new AccountClient(transport)}>
            <RuntimeProvider client={client} info={boot.info} initialSettings={await client.getSettings()}>
              <Shell />
            </RuntimeProvider>
          </AccountProvider>
        </TooltipProvider>
      </ToastProvider>
    </Root>,
  );
  const user = userEvent.setup();
  if (!statusFailure) await screen.findByRole("region", { name: "KalVoice widget" });
  const primary = within(screen.getByRole("navigation", { name: "Primary" }));
  const go = async (name: string) => {
    await user.click(primary.getByRole("button", { name }));
  };
  const inject = (signal: KalVoiceSignal) => act(() => deliver?.(signal));
  return { transport, subscribe, user, go, inject };
}

const widget = () => screen.getByRole("region", { name: "KalVoice widget" });
const widgetState = async (label: string) =>
  waitFor(() => expect(within(widget()).getByText(label, { selector: "span" })).toBeInTheDocument());
const press = () => fireEvent.keyDown(window, { code: "F8", key: "F8" });
const release = () => fireEvent.keyUp(window, { code: "F8", key: "F8" });

describe("push to talk is always visible", () => {
  it("keeps exactly one live subscription across navigation, page mount/unmount and dialogs", async () => {
    const { subscribe, user, go } = await mount();
    await go("KalVoice");
    await go("Settings");
    await screen.findByText("Speech model");
    // A download consent dialog opens and closes over Settings.
    const download = screen.getAllByRole("button", { name: "Download" })[0];
    if (!download) throw new Error("no downloadable speech model");
    await user.click(download);
    await screen.findByRole("alertdialog");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await go("Dashboard");
    await go("Threads");
    await go("KalVoice");
    await go("Settings");
    expect(subscribe).toHaveBeenCalledTimes(1);

    press();
    await widgetState("Listening");
    release();
    await widgetState("Processing");
  });

  it("StrictMode remounts add listeners but never a second native channel", async () => {
    const { subscribe, go } = await mount({ strict: true });
    await go("Threads");
    expect(subscribe).toHaveBeenCalledTimes(1);
    press();
    await widgetState("Listening");
    release();
    await widgetState("Processing");
  });

  it.each(["Dashboard", "Threads", "Settings"])("shows Listening, Processing and the result from %s", async (page) => {
    const { go } = await mount();
    await go(page);
    press();
    await widgetState("Listening");
    release();
    await widgetState("Processing");
    await widgetState("Done");
    expect(widget()).toHaveTextContent(/settings/i);
  });

  it("shows an actionable listening failure even when the widget is hidden", async () => {
    const { transport, user, go } = await mount();
    await go("Dashboard");
    await user.click(within(widget()).getByRole("button", { name: /Hide the widget/ }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "KalVoice widget" })).toBeNull());
    // The speech model disappears behind the UI's back: the native side refuses to listen.
    await transport.invoke("kalvoice_model_delete", { modelId: "tiny.en" });
    press();
    const alert = await screen.findByRole("alert", { name: "Push to talk" });
    expect(alert).toHaveTextContent("Download a speech model");
    await user.click(within(alert).getByRole("button", { name: "Set up speech" }));
    expect(await screen.findByText("Speech model")).toBeInTheDocument();
  });

  it("shows native microphone and listening progress when collapsed to the orb or hidden", async () => {
    const { user, inject } = await mount();
    await user.click(within(widget()).getByRole("button", { name: "Collapse to the orb" }));
    press();
    const activity = await screen.findByRole("status", { name: "Push to talk" });
    await waitFor(() => expect(activity).toHaveTextContent("Listening"));
    release();
    await waitFor(() => expect(screen.getByRole("status", { name: "Push to talk" })).toHaveTextContent("Processing"));
    await waitFor(() => expect(screen.queryByRole("status", { name: "Push to talk" })).toBeNull(), { timeout: 6000 });

    inject({
      kind: "listening_failed",
      sessionId: null,
      mode: "talk",
      code: "microphone_denied",
      message: "Microphone access is blocked. In system privacy settings, allow KalCode to use the microphone.",
    });
    const alert = await screen.findByRole("alert", { name: "Push to talk" });
    expect(alert).toHaveTextContent("Microphone access is blocked");
    await user.click(within(alert).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(screen.queryByRole("alert", { name: "Push to talk" })).toBeNull());
  }, 15_000);
});

describe("push-to-talk readiness is truthful", () => {
  it("never says Ready while the talk key is unregistered, and shows the OS reason everywhere", async () => {
    let patch: Partial<KalVoiceStatus> = {
      talkKeyActive: false,
      shortcutIssues: [
        { mode: "talk", accelerator: "F8", message: "Another app is using this key. Choose a different one." },
      ],
    };
    const { go } = await mount({ statusPatch: () => patch });
    await widgetState("Key unavailable");
    expect(within(widget()).queryByText("Ready", { selector: "span" })).toBeNull();
    expect(widget()).toHaveTextContent("F8 unavailable: Another app is using this key.");

    await go("Settings");
    const readiness = await screen.findByRole("status", { name: "Push-to-talk readiness" });
    expect(readiness).toHaveTextContent("F8 unavailable: Another app is using this key.");
    expect(readiness).not.toHaveTextContent(/^Ready/);

    await go("KalVoice");
    const tile = screen.getByText("Push to talk", { selector: "p" }).closest("li");
    expect(tile).toHaveTextContent("Key unavailable");
    expect(tile).not.toHaveTextContent("Ready");

    // Registered once KalCode is in front: a window focus re-reads native status.
    patch = { talkKeyActive: false, shortcutIssues: [] };
    fireEvent.focus(window);
    await waitFor(() => expect(tile).toHaveTextContent("Key not active"));
    patch = {};
    fireEvent.focus(window);
    await waitFor(() => expect(tile).toHaveTextContent("Ready"));
    await widgetState("Ready");
  });

  it("says why when native KalVoice never started, instead of an invisible widget", async () => {
    const { go } = await mount({
      statusFailure: {
        category: "internal",
        code: "kalvoice_unavailable",
        message: "KalVoice Requests need a verified KalCode account.",
        retryable: false,
      },
    });
    const notice = await screen.findByRole("status", { name: "Push to talk" });
    expect(notice).toHaveTextContent("KalVoice: Unavailable");
    expect(notice).toHaveTextContent("KalVoice Requests need a verified KalCode account.");
    expect(within(notice).getByRole("button", { name: "Try again" })).toBeInTheDocument();
    await go("KalVoice");
    const status = await screen.findByText(/KalVoice status couldn.t be read/);
    expect(status).toHaveTextContent("verified KalCode account");
    expect(screen.queryByText("Ready")).toBeNull();
  });
});
