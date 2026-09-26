import "@xterm/xterm/css/xterm.css";
import type { ThreadStatus } from "@kalcode/protocol";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import { toKalCodeError } from "../../../ipc/errors.ts";
import {
  createOrderedInputQueue,
  DictationDeliveryError,
  frameProviderPrompt,
  providerInputReadiness,
  registerDictationSink,
  throwIfDictationCancelled,
} from "../../../kalvoice/dictation.ts";
import { afterLiveResize, isLiveResizing } from "../../../shell/panes/liveResize.ts";
import { OutputScheduler } from "../../../shell/panes/outputScheduler.ts";
import codeStyles from "../Code.module.css";
import { isTerminalShortcut } from "../shortcuts.ts";
import { MINIMUM_CONTRAST, TERMINAL_THEMES } from "../terminalTheme.ts";
import type { PaneChannel } from "./paneChannel.ts";

const FONT_SIZE = 13;
const RESIZE_DEBOUNCE_MS = 80;
/** Rendered output is acknowledged to native in steps of this many bytes. */
const ACK_EVERY_BYTES = 64 * 1024;

interface PaneTerminalProps {
  channel: PaneChannel;
  threadId: string;
  providerId: string;
  providerAccountId: string | null;
  status: ThreadStatus;
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

function monoFontFamily(): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim();
  return value || "ui-monospace, Consolas, monospace";
}

/**
 * The provider's own TUI, shown in xterm.js exactly as the CLI draws it (the same terminal stack
 * as Z1 tabs: DOM renderer, flow-controlled attachment, replay first). KalCode never reads this
 * text for status; status comes from native only.
 */
export function PaneTerminal({
  channel,
  threadId,
  providerId,
  providerAccountId,
  status,
  providerPromptActive,
  label,
  running,
  focusRequest,
  theme,
  throttled = false,
}: PaneTerminalProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const runningRef = useRef(running);
  runningRef.current = running;
  const initialTheme = useRef(theme);
  const throttledRef = useRef(throttled);
  throttledRef.current = throttled;
  const writerRef = useRef<OutputScheduler | null>(null);
  const labelRef = useRef(label);
  labelRef.current = label;
  const inputRef = useRef<ReturnType<typeof createOrderedInputQueue> | null>(null);
  const contextRef = useRef({ threadId, providerId, providerAccountId, status, providerPromptActive });
  contextRef.current = { threadId, providerId, providerAccountId, status, providerPromptActive };

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
      if (isTerminalShortcut(event)) return false;
      const ctrl = event.ctrlKey && !event.altKey && !event.metaKey;
      const key = event.key.toLowerCase();
      if (ctrl && key === "c" && term.hasSelection()) return false;
      if (ctrl && key === "c" && event.shiftKey) return false;
      if (ctrl && key === "v") return false;
      return true;
    });

    const input = createOrderedInputQueue(
      (data) => channel.write(threadId, data),
      (error) => {
        if (import.meta.env.DEV && toKalCodeError(error).code !== "pane_not_running") {
          console.warn("pane input failed", error);
        }
      },
    );
    inputRef.current = input;
    let replaying = false;
    const send = (data: string) => {
      if (replaying || !runningRef.current) return;
      input.send(data);
    };
    term.onData(send);

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
          fitNow();
          if (id === null && !resync) {
            term.write(
              "\x1b[2mThis pane's provider ended in an earlier run. Resume the thread to start it again.\x1b[0m",
            );
          }
        })
        .catch((error: unknown) => {
          if (!disposed) term.write(`\r\n${toKalCodeError(error).message}\r\n`);
        });
    };
    connect(false);

    return () => {
      disposed = true;
      observer.disconnect();
      cancelAnimationFrame(frame);
      waitingForResize?.();
      writer.dispose();
      writerRef.current = null;
      if (resizeTimer) clearTimeout(resizeTimer);
      if (attachment !== null) channel.detach(attachment).catch(() => undefined);
      input.dispose();
      if (inputRef.current === input) inputRef.current = null;
      termRef.current = null;
      term.dispose();
    };
  }, [channel, threadId]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    return registerDictationSink(host, {
      label: labelRef.current,
      destination: { kind: "provider_pane", threadId, providerId, providerAccountId },
      async deliver(transcript, options) {
        throwIfDictationCancelled(options?.signal);
        const current = contextRef.current;
        if (
          current.threadId !== threadId ||
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
        const framed = frameProviderPrompt(transcript);
        const input = inputRef.current;
        if (!input) throw new DictationDeliveryError("target_closed", "That provider pane has closed.");
        try {
          await input.deliver(framed, options);
        } catch (cause) {
          if (cause instanceof DictationDeliveryError) throw cause;
          const error = toKalCodeError(cause);
          if (error.code === "pane_not_running") {
            throw new DictationDeliveryError("terminal_not_running", "That provider session is no longer running.");
          }
          throw new DictationDeliveryError(
            "provider_delivery_failed",
            "KalCode could not write to that provider pane.",
          );
        }
        return framed.length - 1;
      },
    });
  }, [providerAccountId, providerId, threadId]);

  useEffect(() => {
    termRef.current?.textarea?.setAttribute("aria-label", label);
  }, [label]);

  useEffect(() => {
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

  useEffect(() => {
    if (focusRequest === 0) return;
    const frame = requestAnimationFrame(() => termRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [focusRequest]);

  return <div ref={hostRef} className={codeStyles.xtermHost} data-pane-terminal={threadId} data-selectable />;
}
