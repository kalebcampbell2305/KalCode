/**
 * Prompt evidence for KalTidy (pure): is a terminal's shell back at its prompt? Read from the
 * tail of the terminal's native scrollback, so it survives a reload of the window and covers
 * terminals no view is showing. Fail closed: anything that doesn't positively look like a
 * prompt is "not at a prompt".
 */

export interface ScreenState {
  /** The cursor's current line, escape sequences removed. */
  line: string;
  /** The shell is at its prompt with nothing typed after it. */
  atPrompt: boolean;
}

/** How much of the scrollback's end is read (the current line is near the end). */
export const SCREEN_TAIL_BYTES = 16 * 1024;

/** A shell prompt ends with one of these, plus optional spaces ("PS C:\site> ", "$ ", "❯ "). */
const PROMPT_END = /[>$#%❯»λ]\s*$/u;

export function looksLikePrompt(line: string): boolean {
  return line.trim() !== "" && PROMPT_END.test(line);
}

/**
 * Follows the output's end the way a terminal would, closely enough to know the current line:
 * line feeds and cursor moves to another row start a new line, carriage return and column moves
 * restart it, Backspace removes a character, everything else that isn't text is ignored.
 * Shell-integration marks (OSC 133 / OSC 633: A prompt start, B prompt end, C command running,
 * D command finished) take precedence over the text when the shell emits them.
 */
export function screenFromOutput(output: string): ScreenState {
  let line = "";
  let mark: "A" | "B" | "C" | "D" | null = null;
  /** Where the prompt ended on the current line (after B), or null. */
  let promptEnd: number | null = null;
  const newLine = () => {
    line = "";
    promptEnd = null;
  };
  let i = 0;
  while (i < output.length) {
    const ch = output[i] as string;
    if (ch === "\x1b") {
      const next = output[i + 1];
      if (next === "]") {
        // OSC: up to BEL or ST.
        let end = i + 2;
        while (end < output.length && output[end] !== "\x07" && !(output[end] === "\x1b" && output[end + 1] === "\\")) {
          end += 1;
        }
        const body = output.slice(i + 2, end);
        const shellMark = /^(?:133|633);([ABCD])/.exec(body);
        if (shellMark) {
          mark = shellMark[1] as "A" | "B" | "C" | "D";
          promptEnd = mark === "B" ? line.length : null;
        }
        i = output[end] === "\x07" ? end + 1 : end + 2;
        continue;
      }
      if (next === "[") {
        let end = i + 2;
        while (end < output.length) {
          const code = output.charCodeAt(end);
          if (code >= 0x40 && code <= 0x7e) break;
          end += 1;
        }
        const final = output[end];
        if (final === "H" || final === "f" || final === "A" || final === "B" || final === "E" || final === "F") {
          newLine(); // the cursor moved to (possibly) another row
        } else if (final === "G") {
          line = "";
        }
        i = end + 1;
        continue;
      }
      i += 2; // other two-character escapes
      continue;
    }
    if (ch === "\n") newLine();
    else if (ch === "\r") line = "";
    else if (ch === "\b") line = line.slice(0, -1);
    else if (ch.charCodeAt(0) >= 0x20 && ch !== "\x7f") line += ch;
    i += 1;
  }
  if (mark === "C") return { line, atPrompt: false };
  if (mark === "B" && promptEnd !== null) return { line, atPrompt: line.slice(promptEnd).trim() === "" };
  return { line, atPrompt: looksLikePrompt(line) };
}

/** The screen state from the end of a scrollback replay. */
export function screenFromReplay(bytes: Uint8Array): ScreenState {
  const tail = bytes.length > SCREEN_TAIL_BYTES ? bytes.subarray(bytes.length - SCREEN_TAIL_BYTES) : bytes;
  return screenFromOutput(new TextDecoder().decode(tail));
}
