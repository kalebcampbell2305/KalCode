/**
 * TEST DOUBLE — KalVoice for the in-memory transport (unit tests and the `ui-test` Playwright
 * build only; never bundled into development or production builds).
 *
 * It stands in for the native KalVoice runtime: the push-to-talk key (emulated with key events
 * on the page, since the browser has no OS-level hotkeys), the microphone level, a FAKE speech
 * recognizer that returns a fixed transcript instead of listening (with partials revealed word by
 * word), a small subset of the command grammar and router, the usage ledger and model downloads.
 * Messages mirror the native ones so UI tests exercise the real UI flows. Nothing here records or
 * recognizes audio.
 *
 * Scenarios (`?scenario=`): kalvoice-limit (allowance used up), kalvoice-no-model (no speech
 * model installed and the owner opted out of the automatic download), kalvoice-first-run (a
 * brand-new install: the default speech model provisions itself, as native zero-setup does),
 * kalvoice-mic-denied (microphone blocked), kalvoice-approvals (a legacy URL alias retained for
 * app-control coverage), kalvoice-slow (stages last long enough to observe).
 * App-control commands run immediately; provider sessions keep their own native permission
 * prompts. Thread commands report fixed test-double results.
 * `?transcript=` sets what the fake recognizer "hears" (`__kalcodeMemory.kalvoice.setTranscript` changes
 * it between utterances). Composer and session commands ("send that", "clear that", "tell <name>
 * to …", "go back") mirror the 0.1.5 TK-3 grammar closely enough for UI tests.
 */
import type {
  AgentFilter,
  CommandRequest,
  ComponentProvisioning,
  EventPayload,
  IpcError,
  KalVoiceMode,
  KalVoiceOutcome,
  KalVoicePreferences,
  KalVoicePreferencesPatch,
  KalVoiceResponse,
  KalVoiceSignal,
  KalVoiceStatus,
  KalVoiceUsage,
  PanelPlacement,
  ReservedShortcut,
  SessionResolution,
  SpeechModelInfo,
  StageTimings,
  SurfaceId,
  TalkRequest,
  TalkResponse,
  TalkRoute,
  UiCommandRequest,
  UiDirective,
} from "@kalcode/protocol";
import { getPlan } from "@kalcode/protocol";
import { checkReserved, isTalkKey } from "../kalvoice/shortcutModel.ts";
import { normalizeBrowserAddress } from "../surfaces/browser/browserModel.ts";

// The in-memory backend has no verified plan: the Free allowance from the plan catalog.
const FREE_KALVOICE_ALLOWANCE = getPlan("free").limits.kalvoiceRequestsPerMonth ?? 0;

export const KALVOICE_SCENARIOS = [
  "kalvoice-limit",
  "kalvoice-no-model",
  "kalvoice-first-run",
  "kalvoice-mic-denied",
  "kalvoice-approvals",
  "kalvoice-slow",
] as const;
export type KalVoiceScenario = (typeof KALVOICE_SCENARIOS)[number];

export function isKalVoiceScenario(value: string | null): value is KalVoiceScenario {
  return value !== null && (KALVOICE_SCENARIOS as readonly string[]).includes(value);
}

type Emit = (event: EventPayload, options?: { correlation?: { requestId?: string | null } }) => unknown;

const RESERVED: ReservedShortcut[] = [
  { accelerator: "F5", owner: "reloading the window" },
  { accelerator: "F7", owner: "caret browsing" },
  { accelerator: "F12", owner: "developer tools" },
];

const TALK_KEYS = [...Array.from({ length: 24 }, (_, i) => `F${i + 1}`), "Pause", "ScrollLock", "Insert"];

/** Pretends another app already registered this key globally (to exercise the refusal path). */
const TAKEN_BY_ANOTHER_APP = "F9";

const SOURCE = "KalCode's signed component catalog on kalcoded.com";
const CATALOG: Omit<SpeechModelInfo, "state">[] = [
  {
    id: "tiny.en",
    displayName: "English (fastest)",
    summary: "Quickest response to commands. Recommended.",
    sizeBytes: 77_704_715,
    englishOnly: true,
    source: SOURCE,
  },
  {
    id: "base.en",
    displayName: "English (balanced)",
    summary: "More accurate dictation; a little slower to respond.",
    sizeBytes: 147_964_211,
    englishOnly: true,
    source: SOURCE,
  },
  {
    id: "small.en",
    displayName: "English (more accurate)",
    summary: "Better with accents and technical words; slower on older computers.",
    sizeBytes: 487_614_201,
    englishOnly: true,
    source: SOURCE,
  },
  {
    id: "base",
    displayName: "Multilingual (compact)",
    summary: "Detects and transcribes about 100 languages.",
    sizeBytes: 147_951_465,
    englishOnly: false,
    source: SOURCE,
  },
  {
    id: "small",
    displayName: "Multilingual (more accurate)",
    summary: "About 100 languages with higher accuracy; slower on older computers.",
    sizeBytes: 487_601_967,
    englishOnly: false,
    source: SOURCE,
  },
];

const SURFACE_WORDS: Record<string, SurfaceId> = {
  dashboard: "dashboard",
  home: "dashboard",
  activity: "dashboard",
  kalvoice: "kalvoice",
  code: "code",
  threads: "threads",
  agents: "agents",
  missions: "missions",
  automations: "automations",
  skills: "skills",
  plugins: "plugins",
  memory: "memory",
  providers: "providers",
  settings: "settings",
};

const SURFACE_LABELS: Record<SurfaceId, string> = {
  operations: "Operations",
  dashboard: "Activity",
  kalvoice: "KalVoice",
  code: "Code",
  threads: "Threads",
  agents: "Agents",
  missions: "Missions",
  automations: "Automations",
  skills: "Skills",
  plugins: "Plugins",
  memory: "Memory",
  providers: "Providers",
  settings: "Settings",
  command_center: "the Command Center",
};

const DONE_SUMMARY: Record<string, string> = {
  create_threads: "Opened 4 Codex threads (test double).",
  resume_threads: "Resumed all threads (test double).",
  pause_threads: "Paused all threads (test double).",
  stop_threads: "Stopped all threads (test double).",
};

