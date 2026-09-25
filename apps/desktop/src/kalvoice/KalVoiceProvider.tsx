import type {
  ApprovalDecision,
  KalVoiceInput,
  KalVoicePreferencesPatch,
  KalVoiceResponse,
  KalVoiceSignal,
  KalVoiceStatus,
  PanelAnchor,
  PanelView,
  SizeClass,
  SurfaceId,
  TalkTarget,
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
import { type KalCodeError, toKalCodeError } from "../ipc/errors.ts";
import { useRuntime } from "../runtime/RuntimeProvider.tsx";
import { useNavigation } from "../shell/navigation.tsx";
import { type AssistantState, INITIAL_STATE, reduce } from "./assistantState.ts";
import { type DictationTarget, insertTranscript, resolveDictationTarget, targetIsAlive } from "./dictation.ts";
import { placementFor, sizeClassFor } from "./panelGeometry.ts";

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
  refreshStatus: () => Promise<void>;
  state: AssistantState;
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
  decideApproval: (decision: ApprovalDecision) => Promise<void>;
  dismiss: () => void;
  updatePreferences: (patch: KalVoicePreferencesPatch) => Promise<KalVoiceStatus>;
  downloads: Record<string, DownloadProgress>;
  downloadModel: (modelId: string) => Promise<void>;
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

/** Runs `fn` after the browser has painted the current update (for "visible action" timing). */
function afterPaint(fn: () => void) {
  requestAnimationFrame(() => setTimeout(fn, 0));
}

export function KalVoiceProvider({ children }: { children: ReactNode }) {
  const { client } = useRuntime();
  const { current, navigate } = useNavigation();
  const toast = useToast();
  const [status, setStatus] = useState<KalVoiceStatus | null>(null);
  const [statusError, setStatusError] = useState<KalCodeError | null>(null);
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
  const targets = useRef(new Map<string, DictationTarget | null>());
  const cancelled = useRef(new Set<string>());
  /** For "Type it instead": where the words would have gone and the page before a navigation. */
  const undo = useRef<{ requestId: string; target: DictationTarget | null; previous: SurfaceId | null } | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const currentRef = useRef(current);
  currentRef.current = current;
  const width = useWindowWidth();
  const sizeClass = sizeClassFor(width);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await client.kalvoiceStatus());
      setStatusError(null);
    } catch (error) {
      setStatusError(toKalCodeError(error));
    }
  }, [client]);

  const updatePreferences = useCallback(
    async (patch: KalVoicePreferencesPatch) => {
      const next = await client.kalvoiceUpdatePreferences(patch);
      setStatus(next);
      return next;
    },
    [client],
  );

  const applyResponse = useCallback(
    (response: KalVoiceResponse) => {
      dispatch({ type: "response", response });
      setHistory((items) =>
        items.map((item) => (item.requestId === response.requestId ? { ...item, response } : item)),
      );
      setStatus((s) => (s ? { ...s, usage: response.usage } : s));
      if (response.directive?.kind === "navigate") navigate(response.directive.surface);
    },
    [navigate],
  );

  const submit = useCallback(
    async (text: string, input: KalVoiceInput = "text") => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const requestId = crypto.randomUUID();
      setHistory((items) => [{ requestId, text: trimmed, input, response: null }, ...items].slice(0, 20));
      dispatch({ type: "submitted", requestId });
      try {
        applyResponse(await client.kalvoiceRequest({ requestId, text: trimmed, input, workspaceId: null }));
      } catch (error) {
        const e = toKalCodeError(error);
        dispatch({ type: "request_error", requestId, message: e.message, code: e.code });
      }
    },
    [client, applyResponse],
  );

  /** One utterance: native routing decides command, dictation or request. */
  const talk = useCallback(
    async (sessionId: string, text: string, durationMs: number) => {
      const started = performance.now();
      const target = targets.current.get(sessionId) ?? null;
      targets.current.delete(sessionId);
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
          workspaceId: null,
        });
        if (talked.route === "dictation") {
          if (target && targetIsAlive(target)) {
            dispatch({ type: "dictation_inserted", characters: insertTranscript(target, text) });
          } else {
            dispatch({
              type: "dictation_blocked",
              message: `The text box closed before your words arrived. You said: “${text}”`,
            });
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
        const e = toKalCodeError(error);
        dispatch({ type: "request_error", requestId, message: e.message, code: e.code });
      }
    },
    [client, applyResponse],
  );

  const onSignal = useCallback(
    (signal: KalVoiceSignal) => {
      switch (signal.kind) {
        case "level":
          levelRef.current = signal.level;
          return;
        case "listening_started":
          levelRef.current = 0;
          // The target is fixed now: switching focus while speaking can't redirect the text.
          targets.current.set(signal.sessionId, resolveDictationTarget(document.activeElement));
          break;
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
          if (cancelled.current.delete(result.sessionId)) return;
          dispatch({ type: "signal", signal });
          if (result.kind === "transcript") void talk(result.sessionId, result.text, result.durationMs);
          return;
        }
        case "cancelled":
        case "listening_failed":
          levelRef.current = 0;
          if (signal.sessionId) targets.current.delete(signal.sessionId);
          break;
        case "model_progress":
          setDownloads((d) => ({
            ...d,
            [signal.modelId]: { received: signal.receivedBytes, total: signal.totalBytes },
          }));
          return;
        case "model_installed":
          setDownloads(({ [signal.modelId]: _, ...rest }) => rest);
          toast.show({ tone: "success", title: "Speech model installed", description: "Push to talk is ready." });
          void refreshStatus();
          return;
        case "model_failed":
          setDownloads(({ [signal.modelId]: _, ...rest }) => rest);
          if (signal.code !== "download_cancelled") {
            toast.show({ tone: "danger", title: "Speech model not installed", description: signal.message });
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

  // Subscribe once per client; the latest handler is read through a ref.
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        await client.subscribeKalVoice((signal) => {
          if (active) onSignalRef.current(signal);
        });
      } catch (error) {
        if (active) setStatusError(toKalCodeError(error));
      }
      if (active) await refreshStatus();
    })();
    return () => {
      active = false;
    };
  }, [client, refreshStatus]);

  // Done is shown briefly, then the widget returns to Ready on its own.
  useEffect(() => {
    if (state.phase !== "done") return;
    const timer = setTimeout(() => dispatch({ type: "settle" }), DONE_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [state.phase]);

  const cancel = useCallback(async () => {
    const now = stateRef.current;
    if (now.sessionId) cancelled.current.add(now.sessionId);
    try {
      await client.kalvoiceListenCancel();
    } catch {
      // Nothing was listening.
    }
    if (now.phase === "transcribing" && now.sessionId) {
      dispatch({
        type: "signal",
        signal: { kind: "cancelled", sessionId: now.sessionId, mode: now.mode ?? "command" },
      });
    }
  }, [client]);

  // Escape stops listening (and discards the recording) from anywhere.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const phase = stateRef.current.phase;
      if (phase === "listening" || phase === "transcribing") {
        event.preventDefault();
        void cancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [cancel]);

  const startListening = useCallback(async () => {
    try {
      await client.kalvoiceListenStart("command");
    } catch {
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
    if (!targetIsAlive(saved.target)) {
      dispatch({ type: "dictation_blocked", message: "That text box has closed." });
      return;
    }
    if (saved.previous) navigate(saved.previous);
    insertTranscript(saved.target, last.text);
    let refunded = false;
    try {
      refunded = await client.kalvoiceTypeInstead(last.requestId);
    } catch {
      // Keeps the typed text either way.
    }
    undo.current = null;
    dispatch({
      type: "typed_instead",
      message: refunded ? "Typed instead." : "Typed instead. The command itself can't be undone.",
    });
    if (refunded) void refreshStatus();
  }, [client, navigate, refreshStatus]);

  const decideApproval = useCallback(
    async (decision: ApprovalDecision) => {
      const id = stateRef.current.approvalRequestId;
      if (!id) return;
      try {
        await client.decideApproval(id, decision);
      } catch (error) {
        toast.show({ tone: "danger", title: "Approval not recorded", description: toKalCodeError(error).message });
      }
    },
    [client, toast],
  );

  const dismiss = useCallback(() => dispatch({ type: "dismiss" }), []);

  const downloadModel = useCallback(
    async (modelId: string) => {
      const model = status?.models.find((m) => m.id === modelId);
      setDownloads((d) => ({ ...d, [modelId]: { received: 0, total: model?.sizeBytes ?? 0 } }));
      try {
        // Called only from the consent dialog's Download button.
        await client.kalvoiceModelDownload(modelId, true);
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
  const saved = placementFor(prefs?.panelPlacements ?? [], sizeClass, prefs?.panelDefault ?? "bottom_right");
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
      refreshStatus,
      state,
      levelRef,
      submit,
      startListening,
      stopListening,
      cancel,
      typeInstead,
      canTypeInstead,
      decideApproval,
      dismiss,
      updatePreferences,
      downloads,
      downloadModel,
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
      refreshStatus,
      state,
      submit,
      startListening,
      stopListening,
      cancel,
      typeInstead,
      canTypeInstead,
      decideApproval,
      dismiss,
      updatePreferences,
      downloads,
      downloadModel,
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
