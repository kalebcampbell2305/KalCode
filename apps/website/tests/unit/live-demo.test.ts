import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AGENT_STATE_LABEL } from "@kalcode/protocol";
import { PLAN_FEATURES } from "@kalcode/protocol/plans";
import { describe, expect, it } from "vitest";
import {
  agentState,
  agentsList,
  closeOverlays,
  counts,
  EFFORTS,
  go,
  initialState,
  isAvailable,
  jumpToNeeds,
  launch,
  locationOf,
  MAX_AGENTS_PER_LAUNCH,
  MODELS,
  navStep,
  openBrowser,
  openLauncher,
  openOperationsContext,
  openTerminal,
  PROVIDERS,
  promptAgent,
  recordVisit,
  requestClose,
  resolveClose,
  runs,
  runVoice,
  SURFACES,
  tick,
  tidyIdle,
  weeklyWindow,
} from "../../src/lib/live/model";
import { renderApp } from "../../src/lib/live/render";

const cfg = { downloadHref: "/download", downloadLabel: "Download KalCode", accountHref: "/account" };

describe("the live demo's sample workspace", () => {
  it("opens on Code with Dashboard Redesign working, Dashboard Tests testing, a dev server and one agent needing you", () => {
    const state = initialState();
    expect(state.surface).toBe("code");
    expect(SURFACES[0]?.id).toBe("code");
    const byName = Object.fromEntries(agentsList(state).map((a) => [a.name, agentState(a)]));
    expect(byName["Dashboard Redesign"]).toBe("working");
    expect(byName["Dashboard Tests"]).toBe("testing");
    expect(byName["Code Review"]).toBe("done");
    expect(byName["README Screenshots"]).toBe("waiting");
    expect(counts(state).needs).toBe(1);
    expect(Object.values(state.tabs).some((t) => t.kind === "terminal" && t.title.includes("dev server"))).toBe(true);
  });

  it("opens current-workspace runs, services and tests beside Code without duplicating the pane", () => {
    const state = initialState();
    openOperationsContext(state);

    const context = Object.values(state.tabs).find((tab) => tab.widget === "operations");
    expect(state.surface).toBe("code");
    expect(context?.title).toBe("Runs & services");
    const html = renderApp(state, cfg);
    for (const label of ["Runs", "Services", "Tests"]) {
      expect(html).toMatch(new RegExp(`role="tab"[^>]*>${label}<span>`));
    }

    openOperationsContext(state);
    expect(Object.values(state.tabs).filter((tab) => tab.widget === "operations")).toHaveLength(1);
  });

  it("shows current test-run evidence without inventing a completed result", () => {
    const state = initialState();
    openOperationsContext(state);
    state.contextTab = "tests";
    const run = runs(state).find((entry) => entry.name === "Dashboard Tests");
    if (!run) throw new Error("The sample workspace must have a test run");
    expect(run?.status).toBe("Running");
    state.run = run.id;
    const html = renderApp(state, cfg);
    expect(html).not.toContain("14 tests passed · evidence attached");
    expect(html).toContain(`<strong>${run.status} · ${run.duration}</strong>`);
  });

  it("gives every agent its own terminal pane: N launched agents are N panes, never threads", () => {
    const state = initialState();
    const panes = Object.keys(state.tabs).length;
    openLauncher(state, "codex");
    if (state.launcher) state.launcher.count = 3;
    const created = launch(state);
    expect(created).toHaveLength(3);
    expect(Object.keys(state.tabs).length).toBe(panes + 3);
    for (const id of created) {
      const tab = Object.values(state.tabs).find((t) => t.agent === id);
      expect(tab?.kind).toBe("agent");
      expect(state.agents[id]?.provider).toBe("codex");
    }
    // As in the app, taskless sessions use the clean provider name, never alphabetic placeholders.
    expect(created.map((id) => state.agents[id]?.name)).toEqual(["Codex", "Codex", "Codex"]);
    expect(state.surface).toBe("code");
  });

  it("uses only the account's all-model weekly window for compact usage", () => {
    const state = initialState();
    const account = (id: string) => {
      const found = state.accounts.find((candidate) => candidate.id === id);
      if (!found) throw new Error(`Missing sample account ${id}`);
      return found;
    };
    expect(weeklyWindow(account("claude-personal"))?.left).toBe(81);
    expect(weeklyWindow(account("codex-personal"))?.left).toBe(73);
    expect(weeklyWindow(account("gemini-personal"))).toBeNull();

    let html = renderApp(state, cfg);
    expect(html).toContain("81% left");
    expect(html).not.toContain("64% left");

    openLauncher(state, "gemini");
    html = renderApp(state, cfg);
    expect(html).toContain("Weekly usage unavailable");
    expect(html).not.toContain("88% left");
    expect(html).not.toContain("0% left");
  });

  it("launches up to ten agents at once, as the desktop launcher does", () => {
    expect(MAX_AGENTS_PER_LAUNCH).toBe(10);
    const state = initialState();
    openLauncher(state, "claude");
    if (state.launcher) state.launcher.count = 12;
    expect(launch(state)).toHaveLength(10);
  });

  it("offers every shipped provider: Claude Code, Codex, Gemini CLI and Cursor", () => {
    expect(PROVIDERS).toEqual(["claude", "codex", "gemini", "cursor"]);
    const state = initialState();
    openLauncher(state, "gemini");
    const html = renderApp(state, cfg);
    for (const name of ["Claude Code", "Codex", "Gemini CLI", "Cursor"]) expect(html).toContain(name);
    expect(html).not.toContain('aria-label="Effort"');
  });

  it("starts new agents in Bypass, with Plan as the read-only choice", () => {
    const state = initialState();
    expect(state.mode).toBe("bypass");
    openLauncher(state, "claude");
    const html = renderApp(state, cfg);
    const [id] = launch(state);
    expect(state.agents[id ?? ""]?.mode).toBe("bypass");
    expect(html).toContain("Starts in Bypass");
    expect(html).not.toMatch(/Approve mode|>Approve<|Bypass and Custom are planned/);
  });

  it("makes its Needs You moment a secret request, never a package-install approval", () => {
    const state = initialState();
    const waiting = agentsList(state).filter((a) => agentState(a) === "needs_you");
    expect(waiting.map((a) => a.approval?.reason)).toEqual([expect.stringMatching(/credentials and secrets/)]);
    expect(renderApp(state, cfg)).not.toMatch(/pnpm add zod|Installing packages/);
  });

  it("goes Back and Forward through visited pages and panes", () => {
    const state = initialState();
    go(state, "dashboard");
    recordVisit(state);
    go(state, "operations");
    recordVisit(state);
    expect(navStep(state, -1)).toBe(true);
    expect(state.surface).toBe("dashboard");
    expect(navStep(state, -1)).toBe(true);
    expect(locationOf(state)).toBe("code:t-a1");
    expect(navStep(state, 1)).toBe(true);
    expect(state.surface).toBe("dashboard");
  });

  it("Smart Close asks before ending active work, and closing a pane stops its agent (0.1.9+2168)", () => {
    const state = initialState();
    requestClose(state, "t-a1");
    expect(state.closing).toBe("t-a1");
    resolveClose(state, "cancel");
    expect(state.tabs["t-a1"]).toBeDefined();
    expect(state.agents.a1).toBeDefined();
    requestClose(state, "t-a1");
    resolveClose(state, "stop");
    expect(state.tabs["t-a1"]).toBeUndefined();
    expect(state.agents.a1).toBeUndefined();
    requestClose(state, "t-a3");
    expect(state.closing).toBeNull();
    expect(state.agents.a3).toBeUndefined();
  });

  it("closes every overlay when the page changes the demo's surface", () => {
    const state = initialState();
    openLauncher(state, "claude");
    state.menu = "accounts";
    state.voice.open = true;
    go(state, "operations");
    expect([state.launcher, state.menu, state.voice.open]).toEqual([null, null, false]);
    openLauncher(state, "codex");
    closeOverlays(state);
    expect(state.launcher).toBeNull();
  });

  it("offers the desktop launcher's exact model and effort choices", () => {
    expect(MODELS.claude).toEqual(["Account default", "Opus", "Sonnet", "Haiku", "Fable"]);
    expect(MODELS.gemini).toEqual(["Auto (default)", "Pro", "Flash", "Flash-Lite"]);
    expect(EFFORTS.claude).toContain("Extra high");
    expect(EFFORTS.codex).toContain("Minimal");
    expect(EFFORTS.gemini).toEqual([]);
    expect(EFFORTS.cursor).toEqual([]);
  });

  it("shows statuses in the one agent-state model's own words", () => {
    const html = renderApp(initialState(), cfg);
    expect(html).toContain(AGENT_STATE_LABEL.working);
    expect(html).toContain(AGENT_STATE_LABEL.testing);
    expect(html).not.toMatch(/PERMISSION REQUIRED|WAITING FOR YOU|Needs approval/);
  });

  it("jumps Needs You to the blocked agent and KalTidy stops only idle terminals", () => {
    const state = initialState();
    expect(jumpToNeeds(state)).toBe(true);
    const focused = state.frames.find((f) => f.id === state.focus);
    expect(state.tabs[focused?.active ?? ""]?.title).toBe("Payments Webhook");
    openTerminal(state);
    const before = agentsList(state).length;
    const result = tidyIdle(state);
    expect(result.stopped).toBe(1);
    expect(agentsList(state).length).toBe(before);
  });

  it("opens Live Browser on the detected dev server, beside the agents", () => {
    const state = initialState();
    openBrowser(state);
    const browser = Object.values(state.tabs).find((t) => t.kind === "browser");
    expect(browser?.url).toBe("localhost:3000");
    expect(state.frames.at(-1)?.tabs).toContain(browser?.id);
  });

  it("runs a typed prompt in a fresh agent and finishes it", () => {
    const state = initialState();
    openLauncher(state, "claude");
    const [id] = launch(state);
    tick(state);
    tick(state);
    promptAgent(state, id ?? "", "Add a dark mode toggle");
    expect(state.agents[id ?? ""]?.name).toBe("Dark Mode Toggle");
    for (let i = 0; i < 30; i++) tick(state);
    expect(agentState(state.agents[id ?? ""] ?? ({} as never))).toBe("done");
    promptAgent(state, id ?? "", "Write tests for Login");
    expect(state.agents[id ?? ""]?.name).toBe("Dark Mode Toggle");
  });

  it("shows task titles first and truthful simulated selector metadata and weekly usage in Agent Fleet", () => {
    const state = initialState();
    go(state, "dashboard");
    const html = renderApp(state, cfg);

    expect(html).toContain("Dashboard Redesign");
    expect(html).toContain("Claude Code · Personal · model: opus (selected) · effort: high (selected)");
    expect(html).toContain(
      "Claude Code · Work · model: sonnet (selected) · effort: provider default (resolved level not reported)",
    );
    expect(html).toContain(
      "Codex · Personal · model: provider default (resolved ID not reported) · reasoning: medium (selected)",
    );
    expect(html).toContain(
      "Gemini CLI · Personal · model: provider auto (resolved ID not reported) · reasoning: provider-controlled (not reported)",
    );
    expect(html).not.toContain("Claude Code · Personal · Opus ·");
    expect(html).not.toContain("Claude Code · Work · Sonnet ·");
    expect(html).toContain("81% weekly left");
    expect(html).toContain("Weekly usage unavailable");
    expect(html).toContain("Simulated workspace");
  });

  it("answers KalVoice commands by acting on the workspace", () => {
    const state = initialState();
    expect(runVoice(state, "Open four Codex terminals")).toBe("Opened 4 Codex terminals in Code.");
    expect(runVoice(state, "Open Activity")).toBe("Opened Activity.");
    expect(state.surface).toBe("dashboard");
    go(state, "code");
    expect(runVoice(state, "Open Dashboard")).toBe("Opened Activity.");
    expect(state.surface).toBe("dashboard");
  });
});

describe("the live demo's truth", () => {
  it("tags a surface Coming soon exactly when its roadmap feature has not shipped", () => {
    for (const feature of PLAN_FEATURES) expect(isAvailable(feature.id)).toBe(feature.status === "available");
    const html = renderApp(initialState(), cfg);
    const soon = ["agent-fleet", "provider-terminals", "account-hub", "adaptive-canvas"].filter(
      (id) => !isAvailable(id),
    ).length;
    expect((html.match(/lk-soon/g) ?? []).length).toBeLessThanOrEqual(soon);
  });

  it("shows Gemini CLI as the shipped provider it is, and never any real person's data", () => {
    const html = renderApp(initialState(), cfg);
    expect(html).toContain("Gemini CLI");
    expect(html).not.toMatch(/Gemini CLI unavailable|not in Stable/i);
    expect(html).not.toMatch(/@[a-z0-9.-]+\.[a-z]{2,}/i);
  });

  it("keeps the generated icons identical to the app's lucide icons", () => {
    const script = fileURLToPath(new URL("../../scripts/gen-live-icons.mjs", import.meta.url));
    expect(() => execFileSync(process.execPath, [script, "--check"], { stdio: "pipe" })).not.toThrow();
  });
});
