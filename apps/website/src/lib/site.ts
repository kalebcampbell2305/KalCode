/**
 * Site-wide constants shared by the Astro pages, the Worker and the tests.
 * Keep this module free of Astro or Worker imports so both runtimes can use it.
 */

import { PLANS } from "@kalcode/protocol/plans";

/** "Free, Pro, MAX and MAX 2X", from the plan catalog. */
const PLAN_NAMES = `${PLANS.slice(0, -1)
  .map((plan) => plan.name)
  .join(", ")} and ${PLANS.at(-1)?.name}`;

export const SITE_ORIGIN = "https://kalcoded.com";
export const SITE_NAME = "KalCode";

/**
 * Version of the consent text shown under the early-access form (stored with each email).
 * The date the text last changed, plus `.n` for a second revision on the same day. Bump it
 * whenever the wording in EarlyAccessForm.astro changes.
 *   2026-09-24    first text
 *   2026-09-24.2  adds the confirmation email (double opt-in)
 */
export const CONSENT_VERSION = "2026-09-24.2";

/** The published contact for privacy, legal and security matters. */
export const CONTACT_EMAIL = "kalcodebuilds@gmail.com";

/**
 * Sender of every email kalcoded.com sends (confirmation and removal links), delivered by Resend
 * from the verified kalcoded.com domain. Replies go to the published contact address.
 */
export const EMAIL_FROM = "KalCode <hello@kalcoded.com>";
export const EMAIL_REPLY_TO = CONTACT_EMAIL;

/** Early-access double opt-in: link pages, link lifetime and per-address email throttle. */
export const EARLY_ACCESS_EMAIL = {
  /** Page a confirmation link opens; it POSTs the link's code only when the person presses the button. */
  confirmPath: "/early-access/confirm",
  /** Page a removal link opens; same rule. */
  removePath: "/early-access/remove",
  /** Links work once and expire after this long; unconfirmed sign-ups are deleted after it. */
  linkTtlHours: 72,
  /** At most one email to an address per this many minutes… */
  minIntervalMinutes: 10,
  /** …and at most this many per address per UTC day. */
  dailyPerAddress: 5,
  /**
   * Default cap on all emails the site sends per UTC day (the Worker var EMAIL_DAILY_LIMIT
   * overrides it). Keeps a flood of sign-ups inside the email provider's free allowance.
   */
  dailyTotal: 90,
} as const;

/**
 * Official social accounts (owner-supplied, 2026-09-24). Every social link on the site reads from
 * here; `official` is the KalCode product account, `founder` the founder's own account.
 */
export const SOCIAL = {
  official: { network: "X", handle: "@KalCodeDev", url: "https://x.com/KalCodeDev", label: "KalCode on X" },
  founder: {
    network: "X",
    handle: "@CampbellKaleb23",
    url: "https://x.com/CampbellKaleb23",
    label: "KalCode's founder on X",
  },
} as const;

/**
 * KalVoice facts shown across the site (docs/KALVOICE.md). KalVoice is in development
 * (campaign Z12): pages must describe it as designed, never as shipped.
 */
export const KALVOICE = {
  name: "KalVoice",
  line: "Speak your prompts. Control your workspace. Coordinate your coding agents.",
  summary:
    "KalVoice turns your voice into coding prompts and KalCode commands. Dictate directly into Claude Code, Codex and your terminals, or ask KalVoice to run your workspace.",
  status: "In development",
  /**
   * One push-to-talk key: hold it, speak, release. KalVoice decides from context whether the words
   * are dictation (typed into the focused input) or a command. Configurable to another function
   * key, Pause, Scroll Lock or Insert; the app refuses Caps Lock and Fn
   * (crates/kalvoice/src/shortcuts.rs). The key is held only while KalCode is the foreground app.
   */
  pushToTalkKey: "F8",
  /** Says the key can be changed and when it works. Offers only keys the app accepts. */
  keyNote:
    "F8 is the default. Choose another function key, Pause, Scroll Lock or Insert instead. The key works while KalCode is the active window, so other apps keep it otherwise.",
  globeAlt: "KalVoice globe: a sphere of connected points of light",
} as const;

export interface PageInfo {
  path: string;
  title: string;
  description: string;
}

/** Private account entry point. It is routable from site chrome but excluded from search/sitemap. */
export const ACCOUNT_PAGE = {
  path: "/account",
  title: "Account — KalCode",
  description:
    "Open your KalCode account to view your plan, KalVoice Requests and billing. Sign in with Google, Microsoft or a one-time email link; provider usage remains on your connected provider accounts.",
} as const satisfies PageInfo;

