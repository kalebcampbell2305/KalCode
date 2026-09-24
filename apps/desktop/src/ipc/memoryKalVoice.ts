/**
 * TEST DOUBLE — KalVoice for the in-memory transport (unit tests and the `ui-test` Playwright
 * build only; never bundled into development or production builds).
 *
 * It stands in for the native KalVoice runtime: the global shortcuts (emulated with key events
 * on the page, since the browser has no OS-level shortcuts), microphone level, a FAKE speech
 * recognizer that returns a fixed transcript instead of listening, a small subset of the command
 * grammar, the usage ledger and model downloads. Messages mirror the native ones so UI tests
 * exercise the real UI flows. Nothing here records or recognizes audio.
 *
 * Scenarios (`?scenario=`): kalvoice-limit (allowance used up), kalvoice-no-model (no speech
 * model installed), kalvoice-mic-denied (microphone blocked), kalvoice-approvals (thread
 * commands wait for approval), kalvoice-slow (stages last long enough to observe).
 * `?transcript=` sets what the fake recognizer "hears".
 */
import type {
  CommandRequest,
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
  SurfaceId,
  UiDirective,
} from "@kalcode/protocol";
import { canonicalize, shortcutFromEvent, validateShortcut } from "../kalvoice/shortcutModel.ts";

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
  ["CommandOrControl+K", "KalCode command palette"],
  ["CommandOrControl+B", "KalCode sidebar"],
  ["CommandOrControl+A", "Select all"],
  ["CommandOrControl+C", "Copy / interrupt in terminals"],
  ["CommandOrControl+V", "Paste"],
  ["CommandOrControl+X", "Cut"],
  ["CommandOrControl+Z", "Undo"],
  ["CommandOrControl+Y", "Redo"],
  ["CommandOrControl+Shift+Z", "Redo"],
  ["CommandOrControl+S", "Save"],
  ["CommandOrControl+F", "Find"],
  ["CommandOrControl+W", "Close"],
  ["CommandOrControl+Q", "Quit"],
  ["CommandOrControl+T", "New tab"],
  ["CommandOrControl+N", "New window"],
  ["CommandOrControl+P", "Print / quick open"],
  ["CommandOrControl+R", "Reload"],
  ["CommandOrControl+Shift+C", "Terminal copy"],
  ["CommandOrControl+Shift+V", "Terminal paste"],
  ["CommandOrControl+Shift+P", "Editor command palette"],
  ["CommandOrControl+Space", "Input source / Spotlight"],
  ["Alt+Space", "Window menu"],
  ["Alt+F4", "Close window"],
].map(([accelerator, owner]) => ({ accelerator: accelerator as string, owner: owner as string }));

/** Pretends another app already owns this combination (to exercise the OS refusal path). */
const TAKEN_BY_ANOTHER_APP = "CommandOrControl+Alt+O";

