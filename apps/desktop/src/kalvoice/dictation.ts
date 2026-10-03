import type { ThreadStatus } from "@kalcode/protocol";
import {
  type ComposerRegistration,
  composerForElement,
  composerForThread,
  isCurrentComposer,
} from "./composerRegistry.ts";
import { recordVoiceInsertion } from "./voiceSpans.ts";

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
        /** Opaque identity of the exact provider process/PTY instance. */
        instanceId: string | null;
        /** Native PTY identity for this provider runtime; never aliases a workspace shell. */
        terminalId?: string | null;
      };
  /** Delivers dictated text to the captured destination, resolving only after its transport accepts it. */
  deliver(text: string, options?: DictationDeliveryOptions): Promise<number | undefined>;
  /** Submits text already present in a provider pane. Raw terminals never implement this. */
  submit?(options?: DictationDeliveryOptions): Promise<void>;
  /** Human name for messages ("Terminal"). */
  label: string;
}

interface RegisteredSink {
  sink: DictationSink;
  generation: number;
}

const sinks = new Map<Element, RegisteredSink>();
interface IndexedSink {
  element: Element;
  registration: RegisteredSink;
}

/**
 * A destination can briefly have two mounted views during React replacement. Keep every current
 * registration and select the newest live one; a stale cleanup can then remove only itself.
 */
const sinksByDestination = new Map<string, Map<number, IndexedSink>>();
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
  /** Provider panes send by default. `insert` writes the draft without pressing Enter. */
  mode?: "insert" | "send";
}

export function throwIfDictationCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DictationDeliveryError("dictation_cancelled", "Dictation was cancelled before delivery.");
  }
}

interface QueuedInput {
  data: string;
  signal?: AbortSignal;
  /** Revalidates mutable destination state at the write linearization point. */
  beforeWrite?: () => void;
  /** One delivery's exact native writer, used when its target identity is stricter than the lane default. */
  writeOverride?: (data: string) => Promise<void>;
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
  writeGuarded: (data: string) => Promise<void> = write,
): {
  send(data: string): void;
  deliver(
    data: string,
    options?: DictationDeliveryOptions,
    beforeWrite?: () => void,
    writeOverride?: (data: string) => Promise<void>,
  ): Promise<void>;
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
      let start = 0;
      while (start < batch.length) {
        const first = batch[start];
        if (!first) break;
        const { background, writeOverride } = first;
        let end = start + 1;
        while (
          end < batch.length &&
          batch[end]?.background === background &&
          batch[end]?.writeOverride === writeOverride
        ) {
          end += 1;
        }
        const group: QueuedInput[] = [];
        for (const item of batch.slice(start, end)) {
          if (item.onAbort) item.signal?.removeEventListener("abort", item.onAbort);
          if (closed) {
            item.reject(new DictationDeliveryError("target_closed", "That destination closed before delivery."));
            continue;
          }
          if (item.failure || item.signal?.aborted) {
            item.reject(
              item.failure ??
                new DictationDeliveryError("dictation_cancelled", "Dictation was cancelled before delivery."),
            );
            continue;
          }
          try {
            item.beforeWrite?.();
            group.push(item);
          } catch (cause) {
            item.reject(cause);
          }
        }
        if (group.length === 0) {
          start = end;
          continue;
        }
        try {
          await (background ? write : (writeOverride ?? writeGuarded))(group.map((item) => item.data).join(""));
          for (const item of group) item.resolve();
        } catch (cause) {
          for (const item of group) {
            item.reject(cause);
            if (item.background) onBackgroundError(cause);
          }
        }
        start = end;
      }
    }
    flushing = false;
  };

  const enqueue = (
    data: string,
    background: boolean,
    options: DictationDeliveryOptions = {},
    beforeWrite?: () => void,
    writeOverride?: (data: string) => Promise<void>,
  ) =>
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
      const item: QueuedInput = {
        data,
        signal: options.signal,
        beforeWrite,
        writeOverride,
        resolve,
        reject,
        background,
      };
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
    deliver(data, options, beforeWrite, writeOverride) {
      return enqueue(data, false, options, beforeWrite, writeOverride);
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
  const previous = sinks.get(element);
  if (previous) removeDestinationRegistration(element, previous);
  sinks.set(element, registration);
  for (const key of destinationKeys(sink.destination)) {
    let entries = sinksByDestination.get(key);
    if (!entries) {
      entries = new Map();
      sinksByDestination.set(key, entries);
    }
    entries.set(registration.generation, { element, registration });
  }
  return () => {
    if (sinks.get(element) === registration) sinks.delete(element);
    removeDestinationRegistration(element, registration);
  };
}

