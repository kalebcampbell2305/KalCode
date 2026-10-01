/**
 * KalTidy's view of what happened in each terminal recently, fed by the terminal view's input
 * queue and output stream (`TerminalView`): when it last printed, when the person last typed,
 * and whether they typed something at the prompt without pressing Enter (work that would be
 * lost). Module state, so it survives a terminal view unmounting (another workspace, a closed
 * pane) for as long as the window lives.
 */

export interface TerminalActivity {
  /** Epoch ms of the last live output (never the scrollback replay); null when none seen. */
  lastOutputAt: number | null;
  /** Epoch ms of the last input sent; null when none seen. */
  lastInputAt: number | null;
  /** Text was typed (or the line edited) since the last Enter. */
  unsent: boolean;
}

interface LineState {
  /** Printable text typed since the last Enter. */
  buffer: string;
  /** The line was edited in a way KalCode can't follow (history recall, completion, …). */
  edited: boolean;
}

interface Entry extends LineState {
  lastOutputAt: number | null;
  lastInputAt: number | null;
}

const entries = new Map<string, Entry>();

const EMPTY: TerminalActivity = { lastOutputAt: null, lastInputAt: null, unsent: false };

function entry(terminalId: string): Entry {
  let found = entries.get(terminalId);
  if (!found) {
    found = { lastOutputAt: null, lastInputAt: null, buffer: "", edited: false };
    entries.set(terminalId, found);
  }
  return found;
}

/**
 * Escape sequences the terminal emulator sends by itself in answer to the program (cursor
 * position, device attributes, mode and colour reports), focus and mouse reports, and paste
 * brackets. None of them put text at the prompt.
 */
function isAutomaticReport(sequence: string): boolean {
  if (sequence.startsWith("\x1b]") || sequence.startsWith("\x1bP")) return true; // OSC / DCS replies
  if (!sequence.startsWith("\x1b[")) return false;
  const body = sequence.slice(2);
  return (
    /^\d+;\d+R$/.test(body) || // cursor position report
    /^[?>=][\d;]*c$/.test(body) || // device attributes
    /^\??\d*n$/.test(body) || // status report
    /^\??[\d;]*\$y$/.test(body) || // mode report
    body === "I" ||
    body === "O" || // focus in / out
    body === "200~" ||
    body === "201~" || // bracketed paste markers (the pasted text itself counts)
    /^<[\d;]+[Mm]$/.test(body) || // SGR mouse report
    /^M[\s\S]{3}$/.test(body) // X10 mouse report
  );
}

/** Splits off one escape sequence starting at `start` (which holds ESC). */
function escapeSequenceAt(data: string, start: number): string {
  const next = data[start + 1];
  if (next === undefined) return "\x1b";
  if (next === "]" || next === "P") {
    // OSC / DCS: up to BEL or ST (ESC \).
    for (let i = start + 2; i < data.length; i += 1) {
      if (data[i] === "\x07") return data.slice(start, i + 1);
      if (data[i] === "\x1b" && data[i + 1] === "\\") return data.slice(start, i + 2);
    }
    return data.slice(start);
  }
  if (next === "[") {
    // X10 mouse: ESC [ M and three raw bytes.
    if (data[start + 2] === "M" && data.length - start >= 6) {
      return data.slice(start, start + 6);
    }
    for (let i = start + 2; i < data.length; i += 1) {
      const code = data.charCodeAt(i);
      if (code >= 0x40 && code <= 0x7e) return data.slice(start, i + 1);
    }
    return data.slice(start);
  }
  if (next === "O") return data.slice(start, start + 3); // SS3 keys (arrows, F1–F4)
  return data.slice(start, start + 2); // Alt+key
}

/**
 * The prompt line after `data` is typed (pure). Enter and Ctrl+C start a clean line; Backspace
 * removes a character; printable text is kept; anything else that can change the line (arrows,
 * Tab, Alt-keys, other control keys) marks it edited, because KalCode can't see what the shell
 * did with it. Reports the terminal emulator sends by itself are ignored.
 */
export function lineAfterInput(state: LineState, data: string): LineState {
  let { buffer, edited } = state;
  let i = 0;
  while (i < data.length) {
    const ch = data[i] as string;
    if (ch === "\x1b") {
      const sequence = escapeSequenceAt(data, i);
      if (!isAutomaticReport(sequence)) edited = true;
      i += sequence.length;
      continue;
    }
    if (ch === "\r" || ch === "\n" || ch === "\x03") {
      buffer = "";
      edited = false;
    } else if (ch === "\x7f" || ch === "\b") {
      buffer = buffer.slice(0, -1);
    } else if (ch === "\x0c") {
      // Ctrl+L redraws the screen; the line is unchanged.
    } else if (ch.charCodeAt(0) < 0x20) {
      edited = true;
    } else {
      buffer += ch;
    }
    i += 1;
  }
  return { buffer, edited };
}

/** Records input sent to a terminal (keys, paste, dictation). */
export function noteTerminalInput(terminalId: string, data: string, now = Date.now()): void {
  const current = entry(terminalId);
  const next = lineAfterInput(current, data);
  current.buffer = next.buffer;
  current.edited = next.edited;
  // Reports the emulator sends by itself are not the person using the terminal.
  if (stripReports(data) !== "") current.lastInputAt = now;
}

function stripReports(data: string): string {
  let out = "";
  let i = 0;
  while (i < data.length) {
    if (data[i] === "\x1b") {
      const sequence = escapeSequenceAt(data, i);
      if (!isAutomaticReport(sequence)) out += sequence;
      i += sequence.length;
      continue;
    }
    out += data[i];
    i += 1;
  }
  return out;
}

/** Records live output from a terminal (not the scrollback replay). */
export function noteTerminalOutput(terminalId: string, now = Date.now()): void {
  entry(terminalId).lastOutputAt = now;
}

/** What KalTidy knows about a terminal's recent use. */
export function terminalActivity(terminalId: string): TerminalActivity {
  const found = entries.get(terminalId);
  if (!found) return EMPTY;
  return {
    lastOutputAt: found.lastOutputAt,
    lastInputAt: found.lastInputAt,
    unsent: found.buffer.length > 0 || found.edited,
  };
}

/** Drops a closed terminal's record. */
export function forgetTerminalActivity(terminalId: string): void {
  entries.delete(terminalId);
}

export function resetTerminalActivityForTests(): void {
  entries.clear();
}
