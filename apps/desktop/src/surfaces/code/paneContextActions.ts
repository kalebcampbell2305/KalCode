import type { PaneInfo, ProviderAccount, ThreadSummary } from "@kalcode/protocol";
import { rebindBlocker } from "../threads/useThreadAccount.ts";
import { type CreatePaneInput, isPaneProvider } from "./panes/paneChannel.ts";

/** A duplicate is a fresh coding session with the same exact provider launch settings. */
export function duplicatePaneInput(thread: ThreadSummary): CreatePaneInput | null {
  if (!isPaneProvider(thread.providerId) || thread.permissionMode === "custom" || thread.archivedAt !== null)
    return null;
  return {
    sourceThreadId: thread.id,
    providerId: thread.providerId,
    providerAccountId: thread.providerAccountId,
    workspaceId: thread.workspaceId,
    model: thread.model,
    effort: thread.effort,
    permissionMode: thread.permissionMode,
    name: `${[...thread.name].slice(0, 73).join("")} (copy)`,
  };
}

export function canStopPane(thread: ThreadSummary, info: PaneInfo | null): boolean {
  return Boolean(info?.running || thread.status === "starting" || thread.status === "waiting_for_dependency");
}

/** A live CLI owns its sign-in for its entire process lifetime, even when its prompt is idle. */
export function paneRebindAccounts(
  thread: ThreadSummary,
  info: PaneInfo | null,
  accounts: readonly ProviderAccount[],
): ProviderAccount[] {
  if (!info || info.running || rebindBlocker(thread)) return [];
  return accounts.filter(
    (account) =>
      account.providerId === thread.providerId &&
      account.id !== thread.providerAccountId &&
      account.archivedAt === null &&
      account.authenticationState !== "not_authenticated",
  );
}

export type DuplicatePlacement = "split" | "tab";
const placementKey = (workspaceId: string) => `kalcode:duplicate-placement:${workspaceId}`;
export function duplicatePlacement(workspaceId: string): DuplicatePlacement {
  try {
    return localStorage.getItem(placementKey(workspaceId)) === "tab" ? "tab" : "split";
  } catch {
    return "split";
  }
}
export function rememberDuplicatePlacement(workspaceId: string, placement: DuplicatePlacement): void {
  try {
    localStorage.setItem(placementKey(workspaceId), placement);
  } catch {
    /* Optional preference. */
  }
}
