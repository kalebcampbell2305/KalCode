import "@xterm/xterm/css/xterm.css";
import type { TerminalInfo } from "@kalcode/protocol";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import { toKalCodeError } from "../../ipc/errors.ts";
import { useRuntime } from "../../runtime/RuntimeProvider.tsx";
import { useWorkspaces } from "../../runtime/WorkspaceProvider.tsx";
import styles from "./Code.module.css";
import { isTerminalShortcut } from "./shortcuts.ts";
import { MINIMUM_CONTRAST, TERMINAL_THEMES } from "./terminalTheme.ts";

const FONT_SIZE = 13;
const RESIZE_DEBOUNCE_MS = 80;

interface TerminalViewProps {
  terminal: TerminalInfo;
  /** Accessible name of the terminal (its tab label). */
  label: string;
  /** Shown (the tab in front). Hidden views stay attached so switching is instant. */
  visible: boolean;
  /** Changes when this terminal should take keyboard focus. */
  focusRequest: number;
  theme: "light" | "dark";
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
export function TerminalView({ terminal, label, visible, focusRequest, theme }: TerminalViewProps) {
  const { client } = useRuntime();
  const { lastSize } = useWorkspaces();
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const running = terminal.status === "running";
  const runningRef = useRef(running);
  runningRef.current = running;
  const initialTheme = useRef(theme);
  const terminalId = terminal.id;

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
    let first = true;
    const send = inputQueue((data) => client.writeTerminal(terminalId, data));
    term.onData((data) => {
      if (!replaying && runningRef.current) send(data);
    });
    term.onBinary((data) => {
      // Legacy mouse reports; only 7-bit data survives the UTF-8 input path unchanged.
      if (!replaying && runningRef.current && !/[^\x00-\x7f]/.test(data)) send(data);
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
    const fitNow = () => {
      if (disposed || host.clientWidth === 0 || host.clientHeight === 0) return; // hidden tab
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

    client
      .attachTerminal(terminalId, (bytes) => {
        if (disposed) return;
        if (first) {
          first = false;
          if (bytes.length === 0) return;
          replaying = true;
          term.write(bytes, () => {
            replaying = false;
          });
          return;
        }
        term.write(bytes);
      })
      .then((attached) => {
        if (disposed) return;
        fitNow();
        if (attached) sendSize();
      })
      .catch((error: unknown) => {
        if (!disposed) term.write(`\r\n${toKalCodeError(error).message}\r\n`);
      });

    return () => {
      disposed = true;
      observer.disconnect();
      cancelAnimationFrame(frame);
      if (resizeTimer) clearTimeout(resizeTimer);
      client.detachTerminal(terminalId).catch(() => undefined);
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
    const term = termRef.current;
    if (!term) return;
    term.options.disableStdin = !running;
    term.options.cursorBlink = running;
    // An ended shell has no cursor; showing one suggests it still accepts input.
    if (!running) term.write("[?25l");
  }, [running]);

  useEffect(() => {
    if (!visible || focusRequest === 0) return;
    const frame = requestAnimationFrame(() => termRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [visible, focusRequest]);

  return <div ref={hostRef} className={styles.xtermHost} data-terminal-id={terminalId} data-selectable />;
}
