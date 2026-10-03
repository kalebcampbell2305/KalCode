import type { DevelopmentService, OperationEnvironment, ThreadSummary } from "@kalcode/protocol";
import type { PickedElement } from "./browserBridge.ts";
import { normalizeBrowserAddress, persistableBrowserUrl } from "./browserModel.ts";

/** Where a Live Browser points: the dev server, a preview deployment or production. */
export type LiveBrowserTarget = "local" | "preview" | "production";
export const LIVE_BROWSER_TARGETS: readonly LiveBrowserTarget[] = ["local", "preview", "production"];
export const TARGET_LABEL: Record<LiveBrowserTarget, string> = {
  local: "Local",
  preview: "Preview",
  production: "Production",
};

export const DEFAULT_LOCAL_URL = "http://localhost:3000/";

export interface ResolvedTarget {
  url: string | null;
  /** Where the URL came from, for the tooltip ("Frontend dev server", "Cloudflare Pages"…). */
  source: string | null;
}

export type ResolvedTargets = Record<LiveBrowserTarget, ResolvedTarget>;

type Remembered = Partial<Record<LiveBrowserTarget, string>>;

const STORAGE_PREFIX = "kalcode.liveBrowser.targets.";

/** Per-workspace target URLs the person used (origin and path only). Never required to work. */
export function rememberedTargets(workspaceId: string): Remembered {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + workspaceId);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Remembered = {};
    for (const target of LIVE_BROWSER_TARGETS) {
      const value = parsed[target];
      if (typeof value !== "string") continue;
      try {
        out[target] = persistableBrowserUrl(value);
      } catch {
        // A corrupted entry is dropped; the target falls back to discovery.
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function rememberTarget(workspaceId: string, target: LiveBrowserTarget, url: string): void {
  try {
    const next = { ...rememberedTargets(workspaceId), [target]: persistableBrowserUrl(url) };
    localStorage.setItem(STORAGE_PREFIX + workspaceId, JSON.stringify(next));
  } catch {
    // Storage is a convenience only (private windows, blocked storage).
  }
}

function firstUrl(urls: readonly string[]): string | null {
  for (const url of urls) {
    try {
      return normalizeBrowserAddress(url);
    } catch {
      // Not an address the Browser can open.
    }
  }
  return null;
}

export function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost");
  } catch {
    return false;
  }
}

/** Running dev servers of a workspace with an address the Browser can open, newest first. */
export function devServers(
  services: readonly DevelopmentService[] | null | undefined,
  workspaceId: string,
): { service: DevelopmentService; url: string }[] {
  return (services ?? [])
    .filter((service) => service.workspaceId === workspaceId && service.status === "running")
    .flatMap((service) => {
      const url = firstUrl(service.urls.filter(isLocalUrl));
      return url ? [{ service, url }] : [];
    })
    .sort((a, b) => (a.service.uptimeSeconds ?? 0) - (b.service.uptimeSeconds ?? 0));
}

/**
 * The three targets for a workspace. Local prefers a running dev server, then the Local
 * environment and what the person used; Preview and Production come from Operations environments
 * (Preview falls back to Staging), then what the person used. Nothing is ever invented.
 */
export function resolveTargets(
  workspaceId: string,
  snapshot: { services?: readonly DevelopmentService[]; environments?: readonly OperationEnvironment[] } | null,
  remembered: Remembered,
): ResolvedTargets {
  const environments = (snapshot?.environments ?? []).filter((environment) => environment.workspaceId === workspaceId);
  const environment = (kind: OperationEnvironment["kind"]) => {
    const match = environments.find((candidate) => candidate.kind === kind && firstUrl(candidate.urls));
    return match ? { url: firstUrl(match.urls), source: match.platform ?? null } : null;
  };
  const [server] = devServers(snapshot?.services, workspaceId);
  const local = server
    ? { url: server.url, source: server.service.name }
    : (environment("local") ??
      (remembered.local ? { url: remembered.local, source: null } : { url: DEFAULT_LOCAL_URL, source: null }));
  const preview =
    environment("preview") ??
    environment("staging") ??
    (remembered.preview ? { url: remembered.preview, source: null } : { url: null, source: null });
  const production =
    environment("production") ??
    (remembered.production ? { url: remembered.production, source: null } : { url: null, source: null });
  return { local, preview, production };
}

