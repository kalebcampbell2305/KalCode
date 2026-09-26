/**
 * The KalVoice widget's state, derived only from things that really happen: native listening
 * signals, pipeline stages and request outcomes.
 *
 * States shown to people: Ready · Listening · Processing · Executing · Done · Error.
 */
import type { KalVoiceMode, KalVoiceResponse, KalVoiceSignal, KalVoiceUsage, TalkRoute } from "@kalcode/protocol";

export type AssistantPhase = "idle" | "listening" | "transcribing" | "thinking" | "executing" | "done" | "error";

/** The last push-to-talk utterance, for "Type it instead". Kept in this window only. */
export interface LastTalk {
  requestId: string;
  text: string;
  route: TalkRoute;
  /** Something that accepts text had focus when the key went down. */
  hadTarget: boolean;
}

export interface AssistantState {
  phase: AssistantPhase;
  mode: KalVoiceMode | null;
  sessionId: string | null;
  requestId: string | null;
  /** Live partial transcript while the key is held (never stored). */
  partial: string | null;
  /** Detail for the state line and the result area (never persisted). */
  message: string | null;
  /** Error code for ERROR (e.g. `needs_provider`, `limit_reached`, `model_not_installed`). */
  code: string | null;
  lastResponse: KalVoiceResponse | null;
  lastTalk: LastTalk | null;
}

export const INITIAL_STATE: AssistantState = {
  phase: "idle",
  mode: null,
  sessionId: null,
  requestId: null,
  partial: null,
  message: null,
  code: null,
  lastResponse: null,
  lastTalk: null,
};

export type AssistantEvent =
  | { type: "signal"; signal: KalVoiceSignal }
  | { type: "submitted"; requestId: string }
  | { type: "response"; response: KalVoiceResponse }
  | { type: "request_error"; requestId: string; message: string; code: string }
  | { type: "talked"; talk: LastTalk }
  | { type: "dictation_inserted"; characters: number }
  | { type: "dictation_blocked"; message: string }
  | { type: "typed_instead"; message: string }
  | { type: "dismiss" }
  | { type: "settle" };

function fromResponse(state: AssistantState, response: KalVoiceResponse): AssistantState {
  const base = {
    ...state,
    requestId: response.requestId,
    lastResponse: response,
    mode: null,
    sessionId: null,
    partial: null,
  };
  const outcome = response.outcome;
  switch (outcome.kind) {
    case "completed":
      return { ...base, phase: "done", message: outcome.summary, code: null };
    case "permission_required":
      return {
        ...base,
        phase: "error",
        message: "The provider session is waiting for permission. Review its native prompt.",
        code: "provider_permission_required",
      };
    case "needs_provider":
      return { ...base, phase: "error", message: outcome.message, code: "needs_provider" };
    case "limit_reached":
      return {
        ...base,
        phase: "error",
        message: `You've used this month's KalVoice Requests. They reset ${formatDay(outcome.resetsAt)}. Dictation keeps working.`,
        code: "limit_reached",
      };
    case "failed":
      return { ...base, phase: "error", message: outcome.message, code: outcome.code };
  }
}

export function reduce(state: AssistantState, event: AssistantEvent): AssistantState {
  switch (event.type) {
    case "submitted":
      return { ...state, phase: "thinking", requestId: event.requestId, message: null, code: null };
    case "response":
      // A late answer to a request the user already moved on from is ignored.
      if (state.requestId !== null && event.response.requestId !== state.requestId) return state;
      return fromResponse(state, event.response);
    case "request_error":
      if (state.requestId !== event.requestId) return state;
      return { ...state, phase: "error", message: event.message, code: event.code, partial: null };
    case "talked":
      return { ...state, lastTalk: event.talk };
    case "dictation_inserted":
      return {
        ...state,
        phase: "done",
        mode: null,
        sessionId: null,
        partial: null,
        message: `Inserted ${event.characters.toLocaleString()} character${event.characters === 1 ? "" : "s"}.`,
        code: null,
      };
    case "dictation_blocked":
      return {
        ...state,
        phase: "error",
        mode: null,
        sessionId: null,
        partial: null,
        message: event.message,
        code: "no_target",
      };
    case "typed_instead":
      return { ...state, phase: "done", message: event.message, code: null, lastTalk: null };
    case "dismiss":
      return { ...state, phase: "idle", message: null, code: null, partial: null };
    case "settle":
      return state.phase === "done" ? { ...state, phase: "idle", message: null } : state;
    case "signal":
      return onSignal(state, event.signal);
  }
}

function onSignal(state: AssistantState, signal: KalVoiceSignal): AssistantState {
  switch (signal.kind) {
    case "listening_started":
      return {
        ...state,
        phase: "listening",
        mode: signal.mode,
        sessionId: signal.sessionId,
        partial: null,
        message: null,
        code: null,
        lastTalk: null,
      };
    case "partial":
      return state.sessionId === signal.sessionId ? { ...state, partial: signal.text } : state;
    case "transcribing":
      return state.sessionId === signal.sessionId ? { ...state, phase: "transcribing" } : state;
    case "result": {
      const result = signal.result;
      if (state.sessionId !== result.sessionId) return state;
      if (result.kind === "nothing_heard") {
        return { ...state, phase: "idle", mode: null, sessionId: null, partial: null, message: "Nothing was heard." };
      }
      // The provider routes the transcript next (command, dictation or request).
      return { ...state, partial: result.text };
    }
    case "listening_failed":
      return {
        ...state,
        phase: "error",
        mode: null,
        sessionId: null,
        partial: null,
        message: signal.message,
        code: signal.code,
      };
    case "cancelled":
      if (state.sessionId !== signal.sessionId) return state;
      return { ...state, phase: "idle", mode: null, sessionId: null, partial: null, message: "Cancelled.", code: null };
    case "request_stage":
      if (state.requestId !== signal.requestId) return state;
      if (state.phase !== "thinking" && state.phase !== "executing" && state.phase !== "transcribing") return state;
      return { ...state, phase: signal.stage === "executing" ? "executing" : "thinking" };
    case "request_resolved":
      return state.requestId === signal.response.requestId ? fromResponse(state, signal.response) : state;
    default:
      return state;
  }
}

/** The state name shown next to the status dot. */
export const STATE_LABELS: Record<AssistantPhase, string> = {
  idle: "Ready",
  listening: "Listening",
  transcribing: "Processing",
  thinking: "Processing",
  executing: "Executing",
  done: "Done",
  error: "Error",
};

/** What screen readers hear when the state changes. */
export function announcement(state: AssistantState): string {
  const label = STATE_LABELS[state.phase];
  const detail = (state.phase === "done" || state.phase === "error") && state.message ? ` ${state.message}` : "";
  return `KalVoice: ${label}.${detail}`;
}

const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

export function formatDay(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : DAY.format(date);
}

/** "482 / 1,500 used · 1,018 remaining · renews Oct 1" / "… · Unlimited". */
export function usageLine(usage: KalVoiceUsage): string {
  const used = usage.used.toLocaleString("en-US");
  if (usage.allowance === null) return `${used} KalVoice Requests used · Unlimited`;
  const remaining = Math.max(0, usage.allowance - usage.used).toLocaleString("en-US");
  return `${used} / ${usage.allowance.toLocaleString("en-US")} used · ${remaining} remaining · renews ${formatDay(usage.resetsAt)}`;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${Math.round(bytes / 1_000_000)} MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${bytes} B`;
}
