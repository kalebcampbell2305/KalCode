import type { ModelInfo, ProviderAccount, ProviderAccountBinding, Workspace } from "@kalcode/protocol";
import { Button, Field, IconButton, ProviderGlyph, SegmentedControl, Select, TextInput } from "@kalcode/ui/components";
import { Bot, Minus, Plus } from "lucide-react";
import { Dialog } from "radix-ui";
import { type FormEvent, useCallback, useEffect, useId, useState } from "react";
import { useRuntime } from "../../runtime/RuntimeProvider.tsx";
import { accountSessionState } from "../providers/accountIdentity.ts";
import { LaunchAccountPicker } from "../providers/LaunchAccountPicker.tsx";
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
  bindings: readonly ProviderAccountBinding[];
}

const EMPTY: LaunchData = { models: new Map(), bindings: [] };

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
  const [selection, setSelection] = useState<{ scope: string; id: string } | null>(null);
  const scope = `${providerId}:${workspace.id}`;
  const accountId = selection?.scope === scope ? selection.id : "";
  const setAccountId = (id: string) => setSelection({ scope, id });
  const [bindingsReady, setBindingsReady] = useState(false);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [localAccounts, setLocalAccounts] = useState<readonly ProviderAccount[] | null>(null);
  const [localAccountError, setLocalAccountError] = useState<string | null>(null);
  // What the person typed; the launch uses it clamped, so editing "1" to "5" never passes through 15.
  const [countText, setCountText] = useState("1");
  const count = clampAgentCount(Number(countText));

  const reloadAccounts = useCallback(async () => {
    try {
      const [accounts, bindings] = await Promise.all([
        sessions ? sessions.reload() : client.listProviderAccounts(),
        client.listProviderAccountBindings({ kind: "workspace" }),
      ]);
      setLocalAccounts(accounts);
      setData((current) => ({ ...EMPTY, ...current, bindings }));
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
    // Account selection never waits for provider/model detection.
    client.listProviderAccountBindings({ kind: "workspace" }).then(
      (bindings) => {
        if (!cancelled) {
          setData((current) => ({ ...EMPTY, ...current, bindings }));
          setBindingsReady(true);
        }
      },
      () => {
        if (!cancelled) setLocalAccountError("Workspace accounts unavailable");
      },
    );
    client.threadOptions().then(
      (options) => {
        if (!cancelled)
          setData((current) => ({
            ...EMPTY,
            ...current,
            models: new Map(options.providers.map((p) => [p.id, p.models])),
          }));
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [client, sharedSessions]);

  const loaded = data ?? EMPTY;
  const restoredAccounts = sessions ? sessions.accounts : localAccounts;
  const accounts = launchAccounts(restoredAccounts ?? [], providerId);
  const models = loaded.models.get(providerId) ?? [];
  const efforts = AGENT_EFFORTS[providerId];
  const name = providerIdentity(providerId).name;
  const preselectedAccountId = restoredAccounts
    ? preselectLaunchAccount(restoredAccounts, loaded.bindings, providerId, workspace.id)
    : null;
  // Resolve on the first ready paint, retaining an explicit choice as background checks settle.
  const selectedAccountId = accounts.some((account) => account.id === accountId)
    ? accountId
    : (preselectedAccountId ?? "");
  const chooseProvider = (next: PaneProviderId) => {
    setProviderId(next);
    setModel("");
    setEffort("");
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    // Waits for the (local, fast) account read, so the account shown is the one that runs.
    if (
      busy ||
      !bindingsReady ||
      !restoredAccounts ||
      !selectedAccountId ||
      !selectedSession?.usable ||
      accountLoadError
    )
      return;
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
  const ready = bindingsReady && restoredAccounts !== null;
  const accountLoadError = (sessions?.accounts === null ? sessions.loadError : null) ?? localAccountError;
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

            <LaunchAccountPicker
              providerId={providerId}
              providerName={name}
              accounts={restoredAccounts}
              value={selectedAccountId}
              onChange={setAccountId}
              onReload={reloadAccounts}
              disabled={busy}
              error={accountLoadError}
            />

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
                disabled={!ready || !selectedAccountId || !selectedSession?.usable || !!accountLoadError}
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
