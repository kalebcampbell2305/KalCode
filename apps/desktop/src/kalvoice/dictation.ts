import type { ThreadStatus } from "@kalcode/protocol";

/**
 * Dictation targets: where a transcript goes. The target is resolved when the dictation
 * shortcut goes down, so moving focus while speaking can never send text somewhere else.
 *
 * Text inputs and textareas receive the transcript at the caret. Other surfaces (terminals:
 * xterm renders into a hidden textarea whose input must go to the PTY instead) register a
 * sink with `registerDictationSink`; Code mode wires it to `terminal_write` when terminals land.
 */

export interface DictationSink {
  /** The immutable runtime destination captured when push-to-talk starts. */
  destination:
    | { kind: "raw_terminal"; terminalId: string }
    | {
        kind: "provider_pane";
        threadId: string;
        providerId: string;
        /** Stable profile metadata only; never a credential. */
        providerAccountId: string | null;
      };
  /** Delivers dictated text to the captured destination, resolving only after its transport accepts it. */
  deliver(text: string, options?: DictationDeliveryOptions): Promise<number | void>;
  /** Human name for messages ("Terminal"). */
  label: string;
}

interface RegisteredSink {
  sink: DictationSink;
  generation: number;
}

const sinks = new Map<Element, RegisteredSink>();
let nextGeneration = 1;

export type DictationDeliveryErrorCode =
  | "target_closed"
  | "dictation_cancelled"
  | "empty_transcript"
  | "terminal_not_running"
  | "terminal_delivery_failed"
  | "provider_input_busy"
  | "provider_permission_prompt"
  | "provider_input_unverified"
  | "provider_delivery_failed";

/** A stable local delivery error. Messages intentionally never contain the transcript. */
export class DictationDeliveryError extends Error {
  constructor(
    readonly code: DictationDeliveryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DictationDeliveryError";
  }
}

export interface DictationDeliveryOptions {
  signal?: AbortSignal;
}

export function throwIfDictationCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DictationDeliveryError("dictation_cancelled", "Dictation was cancelled before delivery.");
  }
}

interface QueuedInput {
  data: string;
  signal?: AbortSignal;
  failure?: DictationDeliveryError;
  onAbort?: () => void;
  resolve: () => void;
  reject: (cause: unknown) => void;
  background: boolean;
}

/** Serializes keyboard and dictation input through one PTY write lane. */
export function createOrderedInputQueue(
  write: (data: string) => Promise<void>,
  onBackgroundError: (cause: unknown) => void = () => undefined,
): {
  send(data: string): void;
  deliver(data: string, options?: DictationDeliveryOptions): Promise<void>;
  dispose(): void;
} {
  let pending: QueuedInput[] = [];
  let flushing = false;
  let closed = false;

  const flush = async () => {
    flushing = true;
    while (pending.length > 0) {
      const batch = pending;
      pending = [];
      const live: QueuedInput[] = [];
      for (const item of batch) {
        if (item.onAbort) item.signal?.removeEventListener("abort", item.onAbort);
        if (item.failure || item.signal?.aborted) {
          item.reject(
            item.failure ??
              new DictationDeliveryError("dictation_cancelled", "Dictation was cancelled before delivery."),
          );
        } else {
          live.push(item);
        }
      }
      if (live.length === 0) continue;
      try {
        await write(live.map((item) => item.data).join(""));
        for (const item of live) item.resolve();
      } catch (cause) {
        for (const item of live) {
          item.reject(cause);
          if (item.background) onBackgroundError(cause);
        }
      }
    }
    flushing = false;
  };

  const enqueue = (data: string, background: boolean, options: DictationDeliveryOptions = {}) =>
    new Promise<void>((resolve, reject) => {
      try {
        if (closed) {
          reject(new DictationDeliveryError("target_closed", "That destination closed before delivery."));
          return;
        }
        throwIfDictationCancelled(options.signal);
      } catch (cause) {
        reject(cause);
        return;
      }
      const item: QueuedInput = { data, signal: options.signal, resolve, reject, background };
      item.onAbort = () => {
        item.failure = new DictationDeliveryError("dictation_cancelled", "Dictation was cancelled before delivery.");
      };
      options.signal?.addEventListener("abort", item.onAbort, { once: true });
      pending.push(item);
      if (!flushing) void flush();
    });

  return {
    send(data) {
      void enqueue(data, true).catch(() => undefined);
    },
    deliver(data, options) {
      return enqueue(data, false, options);
    },
    dispose() {
      closed = true;
      for (const item of pending) {
        item.failure = new DictationDeliveryError("target_closed", "That destination closed before delivery.");
      }
    },
  };
}