function rawTerminalKey(terminalId: string): string {
  return `raw-terminal:${terminalId}`;
}

function providerThreadKey(threadId: string): string {
  return `provider-thread:${threadId}`;
}

function providerTerminalKey(terminalId: string): string {
  return `provider-terminal:${terminalId}`;
}

function destinationKeys(destination: DictationSink["destination"]): string[] {
  if (destination.kind === "raw_terminal") return [rawTerminalKey(destination.terminalId)];
  return [
    providerThreadKey(destination.threadId),
    ...(destination.terminalId ? [providerTerminalKey(destination.terminalId)] : []),
  ];
}

function removeDestinationRegistration(element: Element, registration: RegisteredSink): void {
  for (const key of destinationKeys(registration.sink.destination)) {
    const entries = sinksByDestination.get(key);
    const indexed = entries?.get(registration.generation);
    if (indexed?.element === element && indexed.registration === registration) {
      entries?.delete(registration.generation);
      if (entries?.size === 0) sinksByDestination.delete(key);
    }
  }
}

const TEXT_INPUT_TYPES = new Set(["text", "search", "url", "email", ""]);

export type DictationTarget =
  | { kind: "field"; element: HTMLInputElement | HTMLTextAreaElement; paneId: string | null }
  /** A thread's message box, bound to its thread id (never re-found by DOM id). */
  | { kind: "composer"; element: HTMLTextAreaElement; composer: ComposerRegistration; paneId: string | null }
  | { kind: "sink"; element: Element; sink: DictationSink; generation: number; paneId: string | null };

export type DictationSinkTarget = Extract<DictationTarget, { kind: "sink" }>;

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
  if (!isEditableField(active)) return null;
  // A thread composer is its own registered target, carrying the thread it belongs to.
  const composer = composerForElement(active);
  if (composer && active instanceof HTMLTextAreaElement) {
    return { kind: "composer", element: active, composer, paneId: owningPaneId(active) };
  }
  return { kind: "field", element: active, paneId: owningPaneId(active) };
}

/** Whether the target can still receive text (it may have closed while the user spoke). */
export function targetIsAlive(target: DictationTarget): boolean {
  if (!target.element.isConnected) return false;
  if (target.kind === "field") return isEditableField(target.element);
  if (target.kind === "composer") {
    return (
      isEditableField(target.element) &&
      isCurrentComposer(target.composer) &&
      target.composer.handle.element() === target.element
    );
  }
  const registration = sinks.get(target.element);
  return registration?.generation === target.generation && registration.sink === target.sink;
}

function newestLiveSink(key: string): DictationSinkTarget | null {
  const entries = sinksByDestination.get(key);
  if (!entries) return null;
  let newest: IndexedSink | null = null;
  for (const [generation, indexed] of entries) {
    const current = sinks.get(indexed.element);
    if (!indexed.element.isConnected || current !== indexed.registration || current.generation !== generation) {
      entries.delete(generation);
      continue;
    }
    if (!newest || current.generation > newest.registration.generation) newest = indexed;
  }
  if (entries.size === 0) sinksByDestination.delete(key);
  if (!newest) return null;
  return {
    kind: "sink",
    element: newest.element,
    sink: newest.registration.sink,
    generation: newest.registration.generation,
    paneId: owningPaneId(newest.element),
  };
}

/** The newest live provider-pane target for an immutable thread identity. */
export function dictationTargetForProviderThread(threadId: string): DictationSinkTarget | null {
  const target = newestLiveSink(providerThreadKey(threadId));
  return target?.sink.destination.kind === "provider_pane" && target.sink.destination.threadId === threadId
    ? target
    : null;
}

/** The newest live provider-pane target for its authoritative native PTY identity. */
export function dictationTargetForProviderTerminal(terminalId: string): DictationSinkTarget | null {
  const target = newestLiveSink(providerTerminalKey(terminalId));
  return target?.sink.destination.kind === "provider_pane" && target.sink.destination.terminalId === terminalId
    ? target
    : null;
}

/** A raw workspace shell target. It is kept in a namespace separate from provider PTYs. */
export function dictationTargetForRawTerminal(terminalId: string): DictationSinkTarget | null {
  const target = newestLiveSink(rawTerminalKey(terminalId));
  return target?.sink.destination.kind === "raw_terminal" && target.sink.destination.terminalId === terminalId
    ? target
    : null;
}

