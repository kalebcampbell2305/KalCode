import type { SessionCandidate, SessionFollowUp } from "@kalcode/protocol";
import {
  type ComposerRegistration,
  type ComposerSubmitOutcome,
  composerForThread,
  waitForComposer,
} from "./composerRegistry.ts";
import { insertTranscript, replaceFieldText } from "./dictation.ts";
import { forgetVoiceText, planVoiceClear } from "./voiceSpans.ts";

/**
 * The UI side of KalVoice's composer directives (0.1.5 TK-2). Every send goes through the
 * composer's own Send, so prompt review and the warning dialog apply unchanged; a warned prompt
 * stops at the dialog and voice never confirms it. Nothing here resumes a stopped thread or
 * answers a permission request. Messages name the thread only, never the text.
 */

export interface DirectiveReport {
  ok: boolean;
  message: string;
}

export interface ComposerDirectiveDeps {
  /** Shows `threadId` in the Threads surface, where its composer lives. */
  openThread(threadId: string): void;
  report(result: DirectiveReport): void;
  /** How long to wait for a thread's composer to appear after opening it. */
  waitMs?: number;
  signal?: AbortSignal;
}

const quoted = (name: string) => `“${name}”`;

function notResuming(name: string): string {
  return `${quoted(name)} isn't running. Press Resume and send to resume it with your message. Nothing was sent.`;
}

function describeSubmit(outcome: ComposerSubmitOutcome, name: string, blocked: string | null): DirectiveReport {
  switch (outcome) {
    case "sent":
      return { ok: true, message: `Sent to ${quoted(name)}.` };
    case "confirm":
      return {
        ok: true,
        message: `Review the warning for ${quoted(name)}. Nothing is sent until you confirm it.`,
      };
    case "busy":
      return { ok: false, message: `${quoted(name)} is already sending a message.` };
    case "empty":
      return { ok: false, message: `${quoted(name)} has no message to send.` };
    case "blocked":
      return { ok: false, message: blocked ?? "This thread can't take messages right now. Nothing was sent." };
    default:
      return { ok: false, message: `The message to ${quoted(name)} wasn't sent.` };
  }
}

/** Runs one composer's own Send, refusing what voice must never do (resume, blocked threads). */
async function sendThrough(registration: ComposerRegistration, signal?: AbortSignal): Promise<DirectiveReport | null> {
  if (signal?.aborted) return null;
  const { handle } = registration;
  const name = handle.identity().threadName;
  const mode = handle.mode();
  if (mode === "blocked") return describeSubmit("blocked", name, handle.blockedReason());
  if (mode === "resume") return { ok: false, message: notResuming(name) };
  if (!handle.hasText()) return describeSubmit("empty", name, null);
  const outcome = await handle.submit();
  if (signal?.aborted) return null;
  return describeSubmit(outcome, name, handle.blockedReason());
}

/** `submit_composer`: presses that thread's own Send. */
export async function submitComposer(deps: ComposerDirectiveDeps, threadId: string): Promise<void> {
  if (deps.signal?.aborted) return;
  const registration = composerForThread(threadId);
  if (!registration?.handle.element()?.isConnected) {
    deps.report({ ok: false, message: "That thread's message box isn't open. Nothing was sent." });
    return;
  }
  const result = await sendThrough(registration, deps.signal);
  if (result && !deps.signal?.aborted) deps.report(result);
}

/**
 * `clear_composer`: removes only the text KalVoice typed into that thread's box since its last
 * send or clear. Text the person typed is never deleted: when KalVoice can't tell exactly which
 * characters it typed (the person edited in or right next to them), it refuses and changes
 * nothing. Never sends.
 */
