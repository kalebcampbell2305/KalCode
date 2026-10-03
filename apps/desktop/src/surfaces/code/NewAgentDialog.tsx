import type { ModelInfo, ProviderAccount, ProviderAccountBinding, Workspace } from "@kalcode/protocol";
import { Button, Field, IconButton, ProviderGlyph, SegmentedControl, Select, TextInput } from "@kalcode/ui/components";
import { Bot, Minus, Plus } from "lucide-react";
import { Dialog } from "radix-ui";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { useRuntime } from "../../runtime/RuntimeProvider.tsx";
import { accountName, accountSessionState } from "../providers/accountIdentity.ts";
import { useOptionalProviderAccountSessions } from "../providers/ProviderAccountSessions.tsx";
import styles from "./NewAgentDialog.module.css";
import {
  AGENT_EFFORTS,
  clampAgentCount,
  launchAccounts,
  launchLabel,
  MAX_AGENTS_PER_LAUNCH,
  preselectLaunchAccount,
} from "./panes/agentLaunch.ts";
import { PANE_PROVIDERS, type PaneProviderId } from "./panes/paneChannel.ts";
import { providerIdentity } from "./panes/paneLabels.ts";
import type { AgentLaunch } from "./panes/useProviderPanes.ts";

export interface AgentLaunchSpec extends AgentLaunch {
  providerId: PaneProviderId;
  count: number;
}

interface LaunchData {
  models: ReadonlyMap<string, readonly ModelInfo[]>;
  /** Direct-client fallback when rendered outside the shell account provider. */
  accounts: readonly ProviderAccount[] | null;
  bindings: readonly ProviderAccountBinding[];
}

const EMPTY: LaunchData = { models: new Map(), accounts: [], bindings: [] };

/** "Work", "Work · Default", "Work · Signed out". */
function accountOption(account: ProviderAccount, checking = false, validationError: string | null = null): string {
  const parts = [accountName(account)];
  if (account.isDefault) parts.push("Default");
  const session = accountSessionState(account, checking, validationError);
  if (session.state !== "connected") parts.push(session.label);
  return parts.join(" · ");
}

export interface NewAgentDialogProps {
  workspace: Workspace;
  /** Codex / Gemini CLI when this build can run them (Claude Code is always offered). */
  offered: readonly PaneProviderId[];
  initialProvider: PaneProviderId;
  busy: boolean;
  error: string | null;
  /** Starts the agents; resolves true when at least one started (the dialog then closes). */
  onLaunch: (spec: AgentLaunchSpec) => Promise<boolean>;
  onClose: () => void;
}

/**
 * Code's + launcher: start one or more coding agents (Claude Code, Codex or Gemini CLI in their
 * own terminal panes) with an exact account, model and effort.
 */
