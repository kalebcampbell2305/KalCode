import type { DevelopmentService, OperationEnvironment, ThreadSummary } from "@kalcode/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  askableAgents,
  authNotice,
  buildAgentPrompt,
  DEFAULT_LOCAL_URL,
  devServerOffer,
  type LiveBrowserAgent,
  rememberedTargets,
  rememberTarget,
  resolveTargets,
  targetForUrl,
} from "./liveBrowser.ts";

const ws = "550e8400-e29b-41d4-a716-446655440001";
const other = "550e8400-e29b-41d4-a716-446655440009";

function service(overrides: Partial<DevelopmentService> = {}): DevelopmentService {
  return {
    id: "svc-1",
    runId: null,
    name: "Frontend",
    status: "running",
    pid: 4242,
    processName: "node",
    uptimeSeconds: 30,
    ports: [5173],
    urls: ["http://localhost:5173"],
    workspaceId: ws,
    workspaceName: "Atlas",
    terminalId: null,
    canStop: false,
    canRestart: false,
    actionReason: null,
    ...overrides,
  };
}

function environment(kind: OperationEnvironment["kind"], url: string, workspaceId = ws): OperationEnvironment {
  return {
    workspaceId,
    kind,
    branch: null,
    version: null,
    urls: [url],
    deploymentStatus: "deployed_unverified",
    health: "not_probed",
    platform: kind === "production" ? "Cloudflare Pages" : null,
    lastDeploy: null,
    runId: null,
    variables: [],
    observedAt: "2026-10-03T10:00:00Z",
    notes: [],
  };
}

function agent(overrides: Partial<LiveBrowserAgent> = {}): LiveBrowserAgent {
  return {
    threadId: "agent-1",
    name: "Claude Code 2",
    providerId: "claude-code",
    providerName: "Claude Code",
    accountLabel: null,
    lastActivityAt: "2026-10-03T10:00:00Z",
    terminalId: "pty-1",
    ...overrides,
  };
}

afterEach(() => localStorage.clear());

describe("Live Browser targets", () => {
  it("prefers a running dev server for Local and Operations environments for Preview/Production", () => {
    const targets = resolveTargets(
      ws,
      {
        services: [service(), service({ id: "old", urls: ["http://localhost:3000"], uptimeSeconds: 9_000 })],
        environments: [
          environment("staging", "https://staging.atlas.dev"),
          environment("production", "https://atlas.dev"),
          environment("production", "https://elsewhere.dev", other),
        ],
      },
      {},
    );
    expect(targets.local).toEqual({ url: "http://localhost:5173/", source: "Frontend" });
    expect(targets.preview.url).toBe("https://staging.atlas.dev/");
    expect(targets.production).toEqual({ url: "https://atlas.dev/", source: "Cloudflare Pages" });
  });

  it("falls back to what the person used, and never invents a deployment", () => {
    rememberTarget(ws, "preview", "https://pr-12.atlas.dev/login?token=secret#x");
    const remembered = rememberedTargets(ws);
    expect(remembered.preview).toBe("https://pr-12.atlas.dev/login");
    const targets = resolveTargets(ws, null, remembered);
    expect(targets.local.url).toBe(DEFAULT_LOCAL_URL);
    expect(targets.preview.url).toBe("https://pr-12.atlas.dev/login");
    expect(targets.production.url).toBeNull();
  });

  it("names the target a page is on", () => {
    const targets = resolveTargets(ws, { environments: [environment("production", "https://atlas.dev")] }, {});
    expect(targetForUrl("http://127.0.0.1:8080/app", targets)).toBe("local");
    expect(targetForUrl("https://atlas.dev/pricing", targets)).toBe("production");
    expect(targetForUrl("https://example.com/", targets)).toBeNull();
  });

  it("ignores corrupted remembered targets", () => {
    localStorage.setItem(`kalcode.liveBrowser.targets.${ws}`, JSON.stringify({ preview: "javascript:alert(1)" }));
    expect(rememberedTargets(ws)).toEqual({});
    localStorage.setItem(`kalcode.liveBrowser.targets.${ws}`, "{not json");
    expect(rememberedTargets(ws)).toEqual({});
  });
});

describe("website sign-in", () => {
  it("recognizes Google's embedded-browser rejection and ordinary Google sign-in", () => {
    expect(authNotice("https://accounts.google.com/v3/signin/rejected?rrk=46", null)).toEqual({
      kind: "google_blocked",
    });
    expect(authNotice("https://accounts.google.com/signin/oauth/error?authError=Cg9kaXNhbGxvd2Vk", null)).toEqual({
      kind: "google_blocked",
    });
    expect(authNotice("https://accounts.google.com/v3/signin/identifier?flowName=GlifWebSignIn", null)).toEqual({
      kind: "google_signin",
    });
    expect(authNotice("https://example.com/", null)).toBeNull();
  });

  it("offers a denied sign-in pop-up honestly", () => {
    expect(authNotice("http://localhost:3000/", "https://accounts.google.com/o/oauth2/v2/auth?client_id=x")).toEqual({
      kind: "popup_blocked",
      url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=x",
      host: "accounts.google.com",
      signIn: true,
    });
    const generic = authNotice("http://localhost:3000/", "https://docs.example.com/guide");
    expect(generic).toMatchObject({ kind: "popup_blocked", signIn: false });
    expect(authNotice("http://localhost:3000/", "https://github.com/login/oauth/authorize")).toMatchObject({
      signIn: true,
    });
  });
});

