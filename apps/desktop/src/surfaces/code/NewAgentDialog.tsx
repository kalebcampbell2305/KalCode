import type { ModelInfo, ProviderAccount, ProviderAccountBinding, Workspace } from "@kalcode/protocol";
import { Button, Field, IconButton, ProviderGlyph, SegmentedControl, Select, TextInput } from "@kalcode/ui/components";
import { Bot, Minus, Plus } from "lucide-react";
import { Dialog } from "radix-ui";
import { type FormEvent, useEffect, useId, useState } from "react";
import { useRuntime } from "../../runtime/RuntimeProvider.tsx";
import { accountName, accountSignIn } from "../providers/accountIdentity.ts";
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
  accounts: readonly ProviderAccount[];
  bindings: readonly ProviderAccountBinding[];
}

const EMPTY: LaunchData = { models: new Map(), accounts: [], bindings: [] };

/** "Work", "Work · Default", "Work · Signed out". */
function accountOption(account: ProviderAccount): string {
  const parts = [accountName(account)];
  if (account.isDefault) parts.push("Default");
  if (account.authenticationState !== "authenticated") parts.push(accountSignIn(account).label);
  return parts.join(" · ");
}

export interface NewAgentDialogProps {
  workspace: Workspace;
  /** Codex / Gemini CLI when this build can run them (Claude Code is always offered). */
  offered: readonly PaneProviderId[];
  initialProvider: PaneProviderId;
  busy: boolean;
  error: string | null;
  /** Starts the agents; resolves true when every one started (the dialog then closes). */
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
  const id = useId();
  const providers = PANE_PROVIDERS.filter((p) => p === "claude-code" || offered.includes(p));
  const [providerId, setProviderId] = useState<PaneProviderId>(
    providers.includes(initialProvider) ? initialProvider : "claude-code",
  );
  const [data, setData] = useState<LaunchData | null>(null);
  const [accountId, setAccountId] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [count, setCount] = useState(1);

  // Models, accounts and the workspace's remembered accounts. A read that fails leaves the
  // provider defaults, which native resolves the same way.
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      client.threadOptions().catch(() => null),
      client.listProviderAccounts().catch(() => []),
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
  }, [client]);

  const loaded = data ?? EMPTY;
  const accounts = launchAccounts(loaded.accounts, providerId);
  const models = loaded.models.get(providerId) ?? [];
  const efforts = AGENT_EFFORTS[providerId];
  const name = providerIdentity(providerId).name;

  // A provider (or the loaded accounts) changing picks that provider's account again.
  useEffect(() => {
    if (!data) return;
    setAccountId(preselectLaunchAccount(data.accounts, data.bindings, providerId, workspace.id));
  }, [data, providerId, workspace.id]);

  const chooseProvider = (next: PaneProviderId) => {
    setProviderId(next);
    setModel("");
    setEffort("");
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    // Waits for the (local, fast) account read, so the account shown is the one that runs.
    if (busy || !data) return;
    const ok = await onLaunch({
      providerId,
      count: clampAgentCount(count),
      providerAccountId: accountId || null,
      model: model || null,
      effort: effort || null,
    });
    if (ok) onClose();
  };

  const account = accounts.find((a) => a.id === accountId);
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
                  value={accountId}
                  disabled={busy}
                  onChange={(event) => setAccountId(event.target.value)}
                >
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {accountOption(a)}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : (
              <p className={styles.account}>
                <span className={styles.label}>Account</span>
                <span className={styles.accountValue}>
                  {account ? accountOption(account) : data ? `No ${name} account added yet` : "Checking…"}
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
                  onClick={() => setCount((n) => clampAgentCount(n - 1))}
                />
                <TextInput
                  id={`${id}-count`}
                  className={styles.count}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={MAX_AGENTS_PER_LAUNCH}
                  value={count}
                  disabled={busy}
                  aria-describedby={`${id}-count-hint`}
                  onChange={(e) => setCount(clampAgentCount(Number(e.target.value)))}
                />
                <IconButton
                  size="sm"
                  label="One more agent"
                  icon={<Plus />}
                  disabled={busy || count >= MAX_AGENTS_PER_LAUNCH}
                  onClick={() => setCount((n) => clampAgentCount(n + 1))}
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
                disabled={!data}
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