function origin(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Which target the page is on: Local for any loopback address, else the matching origin. */
export function targetForUrl(url: string, targets: ResolvedTargets): LiveBrowserTarget | null {
  if (isLocalUrl(url)) return "local";
  const current = origin(url);
  if (!current) return null;
  if (current === origin(targets.production.url)) return "production";
  if (current === origin(targets.preview.url)) return "preview";
  return null;
}

// ---------------------------------------------------------------------------------------------
// Sign-in

export type AuthNotice =
  | { kind: "google_blocked" }
  | { kind: "google_signin" }
  | { kind: "popup_blocked"; url: string; host: string; signIn: boolean };

const GOOGLE_ACCOUNTS = "accounts.google.com";
const SIGN_IN_WORDS = /(?:^|[./_-])(?:oauth2?|signin|sign-in|login|log-in|auth|authorize|sso|accounts)(?:[./_?-]|$)/iu;

/**
 * What the pane should say about website sign-in. Google rejects sign-in from embedded browsers
 * ("This browser or app may not be secure", `disallowed_useragent`); KalCode never works around
 * that check. It offers the honest path: continue in the system browser.
 */
export function authNotice(url: string, blockedPopup: string | null): AuthNotice | null {
  if (blockedPopup) {
    try {
      const popup = new URL(blockedPopup);
      const signIn = popup.hostname === GOOGLE_ACCOUNTS || SIGN_IN_WORDS.test(`${popup.hostname}${popup.pathname}`);
      return { kind: "popup_blocked", url: popup.toString(), host: popup.hostname, signIn };
    } catch {
      // Ignore a pop-up address the Browser couldn't open anyway.
    }
  }
  try {
    const page = new URL(url);
    if (page.hostname !== GOOGLE_ACCOUNTS) return null;
    if (/\/signin\/(?:v2\/)?rejected|\/signin\/oauth\/error|\/v3\/signin\/rejected/iu.test(page.pathname)) {
      return { kind: "google_blocked" };
    }
    return { kind: "google_signin" };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Ask Agent

/** A coding agent the Browser can ask (a real provider terminal pane, AGENTS.md). */
export interface LiveBrowserAgent {
  threadId: string;
  name: string;
  providerId: string;
  providerName: string;
  accountLabel: string | null;
  lastActivityAt: string | null;
  /** The agent's PTY terminal, which a dev server it started may report as its owner. */
  terminalId: string | null;
}

const ENDED: ReadonlySet<ThreadSummary["status"]> = new Set(["completed", "failed", "interrupted", "offline"]);

/** Live coding agents of a workspace, most recently active first. Chat threads never qualify. */
export function askableAgents(threads: readonly ThreadSummary[], workspaceId: string): LiveBrowserAgent[] {
  return threads
    .filter(
      (thread) =>
        thread.workspaceId === workspaceId &&
        (thread.runtimeKind === "interactive_pty" || thread.terminalId != null) &&
        thread.archivedAt == null &&
        !ENDED.has(thread.status),
    )
    .map((thread) => ({
      threadId: thread.id,
      name: thread.name,
      providerId: thread.providerId,
      providerName: thread.providerName,
      accountLabel: thread.accountLabel ?? null,
      lastActivityAt: thread.lastActivityAt ?? null,
      terminalId: thread.terminalId ?? null,
    }))
    .sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? ""));
}

export interface AskContext {
  question: string;
  url: string;
  title: string | null;
  element: PickedElement | null;
  errors: readonly string[];
  screenshotPath: string | null;
}

const MAX_PROMPT_CHARS = 3_000;

function quoted(value: string, limit: number): string {
  const text = value.replace(/\s+/gu, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/**
 * One prompt line for the agent's terminal. Page data is labelled as untrusted website content
 * so the agent treats it as evidence, not instructions. The terminal path sanitizes it again.
 */
export function buildAgentPrompt(context: AskContext): string {
  const question = quoted(context.question, 600) || "Take a look at this page.";
  const parts = [`${question} [Live Browser context, from the website (untrusted page data):`];
  parts.push(`page ${context.url}${context.title ? ` titled "${quoted(context.title, 120)}"` : ""}.`);
  if (context.element) {
    parts.push(
      `Selected element: ${quoted(context.element.selector, 300)}${
        context.element.text ? ` with text "${quoted(context.element.text, 140)}"` : ""
      }; HTML: ${quoted(context.element.html, 900)}.`,
    );
  }
  if (context.errors.length > 0) {
    const list = context.errors
      .slice(-5)
      .map((error) => quoted(error, 240))
      .join(" | ");
    parts.push(`Console errors (${context.errors.length}): ${list}.`);
  }
  if (context.screenshotPath) parts.push(`Screenshot of the page: ${context.screenshotPath}.`);
  const prompt = `${parts.join(" ")}]`;
  return prompt.length > MAX_PROMPT_CHARS ? `${prompt.slice(0, MAX_PROMPT_CHARS - 2)}…]` : prompt;
}

// ---------------------------------------------------------------------------------------------
// Dev server offers

export interface DevServerOffer {
  key: string;
  url: string;
  /** "localhost:3000" */
  host: string;
  serviceName: string;
  /** The agent to open beside: the one whose terminal owns the server, else the only live agent. */
  agent: LiveBrowserAgent | null;
  /** A KalCode terminal that owns the server (when it isn't an agent's). */
  terminalId: string | null;
}

/**
 * The dev server worth offering in Live Browser: the newest running local server of the workspace
 * that no Live Browser shows yet and the person hasn't dismissed. Attribution never guesses
 * between several agents: with no owning terminal and more than one agent, no agent is named.
 */
export function devServerOffer(
  services: readonly DevelopmentService[] | null | undefined,
  workspaceId: string,
  agents: readonly LiveBrowserAgent[],
  openUrls: readonly string[],
  dismissed: ReadonlySet<string>,
): DevServerOffer | null {
  const open = new Set(openUrls.map((url) => origin(url)).filter((value): value is string => value !== null));
  for (const { service, url } of devServers(services, workspaceId)) {
    const key = `${workspaceId}:${service.id}:${url}`;
    if (dismissed.has(key) || open.has(origin(url) ?? url)) continue;
    const owner = service.terminalId ? agents.find((agent) => agent.terminalId === service.terminalId) : undefined;
    const agent = owner ?? (!service.terminalId && agents.length === 1 ? (agents[0] ?? null) : null);
    return {
      key,
      url,
      host: new URL(url).host,
      serviceName: service.name,
      agent,
      terminalId: agent ? null : service.terminalId,
    };
  }
  return null;
}

/** "Claude Code 2 · Work" style label for an agent. */
export function agentLabel(agent: LiveBrowserAgent): string {
  return agent.accountLabel ? `${agent.name} · ${agent.accountLabel}` : agent.name;
}
