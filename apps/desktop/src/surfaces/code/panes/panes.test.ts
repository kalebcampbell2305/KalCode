import type {
  ApprovalView,
  PaneInfo,
  PermissionMode,
  ProviderAccount,
  ThreadStatus,
  ThreadSummary,
  Workspace,
} from "@kalcode/protocol";
import { READY_ACTIVITY } from "@kalcode/protocol";
import { render, screen } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { KalCodeClient } from "../../../ipc/client.ts";
import { createMemoryTransport, type MemoryTransport } from "../../../ipc/memoryTransport.ts";
import {
  PaneAccountChip,
  PaneStatusChip,
  paneAccountLabel,
  resolvePaneAccount,
  samePaneAccount,
} from "./PaneParts.tsx";
import { PaneChannel, paneStartMode, resolvePaneStartMode, splitInput } from "./paneChannel.ts";
import {
  approvalAnnouncement,
  canResumePane,
  channelNote,
  endedSummary,
  isAnswerInProvider,
  paneEffort,
  paneInfoCopy,
  paneLabel,
  paneModel,
  paneStatus,
  providerIdentity,
} from "./paneLabels.ts";

function requirePaneAccount(value: ReturnType<typeof resolvePaneAccount>) {
  if (value === null) throw new Error("expected a pane account identity");
  return value;
}

function info(partial: Partial<PaneInfo>): PaneInfo {
  return {
    threadId: "t",
    providerId: "claude-code",
    instanceId: "pane-instance",
    hookChannel: "active",
    decisionRouting: "engine",
    kalcodeAnswersApprovals: true,
    running: true,
    exitCode: null,
    ...partial,
  };
}

