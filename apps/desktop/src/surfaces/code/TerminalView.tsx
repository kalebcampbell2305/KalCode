import "@xterm/xterm/css/xterm.css";
import type { TerminalInfo } from "@kalcode/protocol";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import { toKalCodeError } from "../../ipc/errors.ts";
import {
  createOrderedInputQueue,
  DictationDeliveryError,
  registerDictationSink,
  sanitizeTerminalDictation,
  throwIfDictationCancelled,
} from "../../kalvoice/dictation.ts";
import { useRuntime } from "../../runtime/RuntimeProvider.tsx";
import { useWorkspaces } from "../../runtime/WorkspaceProvider.tsx";
import { ContentContextMenu } from "../../shell/context/ContentContextMenu.tsx";
import { terminalContext } from "../../shell/context/terminalContext.ts";
import { afterLiveResize, isLiveResizing } from "../../shell/panes/liveResize.ts";
import { OutputScheduler } from "../../shell/panes/outputScheduler.ts";
import { useTextScale } from "../../shell/useTextScale.ts";
import styles from "./Code.module.css";
import { useCodeShown } from "./codeShown.ts";
import { noteTerminalInput, noteTerminalOutput } from "./kaltidy/activity.ts";
import { suppressReplayQueries } from "./replayQueries.ts";
import { isTerminalShortcut } from "./shortcuts.ts";
import { registerTerminalImageTarget, TerminalImageError, terminalImageTargetKey } from "./terminalImages.ts";
import {
  cursorStyle,
  invalidateMonoFontFamily,
  MINIMUM_CONTRAST,
  monoFontFamily,
  TERMINAL_THEMES,
} from "./terminalTheme.ts";

const FONT_SIZE = 13;

/** Terminal font size for an interface text scale, in whole pixels so glyph cells stay crisp. */
export function terminalFontSize(scale: number): number {
  return Math.round(FONT_SIZE * scale);
}
const RESIZE_DEBOUNCE_MS = 80;
/** Rendered output is acknowledged to native in steps of this many bytes. */
const ACK_EVERY_BYTES = 64 * 1024;

interface TerminalViewProps {
  terminal: TerminalInfo;
  /** Accessible name of the terminal (its tab label). */
  label: string;
  /** Shown (the tab in front). Hidden views stay attached so switching is instant. */
  visible: boolean;
  /** Changes when this terminal should take keyboard focus. */
  focusRequest: number;
  theme: "light" | "dark";
  /** The pane isn't focused: output renders in batches (≤ 4 a second). */
  throttled?: boolean;
}

/**
 * One terminal: an xterm.js view (DOM renderer, so text stays accessible and testable) attached
 * to a native session. The first output message is the scrollback replay; terminal reports
 * xterm.js generates while replaying are not sent back, because the shell already had them
 * answered when the output was first shown.
 */
