/**
 * The 2-minute tour of the live demo. Each step puts the demo in a state (`setup`, an action the
 * client runs) and spotlights one element (`target`, a `data-tour` value; the card centres when the
 * target is not on screen, e.g. the sidebar on a phone).
 */
export interface TourStep {
  kicker: string;
  title: string;
  body: string;
  tip?: string;
  target?: string;
  /** Demo actions to run before the step shows (same vocabulary as `data-do`). */
  setup?: readonly string[];
}

export const TOUR: readonly TourStep[] = [
  {
    kicker: "Welcome",
    title: "Welcome to KalCode",
    body: "KalCode brings your AI coding tools into one workspace. This is a live demo workspace: everything you click works.",
    setup: ["menus-close", "go:code"],
  },
  {
    kicker: "Code",
    title: "Your agents, in real terminals",
    body: "This is Code, where your real Claude Code and Codex coding agents run. Each agent is its own terminal pane: Dashboard Redesign is redesigning the dashboard while Dashboard Tests runs the tests.",
    tip: "An agent is a terminal, not a chat thread.",
    target: "nav-code",
    setup: ["menus-close", "go:code"],
  },
  {
    kicker: "Launch an agent",
    title: "Choose provider, account, model and effort",
    body: "New agent opens the launcher. Pick an account, the exact model and the effort, and how many agents. Each one gets its own terminal.",
    tip: "Press Launch to add one. It appears right in Code.",
    target: "launcher",
    setup: ["menus-close", "go:code", "launcher"],
  },
  {
    kicker: "Agent Fleet",
    title: "Every coding agent, at a glance",
    body: "The Dashboard's Agent Fleet shows what every agent is doing: working, waiting for you, or done. Click a card to jump straight to its terminal.",
    target: "fleet",
    setup: ["launcher-close", "menus-close", "go:dashboard"],
  },
  {
    kicker: "Needs You",
    title: "Know the moment an agent needs you",
    body: "Login Validation wants to run a command. Needs You counts every agent waiting on you, and one click takes you to it.",
    target: "needs",
    setup: ["menus-close", "go:dashboard"],
  },
  {
    kicker: "Accounts",
    title: "All your provider accounts",
    body: "Connect several Claude Code and Codex accounts. See how much each one has left before you launch, and pick the right one for every agent.",
    target: "accounts",
    setup: ["menus-close", "menu:accounts"],
  },
  {
    kicker: "Live Browser",
    title: "Your app, beside the agent building it",
    body: "Live Browser opens your dev server in a pane next to your agents. KalCode found localhost:3000 by itself.",
    target: "browser",
    setup: ["menus-close", "browser"],
  },
  {
    kicker: "KalVoice",
    title: "Control your workspace by voice",
    body: "Hold F8 and speak: your words land in the focused agent, or KalVoice runs the command. Try a phrase.",
    target: "voice",
    setup: ["menus-close", "voice:open"],
  },
  {
    kicker: "Operations",
    title: "Runs, Queue, Services, Environments, Activity",
    body: "Everything your agents run is one record here, from queued task to finished run, with your services and environments beside it.",
    target: "operations",
    setup: ["menus-close", "voice:close", "go:operations"],
  },
  {
    kicker: "You're ready",
    title: "Ready to build?",
    body: "Download KalCode and it opens just like this, with your own projects, your own accounts and your real agents.",
    setup: ["menus-close", "go:code"],
  },
];
