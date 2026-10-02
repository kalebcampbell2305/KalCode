import type { KalTidyApi } from "../surfaces/code/kaltidy/kalTidyContext.ts";
import type { DirectiveReport } from "./voiceDirectives.ts";

/**
 * KalVoice's KalTidy commands: "close all idle terminals" runs KalTidy, "review idle terminals"
 * opens its review. Recognized in the window before native routing, like a "Which one?" answer:
 * KalTidy lives in the UI and has no native intent. Only a whole utterance that is exactly one of
 * these phrases (around the same filler the native grammar ignores) counts, so it is as sure as
 * a native high-confidence command; any other words ("close this terminal", "stop the build",
 * a sentence being dictated) are left to native routing unchanged.
 */
export type KalTidyVoiceCommand = "run" | "review";

const NAME = "(kaltidy|kal tidy|cal tidy|caltidy)";
const ALL = "[all|all the|all my|all of the|all of my|the|my]";

const PATTERNS: Record<KalTidyVoiceCommand, string[]> = {
  run: [
    `(close|stop|kill|shut down) ${ALL} idle terminals`,
    "(clean|tidy) up [all] [the|my] terminals",
    "tidy [all] [the|my] terminals",
    NAME,
    `(run|start) ${NAME}`,
  ],
  review: [
    `(review|show|list) [me] ${ALL} idle terminals`,
    "which [of] [the|my] terminals are idle",
    `${NAME} review`,
    `(review|open) ${NAME}`,
  ],
};

/** Every concrete wording of a pattern: `(a|b)` is a choice, `[a|b]` an optional choice. */
function expand(pattern: string): string[] {
  let out = [""];
  for (const part of pattern.match(/\([^)]*\)|\[[^\]]*\]|\S+/g) ?? []) {
    const choices = part.startsWith("(")
      ? part.slice(1, -1).split("|")
      : part.startsWith("[")
        ? ["", ...part.slice(1, -1).split("|")]
        : [part];
    out = out.flatMap((prefix) => choices.map((choice) => [prefix, choice].filter(Boolean).join(" ")));
  }
  return out;
}

const PHRASES = new Map<string, KalTidyVoiceCommand>(
  (Object.entries(PATTERNS) as [KalTidyVoiceCommand, string[]][]).flatMap(([command, patterns]) =>
    patterns.flatMap(expand).map((phrase) => [phrase, command] as const),
  ),
);

/** Addressing KalVoice ("Hey Kal, …"), as the native grammar strips it. */
const ADDRESS = [
  "hey kal code",
  "hey kal voice",
  "hey kalcode",
  "hey kalvoice",
  "hey kal",
  "hey cal",
  "okay kal",
  "ok kal",
  "kal code",
  "kal voice",
  "kalcode",
  "kalvoice",
  "kal",
];

/** The native grammar's leading filler and opening disfluencies. */
const LEADING = [
  "um",
  "umm",
  "uh",
  "er",
  "erm",
  "hmm",
  "so",
  "well",
  "alright",
  "all right",
  "hey",
  "hi",
  "ok",
  "okay",
  "please",
  "kindly",
  "just",
  "quickly",
  "now",
  "can you",
  "could you",
  "would you",
  "will you",
  "can we",
  "could we",
  "lets",
  "let us",
  "go ahead and",
  "i want you to",
  "i would like you to",
  "id like you to",
  "i need you to",
  "i want to",
  "i would like to",
  "id like to",
  "i need to",
];

const TRAILING = ["please", "for me", "right now", "now", "thanks", "thank you", "kalvoice", "asap"];

function words(text: string): string {
  return text
    .toLowerCase()
    .replace(/['‘’]/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "")
    .join(" ");
}

function stripLeading(text: string, phrases: readonly string[]): string {
  for (const phrase of phrases) {
    if (text === phrase) return "";
    if (text.startsWith(`${phrase} `)) return stripLeading(text.slice(phrase.length + 1), phrases);
  }
  return text;
}

function stripTrailing(text: string): string {
  for (const phrase of TRAILING) {
    if (text === phrase) return "";
    if (text.endsWith(` ${phrase}`)) return stripTrailing(text.slice(0, -phrase.length - 1));
  }
  return text;
}

/** The KalTidy command an utterance is, or null when it is anything else. */
export function parseKalTidyCommand(text: string): KalTidyVoiceCommand | null {
  const said = words(text);
  // "Kal tidy" is the name, not "Kal," + "tidy": try the words as said before removing an address.
  for (const candidate of [said, stripLeading(said, ADDRESS)]) {
    const core = stripTrailing(stripLeading(candidate, LEADING));
    const command = PHRASES.get(core);
    if (command) return command;
  }
  return null;
}

/**
 * Runs a KalTidy command and reports through KalVoice's normal result line. KalTidy itself
 * decides what is idle; KalVoice never stops a terminal any other way.
 */
export async function runKalTidyCommand(
  kalTidy: KalTidyApi | null,
  command: KalTidyVoiceCommand,
  report: (result: DirectiveReport) => void,
): Promise<void> {
  if (!kalTidy) {
    report({ ok: false, message: "KalTidy isn't available here. Nothing was stopped." });
    return;
  }
  if (command === "review") {
    kalTidy.openReview();
    report({ ok: true, message: "Opened KalTidy review. Nothing was stopped." });
    return;
  }
  try {
    const outcome = await kalTidy.stopIdle();
    report({ ok: outcome.failed === 0, message: outcome.summary });
  } catch {
    report({ ok: false, message: "KalTidy couldn't finish. Some idle terminals may still be running." });
  }
}