const CATALOG: Omit<SpeechModelInfo, "state">[] = [
  {
    id: "base.en",
    displayName: "English (compact)",
    summary: "Fast and accurate for English. Recommended.",
    sizeBytes: 147_964_211,
    englishOnly: true,
    source: "Hugging Face, ggerganov/whisper.cpp (official whisper.cpp models)",
  },
  {
    id: "small.en",
    displayName: "English (more accurate)",
    summary: "Better with accents and technical words; slower on older computers.",
    sizeBytes: 487_614_201,
    englishOnly: true,
    source: "Hugging Face, ggerganov/whisper.cpp (official whisper.cpp models)",
  },
  {
    id: "base",
    displayName: "Multilingual (compact)",
    summary: "Detects and transcribes about 100 languages.",
    sizeBytes: 147_951_465,
    englishOnly: false,
    source: "Hugging Face, ggerganov/whisper.cpp (official whisper.cpp models)",
  },
  {
    id: "small",
    displayName: "Multilingual (more accurate)",
    summary: "About 100 languages with higher accuracy; slower on older computers.",
    sizeBytes: 487_601_967,
    englishOnly: false,
    source: "Hugging Face, ggerganov/whisper.cpp (official whisper.cpp models)",
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
};

function fail(code: string, message: string, category: IpcError["category"] = "validation"): never {
  throw { category, code, message, retryable: false } satisfies IpcError;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Parsed {
  kind: string;
  outcome?: KalVoiceOutcome;
  directive?: UiDirective;
  consequential?: boolean;
}

/** A tiny subset of the native grammar (crates/kalvoice/src/grammar.rs), enough for UI tests. */
function understand(text: string): Parsed | null {
  const t = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}' ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(please |hey kalvoice )+/, "");
  if (!t) return { kind: "empty" };
  if (/\b(don't|dont|not|never|and|then)\b/.test(t)) return null;
  const nav = t.match(/^(?:go to|go|open|show me|show|switch to|take me to|navigate to) (?:the )?(\w+)(?: page)?$/);
  const surface = nav?.[1] ? SURFACE_WORDS[nav[1]] : undefined;
  if (surface) {
    return {
      kind: "navigate",
      outcome: { kind: "completed", summary: `Opened ${SURFACE_LABELS[surface]}.` },
      directive: { kind: "navigate", surface },
    };
  }
  if (
    /^(open|start|create|launch|new) (\w+ )?(\w+ )?(codex|claude|gemini)( code| cli)? (threads?|sessions?|agents?)$/.test(
      t,
    )
  ) {
    return { kind: "create_threads", consequential: true };
  }
  if (
    /^(pause|resume|stop|halt|kill) (all |every |the )?(active |running |paused )?(threads?|agents?|sessions?|everything)$/.test(
      t,
    )
  ) {
    return {
      kind: t.split(" ")[0] === "pause" ? "pause_threads" : t.startsWith("resume") ? "resume_threads" : "stop_threads",
      consequential: true,
    };
  }
  if (/^(what are my threads doing|status|what is running)$/.test(t)) return { kind: "status_report" };
  if (/^(show approvals|what needs permission|approvals)$/.test(t)) {
    return {
      kind: "show_approvals",
      outcome: {
        kind: "failed",
        code: "approvals_unavailable",
        message: "Approvals aren't available in this build yet, so there's nothing KalVoice can show.",
      },
    };
  }
  if (/^(new terminal|open a terminal)$/.test(t)) {
    return {
      kind: "create_terminal",
      outcome: {
        kind: "failed",
        code: "workspaces_unavailable",
        message: "Workspaces and terminals aren't available in this build yet, so KalVoice can't open them.",
      },
    };
  }
  return null;
}

function defaults(): KalVoicePreferences {
  return {
    dictationShortcut: "CommandOrControl+Shift+Space",
    commandShortcut: "CommandOrControl+Shift+K",
    intelligence: null,
    speechModel: "base.en",
    voiceReplies: false,
    panelDefault: "bottom_right",
    panelVisible: true,
    panelPlacements: [],
  };
}

export interface MemoryKalVoice {
  handlers: Record<string, (args: Record<string, unknown>) => unknown>;
  subscribe(onSignal: (signal: KalVoiceSignal) => void): void;
}

export function createMemoryKalVoice(emit: Emit, scenario: string, transcriptOverride?: string | null): MemoryKalVoice {
  const slow = scenario === "kalvoice-slow";
  let prefs = defaults();
  const installed = new Set<string>(scenario === "kalvoice-no-model" ? [] : ["base.en"]);
  const partial = new Map<string, number>();
  const downloading = new Map<string, ReturnType<typeof setInterval>>();
  const counted = new Set<string>();
  let used = scenario === "kalvoice-limit" ? 250 : 0;
  let listening: { sessionId: string; mode: KalVoiceMode; levelTimer: ReturnType<typeof setInterval> } | null = null;
  let commandPressedAt = 0;
  const pending = new Map<string, { requestId: string; kind: string }>();
  const subscribers = new Set<(signal: KalVoiceSignal) => void>();
  const transcript =
    transcriptOverride ??
    (typeof location !== "undefined" ? new URLSearchParams(location.search).get("transcript") : null) ??
    "Add a unit test for the parser";

  const signal = (s: KalVoiceSignal) => {
    for (const subscriber of subscribers) setTimeout(() => subscriber(s), 0);
  };

  const usage = (): KalVoiceUsage => {
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    return { used, allowance: 250, periodStart: start.toISOString(), resetsAt: next.toISOString() };
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
    shortcutIssues: [],
    listening: listening ? { sessionId: listening.sessionId, mode: listening.mode } : null,
  });

  const begin = (mode: KalVoiceMode, quiet: boolean): string | null => {
    if (listening) return null;
    const failWith = (code: string, message: string) => {
      if (mode === "dictation")
        emit({ type: "kalvoice.dictation_failed", payload: { sessionId: crypto.randomUUID(), code } });
      if (!quiet) signal({ kind: "listening_failed", sessionId: null, mode, code, message });
      return null;
    };
    if (!activeModel()) {
      return failWith("model_not_installed", "Download a speech model in Settings, KalVoice, to use dictation.");
    }
    if (scenario === "kalvoice-mic-denied") {
      return failWith(
        "microphone_denied",
        "Microphone access is blocked. Allow desktop apps to use the microphone in your system's privacy settings, then try again.",
      );
    }
    const sessionId = crypto.randomUUID();
    let t = 0;
    const levelTimer = setInterval(() => {
      t += 1;
      // Simulated input level only — no audio exists in the test double.
      signal({ kind: "level", sessionId, level: 0.35 + 0.3 * Math.abs(Math.sin(t / 2.3)) });
    }, 50);
    listening = { sessionId, mode, levelTimer };
    signal({ kind: "listening_started", sessionId, mode });
    if (mode === "dictation") emit({ type: "kalvoice.dictation_started", payload: { sessionId } });
    return sessionId;
  };

  const finish = (sessionId: string) => {
    if (!listening || listening.sessionId !== sessionId) return false;
    const { mode, levelTimer } = listening;
    clearInterval(levelTimer);
    listening = null;
    signal({ kind: "transcribing", sessionId, mode });
    setTimeout(
      () => {
        // FAKE recognizer: returns the configured transcript.
        const text = transcript.trim();
        if (mode === "dictation") {
          emit({
            type: "kalvoice.dictation_completed",
            payload: { sessionId, durationMs: 900, characters: text.length },
          });
        }
        signal({
          kind: "result",
          result: text ? { kind: "transcript", sessionId, mode, text } : { kind: "nothing_heard", sessionId, mode },
        });
      },
      slow ? 1200 : 250,
    );
    return true;
  };

  const cancel = () => {
    if (!listening) return false;
    const { sessionId, mode, levelTimer } = listening;
    clearInterval(levelTimer);
    listening = null;
    if (mode === "dictation") emit({ type: "kalvoice.dictation_failed", payload: { sessionId, code: "cancelled" } });
    signal({ kind: "cancelled", sessionId, mode });
    return true;
  };

  const matches = (event: KeyboardEvent, accelerator: string) => {
    const pressed = shortcutFromEvent(event);
    const canonical = canonicalize(accelerator);
    return pressed !== null && canonical.ok && pressed === canonical.value;
  };

  // Emulates the native global shortcuts (the browser has none).
  let installedKeys = false;
  const installKeys = () => {
    if (installedKeys || typeof window === "undefined") return;
    installedKeys = true;
    window.addEventListener(
      "keydown",
      (event) => {
        if (event.repeat) return;
        if (matches(event, prefs.dictationShortcut)) {
          event.preventDefault();
          begin("dictation", false);
        } else if (matches(event, prefs.commandShortcut)) {
          event.preventDefault();
          commandPressedAt = Date.now();
          signal({ kind: "open_command_bar" });
          begin("command", true);
        }
      },
      true,
    );
    window.addEventListener(
      "keyup",
      (event) => {
        if (!listening) return;
        const released = event.code === "Space" || event.code.startsWith("Key") || /Control|Meta|Shift/.test(event.key);
        if (!released) return;
        if (listening.mode === "command") {
          if (Date.now() - commandPressedAt < 400) {
            const { sessionId, levelTimer } = listening;
            clearInterval(levelTimer);
            listening = null;
            signal({ kind: "cancelled", sessionId, mode: "command" });
          } else {
            finish(listening.sessionId);
          }
        } else {
          finish(listening.sessionId);
        }
      },
      true,
    );
  };

  const respond = (
    requestId: string,
    kind: string | null,
    outcome: KalVoiceOutcome,
    wasCounted: boolean,
    directive: UiDirective | null = null,
  ): KalVoiceResponse => ({
    requestId,
    intent: kind,
    outcome,
    usage: usage(),
    counted: wasCounted,
    directive,
  });

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
    const allowance = 250;
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
      emit(
        { type: "kalvoice.request_failed", payload: { requestId, code: "needs_provider" } },
        { correlation: { requestId } },
      );
      return respond(
        requestId,
        "reasoning",
        {
          kind: "needs_provider",
          message: "Connect a supported AI provider to use KalVoice reasoning for this request.",
        },
        false,
      );
    }
    emit(
      { type: "kalvoice.command_recognized", payload: { requestId, intent: parsed.kind } },
      { correlation: { requestId } },
    );
    if (parsed.consequential) {
      if (scenario !== "kalvoice-approvals") {
        return failed(
          "threads_unavailable",
          "Threads aren't available in this build yet, so KalVoice can't manage them.",
          parsed.kind,
        );
      }
      used += 1;
      counted.add(requestId);
      const approvalRequestId = crypto.randomUUID();
      pending.set(approvalRequestId, { requestId, kind: parsed.kind });
      return respond(requestId, parsed.kind, { kind: "permission_required", approvalRequestId }, true);
    }
    if (parsed.kind === "status_report") {
      return failed(
        "threads_unavailable",
        "Threads aren't available in this build yet, so KalVoice can't manage them.",
        parsed.kind,
      );
    }
    if (parsed.outcome?.kind === "failed") return failed(parsed.outcome.code, parsed.outcome.message, parsed.kind);
    used += 1;
    counted.add(requestId);
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

  const updatePreferences = (patch: KalVoicePreferencesPatch): KalVoiceStatus => {
    const allowed = new Set([
      "dictationShortcut",
      "commandShortcut",
      "intelligence",
      "speechModel",
      "voiceReplies",
      "panelDefault",
      "panelVisible",
      "panelPlacement",
    ]);
    if (Object.keys(patch).some((k) => !allowed.has(k)))
      fail("ipc_rejected", "KalCode couldn't complete that request.", "internal");
    if (Object.keys(patch).length === 0)
      fail("empty_preferences_patch", "No KalVoice preferences were provided to update.");
    const next: KalVoicePreferences = { ...prefs, panelPlacements: [...prefs.panelPlacements] };
    if (patch.dictationShortcut !== undefined) next.dictationShortcut = patch.dictationShortcut;
    if (patch.commandShortcut !== undefined) next.commandShortcut = patch.commandShortcut;
    for (const [key, other] of [
      ["dictationShortcut", "commandShortcut"],
      ["commandShortcut", "dictationShortcut"],
    ] as const) {
      const checked = validateShortcut(next[key], next[other], RESERVED);
      if (!checked.ok) fail(checked.code, checked.message);
      next[key] = checked.value;
    }
    for (const accelerator of [next.dictationShortcut, next.commandShortcut]) {
      if (
        accelerator === TAKEN_BY_ANOTHER_APP &&
        accelerator !== prefs.dictationShortcut &&
        accelerator !== prefs.commandShortcut
      ) {
        fail("shortcut_in_use", "Ctrl+Alt+O is already used by another app. Choose a different one.");
      }
    }
    if (patch.intelligence) {
      next.intelligence =
        patch.intelligence.kind === "automatic"
          ? null
          : patch.intelligence.kind === "local"
            ? { kind: "local" }
            : { kind: "provider", providerId: patch.intelligence.providerId };
    }
    if (patch.speechModel !== undefined) {
      if (!CATALOG.some((m) => m.id === patch.speechModel))
        fail("unknown_speech_model", "That speech model isn't in KalVoice's catalog.");
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
    prefs = next;
    if (keys.length) emit({ type: "settings.changed", payload: { keys } });
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

  const handlers: MemoryKalVoice["handlers"] = {
    kalvoice_subscribe: () => fail("use_subscribe", "Use subscribeKalVoice().", "internal"),
    kalvoice_status: () => status(),
    kalvoice_request: (args) => handleRequest(args.request as CommandRequest),
    kalvoice_preferences_update: (args) => updatePreferences(args.patch as KalVoicePreferencesPatch),
    kalvoice_listen_start: (args) => {
      const id = begin(args.mode as KalVoiceMode, false);
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

  // Approvals arrive from the (future) approvals UI; tests resolve them through this hook. It is
  // installed by the transport the app actually subscribes with (StrictMode boots twice).
  const installTestHook = () => {
    if (typeof window === "undefined") return;
    (window as unknown as { __kalvoiceTest?: unknown }).__kalvoiceTest = {
      approveAll: () => {
        for (const [approvalId, { requestId, kind }] of pending) {
          pending.delete(approvalId);
          signal({ kind: "request_stage", requestId, stage: "executing" });
          signal({
            kind: "request_resolved",
            response: respond(
              requestId,
              kind,
              { kind: "completed", summary: "Done: the approved command ran (test double)." },
              true,
            ),
          });
        }
      },
    };
  };

  return {
    handlers,
    subscribe(onSignal) {
      subscribers.add(onSignal);
      installKeys();
      installTestHook();
    },
  };
}
