import type { Notification, ThreadSummary } from "@kalcode/protocol";
import { describe, expect, it } from "vitest";
import { waitingAgents } from "../../runtime/actions.ts";
import { attentionItems, attentionSummary, REVIEW_WINDOW_MS, STALLED_AFTER_MS, sourceOf } from "./model.ts";

const NOW = Date.parse("2026-10-05T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function agent(patch: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    id: "a1",
    name: "Billing Fix",
    providerId: "codex",
    providerName: "Codex",
    model: "gpt-5",
    effort: null,
    providerAccountId: null,
    accountLabel: null,
    workspaceId: "w1",
    workspaceName: "kalcode",
    permissionMode: "bypass",
    status: "running_command",
    currentActivity: null,
    createdAt: ago(60_000),
    lastActivityAt: ago(1_000),
    pendingApprovals: 0,
    unreadMessages: 0,
    filesChanged: null,
    branch: null,
    error: null,
    archivedAt: null,
    resumable: true,
    permissionProfileId: null,
    runtimeKind: "interactive_pty",
    terminalId: "t1",
    worktreeId: null,
    ...patch,
  } as ThreadSummary;
}

function signOut(patch: Partial<Notification> = {}): Notification {
  return {
    id: "n1",
    kind: "provider_disconnected",
    severity: "warning",
    title: "Claude Code is signed out",
    body: "Threads that use Claude Code can't start until you sign in again.",
    entityKind: "provider",
    entityId: "claude-code",
    workspaceId: null,
    createdAt: ago(5_000),
    updatedAt: ago(5_000),
    readAt: null,
    count: 1,
    ...patch,
  } as Notification;
}

const none = new Set<string>();
const items = (input: Partial<Parameters<typeof attentionItems>[0]>) =>
  attentionItems({ agents: [], approvals: [], notifications: [], dismissed: none, now: NOW, ...input });

