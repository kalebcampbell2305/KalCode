import type { Terminal } from "@xterm/xterm";
import type { ContentContext } from "./contentActions.ts";

/** Prefer an explicit selection, otherwise the output line the user clicked. */
export function terminalContext(
  term: Terminal | null,
  target: EventTarget | null,
  label: string,
  keyboard = false,
): ContentContext {
  const selected = term?.getSelection() ?? "";
  const row = target instanceof Element ? target.closest(".xterm-rows > div") : null;
  const line =
    row?.textContent ??
    (keyboard
      ? term?.buffer.active.getLine(term.buffer.active.baseY + term.buffer.active.cursorY)?.translateToString(true)
      : "") ??
    "";
  return { kind: "output", label: `${label} output`, text: selected || line };
}
