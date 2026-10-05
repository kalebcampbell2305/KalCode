import type { PaneInfo, ProviderAccount, ThreadSummary } from "@kalcode/protocol";
import { expect, it } from "vitest";
import {
  canStopPane,
  duplicatePaneInput,
  duplicatePlacement,
  paneRebindAccounts,
  rememberDuplicatePlacement,
} from "./paneContextActions.ts";

const thread = {
  id: "source",
  providerId: "codex",
  providerAccountId: "current",
  archivedAt: null,
  status: "idle",
  pendingApprovals: 0,
} as ThreadSummary;
const account = (id: string, overrides: Partial<ProviderAccount> = {}) =>
  ({
    id,
    providerId: "codex",
    archivedAt: null,
    authenticationState: "authenticated",
    ...overrides,
  }) as ProviderAccount;

it("never offers account changes for live PTYs, unknown process state, working agents, or pending approvals", () => {
  const accounts = [account("other")];
  expect(paneRebindAccounts(thread, { running: true } as PaneInfo, accounts)).toEqual([]);
  expect(paneRebindAccounts(thread, null, accounts)).toEqual([]);
  expect(paneRebindAccounts({ ...thread, status: "running_tool" }, { running: false } as PaneInfo, accounts)).toEqual(
    [],
  );
  expect(paneRebindAccounts({ ...thread, pendingApprovals: 1 }, { running: false } as PaneInfo, accounts)).toEqual([]);
});

it("offers only a different usable same-provider account after the CLI stops", () => {
  const usable = account("other");
  expect(
    paneRebindAccounts(thread, { running: false } as PaneInfo, [
      account("current"),
      usable,
      account("archived", { archivedAt: "2026-01-01" }),
      account("signed-out", { authenticationState: "not_authenticated" }),
      account("different", { providerId: "claude-code" }),
    ]),
  ).toEqual([usable]);
});

it("duplicates exact launch settings without widening permission mode or copying a provider session", () => {
  const source = {
    ...thread,
    name: "Review",
    workspaceId: "clicked-workspace",
    permissionMode: "plan",
    model: "exact-model",
    effort: "high",
  } as ThreadSummary;
  expect(duplicatePaneInput(source)).toEqual({
    sourceThreadId: "source",
    providerId: "codex",
    providerAccountId: "current",
    workspaceId: "clicked-workspace",
    permissionMode: "plan",
    model: "exact-model",
    effort: "high",
    name: null,
  });
  expect(duplicatePaneInput({ ...source, permissionMode: "custom" })).toBeNull();
  expect(duplicatePaneInput({ ...source, archivedAt: "2026-01-01" })).toBeNull();
});

it("offers Stop for a live or queued coding agent and omits it after the process exits", () => {
  expect(canStopPane(thread, { running: true } as PaneInfo)).toBe(true);
  expect(canStopPane({ ...thread, status: "starting" }, null)).toBe(true);
  expect(canStopPane({ ...thread, status: "waiting_for_dependency" }, null)).toBe(true);
  expect(canStopPane({ ...thread, status: "completed" }, { running: false } as PaneInfo)).toBe(false);
});

it("defaults to beside the source and remembers the selected workspace placement", () => {
  expect(duplicatePlacement("new-workspace")).toBe("split");
  rememberDuplicatePlacement("new-workspace", "tab");
  expect(duplicatePlacement("new-workspace")).toBe("tab");
  expect(duplicatePlacement("different-workspace")).toBe("split");
  rememberDuplicatePlacement("new-workspace", "split");
});