export function clearComposer(deps: ComposerDirectiveDeps, threadId: string): void {
  if (deps.signal?.aborted) return;
  const element = composerForThread(threadId)?.handle.element() ?? null;
  if (!element?.isConnected) {
    deps.report({ ok: false, message: "That thread's message box isn't open. Nothing was cleared." });
    return;
  }
  const plan = planVoiceClear(threadId, element.value);
  if (plan.kind === "nothing") {
    forgetVoiceText(threadId);
    deps.report({ ok: true, message: "Nothing to clear." });
    return;
  }
  if (plan.kind === "ambiguous") {
    deps.report({ ok: false, message: "I couldn't tell which text I typed — clear it yourself." });
    return;
  }
  // Through the box's own input path, so the composer (and a pending prompt review) follow.
  replaceFieldText(element, plan.value, plan.caret);
  forgetVoiceText(threadId);
  deps.report({ ok: true, message: "Cleared what KalVoice typed. Nothing was sent." });
}

/**
 * `compose_in_thread`: opens the thread, puts `text` in its message box and, when `submit` is
 * set, sends it through the composer's own Send. A thread waiting for a permission decision is
 * refused with the composer's own message; a stopped thread keeps the text for the person to
 * resume; an unsent draft already in the box is never sent along without the person seeing it.
 */
export async function composeInThread(
  deps: ComposerDirectiveDeps,
  { threadId, text, submit }: { threadId: string; text: string; submit: boolean },
): Promise<void> {
  if (deps.signal?.aborted) return;
  deps.openThread(threadId);
  const waited = await waitForComposer(threadId, {
    timeoutMs: deps.waitMs ?? 3000,
    ...(deps.signal ? { signal: deps.signal } : {}),
  });
  if (deps.signal?.aborted) return;
  // The thread's current registration (a remount may have replaced the one that was first seen).
  const registration = waited ? composerForThread(threadId) : null;
  const element = registration?.handle.element() ?? null;
  if (!registration || !element) {
    deps.report({ ok: false, message: "KalCode couldn't open that thread's message box. Nothing was sent." });
    return;
  }
  const { handle } = registration;
  const name = handle.identity().threadName;
  const mode = handle.mode();
  if (mode === "blocked") {
    deps.report({
      ok: false,
      message: handle.blockedReason() ?? "This thread can't take messages right now. Nothing was sent.",
    });
    return;
  }
  const hadDraft = handle.hasText();
  element.focus();
  element.setSelectionRange(element.value.length, element.value.length);
  try {
    await insertTranscript({ kind: "composer", element, composer: registration, paneId: null }, text, {
      ...(deps.signal ? { signal: deps.signal } : {}),
    });
  } catch {
    if (deps.signal?.aborted) return;
    deps.report({ ok: false, message: `${quoted(name)}'s message box couldn't take the text. Nothing was sent.` });
    return;
  }
  if (deps.signal?.aborted) return;
  if (!submit) {
    deps.report({ ok: true, message: `Added to ${quoted(name)}. Nothing was sent.` });
    return;
  }
  if (mode === "resume") {
    deps.report({
      ok: true,
      message: `${quoted(name)} isn't running. Your message is in its box; press Resume and send to resume it.`,
    });
    return;
  }
  if (hadDraft) {
    deps.report({
      ok: true,
      message: `${quoted(name)} already had an unsent message. KalVoice added yours after it; review it and press Send.`,
    });
    return;
  }
  const result = await sendThrough(registration, deps.signal);
  if (result && !deps.signal?.aborted) deps.report(result);
}

/** A clarification's follow-up for the session the person picked. */
export async function followUpChoice(
  deps: ComposerDirectiveDeps & { focusThread(threadId: string): void },
  choice: SessionCandidate,
  followUp: SessionFollowUp,
): Promise<void> {
  if (deps.signal?.aborted) return;
  if (followUp.kind === "open") {
    deps.focusThread(choice.threadId);
    if (!deps.signal?.aborted) deps.report({ ok: true, message: `Opened ${quoted(choice.name)}.` });
    return;
  }
  await composeInThread(deps, { threadId: choice.threadId, text: followUp.text, submit: followUp.submit });
}