describe("pane labels", () => {
  it("maps agents through the shared agent-state model, never colour alone", () => {
    const agent = (status: ThreadStatus, more: Partial<ThreadSummary> = {}) => ({
      status,
      currentActivity: null,
      pendingApprovals: 0,
      ...more,
    });
    expect(paneStatus(agent("waiting_for_permission"))).toMatchObject({ label: "NEEDS YOU", tone: "waiting" });
    expect(paneStatus(agent("running_command"))).toMatchObject({ label: "WORKING", tone: "working" });
    expect(paneStatus(agent("testing"))).toMatchObject({ label: "TESTING", tone: "working" });
    expect(paneStatus(agent("interrupted", { resumable: true }))).toMatchObject({
      label: "STOPPED",
      qualifier: "resumable",
    });
    expect(paneStatus(agent("interrupted", { resumable: false }))).toMatchObject({ qualifier: "historical" });
    expect(endedSummary("interrupted", "Codex", null, null, false)).toBe("Ended · saved in history");
    expect(paneStatus(agent("waiting_for_dependency"))).toMatchObject({ label: "WAITING" });
    expect(paneStatus(agent("idle", { currentActivity: READY_ACTIVITY })).label).toBe("READY");
    expect(paneStatus(agent("idle", { pendingApprovals: 1 })).label).toBe("NEEDS YOU");
    expect(paneStatus(agent("paused"))).toMatchObject({ label: "IDLE", qualifier: "paused" });
    expect(paneStatus(agent("completed")).label).toBe("DONE");
  });

  it("never labels an agent whose process hasn't started IDLE: launching is STARTING, a hold is WAITING", () => {
    const agent = (status: ThreadStatus) => ({ status, currentActivity: null, pendingApprovals: 0 });
    expect(paneStatus(agent("starting"))).toMatchObject({ label: "STARTING" });
    // WAITING is "on hold" (muted), never the amber of NEEDS YOU.
    expect(paneStatus(agent("waiting_for_dependency"))).toMatchObject({
      label: "WAITING",
      tone: "muted",
      qualifier: "waiting on another task",
    });
    // A resource hold shows its real reason in place of the shared qualifier.
    render(
      createElement(PaneStatusChip, {
        thread: agent("waiting_for_dependency"),
        qualifier: "memory is critically low",
      }),
    );
    expect(screen.getByText("WAITING")).toBeInTheDocument();
    expect(screen.getByText("memory is critically low")).toBeInTheDocument();
    expect(screen.queryByText("waiting on another task")).toBeNull();
    expect(screen.queryByText(/IDLE|CPU busy/)).toBeNull();
  });

  it("uses neutral glyphs and plain provider names", () => {
    expect(providerIdentity("claude-code")).toEqual({ name: "Claude Code", initial: "C", shape: "square" });
    expect(providerIdentity("codex").name).toBe("Codex");
    expect(providerIdentity("gemini-cli").name).toBe("Gemini CLI");
    expect(providerIdentity("other", "Other CLI").initial).toBe("O");
  });

  it("says who answers approvals and how much KalCode sees", () => {
    expect(channelNote(info({}))).toBeNull();
    expect(channelNote(info({ decisionRouting: "provider_prompt", kalcodeAnswersApprovals: false }))?.text).toBe(
      "Approvals in Claude Code",
    );
    expect(channelNote(info({ hookChannel: "limited", kalcodeAnswersApprovals: false }))).toEqual({
      text: "Limited status — approvals in Claude Code",
      tone: "limited",
    });
    expect(channelNote(info({ hookChannel: "ended", running: false, exitCode: 0 }))?.text).toBe("Ended (exit 0)");
    expect(channelNote(null)).toBeNull();
  });

  it("words the channel from the session's state, the same for every provider", () => {
    const codex = info({ providerId: "codex", decisionRouting: "provider_prompt", kalcodeAnswersApprovals: false });
    expect(channelNote({ ...codex, hookChannel: "waiting" })).toEqual({
      text: "Connecting to Codex…",
      tone: "neutral",
    });
    expect(channelNote(codex)?.text).toBe("Approvals in Codex");
    expect(
      channelNote(info({ providerId: "gemini-cli", hookChannel: "limited", kalcodeAnswersApprovals: false })),
    ).toEqual({
      text: "Limited status — approvals in Gemini CLI",
      tone: "limited",
    });
    expect(channelNote({ ...codex, providerId: "cursor", hookChannel: "limited" })?.text).toBe(
      "Limited status — approvals in Cursor",
    );
    expect(channelNote({ ...codex, running: false, hookChannel: "ended", exitCode: 1 })?.text).toBe("Ended (exit 1)");
  });

  it("describes what KalCode sees in each provider's pane, never claiming checks it can't do", () => {
    expect(paneInfoCopy("codex", null).summary).toBe(
      "KalCode reads Codex's own lifecycle hooks (prompt, tool calls, approval requests, turn end) where this Codex version supports them, otherwise its turn-finished notification and process state. Approvals are answered in Codex's own prompt.",
    );
    expect(paneInfoCopy("gemini-cli", null).summary).toBe(
      "Process state only: KalCode can't see Gemini CLI's tool calls yet. Approvals are answered in Gemini CLI's own prompt.",
    );
    for (const id of ["codex", "gemini-cli"]) {
      const copy = paneInfoCopy(id, null);
      expect(copy.footer).not.toContain("always blocks");
      expect(copy.summary).not.toContain("checked by KalCode");
    }
    expect(paneInfoCopy("claude-code", info({})).footer).toContain("KalCode always blocks pushes");
    expect(isAnswerInProvider("Answer in Codex")).toBe(true);
    expect(isAnswerInProvider(null)).toBe(false);
  });

  it("labels the pane region, and shows the exact model and effort or nothing (never a guess)", () => {
    const thread = { name: "Fix login", providerId: "claude-code", providerName: "Claude Code", model: null };
    expect(paneLabel(thread as ThreadSummary)).toBe("Fix login, Claude Code agent");
    expect(paneModel({ model: null })).toBeNull();
    expect(paneModel({ model: "  " })).toBeNull();
    expect(paneModel({ model: "claude-opus-4-1" })).toBe("claude-opus-4-1");
    expect(paneEffort({ effort: null })).toBeNull();
    expect(paneEffort({ effort: "default" })).toBeNull();
    expect(paneEffort({ effort: "high" })).toBe("High");
    expect(paneEffort({ effort: "xhigh" })).toBe("Extra high");
    expect(paneEffort({ effort: "minimal" })).toBe("Minimal");
  });

  it("offers Resume only for an agent whose provider ended, and says what happened", () => {
    expect(canResumePane("failed", false)).toBe(true);
    expect(canResumePane("interrupted", false)).toBe(true);
    expect(canResumePane("completed", false)).toBe(true);
    expect(canResumePane("idle", false)).toBe(false);
    expect(canResumePane("failed", true), "a live process is never offered a second start").toBe(false);
    expect(endedSummary("failed", "Codex", null, "Codex isn't signed in.")).toBe("Codex isn't signed in.");
    expect(endedSummary("completed", "Claude Code", 0, null)).toBe("Finished");
    expect(endedSummary("completed", "Claude Code", 2, null)).toBe("Exited with code 2");
    expect(endedSummary("interrupted", "Codex", null, null)).toBe("Stopped · resume to pick up where it left off");
    expect(approvalAnnouncement("Claude Code", "Fix login")).toBe(
      "Claude Code needs approval in Fix login. Press Ctrl+Shift+E to answer.",
    );
  });

  it("uses the exact managed account and marks stale account snapshots truthfully", () => {
    const thread = {
      providerId: "codex",
      providerAccountId: "0192f3c4-0000-7000-8000-000000000202",
      accountLabel: "Work",
    } as ThreadSummary;
    const active = {
      id: thread.providerAccountId,
      providerId: "codex",
      displayName: "Work profile",
      archivedAt: null,
    } as ProviderAccount;

    const usageAccount = (displayName: string) => ({ id: thread.providerAccountId, displayName, providerId: "codex" });
    expect(resolvePaneAccount(thread, [active], false)).toEqual({
      label: "Work profile",
      state: "active",
      usageAccount: usageAccount("Work profile"),
    });
    // The shared account name, so a blank-named account reads the same here as everywhere else.
    expect(resolvePaneAccount(thread, [{ ...active, displayName: "  " }], false)).toEqual({
      label: "Unnamed account",
      state: "active",
      usageAccount: usageAccount("Unnamed account"),
    });
    // Usage is only ever this thread's exact account; a gone or unmanaged account shows none.
    expect(resolvePaneAccount(thread, [], false)?.usageAccount).toBeUndefined();
    expect(resolvePaneAccount({ ...thread, providerAccountId: null }, [active], false)?.usageAccount).toBeUndefined();
    expect(
      samePaneAccount(resolvePaneAccount(thread, [active], false), resolvePaneAccount(thread, [{ ...active }], false)),
    ).toBe(true);
    expect(samePaneAccount(resolvePaneAccount(thread, [active], false), resolvePaneAccount(thread, null, false))).toBe(
      false,
    );
    expect(paneAccountLabel(requirePaneAccount(resolvePaneAccount(thread, null, false)))).toBe(
      "Work (checking status)",
    );
    expect(paneAccountLabel(requirePaneAccount(resolvePaneAccount(thread, [], false)))).toBe(
      "Work (archived or unavailable)",
    );
    expect(paneAccountLabel(requirePaneAccount(resolvePaneAccount(thread, null, true)))).toBe(
      "Work (status unavailable)",
    );
    expect(
      resolvePaneAccount(thread, [{ ...active, providerId: "claude-code" }], false),
      "an account id from a different provider is never displayed as this pane's identity",
    ).toEqual({ label: "Work", state: "archived_or_unavailable" });
  });

  it("exposes provider context for the visible account name without an unsupported ARIA label", () => {
    render(createElement(PaneAccountChip, { account: { label: "Work profile", state: "active" } }));
    expect(screen.getByText("Provider account")).toHaveClass("visually-hidden");
    expect(screen.getByTitle("Provider account: Work profile")).toHaveTextContent("Provider account Work profile");
  });

  it("renders the status chip as glyph + words that never shrink into each other", () => {
    const { container } = render(
      createElement(PaneStatusChip, { thread: { status: "idle", currentActivity: null, pendingApprovals: 0 } }),
    );
    const chip = container.querySelector("[data-pane-status]");
    expect(chip).toHaveTextContent(/^IDLE$/);
    expect(chip?.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });
});

describe("pane channel helpers", () => {
  it("splits input without breaking surrogate pairs", () => {
    const text = `${"a".repeat(3)}😀${"b".repeat(3)}`;
    const parts = splitInput(text, 4);
    expect(parts.join("")).toBe(text);
    for (const part of parts) expect(/[\ud800-\udbff]$/.test(part)).toBe(false);
  });

  it("starts coding agents without approvals unless the saved default is Plan", () => {
    expect(paneStartMode("plan")).toBe("plan");
    for (const mode of ["auto", "approve", "bypass", "custom"] as const) expect(paneStartMode(mode)).toBe("bypass");
  });

  it("waits for delayed canonical settings and preserves a saved Plan preference exactly", async () => {
    let provideSettings: ((settings: { defaultMode: PermissionMode }) => void) | undefined;
    const delayed = new Promise<{ defaultMode: PermissionMode }>((resolve) => {
      provideSettings = resolve;
    });
    let settled = false;
    const resolving = resolvePaneStartMode(null, () => delayed).then((mode) => {
      settled = true;
      return mode;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    provideSettings?.({ defaultMode: "plan" });
    await expect(resolving).resolves.toBe("plan");
  });

  it("surfaces a canonical settings read failure without inventing a launch mode", async () => {
    await expect(
      resolvePaneStartMode(null, async () => {
        throw new Error("permission settings unavailable");
      }),
    ).rejects.toThrow("permission settings unavailable");
  });
});

async function setup(): Promise<{ transport: MemoryTransport; channel: PaneChannel; workspace: Workspace }> {
  const transport = createMemoryTransport("default", { detectDelayMs: 0 });
  const client = new KalCodeClient(transport);
  transport.workspaces.queueFolders("pane-site");
  const workspace = (await client.openWorkspaceDialog()) as Workspace;
  return { transport, channel: new PaneChannel(client), workspace };
}

/** The simulated provider answers on short timers; wait for them like a person would. */
function settle(ms = 400) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("in-memory provider panes", () => {
  it("continues with an explicit account in a fresh runtime without rebinding the live source", async () => {
    const { transport, channel, workspace } = await setup();
    const client = new KalCodeClient(transport);
    const source = await channel.create({
      workspaceId: workspace.id,
      providerId: "codex",
      permissionMode: "plan",
      effort: "high",
    });
    const original = await channel.info(source.id);
    const target = await client.createProviderAccount("codex", "Continuation");
    const input = {
      sourceThreadId: source.id,
      switchAccountId: target.id,
      workspaceId: "stale",
      permissionMode: "bypass" as const,
    };
    const next = await channel.create(input);
    expect(next.id).not.toBe(source.id);
    expect(next).toMatchObject({
      providerAccountId: target.id,
      workspaceId: source.workspaceId,
      permissionMode: "plan",
      effort: "high",
    });
    expect((await channel.info(next.id))?.instanceId).not.toBe(original?.instanceId);
    expect((await client.getThread(source.id)).providerAccountId).toBe(source.providerAccountId);
    expect(await channel.info(source.id)).toMatchObject({ running: true, instanceId: original?.instanceId });
    const foreign = await client.createProviderAccount("claude-code", "Wrong provider");
    await expect(channel.create({ ...input, switchAccountId: foreign.id })).rejects.toMatchObject({
      code: "provider_account_mismatch",
    });
    await client.archiveProviderAccount(target.id);
    await expect(channel.create(input)).rejects.toMatchObject({ code: "provider_account_archived" });
    await expect(
      channel.create({ workspaceId: workspace.id, permissionMode: "plan", switchAccountId: "missing" }),
    ).rejects.toMatchObject({ code: "pane_switch_source_required" });
    await client.stopThread(next.id);
    await client.stopThread(source.id);
  });
  it("New like this starts a fresh live provider while preserving the original and exact configuration", async () => {
    const { transport, channel, workspace } = await setup();
    const source = await channel.create({
      workspaceId: workspace.id,
      providerId: "codex",
      model: (await new KalCodeClient(transport).threadOptions()).providers.find((p) => p.id === "codex")?.models[0]
        ?.id,
      effort: "high",
      permissionMode: "plan",
      name: "Review",
    });
    const original = await channel.info(source.id);
    const copy = await channel.create({ sourceThreadId: source.id, workspaceId: "stale", permissionMode: "bypass" });
    expect(copy.id).not.toBe(source.id);
    expect(copy).toMatchObject({
      workspaceId: source.workspaceId,
      providerId: source.providerId,
      providerAccountId: source.providerAccountId,
      model: source.model,
      effort: "high",
      permissionMode: "plan",
      name: "Codex",
      runtimeKind: "interactive_pty",
    });
    expect(await channel.info(copy.id)).toMatchObject({ running: true });
    expect((await channel.info(copy.id))?.instanceId).not.toBe(original?.instanceId);
    await new KalCodeClient(transport).stopThread(copy.id);
    expect(await channel.info(source.id)).toMatchObject({ running: true, instanceId: original?.instanceId });
  });
  it("fresh recovery carries task context but uses the explicitly chosen launch configuration", async () => {
    const { transport, channel, workspace } = await setup();
    const source = await channel.create({
      workspaceId: workspace.id,
      providerId: "codex",
      permissionMode: "plan",
      name: "Review changes",
    });
    await new KalCodeClient(transport).stopThread(source.id);
    const next = await channel.create({
      contextSourceThreadId: source.id,
      workspaceId: workspace.id,
      providerId: "claude-code",
      permissionMode: "approve",
    });
    expect(next.id).not.toBe(source.id);
    expect(next).toMatchObject({
      name: source.name,
      workspaceId: source.workspaceId,
      providerId: "claude-code",
      permissionMode: "approve",
    });
    expect((await new KalCodeClient(transport).getThread(source.id)).status).toBe("interrupted");
    await expect(
      channel.create({
        sourceThreadId: source.id,
        contextSourceThreadId: source.id,
        workspaceId: workspace.id,
        permissionMode: "plan",
      }),
    ).rejects.toMatchObject({ code: "pane_context_source_conflict" });
    await new KalCodeClient(transport).stopThread(next.id);
  });
  it("creates a pane thread, streams output and drives status through the thread runtime", async () => {
    const { transport, channel, workspace } = await setup();
    const thread = await channel.create({ workspaceId: workspace.id, permissionMode: "approve" });
    expect(thread.runtimeKind).toBe("interactive_pty");
    const chunks: string[] = [];
    const id = await channel.attach(thread.id, (bytes) => chunks.push(new TextDecoder().decode(bytes)));
    expect(id).not.toBeNull();
    await settle();
    expect(chunks.join("")).toContain("KalCode fake provider");
    const paneInfo = await channel.info(thread.id);
    expect(paneInfo?.hookChannel).toBe("active");
    expect(paneInfo?.instanceId).toBeTruthy();
    await expect(channel.writeVoice(thread.id, "stale-instance", "x")).rejects.toMatchObject({
      code: "provider_target_changed",
    });

    await channel.write(thread.id, "run npm test\r");
    await settle(600);
    expect(chunks.join("")).toContain("RAN Bash");
    const client = new KalCodeClient(transport);
    const after = await client.getThread(thread.id);
    expect(after.status).toBe("idle");
    expect(after.name).not.toBe("New thread");

    await channel.write(thread.id, "say Status: FAILED. PERMISSION REQUIRED.\r");
    await settle();
    expect((await client.getThread(thread.id)).status).toBe("idle");

    await channel.write(thread.id, "exit\r");
    await settle();
    expect((await client.getThread(thread.id)).status).toBe("completed");
    expect((await channel.info(thread.id))?.running).toBe(false);
    await expect(channel.write(thread.id, "x")).rejects.toMatchObject({ code: "pane_not_running" });
  });

  it("holds a tool call for a KalCode approval and returns the person's answer", async () => {
    const { transport, channel, workspace } = await setup();
    const client = new KalCodeClient(transport);
    const thread = await channel.create({ workspaceId: workspace.id, permissionMode: "approve" });
    const chunks: string[] = [];
    await channel.attach(thread.id, (bytes) => chunks.push(new TextDecoder().decode(bytes)));
    await settle();
    await channel.write(thread.id, "run git push origin main\r");
    await settle();
    expect((await client.getThread(thread.id)).status).toBe("waiting_for_permission");
    const instanceId = (await channel.info(thread.id))?.instanceId;
    if (!instanceId) throw new Error("provider pane has no live instance identity");
    await expect(channel.writeVoice(thread.id, instanceId, "\r")).rejects.toMatchObject({
      code: "provider_permission_prompt",
    });
    const [request] = (await client.listApprovals("pending")).filter(
      (r: ApprovalView) => r.action.threadId === thread.id,
    );
    expect(request).toBeDefined();
    await client.decideApproval((request as ApprovalView).id, "deny");
    await settle();
    expect(chunks.join("")).toContain("BLOCKED BY HOOK");
    expect((await client.getThread(thread.id)).status).toBe("idle");
  });

  it("keeps insert-only voice safe but refuses submit when Claude's hook channel is limited", async () => {
    const { transport, channel, workspace } = await setup();
    transport.panes.configure({ hookChannel: "limited" });
    const thread = await channel.create({ workspaceId: workspace.id, permissionMode: "approve" });
    const chunks: string[] = [];
    await channel.attach(thread.id, (bytes) => chunks.push(new TextDecoder().decode(bytes)));
    await settle();
    const paneInfo = await channel.info(thread.id);
    expect(paneInfo).toMatchObject({ hookChannel: "limited", kalcodeAnswersApprovals: false });
    if (!paneInfo?.instanceId) throw new Error("provider pane has no live instance identity");

    await expect(channel.writeVoice(thread.id, paneInfo.instanceId, "voice submit\r")).rejects.toMatchObject({
      code: "provider_input_unverified",
    });
    expect(chunks.join("")).not.toContain("voice submit");

    await channel.writeVoice(thread.id, paneInfo.instanceId, "voice draft");
    expect(chunks.join("")).toContain("voice draft");
  });

  it("validates like native and can be turned off", async () => {
    const { transport, channel, workspace } = await setup();
    await expect(channel.info("not-an-id")).rejects.toMatchObject({ code: "invalid_thread" });
    await expect(
      transport.invoke("provider_pane_create", {
        providerId: "other-cli",
        workspaceId: workspace.id,
        permissionMode: "approve",
      }),
    ).rejects.toMatchObject({ code: "provider_pane_unsupported" });
    transport.panes.configure({ enabled: false });
    await expect(channel.create({ workspaceId: workspace.id, permissionMode: "approve" })).rejects.toMatchObject({
      code: "provider_panes_unavailable",
    });
  });

  it("runs Codex with approvals in its own prompt and the shared states from its hooks", async () => {
    const { transport, channel, workspace } = await setup();
    const client = new KalCodeClient(transport);
    const providerAccountId = "0192f3c4-0000-7000-8000-000000000201";
    const thread = await channel.create({
      providerId: "codex",
      providerAccountId,
      workspaceId: workspace.id,
      permissionMode: "approve",
    });
    expect(thread).toMatchObject({
      providerId: "codex",
      providerAccountId,
      accountLabel: "Personal",
      runtimeKind: "interactive_pty",
    });
    const chunks: string[] = [];
    await channel.attach(thread.id, (bytes) => chunks.push(new TextDecoder().decode(bytes)));
    await settle();
    expect(await channel.info(thread.id)).toMatchObject({ hookChannel: "active", kalcodeAnswersApprovals: false });
    expect(await client.getThread(thread.id)).toMatchObject({ status: "idle", currentActivity: READY_ACTIVITY });

    await channel.write(thread.id, "run git push origin main\r");
    await settle();
    const asking = await client.getThread(thread.id);
    expect(asking).toMatchObject({ status: "waiting_for_user", currentActivity: "Answer in Codex" });
    // Never a KalCode approval for a Codex pane.
    expect((await client.listApprovals("pending")).filter((r) => r.action.threadId === thread.id)).toEqual([]);
    await channel.write(thread.id, "n\r");
    await settle();
    expect((await client.getThread(thread.id)).status).toBe("idle");
    expect(await channel.info(thread.id)).toMatchObject({ hookChannel: "active", kalcodeAnswersApprovals: false });
  });

  it("runs Gemini CLI with process state only", async () => {
    const { transport, channel, workspace } = await setup();
    const client = new KalCodeClient(transport);
    const thread = await channel.create({
      providerId: "gemini-cli",
      workspaceId: workspace.id,
      permissionMode: "plan",
    });
    await settle();
    expect(await channel.info(thread.id)).toMatchObject({ hookChannel: "limited", kalcodeAnswersApprovals: false });
    await channel.write(thread.id, "run npm install lodash\r");
    await settle();
    expect((await client.getThread(thread.id)).status).toBe("idle");
    expect((await client.listApprovals("pending")).filter((r) => r.action.threadId === thread.id)).toEqual([]);
    // Gemini CLI's own prompt takes the answer; KalCode only sees the process end.
    await channel.write(thread.id, "n\r");
    await settle();
    await channel.write(thread.id, "exit\r");
    await settle();
    expect((await client.getThread(thread.id)).status).toBe("completed");
  });
});