/**
 * The private owner dashboard (docs/OWNER_ANALYTICS.md). Deliberately not in PAGES, navigation,
 * the footer or the sitemap, and noindex. Its data is served only to an OWNER account.
 */
export const OWNER_PAGE = {
  path: "/owner/analytics",
  title: "KalCode · Owner",
  description: "Private KalCode owner dashboard.",
} as const satisfies PageInfo;

/**
 * Every public page. Titles are the exact <title> text; tests assert against this list and
 * the Worker accepts only these paths as an early-access `source`.
 */
export const PAGES = [
  {
    path: "/",
    title: "KalCode — AI Coding Workspace for Claude Code & Codex",
    description:
      "KalCode brings Claude Code and Codex into one AI coding workspace. Run agents in real terminals, preview your app and use KalVoice. Explore the official site.",
  },
  {
    path: "/product",
    title: "AI Coding Workspace Features — KalCode",
    description:
      "Explore KalCode's AI coding workspace: agent terminals, provider threads, Dashboard, KalVoice and local-first storage. See available features and the roadmap.",
  },
  {
    path: "/kalvoice",
    title: "KalVoice: Voice Commands for AI Coding — KalCode",
    description:
      "KalVoice is the voice layer in KalCode: hold F8 and speak. Words land in the focused agent, on your device and unlimited; commands run your workspace. In development.",
  },
  {
    path: "/pricing",
    title: "Pricing & Plans — KalCode",
    description: `Compare KalCode ${PLAN_NAMES} plans, monthly or yearly. Unlimited local coding agents and terminals. Upgrade workflow, scale and autonomy.`,
  },
  {
    path: "/download",
    title: "Download KalCode — Official Desktop App",
    description:
      "Get the official KalCode desktop app. Find available Windows and macOS downloads, release details and checksums, and start your AI coding workspace.",
  },
  {
    path: "/docs",
    title: "Documentation & Setup Guide — KalCode",
    description:
      "Get started with KalCode: connect your coding providers, choose permissions, use KalVoice and learn how your AI coding workspace stores data locally.",
  },
  {
    path: "/docs/permissions",
    title: "Permissions — KalCode Docs",
    description:
      "How KalCode permission modes decide what agents and KalVoice may do: threads in 0.1.6 run in Plan, Approve or Auto; Bypass and Custom are planned.",
  },
  {
    path: "/docs/providers",
    title: "Providers — KalCode Docs",
    description:
      "How KalCode connects Claude Code and Codex through documented integration methods using your own accounts, on every plan, and why Gemini CLI is unavailable in 0.1.6.",
  },
  {
    path: "/docs/kalvoice",
    title: "KalVoice — KalCode Docs",
    description:
      "KalVoice reference: the push-to-talk key, dictation and commands, how KalVoice Requests are counted, local command interpretation, and how audio stays on your device.",
  },
  {
    path: "/docs/local-first",
    title: "Local-first — KalCode Docs",
    description:
      "What KalCode keeps on your device, where your KalCode session and provider sign-ins are stored, and what never leaves your machine.",
  },
  {
    path: "/updates",
    title: "Release Notes & Product Updates — KalCode",
    description:
      "KalCode product updates: Windows releases, KalVoice progress, provider workspace improvements and meaningful product news without the engineering noise.",
  },
  {
    path: "/security",
    title: "Security — KalCode",
    description:
      "KalCode security commitments: local-first data, on-device voice, your own provider accounts in separate managed profiles, an IPC allow-list, your KalCode session in the OS credential store, no telemetry in current builds, and a permission model agents cannot bypass.",
  },
  {
    path: "/privacy",
    title: "Privacy — KalCode",
    description:
      "Read KalCode's privacy notice for the website, accounts and desktop app, including data storage, email removal and on-device voice processing.",
  },
  {
    path: "/terms",
    title: "Terms — KalCode",
    description: "Terms of use for kalcoded.com, the KalCode early-access list and the KalCode preview app.",
  },
] as const satisfies readonly PageInfo[];

export type PagePath = (typeof PAGES)[number]["path"];

export const NOT_FOUND_PAGE: PageInfo = {
  path: "/404",
  title: "Page not found — KalCode",
  description: "The page you were looking for is not on kalcoded.com.",
};

/**
 * Pages opened from links in our emails. They are not public pages: not in PAGES, the sitemap
 * or the navigation, never indexed, and never valid as an early-access `source`.
 */