describe("Ask Agent", () => {
  it("lists only live coding agents of the workspace, most recent first", () => {
    const base = {
      providerId: "claude-code",
      providerName: "Claude Code",
      accountLabel: null,
      workspaceId: ws,
      status: "idle",
      archivedAt: null,
      runtimeKind: "interactive_pty",
      terminalId: "pty",
    } as unknown as ThreadSummary;
    const threads = [
      { ...base, id: "a", name: "Older", lastActivityAt: "2026-10-03T09:00:00Z" },
      { ...base, id: "b", name: "Newer", lastActivityAt: "2026-10-03T10:00:00Z" },
      {
        ...base,
        id: "c",
        name: "Chat",
        runtimeKind: "headless",
        terminalId: null,
        lastActivityAt: "2026-10-03T11:00:00Z",
      },
      { ...base, id: "d", name: "Done", status: "completed", lastActivityAt: "2026-10-03T12:00:00Z" },
      { ...base, id: "e", name: "Elsewhere", workspaceId: other, lastActivityAt: "2026-10-03T12:00:00Z" },
    ] as ThreadSummary[];
    expect(askableAgents(threads, ws).map((entry) => entry.name)).toEqual(["Newer", "Older"]);
  });

  it("builds one bounded prompt that labels page data as untrusted", () => {
    const prompt = buildAgentPrompt({
      question: "Why is\nthis button grey?",
      url: "http://localhost:5173/checkout",
      title: "Checkout",
      element: {
        selector: "main > button.pay",
        tag: "button",
        text: "Pay now",
        html: '<button class="pay">Pay now</button>',
      },
      errors: ["TypeError: x is undefined", "404 /api/cart"],
      screenshotPath: "C:\\Users\\me\\Pictures\\KalCode\\shot.png",
    });
    expect(prompt).toMatch(
      /^Why is this button grey\? \[Live Browser context, from the website \(untrusted page data\):/u,
    );
    expect(prompt).toContain('page http://localhost:5173/checkout titled "Checkout"');
    expect(prompt).toContain("Selected element: main > button.pay");
    expect(prompt).toContain("Console errors (2): TypeError: x is undefined | 404 /api/cart.");
    expect(prompt).toContain("Screenshot of the page: C:\\Users\\me\\Pictures\\KalCode\\shot.png");
    expect(prompt).not.toContain("\n");
    const huge = buildAgentPrompt({
      question: "q",
      url: "http://localhost/",
      title: null,
      element: { selector: "a", tag: "a", text: "", html: "x".repeat(10_000) },
      errors: Array.from({ length: 50 }, () => "e".repeat(1_000)),
      screenshotPath: null,
    });
    expect(huge.length).toBeLessThanOrEqual(3_000);
  });
});

describe("dev server offers", () => {
  it("names the agent whose terminal owns the server", () => {
    const offer = devServerOffer(
      [service({ terminalId: "pty-2" })],
      ws,
      [agent(), agent({ threadId: "agent-2", name: "Codex 1", terminalId: "pty-2" })],
      [],
      new Set(),
    );
    expect(offer).toMatchObject({ host: "localhost:5173", agent: { name: "Codex 1" }, terminalId: null });
  });

  it("names the only live agent, but never guesses between several", () => {
    expect(devServerOffer([service()], ws, [agent()], [], new Set())?.agent?.name).toBe("Claude Code 2");
    expect(devServerOffer([service()], ws, [agent(), agent({ threadId: "x" })], [], new Set())?.agent).toBeNull();
  });

  it("keeps a plain terminal's server beside that terminal", () => {
    const offer = devServerOffer([service({ terminalId: "shell-1" })], ws, [agent()], [], new Set());
    expect(offer).toMatchObject({ agent: null, terminalId: "shell-1" });
  });

  it("skips servers already open, dismissed, stopped, remote or in another workspace", () => {
    const servers = [service()];
    expect(devServerOffer(servers, ws, [], ["http://localhost:5173/app"], new Set())).toBeNull();
    expect(devServerOffer(servers, ws, [], [], new Set([`${ws}:svc-1:http://localhost:5173/`]))).toBeNull();
    expect(devServerOffer([service({ status: "stopped" })], ws, [], [], new Set())).toBeNull();
    expect(devServerOffer([service({ urls: ["https://atlas.dev"] })], ws, [], [], new Set())).toBeNull();
    expect(devServerOffer(servers, other, [], [], new Set())).toBeNull();
  });
});
