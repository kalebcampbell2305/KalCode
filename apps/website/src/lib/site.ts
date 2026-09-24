/**
 * Site-wide constants shared by the Astro pages, the Worker and the tests.
 * Keep this module free of Astro or Worker imports so both runtimes can use it.
 */

export const SITE_ORIGIN = "https://kalcoded.com";
export const SITE_NAME = "KalCode";

/** Version of the consent text shown under the early-access form (stored with each email). */
export const CONSENT_VERSION = "2026-09-24";

export interface PageInfo {
  path: string;
  title: string;
  description: string;
}

/**
 * Every public page. Titles are the exact <title> text; tests assert against this list and
 * the Worker accepts only these paths as an early-access `source`.
 */
export const PAGES = [
  {
    path: "/",
    title: "KalCode — One intelligence that operates your entire AI workspace",
    description:
      "KalCode is a desktop workspace in private development that connects Claude Code, Codex and Gemini CLI, runs them as persistent threads, and keeps you in control of every permission.",
  },
  {
    path: "/product",
    title: "Product — KalCode",
    description:
      "How KalCode is being built: provider connections, persistent threads, a live Dashboard, permission modes, JARVIS coordination, and local-first storage.",
  },
  {
    path: "/pricing",
    title: "Pricing — KalCode",
    description:
      "KalCode plans: Free, Pro and MAX. Plans become available at launch, and connecting your AI providers is free on every plan.",
  },
  {
    path: "/download",
    title: "Download — KalCode",
    description:
      "KalCode is in private development and has no public build yet. Join early access to hear when there is a build to try.",
  },
  {
    path: "/docs",
    title: "Docs — KalCode",
    description:
      "Documentation for KalCode as it is designed: permissions, providers, JARVIS, and local-first storage.",
  },
  {
    path: "/docs/permissions",
    title: "Permissions — KalCode Docs",
    description:
      "How KalCode permission modes (Plan, Approve, Auto, Bypass, Custom) decide what agents and JARVIS may do.",
  },
  {
    path: "/docs/providers",
    title: "Providers — KalCode Docs",
    description:
      "How KalCode connects Claude Code, Codex and Gemini CLI through documented integration methods, on every plan.",
  },
  {
    path: "/docs/jarvis",
    title: "JARVIS — KalCode Docs",
    description:
      "JARVIS is the intelligence inside KalCode that coordinates providers, threads and missions within your permissions.",
  },
  {
    path: "/docs/local-first",
    title: "Local-first — KalCode Docs",
    description:
      "What KalCode keeps on your device, how it stores secrets in the OS keychain, and what never leaves your machine.",
  },
  {
    path: "/changelog",
    title: "Changelog — KalCode",
    description: "Development milestones for KalCode, starting with 0.1.0 — Foundation.",
  },
  {
    path: "/security",
    title: "Security — KalCode",
    description:
      "KalCode security commitments: local-first data, an IPC allow-list, OS keychain secrets, no telemetry in current builds, and a permission model agents cannot bypass.",
  },
  {
    path: "/privacy",
    title: "Privacy — KalCode",
    description:
      "What kalcoded.com collects (only early-access emails), where it is stored, and how to remove your email.",
  },
  {
    path: "/terms",
    title: "Terms — KalCode",
    description: "Terms of use for kalcoded.com and the KalCode early-access list.",
  },
] as const satisfies readonly PageInfo[];

export type PagePath = (typeof PAGES)[number]["path"];

export const NOT_FOUND_PAGE: PageInfo = {
  path: "/404",
  title: "Page not found — KalCode",
  description: "The page you were looking for is not on kalcoded.com.",
};

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

export const PRIMARY_NAV = [
  { href: "/product", label: "Product" },
  { href: "/pricing", label: "Pricing" },
  { href: "/docs", label: "Docs" },
  { href: "/changelog", label: "Changelog" },
] as const;

export const FOOTER_NAV = {
  product: [
    { href: "/product", label: "Product" },
    { href: "/pricing", label: "Pricing" },
    { href: "/download", label: "Download" },
    { href: "/changelog", label: "Changelog" },
  ],
  docs: [
    { href: "/docs", label: "Overview" },
    { href: "/docs/permissions", label: "Permissions" },
    { href: "/docs/providers", label: "Providers" },
    { href: "/docs/jarvis", label: "JARVIS" },
    { href: "/docs/local-first", label: "Local-first" },
  ],
  legal: [
    { href: "/security", label: "Security" },
    { href: "/privacy", label: "Privacy" },
    { href: "/terms", label: "Terms" },
  ],
} as const;

export const DOCS_NAV = FOOTER_NAV.docs;
