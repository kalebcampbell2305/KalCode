import "@xterm/xterm/css/xterm.css";
import type { TerminalInfo } from "@kalcode/protocol";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import { toKalCodeError } from "../../ipc/errors.ts";
import { useRuntime } from "../../runtime/RuntimeProvider.tsx";
import { useWorkspaces } from "../../runtime/WorkspaceProvider.tsx";
import { afterLiveResize, isLiveResizing } from "../../shell/panes/liveResize.ts";
import { OutputScheduler } from "../../shell/panes/outputScheduler.ts";
import styles from "./Code.module.css";
import { isTerminalShortcut } from "./shortcuts.ts";
import { MINIMUM_CONTRAST, TERMINAL_THEMES } from "./terminalTheme.ts";

const FONT_SIZE = 13;
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

function monoFontFamily(): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim();
  return value || "ui-monospace, Consolas, monospace";
}

/**
 * Sends input in order, one write in flight at a time; keystrokes typed meanwhile are batched
 * into the next write.
 */
function inputQueue(write: (data: string) => Promise<void>) {
  let pending = "";
  let flushing = false;
  const flush = async () => {
    flushing = true;
    while (pending) {
      const data = pending;
      pending = "";
      try {
        await write(data);
      } catch (error) {
        // An ended terminal refuses input; its status updates through events.
        if (import.meta.env.DEV && toKalCodeError(error).code !== "terminal_not_running") {
          console.warn("terminal input failed", error);
        }
      }
    }
    flushing = false;
  };
  return (data: string) => {
    pending += data;
    if (!flushing) void flush();
  };
}

/**
 * One terminal: an xterm.js view (DOM renderer, so text stays accessible and testable) attached
 * to a native session. The first output message is the scrollback replay; terminal reports
 * xterm.js generates while replaying are not sent back, because the shell already had them
 * answered when the output was first shown.
 */
export function TerminalView({ terminal, label, visible, focusRequest, theme, throttled = false }: TerminalViewProps) {
  const { client } = useRuntime();
  const { lastSize } = useWorkspaces();
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const running = terminal.status === "running";
  const runningRef = useRef(running);
  runningRef.current = running;
  const initialTheme = useRef(theme);
  const terminalId = terminal.id;
  const throttledRef = useRef(throttled);
  throttledRef.current = throttled;
  const writerRef = useRef<OutputScheduler | null>(null);

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

    // App shortcuts (new/close/switch tab, leave the terminal) are not sent to the shell; they
    // bubble to the Code surface. Copy and paste follow Windows Terminal: Ctrl+C copies when
    // text is selected (otherwise it interrupts), Ctrl+V and Ctrl+Shift+V paste.
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      if (isTerminalShortcut(event)) return false;
      const ctrl = event.ctrlKey && !event.altKey && !event.metaKey;
      const key = event.key.toLowerCase();
      if (ctrl && key === "c" && term.hasSelection()) return false; // browser copy → xterm copy handler
      if (ctrl && key === "c" && event.shiftKey) return false;
      if (ctrl && key === "v") return false; // browser paste → xterm paste handler
      return true;
    });

    let replaying = false;
    const send = inputQueue((data) => client.writeTerminal(terminalId, data));
    term.onData((data) => {
      if (!replaying && runningRef.current) send(data);
    });
    term.onBinary((data) => {
      // Legacy mouse reports; only 7-bit data survives the UTF-8 input path unchanged.
      const sevenBit = [...data].every((ch) => ch.charCodeAt(0) < 0x80);
      if (!replaying && runningRef.current && sevenBit) send(data);
    });

    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const sendSize = () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeTimer = null;
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
    };
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fitNow);
    });
    observer.observe(host);
    // Re-measure once the monospace font has loaded, so cells match the real glyphs.
    void document.fonts?.load(`${FONT_SIZE}px ${monoFontFamily()}`).then(() => {
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
              replaying = false;
              // The replay may show the cursor again; an ended shell has none.
              if (!runningRef.current) term.write("\x1b[?25l");
              acknowledge(bytes.length);
            });
            return;
          }
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
      observer.disconnect();
      cancelAnimationFrame(frame);
      waitingForResize?.();
      writer.dispose();
      writerRef.current = null;
      if (resizeTimer) clearTimeout(resizeTimer);
      // An attach still in flight detaches itself when it resolves (see `connect`).
      if (attachment !== null) client.detachTerminal(attachment).catch(() => undefined);
      termRef.current = null;
      term.dispose();
    };
  }, [client, terminalId, lastSize]);

  useEffect(() => {
    // Tab labels can change (numbering) without restarting the view.
    termRef.current?.textarea?.setAttribute("aria-label", `${label} terminal input`);
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
    // An ended shell has no cursor; showing one suggests it still accepts input.
    if (!running) term.write("\x1b[?25l");
  }, [running]);

  useEffect(() => {
    if (!visible || focusRequest === 0) return;
    const frame = requestAnimationFrame(() => termRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [visible, focusRequest]);

  return <div ref={hostRef} className={styles.xtermHost} data-terminal-id={terminalId} data-selectable />;
}
