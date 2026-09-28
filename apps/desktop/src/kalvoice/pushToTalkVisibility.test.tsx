import type { KalVoiceSignal, KalVoiceStatus, SurfaceFlag } from "@kalcode/protocol";
import { ToastProvider, TooltipProvider } from "@kalcode/ui/components";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Fragment, StrictMode, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountProvider, useOptionalAccount } from "../account/AccountProvider.tsx";
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
  /** Native `kalvoice_status` refuses while this returns an error (e.g. runtime not started). */
  statusFailure?: () => object | null;
  /** Native `kalvoice_subscribe` refuses while this returns an error. */
  subscribeFailure?: () => object | null;
}

/**
 * Reports the account runtime's readiness after each commit. It renders after the Shell, so its
 * effect runs after KalVoice's "runtime became ready" effect in the same commit: once it reports
 * ready, any channel renewal that transition causes has already called `kalvoice_subscribe`.
 */
function AccountReadyProbe({ onReady }: { onReady: () => void }) {
  const ready = useOptionalAccount()?.runtime.ready ?? false;
  useEffect(() => {
    if (ready) onReady();
  }, [ready, onReady]);
  return null;
}

async function mount({ statusPatch, strict = false, statusFailure, subscribeFailure }: MountOptions = {}) {
  const transport = createMemoryTransport("account-ready", { detectDelayMs: 0 });
  let deliver: ((signal: KalVoiceSignal) => void) | null = null;
  const nativeSubscribe = transport.subscribeKalVoice.bind(transport);
  const subscribe = vi.fn(async (onSignal: (signal: KalVoiceSignal) => void) => {
    const refused = subscribeFailure?.();
    if (refused) throw refused;
    deliver = onSignal;
    await nativeSubscribe(onSignal);
  });
  transport.subscribeKalVoice = subscribe;
  const invoked: string[] = [];
  {
    const invoke = transport.invoke.bind(transport);
    transport.invoke = (async (command: string, args?: Record<string, unknown>) => {
      invoked.push(command);
      const refused = command === "kalvoice_status" ? statusFailure?.() : null;
      if (refused) throw refused;
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
  let accountReady = false;
  const onAccountReady = () => {
    accountReady = true;
  };
  render(
    <Root>
      <ToastProvider>
        <TooltipProvider>
          <AccountProvider client={new AccountClient(transport)}>
            <RuntimeProvider client={client} info={boot.info} initialSettings={await client.getSettings()}>
              <Shell />
            </RuntimeProvider>
            <AccountReadyProbe onReady={onAccountReady} />
          </AccountProvider>
        </TooltipProvider>
      </ToastProvider>
    </Root>,
  );
  const user = userEvent.setup();
  if (!statusFailure?.()) await screen.findByRole("region", { name: "KalVoice widget" });
  const primary = within(screen.getByRole("navigation", { name: "Primary" }));
  const go = async (name: string) => {
    await user.click(primary.getByRole("button", { name }));
  };
  const inject = (signal: KalVoiceSignal) => act(() => deliver?.(signal));
  const talks = () => invoked.filter((c) => c === "kalvoice_talk").length;
  // Let the account runtime settle (its "ready" transition renews the channel at most once) so
  // tests can count subscribes caused by what they do. Waits for that transition to commit rather
  // than for a fixed delay, which a loaded machine can outlast.
  await waitFor(() => expect(accountReady).toBe(true));
  const settled = subscribe.mock.calls.length;
  return { transport, subscribe, user, go, inject, talks, settled, invoked };
}

const NOT_STARTED = {
  category: "internal",
  code: "kalvoice_unavailable",
  message: "KalVoice Requests need a verified KalCode account.",
  retryable: false,
};

const widget = () => screen.getByRole("region", { name: "KalVoice widget" });
const widgetState = async (label: string) =>
  waitFor(() => expect(within(widget()).getByText(label, { selector: "span" })).toBeInTheDocument());
const press = () => fireEvent.keyDown(window, { code: "F8", key: "F8" });
const release = () => fireEvent.keyUp(window, { code: "F8", key: "F8" });

describe("push to talk is always visible", () => {
  it("regression guard: one live subscription across navigation, page mount/unmount and dialogs", async () => {
    const { subscribe, user, go, talks, settled } = await mount();
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
    expect(subscribe).toHaveBeenCalledTimes(settled);

    press();
    await widgetState("Listening");
    release();
    await widgetState("Processing");
    await widgetState("Done");
    expect(talks()).toBe(1);
    // Every step waits on a condition; the budget covers a full Shell mount plus seven page
    // changes and a dialog, which a loaded machine (a full parallel suite) can slow past 5 s.
  }, 20_000);

  it("StrictMode remounts add listeners but never a second native channel", async () => {
    const { subscribe, go, talks } = await mount({ strict: true });
    await go("Threads");
    // The initial channel plus at most the account runtime's one renewal; never one per mount.
    expect(subscribe.mock.calls.length).toBeLessThanOrEqual(2);
    press();
    await widgetState("Listening");
    release();
    await widgetState("Processing");
    await widgetState("Done");
    expect(talks()).toBe(1);
  });

  it.each(["Dashboard", "Threads", "Settings"])(
    "regression guard: Listening, Processing and the result from %s",
    async (page) => {
      const { go } = await mount();
      await go(page);
      press();
      await widgetState("Listening");
      release();
      await widgetState("Processing");
      await widgetState("Done");
      expect(widget()).toHaveTextContent(/settings/i);
    },
  );

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
    const { user, inject, invoked } = await mount();
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
    // One click to the OS microphone privacy page (native opens only that page).
    await user.click(within(alert).getByRole("button", { name: "Open privacy settings" }));
    await waitFor(() => expect(invoked).toContain("kalvoice_open_microphone_settings"));
    await user.click(within(alert).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(screen.queryByRole("alert", { name: "Push to talk" })).toBeNull());
  }, 15_000);
});

describe("push-to-talk readiness is truthful", () => {
  it("follows native talk_key: never Ready while unregistered, the OS reason everywhere, background is not an error", async () => {
    const { go, inject } = await mount();
    await widgetState("Ready");
    const talkKey = (active: boolean, reason: string | null) =>
      inject({ kind: "talk_key", active, reason, accelerator: "F8" });

    talkKey(false, "os_refused");
    await widgetState("Key unavailable");
    expect(within(widget()).queryByText("Ready", { selector: "span" })).toBeNull();
    expect(widget()).toHaveTextContent("F8 unavailable: Another app is using this key.");

    await go("Settings");
    const readiness = await screen.findByRole("status", { name: "Push-to-talk readiness" });
    // The Settings status re-read on open must not resurrect Ready over the native signal.
    await waitFor(() => expect(readiness).toHaveTextContent("F8 unavailable: Another app is using this key."));
    expect(readiness).toHaveAttribute("data-attention", "true");

    await go("KalVoice");
    const tile = screen.getByText("Push to talk", { selector: "p" }).closest("li");
    expect(tile).toHaveTextContent("Key unavailable");
    expect(tile).not.toHaveTextContent("Ready");

    // KalCode went to the background: expected, shown without an error.
    talkKey(false, "not_focused");
    await waitFor(() => expect(tile).toHaveTextContent("Ready when in front"));
    await widgetState("Ready when in front");
    expect(widget()).not.toHaveAttribute("data-attention");
    expect(screen.queryByRole("alert", { name: "Push to talk" })).toBeNull();

    // Back in front: native registers the key again.
    talkKey(true, null);
    await waitFor(() => expect(tile).toHaveTextContent("Ready"));
    await widgetState("Ready");
  });

  it("says why when native KalVoice never started, instead of an invisible widget", async () => {
    const { go } = await mount({ statusFailure: () => NOT_STARTED });
    const notice = await screen.findByRole("status", { name: "Push to talk" });
    expect(notice).toHaveTextContent("KalVoice: Unavailable");
    expect(notice).toHaveTextContent("KalVoice Requests need a verified KalCode account.");
    expect(within(notice).getByRole("button", { name: "Try again" })).toBeInTheDocument();
    await go("KalVoice");
    const section = await screen.findByRole("region", { name: "Status" });
    const status = within(section).getByRole("alert");
    expect(status).toHaveTextContent(/KalVoice status couldn.t be read/);
    expect(status).toHaveTextContent("verified KalCode account");
    expect(screen.queryByText("Ready")).toBeNull();
  });
});

describe("signals that aren't connected are never masked", () => {
  it("a refused subscribe with a successful status read never shows Ready, and reconnects on focus", async () => {
    let refused = true;
    const { talks } = await mount({ subscribeFailure: () => (refused ? NOT_STARTED : null) });
    await widgetState("Not connected");
    expect(within(widget()).queryByText("Ready", { selector: "span" })).toBeNull();
    expect(widget()).toHaveTextContent("KalVoice can't show push-to-talk progress");

    refused = false;
    fireEvent.focus(window);
    await widgetState("Ready");
    press();
    await widgetState("Listening");
    release();
    await widgetState("Done");
    expect(talks()).toBe(1);
  });

  it("runtime not ready at launch: once it is, the subscription is established and push to talk works", async () => {
    let runtimeReady = false;
    const { subscribe, talks } = await mount({
      statusFailure: () => (runtimeReady ? null : NOT_STARTED),
      subscribeFailure: () => (runtimeReady ? null : NOT_STARTED),
    });
    // (The "Not connected" notice itself is covered above; this test is about recovery.)
    await waitFor(() => expect(subscribe).toHaveBeenCalled());
    expect(screen.queryByText("Ready")).toBeNull();

    runtimeReady = true;
    // Coming forward is the runtime-status trigger available today (no timer-driven polling).
    fireEvent.focus(window);
    await widgetState("Ready");
    expect(screen.queryByRole("status", { name: "Push to talk" })).toBeNull();
    const attempts = subscribe.mock.calls.length;
    press();
    await widgetState("Listening");
    release();
    await widgetState("Processing");
    await widgetState("Done");
    expect(talks()).toBe(1);
    expect(subscribe.mock.calls.length).toBe(attempts);
  });

  it("renewing the channel mid-utterance delivers the result once and routes it once", async () => {
    const { subscribe, talks, settled } = await mount();
    press();
    await widgetState("Listening");
    fireEvent.focus(window);
    await waitFor(() => expect(subscribe).toHaveBeenCalledTimes(settled + 1));
    release();
    await widgetState("Processing");
    await widgetState("Done");
    expect(talks()).toBe(1);
  });

  it("an older Ready status is not trusted once a refresh fails", async () => {
    let failing = false;
    const { go } = await mount({ statusFailure: () => (failing ? NOT_STARTED : null) });
    await widgetState("Ready");
    failing = true;
    await go("Settings"); // Opening Settings re-reads status.
    await widgetState("Unverified");
    expect(widget()).toHaveTextContent("KalVoice status couldn't be refreshed");
    failing = false;
    await userEvent.click(within(widget()).getByRole("button", { name: "Try again" }));
    await widgetState("Ready");
  });
});
