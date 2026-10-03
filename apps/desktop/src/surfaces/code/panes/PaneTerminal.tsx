import "@xterm/xterm/css/xterm.css";
import type { ThreadStatus } from "@kalcode/protocol";
import { Button } from "@kalcode/ui/components";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { RotateCcw, Unplug } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import { toKalCodeError } from "../../../ipc/errors.ts";
import {
  createOrderedInputQueue,
  DictationDeliveryError,
  type DictationDeliveryOptions,
  providerInputPayload,
  providerInputReadiness,
  registerDictationSink,
  throwIfDictationCancelled,
} from "../../../kalvoice/dictation.ts";
import { ContentContextMenu } from "../../../shell/context/ContentContextMenu.tsx";
import { terminalContext } from "../../../shell/context/terminalContext.ts";
import { afterLiveResize, isLiveResizing } from "../../../shell/panes/liveResize.ts";
import { OutputScheduler } from "../../../shell/panes/outputScheduler.ts";
import codeStyles from "../Code.module.css";
import { suppressReplayQueries } from "../replayQueries.ts";
import { isTerminalShortcut } from "../shortcuts.ts";
import { registerTerminalImageTarget, TerminalImageError, terminalImageTargetKey } from "../terminalImages.ts";
import { invalidateMonoFontFamily, MINIMUM_CONTRAST, monoFontFamily, TERMINAL_THEMES } from "../terminalTheme.ts";
import styles from "./Panes.module.css";
import type { PaneChannel } from "./paneChannel.ts";

const FONT_SIZE = 13;
const RESIZE_DEBOUNCE_MS = 80;
/** Rendered output is acknowledged to native in steps of this many bytes. */
const ACK_EVERY_BYTES = 64 * 1024;

interface PaneTerminalProps {
  channel: PaneChannel;
  threadId: string;
  /** Opaque identity of this exact provider process/PTY instance. */
  instanceId: string | null;
  /** Authoritative native PTY bound to this provider thread. */
  terminalId?: string | null;
  providerId: string;
  providerAccountId: string | null;
  status: ThreadStatus;
  /** Native user-safe startup/runtime error, kept distinct from historical restoration. */
  errorMessage?: string | null;
  /** Structured provider/runtime state only; never inferred from terminal output. */
  providerPromptActive: boolean;
  /** Accessible name of the terminal input. */
  label: string;
  /** The provider process is running (input is accepted). */
  running: boolean;
  focusRequest: number;
  theme: "light" | "dark";
  /** The pane isn't focused: output renders in batches (≤ 4 a second). */
  throttled?: boolean;
}

/**
 * The provider's own TUI, shown in xterm.js exactly as the CLI draws it (the same terminal stack
 * as Z1 tabs: DOM renderer, flow-controlled attachment, replay first). KalCode never reads this
 * text for status; status comes from native only.
 */