describe("attentionItems", () => {
  it("keeps ordinary progress out of the inbox", () => {
    expect(
      items({
        agents: [
          agent(),
          agent({ id: "a2", status: "idle", currentActivity: "Ready for a task" }),
          agent({ id: "a3", status: "completed", filesChanged: 0 }),
          agent({ id: "a4", status: "starting" }),
        ],
      }),
    ).toEqual([]);
  });

  it("says what, why and what next for a question, opening the exact agent", () => {
    const [item] = items({
      agents: [agent({ status: "waiting_for_user", currentActivity: "Which pricing tier should be default?" })],
    });
    expect(item).toMatchObject({
      kind: "question",
      source: "Codex · Billing Fix",
      what: "Asked you a question",
      why: "Which pricing tier should be default?",
      dismissible: false,
      actions: [{ id: "open-agent", agentId: "a1", workspaceId: "w1" }],
    });
  });

  it("offers Retry for a failed agent and explains the failure", () => {
    const [item] = items({
      agents: [agent({ status: "failed", error: { code: "x", message: "Subscription webhook test failed." } })],
    });
    expect(item?.kind).toBe("failed");
    expect(item?.why).toBe("Subscription webhook test failed.");
    expect(item?.actions.map((a) => a.label)).toEqual(["Open agent", "Retry"]);
  });

  it("treats a pending approval on an agent as one item, and a stray approval as its own", () => {
    const list = items({
      agents: [agent({ pendingApprovals: 1 })],
      approvals: [
        { id: "p1", action: { threadId: "a1", summary: "Run rm -rf build", requestedAt: ago(1_000) } },
        { id: "p2", action: { threadId: null, summary: "Open the production database", requestedAt: ago(2_000) } },
      ],
    });
    expect(list.map((i) => i.kind)).toEqual(["approval", "approval"]);
    expect(list.map((i) => i.agentId)).toEqual(["a1", null]);
  });

  it("flags an agent marked working with no activity for a while, and not before", () => {
    expect(items({ agents: [agent({ lastActivityAt: ago(STALLED_AFTER_MS - 1_000) })] })).toEqual([]);
    const [item] = items({ agents: [agent({ lastActivityAt: ago(STALLED_AFTER_MS + 4 * 60_000) })] });
    expect(item?.kind).toBe("stalled");
    expect(item?.what).toBe("No activity for 24 min");
  });

  it("asks for review of finished work with changes, within a day", () => {
    const [item] = items({ agents: [agent({ status: "completed", filesChanged: 6, branch: "kal/billing" })] });
    expect(item).toMatchObject({ kind: "review", what: "Finished · 6 files changed" });
    expect(item?.why).toContain("kal/billing");
    expect(
      items({ agents: [agent({ status: "completed", filesChanged: 6, lastActivityAt: ago(REVIEW_WINDOW_MS + 1) })] }),
    ).toEqual([]);
  });

  it("leaves failures older than a day to the Fleet, so old failures never flood the inbox", () => {
    const old = Array.from({ length: 121 }, (_, i) =>
      agent({ id: `f${i}`, status: "failed", lastActivityAt: ago(REVIEW_WINDOW_MS + 60_000) }),
    );
    expect(items({ agents: [...old, agent({ id: "new", status: "failed" })] }).map((i) => i.agentId)).toEqual(["new"]);
  });

  it("hides a dismissed occurrence but shows the next one", () => {
    const failed = agent({ status: "failed" });
    const [first] = items({ agents: [failed] });
    const dismissed = new Set([first?.key ?? ""]);
    expect(items({ agents: [failed], dismissed })).toEqual([]);
    expect(items({ agents: [{ ...failed, lastActivityAt: ago(0) }], dismissed })).toHaveLength(1);
  });

  it("never lets a state that clears itself be dismissed", () => {
    const question = agent({ status: "waiting_for_user" });
    const [item] = items({ agents: [question] });
    expect(items({ agents: [question], dismissed: new Set([item?.key ?? ""]) })).toHaveLength(1);
  });

  it("raises one sign-in item per signed-out provider and ignores read ones", () => {
    const list = items({
      notifications: [signOut(), signOut({ id: "n2" }), signOut({ id: "n3", entityId: "codex", readAt: ago(1) })],
    });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      kind: "auth",
      source: "Claude Code",
      actions: [{ id: "sign-in" }, { id: "dismiss" }],
    });
  });

  it("ignores archived agents and sorts blockers before reviews", () => {
    const list = items({
      agents: [
        agent({ id: "r", status: "completed", filesChanged: 2, lastActivityAt: ago(0) }),
        agent({ id: "q", status: "waiting_for_user", lastActivityAt: ago(60_000) }),
        agent({ id: "x", status: "failed", archivedAt: ago(1) }),
      ],
    });
    expect(list.map((i) => i.agentId)).toEqual(["q", "r"]);
  });

  it("works the same for every provider", () => {
    for (const [providerId, providerName] of [
      ["claude-code", "Claude Code"],
      ["codex", "Codex"],
      ["cursor", "Cursor"],
      ["gemini", "Gemini CLI"],
    ] as const) {
      const [item] = items({ agents: [agent({ providerId, providerName, status: "waiting_for_user" })] });
      expect(item?.source).toBe(`${providerName} · Billing Fix`);
    }
  });
});

describe("copy and helpers", () => {
  it("summarises counts provider-neutrally", () => {
    expect(attentionSummary([])).toBe("Nothing needs you");
    expect(attentionSummary(items({ agents: [agent({ status: "failed" })] }))).toBe("1 blocked on you");
    expect(
      attentionSummary(
        items({
          agents: [
            agent({ id: "q", status: "waiting_for_user" }),
            agent({ id: "r", status: "completed", filesChanged: 3 }),
            agent({ id: "s", lastActivityAt: ago(STALLED_AFTER_MS * 2) }),
          ],
        }),
      ),
    ).toBe("1 blocked on you · 1 to review · 1 stalled");
  });

  it("names an unnamed agent by its provider only", () => {
    expect(sourceOf({ providerName: "Codex", name: "Codex" })).toBe("Codex");
  });

  it("finds the waiting agents newest first", () => {
    const list = waitingAgents([
      agent({ id: "old", status: "waiting_for_user", lastActivityAt: ago(10_000) }),
      agent({ id: "new", pendingApprovals: 1, lastActivityAt: ago(0) }),
      agent({ id: "busy" }),
    ]);
    expect(list.map((a) => a.id)).toEqual(["new", "old"]);
  });
});