export function NewAgentDialog({
  workspace,
  offered,
  initialProvider,
  busy,
  error,
  onLaunch,
  onClose,
}: NewAgentDialogProps) {
  const { client } = useRuntime();
  const sessions = useOptionalProviderAccountSessions();
  const sharedSessions = sessions !== null;
  const id = useId();
  const providers = PANE_PROVIDERS.filter((p) => p === "claude-code" || offered.includes(p));
  const [providerId, setProviderId] = useState<PaneProviderId>(
    providers.includes(initialProvider) ? initialProvider : "claude-code",
  );
  const [data, setData] = useState<LaunchData | null>(null);
  const [accountId, setAccountId] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [retryingAccounts, setRetryingAccounts] = useState(false);
  // What the person typed; the launch uses it clamped, so editing "1" to "5" never passes through 15.
  const [countText, setCountText] = useState("1");
  const count = clampAgentCount(Number(countText));

  // Models, accounts and the workspace's remembered accounts. A read that fails leaves the
  // provider defaults, which native resolves the same way.
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      client.threadOptions().catch(() => null),
      sharedSessions ? Promise.resolve(null) : client.listProviderAccounts().catch(() => []),
      client.listProviderAccountBindings({ kind: "workspace" }).catch(() => []),
    ]).then(([options, accounts, bindings]) => {
      if (cancelled) return;
      setData({
        models: new Map((options?.providers ?? []).map((p) => [p.id, p.models])),
        accounts,
        bindings,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [client, sharedSessions]);

  const loaded = data ?? EMPTY;
  const restoredAccounts = sessions?.accounts ?? loaded.accounts;
  const accounts = launchAccounts(restoredAccounts ?? [], providerId);
  const models = loaded.models.get(providerId) ?? [];
  const efforts = AGENT_EFFORTS[providerId];
  const name = providerIdentity(providerId).name;
  const preselectedAccountId =
    data && restoredAccounts ? preselectLaunchAccount(restoredAccounts, data.bindings, providerId, workspace.id) : null;
  // The derived choice is already authoritative on the first ready paint. The effect below keeps
  // the controlled select in sync, but launch must never briefly submit a null account while that
  // effect is waiting to run.
  const selectedAccountId = accounts.some((account) => account.id === accountId)
    ? accountId
    : (preselectedAccountId ?? "");
  const preselectedAccountRef = useRef(preselectedAccountId);
  preselectedAccountRef.current = preselectedAccountId;
  const accountSelectionScope = [
    providerId,
    workspace.id,
    ...(restoredAccounts?.map((item) => `${item.id}:${Number(item.isDefault)}`) ?? ["loading"]),
    ...(data?.bindings.map((binding) => `${binding.providerId}:${binding.scopeId}:${binding.accountId}`) ?? []),
  ].join("|");

  // A provider (or the loaded accounts) changing picks that provider's account again.
  useEffect(() => {
    if (accountSelectionScope.length === 0 || preselectedAccountRef.current === null) return;
    setAccountId(preselectedAccountRef.current);
  }, [accountSelectionScope]);

  const chooseProvider = (next: PaneProviderId) => {
    setProviderId(next);
    setModel("");
    setEffort("");
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    // Waits for the (local, fast) account read, so the account shown is the one that runs.
    if (busy || !data || !restoredAccounts) return;
    const ok = await onLaunch({
      providerId,
      count,
      providerAccountId: selectedAccountId || null,
      model: model || null,
      effort: effort || null,
    });
    if (ok) onClose();
  };

  const account = accounts.find((a) => a.id === selectedAccountId);
  const selectedSession = account
    ? accountSessionState(
        account,
        sessions?.checking.has(account.id),
        sessions?.validationErrors.get(account.id) ?? null,
      )
    : null;
  const ready = data !== null && restoredAccounts !== null;
  const accountLoadError = sessions?.accounts === null ? sessions.loadError : null;
  const retryAccountRestore = async () => {
    if (!sessions || retryingAccounts) return;
    setRetryingAccounts(true);
    await sessions.reload();
    setRetryingAccounts(false);
  };
  return (
    <Dialog.Root open onOpenChange={(open) => (open || busy ? undefined : onClose())}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content className={styles.dialog} aria-describedby={`${id}-desc`}>
          <form className={styles.form} onSubmit={submit} aria-label="New agent">
            <div className={styles.head}>
              <span className={styles.icon} aria-hidden="true">
                <Bot />
              </span>
              <div>
                <Dialog.Title className={styles.title}>New agent</Dialog.Title>
                <Dialog.Description id={`${id}-desc`} className={styles.description}>
                  A real coding agent in its own terminal in <strong>{workspace.name}</strong>.
                </Dialog.Description>
              </div>
            </div>

            <div className={styles.section}>
              <span className={styles.label} id={`${id}-provider`}>
                Provider
              </span>
              <SegmentedControl
                aria-labelledby={`${id}-provider`}
                value={providerId}
                onValueChange={chooseProvider}
                disabled={busy}
                options={providers.map((p) => ({
                  value: p,
                  label: providerIdentity(p).name,
                  icon: <ProviderGlyph provider={p} size="xs" />,
                }))}
              />
            </div>

            {accounts.length > 1 ? (
              <Field htmlFor={`${id}-account`} label="Account">
                <Select
                  id={`${id}-account`}
                  value={selectedAccountId}
                  disabled={busy}
                  onChange={(event) => setAccountId(event.target.value)}
                >
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {accountOption(a, sessions?.checking.has(a.id), sessions?.validationErrors.get(a.id) ?? null)}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : (
              <p className={styles.account}>
                <span className={styles.label}>Account</span>
                <span className={styles.accountStatus}>
                  <span className={styles.accountValue} role={accountLoadError ? "alert" : undefined}>
                    {account
                      ? accountOption(
                          account,
                          sessions?.checking.has(account.id),
                          sessions?.validationErrors.get(account.id) ?? null,
                        )
                      : accountLoadError
                        ? "Accounts unavailable"
                        : ready
                          ? `No ${name} account added yet`
                          : "Restoring accounts…"}
                  </span>
                  {accountLoadError && sessions ? (
                    <Button type="button" variant="ghost" busy={retryingAccounts} onClick={retryAccountRestore}>
                      Try again
                    </Button>
                  ) : null}
                </span>
              </p>
            )}

            <div className={styles.grid}>
              <Field htmlFor={`${id}-model`} label="Model">
                <Select id={`${id}-model`} value={model} disabled={busy} onChange={(e) => setModel(e.target.value)}>
                  <option value="">Provider default</option>
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.displayName}
                    </option>
                  ))}
                </Select>
              </Field>
              {efforts.length > 0 ? (
                <Field htmlFor={`${id}-effort`} label="Effort">
                  <Select
                    id={`${id}-effort`}
                    value={effort}
                    disabled={busy}
                    onChange={(e) => setEffort(e.target.value)}
                  >
                    <option value="">Provider default</option>
                    {efforts.map((level) => (
                      <option key={level} value={level}>
                        {level === "xhigh" ? "Extra high" : level[0]?.toUpperCase() + level.slice(1)}
                      </option>
                    ))}
                  </Select>
                </Field>
              ) : null}
            </div>

            <Field htmlFor={`${id}-count`} label="Agents" hint="Each agent gets its own terminal.">
              <div className={styles.stepper}>
                <IconButton
                  size="sm"
                  label="One fewer agent"
                  icon={<Minus />}
                  disabled={busy || count <= 1}
                  onClick={() => setCountText(String(clampAgentCount(count - 1)))}
                />
                <TextInput
                  id={`${id}-count`}
                  className={styles.count}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={MAX_AGENTS_PER_LAUNCH}
                  value={countText}
                  disabled={busy}
                  aria-describedby={`${id}-count-hint`}
                  onChange={(e) => setCountText(e.target.value)}
                  onBlur={() => setCountText(String(count))}
                />
                <IconButton
                  size="sm"
                  label="One more agent"
                  icon={<Plus />}
                  disabled={busy || count >= MAX_AGENTS_PER_LAUNCH}
                  onClick={() => setCountText(String(clampAgentCount(count + 1)))}
                />
              </div>
            </Field>

            {error ? (
              <p className={styles.error} role="alert">
                {error}
              </p>
            ) : null}

            <div className={styles.actions}>
              <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                busy={busy}
                disabled={!ready || selectedSession?.usable === false}
                icon={<ProviderGlyph provider={providerId} size="xs" />}
              >
                {launchLabel(count, name)}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
