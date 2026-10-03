import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SessionResolution, ThreadStatus, ThreadSummary } from "@kalcode/protocol";
import { describe, expect, it } from "vitest";
import { KalCodeClient } from "../client.ts";
import { createMemoryTransport } from "../memoryTransport.ts";
import { normalizeSessionText, resolveSession, sessionLabel, typoBudget, withinDistance } from "./sessionResolve.ts";

/** The table native `session_resolver_tests.rs` runs too: both resolvers must agree on it. */
interface CasesFile {
  workspaces: Record<string, { id: string; name: string }>;
  threads: {
    key: string;
    name: string;
    provider: string;
    providerName: string;
    account: string | null;
    workspace: string;
    status: ThreadStatus;
    archived?: boolean;
  }[];
  cases: {
    name: string;
    query?: string;
    queryThread?: string;
    workspace?: string;
    focused?: string;
    last?: string;
    expect:
      | { kind: "resolved"; thread: string; tier: string }
      | { kind: "ambiguous"; threads: string[]; total: number; question: string }
      | { kind: "not_found" };
  }[];
}

/** Found by walking up from the working directory (vitest runs from the package or the repo root). */
function readCases(): CasesFile {
  const relative = join("apps", "desktop", "src-tauri", "src", "session_resolver_cases.json");
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    const candidate = join(dir, relative);
    if (existsSync(candidate)) return JSON.parse(readFileSync(candidate, "utf8")) as CasesFile;
    if (dirname(dir) === dir) throw new Error(`${relative} not found above ${process.cwd()}`);
  }
}
const table = readCases();

const threadId = (key: string) => `0192f3c4-0000-7000-8000-0000000000${key}`;

function summary(t: CasesFile["threads"][number]): ThreadSummary {
  const workspace = table.workspaces[t.workspace];
  if (!workspace) throw new Error(`unknown workspace ${t.workspace}`);
  return {
    id: threadId(t.key),
    name: t.name,
    providerId: t.provider,
    providerName: t.providerName,
    model: null,
    effort: null,
    providerAccountId: t.account ? `acct-${t.key}` : null,
    accountLabel: t.account,
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    permissionMode: "approve",
    status: t.status,
    currentActivity: null,
    createdAt: "2026-09-28T12:00:00Z",
    lastActivityAt: "2026-09-28T12:00:00Z",
    pendingApprovals: 0,
    unreadMessages: 0,
    filesChanged: null,
    branch: null,
    error: null,
    archivedAt: t.archived ? "2026-09-28T12:30:00Z" : null,
    resumable: false,
    permissionProfileId: null,
    runtimeKind: null,
    terminalId: null,
    worktreeId: null,
  };
}

const threads = table.threads.map(summary);

it("agent targets exclude chats even when a chat has the same name", () => {
  const chat = { ...threads[0], id: "chat", runtimeKind: "headless" } as ThreadSummary;
  const agent = { ...chat, id: "agent", runtimeKind: "interactive_pty" } as ThreadSummary;
  expect(resolveSession([chat, agent], `${chat.name} agent`)).toMatchObject({
    kind: "resolved",
    target: { threadId: "agent" },
  });
  expect(resolveSession([chat], `${chat.name} agent`)).toMatchObject({ kind: "not_found" });
  expect(resolveSession([chat], `${chat.name} thread`)).toMatchObject({
    kind: "resolved",
    target: { threadId: "chat" },
  });
});

function expected(expect: CasesFile["cases"][number]["expect"]): unknown {
  switch (expect.kind) {
    case "resolved":
      return { kind: "resolved", threadId: threadId(expect.thread), tier: expect.tier };
    case "ambiguous":
      return {
        kind: "ambiguous",
        threadIds: expect.threads.map(threadId),
        total: expect.total,
        question: expect.question,
      };
    case "not_found":
      return { kind: "not_found" };
  }
}

function shape(result: SessionResolution): unknown {
  switch (result.kind) {
    case "resolved":
      return { kind: "resolved", threadId: result.target.threadId, tier: result.tier };
    case "ambiguous":
      return {
        kind: "ambiguous",
        threadIds: result.choices.map((c) => c.threadId),
        total: result.total,
        question: result.question,
      };
    case "not_found":
      return { kind: "not_found" };
  }
}

describe("session resolver (memory mirror of native)", () => {
  it("keeps the shared table broad", () => {
    expect(table.cases.length).toBeGreaterThanOrEqual(25);
  });

  it.each(table.cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const query = c.queryThread ? threadId(c.queryThread) : (c.query ?? "");
    const result = resolveSession(threads, query, {
      workspaceId: c.workspace ? table.workspaces[c.workspace]?.id : null,
      focusedThreadId: c.focused ? threadId(c.focused) : null,
      lastTargetId: c.last ? threadId(c.last) : null,
    });
    expect(shape(result)).toEqual(expected(c.expect));
  });

  it("labels choices Name · Provider · Account", () => {
    const result = resolveSession(threads, "Research", {});
    expect(result.kind).toBe("ambiguous");
    if (result.kind !== "ambiguous") return;
    expect(result.choices.map((c) => c.label)).toEqual([
      "Research · Gemini CLI · Gemini A",
      "Research · Gemini CLI · Gemini B",
    ]);
    const codex = threads.find((t) => t.name === "Release Mac") as ThreadSummary;
    expect(sessionLabel(codex)).toBe("Release Mac · Codex");
  });

  it("never echoes the query when nothing fits", () => {
    const result = resolveSession(threads, "sk-live-secret-looking-words");
    expect(result).toEqual({ kind: "not_found", message: "KalCode couldn't find an open session with that name." });
  });

  it("normalizes like native", () => {
    expect(normalizeSessionText("  Café—Menu  ")).toBe("cafe menu");
    expect(normalizeSessionText("Ærø Straße")).toBe("aero strasse");
    expect(normalizeSessionText("Łódź / Œuvre")).toBe("lodz oeuvre");
    expect(normalizeSessionText("Café")).toBe("cafe");
    expect(normalizeSessionText("Release_Mac.v2")).toBe("release mac v2");
    expect(typoBudget(4)).toBe(0);
    expect(withinDistance("reelase", "release", 1)).toBe(true);
    expect(withinDistance("rlase", "release", 1)).toBe(false);
  });
});

describe("session_resolve over the memory transport", () => {
  it("resolves against the live thread listing and validates context ids", async () => {
    const client = new KalCodeClient(createMemoryTransport("threads"));
    const listed = await client.listThreads();
    const first = listed[0] as ThreadSummary;
    const byId = await client.resolveSession(first.id);
    expect(byId).toMatchObject({ kind: "resolved", tier: "explicit_id", target: { threadId: first.id } });
    const focused = await client.resolveSession("this", { focusedThreadId: first.id });
    expect(focused).toMatchObject({ kind: "resolved", tier: "focused" });
    expect(await client.resolveSession("no such session anywhere")).toMatchObject({ kind: "not_found" });
    await expect(client.resolveSession("x", { workspaceId: "not-an-id" })).rejects.toMatchObject({
      code: "invalid_session_context",
    });
  });
});