export const PaneTerminal = memo(function PaneTerminal({
  channel,
  threadId,
  instanceId,
  terminalId = null,
  providerId,
  providerAccountId,
  status,
  errorMessage = null,
  providerPromptActive,
  label,
  running,
  focusRequest,
  theme,
  throttled = false,
}: PaneTerminalProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const reconnectRef = useRef<(() => void) | null>(null);
  const runningRef = useRef(running);
  runningRef.current = running;
  const initialTheme = useRef(theme);
  const throttledRef = useRef(throttled);
  throttledRef.current = throttled;
  const writerRef = useRef<OutputScheduler | null>(null);
  const labelRef = useRef(label);
  labelRef.current = label;
  const inputRef = useRef<ReturnType<typeof createOrderedInputQueue> | null>(null);
  const missingOutputRef = useRef<(() => void) | null>(null);
  const missingMessage = running
    ? "Connecting to the provider terminal…"
    : errorMessage ||
      (status === "failed"
        ? "The provider could not start. Resume the agent to try again."
        : status === "waiting_for_dependency"
          ? "Waiting for resources to start this agent…"
          : status === "interrupted" || status === "completed"
            ? "This pane's provider ended in an earlier run. Resume the agent to start it again."
            : "Starting the provider terminal…");
  const missingMessageRef = useRef(missingMessage);
  missingMessageRef.current = missingMessage;
  const contextRef = useRef({
    threadId,
    instanceId,
    terminalId,
    providerId,
    providerAccountId,
    status,
    providerPromptActive,
  });
  contextRef.current = {
    threadId,
    instanceId,
    terminalId,
    providerId,
    providerAccountId,
    status,
    providerPromptActive,
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    const term = new Terminal({
      fontFamily: monoFontFamily(),
      fontSize: FONT_SIZE,
      lineHeight: 1.25,
      cursorBlink: true,
      cursorStyle: "bar",
      cursorInactiveStyle: "outline",
      scrollback: 5000,
      minimumContrastRatio: MINIMUM_CONTRAST,
      drawBoldTextInBrightColors: false,
      fontWeightBold: "600",
      theme: TERMINAL_THEMES[initialTheme.current],
      macOptionIsMeta: true,
      disableStdin: !runningRef.current,
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);

    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      if (event.defaultPrevented) return false;
      if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) return false;
      if (isTerminalShortcut(event)) return false;
      const ctrl = event.ctrlKey && !event.altKey && !event.metaKey;
      const paste = (event.ctrlKey || event.metaKey) && !event.altKey;
      const key = event.key.toLowerCase();
      if (ctrl && key === "c" && term.hasSelection()) return false;
      if (ctrl && key === "c" && event.shiftKey) return false;
      if (paste && key === "v") return false;
      return true;
    });

    const input = createOrderedInputQueue(
      (data) => channel.write(threadId, data),
      (error) => {
        if (import.meta.env.DEV && toKalCodeError(error).code !== "pane_not_running") {
          console.warn("pane input failed", error);
        }
      },
      (data) => {
        if (!instanceId) {
          return Promise.reject(
            new DictationDeliveryError("target_closed", "That provider pane has no live runtime identity."),
          );
        }
        return channel.writeVoice(threadId, instanceId, data);
      },
    );
    inputRef.current = input;
    let replaying = false;
    const disposeReplayQueries = suppressReplayQueries(term, () => replaying);
    let imagePasteCapture: ((data: string) => void) | null = null;
    const send = (data: string) => {
      const capture = imagePasteCapture;
      if (capture) {
        capture(data);
        return;
      }
      if (disposed || !runningRef.current) return;
      input.send(data);
    };
    term.onData(send);
    term.onBinary((data) => {
      // Legacy mouse reports (TUIs); only 7-bit data survives the UTF-8 input path unchanged.
      if ([...data].every((ch) => ch.charCodeAt(0) < 0x80)) send(data);
    });

    const guardProviderImagePaste = () => {
      const current = contextRef.current;
      if (disposed || current.threadId !== threadId || current.instanceId !== instanceId) {
        throw new DictationDeliveryError("target_closed", "That provider destination changed.");
      }
      if (!runningRef.current) {
        throw new DictationDeliveryError("terminal_not_running", "That provider session is no longer running.");
      }
      if (current.providerPromptActive || current.status === "waiting_for_permission") {
        throw new DictationDeliveryError(
          "provider_permission_prompt",
          "The provider is waiting for an answer to its native prompt.",
        );
      }
    };
    const unregisterImageTarget = instanceId
      ? registerTerminalImageTarget(host, {
          key: terminalImageTargetKey("agent", threadId),
          importImage: (pngBase64) => channel.importImage(threadId, instanceId, pngBase64),
          discardImage: (imported) => channel.discardImage(threadId, instanceId, imported.imageId),
          focus: () => term.focus(),
          async pasteInsertion(insertion, beforeWrite) {
            if (imagePasteCapture) {
              throw new TerminalImageError("image_paste_busy", "Wait for the current image to finish attaching.");
            }
            const writes: Promise<void>[] = [];
            imagePasteCapture = (data) => {
              writes.push(
                input.deliver(data, undefined, () => {
                  beforeWrite();
                  guardProviderImagePaste();
                }),
              );
            };
            try {
              term.paste(insertion);
            } finally {
              imagePasteCapture = null;
            }
            if (writes.length === 0) {
              throw new TerminalImageError("image_paste_failed", "KalCode couldn't paste the image into that agent.");
            }
            await Promise.all(writes);
          },
        })
      : () => undefined;

    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    term.onResize(({ cols, rows }) => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeTimer = null;
        if (!disposed && runningRef.current) channel.resize(threadId, { cols, rows }).catch(() => undefined);
      }, RESIZE_DEBOUNCE_MS);
    });

    let frame = 0;
    let waitingForResize: (() => void) | null = null;
    const fitNow = () => {
      if (disposed || host.clientWidth === 0 || host.clientHeight === 0) return;
      // While a pane divider is dragged, fit once at the end instead of every frame.
      if (isLiveResizing()) {
        waitingForResize ??= afterLiveResize(() => {
          waitingForResize = null;
          fitNow();
        });
        return;
      }
      try {
        fit.fit();
      } catch {
        // Not measurable yet; the next resize fits it.
      }
    };
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fitNow);
    });
    observer.observe(host);

    let attachment: number | null = null;
    let missingOutput = false;
    let lastMissingMessage: string | null = null;
    const showMissingOutput = () => {
      if (disposed || !missingOutput || lastMissingMessage === missingMessageRef.current) return;
      lastMissingMessage = missingMessageRef.current;
      term.reset();
      term.write(lastMissingMessage);
    };
    missingOutputRef.current = showMissingOutput;
    let generation = 0;
    let unacked = 0;
    // Output of an unfocused pane renders in batches; bytes are acknowledged once rendered.
    const writer = new OutputScheduler(term, (bytes) => acknowledge(bytes));
    writer.setThrottled(throttledRef.current);
    writerRef.current = writer;
    const acknowledge = (bytes: number) => {
      unacked += bytes;
      if (attachment === null || unacked < ACK_EVERY_BYTES) return;
      const [id, amount, current] = [attachment, unacked, generation];
      unacked = 0;
      channel
        .ack(id, amount)
        .then((streaming) => {
          if (!streaming && !disposed && current === generation) connect(true);
        })
        .catch(() => undefined);
    };
    const connect = (resync: boolean) => {
      const current = ++generation;
      // A replay abandoned by this new generation never clears its own flag.
      replaying = false;
      if (attachment !== null) channel.detach(attachment).catch(() => undefined);
      attachment = null;
      unacked = 0;
      let first = true;
      if (resync) {
        writer.clear();
        term.reset();
      }
      channel
        .attach(threadId, (bytes) => {
          if (disposed || current !== generation) return;
          if (first) {
            first = false;
            if (bytes.length === 0) return;
            replaying = true;
            term.write(bytes, () => {
              if (disposed || current !== generation) return;
              replaying = false;
              acknowledge(bytes.length);
            });
            return;
          }
          writer.push(bytes);
        })
        .then((id) => {
          if (disposed || current !== generation) {
            if (id !== null) channel.detach(id).catch(() => undefined);
            return;
          }
          attachment = id;
          setConnectError(null);
          fitNow();
          // Fitting to xterm's own default size fires no resize; the PTY may still differ.
          if (id !== null && runningRef.current && term.cols > 0 && term.rows > 0) {
            channel.resize(threadId, { cols: term.cols, rows: term.rows }).catch(() => undefined);
          }
          if (id === null && !resync) {
            missingOutput = true;
            showMissingOutput();
          }
        })
        .catch((error: unknown) => {
          if (!disposed && current === generation) setConnectError(toKalCodeError(error).message);
        });
    };
    reconnectRef.current = () => connect(true);
    connect(false);

    return () => {
      disposed = true;
      reconnectRef.current = null;
      unregisterImageTarget();
      observer.disconnect();
      cancelAnimationFrame(frame);
      waitingForResize?.();
      writer.dispose();
      writerRef.current = null;
      if (resizeTimer) clearTimeout(resizeTimer);
      if (attachment !== null) channel.detach(attachment).catch(() => undefined);
      input.dispose();
      if (missingOutputRef.current === showMissingOutput) missingOutputRef.current = null;
      disposeReplayQueries();
      if (inputRef.current === input) inputRef.current = null;
      termRef.current = null;
      term.dispose();
    };
  }, [channel, instanceId, threadId]);

  // A resource-held launch can fail before it ever gets a PTY instance. Update its explanation
  // without recreating a live terminal or confusing that failure with restoration.
  useEffect(() => {
    void missingMessage;
    missingOutputRef.current?.();
  }, [missingMessage]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const voiceInput = () => {
      const current = contextRef.current;
      if (
        current.threadId !== threadId ||
        current.instanceId !== instanceId ||
        current.terminalId !== terminalId ||
        current.providerId !== providerId ||
        current.providerAccountId !== providerAccountId
      ) {
        throw new DictationDeliveryError("target_closed", "That provider destination changed.");
      }
      const readiness = providerInputReadiness({
        running: runningRef.current,
        status: current.status,
        providerPromptActive: current.providerPromptActive,
      });
      if (readiness === "ended") {
        throw new DictationDeliveryError("terminal_not_running", "That provider session is no longer running.");
      }
      if (readiness === "provider_prompt") {
        throw new DictationDeliveryError(
          "provider_permission_prompt",
          "The provider is waiting for an answer to its native prompt.",
        );
      }
      if (readiness === "busy") {
        throw new DictationDeliveryError("provider_input_busy", "The provider is still working.");
      }
      if (readiness !== "ready") {
        throw new DictationDeliveryError(
          "provider_input_unverified",
          "KalCode cannot yet confirm that the provider is ready for a prompt.",
        );
      }
      const input = inputRef.current;
      if (!input) throw new DictationDeliveryError("target_closed", "That provider pane has closed.");
      return input;
    };
    const writeVoiceInput = async (
      input: NonNullable<typeof inputRef.current>,
      data: string,
      options?: DictationDeliveryOptions,
    ) => {
      try {
        await input.deliver(data, options, () => {
          // Input may wait behind a keyboard write. Recheck identity, runtime state, and native
          // provider prompts at the exact point this write enters the PTY.
          if (voiceInput() !== input) {
            throw new DictationDeliveryError("target_closed", "That provider pane has closed.");
          }
        });
      } catch (cause) {
        if (cause instanceof DictationDeliveryError) throw cause;
        const error = toKalCodeError(cause);
        if (error.code === "pane_not_running") {
          throw new DictationDeliveryError("terminal_not_running", "That provider session is no longer running.");
        }
        if (error.code === "provider_target_changed") {
          throw new DictationDeliveryError("target_closed", "That provider pane restarted before delivery.");
        }
        if (error.code === "provider_permission_prompt") {
          throw new DictationDeliveryError(
            "provider_permission_prompt",
            "The provider is waiting for an answer to its native prompt.",
          );
        }
        if (error.code === "provider_input_unverified") {
          throw new DictationDeliveryError(
            "provider_input_unverified",
            "KalCode cannot yet confirm that the provider is ready for a prompt.",
          );
        }
        throw new DictationDeliveryError("provider_delivery_failed", "KalCode could not write to that provider pane.");
      }
    };
    return registerDictationSink(host, {
      // Read live: labels renumber without re-registering (which would end a capture).
      get label() {
        return labelRef.current;
      },
      destination: {
        kind: "provider_pane",
        threadId,
        instanceId,
        terminalId,
        providerId,
        providerAccountId,
      },
      async deliver(transcript, options) {
        throwIfDictationCancelled(options?.signal);
        const mode = options?.mode ?? "send";
        const input = voiceInput();
        const payload = providerInputPayload(transcript, mode);
        await writeVoiceInput(input, payload, options);
        return payload.length - (mode === "send" ? 1 : 0);
      },
      async submit(options) {
        throwIfDictationCancelled(options?.signal);
        const input = voiceInput();
        await writeVoiceInput(input, "\r", options);
      },
    });
  }, [instanceId, providerAccountId, providerId, terminalId, threadId]);

  useEffect(() => {
    termRef.current?.textarea?.setAttribute("aria-label", label);
  }, [label]);

  const themeSeen = useRef(theme);
  useEffect(() => {
    if (themeSeen.current !== theme) {
      themeSeen.current = theme;
      invalidateMonoFontFamily();
    }
    const term = termRef.current;
    if (term) term.options.theme = TERMINAL_THEMES[theme];
  }, [theme]);

  useEffect(() => {
    writerRef.current?.setThrottled(throttled);
  }, [throttled]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.disableStdin = !running;
    term.options.cursorBlink = running;
    if (!running) term.write("\x1b[?25l");
  }, [running]);

  // Focus on request, and again when a resumed agent's new instance recreates the terminal while
  // this pane had focus (the old xterm took the keyboard focus with it).
  // A request stays pending until it lands: a new agent's instance id often arrives right after
  // its focus request, and re-running this effect must not drop that request.
  const focusSeen = useRef(0);
  const focusPending = useRef(false);
  useEffect(() => {
    void instanceId;
    if (focusSeen.current !== focusRequest) {
      focusSeen.current = focusRequest;
      if (focusRequest !== 0) focusPending.current = true;
    }
    if (focusRequest === 0) return;
    if (!focusPending.current) {
      const active = document.activeElement;
      const lostWithOldTerminal =
        active === null || active === document.body || (hostRef.current?.contains(active) ?? false);
      if (throttledRef.current || !lostWithOldTerminal) return;
    }
    const frame = requestAnimationFrame(() => {
      focusPending.current = false;
      termRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [focusRequest, instanceId]);

  return (
    <>
      <ContentContextMenu
        sourceAgentId={threadId}
        context={{ kind: "output", label: `${label} output`, text: "" }}
        getContext={(target, keyboard) => terminalContext(termRef.current, target, label, keyboard)}
      >
        <div ref={hostRef} className={codeStyles.xtermHost} data-pane-terminal={threadId} data-selectable />
      </ContentContextMenu>
      {connectError ? (
        <ContentContextMenu
          sourceAgentId={threadId}
          context={{ kind: "error", label: `${label} connection error`, text: connectError }}
        >
          <div className={styles.connectError} role="alert">
            <Unplug aria-hidden="true" />
            <span className={styles.connectErrorText} title={connectError}>
              {connectError}
            </span>
            <Button
              size="sm"
              variant="secondary"
              icon={<RotateCcw />}
              onClick={() => {
                setConnectError(null);
                reconnectRef.current?.();
              }}
            >
              Reconnect
            </Button>
          </div>
        </ContentContextMenu>
      ) : null}
    </>
  );
});