/** Makes `element` (and anything inside it) a dictation target. Returns an unregister function. */
export function registerDictationSink(element: Element, sink: DictationSink): () => void {
  const registration = { sink, generation: nextGeneration++ };
  sinks.set(element, registration);
  return () => {
    if (sinks.get(element) === registration) sinks.delete(element);
  };
}

const TEXT_INPUT_TYPES = new Set(["text", "search", "url", "email", ""]);

export type DictationTarget =
  | { kind: "field"; element: HTMLInputElement | HTMLTextAreaElement; paneId: string | null }
  | { kind: "sink"; element: Element; sink: DictationSink; generation: number; paneId: string | null };

function owningPaneId(element: Element): string | null {
  const paneId = element.closest<HTMLElement>("[data-pane-id]")?.dataset.paneId?.trim();
  return paneId || null;
}

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
    const registration = sinks.get(node);
    if (registration) return { kind: "sink", element: node, paneId: owningPaneId(active), ...registration };
  }
  if (isEditableField(active)) return { kind: "field", element: active, paneId: owningPaneId(active) };
  return null;
}

/** Whether the target can still receive text (it may have closed while the user spoke). */
export function targetIsAlive(target: DictationTarget): boolean {
  if (!target.element.isConnected) return false;
  if (target.kind === "field") return isEditableField(target.element);
  const registration = sinks.get(target.element);
  return registration?.generation === target.generation && registration.sink === target.sink;
}

/**
 * The same target after a page change: a page re-creates its fields, so a field with an id is
 * found again by that id. Null when it's gone for good.
 */
export function reconnectTarget(target: DictationTarget): DictationTarget | null {
  if (targetIsAlive(target)) return target;
  if (target.kind !== "field" || !target.element.id) return null;
  const again = document.getElementById(target.element.id);
  return again && isEditableField(again) ? { kind: "field", element: again, paneId: owningPaneId(again) } : null;
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

/** Inserts a transcript into the captured target after its current registration is verified. */
export async function insertTranscript(
  target: DictationTarget,
  transcript: string,
  options: DictationDeliveryOptions = {},
): Promise<number> {
  throwIfDictationCancelled(options.signal);
  if (!targetIsAlive(target)) {
    throw new DictationDeliveryError("target_closed", "That destination closed before dictation finished.");
  }
  if (target.kind === "sink") {
    const delivered = await target.sink.deliver(transcript, options);
    return delivered ?? transcript.length;
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

/**
 * Converts untrusted speech text into one inert terminal line. Every terminal control, ANSI/OSC
 * sequence and Unicode line separator becomes a boundary, then boundaries collapse to spaces.
 * The caller decides whether to submit it; this function never creates an Enter key.
 */
export function sanitizeTerminalDictation(transcript: string): string {
  return (
    transcript
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Remove untrusted OSC controls before terminal delivery.
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, " ")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Remove both ESC and C1 CSI terminal sequences.
      .replace(/(?:\x1b\[|\u009b)[0-?]*[ -/]*[@-~]/g, " ")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Remove remaining ESC terminal sequences.
      .replace(/\x1b[ -/]*[@-~]/g, " ")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Control bytes and line separators must never reach terminal input.
      .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
      .replace(/\s+/gu, " ")
      .trim()
  );
}

/** One sanitized provider prompt followed by exactly one trusted Enter. */
export function frameProviderPrompt(transcript: string): string {
  const prompt = sanitizeTerminalDictation(transcript);
  if (!prompt) throw new DictationDeliveryError("empty_transcript", "No text remained after safe input filtering.");
  return `${prompt}\r`;
}

export type ProviderInputReadiness = "ready" | "busy" | "provider_prompt" | "unknown" | "ended";

/**
 * Provider auto-submit requires structured evidence that the provider is awaiting an ordinary
 * user response. `idle` is deliberately unknown: it may be an auth/setup menu before hooks or
 * notifications have established prompt readiness.
 */
export function providerInputReadiness(input: {
  running: boolean;
  status: ThreadStatus;
  providerPromptActive: boolean;
}): ProviderInputReadiness {
  if (!input.running) return "ended";
  if (input.providerPromptActive || input.status === "waiting_for_permission") return "provider_prompt";
  if (input.status === "waiting_for_user") return "ready";
  if (
    input.status === "starting" ||
    input.status === "active" ||
    input.status === "thinking" ||
    input.status === "running_tool" ||
    input.status === "running_command" ||
    input.status === "editing" ||
    input.status === "testing" ||
    input.status === "reviewing" ||
    input.status === "recovering"
  ) {
    return "busy";
  }
  return "unknown";
}
