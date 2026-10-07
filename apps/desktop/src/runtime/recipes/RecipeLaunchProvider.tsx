import type {
  LaunchRecipe,
  LaunchRecipesSnapshot,
  PaneContent,
  ProviderAccount,
  ProviderAccountBinding,
  ProviderStatus,
  Workspace,
} from "@kalcode/protocol";
import { useToast } from "@kalcode/ui/components";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { toKalCodeError } from "../../ipc/errors.ts";
import { OperationsClient } from "../../ipc/operations.ts";
import { frameProviderPrompt } from "../../kalvoice/dictation.ts";
import { focusOperationsTarget } from "../../kalvoice/sceneOperations.ts";
import { useNavigation } from "../../shell/navigation.tsx";
import type { BuiltinPreset } from "../../shell/panes/model.ts";
import { activateAndDispatchPaneCommand, type PaneCommandResult } from "../../shell/panes/paneCommands.ts";
import { browserContent } from "../../surfaces/browser/browserModel.ts";
import { launchAccounts, preselectLaunchAccount, readLaunchMemory } from "../../surfaces/code/panes/agentLaunch.ts";
import {
  isPaneProvider,
  PANE_PROVIDERS,
  PaneChannel,
  resolvePaneStartMode,
  splitInput,
} from "../../surfaces/code/panes/paneChannel.ts";
import { useRuntime } from "../RuntimeProvider.tsx";
import { useWorkspaces } from "../WorkspaceProvider.tsx";
import { executeRecipe, type RecipePorts } from "./launch.ts";
import {
  duplicateRecipe,
  launchesImmediately,
  preflightRecipe,
  type RecipeBlocker,
  type RecipeEnvironment,
  type RecipeLaunchInputs,
  type RecipeLaunchSummary,
  type RecipeLink,
  type RecipePreflight,
  resolveRecipeQuery,
  sortRecipes,
} from "./model.ts";
import { useRecipeCapture } from "./useRecipeCapture.ts";

/**
 * The one Launch Recipe authority every entry point uses (buttons, Code, Projects, the palette,
 * KalVoice). Definitions come from native; launching runs `executeRecipe` over canonical paths.
 * Editing a Recipe never touches anything already running.
 */

export type RecipeLaunchPhase =
  | { kind: "idle" }
  | { kind: "preparing"; recipeName: string }
  | { kind: "review"; preflight: RecipePreflight; inputs: RecipeLaunchInputs }
  | { kind: "launching"; preflight: RecipePreflight; done: number; total: number }
  | { kind: "done"; summary: RecipeLaunchSummary };

export interface RecipeLaunchApi {
  phase: RecipeLaunchPhase;
  accounts: ProviderAccount[];
  request(
    target: { recipeId: string } | { query: string },
    /** `quiet`: the caller reports the result itself (KalVoice speaks it). */
    options?: { review?: boolean; quiet?: boolean },
  ): Promise<RecipeRequestResult>;
  update(inputs: RecipeLaunchInputs): void;
  confirm(): Promise<void>;
  cancel(): void;
  repair(blocker: RecipeBlocker): void;
  refreshEnvironment(): Promise<void>;
  dismiss(): void;
  openLink(link: RecipeLink): void;
}

/** `launched` is true once a summary is on screen, so callers don't repeat what it says. */
export interface RecipeRequestResult {
  ok: boolean;
  message: string;
  launched: boolean;
  /** No Launch Recipe matched (KalVoice then tries a Squad recipe of that name). */
  missing?: boolean;
}

export interface RecipeLibrary {
  recipes: LaunchRecipe[];
  limit: number | null;
  loading: boolean;
  error: string | null;
  refresh(): Promise<LaunchRecipesSnapshot | null>;
  save(recipe: LaunchRecipe): Promise<LaunchRecipe>;
  remove(id: string): Promise<void>;
  reorder(ids: string[]): Promise<void>;
  togglePin(id: string): Promise<void>;
  duplicate(id: string): Promise<LaunchRecipe>;
  editor: { open(recipe: LaunchRecipe | null): void; close(): void; recipe: LaunchRecipe | null; isOpen: boolean };
  library: { open(): void; close(): void; isOpen: boolean };
}

