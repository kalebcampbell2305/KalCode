import type {
  KalVoiceInput,
  KalVoicePreferencesPatch,
  KalVoiceResponse,
  KalVoiceSignal,
  KalVoiceStatus,
  LocalReasoningDownload,
  PanelAnchor,
  PanelView,
  SizeClass,
  TalkTarget,
  UiDirective,
} from "@kalcode/protocol";
import { useToast } from "@kalcode/ui/components";
import {
  createContext,
  type MutableRefObject,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { useOptionalAccount } from "../account/AccountProvider.tsx";
import { type KalCodeError, toKalCodeError } from "../ipc/errors.ts";
import { useRuntime } from "../runtime/RuntimeProvider.tsx";
import { useUiIntents } from "../runtime/uiIntents.tsx";
import { useWorkspaces } from "../runtime/WorkspaceProvider.tsx";
import { type Destination, useNavigation } from "../shell/navigation.tsx";
import {
  activateAndDispatchPaneCommand,
  dispatchPaneCommand,
  type PaneCommand,
  paneCanvasListening,
} from "../shell/panes/paneCommands.ts";
import { useOptionalSearch } from "../shell/rail/search/SearchProvider.tsx";
import { usePermissions } from "../surfaces/permissions/index.ts";
import { type AssistantState, INITIAL_STATE, reduce } from "./assistantState.ts";
import {
  type DictationTarget,
  insertTranscript,
  reconnectTarget,
  resolveDictationTarget,
  targetIsAlive,
} from "./dictation.ts";
import { type DictationSession, DictationSessions } from "./dictationSessions.ts";
import { placementFor, sizeClassFor } from "./panelGeometry.ts";
import { type TalkKeyState, withTalkKeyState } from "./readiness.ts";

export interface HistoryItem {
  requestId: string;
  /** What the user said or typed. Kept in this window only; never stored or sent in events. */
  text: string;
  input: KalVoiceInput;
  response: KalVoiceResponse | null;
}

export interface DownloadProgress {
  received: number;
  total: number;
}

interface KalVoiceValue {
  status: KalVoiceStatus | null;
  statusError: KalCodeError | null;
  /** No live signal channel: push-to-talk progress can't be shown until this clears. */
  signalsError: KalCodeError | null;
  /** The latest native push-to-talk key registration (`talk_key` signal), if any yet. */
  talkKey: TalkKeyState | null;
  refreshStatus: () => Promise<void>;
  /** Reconnects signals if needed, then re-reads status ("Try again"). */
  retryConnection: () => Promise<void>;
  state: AssistantState;
  /** The immutable pane destination captured for the active native dictation session. */
  dictationTarget: { sessionId: string; paneId: string | null } | null;
  /** Latest microphone level (0–1), for animation without re-rendering. */
  levelRef: MutableRefObject<number>;
  /** A typed request (KalVoice page, for people who can't or don't want to speak). */
  submit: (text: string, input?: KalVoiceInput) => Promise<void>;
  /** Press-and-hold on the orb (pointer alternative to the push-to-talk key). */
  startListening: () => Promise<void>;
  stopListening: () => Promise<void>;
  cancel: () => Promise<void>;
  /** Undo a spoken command: type the words into the box that had focus instead. */
  typeInstead: () => Promise<void>;
  canTypeInstead: boolean;
  dismiss: () => void;
  updatePreferences: (patch: KalVoicePreferencesPatch) => Promise<KalVoiceStatus>;
  downloads: Record<string, DownloadProgress>;
  downloadModel: (modelId: string, reasoning?: LocalReasoningDownload) => Promise<void>;
  prepareReasoning: () => Promise<LocalReasoningDownload>;
  retryReasoning: () => Promise<void>;
  cancelDownload: (modelId: string) => Promise<void>;
  deleteModel: (modelId: string) => Promise<void>;
  history: readonly HistoryItem[];
  sizeClass: SizeClass;
  panel: {
    visible: boolean;
    view: PanelView;
    anchor: PanelAnchor;
    x: number;
    y: number;
  };
  setPanel: (next: { anchor?: PanelAnchor; x?: number; y?: number; view?: PanelView }) => void;
  setPanelVisible: (visible: boolean) => void;
}

const KalVoiceContext = createContext<KalVoiceValue | null>(null);

const DONE_SETTLE_MS = 4000;

function useWindowWidth(): number {
  const [width, setWidth] = useState(() => (typeof window === "undefined" ? 1440 : window.innerWidth));
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return width;
}

function targetKind(target: DictationTarget | null): TalkTarget {
  if (!target) return "none";
  return target.kind === "sink" ? "terminal" : "field";
}

function dictationFailure(target: DictationTarget | null): string {
  return target?.kind === "sink"
    ? `${target.sink.label} couldn't accept the dictated text. Nothing was inserted.`
    : "The text box couldn't accept the dictated text. Nothing was inserted.";
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** Runs `fn` after the browser has painted the current update (for "visible action" timing). */
function afterPaint(fn: () => void) {
  requestAnimationFrame(() => setTimeout(fn, 0));
}

/** How long a pane command waits for the Code canvas to come up (60 × 50 ms). */
const PANE_WAIT_MS = 50;
const PANE_WAIT_TRIES = 60;

export function KalVoiceProvider({ children }: { children: ReactNode }) {
  const { client } = useRuntime();
  const { current, navigate } = useNavigation();
  const workspaces = useWorkspaces();
  const permissions = usePermissions();
  const uiIntents = useUiIntents();
  const searchValue = useOptionalSearch();
  const search = useRef(searchValue);
  search.current = searchValue;
  const toast = useToast();
  const [status, setStatus] = useState<KalVoiceStatus | null>(null);
  const [statusError, setStatusError] = useState<KalCodeError | null>(null);
  /** The window has no live KalVoice signal channel (subscribe was refused). */
  const [signalsError, setSignalsError] = useState<KalCodeError | null>(null);
  const [state, dispatch] = useReducer(reduce, INITIAL_STATE);
  const [downloads, setDownloads] = useState<Record<string, DownloadProgress>>({});
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [localPanel, setLocalPanel] = useState<{
    anchor?: PanelAnchor;
    x?: number;
    y?: number;
    view?: PanelView;
  } | null>(null);
  const levelRef = useRef(0);
  const dictationSessions = useRef(new DictationSessions<DictationTarget>());
  const [dictationTarget, setDictationTarget] = useState<{
    sessionId: string;
    paneId: string | null;
  } | null>(null);
  /** For "Type it instead": where the words would have gone and the page before a navigation. */
  const undo = useRef<{ requestId: string; target: DictationTarget | null; previous: Destination | null } | null>(null);
  const statusRef = useRef({ status, error: statusError });
  statusRef.current = { status, error: statusError };
  const stateRef = useRef(state);
  stateRef.current = state;
  const currentRef = useRef(current);
  currentRef.current = current;
  const width = useWindowWidth();
  const sizeClass = sizeClassFor(width);

  // Track focus before native capture starts. Widget pointer-down freezes the previously focused
  // target synchronously; native keyboard capture uses this already-tracked target.
  useEffect(() => {
    let active = true;
    const track = () => {
      if (active)
        dictationSessions.current.setFocusedTarget(
          document.hasFocus() ? resolveDictationTarget(document.activeElement) : null,
        );
    };
    // A native child webview can take focus while this document retains its activeElement.
    // Clear only the next capture's target; existing sessions keep their frozen destination.
    const loseFocus = () => dictationSessions.current.setFocusedTarget(null);
    const afterFocusOut = () => queueMicrotask(track);
    track();
    document.addEventListener("focusin", track, true);
    document.addEventListener("focusout", afterFocusOut, true);
    window.addEventListener("blur", loseFocus);
    window.addEventListener("focus", track);
    return () => {
      active = false;
      document.removeEventListener("focusin", track, true);
      document.removeEventListener("focusout", afterFocusOut, true);
      window.removeEventListener("blur", loseFocus);
      window.removeEventListener("focus", track);
      dictationSessions.current.reset();
    };
  }, []);

  // The latest native `talk_key` signal. Native sends it on every registration change and on each
  // subscribe, so it is newer than any status read and is applied on top of every status.
  const [talkKey, setTalkKey] = useState<TalkKeyState | null>(null);
  const talkKeyRef = useRef<TalkKeyState | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(withTalkKeyState(await client.kalvoiceStatus(), talkKeyRef.current));
      setStatusError(null);
    } catch (error) {
      setStatusError(toKalCodeError(error));
    }
  }, [client]);

  const updatePreferences = useCallback(
    async (patch: KalVoicePreferencesPatch) => {
      const next = await client.kalvoiceUpdatePreferences(patch);
      setStatus(withTalkKeyState(next, talkKeyRef.current));
      return next;
    },
    [client],
  );

  // The UI side of a command's result (the native side already did the work).
  const surfaces = useRef({ workspaces, permissions, toast, uiIntents });
  surfaces.current = { workspaces, permissions, toast, uiIntents };
  const runDirective = useCallback(
    (directive: UiDirective | null) => {
      const { workspaces, permissions, toast, uiIntents: intents } = surfaces.current;
      // Pane layout commands (Z7-W1) run on the Code canvas; they wait for it when Code isn't on
      // screen yet. Layout only: nothing starts, stops or closes a process.
      const pane = (command: PaneCommand) => {
        navigate("code");
        const deliver = () => {
          const result = dispatchPaneCommand(command);
          if (result.message) {
            toast.show({ tone: result.handled ? "info" : "danger", title: "Panes", description: result.message });
          }
        };
        if (paneCanvasListening()) {
          deliver();
          return;
        }
        // Code is opening: run the command once its canvas is up, so its result can be shown.
        let tries = 0;
        const timer = setInterval(() => {
          if (paneCanvasListening()) {
            clearInterval(timer);
            deliver();
          } else if (++tries >= PANE_WAIT_TRIES) {
            clearInterval(timer);
            dispatchPaneCommand(command, { queue: true });
          }
        }, PANE_WAIT_MS);
      };
      const scopedPane = (workspaceId: string, command: PaneCommand) => {
        void activateAndDispatchPaneCommand(
          workspaceId,
          command,
          workspaces.activate,
          () => navigate("code"),
          (result) => {
            if (result.message) {
              toast.show({ tone: result.handled ? "info" : "danger", title: "Panes", description: result.message });
            }
          },
        );
      };
      switch (directive?.kind) {
        case "navigate":
          navigate(directive.surface);
          break;
        case "open_workspace":
          void workspaces.activate(directive.workspaceId).then((activated) => {
            if (activated) navigate("code");
          });
          break;
        case "open_terminal": {
          const { workspaceId, terminalId } = directive;
          navigate("code");
          void workspaces.refresh().then(() => workspaces.selectTerminal(terminalId, true, workspaceId));
          break;
        }
        case "open_thread":
          // Z7-W3 focus intents: a provider pane thread is focused in its pane (Z7-W1 canvas),
          // anything else opens in Threads.
          void intents.focus({ kind: "thread", threadId: directive.threadId });
          break;
        case "open_provider_panes":
          scopedPane(directive.workspaceId, { kind: "open-provider-panes", threadIds: directive.threadIds });
          break;
        case "control_pane":
          scopedPane(directive.workspaceId, { kind: "control-pane", command: directive.command });
          break;
        case "control_browser":
          scopedPane(directive.workspaceId, { kind: "browser-control", command: directive.command });
          break;
        case "split_pane":
          pane({ kind: "split", axis: directive.axis });
          break;
        case "arrange_panes":
          pane({ kind: "arrange-providers", axis: directive.axis, providerIds: directive.providerIds });
          break;
        case "resize_pane":
          pane({ kind: "resize", direction: directive.direction, steps: directive.steps });
          break;
        case "close_pane":
          pane(directive.query ? { kind: "close", query: directive.query } : { kind: "close" });
          break;
        case "show_approvals":
          permissions.setPanelOpen(true);
          break;
        case "filter_dashboard":
          // Z7-W3: "Show only agents that are working" and friends.
          intents.filterDashboard(directive.chip);
          break;
        case "search":
          // Z7-W2: KalVoice already read back the names; the palette shows the results.
          search.current?.openWith(directive.query);
          break;
        default:
          break;
      }
    },
    [navigate],
  );

  const applyResponse = useCallback(
    (response: KalVoiceResponse) => {
      dispatch({ type: "response", response });
      setHistory((items) =>
        items.map((item) => (item.requestId === response.requestId ? { ...item, response } : item)),
      );
      setStatus((s) => (s ? { ...s, usage: response.usage } : s));
      runDirective(response.directive);
    },
    [runDirective],
  );

  const submit = useCallback(
    async (text: string, input: KalVoiceInput = "text") => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const requestId = crypto.randomUUID();
      setHistory((items) => [{ requestId, text: trimmed, input, response: null }, ...items].slice(0, 20));
      dispatch({ type: "submitted", requestId });
      try {
        applyResponse(
          await client.kalvoiceRequest({ requestId, text: trimmed, input, workspaceId: workspaces.active?.id ?? null }),
        );
      } catch (error) {
        const e = toKalCodeError(error);
        dispatch({ type: "request_error", requestId, message: e.message, code: e.code });
      }
    },
    [client, applyResponse, workspaces.active?.id],
  );

  /** One utterance: native routing decides command, dictation or request. */
  const talk = useCallback(
    async (session: DictationSession<DictationTarget>, text: string, durationMs: number) => {
      const started = performance.now();
      const { sessionId, target, signal } = session;
      const requestId = crypto.randomUUID();
      dispatch({ type: "submitted", requestId });
      const recordAction = () =>
        afterPaint(() => void client.kalvoiceLatencyRecord(performance.now() - started).catch(() => undefined));
      try {
        const previous = currentRef.current;
        const talked = await client.kalvoiceTalk({
          requestId,
          sessionId,
          text,
          target: targetKind(target),
          durationMs,
          workspaceId: workspaces.active?.id ?? null,
        });
        if (signal.aborted) return;
        if (talked.route === "dictation") {
          if (target && targetIsAlive(target)) {
            try {
              const characters = await insertTranscript(target, text, { signal });
              if (signal.aborted) return;
              dispatch({ type: "dictation_inserted", characters });
            } catch {
              if (signal.aborted) return;
              dispatch({ type: "dictation_blocked", message: dictationFailure(target) });
            }
          } else {
            dispatch({ type: "dictation_blocked", message: dictationFailure(target) });
          }
          recordAction();
          return;
        }
        const response = talked.response;
        if (!response) return;
        setHistory((items) => [{ requestId, text, input: "voice" as const, response }, ...items].slice(0, 20));
        undo.current = { requestId, target, previous: response.directive?.kind === "navigate" ? previous : null };
        dispatch({
          type: "talked",
          talk: { requestId, text, route: talked.route, hadTarget: target !== null },
        });
        applyResponse(response);
        recordAction();
      } catch (error) {
        if (signal.aborted) return;
        const e = toKalCodeError(error);
        dispatch({ type: "request_error", requestId, message: e.message, code: e.code });
      } finally {
        dictationSessions.current.finish(sessionId);
      }
    },
    [client, applyResponse, workspaces.active?.id],
  );

  const onSignal = useCallback(
    (signal: KalVoiceSignal) => {
      switch (signal.kind) {
        case "level":
          levelRef.current = signal.level;
          return;
        case "listening_started":
          levelRef.current = 0;
          {
            const session = dictationSessions.current.open(signal.sessionId);
            setDictationTarget(
              session ? { sessionId: session.sessionId, paneId: session.target?.paneId ?? null } : null,
            );
          }
          break;
        case "talk_key": {
          const update: TalkKeyState = {
            active: signal.active,
            reason: signal.reason,
            accelerator: signal.accelerator,
          };
          talkKeyRef.current = update;
          setTalkKey(update);
          setStatus((current) => withTalkKeyState(current, update));
          return;
        }
        case "reveal":
          setStatus((s) =>
            s && !s.preferences.panelVisible ? { ...s, preferences: { ...s.preferences, panelVisible: true } } : s,
          );
          if (status && !status.preferences.panelVisible) {
            void client.kalvoiceUpdatePreferences({ panelVisible: true }).catch(() => undefined);
          }
          return;
        case "result": {
          const result = signal.result;
          levelRef.current = 0;
          const session = dictationSessions.current.claim(result.sessionId);
          if (!session) return;
          setDictationTarget((current) => (current?.sessionId === result.sessionId ? null : current));
          dispatch({ type: "signal", signal });
          if (result.kind === "transcript") void talk(session, result.text, result.durationMs);
          else dictationSessions.current.finish(result.sessionId);
          return;
        }
        case "cancelled":
        case "listening_failed":
          levelRef.current = 0;
          if (signal.sessionId) dictationSessions.current.cancel(signal.sessionId);
          else dictationSessions.current.abandonPendingCapture();
          setDictationTarget((current) =>
            !signal.sessionId || current?.sessionId === signal.sessionId ? null : current,
          );
          break;
        case "model_progress":
          setDownloads((d) => ({
            ...d,
            [signal.modelId]: { received: signal.receivedBytes, total: signal.totalBytes },
          }));
          return;
        case "local_reasoning_status":
          setStatus((current) => (current ? { ...current, localReasoning: signal.status } : current));
          return;
        case "model_installed":
          setDownloads(({ [signal.modelId]: _, ...rest }) => rest);
          toast.show({
            tone: "success",
            title: signal.modelId === "local-reasoning" ? "Local interpreter installed" : "Speech model installed",
            description:
              signal.modelId === "local-reasoning"
                ? "KalVoice is checking local runtime readiness."
                : "Push to talk is ready.",
          });
          void refreshStatus();
          return;
        case "model_failed":
          setDownloads(({ [signal.modelId]: _, ...rest }) => rest);
          if (signal.code !== "download_cancelled") {
            toast.show({
              tone: "danger",
              title:
                signal.modelId === "local-reasoning" ? "Local interpreter not installed" : "Speech model not installed",
              description: signal.message,
            });
          }
          void refreshStatus();
          return;
        case "request_resolved":
          applyResponse(signal.response);
          return;
        default:
          break;
      }
      dispatch({ type: "signal", signal });
    },
    [client, talk, applyResponse, refreshStatus, toast, status],
  );

  const onSignalRef = useRef(onSignal);
  onSignalRef.current = onSignal;

  // The client keeps one native channel for the window; this provider only adds a listener, so
  // remounts never replace or drop the live channel. The latest handler is read through a ref.
  // A channel that couldn't be opened is its own state (`signalsError`), never masked by a
  // successful status read, and is retried whenever the window comes forward or on "Try again".
  const connectSignals = useRef<() => Promise<void>>(async () => undefined);
  useEffect(() => {
    let active = true;
    let remove: (() => void) | null = null;
    let pending: Promise<void> | null = null;
    const listener = (signal: KalVoiceSignal) => {
      if (active) onSignalRef.current(signal);
    };
    const attempt = async () => {
      try {
        if (remove) {
          // Attached already: re-register the window's channel in case native dropped it.
          await client.renewKalVoiceSubscription();
        } else {
          const unsubscribe = await client.subscribeKalVoice(listener);
          if (!active) {
            unsubscribe();
            return;
          }
          remove = unsubscribe;
        }
        if (!active) return;
        setSignalsError(null);
        // Connected while status is missing or unverified (e.g. the runtime just came up): re-read it.
        if (!statusRef.current.status || statusRef.current.error) void refreshStatus();
      } catch (error) {
        // A refused renewal keeps the attached listener and native's existing channel; only a
        // listener that never attached means signals can't arrive.
        if (active && !remove) setSignalsError(toKalCodeError(error));
      }
    };
    const connect = () => {
      pending ??= attempt().finally(() => {
        pending = null;
      });
      return pending;
    };
    connectSignals.current = connect;
    void connect().then(() => {
      if (active) void refreshStatus();
    });
    // Coming forward: renew (or retry) the channel. Native answers every subscribe with the
    // current `talk_key`, and reports focus changes itself, so nothing is re-read on a delay.
    const onForeground = () => {
      if (document.visibilityState === "hidden") return;
      void connect();
    };
    window.addEventListener("focus", onForeground);
    document.addEventListener("visibilitychange", onForeground);
    return () => {
      active = false;
      remove?.();
      window.removeEventListener("focus", onForeground);
      document.removeEventListener("visibilitychange", onForeground);
    };
  }, [client, refreshStatus]);

  // A status read that succeeds while signals are down means the native runtime is up: retry the
  // channel once per such read (bounded by status events, never by a timer loop).
  const retriedForStatus = useRef<KalVoiceStatus | null>(null);
  useEffect(() => {
    if (!signalsError || !status || retriedForStatus.current === status) return;
    retriedForStatus.current = status;
    void connectSignals.current();
  }, [status, signalsError]);

  // The account's native runtime becoming ready (a new runtime generation): connect signals if
  // they aren't, and re-read status, which could only fail before.
  const runtimeReady = useOptionalAccount()?.runtime.ready ?? false;
  const wasRuntimeReady = useRef(runtimeReady);
  useEffect(() => {
    const became = runtimeReady && !wasRuntimeReady.current;
    wasRuntimeReady.current = runtimeReady;
    if (!became) return;
    void connectSignals.current();
    void refreshStatus();
  }, [runtimeReady, refreshStatus]);

  /** "Try again": reconnect signals (if needed) and re-read status. */
  const retryConnection = useCallback(async () => {
    await connectSignals.current();
    await refreshStatus();
  }, [refreshStatus]);

  // Done is shown briefly, then the widget returns to Ready on its own.
  useEffect(() => {
    if (state.phase !== "done") return;
    const timer = setTimeout(() => dispatch({ type: "settle" }), DONE_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [state.phase]);

  const cancel = useCallback(async () => {
    const now = stateRef.current;
    const activeSession = now.sessionId !== null && dictationSessions.current.has(now.sessionId);
    if (now.sessionId) dictationSessions.current.cancel(now.sessionId);
    if (now.sessionId) {
      setDictationTarget((current) => (current?.sessionId === now.sessionId ? null : current));
    }
    try {
      await client.kalvoiceListenCancel();
    } catch {
      // Nothing was listening.
    }
    if (activeSession && now.sessionId) {
      dispatch({
        type: "signal",
        signal: { kind: "cancelled", sessionId: now.sessionId, mode: now.mode ?? "talk" },
      });
    }
  }, [client]);

  // Escape stops listening (and discards the recording) from anywhere.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const now = stateRef.current;
      const routing = now.sessionId !== null && dictationSessions.current.has(now.sessionId);
      if (now.phase === "listening" || now.phase === "transcribing" || routing) {
        event.preventDefault();
        void cancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [cancel]);

  const startListening = useCallback(async () => {
    const capture = dictationSessions.current.captureFocusedTarget();
    try {
      const sessionId = await client.kalvoiceListenStart("talk");
      const session = dictationSessions.current.open(sessionId, capture);
      setDictationTarget(session ? { sessionId: session.sessionId, paneId: session.target?.paneId ?? null } : null);
    } catch {
      dictationSessions.current.abandonCapture(capture);
      setDictationTarget(null);
      // The native side reports why as a `listening_failed` signal.
    }
  }, [client]);

  const stopListening = useCallback(async () => {
    const id = stateRef.current.sessionId;
    if (!id) return;
    try {
      await client.kalvoiceListenStop(id);
    } catch {
      // Already finished (e.g. the release came first).
    }
  }, [client]);

  const typeInstead = useCallback(async () => {
    const last = stateRef.current.lastTalk;
    const saved = undo.current;
    if (!last || !saved || saved.requestId !== last.requestId || !saved.target) return;
    if (saved.previous) {
      // Back to where the words were meant to go; its text box is re-created on the next frames.
      navigate(saved.previous);
      await nextFrame();
      await nextFrame();
    }
    const target = reconnectTarget(saved.target);
    if (!target) {
      dispatch({ type: "dictation_blocked", message: dictationFailure(saved.target) });
      return;
    }
    if (target.element instanceof HTMLElement) target.element.focus();
    try {
      await insertTranscript(target, last.text);
    } catch {
      dispatch({ type: "dictation_blocked", message: dictationFailure(target) });
      return;
    }
    let refunded = false;
    try {
      refunded = await client.kalvoiceTypeInstead(last.requestId);
    } catch {
      // Keeps the typed text either way.
    }
    undo.current = null;
    dispatch({
      type: "typed_instead",
      message: refunded ? "Typed instead." : "Typed instead. Its KalVoice Request remains counted.",
    });
    if (refunded) void refreshStatus();
  }, [client, navigate, refreshStatus]);

  const dismiss = useCallback(() => dispatch({ type: "dismiss" }), []);

  const prepareReasoning = useCallback(() => client.kalvoiceReasoningPrepare(), [client]);
  const retryReasoning = useCallback(() => client.kalvoiceReasoningRetry(), [client]);
  const downloadModel = useCallback(
    async (modelId: string, reasoning?: LocalReasoningDownload) => {
      const model = status?.models.find((m) => m.id === modelId);
      setDownloads((d) => ({ ...d, [modelId]: { received: 0, total: reasoning?.sizeBytes ?? model?.sizeBytes ?? 0 } }));
      try {
        // Called only from the consent dialog's Download button.
        await client.kalvoiceModelDownload(modelId, true, reasoning?.catalogIdentity);
      } catch (error) {
        setDownloads(({ [modelId]: _, ...rest }) => rest);
        toast.show({ tone: "danger", title: "Download didn't start", description: toKalCodeError(error).message });
      }
    },
    [client, status, toast],
  );

  const cancelDownload = useCallback(
    async (modelId: string) => {
      await client.kalvoiceModelCancel(modelId).catch(() => false);
      await refreshStatus();
    },
    [client, refreshStatus],
  );

  const deleteModel = useCallback(
    async (modelId: string) => {
      try {
        await client.kalvoiceModelDelete(modelId);
      } catch (error) {
        toast.show({ tone: "danger", title: "Couldn't remove the model", description: toKalCodeError(error).message });
      }
      await refreshStatus();
    },
    [client, refreshStatus, toast],
  );

  const prefs = status?.preferences;
  const saved = placementFor(prefs?.panelPlacements ?? [], sizeClass, prefs?.panelDefault ?? "top");
  const visible = prefs?.panelVisible ?? true;
  const anchor = localPanel?.anchor ?? saved.anchor;
  const x = localPanel?.x ?? saved.x;
  const y = localPanel?.y ?? saved.y;
  const view = localPanel?.view ?? saved.view;
  const panel = useMemo(() => ({ visible, anchor, x, y, view }), [visible, anchor, x, y, view]);

  // Local changes win until the saved preferences catch up; a new size class starts fresh.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the size class or saved placement changes.
  useEffect(() => {
    setLocalPanel(null);
  }, [sizeClass, JSON.stringify(saved)]);

  const panelRef = useRef(panel);
  panelRef.current = panel;
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Moves or resizes the widget now and saves it shortly after (keyboard moves come in bursts). */
  const setPanel = useCallback(
    (next: { anchor?: PanelAnchor; x?: number; y?: number; view?: PanelView }) => {
      const merged = { ...panelRef.current, ...next };
      panelRef.current = merged;
      setLocalPanel(merged);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        void updatePreferences({
          panelPlacement: { sizeClass, anchor: merged.anchor, x: merged.x, y: merged.y, view: merged.view },
        }).catch((error) => {
          toast.show({
            tone: "danger",
            title: "KalVoice position not saved",
            description: toKalCodeError(error).message,
          });
        });
      }, 250);
    },
    [sizeClass, updatePreferences, toast],
  );

  const setPanelVisible = useCallback(
    (next: boolean) => {
      setStatus((s) => (s ? { ...s, preferences: { ...s.preferences, panelVisible: next } } : s));
      void updatePreferences({ panelVisible: next }).catch(() => undefined);
    },
    [updatePreferences],
  );

  const canTypeInstead = Boolean(
    state.lastTalk?.route === "command" && state.lastTalk.hadTarget && state.phase === "done",
  );

  const value = useMemo<KalVoiceValue>(
    () => ({
      status,
      statusError,
      signalsError,
      talkKey,
      refreshStatus,
      retryConnection,
      state,
      dictationTarget,
      levelRef,
      submit,
      startListening,
      stopListening,
      cancel,
      typeInstead,
      canTypeInstead,
      dismiss,
      updatePreferences,
      downloads,
      downloadModel,
      prepareReasoning,
      retryReasoning,
      cancelDownload,
      deleteModel,
      history,
      sizeClass,
      panel,
      setPanel,
      setPanelVisible,
    }),
    [
      status,
      statusError,
      signalsError,
      talkKey,
      refreshStatus,
      retryConnection,
      state,
      dictationTarget,
      submit,
      startListening,
      stopListening,
      cancel,
      typeInstead,
      canTypeInstead,
      dismiss,
      updatePreferences,
      downloads,
      downloadModel,
      prepareReasoning,
      retryReasoning,
      cancelDownload,
      deleteModel,
      history,
      sizeClass,
      panel,
      setPanel,
      setPanelVisible,
    ],
  );

  return <KalVoiceContext.Provider value={value}>{children}</KalVoiceContext.Provider>;
}

/** KalVoice, or null when the KalVoice feature is off in this build. */
export function useOptionalKalVoice(): KalVoiceValue | null {
  return useContext(KalVoiceContext);
}

export function useKalVoice(): KalVoiceValue {
  const value = useContext(KalVoiceContext);
  if (!value) throw new Error("useKalVoice must be used inside <KalVoiceProvider>");
  return value;
}
