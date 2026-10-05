/**
 * Which product demos exist in src/components/stage (owned by the stage work). Pages use this to
 * compose a section only when its demo is present, so a missing demo never leaves an empty frame.
 */
import { LIVE_ICON_PATHS } from "./live/icons";

const modules = import.meta.glob("../components/stage/*.astro");

/**
 * A lucide icon (the app's version, from the demo's generated paths) as a self-contained inline
 * SVG, for pages that do not carry the live demo's sprite. Decorative.
 */
export function inlineIcon(name: keyof typeof LIVE_ICON_PATHS): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${LIVE_ICON_PATHS[name]}</svg>`;
}

export type StageName =
  | "AppWindow"
  | "ScrollStory"
  | "TryKalCode"
  | "ProviderSwitch"
  | "BeforeAfter"
  | "PermissionModes"
  | "KalVoiceDemo"
  | "DemoCenter"
  | "MultiAgentWall"
  | "KalVoiceStage"
  | "CommandCenterStage"
  | "MissionGraph"
  | "TimelineStage";

export function hasStage(name: StageName): boolean {
  return `../components/stage/${name}.astro` in modules;
}

/** The first demo of a list that exists, or null. */
export function firstStage(...names: StageName[]): StageName | null {
  return names.find(hasStage) ?? null;
}

/**
 * The sample fleet the home and product pages draw: four coding agents, one per provider, in the
 * shipped agent states (@kalcode/protocol agent-state: starting, working, testing, waiting, needs
 * you, ready, done, failed). Fictional sample data. The Needs You moment is a secret-access
 * request, the one thing Bypass (the default mode) still asks about.
 */
export type SampleAgentState = "working" | "testing" | "needs" | "ready";

export const SAMPLE_AGENT_STATE_LABEL: Record<SampleAgentState, string> = {
  working: "Working",
  testing: "Testing",
  needs: "Needs you",
  ready: "Ready",
};

/** The agent states, in the app's order, as one vocabulary for every provider. */
export const AGENT_STATES = ["Starting", "Working", "Waiting", "Needs you", "Ready", "Done", "Failed"] as const;

export interface SampleAgent {
  provider: "claude" | "codex" | "cursor" | "gemini";
  name: string;
  account: string;
  model: string;
  state: SampleAgentState;
  activity: string;
  lines: readonly { kind: "in" | "tool" | "ok" | "dim" | "warn"; text: string }[];
}

export const SAMPLE_AGENTS: readonly SampleAgent[] = [
  {
    provider: "claude",
    name: "Dashboard Redesign",
    account: "Personal",
    model: "Opus · high",
    state: "working",
    activity: "Editing src/components/StatCard.tsx",
    lines: [
      { kind: "in", text: "Redesign the dashboard stat cards" },
      { kind: "tool", text: "Read src/pages/Dashboard.tsx" },
      { kind: "ok", text: "Edit StatCard.tsx  +38 −11" },
      { kind: "dim", text: "Running pnpm lint…" },
    ],
  },
  {
    provider: "codex",
    name: "Dashboard Tests",
    account: "Work",
    model: "Account default",
    state: "testing",
    activity: "Running pnpm test",
    lines: [
      { kind: "in", text: "Add tests for the stat cards" },
      { kind: "ok", text: "Wrote StatCard.test.tsx" },
      { kind: "tool", text: "pnpm test" },
      { kind: "dim", text: "14 passed · 2 running" },
    ],
  },
  {
    provider: "cursor",
    name: "Checkout Flow",
    account: "Personal",
    model: "Account default",
    state: "ready",
    activity: "3 files changed, ready to review",
    lines: [
      { kind: "in", text: "Fix the checkout total rounding" },
      { kind: "ok", text: "Updated cart/total.ts" },
      { kind: "ok", text: "All checks passed" },
      { kind: "dim", text: "Ready for a task" },
    ],
  },
  {
    provider: "gemini",
    name: "Payments Webhook",
    account: "Google",
    model: "Auto",
    state: "needs",
    activity: "Wants to read STRIPE_SECRET_KEY",
    lines: [
      { kind: "in", text: "Verify Stripe webhooks for paid orders" },
      { kind: "ok", text: "pnpm add stripe" },
      { kind: "warn", text: "Read .env.local (STRIPE_SECRET_KEY)" },
      { kind: "dim", text: "Credentials and secrets always ask" },
    ],
  },
];
