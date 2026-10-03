import type { LocatorEntityKind, TerminalInfo, ThreadSummary, Workspace } from "@kalcode/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRuntime } from "../runtime/RuntimeProvider.tsx";
import { useUiIntents } from "../runtime/uiIntents.tsx";
import { useWorkspaces } from "../runtime/WorkspaceProvider.tsx";
import { useNavigation } from "../shell/navigation.tsx";
import { useOpenLocated } from "../shell/rail/search/useOpenLocated.ts";
import { isCodingAgent } from "../surfaces/dashboard/data/agents.ts";
import { getSelectedThread } from "../surfaces/threads/accountIntent.ts";
import {
  resolveVoiceSceneTarget,
  sceneTargetFromLocator,
  type VoiceSceneContext,
  type VoiceSceneReference,
  type VoiceSceneResolution,
  type VoiceSceneTarget,
} from "./sceneTargets.ts";

/** Metadata and actions published by the Code canvas while it is actually onscreen. */
export interface VoicePaneSceneRegistration {
  workspaceId: string;
  snapshot: () => readonly VoiceSceneTarget[];
  focus: (target: VoiceSceneTarget) => boolean;
}

let paneScene: VoicePaneSceneRegistration | null = null;

/**
 * Publishes the one live Code canvas. Cleanup is identity-safe, so an older unmount cannot erase
 * a newer workspace canvas registered during a switch.
 */
export function registerVoicePaneScene(registration: VoicePaneSceneRegistration): () => void {
  paneScene = registration;
  return () => {
    if (paneScene === registration) paneScene = null;
  };
}

export function voicePaneSceneSnapshot(): readonly VoiceSceneTarget[] {
  return paneScene?.snapshot() ?? [];
}

export function focusVoicePaneSceneTarget(target: VoiceSceneTarget): boolean {
  return Boolean(
    paneScene && (!target.workspaceId || target.workspaceId === paneScene.workspaceId) && paneScene.focus(target),
  );
}

/** Restarts the existing CSS focus trace when voice locates a pane that is already focused. */
export function replayVoiceFocusTrace(element: HTMLElement): boolean {
  const focused = element.getAttribute("data-focused");
  if (focused === null) return false;
  element.removeAttribute("data-focused");
  // Reading layout makes removal observable before restoring the attribute and its animation.
  void element.offsetWidth;
  element.setAttribute("data-focused", focused);
  return true;
}

function keyOf(target: Pick<VoiceSceneTarget, "kind" | "entityId">): string {
  return `${target.kind}:${target.entityId}`;
}

function compactAliases(values: readonly (string | null | undefined)[]): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

export function voiceTerminalStatus(terminal: TerminalInfo): string {
  return terminal.status === "exited" && terminal.exitCode !== null && terminal.exitCode !== 0
    ? "failed"
    : terminal.status;
}

/** Compatible while the generated TypeScript protocol catches up with the Rust contract. */
export function voiceThreadEffort(thread: ThreadSummary): string | null {
  const effort = (thread as ThreadSummary & { effort?: unknown }).effort;
  return typeof effort === "string" && effort.trim() ? effort : null;
}

export interface VoiceSceneThreadClient {
  listThreads: (input: { includeArchived: boolean }) => Promise<ThreadSummary[]>;
}

export interface VoiceSceneEventFeed {
  getSnapshot: () => { events: readonly { seq: number; type: string }[] };
  subscribe: (listener: () => void) => (() => void) | undefined;
}

interface ThreadOwner {
  client: VoiceSceneThreadClient;
  active: boolean;
  generation: number;
}

interface ThreadState {
  owner: ThreadOwner;
  threads: ThreadSummary[];
  loaded: boolean;
}

/**
 * Account/client-bound thread state. A new client is masked synchronously during render, and a
 * failed refresh clears the previous snapshot so provider identities can never bleed across owners.
 */