const LibraryContext = createContext<RecipeLibrary | null>(null);
const LaunchContext = createContext<RecipeLaunchApi | null>(null);
/** Stable for the provider's lifetime: entry points never re-render on launch progress. */
const RequestContext = createContext<RecipeLaunchApi["request"] | null>(null);

export function useRecipeLibrary(): RecipeLibrary {
  const value = useContext(LibraryContext);
  if (!value) throw new Error("useRecipeLibrary must be used inside <RecipesProvider>");
  return value;
}

export function useRecipeLaunch(): RecipeLaunchApi {
  const value = useContext(LaunchContext);
  if (!value) throw new Error("useRecipeLaunch must be used inside <RecipesProvider>");
  return value;
}

/** The canonical launch action for buttons, menus, the palette and KalVoice. */
export function useRecipeRequest(): RecipeLaunchApi["request"] {
  const value = useContext(RequestContext);
  if (!value) throw new Error("useRecipeRequest must be used inside <RecipesProvider>");
  return value;
}

/** Entry points that also render without the provider (isolated views) hide Recipes then. */
export function useOptionalRecipeRequest(): RecipeLaunchApi["request"] | null {
  return useContext(RequestContext);
}

export function useOptionalRecipeLibrary(): RecipeLibrary | null {
  return useContext(LibraryContext);
}

/** For surfaces that also render outside the provider (tests, isolated previews). */
export function useOptionalRecipeLaunch(): RecipeLaunchApi | null {
  return useContext(LaunchContext);
}

const message = (cause: unknown) => toKalCodeError(cause).message;
const ACTIVE_RUN = new Set(["queued", "starting", "running", "paused", "blocked"]);
const READY_TIMEOUT_MS = 90_000;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Launch cancelled."));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });

export function RecipesProvider({ children }: { children: ReactNode }) {
  const { client } = useRuntime();
  const workspaces = useWorkspaces();
  const navigation = useNavigation();
  const toast = useToast();
  const operations = useMemo(
    () => new OperationsClient((command, args) => client.transport.invoke(command, args)),
    [client],
  );
  const panes = useMemo(() => new PaneChannel(client), [client]);

  // ---------- Library ----------
  const [snapshot, setSnapshot] = useState<LaunchRecipesSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ recipe: LaunchRecipe | null } | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;

  // A refresh that started before the latest save/delete/reorder must not overwrite its result.
  const mutations = useRef(0);
  const refresh = useCallback(async (): Promise<LaunchRecipesSnapshot | null> => {
    const startedAt = mutations.current;
    try {
      const next = await client.recipes.snapshot();
      if (startedAt === mutations.current) {
        setSnapshot(next);
        snapshotRef.current = next;
      }
      setError(null);
      return next;
    } catch (cause) {
      setError(message(cause));
      return null;
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  const recipes = useMemo(() => sortRecipes(snapshot?.recipes ?? []), [snapshot]);
  const recipesRef = useRef(recipes);
  recipesRef.current = recipes;

  const save = useCallback(
    async (recipe: LaunchRecipe) => {
      mutations.current += 1;
      const saved = await client.recipes.save(recipe);
      setSnapshot((current) =>
        current ? { ...current, recipes: [...current.recipes.filter((item) => item.id !== saved.id), saved] } : current,
      );
      return saved;
    },
    [client],
  );
  const remove = useCallback(
    async (id: string) => {
      mutations.current += 1;
      await client.recipes.delete(id);
      setSnapshot((current) =>
        current ? { ...current, recipes: current.recipes.filter((item) => item.id !== id) } : current,
      );
    },
    [client],
  );
  const reorder = useCallback(
    async (ids: string[]) => {
      mutations.current += 1;
      const previous = snapshotRef.current;
      if (previous) {
        const position = new Map(ids.map((id, index) => [id, index]));
        setSnapshot({
          ...previous,
          recipes: previous.recipes.map((recipe) => ({
            ...recipe,
            position: position.get(recipe.id) ?? recipe.position,
          })),
        });
      }
      try {
        setSnapshot(await client.recipes.reorder(ids));
      } catch (cause) {
        setSnapshot(previous);
        setError(message(cause));
        throw cause;
      }
    },
    [client],
  );
  const togglePin = useCallback(
    async (id: string) => {
      const recipe = recipesRef.current.find((item) => item.id === id);
      if (recipe) await save({ ...recipe, pinned: !recipe.pinned });
    },
    [save],
  );
  const duplicate = useCallback(
    async (id: string) => {
      const recipe = recipesRef.current.find((item) => item.id === id);
      if (!recipe) throw new Error("That Recipe no longer exists.");
      const position = Math.max(-1, ...recipesRef.current.map((item) => item.position)) + 1;
      return save(duplicateRecipe(recipe, crypto.randomUUID(), recipesRef.current, position));
    },
    [save],
  );

  const library = useMemo<RecipeLibrary>(
    () => ({
      recipes,
      limit: snapshot?.limit ?? null,
      loading,
      error,
      refresh,
      save,
      remove,
      reorder,
      togglePin,
      duplicate,
      editor: {
        open: (recipe) => setEditing({ recipe }),
        close: () => setEditing(null),
        recipe: editing?.recipe ?? null,
        isOpen: editing !== null,
      },
      library: { open: () => setLibraryOpen(true), close: () => setLibraryOpen(false), isOpen: libraryOpen },
    }),
    [
      recipes,
      snapshot?.limit,
      loading,
      error,
      refresh,
      save,
      remove,
      reorder,
      togglePin,
      duplicate,
      editing,
      libraryOpen,
    ],
  );

  // ---------- Launch ----------
  const [phase, setPhase] = useState<RecipeLaunchPhase>({ kind: "idle" });
  const [env, setEnv] = useState<RecipeEnvironment | null>(null);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const envRef = useRef(env);
  envRef.current = env;
  const abortRef = useRef<AbortController | null>(null);
  const inFlight = useRef(false);
  /** Bumped by Cancel: a request still preparing sees it and stops before starting anything. */
  const requestToken = useRef(0);
  // Leaving (sign-out, window close) cancels a launch in progress; Cancel's undo runs.
  useEffect(() => () => abortRef.current?.abort(), []);
  const live = useRef({ workspaces, navigation });
  live.current = { workspaces, navigation };

  const loadEnvironment = useCallback(async (): Promise<RecipeEnvironment> => {
    const [workspaceList, accounts, providers, bindings, squads] = await Promise.all([
      client.listWorkspaces(),
      client.listProviderAccounts(),
      client.listProviders().catch(() => [] as ProviderStatus[]),
      client.listProviderAccountBindings().catch(() => [] as ProviderAccountBinding[]),
      client.squads.snapshot().catch(() => null),
    ]);
    const activeWorkspaceId = live.current.workspaces.active?.id ?? null;
    // Capability check at runtime: a provider joins once its adapter runs interactively.
    // A provider KalCode lists only as "planned" (no working adapter, no interactive support) can't
    // start; every implemented pane provider can, including ones added after this Recipe was saved.
    const capable = new Set(
      providers.filter((p) => p.capabilities.interactive || p.adapter === "implemented").map((p) => p.id as string),
    );
    const listed = new Set(providers.map((p) => p.id as string));
    const agentProviders = PANE_PROVIDERS.filter((id) => !listed.has(id) || capable.has(id));
    const memory = readLaunchMemory();
    return {
      activeWorkspaceId,
      workspaces: workspaceList,
      accounts,
      agentProviders,
      squadIds: squads ? new Set(squads.squads.map((squad) => squad.id)) : null,
      defaultAccount: (providerId) => {
        const candidates = launchAccounts(accounts, providerId);
        const remembered = isPaneProvider(providerId) ? memory.byProvider[providerId]?.accountId : undefined;
        const id =
          (remembered && candidates.some((a) => a.id === remembered) ? remembered : null) ??
          (activeWorkspaceId ? preselectLaunchAccount(accounts, bindings, providerId, activeWorkspaceId) : null);
        return candidates.find((a) => a.id === id) ?? null;
      },
    };
  }, [client]);

  const ports = useMemo<RecipePorts>(
    () => ({
      async createAgent(part, workspaceId) {
        const permissionMode = await resolvePaneStartMode(null, () => client.getPermissionSettings());
        if (!isPaneProvider(part.providerId)) throw new Error("This provider can't run as a coding terminal.");
        const thread = await panes.create({
          providerId: part.providerId,
          providerAccountId: part.account.id,
          workspaceId,
          model: part.model,
          effort: part.effort,
          permissionMode,
          name: part.name,
        });
        return { threadId: thread.id };
      },
      async deliverTask(threadId, task, signal) {
        const chunks = splitInput(frameProviderPrompt(task));
        const deadline = Date.now() + READY_TIMEOUT_MS;
        let last = "the agent didn't become ready in time";
        while (Date.now() < deadline) {
          if (signal.aborted) throw new Error("Launch cancelled.");
          const info = await panes.info(threadId).catch(() => null);
          if (info && !info.running && info.exitCode !== null) throw new Error("the agent exited before it was ready");
          if (info?.instanceId) {
            let sent = 0;
            try {
              for (const chunk of chunks) {
                await panes.writeVoice(threadId, info.instanceId, chunk);
                sent += 1;
              }
              return;
            } catch (cause) {
              const error = toKalCodeError(cause);
              // Native refuses until the provider can take a prompt. Retry only while nothing was
              // written: resending after a partial write would duplicate part of the prompt.
              if (
                sent > 0 ||
                (error.code !== "provider_input_unverified" &&
                  error.code !== "provider_permission_prompt" &&
                  error.code !== "provider_target_changed")
              )
                throw error;
              last = error.message;
            }
          }
          await sleep(750, signal);
        }
        throw new Error(last);
      },
      stopAgent: async (threadId) => {
        await client.stopThread(threadId);
      },
      async createTerminal(workspaceId, name) {
        const terminal = await live.current.workspaces.createTerminal(null, workspaceId);
        if (!terminal) throw new Error("The terminal couldn't start. Check the project folder and try again.");
        if (name) await client.renameTerminal(terminal.id, name).catch(() => undefined);
        return { terminalId: terminal.id };
      },
      runInTerminal: (terminalId, command) => client.writeTerminal(terminalId, `${command}\r`),
      closeTerminal: (terminalId) => client.closeTerminal(terminalId),
      async runningService(workspaceId, name) {
        const snapshot = await operations.snapshot();
        const run = snapshot.items.find(
          (item) =>
            item.spec.kind === "service" &&
            item.spec.workspaceId === workspaceId &&
            item.spec.name.toLocaleLowerCase() === name.toLocaleLowerCase() &&
            ACTIVE_RUN.has(item.status),
        );
        return run ? { runId: run.id } : null;
      },
      async startService(workspaceId, name, command) {
        const record = await operations.enqueue({
          name,
          workspaceId,
          kind: "service",
          command,
          prompt: null,
          providerId: null,
          providerAccountId: null,
          model: null,
          effort: null,
          dependencies: [],
          priority: 0,
          lane: "next",
          environment: "local",
          urls: [],
          envKeys: [],
        });
        return { runId: record.id };
      },
      stopService: (runId) => operations.cancel(runId),
      async launchSquad(squadId, workspaceId, goal, requestId) {
        const launch = await client.squads.launch(squadId, workspaceId, requestId, goal);
        return { launchId: launch.id, operationIds: launch.members.map((member) => member.operationId) };
      },
      async cancelOperations(operationIds) {
        const results = await Promise.allSettled(operationIds.map((id) => operations.cancel(id)));
        if (results.some((result) => result.status === "rejected"))
          throw new Error("Some Squad members couldn't be cancelled.");
      },
      browserContent: (url) => browserContent(undefined, url),
      widgetContent: (widget): PaneContent => ({ kind: "widget", widgetId: widget }),
      openDesk: (workspaceId, contents, preset) =>
        new Promise<PaneCommandResult>((resolve) => {
          // A desk that missed its moment must not appear later, unasked: the timeout withdraws it.
          const withdraw = new AbortController();
          const timer = setTimeout(() => {
            withdraw.abort();
            resolve({ handled: false, message: "Code didn't open in time." });
          }, 20_000);
          void activateAndDispatchPaneCommand(
            workspaceId,
            { kind: "open-desk", contents, preset: preset as BuiltinPreset | null },
            live.current.workspaces.activate,
            () => live.current.navigation.navigate("code"),
            (result) => {
              clearTimeout(timer);
              resolve(result);
            },
            withdraw.signal,
          ).then((result) => {
            if (!result.handled) {
              clearTimeout(timer);
              resolve(result);
            }
          });
        }),
      newRequestId: () => crypto.randomUUID(),
      now: () => performance.now(),
    }),
    [client, operations, panes],
  );

  /**
   * Native can refuse a pane after its session row exists. After the batch settles, stop only
   * sessions that match a FAILED agent part exactly (same project, provider, account, started
   * during this launch) and that no started part owns: no zombie or half-registered agent.
   */
  const stopOrphans = useCallback(
    async (preflight: RecipePreflight, summary: RecipeLaunchSummary, before: ReadonlySet<string> | null) => {
      if (!before || !summary.workspaceId) return;
      const owned = new Set(
        summary.started.flatMap((part) =>
          part.link?.kind === "pane" && part.link.content.kind === "agent" ? [part.link.content.agentId] : [],
        ),
      );
      // Agent parts that ended without a live session of their own (failed, or undone by Cancel).
      const startedKeys = new Set(summary.started.map((part) => part.key));
      const pending = new Map<string, number>();
      for (const part of preflight.plan)
        if (part.kind === "agent" && !startedKeys.has(part.key)) {
          const slot = `${part.providerId}
${part.account.id}`;
          pending.set(slot, (pending.get(slot) ?? 0) + 1);
        }
      if (pending.size === 0) return;
      const threads = await client.listThreads({ workspaceId: summary.workspaceId }).catch(() => []);
      // Only sessions that appeared during this launch, oldest first, and never more per
      // provider/account than this launch failed to start: a session the person opened
      // meanwhile is left alone whenever the counts allow it.
      const fresh = threads
        .filter(
          (thread) =>
            !before.has(thread.id) &&
            !owned.has(thread.id) &&
            !thread.archivedAt &&
            thread.runtimeKind === "interactive_pty",
        )
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
      for (const thread of fresh) {
        const slot = `${thread.providerId}
${thread.providerAccountId}`;
        const left = pending.get(slot) ?? 0;
        if (left === 0) continue;
        pending.set(slot, left - 1);
        await client.stopThread(thread.id).catch(() => undefined);
      }
    },
    [client],
  );

  const run = useCallback(
    async (preflight: RecipePreflight) => {
      abortRef.current?.abort();
      const abort = new AbortController();
      abortRef.current = abort;
      setPhase({ kind: "launching", preflight, done: 0, total: preflight.plan.length });
      // Which sessions existed before, so cleanup can only ever touch sessions this launch made.
      const before =
        preflight.workspace && preflight.plan.some((part) => part.kind === "agent")
          ? await client
              .listThreads({ workspaceId: preflight.workspace.id })
              .then((threads) => new Set(threads.map((thread) => thread.id)))
              .catch(() => null)
          : null;
      const summary = await executeRecipe(preflight, ports, {
        signal: abort.signal,
        onProgress: (done, total) =>
          setPhase((current) => (current.kind === "launching" ? { ...current, done, total } : current)),
      });
      await stopOrphans(preflight, summary, before);
      if (abortRef.current === abort) abortRef.current = null;
      setPhase({ kind: "done", summary });
      return summary;
    },
    [client, ports, stopOrphans],
  );

  const prepare = useCallback(
    async (
      target: { recipeId: string } | { query: string },
      options: { review?: boolean },
      token: number,
    ): Promise<RecipeRequestResult> => {
      const cancelled = () => requestToken.current !== token;
      let list = recipesRef.current;
      const find = () =>
        "recipeId" in target
          ? (() => {
              const recipe = list.find((item) => item.id === target.recipeId);
              return recipe ? ({ kind: "found", recipe } as const) : ({ kind: "missing" } as const);
            })()
          : resolveRecipeQuery(list, target.query);
      let resolved = find();
      if (resolved.kind === "missing") {
        const fresh = await refresh();
        list = sortRecipes(fresh?.recipes ?? snapshotRef.current?.recipes ?? []);
        resolved = find();
      }
      if (resolved.kind === "missing")
        return { ok: false, message: "No saved Recipe matches that.", launched: false, missing: true };
      if (resolved.kind === "ambiguous")
        return {
          ok: false,
          message: `More than one Recipe matches: ${resolved.matches.map((r) => r.name).join(", ")}. Say the full name.`,
          launched: false,
        };
      const recipe = resolved.recipe;
      setPhase({ kind: "preparing", recipeName: recipe.name });
      let environment: RecipeEnvironment;
      try {
        environment = await loadEnvironment();
      } catch (cause) {
        if (cancelled()) return { ok: false, message: "Launch cancelled.", launched: true };
        setPhase({ kind: "idle" });
        return { ok: false, message: `${recipe.name} couldn't be prepared: ${message(cause)}`, launched: false };
      }
      // Cancelled while preparing: nothing has started, and nothing will.
      if (cancelled()) return { ok: false, message: "Launch cancelled.", launched: true };
      setEnv(environment);
      const preflight = preflightRecipe(recipe, environment);
      if (!options.review && launchesImmediately(preflight)) {
        const summary = await run(preflight);
        const total = summary.started.length + summary.failed.length;
        return {
          ok: summary.failed.length === 0,
          message:
            summary.failed.length === 0
              ? `Launched ${recipe.name}: ${summary.started.length} started.`
              : `Launched ${recipe.name}: ${summary.started.length} of ${total} started.`,
          launched: true,
        };
      }
      setPhase({ kind: "review", preflight, inputs: {} });
      return { ok: true, message: `${recipe.name} is ready to review before it launches.`, launched: true };
    },
    [loadEnvironment, refresh, run],
  );

  const prepareAndLaunch = useCallback(
    async (
      target: { recipeId: string } | { query: string },
      options: { review?: boolean },
    ): Promise<RecipeRequestResult> => {
      // One launch at a time, decided synchronously: a voice request and a click can't both start.
      if (inFlight.current)
        return { ok: false, message: "A Recipe is still launching. Wait for it to finish.", launched: false };
      inFlight.current = true;
      const token = ++requestToken.current;
      try {
        return await prepare(target, options, token);
      } finally {
        inFlight.current = false;
      }
    },
    [prepare],
  );

  /** Every entry point gets the same feedback: a request that didn't launch says why. */
  const request = useCallback<RecipeLaunchApi["request"]>(
    async (target, options = {}) => {
      const result = await prepareAndLaunch(target, options);
      if (!result.launched && !options.quiet) toast.show({ tone: "danger", title: result.message });
      return result;
    },
    [prepareAndLaunch, toast],
  );

  const update = useCallback((inputs: RecipeLaunchInputs) => {
    const current = phaseRef.current;
    const environment = envRef.current;
    if (current.kind !== "review" || !environment) return;
    const merged: RecipeLaunchInputs = { ...current.inputs, ...inputs };
    setPhase({
      kind: "review",
      preflight: preflightRecipe(current.preflight.recipe, environment, merged),
      inputs: merged,
    });
  }, []);

  const refreshEnvironment = useCallback(async () => {
    const current = phaseRef.current;
    if (current.kind !== "review") return;
    const environment = await loadEnvironment();
    setEnv(environment);
    const latest = phaseRef.current;
    if (latest.kind !== "review") return;
    setPhase({
      kind: "review",
      preflight: preflightRecipe(latest.preflight.recipe, environment, latest.inputs),
      inputs: latest.inputs,
    });
  }, [loadEnvironment]);

  const confirm = useCallback(async () => {
    const current = phaseRef.current;
    if (current.kind !== "review") return;
    // Blocked parts the person didn't fix are skipped; a whole-launch blocker stops here.
    if (current.preflight.blockers.some((blocker) => !blocker.skippable)) return;
    await run(current.preflight);
  }, [run]);

  const cancel = useCallback(() => {
    const current = phaseRef.current;
    if (current.kind === "launching") abortRef.current?.abort();
    else if (current.kind === "review" || current.kind === "preparing") {
      requestToken.current += 1;
      setPhase({ kind: "idle" });
    }
  }, []);

  const repair = useCallback(
    (blocker: RecipeBlocker) => {
      const current = phaseRef.current;
      if (blocker.repair.kind === "open-project") {
        const id = blocker.repair.workspaceId;
        void (id ? live.current.workspaces.activate(id) : live.current.workspaces.openFolder()).then(() =>
          refreshEnvironment(),
        );
        return;
      }
      if (blocker.repair.kind === "edit" && current.kind === "review") {
        setPhase({ kind: "idle" });
        setEditing({ recipe: current.preflight.recipe });
      }
      // reconnect / choose-account are handled inline by the sheet (LaunchSignIn + account select).
    },
    [refreshEnvironment],
  );

  const openLink = useCallback((link: RecipeLink) => {
    const current = phaseRef.current;
    const workspaceId = current.kind === "done" ? current.summary.workspaceId : live.current.workspaces.active?.id;
    if (!workspaceId) return;
    if (link.kind === "pane") {
      void activateAndDispatchPaneCommand(
        workspaceId,
        { kind: "open", content: link.content },
        live.current.workspaces.activate,
        () => live.current.navigation.navigate("code"),
      );
      return;
    }
    live.current.navigation.navigate("operations");
    void focusOperationsTarget(
      link.kind === "service"
        ? { kind: "run", tab: "runs", runId: link.runId, workspaceId, label: "Service" }
        : { kind: "tab", tab: "squads" },
    );
  }, []);

  const launchApi = useMemo<RecipeLaunchApi>(
    () => ({
      phase,
      accounts: [...(env?.accounts ?? [])],
      request,
      update,
      confirm,
      cancel,
      repair,
      refreshEnvironment,
      dismiss: () => setPhase((current) => (current.kind === "done" ? { kind: "idle" } : current)),
      openLink,
    }),
    [phase, env, request, update, confirm, cancel, repair, refreshEnvironment, openLink],
  );

  return (
    <LibraryContext.Provider value={library}>
      <LaunchContext.Provider value={launchApi}>
        <RequestContext.Provider value={request}>
          <RecipeCaptureListener />
          {children}
        </RequestContext.Provider>
      </LaunchContext.Provider>
    </LibraryContext.Provider>
  );
}

function RecipeCaptureListener() {
  useRecipeCapture();
  return null;
}

export type { Workspace };