function fail(code: string, message: string, category: IpcError["category"] = "validation"): never {
  throw { category, code, message, retryable: false } satisfies IpcError;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Parsed {
  kind: string;
  high: boolean;
  outcome?: KalVoiceOutcome;
  directive?: UiDirective;
  consequential?: boolean;
  /** "tell <session> to <prompt>": the session query and the verbatim prompt. */
  direct?: { query: string; prompt: string };
}

/** Resolves a spoken session name the way `session_resolve` does. */
export type MemorySessionResolver = (
  query: string,
  context: { workspaceId: string | null; focusedThreadId: string | null },
) => Promise<SessionResolution>;

/** Addressing KalVoice itself ("Hey Kal, …"), as native `grammar_sessions::ADDRESS`. */
const ADDRESS =
  /^(?:hey kal ?code|hey kal ?voice|hey kal|hey cal|ok(?:ay)? kal|kal ?code|kal ?voice|kal)(?:[\s,:;!.\-—]+|$)/iu;
const THING = "(?:thread|terminal|session|one|pane|agent|tab)";
const GO_BACK = new RegExp(
  `^(?:go back|(?:(?:go|switch|jump|take|head) )?back to (?:the|my) (?:(?:previous|last) )?${THING}(?: i was (?:just )?(?:using|in|on|at|working (?:in|on)|looking at))?|(?:previous|last) ${THING})$`,
);

/** "send that", "clear that", "go back", "tell <name> to <prompt>": the phrases of native
 * `grammar_sessions` (0.1.5 TK-3, lane B1) that UI tests drive. */
function sessionCommand(text: string, t: string): Parsed | null {
  if (
    /^(?:(?:send|submit) (?:that|it|this)(?: now)?|(?:send|submit) (?:that|this|the) (?:message|prompt)|(?:press|hit|click) send)$/.test(
      t,
    )
  ) {
    return { kind: "submit_focused", high: true };
  }
  if (
    /^(?:(?:clear|cancel|scratch|delete) (?:that|this|it)|never ?mind(?: that)?|(?:don'?t|do not) send (?:that|it|this))$/.test(
      t,
    )
  ) {
    return { kind: "clear_focused", high: true };
  }
  if (GO_BACK.test(t)) {
    return {
      kind: "focus_previous",
      high: true,
      outcome: { kind: "completed", summary: "Going back." },
      directive: { kind: "focus_previous" },
    };
  }
  // The prompt keeps the person's own casing and punctuation.
  const spoken = text.trim().replace(ADDRESS, "");
  const direct = spoken.match(
    /^(?:(?:please|okay|ok|now|so)\s+|(?:can|could|would|will) you\s+)*(?:tell|ask)\s+(.+?)(?:\s+(?:to|that)\s+|\s*[,:;]\s*)(\S.*)$/iu,
  );
  if (
    direct?.[1] &&
    direct[2] &&
    !/^(?:me|us|you|yourself|everyone|everybody|them|him|her|about|for|if|whether)\b/iu.test(direct[1])
  ) {
    return { kind: "direct_prompt", high: false, direct: { query: direct[1], prompt: direct[2] } };
  }
  return null;
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^\p{L}\p{N}' ]+/gu, " ")
    .replace(/\bwhat's\b/g, "what is")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(please |hey kalvoice |hey kal code |hey kalcode |hey kal |ok kal |okay kal )+/, "");
}

const PROVIDER_IDS: Record<string, string> = {
  claude: "claude-code",
  "claude code": "claude-code",
  codex: "codex",
  cursor: "cursor",
  gemini: "gemini-cli",
  "gemini cli": "gemini-cli",
};
const PROVIDER_NAMES: Record<string, string> = {
  "claude-code": "Claude",
  codex: "Codex",
  cursor: "Cursor",
  "gemini-cli": "Gemini",
};
const PROVIDER = "(claude code|claude|codex|cursor|gemini cli|gemini)";
const PANE = "(?: (?:the|this|my|current))?(?: (?:pane|panes|screen|view|window))?";

/** Pane layout commands (Z7-W1), mirroring the native pane rules. Layout only. */
function paneCommand(t: string): Parsed | null {
  const split = (axis: "horizontal" | "vertical"): Parsed => ({
    kind: "split",
    high: true,
    outcome: {
      kind: "completed",
      summary: `Split the pane ${axis === "horizontal" ? "side by side" : "top and bottom"}.`,
    },
    directive: { kind: "split_pane", axis },
  });
  if (new RegExp(`^split${PANE} (vertically|down|stacked|top and bottom)$`).test(t)) return split("vertical");
  if (new RegExp(`^split${PANE}( side by side| horizontally| right| left and right)?$`).test(t)) {
    return split("horizontal");
  }
  const arrange = t.match(
    new RegExp(
      `^(?:split|put|place|show|arrange|open) ${PROVIDER} (?:and|next to) ${PROVIDER}( side by side| next to each other)?$`,
    ),
  );
  if (arrange?.[1] && arrange[2]) {
    const ids = [PROVIDER_IDS[arrange[1]], PROVIDER_IDS[arrange[2]]].filter((id): id is string => Boolean(id));
    if (ids.length === 2 && ids[0] !== ids[1]) {
      return {
        kind: "split",
        high: true,
        outcome: {
          kind: "completed",
          summary: `Putting ${ids.map((id) => PROVIDER_NAMES[id] ?? id).join(" and ")} side by side.`,
        },
        directive: { kind: "arrange_panes", axis: "horizontal", providerIds: ids },
      };
    }
  }
  const resize = t.match(
    new RegExp(`^make${PANE} (?:(a bit|a little|much|a lot) )?(bigger|larger|wider|taller|smaller|narrower|shorter)$`),
  );
  if (resize?.[2]) {
    const word = resize[2];
    const direction =
      word === "taller"
        ? "down"
        : word === "shorter"
          ? "up"
          : word === "smaller" || word === "narrower"
            ? "left"
            : "right";
    const steps = resize[1] === "a bit" || resize[1] === "a little" ? 1 : resize[1] ? 4 : 2;
    const said =
      direction === "right" ? "bigger" : direction === "left" ? "smaller" : direction === "down" ? "taller" : "shorter";
    return {
      kind: "resize",
      high: true,
      outcome: { kind: "completed", summary: `Made the pane ${said}.` },
      directive: { kind: "resize_pane", direction, steps },
    };
  }
  if (/^close (the |this |my |current )?pane$/.test(t)) {
    return {
      kind: "close",
      high: true,
      outcome: { kind: "completed", summary: "Closed the pane." },
      directive: { kind: "close_pane", query: null },
    };
  }
  const named = t.match(/^close (?:the |my )?(.+) pane$/);
  if (named?.[1]) {
    return {
      kind: "close",
      high: true,
      outcome: { kind: "completed", summary: `Closed the ${named[1]} pane.` },
      directive: { kind: "close_pane", query: named[1] },
    };
  }
  return null;
}

function browserCommand(original: string, t: string): Parsed | null {
  const directive = (command: Extract<UiDirective, { kind: "control_browser" }>["command"]): Parsed => ({
    kind: "control_browser",
    high: true,
    outcome: { kind: "completed", summary: "Updated the browser." },
    directive: { kind: "control_browser", workspaceId: "", command },
  });
  if (/^open (?:the )?browser(?: pane)?$/.test(t)) {
    return directive({ kind: "open", url: null, newPane: false });
  }
  if (/^(?:open (?:another|new)|new) browser(?: pane)?$/.test(t)) {
    return directive({ kind: "open", url: null, newPane: true });
  }
  if (/^(?:back|go back|browser back|go back in (?:the )?browser)$/.test(t)) {
    return directive({ kind: "back", browserId: null });
  }
  if (/^(?:forward|go forward|browser forward|go forward in (?:the )?browser)$/.test(t)) {
    return directive({ kind: "forward", browserId: null });
  }
  if (/^(?:reload|refresh)(?: (?:the )?(?:page|browser))?$/.test(t)) {
    return directive({ kind: "reload", browserId: null });
  }
  if (/^stop loading(?: (?:the )?(?:page|browser))?$/.test(t)) {
    return directive({ kind: "stop", browserId: null });
  }
  const address = original
    .trim()
    .replace(/^please\s+/i, "")
    .match(/^(?:open|navigate to)\s+(.+)$/i)?.[1]
    ?.trim();
  if (!address || !/^(?:https?:\/\/|localhost(?::|\s|$))/i.test(address)) return null;
  const spokenLocalhost = address.match(/^localhost\s+(\d+)[.!?]?$/i);
  try {
    const url = normalizeBrowserAddress(spokenLocalhost ? `localhost:${spokenLocalhost[1]}` : address);
    return directive({ kind: "navigate", url, browserId: null });
  } catch {
    return null;
  }
}

/** Plural things the Agents tab lists (native `grammar_agents::LISTED`). */
const LISTED = "(?:agents|coding agents|threads|sessions|tasks|work)";
/** Coding agents, for questions about them (native `grammar_agents::AGENT`). */
const AGENT = "(?:agents?|coding agents?)";
const DET = "(?:(?:all|all the|all of the|all my|all of my|every|the|my) )?";
const SHOW = "(?:show|display|list|filter|give)(?: me)?(?: only| just)?";
const MAYBE_PROVIDER = "(?:(claude code|claude|codex|cursor|gemini cli|gemini) )?";
const NEEDS_ME = "(?:me|you|my attention|attention|my input|input|an answer|my answer|a reply|my reply)";

/** Status words of each agent filter, before ("working agents") and after ("agents that are working") the noun. */
const FILTER_WORDS: readonly [Exclude<AgentFilter, "all">, string | null, string][] = [
  [
    "needs_you",
    null,
    `(?:(?:that |which |who )?(?:need|needs|needing) ${NEEDS_ME}|(?:(?:that|which) (?:are|is) )?(?:currently |still )?waiting (?:for|on) ${NEEDS_ME})`,
  ],
  [
    "working",
    "(?:working|running|active|busy)",
    "(?:(?:that are|which are|that is|which is|currently) )?(?:currently |still )?(?:working|running|busy)",
  ],
  [
    "waiting",
    "(?:waiting|blocked)",
    "(?:(?:that are|which are|that is|which is|currently) )?(?:currently |still )?(?:waiting|blocked)",
  ],
  ["idle", "idle", "(?:(?:that are|which are|that is|which is|currently) )?(?:currently |still )?idle"],
  [
    "done",
    "(?:completed|finished|done)",
    "(?:(?:that are|which are|that have|which have|that|which|that is) )?(?:already )?(?:completed|finished|done)",
  ],
  [
    "failed",
    "(?:failed|failing|errored|crashed|broken)",
    "(?:(?:that have|which have|that|which|that are|which are) )?(?:failed|errored|crashed|broken)",
  ],
];

/** A question's predicate per filter ("which agents *are working*"), as native `grammar_agents::asked`. */
const ASKED: readonly [Exclude<AgentFilter, "all">, string][] = [
  [
    "needs_you",
    `(?:(?:need|needs|want|wants) ${NEEDS_ME}|(?:are|is) (?:currently |still )?waiting (?:for|on) ${NEEDS_ME})`,
  ],
  ["working", "(?:are|is) (?:currently |still )?(?:working|running|busy|active)"],
  ["waiting", "(?:are|is) (?:currently |still )?(?:waiting|blocked)"],
  ["idle", "(?:are|is) (?:currently |still )?idle"],
  [
    "done",
    "(?:(?:are|is) (?:already )?(?:done|finished|complete|completed)|(?:have|has) (?:already )?(?:finished|completed)|(?:just )?(?:finished|completed))",
  ],
  ["failed", "(?:(?:have|has) )?(?:failed|crashed|errored)|(?:are|is) (?:failed|broken)"],
];

const PROVIDER_FROM_WORDS: Record<string, string> = {
  claude: "claude-code",
  "claude code": "claude-code",
  codex: "codex",
  cursor: "cursor",
  gemini: "gemini-cli",
  "gemini cli": "gemini-cli",
};

/** Native `agent_filter_summary` without a thread runtime (the double has none to count). */
function filterSummary(filter: AgentFilter, providerId: string | null): string {
  const named = providerId ? `${PROVIDER_NAMES[providerId] ?? providerId} ` : "";
  if (filter === "all") return `Showing every ${named}agent.`;
  if (filter === "needs_you") return `Showing ${named}agents that need you.`;
  return `Showing ${filter} ${named}agents.`;
}

type AgentPhrase =
  | { kind: "filter_agents" | "count_agents" | "which_agents"; filter: AgentFilter; providerId: string | null }
  | { kind: "open_finished_agent" | "close_idle_agents"; providerId: string | null };

/**
 * Coding agents by status, mirroring native `grammar_agents` (crates/kalvoice/src/grammar_agents.rs):
 * the same shared agent filters for every provider, and a provider only when one is named.
 */
function agentPhrase(t: string): AgentPhrase | null {
  const provider = (words: string | undefined) => (words ? (PROVIDER_FROM_WORDS[words] ?? null) : null);
  const finished = t.match(
    new RegExp(
      `^(?:open|focus|focus on|show|show me|go to|take me to|switch to|jump to|bring up|pull up) (?:me )?(?:(?:the|my) )?${MAYBE_PROVIDER}(?:agent|coding agent|one|terminal|session) (?:(?:that|which|who) )?(?:(?:just|recently) )?(?:finished|completed|got done|is done|was done)$`,
    ),
  );
  if (finished) return { kind: "open_finished_agent", providerId: provider(finished[1]) };
  const close = t.match(
    new RegExp(
      `^(?:close|stop|kill|end|terminate|shut down|clear|clean up|tidy up|tidy) ${DET}${MAYBE_PROVIDER}(?:idle ${MAYBE_PROVIDER}(?:agents?|coding agents|sessions)|(?:agents?|coding agents|sessions) (?:that are|which are) idle)$`,
    ),
  );
  if (close) return { kind: "close_idle_agents", providerId: provider(close[1] ?? close[2]) };
  for (const [filter, predicate] of ASKED) {
    const asked = t.match(
      new RegExp(`^(which|what|how many) (?:of )?(?:(?:the|my) )?${MAYBE_PROVIDER}${AGENT} (?:${predicate})$`),
    );
    if (asked) {
      return {
        kind: asked[1] === "how many" ? "count_agents" : "which_agents",
        filter,
        providerId: provider(asked[2]),
      };
    }
  }
  const total = t.match(new RegExp(`^how many ${MAYBE_PROVIDER}${AGENT}(?: (?:are there|do i have|are open))?$`));
  if (total) return { kind: "count_agents", filter: "all", providerId: provider(total[1]) };
  for (const [filter, before, after] of FILTER_WORDS) {
    const verb = `(?:${SHOW}|only (?:show|display|list)(?: me)?)`;
    const match =
      (before ? t.match(new RegExp(`^${verb} ${DET}${MAYBE_PROVIDER}${before} ${MAYBE_PROVIDER}${LISTED}$`)) : null) ??
      t.match(new RegExp(`^${verb} ${DET}${MAYBE_PROVIDER}${LISTED} (?:${after})$`));
    if (match) return { kind: "filter_agents", filter, providerId: provider(match[1] ?? match[2]) };
  }
  const all = t.match(
    new RegExp(
      `^(?:show|display|list)(?: me)? (?:all|every|all the|all of the|all my|all of my) ${MAYBE_PROVIDER}${LISTED}$`,
    ),
  );
  if (all) return { kind: "filter_agents", filter: "all", providerId: provider(all[1]) };
  // "Show Cursor agents": a provider alone, every status ("show agents" stays navigation).
  const named = t.match(
    /^(?:show|display|list)(?: me)? (?:(?:the|my) )?(claude code|claude|codex|cursor|gemini cli|gemini) (?:agents|coding agents)$/,
  );
  if (named) return { kind: "filter_agents", filter: "all", providerId: provider(named[1]) };
  return null;
}

type Attention = "waiting_for_permission" | "waiting_for_you" | "failed" | "stuck";
type Scope = "agents" | "threads";

/** The Agents tab group that shows every agent in a state (native `SessionAttention::agent_filter`). */
const ATTENTION_FILTER: Record<Attention, AgentFilter> = {
  waiting_for_permission: "needs_you",
  waiting_for_you: "needs_you",
  failed: "failed",
  stuck: "waiting",
};

const ATTENTION_PHRASES: readonly [Attention, string, string | null][] = [
  [
    "waiting_for_permission",
    "(?:(?:waiting|asking) (?:for|on) (?:my )?(?:permission|approval)|(?:needs|need|needing|wants|want|requires|require) (?:my )?permission|(?:needs|need|needing) approval)",
    null,
  ],
  [
    "failed",
    "(?:(?:failed|failing|errored|crashed|broke|broken)|(?:failed|errored|crashed)(?: out)?|(?:hit|got|has) an error|with an error)",
    "(?:failed|failing|broken|crashed)",
  ],
  ["stuck", "stuck", "stuck"],
  [
    "waiting_for_you",
    "(?:waiting|waiting on me|waiting (?:for|on) (?:input|my input|an answer|a reply|my answer)|(?:needs|need|needing) (?:me|input|my input|an answer|my attention))",
    null,
  ],
];

/** Words per scope (native `grammar_sessions`): agent words and unnamed phrases mean coding agents. */
const SCOPE_WORDS: Record<Scope, { one: string; which: string; anything: string; noun: string; nouns: string }> = {
  agents: {
    one: "(?:the one|the agent|the coding agent|the terminal|the provider|the pane|whichever one)",
    which: "(?:which|what) (?:one|ones|agents?|coding agents?|providers?|terminals?)",
    anything: "(?:anything|anyone|anybody|any agents?)",
    noun: "(?:one|agent|coding agent|terminal|pane)",
    nouns: "(?:agents|coding agents)",
  },
  threads: {
    one: "(?:the thread|the session|the chat|the chat thread)",
    which: "(?:which|what) (?:threads?|sessions?)",
    anything: "(?:any threads?|any sessions?)",
    noun: "(?:thread|session)",
    nouns: "(?:threads|sessions)",
  },
};

const FOCUS_VERB = "(?:open|show|show me|focus|focus on|go to|take me to|switch to|jump to|bring up|pull up|find)";
const BE = "(?:(?:is|are|has|have|was|were|that is|which is|that are|that|which) )?(?:(?:currently|still) )?";

/**
 * Sessions by state, mirroring native `grammar_sessions::state_rules`: "which agent is stuck",
 * "focus the one that failed" and "what needs permission" read coding agents of every provider;
 * "which thread failed" keeps reading chat threads.
 */
function attentionPhrase(
  t: string,
): { kind: "focus_by_state" | "which_sessions"; state: Attention; scope: Scope } | null {
  const text = t.replace(/\bthat's\b/g, "that is").replace(/ (?:for me|please|right now|now)$/, "");
  for (const scope of ["agents", "threads"] as const) {
    const w = SCOPE_WORDS[scope];
    for (const [state, phrase, adjective] of ATTENTION_PHRASES) {
      const focus =
        new RegExp(`^${FOCUS_VERB} ${w.one} ${BE}${phrase}$`).test(text) ||
        (adjective !== null && new RegExp(`^${FOCUS_VERB} (?:me )?the ${adjective} ${w.noun}$`).test(text));
      if (focus) return { kind: "focus_by_state", state, scope };
      const which =
        new RegExp(`^${w.which} ${BE}${phrase}$`).test(text) ||
        new RegExp(`^(?:is|are|has|have|did) ${w.anything} ${BE}${phrase}$`).test(text) ||
        (scope === "agents" && new RegExp(`^who ${BE}${phrase}$`).test(text)) ||
        (adjective !== null &&
          new RegExp(`^(?:what|which) ${adjective} ${w.nouns}(?: are there| do i have)?$`).test(text));
      if (which) return { kind: "which_sessions", state, scope };
    }
  }
  const unnamed: readonly [Attention, RegExp][] = [
    [
      "waiting_for_permission",
      /^what (?:(?:needs|need|requires|require|wants) permission|(?:is|are) (?:waiting|asking) (?:for|on) permission)$/,
    ],
    ["failed", /^what (?:failed|crashed|broke|errored)$/],
    ["stuck", /^what (?:is|are) stuck$/],
  ];
  for (const [state, pattern] of unnamed) {
    if (pattern.test(text)) return { kind: "which_sessions", state, scope: "agents" };
  }
  return null;
}

const ATTENTION_WORDS: Record<Attention, readonly [string, string]> = {
  waiting_for_permission: ["is waiting for permission", "are waiting for permission"],
  waiting_for_you: ["is waiting for you", "are waiting for you"],
  failed: ["has failed", "have failed"],
  stuck: ["is stuck", "are stuck"],
};

/** Filter phrases without an agent noun, tried after approvals (native `late_filter_rules`). */
const LATE_FILTERS: readonly [AgentFilter, RegExp][] = [
  [
    "needs_you",
    new RegExp(
      `^(?:${SHOW} (?:everything|all|anything|what)(?: that is| that are)? (?:waiting(?: for| on)?(?: me)?|(?:that needs?|needing) ${NEEDS_ME})|only (?:show|display|list)(?: me)? (?:everything|what)(?: that is| that are)? waiting(?: for| on)?(?: me)?)$`,
    ),
  ],
  ["done", new RegExp(`^${SHOW}(?: me)? what (?:is|has) (?:completed|finished|done)$`)],
  [
    "all",
    /^(?:(?:show|display|list)(?: me)? everything on the dashboard|(?:clear|reset|remove)(?: the| my)?(?: dashboard| agent| agents)? filters?)$/,
  ],
];

/** A small subset of the native grammar (crates/kalvoice/src/grammar.rs), enough for UI tests. */
function understand(text: string): Parsed | null {
  const t = normalize(text);
  if (!t) return { kind: "empty", high: false };
  const session = sessionCommand(text, t);
  if (session) return session;
  if (/\b(don't|dont|not|never)\b/.test(t)) return null;
  const browser = browserCommand(text, t);
  if (browser) return browser;
  const pane = paneCommand(t);
  if (pane) return pane;
  if (/\b(and|then)\b/.test(t)) return null;
  const agents = agentPhrase(t.replace(/\bthat's\b/g, "that is").replace(/ (?:right )?now$/, ""));
  if (agents) {
    if (agents.kind === "filter_agents") {
      return {
        kind: "filter_agents",
        high: true,
        outcome: { kind: "completed", summary: filterSummary(agents.filter, agents.providerId) },
        directive: { kind: "filter_agents", filter: agents.filter, providerId: agents.providerId },
      };
    }
    if (agents.kind === "close_idle_agents") {
      return {
        kind: "close_idle_agents",
        high: true,
        outcome: { kind: "completed", summary: "Closing idle agents with KalTidy." },
        directive: { kind: "close_idle_agents", providerId: agents.providerId },
      };
    }
    if (agents.kind === "which_agents") {
      return {
        kind: "which_agents",
        high: true,
        outcome: { kind: "completed", summary: "No agents yet (test double)." },
        directive: { kind: "filter_agents", filter: agents.filter, providerId: agents.providerId },
      };
    }
    if (agents.kind === "count_agents") {
      return { kind: "count_agents", high: true, outcome: { kind: "completed", summary: "No agents are open." } };
    }
    return {
      kind: "open_finished_agent",
      high: true,
      outcome: {
        kind: "failed",
        code: "finished_agent_not_found",
        message: `No ${agents.providerId ? `${PROVIDER_NAMES[agents.providerId] ?? agents.providerId} ` : ""}agent has finished yet.`,
      },
    };
  }
  const attention = attentionPhrase(t);
  if (attention) {
    // The double has no agents or threads: native reads back the matching names.
    const [one, many] = ATTENTION_WORDS[attention.state];
    const noun = attention.scope === "agents" ? "agent" : "thread";
    if (attention.kind === "focus_by_state") {
      return {
        kind: "focus_by_state",
        high: true,
        outcome: { kind: "failed", code: "session_not_found", message: `No ${noun} ${one}.` },
      };
    }
    return {
      kind: "which_sessions",
      high: true,
      outcome: { kind: "completed", summary: `No ${noun}s ${many}.` },
      ...(attention.scope === "agents"
        ? {
            directive: {
              kind: "filter_agents",
              filter: ATTENTION_FILTER[attention.state],
              providerId: null,
            } satisfies UiDirective,
          }
        : {}),
    };
  }
  const navigate = (surface: SurfaceId, high: boolean): Parsed => ({
    kind: "navigate",
    high,
    outcome: { kind: "completed", summary: `Opened ${SURFACE_LABELS[surface]}.` },
    directive: { kind: "navigate", surface },
  });
  const nav = t.match(/^(?:go to|go|open|show me|show|switch to|take me to|navigate to) (?:the )?(\w+)(?: page)?$/);
  const verbSurface = nav?.[1] ? SURFACE_WORDS[nav[1]] : undefined;
  if (verbSurface) return navigate(verbSurface, true);
  const bare = SURFACE_WORDS[t];
  if (bare) return navigate(bare, false);
  if (
    /^(open|start|create|launch|new) (\w+ )?(\w+ )?(codex|codecs|cursor|claude|gemini)( code| cli)? (threads?|sessions?|agents?)$/.test(
      t,
    )
  ) {
    return { kind: "create_threads", high: true, consequential: true };
  }
  // A narrower state ("stop all idle agents") is never "stop everything" (native RUNNING_STATE).
  if (
    /^(pause|stop|halt|kill) (all |every |the )?(active |running |current |open |working |busy )?(threads?|agents?|sessions?|everything)$/.test(
      t,
    ) ||
    /^(resume) (all |every |the )?(paused |stopped |current |open )?(threads?|agents?|sessions?|everything)$/.test(t)
  ) {
    const verb = t.split(" ")[0];
    return {
      kind: verb === "pause" ? "pause_threads" : verb === "resume" ? "resume_threads" : "stop_threads",
      high: true,
      consequential: true,
    };
  }
  if (/^(what are my threads doing|what is running)$/.test(t)) return { kind: "status_report", high: true };
  if (t === "status") return { kind: "status_report", high: false };
  const approvals: Omit<Parsed, "high"> = {
    kind: "show_approvals",
    outcome: { kind: "completed", summary: "Nothing is waiting for your approval." },
    directive: { kind: "show_approvals" },
  };
  if (/^(show approvals|show what is waiting( for me)?|what is waiting( for me)?)$/.test(t)) {
    return { ...approvals, high: true };
  }
  if (/^(pending )?approvals$/.test(t)) return { ...approvals, high: false };
  // "for me" is trailing filler natively; "that's" expands to "that is".
  const filterText = t.replace(/\bthat's\b/g, "that is").replace(/ for me$/, "");
  for (const [filter, pattern] of LATE_FILTERS) {
    if (pattern.test(filterText)) {
      return {
        kind: "filter_agents",
        high: true,
        outcome: { kind: "completed", summary: filterSummary(filter, null) },
        directive: { kind: "filter_agents", filter, providerId: null },
      };
    }
  }
  // Search (Z7-W2): the Session Locator; native reads back names and statuses.
  const when = t.match(
    /^(?:what (?:was|were) (?:i|we) (?:working on|doing)|(?:find|show|show me) what (?:i|we) (?:was|were) (?:working on|doing))(?: (yesterday|today|this week|last week))?$/,
  );
  const searchFor =
    t.match(/^(?:search|look) (?:for|up) (.+)$/) ??
    t.match(/^find (?:me )?(?:the |my )?(?:thread|session|workspace|project) (?:about |for |called |named )?(.+)$/);
  if (when || searchFor) {
    const query = when ? (when[1] ?? "recent") : (searchFor?.[1] ?? "");
    return {
      kind: "search",
      high: true,
      outcome: { kind: "completed", summary: `Showing matches for “${query}”.` },
      directive: { kind: "search", query },
    };
  }
  if (/^(new terminal|open a terminal)$/.test(t)) {
    return {
      kind: "create_terminal",
      high: true,
      outcome: {
        kind: "failed",
        code: "no_workspace",
        message: "Open a workspace first (Code, Open folder), or name one: “in the website workspace”.",
      },
    };
  }
  return null;
}

/** Mirrors `talk_route` in crates/kalvoice/src/orchestrator.rs. */
function route(text: string, target: TalkRequest["target"]): TalkRoute {
  const parsed = understand(text);
  if (parsed !== null && parsed.kind !== "empty" && (parsed.high || target === "none")) return "command";
  if (target !== "none") return "dictation";
  return "request";
}

function defaults(): KalVoicePreferences {
  return {
    talkKey: "F8",
    talkEnabled: true,
    intelligence: null,
    speechModel: "tiny.en",
    voiceReplies: false,
    panelDefault: "top",
    panelVisible: true,
    panelPlacements: [],
    speechModelAutoDownload: true,
    localIntelligenceAuto: true,
    localIntelligencePaused: false,
  };
}

export interface MemoryKalVoice {
  handlers: Record<string, (args: Record<string, unknown>) => unknown>;
  subscribe(onSignal: (signal: KalVoiceSignal) => void): void;
  /** Test hooks: what the fake recognizer hears next. */
  controls: {
    setTranscript(text: string): void;
    /** Explicit cloud test operation; never routed from a local command or production IPC. */
    cloudRequest(requestId: string): KalVoiceResponse;
  };
  /** Wires spoken session names to the transport's `session_resolve`. */
  setSessionResolver(resolver: MemorySessionResolver): void;
  /** KalVoice does not own approval requests; always returns `undefined`. */
  decideApproval(args: Record<string, unknown>): unknown;
}

export function createMemoryKalVoice(emit: Emit, scenario: string, transcriptOverride?: string | null): MemoryKalVoice {
  const slow = scenario === "kalvoice-slow";
  let prefs = defaults();
  const firstRun = scenario === "kalvoice-first-run";
  // No model and the owner opted out (removed it), so nothing provisions itself.
  if (scenario === "kalvoice-no-model") prefs = { ...prefs, speechModelAutoDownload: false };
  const installed = new Set<string>(scenario === "kalvoice-no-model" || firstRun ? [] : ["tiny.en"]);
  const partial = new Map<string, number>();
  // Like native: automatic (zero-setup) downloads report their phase as `provisioning` items.
  const automatic = new Map<string, ComponentProvisioning>();
  const downloading = new Map<string, ReturnType<typeof setInterval>>();
  const handled = new Map<string, string>();
  const cloudRequests = new Set<string>();
  let used = scenario === "kalvoice-limit" ? FREE_KALVOICE_ALLOWANCE : 0;
  let listening: {
    sessionId: string;
    mode: KalVoiceMode;
    started: number;
    timers: ReturnType<typeof setInterval>[];
  } | null = null;
  const latency: StageTimings[] = [];
  // Like native: one channel per window, replaced on every subscribe.
  let subscriber: ((signal: KalVoiceSignal) => void) | null = null;
  let resolveSession: MemorySessionResolver | null = null;
  let transcript =
    transcriptOverride ??
    (typeof location !== "undefined" ? new URLSearchParams(location.search).get("transcript") : null) ??
    "Add a unit test for the parser";

  const signal = (s: KalVoiceSignal) => {
    const target = subscriber;
    if (target) setTimeout(() => target(s), 0);
  };

  const usage = (): KalVoiceUsage => {
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    return { used, allowance: FREE_KALVOICE_ALLOWANCE, periodStart: start.toISOString(), resetsAt: next.toISOString() };
  };

  const models = (): SpeechModelInfo[] =>
    CATALOG.map((m) => ({
      ...m,
      state: installed.has(m.id)
        ? { kind: "installed" }
        : downloading.has(m.id)
          ? { kind: "downloading", receivedBytes: partial.get(m.id) ?? 0 }
          : partial.has(m.id)
            ? { kind: "paused", receivedBytes: partial.get(m.id) ?? 0 }
            : { kind: "not_installed" },
    }));

  const activeModel = () => [prefs.speechModel, ...CATALOG.map((m) => m.id)].find((id) => installed.has(id)) ?? null;

  const talkKeySignal = (): KalVoiceSignal => ({
    kind: "talk_key",
    active: prefs.talkEnabled,
    reason: prefs.talkEnabled ? null : "disabled",
    accelerator: prefs.talkKey,
  });

  const status = (): KalVoiceStatus => ({
    usage: usage(),
    preferences: prefs,
    models: models(),
    activeModel: activeModel(),
    speechEngine: true,
    microphoneSupported: true,
    voiceOutputAvailable: true,
    providers: [],
    reservedShortcuts: RESERVED,
    talkKeys: TALK_KEYS,
    talkKeyActive: prefs.talkEnabled,
    shortcutIssues: [],
    listening: listening ? { sessionId: listening.sessionId, mode: listening.mode } : null,
    provisioning: [...automatic.values()],
  });

  const publishProvisioning = () => signal({ kind: "provisioning", items: [...automatic.values()] });

  /** The default speech model provisions itself: preparing, downloading, verifying, installed. */
  const provisionDefault = () => {
    const model = CATALOG[0];
    if (!model || !prefs.speechModelAutoDownload || activeModel() || automatic.has(model.id)) return;
    const item: ComponentProvisioning = {
      modelId: model.id,
      automatic: true,
      phase: "preparing",
      receivedBytes: 0,
      totalBytes: model.sizeBytes,
    };
    automatic.set(model.id, item);
    publishProvisioning();
    // First run is paced like kalvoice-slow (about 6 s, not 1.35 s): it starts at boot, so a fast
    // pace can finish before a test on a loaded machine has opened Settings to observe it.
    const step = Math.ceil(model.sizeBytes / (slow || firstRun ? 40 : 8));
    const timer = setInterval(() => {
      const current = automatic.get(model.id);
      if (!current) {
        clearInterval(timer);
        return;
      }
      if (current.phase === "verifying") {
        clearInterval(timer);
        automatic.delete(model.id);
        installed.add(model.id);
        publishProvisioning();
        signal({ kind: "model_installed", modelId: model.id });
        return;
      }
      const received = Math.min(model.sizeBytes, current.receivedBytes + step);
      automatic.set(model.id, {
        ...current,
        phase: received >= model.sizeBytes ? "verifying" : "downloading",
        receivedBytes: received,
      });
      publishProvisioning();
    }, 150);
  };

  const begin = (mode: KalVoiceMode): string | null => {
    if (listening) return null;
    const failWith = (code: string, message: string) => {
      signal({ kind: "listening_failed", sessionId: null, mode, code, message });
      return null;
    };
    if (!activeModel()) {
      return failWith("model_not_installed", "Download a speech model in Settings, KalVoice, to use dictation.");
    }
    if (scenario === "kalvoice-mic-denied") {
      return failWith(
        "microphone_denied",
        "Microphone access is blocked. In system privacy settings, allow KalCode to use the microphone, then try again.",
      );
    }
    const sessionId = crypto.randomUUID();
    let t = 0;
    // Simulated input level only — no audio exists in the test double.
    const level = setInterval(() => {
      t += 1;
      signal({ kind: "level", sessionId, level: 0.35 + 0.3 * Math.abs(Math.sin(t / 2.3)) });
    }, 50);
    // FAKE recognizer partials: the transcript revealed word by word.
    const words = transcript.trim().split(/\s+/);
    let shown = 0;
    const partials = setInterval(() => {
      if (shown >= words.length) return;
      shown += 1;
      signal({ kind: "partial", sessionId, text: words.slice(0, shown).join(" ") });
    }, 180);
    listening = { sessionId, mode, started: Date.now(), timers: [level, partials] };
    signal({ kind: "listening_started", sessionId, mode });
    return sessionId;
  };

  const finish = (sessionId: string) => {
    if (!listening || listening.sessionId !== sessionId) return false;
    const { mode, timers, started } = listening;
    for (const timer of timers) clearInterval(timer);
    listening = null;
    signal({ kind: "transcribing", sessionId, mode });
    const finalMs = slow ? 1200 : 120;
    setTimeout(() => {
      const text = transcript.trim();
      const timings: StageTimings = {
        keyDownToMic: 4,
        speechToPartial: 180,
        keyUpToFinal: finalMs,
        finalToRecognized: null,
        recognizedToAction: null,
        finalSource: "reused_partial",
      };
      latency.unshift(timings);
      signal({
        kind: "result",
        result: text
          ? { kind: "transcript", sessionId, mode, text, durationMs: Date.now() - started }
          : { kind: "nothing_heard", sessionId, mode },
        timings,
      });
    }, finalMs);
    return true;
  };

  const cancel = (expectedId?: string) => {
    if (expectedId && listening?.sessionId !== expectedId) return false;
    if (!listening) return false;
    const { sessionId, mode, timers } = listening;
    for (const timer of timers) clearInterval(timer);
    listening = null;
    signal({ kind: "cancelled", sessionId, mode });
    return true;
  };

  // Emulates the native push-to-talk key (the browser has no OS hotkeys): press opens the
  // "microphone", release finishes; losing window focus mid-hold finishes too (missed release).
  let installedKeys = false;
  const installKeys = () => {
    if (installedKeys || typeof window === "undefined") return;
    installedKeys = true;
    window.addEventListener(
      "keydown",
      (event) => {
        if (event.repeat || !prefs.talkEnabled || !isTalkKey(event, prefs.talkKey)) return;
        event.preventDefault();
        if (listening) return;
        if (begin("talk")) signal({ kind: "reveal" });
      },
      true,
    );
    window.addEventListener(
      "keyup",
      (event) => {
        if (listening && isTalkKey(event, prefs.talkKey)) finish(listening.sessionId);
      },
      true,
    );
    window.addEventListener("blur", () => {
      if (listening) finish(listening.sessionId);
    });
  };

  const respond = (
    requestId: string,
    kind: string | null,
    outcome: KalVoiceOutcome,
    wasCounted: boolean,
    directive: UiDirective | null = null,
  ): KalVoiceResponse => ({ requestId, intent: kind, outcome, usage: usage(), counted: wasCounted, directive });

  // Like native: local commands retain execution fences without consuming cloud quota.
  const meterUiCommand = (request: UiCommandRequest): KalVoiceResponse => {
    const { requestId } = request;
    const kind = `ui_${request.command}`;
    if (handled.has(requestId)) return respond(requestId, kind, { kind: "completed", summary: "" }, false);
    handled.set(requestId, kind);
    emit({ type: "kalvoice.command_executed", payload: { requestId, intent: kind } }, { correlation: { requestId } });
    return respond(requestId, kind, { kind: "completed", summary: "" }, false);
  };

  const handleRequest = async (
    request: CommandRequest,
    target: TalkRequest["target"] = "none",
  ): Promise<KalVoiceResponse> => {
    const { requestId } = request;
    if (handled.has(requestId)) {
      return respond(
        requestId,
        null,
        { kind: "failed", code: "duplicate_request", message: "KalVoice already handled this request." },
        false,
      );
    }
    emit(
      { type: "kalvoice.request_started", payload: { requestId, input: request.input } },
      { correlation: { requestId } },
    );
    signal({ kind: "request_stage", requestId, stage: "thinking" });
    await wait(slow ? 1500 : 60);
    const parsed = understand(request.text);
    const failed = (code: string, message: string, kind: string | null = null) => {
      emit({ type: "kalvoice.request_failed", payload: { requestId, code } }, { correlation: { requestId } });
      return respond(requestId, kind, { kind: "failed", code, message }, false);
    };
    if (parsed?.kind === "empty") return failed("empty_request", "Say or type what you want KalVoice to do.");
    if (!parsed) {
      return failed(
        "local_reasoning_unavailable",
        "On-device KalVoice interpretation isn't available in this build.",
        "reasoning",
      );
    }
    emit(
      { type: "kalvoice.command_recognized", payload: { requestId, intent: parsed.kind } },
      { correlation: { requestId } },
    );
    if (parsed.consequential) {
      parsed.outcome = { kind: "completed", summary: DONE_SUMMARY[parsed.kind] ?? "Done." };
    }
    if (parsed.kind === "status_report") {
      parsed.outcome = { kind: "completed", summary: "No threads are open." };
    }
    if (parsed.directive?.kind === "control_browser") {
      if (!request.workspaceId) {
        return failed("no_workspace", "Open a workspace before controlling the browser.", parsed.kind);
      }
      parsed.directive = { ...parsed.directive, workspaceId: request.workspaceId };
    }
    if (parsed.kind === "submit_focused" || parsed.kind === "clear_focused") {
      // Like native: a raw terminal is never submitted or edited by voice.
      if (target === "terminal") {
        const submit = parsed.kind === "submit_focused";
        return failed(
          submit ? "terminal_submit_refused" : "terminal_clear_refused",
          submit
            ? "KalVoice never presses Enter in a terminal. Press Enter yourself to run it."
            : "KalVoice doesn't edit a terminal's line. Nothing was changed.",
          parsed.kind,
        );
      }
      if (!request.threadId) {
        return failed("no_focused_composer", "Click in a thread's message box first, then try again.", parsed.kind);
      }
      const submit = parsed.kind === "submit_focused";
      parsed.outcome = { kind: "completed", summary: submit ? "Sending that." : "Clearing that." };
      parsed.directive = submit
        ? { kind: "submit_composer", threadId: request.threadId }
        : { kind: "clear_composer", threadId: request.threadId };
    }
    if (parsed.direct) {
      const resolution: SessionResolution = resolveSession
        ? await resolveSession(parsed.direct.query, {
            workspaceId: request.workspaceId,
            focusedThreadId: request.threadId ?? null,
          })
        : { kind: "not_found", message: "KalCode couldn't find an open session with that name." };
      if (resolution.kind === "not_found") return failed("session_not_found", resolution.message, parsed.kind);
      const followUp = { kind: "compose" as const, text: parsed.direct.prompt, submit: true };
      if (resolution.kind === "ambiguous") {
        parsed.outcome = { kind: "completed", summary: resolution.question };
        parsed.directive = {
          kind: "choose_session",
          question: resolution.question,
          choices: resolution.choices,
          followUp,
        };
      } else {
        parsed.outcome = { kind: "completed", summary: `Sending to “${resolution.target.name}”.` };
        parsed.directive = {
          kind: "compose_in_thread",
          threadId: resolution.target.threadId,
          text: followUp.text,
          submit: followUp.submit,
        };
      }
    }
    if (parsed.outcome?.kind === "failed") return failed(parsed.outcome.code, parsed.outcome.message, parsed.kind);
    handled.set(requestId, parsed.kind);
    signal({ kind: "request_stage", requestId, stage: "executing" });
    await wait(slow ? 1500 : 30);
    emit(
      { type: "kalvoice.command_executed", payload: { requestId, intent: parsed.kind } },
      { correlation: { requestId } },
    );
    emit({ type: "kalvoice.request_completed", payload: { requestId } }, { correlation: { requestId } });
    return respond(
      requestId,
      parsed.kind,
      parsed.outcome ?? { kind: "completed", summary: "Done." },
      false,
      parsed.directive ?? null,
    );
  };

  const talk = async (request: TalkRequest): Promise<TalkResponse> => {
    const started = performance.now();
    const which = route(request.text, request.target);
    const recognizedMs = performance.now() - started;
    const latest = latency[0];
    if (latest && latest.finalToRecognized === null) latest.finalToRecognized = recognizedMs;
    emit(
      { type: "kalvoice.talk_routed", payload: { requestId: request.requestId, outcome: which } },
      { correlation: { requestId: request.requestId } },
    );
    if (which === "dictation") {
      emit({
        type: "kalvoice.dictation_completed",
        payload: { sessionId: request.sessionId, durationMs: request.durationMs, characters: request.text.length },
      });
      return { route: which, response: null, recognizedMs };
    }
    const response = await handleRequest(
      {
        requestId: request.requestId,
        text: request.text,
        input: "voice",
        workspaceId: request.workspaceId,
        threadId: request.threadId ?? null,
      },
      request.target,
    );
    return { route: which, response, recognizedMs };
  };

  const updatePreferences = (patch: KalVoicePreferencesPatch): KalVoiceStatus => {
    const allowed = new Set([
      "talkKey",
      "talkEnabled",
      "intelligence",
      "speechModel",
      "voiceReplies",
      "panelDefault",
      "panelVisible",
      "panelPlacement",
      "speechModelAutoDownload",
      "localIntelligenceAuto",
      "localIntelligencePaused",
    ]);
    if (Object.keys(patch).some((k) => !allowed.has(k))) {
      fail("ipc_rejected", "KalCode couldn't complete that request.", "internal");
    }
    if (Object.keys(patch).length === 0) {
      fail("empty_preferences_patch", "No KalVoice preferences were provided to update.");
    }
    const next: KalVoicePreferences = { ...prefs, panelPlacements: [...prefs.panelPlacements] };
    if (patch.talkKey !== undefined) {
      if (!TALK_KEYS.includes(patch.talkKey)) {
        fail("talk_key_invalid", "Choose a function key (F1–F24), Pause, Scroll Lock or Insert.");
      }
      const reserved = checkReserved(patch.talkKey, RESERVED);
      if (!reserved.ok) fail(reserved.code, reserved.message);
      if (patch.talkKey === TAKEN_BY_ANOTHER_APP) {
        fail("talk_key_in_use", "F9 is already used by another app. Choose a different key.");
      }
      next.talkKey = patch.talkKey;
    }
    if (patch.talkEnabled !== undefined) next.talkEnabled = patch.talkEnabled;
    if (patch.intelligence) {
      next.intelligence =
        patch.intelligence.kind === "automatic"
          ? null
          : patch.intelligence.kind === "local"
            ? { kind: "local" }
            : { kind: "provider", providerId: patch.intelligence.providerId };
    }
    if (patch.speechModel !== undefined) {
      if (!CATALOG.some((m) => m.id === patch.speechModel)) {
        fail("unknown_speech_model", "That speech model isn't in KalVoice's catalog.");
      }
      next.speechModel = patch.speechModel;
    }
    if (patch.voiceReplies !== undefined) next.voiceReplies = patch.voiceReplies;
    if (patch.panelDefault !== undefined) {
      next.panelDefault = patch.panelDefault;
      next.panelPlacements = [];
    }
    if (patch.panelVisible !== undefined) next.panelVisible = patch.panelVisible;
    if (patch.speechModelAutoDownload !== undefined) next.speechModelAutoDownload = patch.speechModelAutoDownload;
    if (patch.localIntelligenceAuto !== undefined) next.localIntelligenceAuto = patch.localIntelligenceAuto;
    if (patch.localIntelligencePaused !== undefined) next.localIntelligencePaused = patch.localIntelligencePaused;
    if (patch.panelPlacement) {
      const p: PanelPlacement = patch.panelPlacement;
      if (p.x > 1000 || p.y > 1000) fail("invalid_panel_position", "The KalVoice panel position is out of range.");
      next.panelPlacements = [...next.panelPlacements.filter((q) => q.sizeClass !== p.sizeClass), p];
    }
    const keys = (Object.keys(next) as (keyof KalVoicePreferences)[])
      .filter((k) => JSON.stringify(next[k]) !== JSON.stringify(prefs[k]))
      .map((k) => `kalvoice.${k}`);
    const keyChanged = next.talkKey !== prefs.talkKey || next.talkEnabled !== prefs.talkEnabled;
    prefs = next;
    if (keys.length) emit({ type: "settings.changed", payload: { keys } });
    // Like native: every talk-key registration change is reported.
    if (keyChanged) signal(talkKeySignal());
    return status();
  };

  const download = (modelId: string) => {
    const model = CATALOG.find((m) => m.id === modelId);
    if (!model) fail("unknown_speech_model", "That speech model isn't in KalVoice's catalog.");
    if (downloading.has(modelId)) fail("download_in_progress", "A download for this model is already running.");
    let received = partial.get(modelId) ?? 0;
    const step = Math.ceil(model.sizeBytes / (slow ? 40 : 8));
    const timer = setInterval(() => {
      received = Math.min(model.sizeBytes, received + step);
      partial.set(modelId, received);
      signal({ kind: "model_progress", modelId, receivedBytes: received, totalBytes: model.sizeBytes });
      if (received >= model.sizeBytes) {
        clearInterval(timer);
        downloading.delete(modelId);
        partial.delete(modelId);
        installed.add(modelId);
        signal({ kind: "model_installed", modelId });
      }
    }, 120);
    downloading.set(modelId, timer);
  };

  const STAGE_KEYS = {
    key_down_to_mic: "keyDownToMic",
    speech_to_partial: "speechToPartial",
    key_up_to_final: "keyUpToFinal",
    final_to_recognized: "finalToRecognized",
    recognized_to_action: "recognizedToAction",
  } as const;

  const handlers: MemoryKalVoice["handlers"] = {
    kalvoice_subscribe: () => fail("use_subscribe", "Use subscribeKalVoice().", "internal"),
    kalvoice_status: () => status(),
    kalvoice_request: (args) => handleRequest(args.request as CommandRequest),
    kalvoice_meter_ui_command: (args) => meterUiCommand(args.request as UiCommandRequest),
    kalvoice_talk: (args) => talk(args.request as TalkRequest),
    kalvoice_type_instead: (args) => {
      const id = String(args.requestId);
      if (handled.get(id) !== "navigate") return false;
      handled.set(id, "typed_instead");
      emit({ type: "kalvoice.request_failed", payload: { requestId: id, code: "typed_instead" } });
      return true;
    },
    kalvoice_latency: () => ({
      stages: (Object.keys(STAGE_KEYS) as (keyof typeof STAGE_KEYS)[]).map((stage) => {
        const values = latency
          .map((t) => t[STAGE_KEYS[stage]])
          .filter((v): v is number => typeof v === "number")
          .sort((a, b) => a - b);
        const pick = (p: number) =>
          values.length ? (values[Math.max(0, Math.ceil((p / 100) * values.length) - 1)] ?? null) : null;
        return { stage, count: values.length, p50: pick(50), p95: pick(95), p99: pick(99) };
      }),
      recent: latency.slice(0, 20),
    }),
    kalvoice_latency_record: (args) => {
      const latest = latency[0];
      if (latest && latest.recognizedToAction === null) latest.recognizedToAction = Number(args.actionMs);
    },
    kalvoice_preferences_update: (args) => updatePreferences(args.patch as KalVoicePreferencesPatch),
    kalvoice_listen_start: () => {
      const id = begin("talk");
      if (!id) fail("listening_failed", "KalVoice couldn't start listening.");
      return id;
    },
    kalvoice_listen_stop: (args) => {
      if (!finish(String(args.sessionId))) fail("not_listening", "KalVoice isn't listening.");
    },
    kalvoice_listen_cancel: (args) => cancel(typeof args.sessionId === "string" ? args.sessionId : undefined),
    kalvoice_model_download: (args) => {
      if (args.consent !== true) fail("consent_required", "Downloading a speech model needs your permission first.");
      download(String(args.modelId));
    },
    kalvoice_model_cancel: (args) => {
      const id = String(args.modelId);
      // Like native: a speech model the owner stopped is not fetched again on its own.
      if (CATALOG.some((m) => m.id === id)) prefs = { ...prefs, speechModelAutoDownload: false };
      if (automatic.delete(id)) {
        publishProvisioning();
        return true;
      }
      const timer = downloading.get(id);
      if (!timer) return false;
      clearInterval(timer);
      downloading.delete(id);
      signal({
        kind: "model_failed",
        modelId: id,
        code: "download_cancelled",
        message: "The download was cancelled. It can resume where it stopped.",
      });
      return true;
    },
    kalvoice_model_delete: (args) => {
      const id = String(args.modelId);
      installed.delete(id);
      partial.delete(id);
      // Like native: a removed model is an opt-out from automatic provisioning.
      prefs = { ...prefs, speechModelAutoDownload: false };
      return models();
    },
    // Native opens only the OS microphone privacy page; the test double has no OS to open.
    kalvoice_open_microphone_settings: () => undefined,
  };

  const decideApproval = (_args: Record<string, unknown>): undefined => undefined;

  return {
    handlers,
    decideApproval,
    controls: {
      cloudRequest(requestId) {
        if (cloudRequests.has(requestId))
          return respond(
            requestId,
            "cloud_test",
            { kind: "completed", summary: "Cloud test request completed." },
            false,
          );
        if (used >= FREE_KALVOICE_ALLOWANCE)
          return respond(requestId, "cloud_test", { kind: "limit_reached", resetsAt: usage().resetsAt }, false);
        cloudRequests.add(requestId);
        used += 1;
        return respond(requestId, "cloud_test", { kind: "completed", summary: "Cloud test request completed." }, true);
      },
      setTranscript(text: string) {
        transcript = text;
      },
    },
    setSessionResolver(resolver) {
      resolveSession = resolver;
    },
    subscribe(onSignal) {
      subscriber = onSignal;
      installKeys();
      // Like native: each subscribe is answered with the key's current registration.
      signal(talkKeySignal());
      // Like native: once the runtime is up, a missing default speech model provisions itself.
      if (firstRun) provisionDefault();
    },
  };
}
