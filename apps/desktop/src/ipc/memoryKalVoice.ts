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
 * model installed), kalvoice-mic-denied (microphone blocked), kalvoice-approvals (a legacy URL
 * alias retained for app-control coverage), kalvoice-slow (stages last long enough to observe).
 * App-control commands run immediately; provider sessions keep their own native permission
 * prompts. Thread commands report fixed test-double results.
 * `?transcript=` sets what the fake recognizer "hears".
 */
import type {
  CommandRequest,
  DashboardChip,
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
  SpeechModelInfo,
  StageTimings,
  SurfaceId,
  TalkRequest,
  TalkResponse,
  TalkRoute,
  UiDirective,
} from "@kalcode/protocol";
import { checkReserved, isTalkKey } from "../kalvoice/shortcutModel.ts";
import { normalizeBrowserAddress } from "../surfaces/browser/browserModel.ts";

const FREE_KALVOICE_ALLOWANCE = 75;

export const KALVOICE_SCENARIOS = [
  "kalvoice-limit",
  "kalvoice-no-model",
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

const SOURCE = "Hugging Face, ggerganov/whisper.cpp (official whisper.cpp models)";
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
  dashboard: "the Dashboard",
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
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^\p{L}\p{N}' ]+/gu, " ")
    .replace(/\bwhat's\b/g, "what is")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(please |hey kalvoice )+/, "");
}

const PROVIDER_IDS: Record<string, string> = {
  claude: "claude-code",
  "claude code": "claude-code",
  codex: "codex",
  gemini: "gemini-cli",
  "gemini cli": "gemini-cli",
};
const PROVIDER_NAMES: Record<string, string> = { "claude-code": "Claude", codex: "Codex", "gemini-cli": "Gemini" };
const PROVIDER = "(claude code|claude|codex|gemini cli|gemini)";
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
      outcome: { kind: "completed", summary: "Closed the pane. What it runs keeps running." },
      directive: { kind: "close_pane", query: null },
    };
  }
  const named = t.match(/^close (?:the |my )?(.+) pane$/);
  if (named?.[1]) {
    return {
      kind: "close",
      high: true,
      outcome: { kind: "completed", summary: `Closed the ${named[1]} pane. What it runs keeps running.` },
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

const AGENTS = "(?:agents?|threads?|work|tasks|sessions)";
const SHOW = "(?:show|display|list|filter|give)(?: me)?(?: only| just)?";

/** Dashboard filter phrases (Z7-W3), mirroring `dashboard_filter_patterns` in the native grammar. */
const DASHBOARD_FILTERS: readonly [DashboardChip, RegExp][] = [
  [
    "working",
    new RegExp(
      `^(?:${SHOW}(?: the| my)? (?:working|running|active|busy) ${AGENTS}|${SHOW}(?: the| my)? ${AGENTS} (?:that are|which are|currently) (?:working|running|busy)|only (?:show|display|list)(?: me)?(?: the| my)? (?:working|running|active|busy) ${AGENTS}|(?:which|what) ${AGENTS} (?:are|is) (?:working|running|busy))$`,
    ),
  ],
  [
    "waiting_for_you",
    new RegExp(
      `^(?:${SHOW} (?:everything|all|anything|what)(?: that is| that are)? (?:waiting(?: for| on)?(?: me)?|(?:that needs?|needing) me)|${SHOW}(?: the| my)? ${AGENTS} (?:(?:that are |which are )?waiting(?: for| on)?(?: me)?|(?:that needs?|which needs?|needing) me)|${SHOW}(?: the| my)? ${AGENTS}(?: that| which)? needs?(?: my)? attention)$`,
    ),
  ],
  [
    "done",
    new RegExp(
      `^(?:${SHOW}(?: the| my| all)?(?: the)? (?:completed|finished|done) ${AGENTS}|${SHOW}(?: the| my)? ${AGENTS} (?:that are|which are|that have|which have|that|which) (?:completed|finished|done)|only (?:show|display|list)(?: me)?(?: the| my)? (?:completed|finished|done) ${AGENTS})$`,
    ),
  ],
  [
    "idle",
    new RegExp(
      `^(?:${SHOW}(?: the| my| all)?(?: the)? idle ${AGENTS}|${SHOW}(?: the| my)? ${AGENTS} (?:that are|which are) idle)$`,
    ),
  ],
  [
    "all",
    new RegExp(
      `^(?:(?:show|display|list)(?: me)? (?:all|every|all the|all of the|all my|all of my) ${AGENTS}|(?:clear|reset|remove)(?: the| my)?(?: dashboard)? filters?)$`,
    ),
  ],
];

/** Neutral summaries, as native says them when it can't count (the double has no thread runtime). */
const FILTER_SUMMARY: Record<DashboardChip, string> = {
  all: "Showing every agent on the Dashboard.",
  working: "Showing working agents on the Dashboard.",
  waiting_for_you: "Showing what's waiting for you on the Dashboard.",
  done: "Showing completed work on the Dashboard.",
  idle: "Showing idle agents on the Dashboard.",
};

/** A small subset of the native grammar (crates/kalvoice/src/grammar.rs), enough for UI tests. */
function understand(text: string): Parsed | null {
  const t = normalize(text);
  if (!t) return { kind: "empty", high: false };
  if (/\b(don't|dont|not|never)\b/.test(t)) return null;
  const browser = browserCommand(text, t);
  if (browser) return browser;
  const pane = paneCommand(t);
  if (pane) return pane;
  if (/\b(and|then)\b/.test(t)) return null;
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
    /^(open|start|create|launch|new) (\w+ )?(\w+ )?(codex|codecs|claude|gemini)( code| cli)? (threads?|sessions?|agents?)$/.test(
      t,
    )
  ) {
    return { kind: "create_threads", high: true, consequential: true };
  }
  if (
    /^(pause|resume|stop|halt|kill) (all |every |the )?(active |running |paused )?(threads?|agents?|sessions?|everything)$/.test(
      t,
    )
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
  if (/^(show approvals|what needs permission|show what is waiting( for me)?|what is waiting( for me)?)$/.test(t)) {
    return { ...approvals, high: true };
  }
  if (/^(pending )?approvals$/.test(t)) return { ...approvals, high: false };
  // "for me" is trailing filler natively; "that's" expands to "that is".
  const filterText = t.replace(/\bthat's\b/g, "that is").replace(/ for me$/, "");
  for (const [chip, pattern] of DASHBOARD_FILTERS) {
    if (pattern.test(filterText)) {
      return {
        kind: "filter_dashboard",
        high: true,
        outcome: { kind: "completed", summary: FILTER_SUMMARY[chip] },
        directive: { kind: "filter_dashboard", chip },
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
  };
}

export interface MemoryKalVoice {
  handlers: Record<string, (args: Record<string, unknown>) => unknown>;
  subscribe(onSignal: (signal: KalVoiceSignal) => void): void;
  /** KalVoice does not own approval requests; always returns `undefined`. */
  decideApproval(args: Record<string, unknown>): unknown;
}

export function createMemoryKalVoice(emit: Emit, scenario: string, transcriptOverride?: string | null): MemoryKalVoice {
  const slow = scenario === "kalvoice-slow";
  let prefs = defaults();
  const installed = new Set<string>(scenario === "kalvoice-no-model" ? [] : ["tiny.en"]);
  const partial = new Map<string, number>();
  const downloading = new Map<string, ReturnType<typeof setInterval>>();
  const counted = new Map<string, string>();
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
  const transcript =
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
  });

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

  const cancel = () => {
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

  const handleRequest = async (request: CommandRequest): Promise<KalVoiceResponse> => {
    const { requestId } = request;
    if (counted.has(requestId)) {
      return respond(
        requestId,
        null,
        { kind: "failed", code: "duplicate_request", message: "KalVoice already handled this request." },
        false,
      );
    }
    const allowance = FREE_KALVOICE_ALLOWANCE;
    if (used >= allowance) {
      emit({ type: "kalvoice.limit_reached", payload: { allowance, resetsAt: usage().resetsAt } });
      return respond(requestId, null, { kind: "limit_reached", resetsAt: usage().resetsAt }, false);
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
    if (parsed.outcome?.kind === "failed") return failed(parsed.outcome.code, parsed.outcome.message, parsed.kind);
    used += 1;
    counted.set(requestId, parsed.kind);
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
      true,
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
    const response = await handleRequest({
      requestId: request.requestId,
      text: request.text,
      input: "voice",
      workspaceId: request.workspaceId,
    });
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
    kalvoice_talk: (args) => talk(args.request as TalkRequest),
    kalvoice_type_instead: (args) => {
      const id = String(args.requestId);
      if (counted.get(id) !== "navigate") return false;
      counted.delete(id);
      used = Math.max(0, used - 1);
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
    kalvoice_listen_cancel: () => cancel(),
    kalvoice_model_download: (args) => {
      if (args.consent !== true) fail("consent_required", "Downloading a speech model needs your permission first.");
      download(String(args.modelId));
    },
    kalvoice_model_cancel: (args) => {
      const id = String(args.modelId);
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
      return models();
    },
  };

  const decideApproval = (_args: Record<string, unknown>): undefined => undefined;

  return {
    handlers,
    decideApproval,
    subscribe(onSignal) {
      subscriber = onSignal;
      installKeys();
      // Like native: each subscribe is answered with the key's current registration.
      signal(talkKeySignal());
    },
  };
}
