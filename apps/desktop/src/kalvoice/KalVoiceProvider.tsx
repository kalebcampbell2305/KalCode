import type {
  KalVoiceInput,
  KalVoiceMode,
  KalVoicePreferencesPatch,
  KalVoiceResponse,
  KalVoiceSignal,
  KalVoiceStatus,
  PanelAnchor,
  PanelView,
  SizeClass,
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
  submit: (text: string, input?: KalVoiceInput) => Promise<void>;
  startListening: (mode: KalVoiceMode) => Promise<void>;
  stopListening: () => Promise<void>;
  cancel: () => Promise<void>;
  updatePreferences: (patch: KalVoicePreferencesPatch) => Promise<KalVoiceStatus>;
  downloads: Record<string, DownloadProgress>;
  downloadModel: (modelId: string) => Promise<void>;
  cancelDownload: (modelId: string) => Promise<void>;
  deleteModel: (modelId: string) => Promise<void>;
  history: readonly HistoryItem[];
  /** Incremented when the request box should take focus (command shortcut). */
  focusToken: number;
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
  openAssistant: () => void;
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

export function KalVoiceProvider({ children }: { children: ReactNode }) {
  const { client } = useRuntime();
  const { navigate } = useNavigation();
  const toast = useToast();
  const [status, setStatus] = useState<KalVoiceStatus | null>(null);
  const [statusError, setStatusError] = useState<KalCodeError | null>(null);
  const [state, dispatch] = useReducer(reduce, INITIAL_STATE);
  const [downloads, setDownloads] = useState<Record<string, DownloadProgress>>({});
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [focusToken, setFocusToken] = useState(0);
  const [localPanel, setLocalPanel] = useState<{
    anchor?: PanelAnchor;
    x?: number;
    y?: number;
    view?: PanelView;
  } | null>(null);
  const levelRef = useRef(0);
  const targets = useRef(new Map<string, DictationTarget>());
  const cancelled = useRef(new Set<string>());
  const stateRef = useRef(state);
  stateRef.current = state;
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
      setStatus((current) => (current ? { ...current, usage: response.usage } : current));
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
        const response = await client.kalvoiceRequest({ requestId, text: trimmed, input, workspaceId: null });
        applyResponse(response);
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
          if (signal.mode === "dictation") {
            // Resolve the target now: switching focus while speaking can't redirect the text.
            const target = resolveDictationTarget(document.activeElement);
            if (!target) {
              void client.kalvoiceListenCancel().catch(() => undefined);
              cancelled.current.add(signal.sessionId);
              dispatch({
                type: "dictation_blocked",
                message: "Click into a text box first, then hold the dictation shortcut.",
              });
              return;
            }
            targets.current.set(signal.sessionId, target);
          }
          break;
        case "open_command_bar":
          setLocalPanel((p) => ({ ...p, view: "expanded" }));
          setFocusToken((n) => n + 1);
          setStatus((current) =>
            current && !current.preferences.panelVisible
              ? { ...current, preferences: { ...current.preferences, panelVisible: true } }
              : current,
          );
          void client.kalvoiceUpdatePreferences({ panelVisible: true }).catch(() => undefined);
          return;
        case "result": {
          const result = signal.result;
          if (cancelled.current.delete(result.sessionId)) return;
          const target = targets.current.get(result.sessionId);
          targets.current.delete(result.sessionId);
          levelRef.current = 0;
          if (result.kind === "transcript") {
            if (result.mode === "command") {
              dispatch({ type: "signal", signal });
              void submit(result.text, "voice");
              return;
            }
            if (target && targetIsAlive(target)) {
              const characters = insertTranscript(target, result.text);
              dispatch({ type: "dictation_inserted", characters });
            } else {
              dispatch({
                type: "dictation_blocked",
                message: `The text box closed before your words arrived. You said: “${result.text}”`,
              });
            }
            return;
          }
          break;
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
          toast.show({ tone: "success", title: "Speech model installed", description: "Dictation is ready." });
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
    [client, submit, applyResponse, refreshStatus, toast],
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

  // A completed state is shown briefly, then the assistant returns to idle.
  useEffect(() => {
    if (state.phase !== "done") return;
    const timer = setTimeout(() => dispatch({ type: "settle" }), DONE_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [state.phase]);

  const cancel = useCallback(async () => {
    const current = stateRef.current;
    if (current.sessionId) cancelled.current.add(current.sessionId);
    try {
      await client.kalvoiceListenCancel();
    } catch {
      // Nothing was listening.
    }
    if (current.phase === "transcribing" && current.sessionId) {
      dispatch({
        type: "signal",
        signal: { kind: "cancelled", sessionId: current.sessionId, mode: current.mode ?? "dictation" },
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

  const startListening = useCallback(
    async (mode: KalVoiceMode) => {
      try {
        await client.kalvoiceListenStart(mode);
      } catch {
        // The native side reports why as a `listening_failed` signal.
      }
    },
    [client],
  );

  const stopListening = useCallback(async () => {
    const id = stateRef.current.sessionId;
    if (!id) return;
    try {
      await client.kalvoiceListenStop(id);
    } catch (error) {
      toast.show({ tone: "danger", title: "KalVoice", description: toKalCodeError(error).message });
    }
  }, [client, toast]);

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

  /** Moves or resizes the panel now and saves it shortly after (keyboard moves come in bursts). */
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
            title: "KalVoice panel position not saved",
            description: toKalCodeError(error).message,
          });
        });
      }, 250);
    },
    [sizeClass, updatePreferences, toast],
  );

  const setPanelVisible = useCallback(
    (visible: boolean) => {
      setStatus((current) =>
        current ? { ...current, preferences: { ...current.preferences, panelVisible: visible } } : current,
      );
      void updatePreferences({ panelVisible: visible }).catch(() => undefined);
    },
    [updatePreferences],
  );

  const openAssistant = useCallback(() => {
    setPanelVisible(true);
    setLocalPanel((p) => ({ ...p, view: "expanded" }));
    setFocusToken((n) => n + 1);
  }, [setPanelVisible]);

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
      updatePreferences,
      downloads,
      downloadModel,
      cancelDownload,
      deleteModel,
      history,
      focusToken,
      sizeClass,
      panel,
      setPanel,
      setPanelVisible,
      openAssistant,
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
      updatePreferences,
      downloads,
      downloadModel,
      cancelDownload,
      deleteModel,
      history,
      focusToken,
      sizeClass,
      panel,
      setPanel,
      setPanelVisible,
      openAssistant,
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