function requireProviderTarget(target: DictationSinkTarget | null): DictationSinkTarget {
  if (target?.sink.destination.kind !== "provider_pane" || !targetIsAlive(target)) {
    throw new DictationDeliveryError("target_closed", "That provider pane is not open.");
  }
  return target;
}

async function deliverToProviderTarget(
  target: DictationSinkTarget | null,
  text: string,
  options: DictationDeliveryOptions,
): Promise<number> {
  throwIfDictationCancelled(options.signal);
  const live = requireProviderTarget(target);
  const mode = options.mode ?? "send";
  const delivered = await live.sink.deliver(text, { ...options, mode });
  return delivered ?? providerInputPayload(text, mode).length - (mode === "send" ? 1 : 0);
}

/** Writes a prompt to a provider pane selected by thread. `send` adds exactly one trusted Enter. */
export function deliverToProviderThread(
  threadId: string,
  text: string,
  options: DictationDeliveryOptions = {},
): Promise<number> {
  return deliverToProviderTarget(dictationTargetForProviderThread(threadId), text, options);
}

/**
 * Waits for a provider pane that was just asked to open (a focus intent) to mount its terminal.
 * Resolves the live target, or null when it doesn't appear in time or the request is cancelled.
 */
export function waitForProviderThreadTarget(
  threadId: string,
  signal?: AbortSignal,
  timeoutMs = 8_000,
  intervalMs = 50,
): Promise<DictationSinkTarget | null> {
  const found = dictationTargetForProviderThread(threadId);
  if (found || signal?.aborted) return Promise.resolve(signal?.aborted ? null : found);
  return new Promise((resolve) => {
    const started = Date.now();
    const finish = (target: DictationSinkTarget | null) => {
      clearInterval(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(target);
    };
    const onAbort = () => finish(null);
    const timer = setInterval(() => {
      const target = dictationTargetForProviderThread(threadId);
      if (target || Date.now() - started >= timeoutMs) finish(target);
    }, intervalMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Writes a prompt using the provider runtime's authoritative PTY id, never a raw shell id. */
export function deliverToProviderTerminal(
  terminalId: string,
  text: string,
  options: DictationDeliveryOptions = {},
): Promise<number> {
  return deliverToProviderTarget(dictationTargetForProviderTerminal(terminalId), text, options);
}

async function submitProviderTarget(
  target: DictationSinkTarget | null,
  options: DictationDeliveryOptions,
): Promise<void> {
  throwIfDictationCancelled(options.signal);
  const live = requireProviderTarget(target);
  if (!live.sink.submit) {
    throw new DictationDeliveryError("provider_delivery_failed", "That provider pane cannot submit its draft.");
  }
  await live.sink.submit(options);
}

/**
 * Presses one trusted Enter only through the exact provider registration captured at PTT-down.
 * A replacement mount with the same thread id is deliberately not substituted.
 */
export function submitCapturedProviderTarget(
  target: DictationSinkTarget,
  options: DictationDeliveryOptions = {},
): Promise<void> {
  return submitProviderTarget(target, options);
}

/** Presses one trusted Enter in an already drafted provider pane selected by thread. */
export function submitProviderThread(threadId: string, options: DictationDeliveryOptions = {}): Promise<void> {
  return submitProviderTarget(dictationTargetForProviderThread(threadId), options);
}

/** Presses one trusted Enter in an already drafted provider pane selected by provider PTY id. */
export function submitProviderTerminal(terminalId: string, options: DictationDeliveryOptions = {}): Promise<void> {
  return submitProviderTarget(dictationTargetForProviderTerminal(terminalId), options);
}

/**
 * The same target after a page change. A thread composer is found again only through its own
 * thread's registration (every thread's composer shares one DOM id, so an id lookup could land in
 * another thread). Other fields are re-created by their page and found again by their id. Null
 * when it's gone for good (or not on screen).
 */
export function reconnectTarget(target: DictationTarget): DictationTarget | null {
  if (targetIsAlive(target)) return target;
  if (target.kind === "sink" && target.sink.destination.kind === "provider_pane") {
    const captured = target.sink.destination;
    const again = captured.terminalId
      ? dictationTargetForProviderTerminal(captured.terminalId)
      : dictationTargetForProviderThread(captured.threadId);
    const current = again?.sink.destination;
    // React may remount the same provider pane during navigation. Reconnect only when every
    // immutable provider identity still matches; a same-name or same-thread replacement is not
    // a safe substitute for the target captured at PTT-down.
    if (
      current?.kind === "provider_pane" &&
      current.threadId === captured.threadId &&
      current.instanceId === captured.instanceId &&
      current.terminalId === captured.terminalId &&
      current.providerId === captured.providerId &&
      current.providerAccountId === captured.providerAccountId
    ) {
      return again;
    }
  }
  if (target.kind === "composer") {
    const again = composerForThread(target.composer.handle.threadId);
    const element = again?.handle.element() ?? null;
    return again && element?.isConnected && isEditableField(element)
      ? { kind: "composer", element, composer: again, paneId: owningPaneId(element) }
      : null;
  }
  if (target.kind !== "field" || !target.element.id) return null;
  const again = document.getElementById(target.element.id);
  // A registered composer is never a stand-in for a plain field.
  if (!again || !isEditableField(again) || composerForElement(again)) return null;
  return { kind: "field", element: again, paneId: owningPaneId(again) };
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
): { value: string; caret: number; inserted: string; start: number; end: number } {
  const start = Math.max(0, Math.min(selectionStart, value.length));
  const end = Math.max(start, Math.min(selectionEnd, value.length));
  const before = value.slice(0, start);
  const after = value.slice(end);
  const text = transcript.trim();
  const needsSpace = before.length > 0 && !/[\s([{"'`]$/.test(before) && !/^[.,!?;:)\]}]/.test(text);
  const inserted = `${needsSpace ? " " : ""}${text}`;
  return { value: before + inserted + after, caret: start + inserted.length, inserted, start, end };
}

/** Replaces a text box's value the way typing would (React sees it), with the caret at `caret`. */
export function replaceFieldText(el: HTMLInputElement | HTMLTextAreaElement, value: string, caret: number): void {
  setNativeValue(el, value);
  el.setSelectionRange(caret, caret);
  el.dispatchEvent(new Event("input", { bubbles: true }));
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
  const before = el.value;
  setNativeValue(el, plan.value);
  el.setSelectionRange(plan.caret, plan.caret);
  // A composer remembers exactly what KalVoice typed, so "clear that" removes only that.
  if (target.kind === "composer") {
    recordVoiceInsertion(target.composer.handle.threadId, {
      before,
      start: plan.start,
      end: plan.end,
      inserted: plan.inserted,
      after: plan.value,
    });
  }
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

/** Safe provider input for either drafting or a complete prompt. Only `send` can add Enter. */
export function providerInputPayload(transcript: string, mode: "insert" | "send"): string {
  if (mode === "send") return frameProviderPrompt(transcript);
  const prompt = sanitizeTerminalDictation(transcript);
  if (!prompt) throw new DictationDeliveryError("empty_transcript", "No text remained after safe input filtering.");
  return prompt;
}

export type ProviderInputReadiness = "ready" | "busy" | "provider_prompt" | "unknown" | "ended";

/**
 * Provider input requires a running runtime at a canonical prompt-ready state. The provider
 * lifecycle uses `idle` after SessionStart and after a completed turn; `waiting_for_user` is the
 * more explicit equivalent emitted by providers that expose that distinction.
 */
export function providerInputReadiness(input: {
  running: boolean;
  status: ThreadStatus;
  providerPromptActive: boolean;
}): ProviderInputReadiness {
  if (!input.running) return "ended";
  if (input.providerPromptActive || input.status === "waiting_for_permission") return "provider_prompt";
  if (input.status === "idle" || input.status === "waiting_for_user") return "ready";
  if (
    input.status === "starting" ||
    input.status === "active" ||
    input.status === "thinking" ||
    input.status === "running_tool" ||
    input.status === "running_command" ||
    input.status === "editing" ||
    input.status === "testing" ||
    input.status === "reviewing"
  ) {
    // Provider TUIs accept steering/queued prompts while working. The native voice write still
    // revalidates provider prompts and startup/auth readiness under the provider-session lock.
    return "ready";
  }
  if (input.status === "recovering") return "busy";
  return "unknown";
}

/** Test isolation for the process-local DOM registry. Production unregisters through React effects. */
export function resetDictationSinkRegistryForTests(): void {
  sinks.clear();
  sinksByDestination.clear();
  nextGeneration = 1;
}