export function useVoiceSceneThreads(
  client: VoiceSceneThreadClient,
  feed: VoiceSceneEventFeed | null | undefined,
): { threads: ThreadSummary[]; loaded: boolean; refresh: () => Promise<void> } {
  const ownerRef = useRef<ThreadOwner | null>(null);
  if (ownerRef.current?.client !== client) ownerRef.current = { client, active: false, generation: 0 };
  const owner = ownerRef.current;
  const currentOwner = useRef(owner);
  currentOwner.current = owner;
  const [state, setState] = useState<ThreadState>({ owner, threads: [], loaded: false });

  const refresh = useCallback(async () => {
    const request = ++owner.generation;
    try {
      const threads = await owner.client.listThreads({ includeArchived: false });
      if (owner.active && currentOwner.current === owner && request === owner.generation) {
        setState({ owner, threads, loaded: true });
      }
    } catch {
      if (owner.active && currentOwner.current === owner && request === owner.generation) {
        setState({ owner, threads: [], loaded: true });
      }
    }
  }, [owner]);

  useEffect(() => {
    owner.active = true;
    setState({ owner, threads: [], loaded: false });
    void refresh();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let watermark = Math.max(0, ...(feed?.getSnapshot().events.map((event) => event.seq) ?? []));
    const stop = feed?.subscribe(() => {
      const fresh = feed.getSnapshot().events.filter((event) => event.seq > watermark);
      if (fresh.length === 0) return;
      watermark = Math.max(watermark, ...fresh.map((event) => event.seq));
      if (
        !fresh.some(
          ({ type }) => type.startsWith("thread.") || type.startsWith("shell.") || type.startsWith("workspace."),
        )
      )
        return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void refresh();
      }, 80);
    });
    return () => {
      owner.active = false;
      owner.generation += 1;
      if (timer) clearTimeout(timer);
      stop?.();
    };
  }, [feed, owner, refresh]);

  return state.owner === owner
    ? { threads: state.threads, loaded: state.loaded, refresh }
    : { threads: [], loaded: false, refresh };
}

export interface VoiceSceneSources {
  workspaces: readonly Workspace[];
  terminals: readonly TerminalInfo[];
  threads: readonly ThreadSummary[];
}

/** Builds privacy-bounded targets from canonical shell state; it never includes prompt or terminal text. */
export function createBaseVoiceSceneTargets({ workspaces, terminals, threads }: VoiceSceneSources): VoiceSceneTarget[] {
  const workspaceNames = new Map(workspaces.map((workspace) => [workspace.id, workspace.name]));
  const targets: VoiceSceneTarget[] = workspaces.map((workspace) => ({
    kind: "workspace",
    entityId: workspace.id,
    title: workspace.name,
    aliases: compactAliases([`${workspace.name} workspace`, `${workspace.name} project`]),
    status: workspace.available ? "available" : "missing",
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    updatedAt: workspace.lastOpenedAt,
  }));

  for (const terminal of terminals) {
    const ordinal = terminal.position + 1;
    const workspaceName = workspaceNames.get(terminal.workspaceId);
    targets.push({
      kind: "terminal",
      entityId: terminal.id,
      title: terminal.title,
      aliases: compactAliases([
        `${terminal.title} terminal`,
        `Terminal ${ordinal}`,
        `${terminal.title} ${ordinal}`,
        workspaceName ? `${workspaceName} terminal ${ordinal}` : null,
      ]),
      status: voiceTerminalStatus(terminal),
      workspaceId: terminal.workspaceId,
      workspaceName,
      updatedAt: terminal.endedAt ?? terminal.startedAt,
    });
  }

  for (const thread of threads) {
    const effort = voiceThreadEffort(thread);
    const codingAgent = isCodingAgent(thread);
    targets.push({
      kind: codingAgent ? "agent" : "thread",
      entityId: thread.id,
      title: thread.name,
      aliases: compactAliases([
        thread.providerName,
        `${thread.providerName} ${codingAgent ? "agent" : "thread"}`,
        thread.accountLabel,
        thread.accountLabel ? `${thread.providerName} ${thread.accountLabel}` : null,
        thread.workspaceName,
        `${thread.workspaceName} workspace`,
        thread.model,
        effort,
        thread.branch,
      ]),
      // currentActivity is a short structured runtime fact, never model prose or a prompt.
      subtitle: thread.currentActivity,
      status: thread.status,
      workspaceId: thread.workspaceId,
      workspaceName: thread.workspaceName,
      providerId: thread.providerId,
      providerName: thread.providerName,
      providerAccountId: thread.providerAccountId,
      accountLabel: thread.accountLabel,
      model: thread.model,
      effort,
      branch: thread.branch,
      codingAgent,
      updatedAt: thread.lastActivityAt,
    });
  }
  return targets;
}

/** Pane metadata wins for visibility/focus/geometry while runtime metadata supplies activity. */
export function mergeVoiceSceneTargets(
  base: readonly VoiceSceneTarget[],
  panes: readonly VoiceSceneTarget[],
): VoiceSceneTarget[] {
  const merged = new Map(base.map((target) => [keyOf(target), target]));
  for (const pane of panes) {
    const previous = merged.get(keyOf(pane));
    merged.set(
      keyOf(pane),
      previous
        ? {
            ...previous,
            ...pane,
            aliases: compactAliases([...(previous.aliases ?? []), ...(pane.aliases ?? [])]),
            subtitle: pane.subtitle ?? previous.subtitle,
            status: pane.status ?? previous.status,
            updatedAt: pane.updatedAt ?? previous.updatedAt,
          }
        : pane,
    );
  }
  return [...merged.values()];
}

