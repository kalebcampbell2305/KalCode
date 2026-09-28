import type { SessionCandidate, SessionFollowUp } from "@kalcode/protocol";

/**
 * A pending "Which one?" from KalVoice (`choose_session`). Non-modal and short-lived: the person
 * clicks a choice or says its name on the next push-to-talk; otherwise it expires. Held in this
 * window only; the follow-up text is never shown, stored or logged.
 */
export interface SessionChoiceState {
  id: number;
  question: string;
  choices: SessionCandidate[];
  followUp: SessionFollowUp;
  expiresAt: number;
}

/** How long a clarification waits for an answer. */
export const CHOICE_TTL_MS = 30_000;

const FILLER = new Set([
  "the",
  "a",
  "an",
  "one",
  "ones",
  "please",
  "that",
  "this",
  "use",
  "pick",
  "choose",
  "open",
  "select",
  "go",
  "to",
  "on",
  "in",
  "with",
  "i",
  "mean",
  "meant",
  "thread",
  "session",
  "account",
]);

const ORDINALS: Record<string, number> = {
  first: 0,
  "1st": 0,
  second: 1,
  "2nd": 1,
  third: 2,
  "3rd": 2,
  fourth: 3,
  "4th": 3,
  last: -1,
};

/** Lower-case words without punctuation ("Release · Mac!" → "release mac"). */
export function normalizeSpoken(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^\p{L}\p{N}' ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const tokens = (text: string) => normalizeSpoken(text).split(" ").filter(Boolean);

function candidateWords(choice: SessionCandidate): Set<string> {
  return new Set([
    ...tokens(choice.name),
    ...tokens(choice.providerName),
    ...tokens(choice.accountLabel ?? ""),
    ...tokens(choice.workspaceName),
  ]);
}

/**
 * The choice a spoken answer names, or null when it names none or more than one ("the Mac one",
 * "Release Mac", "second"). Every meaningful word must belong to exactly one choice.
 */
export function pickSpokenChoice(text: string, choices: readonly SessionCandidate[]): SessionCandidate | null {
  const said = normalizeSpoken(text);
  if (!said || choices.length === 0) return null;
  const exact = choices.filter(
    (choice) => normalizeSpoken(choice.name) === said || normalizeSpoken(choice.label) === said,
  );
  if (exact.length === 1) return exact[0] ?? null;
  const words = said.split(" ").filter((word) => !FILLER.has(word));
  if (words.length === 0) return null;
  if (words.length === 1) {
    const ordinal = ORDINALS[words[0] as string];
    if (ordinal !== undefined) return choices.at(ordinal) ?? null;
  }
  const matches = choices.filter((choice) => {
    const known = candidateWords(choice);
    return words.every((word) => known.has(word));
  });
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

/** Whether `state` still waits for an answer at `now`. */
export function choiceIsLive(state: SessionChoiceState | null, now = Date.now()): state is SessionChoiceState {
  return state !== null && now < state.expiresAt;
}
