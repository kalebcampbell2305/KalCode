import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DISPLAY_STATUS_LABEL } from "@kalcode/protocol/display-status";
import { PLAN_FEATURES } from "@kalcode/protocol/plans";
import { describe, expect, it } from "vitest";
import {
  agentsList,
  counts,
  EFFORTS,
  initialState,
  isAvailable,
  jumpToNeeds,
  launch,
  MODELS,
  openBrowser,
  openLauncher,
  openOperationsContext,
  openTerminal,
  promptAgent,
  runs,
  runVoice,
  SURFACES,
  tick,
  tidyIdle,
} from "../../src/lib/live/model";
import { renderApp } from "../../src/lib/live/render";

const cfg = { downloadHref: "/download", downloadLabel: "Download KalCode", accountHref: "/account" };

describe("the live demo's sample workspace", () => {
  it("opens on Code with Claude A working, Codex A testing, a dev server and one agent needing you", () => {
    const state = initialState();
    expect(state.surface).toBe("code");
    expect(SURFACES[0]?.id).toBe("code");
    const bySign = Object.fromEntries(agentsList(state).map((a) => [a.sign, a]));
    expect(bySign["Claude A"]?.status).toBe("working");
    expect(bySign["Codex A"]?.status).toBe("testing");
    expect(bySign["Claude B"]?.status).toBe("done");
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
    const run = runs(state).find((entry) => entry.name === "Tests");
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
    // Call signs follow the Fleet's creation order: Codex A exists, so these are B, C and D.
    expect(created.map((id) => state.agents[id]?.sign)).toEqual(["Codex B", "Codex C", "Codex D"]);
    expect(state.surface).toBe("code");
  });

  it("offers the desktop launcher's exact model and effort choices", () => {
    expect(MODELS.claude).toEqual(["Default", "Opus", "Sonnet", "Haiku", "Fable"]);
    expect(EFFORTS.claude).toContain("Extra high");
    expect(EFFORTS.codex).toContain("Minimal");
  });

  it("shows statuses in the protocol's own words", () => {
    const html = renderApp(initialState(), cfg);
    expect(html).toContain(DISPLAY_STATUS_LABEL.working);
    expect(html).toContain(DISPLAY_STATUS_LABEL.testing);
  });

  it("jumps Needs You to the blocked agent and KalTidy stops only idle terminals", () => {
    const state = initialState();
    expect(jumpToNeeds(state)).toBe(true);
    const focused = state.frames.find((f) => f.id === state.focus);
    expect(state.tabs[focused?.active ?? ""]?.title).toBe("Claude C");
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
    for (let i = 0; i < 30; i++) tick(state);
    expect(state.agents[id ?? ""]?.status).toBe("done");
  });

  it("answers KalVoice commands by acting on the workspace", () => {
    const state = initialState();
    expect(runVoice(state, "Open four Codex terminals")).toBe("Opened 4 Codex terminals in Code.");
    expect(runVoice(state, "Open Dashboard")).toBe("Opened Dashboard.");
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

  it("never shows Gemini CLI, which Stable cannot use, or any real person's data", () => {
    const html = renderApp(initialState(), cfg);
    expect(html).not.toMatch(/Gemini/);
    expect(html).not.toMatch(/@[a-z0-9.-]+\.[a-z]{2,}/i);
  });

  it("keeps the generated icons identical to the app's lucide icons", () => {
    const script = fileURLToPath(new URL("../../scripts/gen-live-icons.mjs", import.meta.url));
    expect(() => execFileSync(process.execPath, [script, "--check"], { stdio: "pipe" })).not.toThrow();
  });
});
