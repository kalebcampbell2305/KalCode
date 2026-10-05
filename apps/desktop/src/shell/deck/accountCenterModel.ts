import type { ProviderAccount, ProviderAccountBinding, ThreadSummary } from "@kalcode/protocol";
import { preselectLaunchAccount } from "../../surfaces/code/panes/agentLaunch.ts";
import { accountSessionState } from "../../surfaces/providers/accountIdentity.ts";
import type { SelectedCodeContext, SelectedThread } from "../../surfaces/threads/accountIntent.ts";

/** Provider quota is not exposed by this contract. Authentication is never a quota estimate. */
export function accountCenterStatus(account: ProviderAccount, checking = false, error?: string | null) {
  return accountCenterHealthStatus(accountSessionState(account, checking, error));
}

export function accountCenterHealthStatus(health: ReturnType<typeof accountSessionState>) {
  if (health.state === "checking") return { label: "Checking", tone: "attention" };
  if (health.state === "expired") return { label: "Signed out", tone: "danger" };
  if (health.state === "error") return { label: "Needs attention", tone: "attention" };
  return health.state === "connected"
    ? { label: "Ready", tone: "healthy" }
    : { label: "Not checked", tone: "attention" };
}

export function selectedLaunchAccount(
  accounts: readonly ProviderAccount[],
  bindings: readonly ProviderAccountBinding[],
  providerId: string,
  workspaceId: string | null,
): ProviderAccount | null {
  const id = preselectLaunchAccount(accounts, bindings, providerId, workspaceId ?? "");
  return accounts.find((a) => a.id === id) ?? null;
}

export function focusedAccountSession(
  threads: readonly ThreadSummary[],
  surface: string,
  workspaceId: string | null,
  code: SelectedCodeContext | null,
  selected: SelectedThread | null,
): ThreadSummary | null {
  if (surface === "threads") return threads.find((t) => t.id === selected?.threadId) ?? null;
  if (surface !== "code" || code?.workspaceId !== workspaceId || !code?.content) return null;
  const content = code.content;
  return (
    threads.find(
      (t) =>
        t.workspaceId === workspaceId &&
        (content.kind === "agent" ? t.id === content.agentId : t.terminalId === content.terminalId),
    ) ?? null
  );
}
