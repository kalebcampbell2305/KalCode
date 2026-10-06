import type { ModelInfo, ProviderAccount, ProviderAccountBinding, Workspace } from "@kalcode/protocol";
import { Button, IconButton, ProviderGlyph } from "@kalcode/ui/components";
import {
  Bot,
  CornerDownLeft,
  Globe,
  LayoutGrid,
  Minus,
  Plus,
  RotateCcw,
  SquareTerminal,
  UsersRound,
} from "lucide-react";
import { Dialog } from "radix-ui";
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type { KalCodeClient } from "../../ipc/client.ts";
import { toKalCodeError } from "../../ipc/errors.ts";
import { useRuntime } from "../../runtime/RuntimeProvider.tsx";
import { UsageMeter } from "../providers/AccountUsageBadge.tsx";
import { accountName, accountSessionState, sortAccounts } from "../providers/accountIdentity.ts";
import {
  type AccountUsageState,
  LOW_USAGE_PERCENT,
  limitingWindow,
  notChecked,
  type UsageWindow,
  useAccountUsages,
} from "../providers/accountUsage.ts";
import { LaunchSignIn } from "../providers/LaunchAccountPicker.tsx";
import { useOptionalProviderAccountSessions } from "../providers/ProviderAccountSessions.tsx";
import { isBrowserAuthProvider } from "../providers/useProviderAccounts.ts";
import styles from "./NewAgentDialog.module.css";
import {
  AGENT_EFFORTS,
  boundLaunchAccount,
  clampAgentCount,
  effortLabel,
  type LaunchMemory,
  launchAccounts,
  launchLabel,
  MAX_AGENTS_PER_LAUNCH,
  readLaunchMemory,
  rememberLaunch,
  resolveLaunchAccount,
  sameSignIns,
} from "./panes/agentLaunch.ts";
import { PANE_PROVIDERS, type PaneProviderId } from "./panes/paneChannel.ts";
import { providerIdentity } from "./panes/paneLabels.ts";
import type { AgentLaunch } from "./panes/useProviderPanes.ts";

export interface AgentLaunchSpec extends AgentLaunch {
  providerId: PaneProviderId;
  count: number;
}

export interface NewAgentDialogProps {
  workspace: Workspace;
  /** Codex / Gemini CLI when this build can run them (Claude Code is always offered). */
  offered: readonly PaneProviderId[];
  initialProvider: PaneProviderId;
  /** Pre-fills the agent count (a "start six agents" request that still needs a choice). */
  initialCount?: number;
  busy: boolean;
  error: string | null;
  /** Handoff launches create exactly one recipient while keeping the prepared draft in Code. */
  fixedCount?: number;
  purpose?: "standard" | "handoff";
  /** Number started. A partial batch retains only its unfinished agents for reconnect/retry. */
  onLaunch: (spec: AgentLaunchSpec) => Promise<boolean | number>;
  onClose: () => void;
  /** Optional secondary actions ("Other"): shown only when the host wires them. */
  onNewTerminal?: () => void;
  onOpenBrowser?: () => void;
  onAddWidget?: () => void;
  /** Opens Operations → Squads, the reusable multi-agent launch surface. */
  onOpenSquads?: () => void;
}

/**
 * What the launcher learned from this runtime, kept for the next open so the launcher paints
 * complete on its first frame and only refreshes in place (owner rule: opening is instant).
 */
interface LauncherCache {
  models: ReadonlyMap<string, readonly ModelInfo[]> | null;
  providers: ReadonlySet<string> | null;
  bindings: readonly ProviderAccountBinding[] | null;
}
const caches = new WeakMap<KalCodeClient, LauncherCache>();
function cacheFor(client: KalCodeClient): LauncherCache {
  let cache = caches.get(client);
  if (!cache) {
    cache = { models: null, providers: null, bindings: null };
    caches.set(client, cache);
  }
  return cache;
}

interface Choice {
  providerId: PaneProviderId;
  /** Empty for a provider with no account yet (its "add account" row). */
  accountId: string;
}

type RowTone = "ok" | "low" | "waiting" | "danger" | "muted" | "accent";

/** The one status word a row shows, from what KalCode actually knows. */
function rowStatus(session: ReturnType<typeof accountSessionState>): { label: string; tone: RowTone } {
  if (session.state === "expired") return { label: "Signed out", tone: "waiting" };
  if (session.state === "checking") return { label: "Checking", tone: "muted" };
  if (session.state === "error") return { label: "Needs attention", tone: "danger" };
  if (session.state === "connected") return { label: "Ready", tone: "ok" };
  return { label: "Not checked", tone: "muted" };
}

const optionId = (base: string, choice: Choice) => `${base}-opt-${choice.providerId}-${choice.accountId || "add"}`;

