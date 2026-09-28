import type { SessionCandidate, SessionFollowUp } from "@kalcode/protocol";
import {
  type ComposerRegistration,
  type ComposerSubmitOutcome,
  composerForThread,
  waitForComposer,
} from "./composerRegistry.ts";
import { insertTranscript } from "./dictation.ts";

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
async function sendThrough(registration: ComposerRegistration): Promise<DirectiveReport> {
  const { handle } = registration;
  const name = handle.identity().threadName;
  const mode = handle.mode();
  if (mode === "blocked") return describeSubmit("blocked", name, handle.blockedReason());
  if (mode === "resume") return { ok: false, message: notResuming(name) };
  if (!handle.hasText()) return describeSubmit("empty", name, null);
  return describeSubmit(await handle.submit(), name, handle.blockedReason());
}

/** `submit_composer`: presses that thread's own Send. */
export async function submitComposer(deps: ComposerDirectiveDeps, threadId: string): Promise<void> {
  const registration = composerForThread(threadId);
  if (!registration?.handle.element()?.isConnected) {
    deps.report({ ok: false, message: "That thread's message box isn't open. Nothing was sent." });
    return;
  }
  deps.report(await sendThrough(registration));
}

/** `clear_composer`: empties that thread's message box. Never sends. */
export function clearComposer(deps: ComposerDirectiveDeps, threadId: string): void {
  const registration = composerForThread(threadId);
  if (!registration?.handle.element()?.isConnected) {
    deps.report({ ok: false, message: "That thread's message box isn't open. Nothing was cleared." });
    return;
  }
  registration.handle.clear();
  deps.report({ ok: true, message: `Cleared ${quoted(registration.handle.identity().threadName)}. Nothing was sent.` });
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
  deps.report(await sendThrough(registration));
}

/** A clarification's follow-up for the session the person picked. */
export async function followUpChoice(
  deps: ComposerDirectiveDeps & { focusThread(threadId: string): void },
  choice: SessionCandidate,
  followUp: SessionFollowUp,
): Promise<void> {
  if (followUp.kind === "open") {
    deps.focusThread(choice.threadId);
    deps.report({ ok: true, message: `Opened ${quoted(choice.name)}.` });
    return;
  }
  // Say which session the answer picked before anything is sent (still through its own Send).
  if (followUp.submit) deps.report({ ok: true, message: `Sending to ${choice.label}.` });
  await composeInThread(deps, { threadId: choice.threadId, text: followUp.text, submit: followUp.submit });
}
