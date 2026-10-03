import type {
  ComponentProvisioning,
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
import { OperationsClient } from "../ipc/operations.ts";
import { DESKTOP_PLATFORM } from "../platform/keyboard.ts";
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
import { useKalTidy } from "../surfaces/code/kaltidy/kalTidyContext.ts";
import { isCodingAgent } from "../surfaces/dashboard/data/agents.ts";
import { usePermissions } from "../surfaces/permissions/index.ts";
import { getSelectedThread, requestRebind } from "../surfaces/threads/accountIntent.ts";
import { useOptionalThreadsIntent } from "../surfaces/threads/intent.tsx";
import { combineAbortSignals } from "./abortSignals.ts";
import { type AssistantState, INITIAL_STATE, reduce } from "./assistantState.ts";
import { composerForThread, setListeningComposer, waitForComposer } from "./composerRegistry.ts";
import {
  type DictationTarget,
  deliverToProviderThread,
  dictationTargetForProviderThread,
  insertTranscript,
  reconnectTarget,
  resolveDictationTarget,
  submitCapturedProviderTarget,
  targetIsAlive,
  waitForProviderThreadTarget,
} from "./dictation.ts";
import { type DictationCapture, type DictationSession, DictationSessions } from "./dictationSessions.ts";
import { parseKalTidyCommand, runKalTidyCommand } from "./kalTidyVoice.ts";
import { placementFor, sizeClassFor } from "./panelGeometry.ts";
import {
  type LocalReasoningState,
  type TalkKeyState,
  withProvisioning,
  withReasoningState,
  withTalkKeyState,
} from "./readiness.ts";
import { attachReportedFnInput } from "./reportedFnInput.ts";
import {
  executeOperationsVoiceChoice,
  focusOperationsTarget,
  handleOperationsVoice,
  type OperationsVoiceResult,
  type OperationsVoiceTarget,
} from "./sceneOperations.ts";
import { sceneReference } from "./sceneRouting.ts";
import { sceneChoiceLabel, type VoiceSceneTarget } from "./sceneTargets.ts";
import {
  CHOICE_TTL_MS,
  choiceIsLive,
  isChoiceAnswer,
  normalizeSpoken,
  pickSpokenChoice,
  type SessionChoiceState,
} from "./sessionChoice.ts";
import { useVoiceScene } from "./useVoiceScene.ts";
import {
  type ComposerDirectiveDeps,
  clearComposer,
  composeInThread,
  type DirectiveReport,
  followUpChoice,
  submitComposer,
} from "./voiceDirectives.ts";

export interface HistoryItem {
  requestId: string;
  /** What the user said or typed. Kept in this window only; never stored or sent in events. */
  text: string;
  input: KalVoiceInput;
  response: KalVoiceResponse | null;
  /** Terminal result for a local scene action; never fabricated as a native response. */
  localResult: DirectiveReport | null;
}

interface RequestLease {
  requestId: string | null;
  controller: AbortController;
}

interface RequestScope {
  requestId: string;
  signal: AbortSignal;
  report: (result: DirectiveReport) => void;
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
  /** The immutable destination captured for the active native dictation session. */
  dictationTarget: DictationTargetView | null;
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
  /** Pauses or resumes the automatic local-intelligence download (stored; survives restarts). */
  setIntelligencePaused: (paused: boolean) => Promise<void>;
  /** Opens the system's microphone privacy settings (when access is blocked). */
  openMicrophoneSettings: () => Promise<void>;
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
  /** A pending "Which one?" (`choose_session`), answered by a click or by saying the name. */
  sessionChoice: SessionChoiceState | null;
  chooseSession: (threadId: string) => void;
  dismissSessionChoice: () => void;
  sceneChoice: { question: string; choices: { id: string; label: string }[] } | null;
  chooseScene: (id: string) => void;
  dismissSceneChoice: () => void;
}

/** What the UI shows about the active push-to-talk destination (ids only). */
export interface DictationTargetView {
  sessionId: string;
  paneId: string | null;
  /** The thread whose composer receives the words (null for other targets). */
  composerThreadId: string | null;
}

function targetView(sessionId: string, target: DictationTarget | null): DictationTargetView {
  return {
    sessionId,
    paneId: target?.paneId ?? null,
    composerThreadId: target?.kind === "composer" ? target.composer.handle.threadId : null,
  };
}

/** Voice never presses Enter in a raw terminal or provider pane, and never edits its line. */
const TERMINAL_SUBMIT_REFUSED = "KalVoice never presses Enter in a terminal. Press Enter yourself to run it.";
const TERMINAL_CLEAR_REFUSED = "KalVoice doesn't edit a terminal's line. Nothing was changed.";

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
  // A thread composer is a text field to native routing (only High-confidence commands run).
  if (target.kind === "sink") {
    return target.sink.destination.kind === "provider_pane" ? "provider_pane" : "terminal";
  }
  return "field";
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
/** How many finished threads KalVoice remembers for "the agent that just finished". */
const RECENT_COMPLETIONS = 8;

export function KalVoiceProvider({ children }: { children: ReactNode }) {
  const { client, feed } = useRuntime();
  const { current, navigate } = useNavigation();
  const workspaces = useWorkspaces();
  const scene = useVoiceScene();
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
  const [dictationTarget, setDictationTarget] = useState<DictationTargetView | null>(null);
  // The composer hint ("KALVOICE TARGET · …") follows the active session's captured target.
  const listeningComposer = dictationTarget?.composerThreadId ?? null;
  useEffect(() => {
    setListeningComposer(listeningComposer);
  }, [listeningComposer]);
  useEffect(() => () => setListeningComposer(null), []);
  const [sessionChoice, setSessionChoice] = useState<SessionChoiceState | null>(null);
  const [sceneChoice, setSceneChoice] = useState<{
    question: string;
    requestId: string;
    choices: { id: string; label: string; execute: (scope: RequestScope) => Promise<void> }[];
    expiresAt: number;
  } | null>(null);
  const sceneChoiceRef = useRef(sceneChoice);
  sceneChoiceRef.current = sceneChoice;
  const activeRequest = useRef<RequestLease | null>(null);
  /**
   * Native request/talk IPC has no cancellation contract once invoked. Keep its lease exclusive
   * until the promise settles; teardown may fence renderer work but cannot retract a native effect.
   */
  const nativeRequestInFlight = useRef<RequestLease | null>(null);
  const reportNativeRequestBusy = useCallback(
    () =>
      toast.show({
        tone: "info",
        title: "KalVoice is already executing",
        description: "It can't be cancelled now. Wait for its final result before starting another request.",
      }),
    [toast],
  );
  const abortActiveRequest = useCallback(
    (markCancelled: boolean): boolean => {
      if (markCancelled && nativeRequestInFlight.current) {
        reportNativeRequestBusy();
        return false;
      }
      const active = activeRequest.current;
      if (!active) return true;
      active.controller.abort();
      activeRequest.current = null;
      if (!markCancelled || !active.requestId) return true;
      const localResult = { ok: false, message: "Cancelled." } satisfies DirectiveReport;
      dispatch({ type: "action_result", requestId: active.requestId, ...localResult });
      setHistory((items) =>
        items.map((item) =>
          item.requestId === active.requestId && item.response === null && item.localResult === null
            ? { ...item, localResult }
            : item,
        ),
      );
      return true;
    },
    [reportNativeRequestBusy],
  );
  const beginRequest = useCallback(
    (requestId: string | null): RequestLease | null => {
      if (!abortActiveRequest(true)) return null;
      const lease = { requestId, controller: new AbortController() };
      activeRequest.current = lease;
      return lease;
    },
    [abortActiveRequest],
  );
  const scopeFor = useCallback((lease: RequestLease, externalSignal?: AbortSignal): RequestScope | null => {
    if (!lease.requestId) return null;
    const signal = externalSignal
      ? combineAbortSignals([lease.controller.signal, externalSignal])
      : lease.controller.signal;
    return {
      requestId: lease.requestId,
      signal,
      report: (result) => {
        if (signal.aborted || activeRequest.current !== lease) return;
        dispatch({ type: "action_result", requestId: lease.requestId as string, ...result });
        setHistory((items) =>
          items.map((item) =>
            item.requestId === lease.requestId && item.response === null ? { ...item, localResult: result } : item,
          ),
        );
      },
    };
  }, []);
  const lastOperation = useRef<{ target: OperationsVoiceTarget; expiresAt: number } | null>(null);
  const lastSceneTarget = useRef<{ target: VoiceSceneTarget; expiresAt: number } | null>(null);
  const lastCompletedThread = useRef<{ threadId: string; at: number } | null>(null);
  /** Threads whose work finished since mount, newest first ("open the agent that just finished"). */
  const recentCompletions = useRef<string[]>([]);
  const lastLifecycle = useRef<{
    targetKind: "thread" | "operation";
    targetId: string;
    workspaceId?: string;
    expiresAt: number;
  } | null>(null);
  const sceneLifetime = useRef(new AbortController());
  // biome-ignore lint/correctness/useExhaustiveDependencies: client changes invalidate every pending scene action.
  useEffect(() => {
    sceneLifetime.current = new AbortController();
    return () => {
      // This only prevents renderer work after teardown; native talk may still finish its effect.
      abortActiveRequest(false);
      sceneLifetime.current.abort();
      sceneChoiceRef.current = null;
      lastSceneTarget.current = null;
      lastOperation.current = null;
      lastCompletedThread.current = null;
      recentCompletions.current = [];
      lastLifecycle.current = null;
    };
  }, [client, abortActiveRequest]);
  const operationsClient = useMemo(
    () => new OperationsClient((command, args) => client.transport.invoke(command, args)),
    [client],
  );
  const choiceRef = useRef(sessionChoice);
  choiceRef.current = sessionChoice;
  const [contextClient, setContextClient] = useState(client);
  if (contextClient !== client) {
    abortActiveRequest(false);
    setContextClient(client);
    setSceneChoice(null);
    setSessionChoice(null);
    sceneChoiceRef.current = null;
    choiceRef.current = null;
    lastSceneTarget.current = null;
    lastOperation.current = null;
    lastCompletedThread.current = null;
    recentCompletions.current = [];
    lastLifecycle.current = null;
  }
  const choiceId = useRef(0);
  const launchRetry = useRef<((text: string, workspaceId: string, label: string) => Promise<void>) | null>(null);
  /** For "Type it instead": where the words would have gone and the page before a navigation. */
  const undo = useRef<{ requestId: string; target: DictationTarget | null; previous: Destination | null } | null>(null);
  const statusRef = useRef({ status, error: statusError });
  statusRef.current = { status, error: statusError };
  useEffect(() => {
    lastCompletedThread.current = null;
    recentCompletions.current = [];
    lastLifecycle.current = null;
    if (!feed) return;
    const mountedAt = Date.now();
    let highWater = feed.getSnapshot().events[0]?.seq ?? 0;
    return feed.subscribe(() => {
      const events = feed.getSnapshot().events;
      const fresh = events.filter((event) => event.seq > highWater && Date.parse(event.occurredAt) >= mountedAt);
      highWater = Math.max(highWater, events[0]?.seq ?? 0);
      const completions = fresh.flatMap((event) =>
        event.type === "thread.completed" ||
        (event.type === "agent.turn_completed" && event.payload.ok && !event.payload.interrupted)
          ? [event]
          : [],
      );
      const completion = completions[0];
      if (!completion) return;
      lastCompletedThread.current = { threadId: completion.payload.threadId, at: Date.parse(completion.occurredAt) };
      const ids = completions.map((event) => event.payload.threadId);
      recentCompletions.current = [...new Set([...ids, ...recentCompletions.current])].slice(0, RECENT_COMPLETIONS);
    });
  }, [feed]);
  useEffect(() => {
    if (DESKTOP_PLATFORM !== "windows" || !status?.preferences.talkEnabled) return;
    return attachReportedFnInput(
      window,
      (input) => client.kalvoiceFnInput(input),
      () => {
        toast.show({
          tone: "info",
          title: "Fn push to talk is unavailable",
          description: `Use ${statusRef.current.status?.preferences.talkKey ?? "F8"}, the configured fallback key.`,
        });
      },
    );
  }, [client, status?.preferences.talkEnabled, toast]);
  const stateRef = useRef(state);
  stateRef.current = state;
  /** The latest orb start, until a stop consumes it or Escape abandons it. */
  const pendingStart = useRef<{
    promise: Promise<string | null>;
    capture: DictationCapture<DictationTarget>;
    abandoned: boolean;
    sessionId: string | null;
  } | null>(null);
  const abandonedStartIds = useRef(new Set<string>());
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
  // The latest native `local_reasoning_status`, applied over every status read the same way.
  const reasoningRef = useRef<LocalReasoningState | null>(null);
  // The latest native `provisioning` list (component downloads), applied the same way.
  const provisioningRef = useRef<ComponentProvisioning[] | null>(null);
  const withNativeState = useCallback(
    (next: KalVoiceStatus) =>
      withProvisioning(
        withReasoningState(withTalkKeyState(next, talkKeyRef.current), reasoningRef.current),
        provisioningRef.current,
      ),
    [],
  );

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(withNativeState(await client.kalvoiceStatus()));
      setStatusError(null);
    } catch (error) {
      setStatusError(toKalCodeError(error));
    }
  }, [client, withNativeState]);

  const updatePreferences = useCallback(
    async (patch: KalVoicePreferencesPatch) => {
      const next = await client.kalvoiceUpdatePreferences(patch);
      setStatus(withNativeState(next));
      return next;
    },
    [client, withNativeState],
  );

  const threadsIntent = useOptionalThreadsIntent();
  const kalTidy = useKalTidy();
  // The UI side of a command's result (the native side already did the work).
  const surfaces = useRef({ workspaces, permissions, toast, uiIntents, threadsIntent, kalTidy });
  surfaces.current = { workspaces, permissions, toast, uiIntents, threadsIntent, kalTidy };

  /** Composer directives act on a thread's own message box, which lives in Threads. */
  const composerDeps = useCallback(
    (scope?: RequestScope): ComposerDirectiveDeps => ({
      openThread: (threadId) => {
        if (scope?.signal.aborted) return;
        if (currentRef.current === "threads" && composerForThread(threadId)?.handle.element()?.isConnected) return;
        const { threadsIntent: threads, uiIntents: intents } = surfaces.current;
        if (threads) {
          navigate("threads");
          threads.request("open", threadId);
        } else {
          void intents.focus({ kind: "thread", threadId });
        }
      },
      report: (result) => scope?.report(result),
      signal: scope?.signal,
    }),
    [navigate],
  );

  const runDirective = useCallback(
    (directive: UiDirective | null, scope: RequestScope, origin: { target: DictationTarget | null } | null = null) => {
      if (scope.signal.aborted) return;
      const { workspaces, permissions, toast, uiIntents: intents, threadsIntent: threads } = surfaces.current;
      // Pane commands run on the Code canvas and wait for its registered handler when Code is opening.
      const pane = (command: PaneCommand) => {
        if (scope.signal.aborted) return;
        navigate("code");
        const deliver = () => {
          if (scope.signal.aborted) return;
          const result = dispatchPaneCommand(command, { signal: scope.signal });
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
          if (scope.signal.aborted) {
            clearInterval(timer);
            return;
          }
          if (paneCanvasListening()) {
            clearInterval(timer);
            deliver();
          } else if (++tries >= PANE_WAIT_TRIES) {
            clearInterval(timer);
            dispatchPaneCommand(command, { queue: true, signal: scope.signal });
          }
        }, PANE_WAIT_MS);
      };
      const scopedPane = (workspaceId: string, command: PaneCommand) => {
        if (scope.signal.aborted) return;
        void activateAndDispatchPaneCommand(
          workspaceId,
          command,
          workspaces.activate,
          () => navigate("code"),
          (result) => {
            if (scope.signal.aborted) return;
            if (result.message) {
              toast.show({ tone: result.handled ? "info" : "danger", title: "Panes", description: result.message });
            }
          },
          scope.signal,
        );
      };
      switch (directive?.kind) {
        case "choose_launch_account":
          setSessionChoice(null);
          setSceneChoice({
            question: directive.question,
            requestId: scope.requestId,
            expiresAt: Date.now() + CHOICE_TTL_MS,
            choices: directive.choices.map((choice) => ({
              id: choice.accountId,
              label: choice.label,
              execute: async (choiceScope) => {
                if (choiceScope.signal.aborted) return;
                if (!launchRetry.current) return;
                await launchRetry.current(choice.retryText, directive.workspaceId, choice.label);
              },
            })),
          });
          break;
        case "navigate":
          navigate(directive.surface);
          break;
        case "open_workspace":
          void workspaces.activate(directive.workspaceId).then((activated) => {
            if (!scope.signal.aborted && activated) navigate("code");
          });
          break;
        case "open_terminal": {
          const { workspaceId, terminalId } = directive;
          navigate("code");
          void workspaces.refresh().then(() => {
            if (!scope.signal.aborted) workspaces.selectTerminal(terminalId, true, workspaceId);
          });
          break;
        }
        case "open_thread":
          // Z7-W3 focus intents: a provider pane thread is focused in its pane (Z7-W1 canvas),
          // anything else opens in Threads.
          void intents.focus({ kind: "thread", threadId: directive.threadId });
          break;
        case "open_agent":
          void intents.focus({ kind: "agent", agentId: directive.agentId, workspaceId: directive.workspaceId });
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
        case "confirm_thread_rebind":
          // 0.1.5: KalVoice never rebinds a thread. It asks Threads to show the Rebind dialog;
          // only the person's confirmation there switches the account.
          // Always Threads (never a pane), and the request expires if the person moves on (S4).
          requestRebind(directive.threadId, directive.accountId);
          navigate("threads");
          break;
        case "submit_composer":
          if (origin?.target?.kind === "sink" && origin.target.sink.destination.kind === "provider_pane") {
            const captured = origin.target;
            const capturedThreadId = origin.target.sink.destination.threadId;
            if (!targetIsAlive(captured) || capturedThreadId !== directive.threadId) {
              scope.report({ ok: false, message: "That agent is no longer the captured target. Nothing was sent." });
              break;
            }
            void submitCapturedProviderTarget(captured, { signal: scope.signal }).then(
              () => scope.report({ ok: true, message: `Sent to ${captured.sink.label}.` }),
              (error) => scope.report({ ok: false, message: toKalCodeError(error).message }),
            );
          } else if (origin?.target?.kind === "sink") scope.report({ ok: false, message: TERMINAL_SUBMIT_REFUSED });
          else void submitComposer(composerDeps(scope), directive.threadId);
          break;
        case "clear_composer":
          if (origin?.target?.kind === "sink") scope.report({ ok: false, message: TERMINAL_CLEAR_REFUSED });
          else clearComposer(composerDeps(scope), directive.threadId);
          break;
        case "compose_in_thread":
          // A mounted provider terminal has the same immutable thread identity as its composer.
          // Preserve its native input-readiness checks; never fall back after a refused delivery.
          if (dictationTargetForProviderThread(directive.threadId)) {
            void deliverToProviderThread(directive.threadId, directive.text, {
              mode: directive.submit ? "send" : "insert",
              signal: scope.signal,
            }).then(
              () =>
                scope.report({
                  ok: true,
                  message: directive.submit ? "Sent to the agent." : "Inserted in the agent terminal.",
                }),
              (error) => scope.report({ ok: false, message: toKalCodeError(error).message }),
            );
          } else {
            void (async () => {
              const thread = await client.getThread(directive.threadId);
              if (scope.signal.aborted) return;
              if (isCodingAgent(thread)) {
                await intents.focus({ kind: "agent", agentId: thread.id, workspaceId: thread.workspaceId });
                // Focusing opens the agent's pane on a later render; its terminal registers then.
                await waitForProviderThreadTarget(thread.id, scope.signal);
                if (scope.signal.aborted) return;
                await deliverToProviderThread(thread.id, directive.text, {
                  mode: directive.submit ? "send" : "insert",
                  signal: scope.signal,
                });
                scope.report({
                  ok: true,
                  message: directive.submit ? "Sent to the agent." : "Inserted in the agent terminal.",
                });
              } else await composeInThread(composerDeps(scope), directive);
            })().catch((error) => scope.report({ ok: false, message: toKalCodeError(error).message }));
          }
          break;
        case "focus_previous":
          void intents.focusPrevious().then((focused) => {
            if (!scope.signal.aborted && !focused)
              scope.report({ ok: false, message: "There's no earlier thread or terminal to go back to." });
          });
          break;
        case "choose_session":
          // Non-modal: the question stays up beside the widget until answered or expired.
          setSessionChoice({
            id: ++choiceId.current,
            question: directive.question,
            choices: directive.choices,
            followUp: directive.followUp,
            expiresAt: Date.now() + CHOICE_TTL_MS,
          });
          break;
        case "open_new_thread":
          // Only opens New thread, prefilled: nothing starts until the person sends (S3). An empty
          // provider id is not a request KalVoice can prefill.
          if (directive.providerId.length === 0) break;
          navigate("threads");
          threads?.request("new", undefined, {
            providerId: directive.providerId,
            providerAccountId: directive.providerAccountId,
            workspaceId: directive.workspaceId,
          });
          break;
      }
    },
    [navigate, composerDeps, client],
  );

  const applyResponse = useCallback(
    (
      response: KalVoiceResponse,
      origin: { target: DictationTarget | null } | null = null,
      suppliedScope?: RequestScope,
    ): boolean => {
      const active = activeRequest.current;
      const scope =
        suppliedScope ??
        (active?.requestId === response.requestId && !active.controller.signal.aborted ? scopeFor(active) : null);
      if (!scope || scope.requestId !== response.requestId || scope.signal.aborted) return false;
      if (response.directive && response.directive.kind !== "choose_session") {
        lastLifecycle.current = null;
        lastOperation.current = null;
        if (
          response.directive.kind === "open_thread" ||
          response.directive.kind === "open_agent" ||
          response.directive.kind === "compose_in_thread"
        ) {
          const threadId =
            response.directive.kind === "open_agent" ? response.directive.agentId : response.directive.threadId;
          const target = scene
            .snapshot()
            .find(
              (candidate) =>
                (candidate.kind === "thread" || candidate.kind === "agent") && candidate.entityId === threadId,
            );
          lastSceneTarget.current = target ? { target, expiresAt: Date.now() + 120_000 } : null;
        } else if (response.directive.kind !== "submit_composer") lastSceneTarget.current = null;
      }
      dispatch({ type: "response", response });
      setHistory((items) =>
        items.map((item) => (item.requestId === response.requestId ? { ...item, response, localResult: null } : item)),
      );
      setStatus((s) => (s ? { ...s, usage: response.usage } : s));
      runDirective(response.directive, scope, origin);
      return true;
    },
    [runDirective, scene, scopeFor],
  );

  // A clarification waits 30 s for an answer, then goes away on its own.
  useEffect(() => {
    if (!sessionChoice) return;
    const timer = setTimeout(
      () => setSessionChoice((current) => (current?.id === sessionChoice.id ? null : current)),
      Math.max(0, sessionChoice.expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [sessionChoice]);

  const dismissSessionChoice = useCallback(() => setSessionChoice(null), []);

  const dismissSceneChoice = useCallback(() => {
    sceneChoiceRef.current = null;
    setSceneChoice(null);
  }, []);
  const chooseScene = useCallback(
    async (id: string, suppliedScope?: RequestScope): Promise<void> => {
      const pending = sceneChoiceRef.current;
      if (!pending || pending.expiresAt <= Date.now()) return;
      const choice = pending.choices.find((candidate) => candidate.id === id);
      if (!choice) return;
      let active = activeRequest.current;
      let scope =
        suppliedScope ??
        (active?.requestId === pending.requestId && !active.controller.signal.aborted ? scopeFor(active) : null);
      // A PTT session invalidates the older request lease, but a still-visible, unexpired chooser
      // remains an explicit user action. Give a click a fresh lease; spoken answers already supply
      // the current utterance's scope through routeScene.
      if (!scope && !suppliedScope) {
        active = beginRequest(pending.requestId);
        if (!active) return;
        scope = scopeFor(active);
        dispatch({ type: "submitted", requestId: pending.requestId });
      }
      if (!scope || scope.signal.aborted) return;
      dismissSceneChoice();
      try {
        await choice.execute(scope);
      } catch (error) {
        scope.report({ ok: false, message: toKalCodeError(error).message });
      }
    },
    [beginRequest, dismissSceneChoice, scopeFor],
  );
  useEffect(() => {
    if (!sceneChoice) return;
    const timer = setTimeout(dismissSceneChoice, Math.max(0, sceneChoice.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [sceneChoice, dismissSceneChoice]);

  const routeScene = useCallback(
    async (text: string, requestScope: RequestScope): Promise<boolean> => {
      if (requestScope.signal.aborted) return true;
      const signal = combineAbortSignals([requestScope.signal, sceneLifetime.current.signal]);
      const scope: RequestScope = {
        ...requestScope,
        signal,
        report: (result) => {
          if (!signal.aborted) requestScope.report(result);
        },
      };
      const report = scope.report;
      const spoken = normalizeSpoken(text);
      const callback = lastLifecycle.current;
      const callbackFollowup =
        /^(?:(?:open|show|focus) (?:it|that)|what did (?:it|that|the agent) do|what happened)$/.test(spoken);
      const liveCallback = callback && callback.expiresAt > Date.now() && callbackFollowup ? callback : null;
      if (liveCallback?.targetKind === "operation") {
        const detail = await operationsClient.detail(liveCallback.targetId).catch(() => null);
        if (signal.aborted) return true;
        if (!detail) {
          lastLifecycle.current = null;
          lastOperation.current = null;
          report({ ok: false, message: "That run is no longer available." });
          return true;
        }
        const { run } = detail;
        if (
          run.id !== liveCallback.targetId ||
          (liveCallback.workspaceId && liveCallback.workspaceId !== run.spec.workspaceId)
        ) {
          lastLifecycle.current = null;
          lastOperation.current = null;
          report({ ok: false, message: "That run is no longer available." });
          return true;
        }
        lastOperation.current = {
          target: { kind: "run", tab: "runs", runId: run.id, workspaceId: run.spec.workspaceId, label: run.spec.name },
          expiresAt: Date.now() + 120_000,
        };
        lastSceneTarget.current = null;
        if (/^(?:what did|what happened)/.test(spoken)) {
          report({ ok: true, message: `${run.spec.name}: ${run.status.replaceAll("_", " ")}.` });
          return true;
        }
      }
      const completed = lastCompletedThread.current;
      const recentScene = lastSceneTarget.current;
      const summaryTarget =
        recentScene &&
        recentScene.expiresAt > Date.now() &&
        (recentScene.target.kind === "thread" || recentScene.target.kind === "agent")
          ? recentScene.target.entityId
          : null;
      const completionQuery = /^(?:what|which (?:agent|terminal)) just (?:finished|completed)$/.test(spoken);
      const completionFollowup =
        /^(?:open|show|focus) (?:it|that)$/.test(spoken) &&
        (!summaryTarget || liveCallback?.targetKind === "thread") &&
        !lastOperation.current &&
        statusRef.current.status?.preferences.voiceReplies;
      const recentCompletion = completed && Date.now() - completed.at < 120_000 ? completed.threadId : null;
      const summaryQuery = /^(?:what did (?:it|that|the agent) do|what happened)$/.test(spoken);
      const threadToDescribe =
        liveCallback?.targetKind === "thread"
          ? liveCallback.targetId
          : completionQuery || completionFollowup
            ? recentCompletion
            : summaryQuery
              ? (summaryTarget ?? recentCompletion)
              : null;
      if (threadToDescribe && typeof client.getThread === "function") {
        const thread = await client.getThread(threadToDescribe).catch(() => null);
        if (signal.aborted) return true;
        if (!thread || thread.id !== threadToDescribe || thread.archivedAt) {
          lastLifecycle.current = null;
          lastCompletedThread.current = null;
          lastSceneTarget.current = null;
          report({ ok: false, message: "That agent is no longer available." });
          return true;
        }
        if (/\bagent\b/.test(spoken) && !isCodingAgent(thread)) {
          lastLifecycle.current = null;
          lastCompletedThread.current = null;
          lastSceneTarget.current = null;
          // An unrelated chat callback cannot answer an agent question. The native resolver
          // can still locate a coding session using its durable runtime identity.
          return false;
        }
        if (liveCallback?.workspaceId && thread.workspaceId !== liveCallback.workspaceId) {
          lastLifecycle.current = null;
          lastSceneTarget.current = null;
          report({ ok: false, message: "That agent is no longer available." });
          return true;
        }
        const target: VoiceSceneTarget = {
          kind: isCodingAgent(thread) ? "agent" : "thread",
          codingAgent: isCodingAgent(thread),
          entityId: thread.id,
          title: thread.name,
          workspaceId: thread.workspaceId,
          providerId: thread.providerId,
          status: thread.status,
        };
        lastSceneTarget.current = { target, expiresAt: Date.now() + 120_000 };
        lastOperation.current = null;
        if (completionFollowup) {
          const opened = await scene.focus(target, signal);
          if (!opened) {
            lastLifecycle.current = null;
            lastCompletedThread.current = null;
            lastSceneTarget.current = null;
          }
          if (!signal.aborted)
            report({
              ok: opened,
              message: opened ? `${thread.name} opened.` : "That agent is no longer available.",
            });
        } else {
          const changed = thread.filesChanged === null ? "" : ` ${thread.filesChanged} files changed.`;
          const activity = thread.currentActivity ? ` Last activity: ${thread.currentActivity.slice(0, 180)}.` : "";
          report({
            ok: true,
            message: `${thread.name}${completionQuery ? " finished its task" : ` is ${thread.status.replaceAll("_", " ")}`}.${changed}${activity}`,
          });
        }
        return true;
      }
      const pending = sceneChoiceRef.current;
      if (pending && pending.expiresAt > Date.now()) {
        const answer = normalizeSpoken(text).replace(/^(?:the |number )/, "");
        const ordinal = ["one", "two", "three", "four", "five", "six"].indexOf(answer);
        const matches = pending.choices.filter(
          (choice, index) =>
            normalizeSpoken(choice.label) === answer ||
            normalizeSpoken(choice.label.split(/\s+[—–]\s+/)[0] ?? "") === answer ||
            String(index + 1) === answer ||
            ordinal === index,
        );
        const matched = matches.length === 1 ? matches[0] : undefined;
        if (matched) {
          await chooseScene(matched.id, scope);
          return true;
        }
        dismissSceneChoice();
      }
      const deps = {
        client: operationsClient,
        navigate: () => navigate("operations"),
        focus: (target: OperationsVoiceTarget) => focusOperationsTarget(target, { signal }),
        signal,
      };
      const show = (result: OperationsVoiceResult, resultScope: RequestScope = scope) => {
        if (!result.handled || resultScope.signal.aborted) return;
        if (result.target) {
          lastLifecycle.current = null;
          lastOperation.current = { target: result.target, expiresAt: Date.now() + 120_000 };
          lastSceneTarget.current = null;
        }
        resultScope.report({ ok: result.status !== "failed", message: result.message });
        if (result.choices?.length) {
          setSessionChoice(null);
          setSceneChoice({
            question: result.message,
            requestId: resultScope.requestId,
            expiresAt: Date.now() + CHOICE_TTL_MS,
            choices: result.choices.map((choice) => ({
              id: choice.id,
              label: choice.label,
              execute: async (choiceScope) => {
                const choiceDeps = { ...deps, signal: choiceScope.signal };
                show(await executeOperationsVoiceChoice(choice, choiceDeps), choiceScope);
              },
            })),
          });
        }
      };
      const previous = lastOperation.current;
      const result = await handleOperationsVoice(
        text,
        deps,
        previous && previous.expiresAt > Date.now() ? previous.target : null,
      );
      show(result);
      if (result.handled || signal.aborted) return true;
      const reference = sceneReference(text);
      if (!reference) return false;
      const recent = lastSceneTarget.current;
      const resolution = await scene.resolve(reference, {
        lastTarget: recent && recent.expiresAt > Date.now() ? recent.target : null,
      });
      if (signal.aborted) return true;
      const focusTarget = async (target: VoiceSceneTarget, focusScope: RequestScope = scope) => {
        if (focusScope.signal.aborted) return;
        lastLifecycle.current = null;
        const focused = await scene.focus(target, focusScope.signal);
        if (focusScope.signal.aborted) return;
        if (focused) {
          lastSceneTarget.current = { target, expiresAt: Date.now() + 120_000 };
          lastOperation.current = null;
        } else {
          lastSceneTarget.current = null;
          lastOperation.current = null;
        }
        focusScope.report({
          ok: focused,
          message: focused
            ? `${target.title} opened.`
            : `I couldn't open ${target.title}; it may no longer be available.`,
        });
      };
      // A coding agent goes back to idle when its turn completes, so "the agent that just
      // finished" comes from completion events first; finished statuses are the fallback.
      if (reference.kind === "latest_completed" && typeof client.getThread === "function") {
        for (const threadId of recentCompletions.current) {
          const thread = await client.getThread(threadId).catch(() => null);
          if (signal.aborted) return true;
          if (!thread || thread.id !== threadId || thread.archivedAt) continue;
          if (reference.agents && !isCodingAgent(thread)) continue;
          await focusTarget({
            kind: isCodingAgent(thread) ? "agent" : "thread",
            codingAgent: isCodingAgent(thread),
            entityId: thread.id,
            title: thread.name,
            workspaceId: thread.workspaceId,
            providerId: thread.providerId,
            status: thread.status,
          });
          return true;
        }
      }
      if (resolution.kind === "resolved") {
        await focusTarget(resolution.target);
        return true;
      }
      if (resolution.kind === "ambiguous") {
        setSessionChoice(null);
        setSceneChoice({
          question: "Which one?",
          requestId: scope.requestId,
          expiresAt: Date.now() + CHOICE_TTL_MS,
          choices: resolution.choices.map((target) => ({
            id: `${target.kind}:${target.entityId}`,
            label: sceneChoiceLabel(target),
            execute: (choiceScope) => focusTarget(target, choiceScope),
          })),
        });
        scope.report({ ok: true, message: `I found ${resolution.choices.length} matches. Which one?` });
        return true;
      }
      return false;
    },
    [client, operationsClient, navigate, chooseScene, dismissSceneChoice, scene],
  );
  /** Follows up on the session the person picked (a click or its spoken name). */
  const followUp = useCallback(
    async (threadId: string, suppliedScope?: RequestScope): Promise<boolean> => {
      const pending = choiceRef.current;
      if (!choiceIsLive(pending)) return false;
      const choice = pending.choices.find((candidate) => candidate.threadId === threadId);
      if (!choice) return false;
      let selectedScope = suppliedScope;
      if (!selectedScope) {
        const requestId = crypto.randomUUID();
        const lease = beginRequest(requestId);
        if (!lease) return false;
        selectedScope = scopeFor(lease) ?? undefined;
        if (!selectedScope) return false;
        dispatch({ type: "submitted", requestId });
      }
      const scope = selectedScope;
      choiceRef.current = null;
      setSessionChoice(null);
      try {
        if (pending.followUp.kind === "compose") {
          runDirective(
            {
              kind: "compose_in_thread",
              threadId: choice.threadId,
              text: pending.followUp.text,
              submit: pending.followUp.submit,
            },
            scope,
          );
          return true;
        }
        await followUpChoice(
          {
            ...composerDeps(scope),
            focusThread: async (id) => {
              if (scope.signal.aborted) return;
              const thread = await client.getThread(id);
              if (scope.signal.aborted) return;
              await surfaces.current.uiIntents.focus(
                isCodingAgent(thread)
                  ? { kind: "agent", agentId: id, workspaceId: thread.workspaceId }
                  : { kind: "thread", threadId: id },
              );
            },
          },
          choice,
          pending.followUp,
        );
      } catch (error) {
        scope.report({ ok: false, message: toKalCodeError(error).message });
      }
      return true;
    },
    [beginRequest, composerDeps, scopeFor, client, runDirective],
  );
  const chooseSession = useCallback(
    (threadId: string) => {
      void followUp(threadId);
    },
    [followUp],
  );

  const submit = useCallback(
    async (text: string, input: KalVoiceInput = "text", workspaceIdOverride?: string, displayText?: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const requestId = crypto.randomUUID();
      const lease = beginRequest(requestId);
      if (!lease) return;
      const scope = scopeFor(lease);
      if (!scope) return;
      setHistory((items) =>
        [{ requestId, text: displayText ?? trimmed, input, response: null, localResult: null }, ...items].slice(0, 20),
      );
      dispatch({ type: "submitted", requestId });
      try {
        const tidy = parseKalTidyCommand(trimmed);
        if (tidy) {
          nativeRequestInFlight.current = lease;
          try {
            await runKalTidyCommand(surfaces.current.kalTidy, tidy, scope.report);
          } finally {
            if (nativeRequestInFlight.current === lease) nativeRequestInFlight.current = null;
          }
          return;
        }
        if (await routeScene(trimmed, scope)) return;
        if (scope.signal.aborted || activeRequest.current !== lease) return;
        nativeRequestInFlight.current = lease;
        let response: Awaited<ReturnType<typeof client.kalvoiceRequest>>;
        try {
          response = await client.kalvoiceRequest({
            requestId,
            text: trimmed,
            input,
            workspaceId: workspaceIdOverride ?? workspaces.active?.id ?? null,
            threadId:
              lastSceneTarget.current &&
              lastSceneTarget.current.expiresAt > Date.now() &&
              (lastSceneTarget.current.target.kind === "thread" || lastSceneTarget.current.target.kind === "agent")
                ? lastSceneTarget.current.target.entityId
                : (getSelectedThread()?.threadId ?? null),
          });
        } finally {
          if (nativeRequestInFlight.current === lease) nativeRequestInFlight.current = null;
        }
        if (scope.signal.aborted || activeRequest.current !== lease) return;
        applyResponse(response, null, scope);
      } catch (error) {
        if (scope.signal.aborted || activeRequest.current !== lease) return;
        const e = toKalCodeError(error);
        dispatch({ type: "request_error", requestId, message: e.message, code: e.code });
        setHistory((items) =>
          items.map((item) =>
            item.requestId === requestId && item.response === null
              ? { ...item, localResult: { ok: false, message: e.message } }
              : item,
          ),
        );
      }
    },
    [client, applyResponse, beginRequest, scopeFor, workspaces.active?.id, routeScene],
  );
  launchRetry.current = (text, workspaceId, label) => submit(text, "text", workspaceId, label);

  /** One utterance: native routing decides command, dictation or request. */
  const talk = useCallback(
    async (session: DictationSession<DictationTarget>, text: string, durationMs: number) => {
      const started = performance.now();
      const { sessionId, target, signal: sessionSignal } = session;
      const requestId = crypto.randomUUID();
      const lease = beginRequest(requestId);
      if (!lease) {
        dictationSessions.current.finish(sessionId);
        return;
      }
      const scope = scopeFor(lease, sessionSignal);
      if (!scope) return;
      const { signal } = scope;
      dispatch({ type: "submitted", requestId });
      const recordAction = () =>
        afterPaint(() => void client.kalvoiceLatencyRecord(performance.now() - started).catch(() => undefined));
      try {
        // Explicit insertion has precedence over every navigation/action grammar. The remainder
        // is the user's literal draft; even command-shaped words must never execute here.
        const literal = /^\s*type\s+([\s\S]+)$/i.exec(text)?.[1];
        if (literal !== undefined) {
          if (!target || !targetIsAlive(target)) {
            scope.report({ ok: false, message: "Focus a text box or terminal before dictating." });
          } else {
            const characters = await insertTranscript(target, literal, { signal, mode: "insert" });
            if (!signal.aborted) dispatch({ type: "dictation_inserted", characters });
          }
          recordAction();
          return;
        }
        // An answer to "Which one?" is handled here: native keeps no conversation state. Only a
        // short answer or a choice form counts; anything else is a new request and drops the question.
        const pending = choiceRef.current;
        if (choiceIsLive(pending)) {
          const answer = isChoiceAnswer(text);
          const picked = answer ? pickSpokenChoice(text, pending.choices) : null;
          if (picked && (await followUp(picked.threadId, scope))) {
            recordAction();
            return;
          }
          if (!answer) {
            choiceRef.current = null;
            setSessionChoice(null);
          }
        }
        const tidy = parseKalTidyCommand(text);
        if (tidy) {
          if (signal.aborted || activeRequest.current !== lease) return;
          nativeRequestInFlight.current = lease;
          try {
            await runKalTidyCommand(surfaces.current.kalTidy, tidy, scope.report);
          } finally {
            if (nativeRequestInFlight.current === lease) nativeRequestInFlight.current = null;
          }
          recordAction();
          return;
        }
        if (await routeScene(text, scope)) {
          recordAction();
          return;
        }
        if (signal.aborted || activeRequest.current !== lease) return;
        const previous = currentRef.current;
        nativeRequestInFlight.current = lease;
        let talked: Awaited<ReturnType<typeof client.kalvoiceTalk>>;
        try {
          talked = await client.kalvoiceTalk({
            requestId,
            sessionId,
            text,
            target: targetKind(target),
            durationMs,
            workspaceId: workspaces.active?.id ?? null,
            // The captured composer's thread wins over whatever Threads shows by now.
            threadId:
              target?.kind === "composer"
                ? target.composer.handle.threadId
                : target?.kind === "sink" && target.sink.destination.kind === "provider_pane"
                  ? target.sink.destination.threadId
                  : lastSceneTarget.current &&
                      lastSceneTarget.current.expiresAt > Date.now() &&
                      (lastSceneTarget.current.target.kind === "thread" ||
                        lastSceneTarget.current.target.kind === "agent")
                    ? lastSceneTarget.current.target.entityId
                    : (getSelectedThread()?.threadId ?? null),
          });
        } finally {
          if (nativeRequestInFlight.current === lease) nativeRequestInFlight.current = null;
        }
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
        setHistory((items) =>
          [{ requestId, text, input: "voice" as const, response, localResult: null }, ...items].slice(0, 20),
        );
        undo.current = { requestId, target, previous: response.directive?.kind === "navigate" ? previous : null };
        dispatch({
          type: "talked",
          talk: { requestId, text, route: talked.route, hadTarget: target !== null },
        });
        applyResponse(response, { target }, scope);
        recordAction();
      } catch (error) {
        if (signal.aborted) return;
        const e = toKalCodeError(error);
        dispatch({ type: "request_error", requestId, message: e.message, code: e.code });
      } finally {
        dictationSessions.current.finish(sessionId);
      }
    },
    [client, applyResponse, beginRequest, followUp, scopeFor, workspaces.active?.id, routeScene],
  );

  const onSignal = useCallback(
    (signal: KalVoiceSignal) => {
      if ("sessionId" in signal && signal.sessionId && abandonedStartIds.current.has(signal.sessionId)) return;
      switch (signal.kind) {
        case "lifecycle_callback":
          lastLifecycle.current = {
            targetKind: signal.targetKind,
            targetId: signal.targetId,
            ...(signal.workspaceId ? { workspaceId: signal.workspaceId } : {}),
            expiresAt: Date.now() + 120_000,
          };
          lastSceneTarget.current = null;
          lastOperation.current = null;
          return;
        case "level":
          levelRef.current = signal.level;
          return;
        case "listening_started":
          {
            const pending = pendingStart.current;
            if (pending?.abandoned) {
              // Native IPC tasks can overtake each other. Wait for this abandoned request's
              // identity before accepting a signal, so Escape never flashes late Listening.
              void pending.promise.then((id) => {
                if (pendingStart.current === pending) pendingStart.current = null;
                if (signal.sessionId !== id) onSignalRef.current(signal);
              });
              return;
            }
          }
          levelRef.current = 0;
          if (!beginRequest(null)) {
            dictationSessions.current.abandonPendingCapture();
            setDictationTarget(null);
            void client.kalvoiceListenCancel(signal.sessionId).catch(() => undefined);
            return;
          }
          {
            const session = dictationSessions.current.open(signal.sessionId);
            setDictationTarget(session ? targetView(session.sessionId, session.target) : null);
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
          if (nativeRequestInFlight.current) return;
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
        case "provisioning":
          provisioningRef.current = signal.items;
          setStatus((current) => withProvisioning(current, signal.items));
          return;
        case "local_reasoning_status": {
          const update: LocalReasoningState = {
            status: signal.status,
            ...(signal.issue === undefined ? {} : { issue: signal.issue }),
          };
          reasoningRef.current = update;
          setStatus((current) => withReasoningState(current, update));
          return;
        }
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
    [client, talk, applyResponse, beginRequest, refreshStatus, toast, status],
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
    if (!abortActiveRequest(true)) return;
    if (now.sessionId) dictationSessions.current.cancel(now.sessionId);
    if (now.sessionId) {
      setDictationTarget((current) => (current?.sessionId === now.sessionId ? null : current));
    }
    try {
      await client.kalvoiceListenCancel(now.sessionId ?? undefined);
    } catch {
      // Nothing was listening.
    }
    if (activeSession && now.sessionId) {
      dispatch({
        type: "signal",
        signal: { kind: "cancelled", sessionId: now.sessionId, mode: now.mode ?? "talk" },
      });
    }
  }, [client, abortActiveRequest]);

  // Escape stops listening (and discards the recording) from anywhere.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const now = stateRef.current;
      const routing = now.sessionId !== null && dictationSessions.current.has(now.sessionId);
      if (now.phase === "listening" || now.phase === "transcribing" || routing) {
        event.preventDefault();
        void cancel();
        return;
      }
      const pending = pendingStart.current;
      if (pending) {
        pending.abandoned = true;
        if (pending.sessionId) {
          dictationSessions.current.cancel(pending.sessionId);
          setDictationTarget((current) => (current?.sessionId === pending.sessionId ? null : current));
        } else {
          dictationSessions.current.abandonCapture(pending.capture);
        }
      }
      // Native can still be opening the microphone while renderer state truthfully remains Ready.
      // This is a no-op when idle and intentionally leaves dialog Escape and typed requests alone;
      // a spoken reply keeps playing unless a pending start or session was actually cancelled.
      void client.kalvoiceListenCancel(undefined, { keepSpeech: true }).catch(() => undefined);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [cancel, client]);

  const startListening = useCallback(async () => {
    if (pendingStart.current?.abandoned && pendingStart.current.sessionId === null) return;
    if (nativeRequestInFlight.current) {
      reportNativeRequestBusy();
      return;
    }
    const capture = dictationSessions.current.captureFocusedTarget();
    const started = client.kalvoiceListenStart("talk");
    // A release can arrive before the microphone opens (a quick tap); stopListening waits for it.
    const pending = {
      promise: started.catch(() => null),
      capture,
      abandoned: false,
      sessionId: null as string | null,
    };
    pendingStart.current = pending;
    try {
      const sessionId = await started;
      pending.sessionId = sessionId;
      if (pending.abandoned) {
        abandonedStartIds.current.add(sessionId);
        // Bound stale IPC delivery fencing independently of the number of takes in this window.
        if (abandonedStartIds.current.size > 128) {
          const oldest = abandonedStartIds.current.values().next().value;
          if (oldest) abandonedStartIds.current.delete(oldest);
        }
        await client.kalvoiceListenCancel(sessionId);
        if (pendingStart.current === pending) pendingStart.current = null;
        return;
      }
      const session = dictationSessions.current.open(sessionId, capture);
      setDictationTarget(session ? targetView(session.sessionId, session.target) : null);
    } catch {
      if (pendingStart.current === pending) pendingStart.current = null;
      dictationSessions.current.abandonCapture(capture);
      setDictationTarget(null);
      // The native side reports why as a `listening_failed` signal.
    }
  }, [client, reportNativeRequestBusy]);

  const stopListening = useCallback(async () => {
    if (nativeRequestInFlight.current) return;
    const pending = pendingStart.current;
    if (pending?.abandoned) return;
    pendingStart.current = null;
    const id = stateRef.current.sessionId ?? (pending ? await pending.promise : null);
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
    let target = reconnectTarget(saved.target);
    if (!target && saved.target.kind === "composer") {
      // The words belong to that thread's message box only: open that thread (never whichever
      // thread is on screen now) and wait for its composer.
      const threadId = saved.target.composer.handle.threadId;
      composerDeps().openThread(threadId);
      if (await waitForComposer(threadId)) target = reconnectTarget(saved.target);
    }
    if (!target) {
      dispatch({ type: "dictation_blocked", message: dictationFailure(saved.target) });
      return;
    }
    if (target.element instanceof HTMLElement) target.element.focus();
    try {
      await insertTranscript(target, last.text, { mode: "insert" });
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
  }, [client, navigate, refreshStatus, composerDeps]);

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

  const setIntelligencePaused = useCallback(
    async (paused: boolean) => {
      try {
        await updatePreferences({ localIntelligencePaused: paused });
      } catch (error) {
        toast.show({
          tone: "danger",
          title: paused ? "Couldn't pause" : "Couldn't resume",
          description: toKalCodeError(error).message,
        });
      }
    },
    [updatePreferences, toast],
  );

  const openMicrophoneSettings = useCallback(async () => {
    try {
      await client.kalvoiceOpenMicrophoneSettings();
    } catch (error) {
      toast.show({
        tone: "danger",
        title: "Couldn't open privacy settings",
        description: toKalCodeError(error).message,
      });
    }
  }, [client, toast]);

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
      setIntelligencePaused,
      openMicrophoneSettings,
      history,
      sizeClass,
      panel,
      setPanel,
      setPanelVisible,
      sessionChoice,
      chooseSession,
      dismissSessionChoice,
      sceneChoice,
      chooseScene,
      dismissSceneChoice,
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
      setIntelligencePaused,
      openMicrophoneSettings,
      history,
      sizeClass,
      panel,
      setPanel,
      setPanelVisible,
      sessionChoice,
      chooseSession,
      dismissSessionChoice,
      sceneChoice,
      chooseScene,
      dismissSceneChoice,
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