const LOCATOR_KINDS = new Set<LocatorEntityKind>([
  "thread",
  "workspace",
  "remote_workspace",
  "terminal",
  "provider",
  "agent",
  "mission",
  "task",
  "worktree",
  "automation",
  "file",
  "command",
  "activity",
]);

function locatorKind(kind: VoiceSceneTarget["kind"]): kind is LocatorEntityKind {
  return LOCATOR_KINDS.has(kind as LocatorEntityKind);
}

export interface VoiceSceneResolveOptions extends Pick<VoiceSceneContext, "lastTarget" | "kinds" | "workspaceId"> {}

export interface VoiceScene {
  /** Takes a fresh snapshot, including current pane focus and DOM geometry. */
  snapshot: () => VoiceSceneTarget[];
  resolve: (reference: VoiceSceneReference, options?: VoiceSceneResolveOptions) => Promise<VoiceSceneResolution>;
  /** Uses the current canvas first, then the canonical stale-safe Session Locator open path. */
  focus: (target: VoiceSceneTarget, signal?: AbortSignal) => Promise<boolean>;
  refresh: () => Promise<void>;
  loaded: boolean;
}

export interface KnownVoiceSceneFocusActions {
  workspaces: readonly Workspace[];
  activeWorkspaceId: string | null;
  terminals: readonly TerminalInfo[];
  listTerminals: (workspaceId: string) => Promise<readonly TerminalInfo[]>;
  getThread: (threadId: string) => Promise<ThreadSummary>;
  activateWorkspace: (workspaceId: string) => Promise<boolean>;
  selectTerminal: (terminalId: string, focus: boolean, workspaceId: string) => void;
  focusIntent: (
    target:
      | { kind: "thread"; threadId: string; workspaceId: string }
      | { kind: "agent"; agentId: string; workspaceId: string }
      | { kind: "workspace"; workspaceId: string }
      | { kind: "provider"; providerId: string }
      | { kind: "dashboard" },
  ) => Promise<void>;
  navigateToCode: () => void;
}

/** Returns null only when the target belongs to a different scene owner (for example a file). */
export async function focusKnownVoiceSceneTarget(
  target: VoiceSceneTarget,
  actions: KnownVoiceSceneFocusActions,
  signal?: AbortSignal,
): Promise<boolean | null> {
  if (signal?.aborted) return false;
  if (target.kind === "terminal") {
    const expected = actions.terminals.find((candidate) => candidate.id === target.entityId);
    const workspaceId = target.workspaceId ?? expected?.workspaceId;
    if (!workspaceId) return false;
    const current = async () =>
      (await actions.listTerminals(workspaceId)).find(
        (candidate) => candidate.id === target.entityId && candidate.workspaceId === workspaceId,
      );
    try {
      if (!(await current()) || signal?.aborted) return false;
      if (actions.activeWorkspaceId !== workspaceId) {
        if (signal?.aborted || !(await actions.activateWorkspace(workspaceId)) || signal?.aborted) return false;
      }
      // Activation and terminal closure are independent native writes. Re-read after a switch so
      // a tab closed during activation cannot become a successful focus result.
      if (actions.activeWorkspaceId !== workspaceId && (!(await current()) || signal?.aborted)) return false;
    } catch {
      return false;
    }
    if (signal?.aborted) return false;
    actions.navigateToCode();
    if (signal?.aborted) return false;
    actions.selectTerminal(target.entityId, true, workspaceId);
    return true;
  }
  if (target.kind === "thread" || target.kind === "agent") {
    try {
      const thread = await actions.getThread(target.entityId);
      if (signal?.aborted || thread.archivedAt !== null) return false;
      if ((target.kind === "agent" || target.codingAgent) && !isCodingAgent(thread)) return false;
      await actions.focusIntent(
        isCodingAgent(thread)
          ? { kind: "agent", agentId: thread.id, workspaceId: thread.workspaceId }
          : { kind: "thread", threadId: thread.id, workspaceId: thread.workspaceId },
      );
      return !signal?.aborted;
    } catch {
      return false;
    }
  }
  if (target.kind === "workspace") {
    if (!actions.workspaces.some((workspace) => workspace.id === target.entityId && workspace.available)) return false;
    if (signal?.aborted) return false;
    await actions.focusIntent({ kind: "workspace", workspaceId: target.entityId });
    return !signal?.aborted;
  }
  if (target.kind === "provider" && target.providerId) {
    if (signal?.aborted) return false;
    await actions.focusIntent({ kind: "provider", providerId: target.providerId });
    return !signal?.aborted;
  }
  if (target.kind === "dashboard") {
    if (signal?.aborted) return false;
    await actions.focusIntent({ kind: "dashboard" });
    return !signal?.aborted;
  }
  return null;
}

