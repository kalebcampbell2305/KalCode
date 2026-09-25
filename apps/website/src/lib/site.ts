/**
 * Site-wide constants shared by the Astro pages, the Worker and the tests.
 * Keep this module free of Astro or Worker imports so both runtimes can use it.
 */

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
    "KalVoice turns your voice into coding prompts and KalCode commands. Dictate directly into Claude Code, Codex, Gemini CLI and your terminals, or ask KalVoice to run your workspace.",
  status: "In development",
  /**
   * One push-to-talk key: hold it, speak, release. KalVoice decides from context whether the words
   * are dictation (typed into the focused input) or a command. Configurable to Caps Lock, another
   * single key, or Fn on keyboards that expose it to apps.
   */
  pushToTalkKey: "F8",
  /** The one line that says the key can be changed. Never claims Fn works everywhere. */
  keyNote:
    "F8 is the default. Choose Caps Lock or another single key instead, or Fn on keyboards that pass it to apps.",
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
    "Open your KalCode account to view your plan, KalVoice Requests and billing. Sign-in uses GitHub in the system browser; provider usage remains on your connected provider accounts.",
} as const satisfies PageInfo;

/**
 * Every public page. Titles are the exact <title> text; tests assert against this list and
 * the Worker accepts only these paths as an early-access `source`.
 */
export const PAGES = [
  {
    path: "/",
    title: "KalCode — One intelligence that operates your entire AI workspace",
    description:
      "KalCode is a desktop workspace in private development. Connect the coding agents you already use — Claude Code, Codex and Gemini CLI — run them side by side, approve every action, and speak your prompts with KalVoice.",
  },
  {
    path: "/product",
    title: "Product — KalCode",
    description:
      "The KalCode workspace piece by piece: provider panes, threads, the Dashboard, permission modes, KalVoice and local-first storage, with an honest table of what is built today and what is planned.",
  },
  {
    path: "/kalvoice",
    title: "KalVoice — KalCode",
    description:
      "KalVoice is the voice layer in KalCode: hold F8 and speak. Words land in the focused agent, on your device and unlimited; commands run your workspace. In development.",
  },
  {
    path: "/pricing",
    title: "Pricing — KalCode",
    description:
      "KalCode plans: Free, Pro, MAX and MAX 2X. Every plan includes all providers, all permission modes and unlimited local dictation; plans differ in KalVoice Requests and workspace features. AI usage stays on your own provider account.",
  },
  {
    path: "/download",
    title: "Download — KalCode",
    description:
      "Download KalCode for your platform, with the version, size and SHA-256 of every build — or join early access while there is no public build yet.",
  },
  {
    path: "/docs",
    title: "Docs — KalCode",
    description:
      "Documentation for KalCode as it is designed: permissions, providers, KalVoice, and local-first storage.",
  },
  {
    path: "/docs/permissions",
    title: "Permissions — KalCode Docs",
    description:
      "How KalCode permission modes (Plan, Approve, Auto, Bypass, Custom) decide what agents and KalVoice may do.",
  },
  {
    path: "/docs/providers",
    title: "Providers — KalCode Docs",
    description:
      "How KalCode connects Claude Code, Codex and Gemini CLI through documented integration methods using your own accounts, on every plan.",
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
      "What KalCode keeps on your device, how it stores secrets in the OS keychain, and what never leaves your machine.",
  },
  {
    path: "/updates",
    title: "Updates — KalCode",
    description:
      "KalCode product updates: Windows releases, KalVoice progress, provider workspace improvements and meaningful product news without the engineering noise.",
  },
  {
    path: "/security",
    title: "Security — KalCode",
    description:
      "KalCode security commitments: local-first data, on-device voice, your own provider accounts, an IPC allow-list, OS keychain secrets, no telemetry in current builds, and a permission model agents cannot bypass.",
  },
  {
    path: "/privacy",
    title: "Privacy — KalCode",
    description:
      "What kalcoded.com collects (only early-access emails), where it is stored, how to remove your email, and how KalVoice keeps voice audio on your device.",
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
 * Honest adapter status per provider (TRUTH.md, 2026-09-24). Shown wherever providers are named
 * next to each other, so no pane or bar implies more than the runtime can do today.
 */
export const PROVIDERS = [
  { id: "claude", name: "Claude Code", access: "Claude sign-in or API key", status: "Adapter built", state: "built" },
  {
    id: "codex",
    name: "Codex",
    access: "ChatGPT sign-in or API key",
    status: "Detected · adapter planned",
    state: "planned",
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    access: "Google sign-in or API key",
    status: "Detected · adapter planned",
    state: "planned",
  },
] as const;