export function TerminalView({
  terminal,
  label,
  visible: paneVisible,
  focusRequest,
  theme,
  throttled: paneThrottled = false,
}: TerminalViewProps) {
  // Code's own visibility arrives from a store, so hiding Code never re-renders pane chrome.
  const codeShown = useCodeShown();
  const visible = paneVisible && codeShown;
  const throttled = paneThrottled || !codeShown;
  const { client } = useRuntime();
  const { lastSize } = useWorkspaces();
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const running = terminal.status === "running";
  const runningRef = useRef(running);
  runningRef.current = running;
  const initialTheme = useRef(theme);
  // Terminal text follows the interface text size (Settings → Appearance → Text size).
  const fontSize = terminalFontSize(useTextScale());
  const initialFontSize = useRef(fontSize);
  const fitRef = useRef<(() => void) | null>(null);
  const terminalId = terminal.id;
  const terminalStartedAtRef = useRef(terminal.startedAt);
  terminalStartedAtRef.current = terminal.startedAt;
  const labelRef = useRef(label);
  labelRef.current = label;
  const throttledRef = useRef(throttled);
  throttledRef.current = throttled;
  const writerRef = useRef<OutputScheduler | null>(null);
  const inputRef = useRef<ReturnType<typeof createOrderedInputQueue> | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    const term = new Terminal({
      fontFamily: monoFontFamily(),
      fontSize: initialFontSize.current,
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

    // App shortcuts (new/close/switch tab, leave the terminal) are not sent to the shell; they
    // bubble to the Code surface. Copy and paste follow Windows Terminal: Ctrl+C copies when
    // text is selected (otherwise it interrupts), Ctrl+V and Ctrl+Shift+V paste.
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      // The window-level push-to-talk handler runs in capture phase. Never encode that already
      // consumed key (for example F8 as ESC [19~) into the PTY.
      if (event.defaultPrevented) return false;
      if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) return false;
      if (isTerminalShortcut(event)) return false;
      const ctrl = event.ctrlKey && !event.altKey && !event.metaKey;
      const paste = (event.ctrlKey || event.metaKey) && !event.altKey;
      const key = event.key.toLowerCase();
      if (ctrl && key === "c" && term.hasSelection()) return false; // browser copy → xterm copy handler
      if (ctrl && key === "c" && event.shiftKey) return false;
      if (paste && key === "v") return false; // browser paste → xterm paste handler
      return true;
    });

    let replaying = false;
    const disposeReplayQueries = suppressReplayQueries(term, () => replaying);
    const input = createOrderedInputQueue(
      (data) => {
        // KalTidy: every key, paste and dictation reaches the shell here.
        noteTerminalInput(terminalId, data);
        return client.writeTerminal(terminalId, data);
      },
      (error) => {
        // An ended terminal refuses input; its status updates through events.
        if (import.meta.env.DEV && toKalCodeError(error).code !== "terminal_not_running") {
          console.warn("terminal input failed", error);
        }
      },
    );
    inputRef.current = input;
    let imagePasteCapture: ((data: string) => void) | null = null;
    term.onData((data) => {
      const capture = imagePasteCapture;
      if (capture) {
        capture(data);
        return;
      }
      if (!disposed && runningRef.current) input.send(data);
    });
    term.onBinary((data) => {
      // Legacy mouse reports; only 7-bit data survives the UTF-8 input path unchanged.
      const sevenBit = [...data].every((ch) => ch.charCodeAt(0) < 0x80);
      if (!disposed && runningRef.current && sevenBit) input.send(data);
    });

    const imageTarget = { kind: "terminal", terminalId } as const;
    const unregisterImageTarget = registerTerminalImageTarget(host, {
      key: terminalImageTargetKey("terminal", terminalId),
      importImage: (pngBase64) => client.importTerminalImage(imageTarget, pngBase64),
      beginAttachment: () => {
        const startedAt = terminalStartedAtRef.current;
        return () => {
          if (disposed || !runningRef.current) {
            throw new DictationDeliveryError("terminal_not_running", "That terminal is no longer running.");
          }
          if (terminalStartedAtRef.current !== startedAt) {
            throw new TerminalImageError(
              "terminal_generation_changed",
              "That terminal restarted before the image was ready. Try again in the active terminal.",
            );
          }
        };
      },
      discardImage: (imported) => client.discardTerminalImage(imageTarget, imported.imageId),
      focus: () => term.focus(),
      async pasteInsertion(insertion, beforeWrite, terminalGeneration) {
        if (!Number.isSafeInteger(terminalGeneration) || (terminalGeneration ?? 0) <= 0) {
          throw new TerminalImageError(
            "terminal_generation_invalid",
            "That terminal restarted before the image was ready. Try again in the active terminal.",
          );
        }
        if (imagePasteCapture) {
          throw new TerminalImageError("image_paste_busy", "Wait for the current image to finish attaching.");
        }
        const writes: Promise<void>[] = [];
        imagePasteCapture = (data) => {
          writes.push(
            input.deliver(
              data,
              undefined,
              () => {
                beforeWrite();
              },
              (guardedData) => client.writeTerminal(terminalId, guardedData, terminalGeneration),
            ),
          );
        };
        try {
          term.paste(insertion);
        } finally {
          imagePasteCapture = null;
        }
        if (writes.length === 0) {
          throw new TerminalImageError("image_paste_failed", "KalCode couldn't paste the image into that terminal.");
        }
        await Promise.all(writes);
      },
    });

    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    // A hidden view (a tab behind another, Code on another page) has no size of its own: it
    // never resizes the shell, and sends its size once it is shown and fitted.
    let sizePending = false;
    const sendSize = () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeTimer = null;
        if (host.clientWidth === 0 || host.clientHeight === 0) {
          sizePending = true;
          return;
        }
        sizePending = false;
        if (!disposed && runningRef.current) {
          client.resizeTerminal(terminalId, { cols: term.cols, rows: term.rows }).catch(() => undefined);
        }
      }, RESIZE_DEBOUNCE_MS);
    };
    term.onResize(({ cols, rows }) => {
      lastSize.current = { cols, rows };
      sendSize();
    });

    let frame = 0;
    let waitingForResize: (() => void) | null = null;
    const fitNow = () => {
      if (disposed || host.clientWidth === 0 || host.clientHeight === 0) return; // hidden tab
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
        // Not measurable yet (fonts or layout still settling); the next resize fits it.
      }
      if (sizePending) sendSize();
    };
    fitRef.current = fitNow;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fitNow);
    });
    observer.observe(host);
    // Re-measure once the monospace font has loaded, so cells match the real glyphs.
    const fontFamily = monoFontFamily();
    void document.fonts?.load(`${initialFontSize.current}px ${fontFamily}`).then(() => {
      if (disposed) return;
      term.options.fontFamily = monoFontFamily();
      fitNow();
    });

    // Attachment lifecycle. Each attach gets its own id; this view detaches exactly that id, so
    // overlapping attach/detach calls (StrictMode, resync) never release another view's stream.
    // Rendered bytes are acknowledged so native can bound what it holds for this view; if the
    // view falls too far behind, native stops streaming and the view resyncs from scrollback.
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
      client
        .ackTerminal(id, amount)
        .then((streaming) => {
          if (!streaming && !disposed && current === generation) connect(true);
        })
        .catch(() => undefined);
    };
    const connect = (resync: boolean) => {
      const current = ++generation;
      // A replay abandoned by this new generation never clears its own flag.
      replaying = false;
      if (attachment !== null) client.detachTerminal(attachment).catch(() => undefined);
      attachment = null;
      unacked = 0;
      let first = true;
      if (resync) {
        writer.clear();
        term.reset();
      }
      client
        .attachTerminal(terminalId, (bytes) => {
          if (disposed || current !== generation) return;
          if (first) {
            first = false;
            if (bytes.length === 0) return;
            replaying = true;
            term.write(bytes, () => {
              if (disposed || current !== generation) return;
              replaying = false;
              // The replay may show the cursor again; an ended shell has none.
              if (!runningRef.current) term.write("\x1b[?25l");
              acknowledge(bytes.length);
            });
            return;
          }
          noteTerminalOutput(terminalId);
          writer.push(bytes);
        })
        .then((id) => {
          if (disposed || current !== generation) {
            if (id !== null) client.detachTerminal(id).catch(() => undefined);
            return;
          }
          attachment = id;
          acknowledge(0);
          fitNow();
          if (id !== null) sendSize();
          else if (!resync)
            term.write("\x1b[2mThis shell ended before KalCode last started; its output isn't kept.\x1b[0m");
        })
        .catch((error: unknown) => {
          if (!disposed) term.write(`\r\n${toKalCodeError(error).message}\r\n`);
        });
    };
    connect(false);

    return () => {
      disposed = true;
      fitRef.current = null;
      unregisterImageTarget();
      observer.disconnect();
      cancelAnimationFrame(frame);
      waitingForResize?.();
      writer.dispose();
      writerRef.current = null;
      if (resizeTimer) clearTimeout(resizeTimer);
      // An attach still in flight detaches itself when it resolves (see `connect`).
      if (attachment !== null) client.detachTerminal(attachment).catch(() => undefined);
      input.dispose();
      disposeReplayQueries();
      if (inputRef.current === input) inputRef.current = null;
      termRef.current = null;
      term.dispose();
    };
  }, [client, terminalId, lastSize]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    return registerDictationSink(host, {
      // Read live: tab labels renumber without re-registering (which would end a capture).
      get label() {
        return labelRef.current;
      },
      destination: { kind: "raw_terminal", terminalId },
      async deliver(transcript, options) {
        throwIfDictationCancelled(options?.signal);
        if (!runningRef.current) {
          throw new DictationDeliveryError("terminal_not_running", "That terminal is no longer running.");
        }
        const text = sanitizeTerminalDictation(transcript);
        if (!text) {
          throw new DictationDeliveryError("empty_transcript", "No text remained after safe input filtering.");
        }
        const input = inputRef.current;
        if (!input) throw new DictationDeliveryError("target_closed", "That terminal has closed.");
        try {
          await input.deliver(text, options);
        } catch (cause) {
          if (cause instanceof DictationDeliveryError) throw cause;
          const error = toKalCodeError(cause);
          if (error.code === "terminal_not_running") {
            throw new DictationDeliveryError("terminal_not_running", "That terminal is no longer running.");
          }
          throw new DictationDeliveryError("terminal_delivery_failed", "KalCode could not write to that terminal.");
        }
        return text.length;
      },
    });
  }, [terminalId]);

  useEffect(() => {
    // Tab labels can change (numbering) without restarting the view.
    termRef.current?.textarea?.setAttribute("aria-label", `${label} terminal input`);
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
    const term = termRef.current;
    if (!term || term.options.fontSize === fontSize) return;
    // A new cell size changes how many rows and columns fit; refit so the PTY is resized to match.
    term.options.fontSize = fontSize;
    fitRef.current?.();
  }, [fontSize]);

  useEffect(() => {
    writerRef.current?.setThrottled(throttled);
  }, [throttled]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.disableStdin = !running;
    term.options.cursorBlink = running;
    // An ended shell has no cursor; showing one suggests it still accepts input.
    if (!running) term.write("\x1b[?25l");
  }, [running]);

  useEffect(() => {
    if (!visible || focusRequest === 0) return;
    const frame = requestAnimationFrame(() => termRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [visible, focusRequest]);

  return (
    <ContentContextMenu
      workspaceId={terminal.workspaceId}
      context={{ kind: "output", label: `${label} output`, text: "" }}
      getContext={(target, keyboard) => terminalContext(termRef.current, target, label, keyboard)}
    >
      <div
        ref={hostRef}
        className={styles.xtermHost}
        style={cursorStyle(theme)}
        data-terminal-id={terminalId}
        data-selectable
      />
    </ContentContextMenu>
  );
}