export const EMAIL_ACTION_PAGES = {
  confirm: {
    path: EARLY_ACCESS_EMAIL.confirmPath,
    title: "Confirm your email — KalCode",
    description: "Confirm your email address for the KalCode early-access list.",
  },
  remove: {
    path: EARLY_ACCESS_EMAIL.removePath,
    title: "Remove your email — KalCode",
    description: "Confirm that you want your email address removed from the KalCode early-access list.",
  },
} as const satisfies Record<string, PageInfo>;

export function getPage(path: PagePath): PageInfo {
  const page = PAGES.find((candidate) => candidate.path === path);
  if (!page) {
    throw new Error(`Unknown page: ${path}`);
  }
  return page;
}

export const PAGE_PATHS: ReadonlySet<string> = new Set(PAGES.map((page) => page.path));

export function isKnownPagePath(value: string): boolean {
  return PAGE_PATHS.has(value);
}

/** Header navigation, in order. The Download call to action and the X link sit after these. */
export const PRIMARY_NAV = [
  { href: "/product", label: "Product" },
  { href: "/kalvoice", label: "KalVoice" },
  { href: "/pricing", label: "Pricing" },
  { href: "/docs", label: "Docs" },
  { href: "/updates", label: "Updates" },
] as const;

export const FOOTER_NAV = {
  product: [
    { href: "/product", label: "Product" },
    { href: "/kalvoice", label: "KalVoice" },
    { href: "/pricing", label: "Pricing" },
    { href: "/download", label: "Download" },
    { href: "/updates", label: "Updates" },
  ],
  docs: [
    { href: "/docs", label: "Overview" },
    { href: "/docs/permissions", label: "Permissions" },
    { href: "/docs/providers", label: "Providers" },
    { href: "/docs/kalvoice", label: "KalVoice" },
    { href: "/docs/local-first", label: "Local-first" },
  ],
  legal: [
    { href: "/security", label: "Security" },
    { href: "/privacy", label: "Privacy" },
    { href: "/terms", label: "Terms" },
  ],
} as const;

export const DOCS_NAV = FOOTER_NAV.docs;

/** The brand tagline, set as live text (never the raster lettering, which smudges at small sizes). */
export const TAGLINE = "One intelligence. A brighter tomorrow.";

/**
 * Honest provider status on the Stable app (B4 8d6c133: crates/providers/src/catalog.rs marks all
 * three adapters Implemented; apps/desktop/src-tauri/src/thread_commands.rs starts every thread in
 * the account's managed profile). Access is the in-app sign-in each provider account supports:
 * Claude Code `auth login --claudeai`, Codex ChatGPT login on personal plans (organization plans
 * are refused), Gemini CLI "Sign in with Google". Managed launches strip provider API-key
 * variables, so no API-key path is claimed. Provider panes are gated off Stable and not claimed.
 */
export const PROVIDERS = [
  { id: "claude", name: "Claude Code", access: "Claude account sign-in", status: "Adapter built", state: "built" },
  { id: "codex", name: "Codex", access: "ChatGPT sign-in (personal plans)", status: "Adapter built", state: "built" },
  { id: "gemini", name: "Gemini CLI", access: "Google sign-in", status: "Unavailable in 0.1.6", state: "unavailable" },
] as const;

/**
 * Gemini CLI availability in KalCode 0.1.6 (unchanged since B5 65be519). On June 18, 2026 Google stopped serving
 * Gemini CLI "Login with Google" for Gemini Code Assist for individuals, Google AI Pro and Ultra
 * (developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals); Standard and
 * Enterprise licenses are unaffected but need a Google Cloud project, which 0.1.6 cannot pass:
 * managed launches keep only the base environment (crates/providers/src/env.rs BASE_ALLOW,
 * managed.rs launch_env) and ignore local .env files (gemini/managed_policy.rs floor_settings).
 * B5 reports "Signed in" from the credential file alone (gemini_account_auth.rs credential_state),
 * so a refused personal account still looks signed in. No Antigravity support is claimed.
 */
export const GEMINI_AVAILABILITY = {
  short: "Gemini CLI is unavailable in KalCode 0.1.6.",
  notice:
    "On June 18, 2026, Google ended Gemini CLI access through Sign in with Google for personal Google accounts: Gemini Code Assist for individuals, Google AI Pro and Google AI Ultra. KalCode 0.1.6 also can't set the Google Cloud project that Gemini Code Assist Standard and Enterprise licenses need, so Gemini CLI is currently unavailable in KalCode. A personal Google account can still finish sign-in and show as signed in, but its threads fail. Claude Code and Codex are unaffected. Updates will say when Gemini CLI can be used in KalCode again.",
} as const;