/**
 * KalVoice's read-through scene. Canonical providers remain WorkspaceProvider, thread_list, the
 * live Code canvas and Session Locator; this hook adds no durable state or second index.
 */
export function useVoiceScene(): VoiceScene {
  const runtime = useRuntime();
  const { client } = runtime;
  const workspaces = useWorkspaces();
  const intents = useUiIntents();
  const navigation = useNavigation();
  const openLocated = useOpenLocated();
  const { threads, loaded, refresh } = useVoiceSceneThreads(client, runtime.feed);

  const terminalList = useMemo(() => {
    const byId = new Map<string, TerminalInfo>();
    for (const terminal of workspaces.running ?? []) byId.set(terminal.id, terminal);
    for (const terminal of workspaces.terminals ?? []) byId.set(terminal.id, terminal);
    return [...byId.values()];
  }, [workspaces.running, workspaces.terminals]);

  const base = useMemo(
    () =>
      createBaseVoiceSceneTargets({
        workspaces: workspaces.workspaces ?? [],
        terminals: terminalList,
        threads,
      }),
    [workspaces.workspaces, terminalList, threads],
  );

  const snapshot = useCallback(() => {
    const targets = mergeVoiceSceneTargets(base, voicePaneSceneSnapshot());
    const selected = navigation.current === "threads" ? getSelectedThread()?.threadId : null;
    return selected
      ? targets.map((target) =>
          target.kind === "thread" && target.entityId === selected
            ? { ...target, focused: true, visible: true }
            : target,
        )
      : targets;
  }, [base, navigation.current]);

  const resolve = useCallback(
    async (reference: VoiceSceneReference, options: VoiceSceneResolveOptions = {}): Promise<VoiceSceneResolution> => {
      const context: VoiceSceneContext = { targets: snapshot(), ...options };
      const local = resolveVoiceSceneTarget(reference, context);
      if (
        local.kind !== "not_found" ||
        reference.kind !== "named" ||
        /\bagents?\b/i.test(reference.query) ||
        typeof client.locatorSearch !== "function"
      ) {
        return local;
      }
      try {
        const referenceKinds = "kinds" in reference ? reference.kinds : undefined;
        const kinds = (referenceKinds ?? options.kinds ?? []).filter(locatorKind);
        const response = await client.locatorSearch({
          text: reference.query,
          kinds,
          workspaceId: options.workspaceId ?? null,
          page: { limit: 6, cursor: null },
        });
        const choices = response.results.items.map(sceneTargetFromLocator);
        if (choices.length === 1) return { kind: "resolved", target: choices[0] as VoiceSceneTarget };
        return choices.length > 1 ? { kind: "ambiguous", choices } : { kind: "not_found" };
      } catch {
        return { kind: "not_found" };
      }
    },
    [client, snapshot],
  );

  const focus = useCallback(
    async (target: VoiceSceneTarget, signal?: AbortSignal): Promise<boolean> => {
      if (signal?.aborted) return false;
      if (focusVoicePaneSceneTarget(target)) {
        if (signal?.aborted) return false;
        navigation.navigate("code");
        return true;
      }
      const known = await focusKnownVoiceSceneTarget(
        target,
        {
          workspaces: workspaces.workspaces ?? [],
          activeWorkspaceId: workspaces.active?.id ?? null,
          terminals: terminalList,
          listTerminals: (workspaceId) => client.listTerminals(workspaceId),
          getThread: (threadId) => client.getThread(threadId),
          activateWorkspace: (workspaceId) => workspaces.activate(workspaceId),
          selectTerminal: (terminalId, moveFocus, workspaceId) =>
            workspaces.selectTerminal(terminalId, moveFocus, workspaceId),
          focusIntent: intents.focus,
          navigateToCode: () => navigation.navigate("code"),
        },
        signal,
      );
      if (known !== null) return known;
      if (signal?.aborted) return false;
      if (locatorKind(target.kind)) {
        const opened = await openLocated(target.kind, target.entityId, "voice");
        return !signal?.aborted && opened;
      }
      return false;
    },
    [client, intents, navigation, openLocated, terminalList, workspaces],
  );

  return useMemo(() => ({ snapshot, resolve, focus, refresh, loaded }), [snapshot, resolve, focus, refresh, loaded]);
}