/**
 * Code's + launcher: every account of every coding-agent provider at a glance with its real
 * usage, then exact model, effort and count, then launch. The last launch per provider is
 * remembered, so the common case is: open, Enter.
 */
export function NewAgentDialog({
  workspace,
  offered,
  initialProvider,
  initialCount,
  busy,
  error,
  fixedCount,
  purpose = "standard",
  onLaunch,
  onClose,
  onNewTerminal,
  onOpenBrowser,
  onAddWidget,
  onOpenSquads,
}: NewAgentDialogProps) {
  const { client } = useRuntime();
  const sessions = useOptionalProviderAccountSessions();
  const discoverModels = sessions?.discoverModels;
  const refreshUsage = sessions?.refreshUsage;
  useEffect(() => refreshUsage?.(), [refreshUsage]);
  const sharedSessions = sessions !== null;
  const usages = useAccountUsages();
  const id = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const cache = cacheFor(client);
  const [memory, setMemory] = useState<LaunchMemory>(() => readLaunchMemory());
  const [models, setModels] = useState(cache.models);
  const [optionProviders, setOptionProviders] = useState(cache.providers);
  const [bindings, setBindings] = useState(cache.bindings);
  const [bindingsReady, setBindingsReady] = useState(false);
  const [localAccounts, setLocalAccounts] = useState<readonly ProviderAccount[] | null>(null);
  const [localAccountError, setLocalAccountError] = useState<string | null>(null);
  // The provider asked for stays requested until `offered` / options can answer (never a silent
  // fallback to Claude Code while Codex is still being detected).
  const [requested, setRequested] = useState<PaneProviderId>(initialProvider);
  const [picked, setPicked] = useState<Choice | null>(null);
  const [config, setConfig] = useState<{ providerId: PaneProviderId; model?: string; effort?: string }>({
    providerId: initialProvider,
  });
  // What the person typed; the launch uses it clamped, so editing "1" to "5" never passes through 15.
  const [countText, setCountText] = useState(() =>
    String(
      initialCount !== undefined ? clampAgentCount(initialCount) : (memory.byProvider[initialProvider]?.count ?? 1),
    ),
  );
  const [countTouched, setCountTouched] = useState(initialCount !== undefined);
  const [signingIn, setSigningIn] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const submitting = useRef(false);
  const [cursorModels, setCursorModels] = useState<{
    accountId: string;
    models: readonly ModelInfo[];
    error: string | null;
  } | null>(null);

  const reloadAccounts = useCallback(async () => {
    try {
      const [accounts, next] = await Promise.all([
        sessions ? sessions.reload() : client.listProviderAccounts(),
        client.listProviderAccountBindings({ kind: "workspace" }),
      ]);
      setLocalAccounts(accounts);
      cacheFor(client).bindings = next;
      setBindings(next);
      setBindingsReady(true);
      setLocalAccountError(null);
    } catch {
      setLocalAccountError("Accounts unavailable");
    }
  }, [client, sessions]);

  useEffect(() => {
    let cancelled = false;
    if (!sharedSessions) {
      client.listProviderAccounts().then(
        (accounts) => {
          if (!cancelled) setLocalAccounts(accounts);
        },
        () => {
          if (!cancelled) setLocalAccountError("Accounts unavailable");
        },
      );
    }
    // Everything below refreshes in place; the launcher already painted from what was known.
    client.listProviderAccountBindings({ kind: "workspace" }).then(
      (next) => {
        if (cancelled) return;
        cacheFor(client).bindings = next;
        setBindings(next);
        setBindingsReady(true);
      },
      () => {
        if (!cancelled) setLocalAccountError("Workspace accounts unavailable");
      },
    );
    client.threadOptions().then(
      (options) => {
        const nextModels = new Map(options.providers.map((p) => [p.id, p.models]));
        const nextProviders = new Set(options.providers.map((p) => p.id));
        const shared = cacheFor(client);
        shared.models = nextModels;
        shared.providers = nextProviders;
        if (cancelled) return;
        setModels(nextModels);
        setOptionProviders(nextProviders);
      },
      () => {
        if (!cancelled) setOptionProviders((current) => current ?? new Set());
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, sharedSessions]);

  const providers = PANE_PROVIDERS.filter(
    (p) => p === "claude-code" || p === "cursor" || offered.includes(p) || (optionProviders?.has(p) ?? false),
  );
  const providerKnown = providers.includes(requested);
  const providerPending = !providerKnown && optionProviders === null;
  const providerId: PaneProviderId = providerKnown || providerPending ? requested : "claude-code";
  const providerName = providerIdentity(providerId).name;
  const requestedName = providerIdentity(requested).name;

  const restoredAccounts = sessions ? sessions.accounts : localAccounts;
  const accountLoadError = (sessions?.accounts === null ? sessions.loadError : null) ?? localAccountError;
  // A handful of accounts: derived each render, so nothing here can go stale.
  const groups = providers.map((p) => ({
    providerId: p,
    accounts: sortAccounts(launchAccounts(restoredAccounts ?? [], p)),
  }));
  const sameSignIn = sameSignIns(groups.flatMap((g) => g.accounts));
  const choices: Choice[] = groups.flatMap((g) =>
    g.accounts.length > 0
      ? g.accounts.map((a) => ({ providerId: g.providerId, accountId: a.id }))
      : [{ providerId: g.providerId, accountId: "" }],
  );

  const candidates = groups.find((g) => g.providerId === providerId)?.accounts ?? [];
  const remembered = memory.byProvider[providerId];
  const selectedAccountId =
    picked?.providerId === providerId && candidates.some((a) => a.id === picked.accountId)
      ? picked.accountId
      : restoredAccounts && !providerPending
        ? resolveLaunchAccount(restoredAccounts, bindings, providerId, workspace.id, remembered)
        : "";
  const account = candidates.find((a) => a.id === selectedAccountId);
  const sessionOf = (a: ProviderAccount) => sessions?.states.get(a.id)?.health ?? accountSessionState(a);
  const usageOf = (accountId: string) =>
    sessions?.states.get(accountId)?.usage ?? usages.get(accountId) ?? notChecked(accountId);
  const selectedSession = account ? sessionOf(account) : null;
  const activeChoice: Choice | null = providerPending ? null : { providerId, accountId: account?.id ?? "" };

  // Cursor models belong to the real account/runtime, never the static catalog or launch memory.
  const cursorAccountId = providerId === "cursor" ? account?.id : undefined;
  const authenticationState = account?.authenticationState;
  const reportedIdentity = account?.providerReportedIdentity;
  // biome-ignore lint/correctness/useExhaustiveDependencies: reconnecting to a different reported identity invalidates account model discovery.
  useEffect(() => {
    if (selectedAccountId && authenticationState !== "not_authenticated") void discoverModels?.(selectedAccountId);
  }, [discoverModels, selectedAccountId, authenticationState, reportedIdentity]);
  useEffect(() => {
    if (!cursorAccountId || discoverModels || authenticationState === "not_authenticated") return;
    let cancelled = false;
    setCursorModels(null);
    client.refreshCursorAccount(cursorAccountId).then(
      (state) => {
        if (cancelled) return;
        setLocalAccounts((current) => current?.map((a) => (a.id === state.account.id ? state.account : a)) ?? null);
        setCursorModels({ accountId: cursorAccountId, models: state.models, error: state.modelsError });
      },
      (failure) => {
        if (!cancelled)
          setCursorModels({ accountId: cursorAccountId, models: [], error: toKalCodeError(failure).message });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, cursorAccountId, discoverModels, authenticationState]);
  const canonicalModels = sessions?.states.get(selectedAccountId)?.models;
  const currentCursorModels = sharedSessions
    ? canonicalModels && canonicalModels.status !== "checking"
      ? { models: canonicalModels.items, error: canonicalModels.reason }
      : null
    : cursorModels?.accountId === selectedAccountId
      ? cursorModels
      : null;

  // Model: provider/account default first, then the exact models this provider reports.
  const providerModels =
    providerId === "cursor"
      ? currentCursorModels?.error
        ? null
        : (currentCursorModels?.models ?? null)
      : canonicalModels?.status === "available"
        ? canonicalModels.items
        : canonicalModels?.status === "unavailable"
          ? null
          : (models?.get(providerId) ?? null);
  const defaultModel = providerModels?.find((m) => m.isDefault) ?? null;
  const rawModel =
    config.providerId === providerId && config.model !== undefined ? config.model : (remembered?.model ?? "");
  const model =
    !rawModel || rawModel === defaultModel?.id
      ? ""
      : providerId !== "cursor" && providerModels && !providerModels.some((m) => m.id === rawModel)
        ? ""
        : rawModel;
  const modelOptions: { value: string; label: string }[] = [
    { value: "", label: defaultModel?.displayName ?? "Default" },
    ...(providerModels
      ? providerModels
          .filter((m) => !m.isDefault)
          .map((m) => ({
            value: m.id,
            label:
              providerId === "cursor" && m.displayName !== m.id && !m.displayName.endsWith(`(${m.id})`)
                ? `${m.displayName} (${m.id})`
                : m.displayName,
          }))
      : model
        ? [{ value: model, label: remembered?.modelName ?? model }]
        : []),
  ];
  const unavailableCursorModel =
    providerId === "cursor" && !!rawModel && !!providerModels && !providerModels.some((m) => m.id === rawModel);
  const modelName = model ? (modelOptions.find((o) => o.value === model)?.label ?? model) : null;
  const efforts = AGENT_EFFORTS[providerId];
  const rawEffort =
    config.providerId === providerId && config.effort !== undefined ? config.effort : (remembered?.effort ?? "");
  const effort = efforts.includes(rawEffort) ? rawEffort : "";
  const count = fixedCount ?? clampAgentCount(Number(countText));

  const choose = (choice: Choice) => {
    if (busy || signingIn) return;
    if (choice.providerId !== providerId) {
      setConfig({ providerId: choice.providerId });
      if (!countTouched && fixedCount === undefined) {
        setCountText(String(memory.byProvider[choice.providerId]?.count ?? 1));
      }
    }
    setRequested(choice.providerId);
    setPicked(choice);
  };
  const setCount = (next: number) => {
    if (busy || signingIn) return;
    setCountTouched(true);
    setCountText(String(clampAgentCount(next)));
  };

  const ready = bindingsReady && restoredAccounts !== null;
  const canLaunch =
    !busy &&
    !signingIn &&
    ready &&
    !providerPending &&
    !!selectedAccountId &&
    !!selectedSession?.usable &&
    !accountLoadError &&
    !unavailableCursorModel;

  const launch = async (spec: AgentLaunchSpec, launchedModelName: string | null) => {
    if (submitting.current) return;
    submitting.current = true;
    let started: number;
    try {
      const result = await onLaunch(spec);
      started = typeof result === "number" ? result : result ? spec.count : 0;
      if (started < spec.count) {
        if (fixedCount === undefined) setCountText(String(spec.count - started));
        // A real provider rejection persists expiry for this exact account. Restore that fact
        // inline, preserving model, effort and unfinished count for the reconnect action.
        await reloadAccounts();
        return;
      }
    } finally {
      submitting.current = false;
    }
    const rememberedCount = fixedCount === undefined ? spec.count : (memory.byProvider[spec.providerId]?.count ?? 1);
    setMemory(
      rememberLaunch({
        providerId: spec.providerId,
        accountId: spec.providerAccountId ?? "",
        model: spec.model ?? null,
        modelName: launchedModelName,
        effort: spec.effort ?? null,
        count: rememberedCount,
        workspaceId: workspace.id,
        boundAccountId: restoredAccounts
          ? boundLaunchAccount(restoredAccounts, bindings, spec.providerId, workspace.id)
          : null,
        at: new Date().toISOString(),
      }),
    );
    onClose();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    // Waits for the (local, fast) binding read, so the account shown is the one that runs.
    if (!canLaunch) return;
    await launch(
      { providerId, count, providerAccountId: selectedAccountId, model: model || null, effort: effort || null },
      modelName,
    );
  };
  const submitNow = () => formRef.current?.requestSubmit();

  // RECENT: the last launch, one click (or Enter when it is the highlighted config) to repeat.
  const last = purpose === "standard" ? memory.last : null;
  const recentAccount =
    last && providers.includes(last.providerId)
      ? launchAccounts(restoredAccounts ?? [], last.providerId).find((a) => a.id === last.accountId)
      : undefined;
  const recent = last && recentAccount ? { ...last, account: recentAccount } : null;
  const recentModels =
    recent?.providerId === "cursor"
      ? cursorModels?.accountId === recent.accountId
        ? cursorModels.models
        : undefined
      : recent
        ? models?.get(recent.providerId)
        : undefined;
  const recentModel =
    recent?.model && recentModels && !recentModels.some((m) => m.id === recent.model) ? null : (recent?.model ?? null);
  const recentSession = recent ? sessionOf(recent.account) : null;
  const recentIsSelected =
    !!recent &&
    recent.providerId === providerId &&
    recent.accountId === selectedAccountId &&
    (recentModel ?? "") === model &&
    (recent.effort ?? "") === effort &&
    (fixedCount ?? recent.count) === count;
  const launchRecent = () => {
    if (!recent || busy || signingIn || !recentSession?.usable || accountLoadError) return;
    if (recent.providerId === "cursor" && recent.model && !recentModels?.some((m) => m.id === recent.model)) {
      choose({ providerId: "cursor", accountId: recent.accountId });
      return;
    }
    void launch(
      {
        providerId: recent.providerId,
        count: fixedCount ?? recent.count,
        providerAccountId: recent.accountId,
        model: recentModel,
        effort: recent.effort && AGENT_EFFORTS[recent.providerId].includes(recent.effort) ? recent.effort : null,
      },
      recentModel ? (recentModels?.find((m) => m.id === recentModel)?.displayName ?? recent.modelName) : null,
    );
  };

  // Low quota: suggest (never switch to) a same-provider account with more left. This judges the
  // window that actually limits work (the 5-hour one can block before the weekly does) and names
  // it, since the rows' headline percentage is the weekly one.
  const lowWindow = account ? limitingLowWindow(usageOf(account.id)) : null;
  const alternative =
    account && lowWindow
      ? candidates.find((a) => {
          if (a.id === account.id || !sessionOf(a).usable) return false;
          const usage = usageOf(a.id);
          return usage.status === "fresh" && limitingWindow(usage) !== null && limitingLowWindow(usage) === null;
        })
      : undefined;

  const retry = async () => {
    if (retrying || busy) return;
    setRetrying(true);
    setRetryError(null);
    try {
      await reloadAccounts();
    } catch (failure) {
      setRetryError(toKalCodeError(failure).message);
    } finally {
      setRetrying(false);
    }
  };

  // Keyboard-first: arrows move between accounts, Enter launches, 1–9 / ± set the agent count.
  const moveTo = (choice: Choice | undefined) => {
    if (!choice) return;
    choose(choice);
    requestAnimationFrame(() => document.getElementById(optionId(id, choice))?.scrollIntoView?.({ block: "nearest" }));
  };
  const onListKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (busy || signingIn) return;
    const index = activeChoice
      ? choices.findIndex((c) => c.providerId === activeChoice.providerId && c.accountId === activeChoice.accountId)
      : -1;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        moveTo(choices[Math.min(choices.length - 1, index + 1)]);
        break;
      case "ArrowUp":
        event.preventDefault();
        moveTo(choices[Math.max(0, index - 1)]);
        break;
      case "Home":
        event.preventDefault();
        moveTo(choices[0]);
        break;
      case "End":
        event.preventDefault();
        moveTo(choices[choices.length - 1]);
        break;
      case "Enter":
        event.preventDefault();
        submitNow();
        break;
    }
  };
  const onFormKey = (event: KeyboardEvent<HTMLFormElement>) => {
    const target = event.target as HTMLElement;
    if (fixedCount !== undefined || busy || event.metaKey || event.ctrlKey || event.altKey) return;
    if (target.closest("input, textarea, select, [contenteditable='true']")) return;
    if (/^[1-9]$/.test(event.key)) {
      event.preventDefault();
      setCount(Number(event.key));
    } else if (event.key === "0") {
      event.preventDefault();
      setCount(MAX_AGENTS_PER_LAUNCH);
    } else if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      setCount(count + 1);
    } else if (event.key === "-" || event.key === "_") {
      event.preventDefault();
      setCount(count - 1);
    }
  };

  const showSignIn =
    restoredAccounts !== null &&
    !accountLoadError &&
    !providerPending &&
    isBrowserAuthProvider(providerId) &&
    (signingIn || candidates.length === 0 || account?.authenticationState === "not_authenticated");
  const others: { label: string; icon: ReactNode; run: () => void }[] = [];
  if (onNewTerminal) others.push({ label: "Terminal", icon: <SquareTerminal />, run: onNewTerminal });
  if (onOpenBrowser) others.push({ label: "Live Browser", icon: <Globe />, run: onOpenBrowser });
  if (onAddWidget) others.push({ label: "Widget", icon: <LayoutGrid />, run: onAddWidget });
  if (onOpenSquads) others.push({ label: "Squads", icon: <UsersRound />, run: onOpenSquads });

  return (
    <Dialog.Root open onOpenChange={(open) => (open || busy ? undefined : onClose())}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content
          className={styles.dialog}
          aria-describedby={`${id}-desc`}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            listRef.current?.focus({ preventScroll: true });
          }}
        >
          <form ref={formRef} className={styles.form} onSubmit={submit} onKeyDown={onFormKey} aria-label="New agent">
            <div className={styles.body}>
              <header className={styles.head}>
                <span className={styles.icon} aria-hidden="true">
                  <Bot />
                </span>
                <div className={styles.headText}>
                  <Dialog.Title className={styles.title}>
                    {purpose === "handoff" ? "New recipient agent" : "New agent"}
                  </Dialog.Title>
                  <Dialog.Description id={`${id}-desc`} className={styles.description}>
                    A real coding agent in its own terminal in <strong>{workspace.name}</strong>.
                    {purpose === "handoff" ? " Your handoff draft stays open for review." : ""}
                  </Dialog.Description>
                </div>
                <kbd className={styles.esc}>Esc</kbd>
              </header>

              {recent ? (
                <section className={styles.block} aria-labelledby={`${id}-recent`}>
                  <h3 className={styles.eyebrow} id={`${id}-recent`}>
                    Recent
                  </h3>
                  <button
                    type="button"
                    className={styles.recent}
                    data-current={recentIsSelected || undefined}
                    disabled={busy || signingIn || !recentSession?.usable || !!accountLoadError}
                    aria-label={`Repeat last: ${[
                      providerIdentity(recent.providerId).name,
                      accountName(recent.account),
                      recentModel ? (recent.modelName ?? recentModel) : "default model",
                      recent.effort ? effortLabel(recent.effort) : null,
                      (fixedCount ?? recent.count) > 1 ? `${fixedCount ?? recent.count} agents` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}`}
                    onClick={launchRecent}
                  >
                    <span className={styles.recentIcon} aria-hidden="true">
                      <RotateCcw />
                    </span>
                    <ProviderGlyph provider={recent.providerId} size="xs" />
                    <span className={styles.recentText}>
                      <strong>{accountName(recent.account)}</strong>
                      <span className={styles.sep}>·</span>
                      <span>
                        {recentModel
                          ? (recentModels?.find((m) => m.id === recentModel)?.displayName ??
                            recent.modelName ??
                            recentModel)
                          : "Default model"}
                      </span>
                      {recent.effort ? (
                        <>
                          <span className={styles.sep}>·</span>
                          <span>{effortLabel(recent.effort)}</span>
                        </>
                      ) : null}
                      {(fixedCount ?? recent.count) > 1 ? (
                        <>
                          <span className={styles.sep}>·</span>
                          <span className={styles.num}>×{fixedCount ?? recent.count}</span>
                        </>
                      ) : null}
                    </span>
                    <UsageMeter usage={usageOf(recent.accountId)} />
                    <span className={styles.recentGo} aria-hidden="true">
                      {recentIsSelected ? <CornerDownLeft /> : "Launch"}
                    </span>
                  </button>
                </section>
              ) : null}

              <section className={styles.block} aria-label="Accounts">
                {accountLoadError ? (
                  <div className={styles.problem}>
                    <p role="alert">Accounts unavailable</p>
                    {retryError ? <p role="alert">{retryError}</p> : null}
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      busy={retrying}
                      disabled={busy}
                      onClick={() => void retry()}
                    >
                      Try again
                    </Button>
                  </div>
                ) : restoredAccounts === null ? (
                  <div className={styles.restoring} role="status">
                    <span className={styles.skeleton} />
                    <span className={styles.skeleton} />
                    <span className={styles.restoringText}>Restoring accounts…</span>
                  </div>
                ) : (
                  <div
                    ref={listRef}
                    className={styles.list}
                    role="listbox"
                    aria-label="Account"
                    aria-describedby={others.length === 0 ? `${id}-keys` : undefined}
                    aria-activedescendant={activeChoice ? optionId(id, activeChoice) : undefined}
                    aria-disabled={busy || signingIn || undefined}
                    tabIndex={0}
                    onKeyDown={onListKey}
                  >
                    {groups.map((group) => {
                      const groupName = providerIdentity(group.providerId).name;
                      return (
                        // biome-ignore lint/a11y/useSemanticElements: an ARIA listbox group of options, not form fields.
                        <div
                          key={group.providerId}
                          className={styles.group}
                          role="group"
                          aria-labelledby={`${id}-group-${group.providerId}`}
                        >
                          <div className={styles.groupHead} id={`${id}-group-${group.providerId}`}>
                            <ProviderGlyph provider={group.providerId} size="xs" />
                            <span>{groupName}</span>
                          </div>
                          {group.accounts.length === 0 ? (
                            <AccountRow
                              id={optionId(id, { providerId: group.providerId, accountId: "" })}
                              selected={activeChoice?.providerId === group.providerId}
                              name={`No ${groupName} account added yet`}
                              meta="Add one to launch"
                              status={{ label: "Add", tone: "accent" }}
                              onPick={() => choose({ providerId: group.providerId, accountId: "" })}
                            />
                          ) : (
                            group.accounts.map((a) => {
                              const usage = usageOf(a.id);
                              const same = sameSignIn.get(a.id);
                              return (
                                <AccountRow
                                  key={a.id}
                                  id={optionId(id, { providerId: group.providerId, accountId: a.id })}
                                  selected={
                                    activeChoice?.providerId === group.providerId && activeChoice.accountId === a.id
                                  }
                                  name={accountName(a)}
                                  meta={
                                    same
                                      ? `Same sign-in as ${same}`
                                      : [
                                          usage.plan ?? "Plan unavailable",
                                          a.providerReportedIdentity ?? (a.isDefault ? "Default" : null),
                                        ]
                                          .filter(Boolean)
                                          .join(" · ")
                                  }
                                  metaTone={same ? "notice" : undefined}
                                  usage={usage}
                                  status={rowStatus(sessionOf(a))}
                                  onPick={() => choose({ providerId: group.providerId, accountId: a.id })}
                                  onLaunch={submitNow}
                                />
                              );
                            })
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {providerPending ? (
                  <p className={styles.note} role="status">
                    Checking {requestedName}…
                  </p>
                ) : requested !== providerId ? (
                  <p className={styles.note} role="status">
                    {requestedName} isn't available here yet. Choose another account.
                  </p>
                ) : null}
                {alternative && account && lowWindow ? (
                  <p className={styles.lowHint}>
                    <span>
                      {accountName(account)} is running low on its {lowWindow.label.toLowerCase()} limit. Use{" "}
                      {accountName(alternative)} instead?
                    </span>
                    <button
                      type="button"
                      className={styles.linkButton}
                      disabled={busy}
                      onClick={() => choose({ providerId, accountId: alternative.id })}
                    >
                      Use {accountName(alternative)}
                    </button>
                  </p>
                ) : null}
                {showSignIn ? (
                  <div className={styles.signIn}>
                    <p className={styles.signInText}>
                      {account
                        ? `${accountName(account)} needs to reconnect.`
                        : `Add a ${providerName} account to launch ${providerName} agents.`}
                    </p>
                    <LaunchSignIn
                      key={providerId}
                      providerId={providerId}
                      providerName={providerName}
                      account={account}
                      needed
                      disabled={busy}
                      onReload={reloadAccounts}
                      onBusyChange={setSigningIn}
                      reconnect={!!account}
                      onConnected={async (connected) => {
                        setPicked({ providerId, accountId: connected.id });
                        await launch(
                          {
                            providerId,
                            providerAccountId: connected.id,
                            count,
                            model: model || null,
                            effort: effort || null,
                          },
                          modelName,
                        );
                      }}
                    />
                  </div>
                ) : null}
              </section>

              <section className={styles.config} aria-label="Launch settings">
                <ChipGroup
                  label="Model"
                  value={model}
                  options={modelOptions}
                  disabled={busy || signingIn || providerPending}
                  pending={providerModels === null}
                  onChange={(next) => setConfig((c) => ({ ...c, providerId, model: next }))}
                />
                {providerId === "cursor" && currentCursorModels?.error ? (
                  <p className={styles.signInText} role="status">
                    {currentCursorModels.error} Use Cursor's native model picker in the terminal.
                  </p>
                ) : null}
                {unavailableCursorModel ? (
                  <p className={styles.error} role="alert">
                    {currentCursorModels?.error
                      ? "Model availability could not be verified"
                      : "Model unavailable for this account"}
                    : {rawModel}. Choose an available model or Default.
                  </p>
                ) : null}
                {efforts.length > 0 ? (
                  <ChipGroup
                    label="Effort"
                    value={effort}
                    options={[
                      { value: "", label: "Default" },
                      ...efforts.map((level) => ({ value: level, label: effortLabel(level) })),
                    ]}
                    disabled={busy || signingIn || providerPending}
                    onChange={(next) => setConfig((c) => ({ ...c, providerId, effort: next }))}
                  />
                ) : null}
                {fixedCount === undefined ? (
                  <div className={styles.configRow}>
                    <label className={styles.configLabel} htmlFor={`${id}-count`}>
                      Agents
                    </label>
                    <div className={styles.countWrap}>
                      <div className={styles.stepper}>
                        <IconButton
                          size="sm"
                          label="One fewer agent"
                          icon={<Minus />}
                          disabled={busy || signingIn || count <= 1}
                          onClick={() => setCount(count - 1)}
                        />
                        <input
                          id={`${id}-count`}
                          className={styles.count}
                          type="number"
                          inputMode="numeric"
                          min={1}
                          max={MAX_AGENTS_PER_LAUNCH}
                          value={countText}
                          disabled={busy || signingIn}
                          aria-describedby={`${id}-count-hint`}
                          onChange={(e) => {
                            setCountTouched(true);
                            setCountText(e.target.value);
                          }}
                          onBlur={() => setCountText(String(count))}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              setCountText(String(count));
                              submitNow();
                            }
                          }}
                        />
                        <IconButton
                          size="sm"
                          label="One more agent"
                          icon={<Plus />}
                          disabled={busy || signingIn || count >= MAX_AGENTS_PER_LAUNCH}
                          onClick={() => setCount(count + 1)}
                        />
                      </div>
                      <span className={styles.countHint} id={`${id}-count-hint`}>
                        Each agent gets its own terminal.
                      </span>
                    </div>
                  </div>
                ) : (
                  <p className={styles.handoffCount}>
                    <span className={styles.configLabel}>Recipient</span>
                    <span>One agent · draft returns for review before sending</span>
                  </p>
                )}
              </section>

              {error ? (
                <p className={styles.error} role="alert">
                  {error}
                </p>
              ) : null}
            </div>

            <footer className={styles.actions}>
              {others.length > 0 ? (
                // biome-ignore lint/a11y/useSemanticElements: a labelled group of buttons, not form fields.
                <div className={styles.others} role="group" aria-label="Other">
                  <span className={styles.eyebrow}>Other</span>
                  {others.map((o) => (
                    <button
                      key={o.label}
                      type="button"
                      className={styles.other}
                      disabled={busy}
                      onClick={() => {
                        o.run();
                        onClose();
                      }}
                    >
                      <span aria-hidden="true">{o.icon}</span>
                      {o.label}
                    </button>
                  ))}
                </div>
              ) : (
                <p className={styles.keys} id={`${id}-keys`}>
                  <span>
                    <kbd>↑</kbd>
                    <kbd>↓</kbd> choose
                  </span>
                  {fixedCount === undefined ? (
                    <span>
                      <kbd>1–9</kbd> agents
                    </span>
                  ) : null}
                  <span>
                    <kbd>↵</kbd> launch
                  </span>
                </p>
              )}
              <div className={styles.buttons}>
                <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  className={styles.launch}
                  busy={busy}
                  disabled={!canLaunch && !busy}
                  icon={<ProviderGlyph provider={providerId} size="xs" />}
                >
                  {launchLabel(count, providerName)}
                </Button>
              </div>
            </footer>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function AccountRow({
  id,
  selected,
  name,
  meta,
  metaTone,
  usage,
  status,
  onPick,
  onLaunch,
}: {
  id: string;
  selected: boolean;
  name: string;
  meta: string;
  metaTone?: "notice";
  usage?: AccountUsageState;
  status: { label: string; tone: RowTone };
  onPick: () => void;
  onLaunch?: () => void;
}) {
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the listbox owns keyboard selection (aria-activedescendant).
    // biome-ignore lint/a11y/useFocusableInteractive: options are reached through the listbox's aria-activedescendant.
    <div
      id={id}
      role="option"
      aria-selected={selected}
      className={styles.option}
      onClick={onPick}
      onDoubleClick={onLaunch}
    >
      <span className={styles.radio} aria-hidden="true" />
      <span className={styles.who}>
        <span className={styles.name}>{name}</span>
        {meta ? (
          <span className={styles.meta} data-tone={metaTone}>
            {meta}
          </span>
        ) : null}
      </span>
      {usage ? <UsageMeter usage={usage} className={styles.usage} /> : null}
      <span className={styles.status} data-tone={status.tone}>
        <span className={styles.statusDot} aria-hidden="true" />
        {status.label}
      </span>
    </div>
  );
}

/** A labelled single-choice row of chips (radio semantics, roving focus, arrows select). */
function ChipGroup({
  label,
  value,
  options,
  disabled,
  pending,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  disabled?: boolean;
  pending?: boolean;
  onChange: (value: string) => void;
}) {
  const labelId = useId();
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const selectedIndex = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (!step || disabled) return;
    event.preventDefault();
    const next = options[(selectedIndex + step + options.length) % options.length];
    if (!next) return;
    onChange(next.value);
    refs.current.get(next.value)?.focus();
  };
  return (
    <div className={styles.configRow}>
      <span className={styles.configLabel} id={labelId}>
        {label}
      </span>
      <div
        className={styles.chips}
        role="radiogroup"
        aria-labelledby={labelId}
        aria-busy={pending || undefined}
        onKeyDown={onKey}
      >
        {options.map((option, index) => (
          // biome-ignore lint/a11y/useSemanticElements: chip radios with roving focus; native radios can't take this styling.
          <button
            key={option.value || "default"}
            ref={(node) => {
              if (node) refs.current.set(option.value, node);
              else refs.current.delete(option.value);
            }}
            type="button"
            role="radio"
            aria-checked={index === selectedIndex}
            tabIndex={index === selectedIndex ? 0 : -1}
            className={styles.chip}
            disabled={disabled}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
        {pending ? <span className={styles.chipPending} aria-hidden="true" /> : null}
      </div>
    </div>
  );
}

/** The fresh window that limits this account when it is under LOW_USAGE_PERCENT, else null. */
function limitingLowWindow(usage: AccountUsageState): UsageWindow | null {
  const window = usage.status === "fresh" ? limitingWindow(usage) : null;
  return window && window.remainingPercent < LOW_USAGE_PERCENT ? window : null;
}
