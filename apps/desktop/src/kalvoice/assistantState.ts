/**
 * The KalVoice assistant's visible state, derived only from things that really happen: native
 * listening signals, pipeline stages, and request outcomes.
 */
import type { KalVoiceMode, KalVoiceResponse, KalVoiceSignal, KalVoiceUsage } from "@kalcode/protocol";

export type AssistantPhase =
  | "idle"
  | "listening"
  | "transcribing"
  | "thinking"
  | "executing"
  | "waiting_for_permission"
  | "done"
  | "error";

export interface AssistantState {
  phase: AssistantPhase;
  mode: KalVoiceMode | null;
  sessionId: string | null;
  requestId: string | null;
  /** Detail for the state line and the result area (never persisted). */
  message: string | null;
  /** Error code for ERROR (e.g. `needs_provider`, `limit_reached`, `model_not_installed`). */
  code: string | null;
  lastResponse: KalVoiceResponse | null;
}

export const INITIAL_STATE: AssistantState = {
  phase: "idle",
  mode: null,
  sessionId: null,
  requestId: null,
  message: null,
  code: null,
  lastResponse: null,
};

export type AssistantEvent =
  | { type: "signal"; signal: KalVoiceSignal }
  | { type: "submitted"; requestId: string }
  | { type: "response"; response: KalVoiceResponse }
  | { type: "request_error"; requestId: string; message: string; code: string }
  | { type: "dictation_inserted"; characters: number }
  | { type: "dictation_blocked"; message: string }
  | { type: "settle" };

function fromResponse(state: AssistantState, response: KalVoiceResponse): AssistantState {
  const base = { ...state, requestId: response.requestId, lastResponse: response, mode: null, sessionId: null };
  const outcome = response.outcome;
  switch (outcome.kind) {
    case "completed":
      return { ...base, phase: "done", message: outcome.summary, code: null };
    case "permission_required":
      return {
        ...base,
        phase: "waiting_for_permission",
        message: "This needs your approval before it runs.",
        code: null,
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
      // A late answer to a request the user already moved on from updates the result only.
      if (state.requestId !== null && event.response.requestId !== state.requestId) {
        return state;
      }
      return fromResponse(state, event.response);
    case "request_error":
      if (state.requestId !== event.requestId) return state;
      return { ...state, phase: "error", message: event.message, code: event.code };
    case "dictation_inserted":
      return {
        ...state,
        phase: "done",
        mode: null,
        sessionId: null,
        message: `Inserted ${event.characters.toLocaleString()} character${event.characters === 1 ? "" : "s"}.`,
        code: null,
      };
    case "dictation_blocked":
      return { ...state, phase: "error", mode: null, sessionId: null, message: event.message, code: "no_target" };
    case "settle":
      return state.phase === "done" ? { ...state, phase: "idle" } : state;
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
        message: null,
        code: null,
      };
    case "transcribing":
      return state.sessionId === signal.sessionId ? { ...state, phase: "transcribing" } : state;
    case "result": {
      const result = signal.result;
      if (state.sessionId !== result.sessionId) return state;
      if (result.kind === "nothing_heard") {
        return { ...state, phase: "idle", mode: null, sessionId: null, message: "Nothing was heard.", code: null };
      }
      // Dictation results are inserted by the provider (then `dictation_inserted`); command
      // transcripts are submitted as a request (then `submitted`).
      return state;
    }
    case "listening_failed":
      return { ...state, phase: "error", mode: null, sessionId: null, message: signal.message, code: signal.code };
    case "cancelled":
      if (state.sessionId !== signal.sessionId) return state;
      // A quick tap of the command shortcut opens the assistant for typing: nothing to report.
      return {
        ...state,
        phase: "idle",
        mode: null,
        sessionId: null,
        message: signal.mode === "command" ? null : "Cancelled.",
        code: null,
      };
    case "request_stage":
      if (state.requestId !== signal.requestId) return state;
      if (state.phase !== "thinking" && state.phase !== "executing") return state;
      return { ...state, phase: signal.stage === "executing" ? "executing" : "thinking" };
    case "request_resolved":
      return state.requestId === signal.response.requestId ? fromResponse(state, signal.response) : state;
    default:
      return state;
  }
}

const LABELS: Record<AssistantPhase, string> = {
  idle: "Ready",
  listening: "Listening…",
  transcribing: "Transcribing…",
  thinking: "Thinking…",
  executing: "Running the command…",
  waiting_for_permission: "Waiting for your approval",
  done: "Done",
  error: "Needs attention",
};

/** The short state line under the KALVOICE header. */
export function stateLine(state: AssistantState): string {
  if (state.phase === "listening") {
    return state.mode === "dictation" ? "Listening… release to insert" : "Listening… release to send";
  }
  if (state.phase === "idle" && state.message) return state.message;
  return LABELS[state.phase];
}

/** What screen readers hear when the state changes. */
export function announcement(state: AssistantState): string {
  const detail = state.phase === "done" || state.phase === "error" ? state.message : null;
  return detail ? `KalVoice: ${LABELS[state.phase]}. ${detail}` : `KalVoice: ${stateLine(state)}`;
}

export const PHASE_NAMES: Record<AssistantPhase, string> = {
  idle: "IDLE",
  listening: "LISTENING",
  transcribing: "TRANSCRIBING",
  thinking: "THINKING",
  executing: "EXECUTING",
  waiting_for_permission: "WAITING FOR PERMISSION",
  done: "DONE",
  error: "ERROR",
};

const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

export function formatDay(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : DAY.format(date);
}

/** "Used 3 of 250 · resets Oct 1" / "Unlimited KalVoice Requests". */
export function usageLine(usage: KalVoiceUsage): string {
  if (usage.allowance === null) return `${usage.used.toLocaleString("en-US")} KalVoice Requests this month · unlimited`;
  return `Used ${usage.used.toLocaleString("en-US")} of ${usage.allowance.toLocaleString("en-US")} · resets ${formatDay(usage.resetsAt)}`;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${Math.round(bytes / 1_000_000)} MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${bytes} B`;
}
