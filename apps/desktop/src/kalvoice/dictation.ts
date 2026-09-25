/**
 * Dictation targets: where a transcript goes. The target is resolved when the dictation
 * shortcut goes down, so moving focus while speaking can never send text somewhere else.
 *
 * Text inputs and textareas receive the transcript at the caret. Other surfaces (terminals:
 * xterm renders into a hidden textarea whose input must go to the PTY instead) register a
 * sink with `registerDictationSink`; Code mode wires it to `terminal_write` when terminals land.
 */

export interface DictationSink {
  /** Accepts dictated text (e.g. writes it to a terminal's PTY). */
  insert(text: string): void;
  /** Human name for messages ("Terminal"). */
  label: string;
}

const sinks = new Map<Element, DictationSink>();

/** Makes `element` (and anything inside it) a dictation target. Returns an unregister function. */
export function registerDictationSink(element: Element, sink: DictationSink): () => void {
  sinks.set(element, sink);
  return () => {
    if (sinks.get(element) === sink) sinks.delete(element);
  };
}

const TEXT_INPUT_TYPES = new Set(["text", "search", "url", "email", ""]);

export type DictationTarget =
  | { kind: "field"; element: HTMLInputElement | HTMLTextAreaElement }
  | { kind: "sink"; element: Element; sink: DictationSink };

function isEditableField(el: Element): el is HTMLInputElement | HTMLTextAreaElement {
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled;
  if (el instanceof HTMLInputElement) {
    return TEXT_INPUT_TYPES.has(el.type.toLowerCase()) && !el.readOnly && !el.disabled;
  }
  return false;
}

/** The target for the focused element, or null when nothing dictatable has focus. */
export function resolveDictationTarget(active: Element | null): DictationTarget | null {
  if (!active || active === document.body) return null;
  // Registered surfaces win (a terminal's hidden textarea is not a text field).
  for (let node: Element | null = active; node; node = node.parentElement) {
    const sink = sinks.get(node);
    if (sink) return { kind: "sink", element: node, sink };
  }
  if (isEditableField(active)) return { kind: "field", element: active };
  return null;
}

/** Whether the target can still receive text (it may have closed while the user spoke). */
export function targetIsAlive(target: DictationTarget): boolean {
  if (!target.element.isConnected) return false;
  return target.kind === "sink" || isEditableField(target.element);
}

/**
 * The same target after a page change: a page re-creates its fields, so a field with an id is
 * found again by that id. Null when it's gone for good.
 */
export function reconnectTarget(target: DictationTarget): DictationTarget | null {
  if (targetIsAlive(target)) return target;
  if (target.kind !== "field" || !target.element.id) return null;
  const again = document.getElementById(target.element.id);
  return again && isEditableField(again) ? { kind: "field", element: again } : null;
}

/**
 * Text to insert at the selection, with a separating space when the transcript would otherwise
 * run into the previous word.
 */
export function planInsertion(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  transcript: string,
): { value: string; caret: number; inserted: string } {
  const start = Math.max(0, Math.min(selectionStart, value.length));
  const end = Math.max(start, Math.min(selectionEnd, value.length));
  const before = value.slice(0, start);
  const after = value.slice(end);
  const text = transcript.trim();
  const needsSpace = before.length > 0 && !/[\s([{"'`]$/.test(before) && !/^[.,!?;:)\]}]/.test(text);
  const inserted = `${needsSpace ? " " : ""}${text}`;
  return { value: before + inserted + after, caret: start + inserted.length, inserted };
}

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  // React tracks the value through the prototype setter; going through it makes React notice.
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}

/** Inserts a transcript into the target. Returns the number of characters inserted. */
export function insertTranscript(target: DictationTarget, transcript: string): number {
  if (target.kind === "sink") {
    target.sink.insert(transcript);
    return transcript.length;
  }
  const el = target.element;
  const plan = planInsertion(
    el.value,
    el.selectionStart ?? el.value.length,
    el.selectionEnd ?? el.value.length,
    transcript,
  );
  setNativeValue(el, plan.value);
  el.setSelectionRange(plan.caret, plan.caret);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  return plan.inserted.length;
}
