import type { ApprovalView, PaneInfo, ThreadSummary, Workspace } from "@kalcode/protocol";
import { describe, expect, it } from "vitest";
import { KalCodeClient } from "../../../ipc/client.ts";
import { createMemoryTransport, type MemoryTransport } from "../../../ipc/memoryTransport.ts";
import { PaneChannel, paneStartMode, splitInput } from "./paneChannel.ts";
import { channelNote, modelLabel, paneLabel, paneStatus, providerIdentity } from "./paneLabels.ts";

function info(partial: Partial<PaneInfo>): PaneInfo {
  return {
    threadId: "t",
    providerId: "claude-code",
    hookChannel: "active",
    decisionRouting: "engine",
    kalcodeAnswersApprovals: true,
    running: true,
    exitCode: null,
    ...partial,
  };
}

describe("pane labels", () => {
  it("maps statuses through the shared display mapping, never colour alone", () => {
    expect(paneStatus("waiting_for_permission")).toMatchObject({ label: "PERMISSION REQUIRED", tone: "waiting" });
    expect(paneStatus("running_command")).toMatchObject({ label: "WORKING", tone: "working" });
    expect(paneStatus("interrupted")).toMatchObject({ label: "IDLE", qualifier: "stopped · resumable" });
    expect(paneStatus("paused").tone).toBe("paused");
    expect(paneStatus("completed").label).toBe("DONE");
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

  it("labels the pane region and the model", () => {
    const thread = { name: "Fix login", providerId: "claude-code", providerName: "Claude Code", model: null };
    expect(paneLabel(thread as ThreadSummary)).toBe("Fix login, Claude Code pane");
    expect(modelLabel(thread as ThreadSummary)).toBe("Account default");
  });
});

describe("pane channel helpers", () => {
  it("splits input without breaking surrogate pairs", () => {
    const text = `${"a".repeat(3)}😀${"b".repeat(3)}`;
    const parts = splitInput(text, 4);
    expect(parts.join("")).toBe(text);
    for (const part of parts) expect(/[\ud800-\udbff]$/.test(part)).toBe(false);
  });

  it("starts panes only in Plan, Approve or Auto", () => {
    expect(paneStartMode("auto")).toBe("auto");
    expect(paneStartMode("bypass")).toBe("approve");
    expect(paneStartMode("custom")).toBe("approve");
    expect(paneStartMode(null)).toBe("approve");
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
  it("creates a pane thread, streams output and drives status through the thread runtime", async () => {
    const { transport, channel, workspace } = await setup();
    const thread = await channel.create({ workspaceId: workspace.id, permissionMode: "approve" });
    expect(thread.runtimeKind).toBe("interactive_pty");
    const chunks: string[] = [];
    const id = await channel.attach(thread.id, (bytes) => chunks.push(new TextDecoder().decode(bytes)));
    expect(id).not.toBeNull();
    await settle();
    expect(chunks.join("")).toContain("KalCode fake provider");
    expect((await channel.info(thread.id))?.hookChannel).toBe("active");

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
    const [request] = (await client.listApprovals("pending")).filter(
      (r: ApprovalView) => r.action.threadId === thread.id,
    );
    expect(request).toBeDefined();
    await client.decideApproval((request as ApprovalView).id, "deny");
    await settle();
    expect(chunks.join("")).toContain("BLOCKED BY HOOK");
    expect((await client.getThread(thread.id)).status).toBe("idle");
  });

  it("validates like native and can be turned off", async () => {
    const { transport, channel, workspace } = await setup();
    await expect(channel.info("not-an-id")).rejects.toMatchObject({ code: "invalid_thread" });
    await expect(
      transport.invoke("provider_pane_create", {
        providerId: "codex",
        workspaceId: workspace.id,
        permissionMode: "approve",
      }),
    ).rejects.toMatchObject({ code: "provider_pane_unsupported" });
    transport.panes.configure({ enabled: false });
    await expect(channel.create({ workspaceId: workspace.id, permissionMode: "approve" })).rejects.toMatchObject({
      code: "provider_panes_unavailable",
    });
  });
});
