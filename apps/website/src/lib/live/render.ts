/**
 * The live KalCode demo, drawn. Pure state -> HTML-string functions: Astro renders the first paint
 * at build time, the client re-renders after every action and morphs the DOM (scripts/live/app.ts).
 *
 * Layout and words follow the shipped desktop app: the Command Deck top bar, the navigation bar
 * (Back/Forward, breadcrumbs, Go to anything), favorites and pins, the Stable sidebar, tabbed Code
 * panes with the terminal-header account picker, Smart Close, the New agent launcher and the Agents
 * rail. Agent states come from the protocol's one agent-state model. Every interactive element
 * carries `data-do="<action>[:arg]"`. No inline styles (the site's CSP forbids them): dynamic sizes
 * are classes or data attributes.
 */

import {
  AGENT_FILTER_LABEL,
  AGENT_FILTERS,
  AGENT_STATE_LABEL,
  AGENT_STATE_TEXT,
  AGENT_STATE_TONE,
  isAgentBusy,
} from "@kalcode/protocol";
import { formatKalVoiceAllowance, getPlan, PLANS } from "@kalcode/protocol/plans";
import { renderAdaptiveCanvas, renderCanvasTools } from "./canvas";
import type { LiveIcon } from "./icons";
import { renderMemory } from "./memory";
import {
  type Account,
  type Agent,
  accountLabel,
  accountOf,
  accountSuggestion,
  agentState,
  agentsIn,
  agentsList,
  attentionItems,
  canNav,
  counts,
  DEV_URL,
  EFFORTS,
  ENVIRONMENTS,
  type Favorite,
  type Frame,
  focusedTab,
  isAvailable,
  isWorking,
  type Line,
  locationLabel,
  MAX_AGENTS_PER_LAUNCH,
  MODE_DESCRIPTION,
  MODE_LABEL,
  MODELS,
  type Mode,
  modelLabel,
  needsYou,
  PRIMARY_SURFACES,
  PROVIDER_NAME,
  PROVIDERS,
  type ProviderId,
  paneCount,
  promptMark,
  type Run,
  runs,
  type State,
  SURFACES,
  type Tab,
  VOICE_PHRASES,
  WORKSPACE,
  workMark,
} from "./model";
import { TOUR } from "./tour";

export interface RenderConfig {
  downloadHref: string;
  downloadLabel: string;
  accountHref: string;
}

export function esc(value: string | number): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function icon(name: LiveIcon, cls = ""): string {
  return `<svg class="lk-i${cls ? ` ${cls}` : ""}" aria-hidden="true" focusable="false"><use href="#lk-${name}"/></svg>`;
}

/** Provider marks as the app draws them (@kalcode/ui ProviderMark): Cursor uses the generic glyph. */
export function glyph(provider: ProviderId | "terminal" | "browser" | "widget"): string {
  if (provider === "terminal") return icon("terminal", "lk-glyph-i");
  if (provider === "browser") return icon("globe", "lk-glyph-i");
  if (provider === "widget") return icon("dashboard", "lk-glyph-i");
  if (provider === "cursor")
    return `<svg class="lk-glyph lk-glyph--cursor" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M8 1.5 13.6 4.75v6.5L8 14.5 2.4 11.25v-6.5Z"/><text x="8" y="10.6" text-anchor="middle" fill="currentColor" stroke="none" font-size="7" font-weight="600">C</text></svg>`;
  return `<span class="lk-glyph lk-glyph--${provider}" aria-hidden="true"></span>`;
}

/** The pane and card status chip: the protocol's AGENT_STATE_LABEL and tone. */
export function statusChip(agent: Pick<Agent, "status" | "activity" | "approval">): string {
  const state = agentState(agent);
  return `<span class="lk-status" data-tone="${AGENT_STATE_TONE[state]}"><span class="lk-status__dot" aria-hidden="true"></span>${AGENT_STATE_LABEL[state]}</span>`;
}
function tone(agent: Agent): string {
  return AGENT_STATE_TONE[agentState(agent)];
}

/** A small "Coming soon" tag for any demo surface whose roadmap feature has not shipped. */
function soon(featureId: string): string {
  return isAvailable(featureId) ? "" : `<span class="lk-soon">Coming soon</span>`;
}

function hint(text: string): string {
  return ` data-hint="${esc(text)}"`;
}

function meter(left: number): string {
  const step = Math.max(0, Math.min(10, Math.round(left / 10)));
  return `<span class="lk-meter" data-low="${left < 20}" aria-hidden="true"><span class="lk-meter__fill" data-w="${step}"></span></span>`;
}

function elapsed(minutes: number): string {
  return minutes ? `${minutes}m` : "now";
}

// ── Top bar (Command Deck) ──────────────────────────────────────────────────────────────────

/** The account the deck's account chip shows: the focused agent's, else the next launch's. */
function chipAccount(state: State): Account | undefined {
  const tab = focusedTab(state);
  const agent = tab?.agent ? state.agents[tab.agent] : undefined;
  return (
    (agent && accountOf(state, agent.account)) ?? state.accounts.find((a) => a.provider === "claude" && a.isDefault)
  );
}

function topBar(state: State): string {
  const c = counts(state);
  const account = chipAccount(state);
  const left = account?.windows[0]?.left ?? 0;
  return `<header class="lk-top">
  <div class="lk-brand"><span class="lk-brand__mark" aria-hidden="true"></span><span class="lk-wordmark" aria-hidden="true"></span><span class="visually-hidden">KalCode</span><span class="lk-demo"${hint("This is a temporary demo workspace. Reset or reload to start over.")}>Demo</span></div>
  <div class="lk-ctx">
    <button type="button" class="lk-ctx__chip" data-do="go:code"${hint("The project folder your agents work in.")}>${icon("folder")}<span><small>Workspace</small>${WORKSPACE.name}</span>${icon("chevron", "lk-caret")}</button>
    <span class="lk-ctx__chip lk-ctx__chip--static">${icon("branch")}<span><small>Branch</small><span class="lk-ctx__branch">${WORKSPACE.branch}<em>±${WORKSPACE.changed}</em><em>↑${WORKSPACE.ahead}</em></span></span></span>
    <button type="button" class="lk-ctx__chip" data-do="menu:environment" aria-expanded="${state.menu === "environment"}"${hint("Local, Preview, Staging or Production: where you're looking.")}>${icon("globe")}<span><small>Environment</small><span><span class="lk-env-dot" data-env="${state.environment}"></span>${state.environment}</span></span></button>
    <button type="button" class="lk-ctx__chip" data-do="menu:mode" data-tour="mode" aria-expanded="${state.menu === "mode"}" aria-label="Permission mode: ${MODE_LABEL[state.mode]}"${hint("How new agents may act. Bypass: no prompts, secrets still ask.")}>${icon("approvals")}<span><small>Mode</small>${MODE_LABEL[state.mode]}</span>${icon("chevron", "lk-caret")}</button>
  </div>
  <div class="lk-top__center"><button type="button" class="lk-search" data-do="menu:palette" data-tour="palette" aria-label="Search or run a command" aria-keyshortcuts="Control+K Meta+K">${icon("search")}<span>Search or run a command</span><kbd>Ctrl K</kbd></button></div>
  <div class="lk-signals">
    <button type="button" class="lk-signal" data-tone="${c.working ? "working" : "muted"}" data-do="go:dashboard" aria-label="${c.working} ${c.working === 1 ? "agent" : "agents"} working. Show agents"><span class="lk-signal__dot" aria-hidden="true"></span><strong>${c.working}</strong><span class="lk-signal__word">working</span></button>
    <button type="button" class="lk-signal" data-tone="${c.needs ? "waiting" : "muted"}" data-do="needs" data-tour="needs" data-active="${c.needs > 0}" aria-label="${c.needs} ${c.needs === 1 ? "thing needs" : "things need"} you"><span class="lk-signal__dot" aria-hidden="true"></span><strong>${c.needs}</strong><span class="lk-signal__word">${c.needs === 1 ? "needs" : "need"} you</span></button>
  </div>
  <button type="button" class="lk-accounts" data-do="menu:accounts" data-tour="accounts" data-low="${left < 20}" aria-label="Account and usage center" aria-expanded="${state.menu === "accounts"}"${hint("Your provider accounts and what each has left.")}>${icon("users")}<span class="lk-accounts__text"><strong>${esc(account?.name ?? "Accounts")}</strong><small>${left}% left</small></span>${icon("chevron", "lk-caret")}</button>
</header>`;
}

// ── Navigation bar and favorites ────────────────────────────────────────────────────────────

function voiceWord(state: State): string {
  return { ready: "Ready", listening: "Listening…", processing: "Processing", executing: "Executing", done: "Done" }[
    state.voice.state
  ];
}

function navBar(state: State): string {
  const here = state.nav.entries[state.nav.index] ?? "code";
  const page = here.startsWith("code:") ? "Code" : locationLabel(state, here);
  const target = here.startsWith("code:") ? locationLabel(state, here) : "";
  return `<div class="lk-navbar" data-tour="navbar">
  <div class="lk-navbar__controls">
    <button type="button" class="lk-icon-btn" data-do="nav:back" aria-label="Go back" aria-keyshortcuts="Alt+ArrowLeft"${canNav(state, -1) ? "" : " disabled"}${hint("Back (Alt ←)")}>${icon("back")}</button>
    <button type="button" class="lk-icon-btn" data-do="nav:forward" aria-label="Go forward" aria-keyshortcuts="Alt+ArrowRight"${canNav(state, 1) ? "" : " disabled"}${hint("Forward (Alt →)")}>${icon("forward")}</button>
    <span class="lk-anchor"><button type="button" class="lk-icon-btn" data-do="menu:history" aria-label="Recent navigation" aria-expanded="${state.menu === "history"}"${state.nav.entries.length < 2 ? " disabled" : ""}>${icon("history")}</button>${state.menu === "history" ? historyMenu(state) : ""}</span>
  </div>
  <nav class="lk-crumbs" aria-label="Breadcrumb"><button type="button" data-do="go:code">${WORKSPACE.name}</button>${icon("chevronRight")}<span${target ? "" : ' aria-current="page"'}>${esc(page)}</span>${target ? `${icon("chevronRight")}<span aria-current="page">${esc(target)}</span>` : ""}</nav>
  <button type="button" class="lk-voice-pill" data-do="voice:toggle" data-tour="voice" aria-label="KalVoice: ${voiceWord(state)}" aria-expanded="${state.voice.open}"${hint("KalVoice: hold F8 and speak. Here, pick a phrase.")}><span class="lk-orb" data-state="${state.voice.state}" aria-hidden="true"></span><span class="lk-voice-pill__word">KalVoice</span><span class="lk-voice-pill__state"><span class="lk-dot" data-tone="${state.voice.state === "ready" ? "muted" : "working"}"></span>${voiceWord(state)}</span></button>
  <button type="button" class="lk-goto" data-do="menu:palette" data-tour="switcher" aria-label="Open quick switcher">${icon("search")}<span>Go to anything</span><kbd>Ctrl K</kbd></button>
</div>`;
}

function historyMenu(state: State): string {
  const items = state.nav.entries
    .map((entry, index) => ({ entry, index }))
    .reverse()
    .slice(0, 12)
    .map(({ entry, index }) => {
      const page = entry.startsWith("code:") ? "Code" : locationLabel(state, entry);
      return `<button type="button" role="menuitem" class="lk-menu__item" data-do="nav-to:${index}"><span>${esc(locationLabel(state, entry))}<small>${esc(page)}${index === state.nav.index ? " · Current" : ""}</small></span></button>`;
    })
    .join("");
  return `<div class="lk-menu lk-menu--history" role="menu" aria-label="Recent navigation"><p class="lk-label">Recent navigation</p>${items}</div>`;
}

const FAVORITE_ICON: Record<Favorite["kind"], LiveIcon> = {
  agent: "bot",
  terminal: "terminal",
  browser: "globe",
  command: "play",
  account: "user",
};

function favoritesBar(state: State): string {
  if (!state.favorites.length) return "";
  const group = (scope: Favorite["scope"]) => {
    const list = state.favorites.filter((f) => f.scope === scope);
    if (!list.length) return "";
    const pin = scope === "pin";
    return `<div class="lk-favs__group"><span class="lk-favs__label" title="${pin ? "Global pins" : `${WORKSPACE.name} favorites`}">${icon(pin ? "pin" : "star")}<span>${pin ? "Pins" : "Favorites"}</span></span><ul role="list" class="lk-favs__items" aria-label="${pin ? "Global pins" : "Workspace favorites"}">${list
      .map(
        (f) =>
          `<li><button type="button" class="lk-fav" data-key="fv-${f.key}" data-do="fav:${esc(f.key)}" title="${esc(f.title)} · ${f.kind}">${icon(FAVORITE_ICON[f.kind])}<span>${esc(f.title)}</span></button></li>`,
      )
      .join("")}</ul></div>`;
  };
  return `<div class="lk-favs" data-tour="favorites">${group("pin")}${group("favorite")}</div>`;
}

// ── Sidebar and mobile tab bar ──────────────────────────────────────────────────────────────

function sidebar(state: State): string {
  const c = counts(state);
  const needs = attentionItems(state).length;
  const items = SURFACES.filter((s) => PRIMARY_SURFACES.includes(s.id))
    .map(
      (s) =>
        `<li><button type="button" class="lk-nav" data-do="go:${s.id}" data-tour="nav-${s.id}" aria-current="${state.surface === s.id ? "page" : "false"}"${hint(s.hint)}>${icon(s.icon as LiveIcon)}<span class="lk-nav__label">${s.label}</span></button></li>`,
    )
    .join("");
  const busy = c.working + c.needs;
  const more = SURFACES.some((s) => !PRIMARY_SURFACES.includes(s.id) && state.surface === s.id);
  return `<nav class="lk-side" aria-label="KalCode">
  <ul role="list">${items}</ul>
  <div class="lk-side__projects"><p class="lk-label">Projects</p><ul role="list"><li><button type="button" class="lk-project" data-do="go:code" aria-current="${state.surface === "code" ? "true" : "false"}">${icon("folder")}<span class="lk-nav__label">${esc(WORKSPACE.name)}</span>${busy ? `<span class="lk-project__live" data-tone="${c.needs ? "waiting" : "working"}" aria-label="${busy} active"><span class="lk-dot"></span>${busy}</span>` : ""}</button></li></ul></div>
  <ul role="list" class="lk-side__foot">
    <li class="lk-anchor"><button type="button" class="lk-nav" data-do="menu:notifications" data-urgent="${needs > 0}" aria-expanded="${state.menu === "notifications"}" aria-label="${needs ? `Needs you, ${needs} waiting` : "Needs you, nothing waiting"}"${hint("Questions, approvals and failures: only what needs you.")}>${icon("bell")}<span class="lk-nav__label">Needs you</span>${needs ? `<span class="lk-badge">${needs}</span>` : ""}</button>${state.menu === "notifications" ? notifications(state) : ""}</li>
    <li class="lk-anchor"><button type="button" class="lk-nav" data-do="menu:more" aria-expanded="${state.menu === "more"}" aria-current="${more ? "page" : "false"}"${hint("Browser, Operations, KalVoice, Threads, Unified Memory and Providers.")}>${icon("layout")}<span class="lk-nav__label">More</span></button>${state.menu === "more" ? moreMenu(state) : ""}</li>
    <li><button type="button" class="lk-nav" data-do="go:settings" aria-current="${state.surface === "settings" ? "page" : "false"}">${icon("settings")}<span class="lk-nav__label">Settings</span></button></li>
    <li class="lk-me"><span class="lk-me__avatar" aria-hidden="true">G</span><span class="lk-nav__label"><strong>Guest</strong><small>Demo workspace</small></span></li>
  </ul>
</nav>`;
}

/** More: every other place, one click away (as in the app's sidebar footer). */
function moreMenu(state: State): string {
  const rows = SURFACES.filter((s) => !PRIMARY_SURFACES.includes(s.id))
    .map(
      (s) =>
        `<button type="button" role="menuitem" class="lk-menu__item" data-do="go:${s.id}" data-tour="nav-${s.id}" aria-current="${state.surface === s.id ? "page" : "false"}">${icon(s.icon as LiveIcon)}<span>${s.label}</span></button>`,
    )
    .join("");
  return `<div class="lk-menu lk-menu--more" role="menu" aria-label="More places"><button type="button" role="menuitem" class="lk-menu__item" data-do="browser">${icon("globe")}<span>Browser</span></button>${rows}</div>`;
}

/** Needs You: what genuinely needs the visitor (what, why, next), then the notification history. */
function notifications(state: State): string {
  const items = attentionItems(state)
    .map(
      (i) =>
        `<li class="lk-attn" data-tone="${i.tone}"><span class="lk-attn__glyph" aria-hidden="true">${icon(i.tone === "failed" ? "alert" : "approvals")}</span><div><small>${esc(i.source)}</small><strong>${esc(i.what)}</strong><p>${esc(i.why)}</p><button type="button" class="lk-btn lk-btn--primary" data-do="agent:${i.agent}">${i.action}</button></div></li>`,
    )
    .join("");
  const rows = state.notes
    .map(
      (n) =>
        `<li data-tone="${n.tone === "done" ? "done" : n.tone === "waiting" ? "waiting" : "muted"}"><span class="lk-dot"></span><span>${esc(n.text)}</span>${n.agent && state.agents[n.agent] ? `<button type="button" class="lk-btn lk-btn--ghost" data-do="agent:${n.agent}">Open</button>` : ""}</li>`,
    )
    .join("");
  return `<div class="lk-menu lk-menu--notes" role="dialog" aria-label="Needs you"><p class="lk-label">Needs you</p>${items ? `<ul role="list" class="lk-attns">${items}</ul>` : `<p class="lk-empty lk-attns__clear">${icon("check")}Nothing needs you.</p>`}<p class="lk-label">History</p><ul role="list" class="lk-notes">${rows || `<li class="lk-empty">You're all caught up.</li>`}</ul></div>`;
}

function tabBar(state: State): string {
  const c = counts(state);
  const short: Partial<Record<string, string>> = { operations: "Ops", memory: "Memory" };
  return `<nav class="lk-tabbar" aria-label="KalCode">${SURFACES.map(
    (s) =>
      `<button type="button" class="lk-tabbar__item" data-do="go:${s.id}" data-tour="nav-${s.id}" aria-label="${s.label}" aria-current="${state.surface === s.id ? "page" : "false"}">${icon(s.icon as LiveIcon)}<span>${short[s.id] ?? s.label}</span>${s.id === "dashboard" && c.needs ? `<span class="lk-badge">${c.needs}</span>` : ""}</button>`,
  ).join("")}</nav>`;
}

// ── Agents rail ─────────────────────────────────────────────────────────────────────────────

function railRow(a: Agent): string {
  const s = agentState(a);
  const explained = isAgentBusy(s) || s === "needs_you" || s === "waiting";
  const detail =
    explained && a.activity && a.activity !== AGENT_STATE_TEXT[s]
      ? `${AGENT_STATE_TEXT[s]} · ${a.activity}`
      : AGENT_STATE_TEXT[s];
  return `<button type="button" class="lk-rail__row" data-key="r-${a.id}" data-do="agent:${a.id}" data-tone="${AGENT_STATE_TONE[s]}" data-needs="${s === "needs_you"}" aria-label="${esc(a.name)}, ${AGENT_STATE_TEXT[s]}, ${PROVIDER_NAME[a.provider]} in ${WORKSPACE.name}. Open agent"><span class="lk-rail__glyph">${glyph(a.provider)}<span class="lk-pulse"></span></span><span class="lk-rail__text"><span class="lk-rail__top"><strong>${esc(a.name)}</strong><time>${elapsed(a.minutes)}</time></span><span class="lk-rail__detail">${esc(detail)}</span><small>${PROVIDER_NAME[a.provider]} · ${WORKSPACE.name}</small></span></button>`;
}

function rail(state: State): string {
  const c = counts(state);
  if (!state.railOpen) {
    const pip = (n: number, t: string, label: string) =>
      n ? `<span class="lk-rail__count" data-tone="${t}" title="${n} ${label}">${n}</span>` : "";
    return `<aside class="lk-rail lk-rail--closed" aria-label="Agents"><button type="button" class="lk-icon-btn" data-do="rail" aria-label="Show the Agents rail">${icon("railOpen")}</button>
      ${pip(c.needs, "waiting", "need you")}${pip(c.working, "working", "working")}${pip(c.waiting, "muted", "waiting")}${pip(c.failed, "failed", "failed")}</aside>`;
  }
  const group = (label: string, t: string, agents: Agent[]) =>
    agents.length
      ? `<section class="lk-rail__group" data-tone="${t}"><p class="lk-label" data-tone="${t}"><span class="lk-dot"></span>${label} <span>${agents.length}</span></p>${agents.map((a) => railRow(a)).join("")}</section>`
      : "";
  const idle = agentsIn(state, "idle");
  const idleGroup = idle.length
    ? `<section class="lk-rail__group"><button type="button" class="lk-rail__fold" data-do="rail-idle" aria-expanded="${state.idleOpen}">${icon("chevronRight")}Idle <span>${idle.length}</span></button>${state.idleOpen ? idle.map((a) => railRow(a)).join("") : ""}</section>`
    : "";
  const body = [
    group("Needs you", "waiting", agentsIn(state, "needs_you")),
    group("Failed", "failed", agentsIn(state, "failed")),
    group("Working", "working", agentsIn(state, "working")),
    group("Waiting", "muted", agentsIn(state, "waiting")),
    idleGroup,
    group("Just finished", "done", agentsIn(state, "done")),
  ].join("");
  return `<aside class="lk-rail" aria-label="Agents" data-tour="rail"><div class="lk-rail__head"><h4>Agents <span class="lk-count">${c.agents}</span></h4><button type="button" class="lk-icon-btn" data-do="rail" aria-label="Hide the Agents rail">${icon("railClose")}</button></div>${c.working === 0 && c.agents ? `<p class="lk-rail__quiet">Nothing running right now.</p>` : ""}${
    body ||
    `<p class="lk-empty">No agents running<button type="button" class="lk-btn lk-btn--primary" data-do="launcher">Launch an agent</button></p>`
  }</aside>`;
}

// ── Code ────────────────────────────────────────────────────────────────────────────────────

function lines(list: readonly Line[]): string {
  return list.map((l) => `<div class="lk-ln" data-k="${l.k}">${esc(l.t) || "&nbsp;"}</div>`).join("");
}

function tabTitle(state: State, tab: Tab): string {
  if (tab.kind === "agent" && tab.agent) {
    const agent = state.agents[tab.agent];
    return agent ? agent.name : tab.title;
  }
  return tab.title;
}

function tabTone(state: State, tab: Tab): string {
  if (tab.kind === "agent" && tab.agent) {
    const agent = state.agents[tab.agent];
    return agent ? tone(agent) : "muted";
  }
  if (tab.kind === "terminal") return tab.idle ? "muted" : "working";
  return "none";
}

function tabGlyph(state: State, tab: Tab): string {
  if (tab.kind === "agent" && tab.agent) return glyph(state.agents[tab.agent]?.provider ?? "claude");
  if (tab.widget === "operations") return icon("operations", "lk-glyph-i");
  return glyph(tab.kind === "agent" ? "claude" : tab.kind);
}

function modeBadge(mode: Mode): string {
  return `<span class="lk-pmode" data-risky="${mode === "bypass"}" title="Permission mode: ${MODE_LABEL[mode]}">${mode === "bypass" ? icon("shieldAlert") : ""}<span class="visually-hidden">Permission mode </span><span>${MODE_LABEL[mode]}</span></span>`;
}

export function agentPane(state: State, agent: Agent): string {
  const account = accountOf(state, agent.account);
  const usage = account?.windows[0];
  const approval = agent.approval
    ? `<div class="lk-approval" role="group" aria-label="${esc(agent.name)} needs approval"><p class="lk-approval__title">${icon("approvals")} ${esc(agent.approval.title)}</p><code>${esc(agent.approval.command)}</code><p class="lk-approval__why">${esc(agent.approval.reason)}</p><div class="lk-approval__actions"><button type="button" class="lk-btn lk-btn--danger" data-do="deny:${agent.id}">Deny</button><button type="button" class="lk-btn lk-btn--primary" data-do="approve:${agent.id}">Approve once</button></div></div>`
    : "";
  const prompt =
    agent.prompt && agentState(agent) === "ready"
      ? `<form class="lk-prompt" data-form="prompt:${agent.id}"><span aria-hidden="true">${esc(promptMark(agent.provider))}</span><input name="q" data-key="in-${agent.id}" autocomplete="off" placeholder="Give this agent a task…" aria-label="Prompt for ${esc(agent.name)}"/><button type="submit" class="lk-icon-btn" aria-label="Send">${icon("send")}</button></form><div class="lk-suggest">${[
          "Add a dark mode toggle",
          "Write tests for Login",
          "Fix the failing build",
        ]
          .map((s) => `<button type="button" class="lk-chip" data-do="prompt:${agent.id}:${esc(s)}">${esc(s)}</button>`)
          .join("")}</div>`
      : "";
  const effort = agent.effort && agent.effort !== "Default" ? agent.effort : "";
  const pickerOpen = state.picker?.agent === agent.id;
  return `<div class="lk-agent">
  <div class="lk-agent__head">
    <div class="lk-agent__lead">
      <strong class="lk-agent__title" title="${esc(agent.name)}">${esc(agent.name)}</strong>
      <span class="lk-ident" title="${esc(`${PROVIDER_NAME[agent.provider]} · ${account?.name ?? ""} · ${modelLabel(agent)}${effort ? ` · ${effort} effort` : ""}`)}"><span class="visually-hidden">${PROVIDER_NAME[agent.provider]}</span><button type="button" class="lk-ident__acct" data-do="picker:${agent.id}" data-picker-for="${agent.id}" aria-expanded="${pickerOpen}" aria-label="${esc(account?.name ?? "Account")}. Switch ${PROVIDER_NAME[agent.provider]} account"${hint("Switch account for a new session")}>${glyph(agent.provider)}<span>${esc(account?.name ?? "Account")}</span>${icon("chevron", "lk-caret")}</button>${agent.provider === "cursor" ? "" : `<span class="lk-ident__seg">${esc(modelLabel(agent))}</span>`}${effort ? `<span class="lk-ident__seg">${esc(effort)}</span>` : ""}</span>
      ${usage ? `<span class="lk-usage" data-low="${usage.left < 20}" title="${usage.label}: ${usage.left}% left">${meter(usage.left)}${usage.left}%</span>` : ""}
    </div>
    <div class="lk-agent__meta">${modeBadge(agent.mode)}${statusChip(agent)}</div>
  </div>
  <div class="lk-term" tabindex="0" role="log" aria-label="${esc(agent.name)} terminal" data-scroll="bottom">${lines(agent.lines)}${isWorking(agent) ? `<div class="lk-ln lk-ln--cursor" data-k="dim">${esc(workMark(agent.provider))} ${esc(agent.activity)}…</div>` : ""}</div>
  ${approval}${prompt}
</div>`;
}

function terminalPane(tab: Tab): string {
  return `<div class="lk-agent"><div class="lk-term" tabindex="0" role="log" aria-label="${esc(tab.title)}" data-scroll="bottom">${lines(tab.lines ?? [])}</div><form class="lk-prompt lk-prompt--shell" data-form="shell:${tab.id}"><span aria-hidden="true">PS&gt;</span><input name="q" data-key="in-${tab.id}" autocomplete="off" placeholder="Type a command (try git status)" aria-label="Command for ${esc(tab.title)}"/></form></div>`;
}

export function sampleApp(version: number): string {
  const stats = [
    ["Revenue", "$48.2k", "+12%"],
    ["Active users", "2,914", "+8%"],
    ["Orders", "1,276", "+3%"],
    ["Refunds", "14", "−2%"],
  ];
  const bars = [38, 52, 44, 61, 58, 72, 80];
  return `<div class="lk-site" data-v="${version}">
  <div class="lk-site__nav"><span class="lk-site__logo">Sample App</span><span>Overview</span><span>Orders</span><span>Customers</span><span class="lk-site__me"></span></div>
  <div class="lk-site__body">
    <p class="lk-site__title">Dashboard</p>
    <div class="lk-site__stats">${stats.map(([k, v, d]) => `<div class="lk-site__stat"><small>${k}</small><strong>${v}</strong><em>${d}</em></div>`).join("")}</div>
    <div class="lk-site__chart"><small>Revenue this week</small><div class="lk-site__bars">${bars.map((h, i) => `<span data-h="${Math.round(h / 10)}" data-i="${i}"></span>`).join("")}</div></div>
  </div>
</div>`;
}

function browserPane(state: State, tab: Tab): string {
  return `<div class="lk-browser">
  <div class="lk-browser__bar">
    <button type="button" class="lk-icon-btn" aria-label="Back" disabled>${icon("back")}</button>
    <button type="button" class="lk-icon-btn" aria-label="Forward" disabled>${icon("forward")}</button>
    <button type="button" class="lk-icon-btn" data-do="reload" aria-label="Reload">${icon("reload")}</button>
    <span class="lk-browser__url"><span class="lk-dot" data-tone="working"></span>${esc(tab.url ?? DEV_URL)}</span>
    <span class="lk-tag">Fit pane</span>
    <button type="button" class="lk-icon-btn" aria-label="Open externally" disabled>${icon("external")}</button>
  </div>
  <div class="lk-browser__view">${sampleApp(state.preview)}</div>
  <div class="lk-browser__foot"><span>${state.preview ? "Sample App · updated by Dashboard Redesign" : "Sample App"}</span><span>http://${esc(tab.url ?? DEV_URL)}/</span></div>
</div>`;
}

function widgetPane(state: State, tab: Tab): string {
  if (tab.widget === "operations") return contextOperations(state);
  const list = tab.widget === "approvals" ? agentsList(state).filter(needsYou) : agentsList(state).filter(isWorking);
  return `<div class="lk-widget"><p class="lk-label">${esc(tab.title)} · ${list.length}</p>${
    list.length
      ? list
          .map(
            (a) =>
              `<button type="button" class="lk-widget__row" data-key="w-${a.id}" data-do="agent:${a.id}">${glyph(a.provider)}<span><strong>${esc(a.name)}</strong></span>${statusChip(a)}</button>`,
          )
          .join("")
      : `<p class="lk-empty">Nothing here right now.</p>`
  }</div>`;
}

function frame(state: State, f: Frame, index: number): string {
  const focused = state.focus === f.id;
  const active = state.tabs[f.active];
  const tabs = f.tabs
    .map((tid) => state.tabs[tid])
    .filter((t): t is Tab => Boolean(t))
    .map(
      (t) =>
        `<div class="lk-tab" data-key="tab-${t.id}" data-selected="${t.id === f.active}"><button type="button" class="lk-tab__btn" aria-pressed="${t.id === f.active}" aria-label="${esc(tabTitle(state, t))}" data-do="tab:${t.id}">${tabGlyph(state, t)}<span>${esc(tabTitle(state, t))}</span><span class="lk-dot" data-tone="${tabTone(state, t)}"></span></button><button type="button" class="lk-tab__x" data-do="close:${t.id}" aria-label="Close ${esc(tabTitle(state, t))}">${icon("close")}</button></div>`,
    )
    .join("");
  let body = "";
  if (active?.kind === "agent" && active.agent && state.agents[active.agent])
    body = agentPane(state, state.agents[active.agent] as Agent);
  else if (active?.kind === "terminal") body = terminalPane(active);
  else if (active?.kind === "browser") body = browserPane(state, active);
  else if (active?.kind === "widget") body = widgetPane(state, active);
  const plusOpen = state.menu === `plus:${f.id}`;
  return `<section class="lk-frame" data-key="${f.id}" data-focused="${focused}" data-kind="${active?.kind ?? "empty"}" aria-label="Pane ${index + 1}: ${esc(active ? tabTitle(state, active) : "empty")}" data-do-focus="${f.id}"${active?.kind === "browser" ? ` data-tour="browser"` : ""}>
  <div class="lk-frame__tabs"><div class="lk-frame__strip" role="group" aria-label="Pane ${index + 1} tabs">${tabs}</div>
    <button type="button" class="lk-icon-btn" data-do="menu:plus:${f.id}" aria-expanded="${plusOpen}" aria-label="Add to pane ${index + 1}"${hint("Open a terminal, Browser, coding agent or widget here.")}>${icon("plus")}</button>
    <span class="lk-frame__end"><button type="button" class="lk-icon-btn" data-do="maximize:${f.id}" aria-label="${state.maximized && focused ? "Restore" : "Maximize"} pane">${icon("maximize")}</button></span>
    ${plusOpen ? plusMenu(f.id) : ""}
  </div>
  ${body}
</section>`;
}

function plusMenu(frameId: string): string {
  const item = (act: string, ic: string, label: string, sub = "") =>
    `<button type="button" role="menuitem" class="lk-menu__item" data-do="${act}">${ic}<span>${label}${sub ? `<small>${sub}</small>` : ""}</span></button>`;
  return `<div class="lk-menu lk-menu--plus" role="menu" aria-label="Open here" data-menu-for="${frameId}">
  <p class="lk-label">Open here</p>
  ${item("terminal", icon("terminal"), "New PowerShell terminal", "Default shell")}
  ${item("browser", icon("globe"), "Browser")}
  <p class="lk-label">Coding agents</p>
  ${PROVIDERS.map((p) => item(`launcher:${p}`, glyph(p), `${PROVIDER_NAME[p]} agent`, `The real ${PROVIDER_NAME[p]}, on your account`)).join("")}
  <p class="lk-label">Widgets</p>
  ${item("widget:approvals", icon("dashboard"), "Needs your approval")}
  ${item("widget:agents", icon("dashboard"), "Active agents")}
</div>`;
}

function codeSurface(state: State): string {
  const tab = focusedTab(state);
  const running = Object.values(state.tabs).filter(
    (t) =>
      (t.agent && state.agents[t.agent] && isWorking(state.agents[t.agent] as Agent)) ||
      (t.kind === "terminal" && !t.idle),
  ).length;
  const canvas = renderAdaptiveCanvas(state, frame);
  return `<div class="lk-code">
  <div class="lk-code__head">
    <span class="lk-code__ws"><strong>${WORKSPACE.name}</strong>${icon("chevron", "lk-caret")}<span class="lk-mono">${WORKSPACE.path}</span></span>
    <span class="lk-code__tools">
      <button type="button" class="lk-btn lk-btn--primary" data-do="launcher" data-tour="new-agent"${hint("Choose a provider, account, model and effort: a real coding agent in its own terminal.")}>${icon("bot")}<span>New agent</span></button>
      <button type="button" class="lk-btn" data-do="terminal" aria-label="New terminal"${hint("A real shell in your project folder.")}>${icon("terminal")}<span>Terminal</span></button>
      <span class="lk-context-control"><button type="button" class="lk-btn" data-do="menu:context" aria-expanded="${state.menu === "context"}" aria-label="Context"${hint("Open Browser, runs, services and tests beside your terminals.")}>${icon("operations")}<span>Context</span>${icon("chevron", "lk-caret")}</button>${state.menu === "context" ? contextMenu() : ""}</span>
      <span class="lk-split"><button type="button" class="lk-btn" data-do="tidy" data-tour="tidy" aria-label="KalTidy: stop idle terminals"${hint("KalTidy: stop idle terminals in one click.")}>${icon("tidy")}<span>Tidy</span></button><button type="button" class="lk-btn lk-btn--caret" data-do="menu:tidy" aria-expanded="${state.menu === "tidy"}" aria-label="More KalTidy actions">${icon("chevron")}</button>${state.menu === "tidy" ? tidyMenu() : ""}</span>
    </span>
  </div>
  ${renderCanvasTools(state)}
  ${canvas}
  <div class="lk-statusbar"><span>${tab ? `${tabGlyph(state, tab)} ${esc(tabTitle(state, tab))}` : "No pane"}</span><span>${icon("globe")} ${DEV_URL}</span><span>${icon("branch")} ${WORKSPACE.branch} · ${WORKSPACE.changed} changed</span><span><span class="lk-dot" data-tone="working"></span>${running} running</span><span class="lk-statusbar__keys">${paneCount(state)} ${paneCount(state) === 1 ? "pane" : "panes"}</span></div>
</div>`;
}

function tidyMenu(): string {
  return `<div class="lk-menu" role="menu" aria-label="KalTidy"><button type="button" role="menuitem" class="lk-menu__item" data-do="tidy">${icon("tidy")}<span>Stop idle terminals</span></button><button type="button" role="menuitem" class="lk-menu__item" data-do="tidy-finished">${icon("check")}<span>Clear finished agents</span></button></div>`;
}

function contextMenu(): string {
  const item = (action: string, glyph: string, label: string, description: string) =>
    `<button type="button" role="menuitem" class="lk-menu__item" data-do="${action}">${glyph}<span>${label}<small>${description}</small></span></button>`;
  return `<div class="lk-menu lk-menu--context" role="menu" aria-label="Beside your code">
  <p class="lk-label">Beside your code</p>
  ${item("browser", icon("globe"), "Browser", "Preview the detected dev server")}
  ${item("context-operations", icon("operations"), "Runs, services &amp; tests", "Live context for this workspace")}
</div>`;
}

// ── Dashboard: the Agent Fleet ──────────────────────────────────────────────────────────────

function fleetCard(state: State, a: Agent): string {
  const s = agentState(a);
  const t = AGENT_STATE_TONE[s];
  const asks = s === "needs_you" && !a.approval;
  const approval = a.approval
    ? `<div class="lk-approval lk-approval--card"><p class="lk-approval__title">${icon("approvals")} ${esc(a.approval.title)}</p><code>${esc(a.approval.command)}</code><div class="lk-approval__actions"><button type="button" class="lk-btn lk-btn--danger" data-do="deny:${a.id}">Deny</button><button type="button" class="lk-btn lk-btn--primary" data-do="approve:${a.id}">Approve once</button></div></div>`
    : "";
  return `<article class="lk-card" data-key="c-${a.id}" data-tone="${t}" data-needs="${s === "needs_you"}" aria-label="${esc(a.name)}">
  <p class="lk-card__top"><span class="lk-dot" data-tone="${t}"></span><strong>${esc(accountLabel(state, a.account))}</strong><span class="lk-stage" data-tone="${t}">${AGENT_STATE_TEXT[s]}</span><time>${icon("clock")}${a.minutes ? `${a.minutes} min` : "<1 min"}</time></p>
  <h5 class="lk-card__name">${esc(a.name)}</h5>
  <p class="lk-card__meta">${glyph(a.provider)}<span>${PROVIDER_NAME[a.provider]} · ${WORKSPACE.name}</span></p>
  <p class="lk-card__mono lk-mono"><span>${esc(modelLabel(a).toLowerCase())}</span>${icon("branch")}<span class="lk-card__branch">${esc(a.branch)}</span></p>
  ${approval || `<p class="lk-card__activity"${asks ? ' data-asks="true"' : ""}>${esc(a.activity)}</p>`}
  <p class="lk-card__foot"><span>${a.files} ${a.files === 1 ? "file" : "files"}</span><button type="button" class="lk-btn${asks ? " lk-btn--primary" : ""}" data-do="agent:${a.id}">${asks ? "Reply" : "Open"}${icon("forward")}</button></p>
</article>`;
}

/** Needs You on Activity: one line that says what is waiting and opens the inbox. */
function needsStrip(state: State): string {
  const items = attentionItems(state);
  const blocked = items.length;
  return `<section class="lk-needs" aria-labelledby="lk-needs-title" data-urgent="${blocked > 0}">
    <span class="lk-needs__glyph" aria-hidden="true">${icon(blocked ? "bell" : "check")}</span>
    <h4 id="lk-needs-title" class="lk-needs__title">Needs you</h4>
    <p class="lk-needs__count">${blocked ? `${blocked} blocked on you` : "Nothing needs you"}</p>
    ${blocked ? `<button type="button" class="lk-btn lk-btn--primary" data-do="${state.mobile ? "needs" : "menu:notifications"}">Review ${blocked}</button>` : ""}
  </section>`;
}

function dashboard(state: State): string {
  const c = counts(state);
  const n: Record<(typeof AGENT_FILTERS)[number], number> = {
    all: c.agents,
    needs_you: c.needs,
    working: c.working,
    waiting: c.waiting,
    done: c.done,
    idle: c.idle,
    failed: c.failed,
  };
  const groups =
    state.fleet === "all"
      ? AGENT_FILTERS.filter((f) => f !== "all").map((f) => [f, agentsIn(state, f)] as const)
      : ([[state.fleet, agentsIn(state, state.fleet)]] as const);
  const tones: Record<string, string> = {
    needs_you: "waiting",
    working: "working",
    waiting: "muted",
    done: "done",
    idle: "muted",
    failed: "failed",
    all: "muted",
  };
  const seg = (count: number, t: string) =>
    count ? `<span class="lk-seg" data-tone="${t}" data-n="${Math.min(count, 10)}"></span>` : "";
  const summary = [
    `${c.agents} agents`,
    `${c.working} working`,
    `${c.needs} ${c.needs === 1 ? "needs" : "need"} you`,
    c.waiting ? `${c.waiting} waiting` : "",
    `${c.done} done`,
    c.idle ? `${c.idle} idle` : "",
    c.failed ? `${c.failed} failed` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return `<div class="lk-page lk-scroll" data-scroll-key="dash">
  <header class="lk-page__head"><div><h3 class="lk-h1">Activity</h3><p>${summary}</p></div>
    <div class="lk-trend" aria-hidden="true"><small>Last hour</small><span class="lk-trend__bars">${[1, 1, 2, 1, 3, 2, 4, 3, 5, 6].map((h) => `<i data-h="${h}"></i>`).join("")}</span><strong>${12 + state.tick} events</strong></div></header>
  ${needsStrip(state)}
  <section class="lk-board" aria-label="Agent Fleet" data-tour="fleet">
    <div class="lk-board__top"><p class="lk-board__count"><span class="lk-eyebrow">Agent Fleet ${soon("agent-fleet")}</span><strong>${c.agents}</strong> agents</p><span class="lk-segbar" aria-hidden="true">${seg(c.needs, "waiting")}${seg(c.working, "working")}${seg(c.waiting, "muted")}${seg(c.done, "done")}${seg(c.idle, "muted")}${seg(c.failed, "failed")}</span>
      <div class="lk-filters" role="group" aria-label="Filter agents">${AGENT_FILTERS.map((f) => `<button type="button" class="lk-filter" data-do="fleet:${f}" data-tone="${tones[f]}" aria-pressed="${state.fleet === f}">${f === "all" ? "" : '<span class="lk-dot"></span>'}${AGENT_FILTER_LABEL[f]} <strong>${n[f]}</strong></button>`).join("")}</div>
      <button type="button" class="lk-btn" data-do="tidy-finished">${icon("tidy")}Clean up</button>
    </div>
    ${
      groups
        .filter(([, agents]) => agents.length)
        .map(
          ([f, agents]) =>
            `<div class="lk-group"><p class="lk-label" data-tone="${tones[f]}"><span class="lk-dot"></span>${AGENT_FILTER_LABEL[f]} <span>${agents.length}</span></p><div class="lk-cards">${agents.map((a) => fleetCard(state, a)).join("")}</div></div>`,
        )
        .join("") || `<p class="lk-empty">No agents match this filter.</p>`
    }
  </section>
</div>`;
}

// ── Operations ──────────────────────────────────────────────────────────────────────────────

const RUN_TONE: Record<Run["status"], string> = {
  Running: "working",
  Blocked: "waiting",
  Succeeded: "done",
  Queued: "muted",
  Failed: "failed",
};

function contextOperations(state: State): string {
  const all = runs(state);
  const tests = all.filter((run) => run.agent === "a2");
  const services = all.filter((run) => run.kind === "service");
  const running = all.filter((run) => run.status === "Running").length;
  const failed = all.filter((run) => run.status === "Failed").length;
  const tabs: readonly [typeof state.contextTab, string, number][] = [
    ["runs", "Runs", all.length],
    ["services", "Services", services.length],
    ["tests", "Tests", tests.length],
  ];
  const panel =
    state.contextTab === "services"
      ? contextServices()
      : contextRuns(state, state.contextTab === "tests" ? tests : all, state.contextTab === "tests");
  return `<div class="lk-context">
  <header class="lk-context__head"><div><small>Live workspace context</small><strong>${esc(WORKSPACE.name)}</strong></div><span class="lk-context__observed"><span class="lk-dot" data-tone="working"></span>Observed now</span></header>
  <div class="lk-context__signal" aria-label="Workspace execution summary"><span><strong>${running}</strong> running</span><span><strong>${services.length}</strong> services</span><span data-tone="${failed ? "failed" : "muted"}"><strong>${failed}</strong> failed</span></div>
  <div class="lk-tabs lk-context__tabs" role="tablist" aria-label="Workspace context views">${tabs
    .map(
      ([id, label, count]) =>
        `<button type="button" id="lk-context-tab-${id}" role="tab" class="lk-tabs__tab" data-do="context-tab:${id}" aria-selected="${state.contextTab === id}" aria-controls="lk-context-panel">${label}<span>${count}</span></button>`,
    )
    .join("")}</div>
  <section id="lk-context-panel" class="lk-context__panel" role="tabpanel" aria-labelledby="lk-context-tab-${state.contextTab}">${panel}</section>
  <footer class="lk-context__foot"><button type="button" class="lk-btn lk-btn--ghost" data-do="ops:${state.contextTab === "tests" ? "runs" : state.contextTab}">Open full Operations</button></footer>
</div>`;
}

function contextRuns(state: State, list: readonly Run[], tests = false): string {
  if (!list.length) return `<p class="lk-context__empty">No ${tests ? "test " : ""}runs in this workspace.</p>`;
  return `<ol class="lk-context__list" aria-label="${tests ? "Test runs" : "Workspace runs"}">${list
    .map(
      (run) =>
        `<li><button type="button" class="lk-context-run" data-do="run:${run.id}" aria-pressed="${state.run === run.id}"><span class="lk-context-run__icon">${runIcon(run)}</span><span class="lk-context-run__copy"><strong>${esc(run.name)}</strong><small>${esc(run.action)}</small></span><span class="lk-context-run__state" data-tone="${RUN_TONE[run.status]}"><span class="lk-dot"></span>${run.status}</span></button>${
          state.run === run.id
            ? `<div class="lk-context-run__evidence" role="region" aria-label="${esc(run.name)} evidence"><span>${esc(run.where)}</span><strong>${esc(run.status)} · ${esc(run.duration)}</strong></div>`
            : ""
        }</li>`,
    )
    .join("")}</ol>`;
}

function contextServices(): string {
  return `<article class="lk-context-service">
  <header><span class="lk-context-run__icon">${icon("server")}</span><span><strong>Frontend</strong><small>pnpm dev · PowerShell</small></span><span class="lk-context-run__state" data-tone="working"><span class="lk-dot"></span>Running</span></header>
  <p><span>Local URL</span><code>http://${DEV_URL}/</code></p>
  <p><span>Workspace</span><strong>${esc(WORKSPACE.name)}</strong></p>
  <button type="button" class="lk-btn lk-btn--primary" data-do="browser">${icon("globe")}Open in Browser</button>
</article>`;
}

function operations(state: State): string {
  const all = runs(state);
  const running = all.filter((r) => r.status === "Running").length;
  const queued = all.filter((r) => r.status === "Queued").length + 2;
  const tabs: [State["opsTab"], string][] = [
    ["runs", "Runs"],
    ["queue", "Queue"],
    ["services", "Services"],
    ["environments", "Environments"],
    ["activity", "Activity"],
  ];
  let panel = "";
  if (state.opsTab === "runs") panel = opsRuns(state, all);
  else if (state.opsTab === "queue") panel = opsQueue(state, all);
  else if (state.opsTab === "services") panel = opsServices();
  else if (state.opsTab === "environments") panel = opsEnvironments(state);
  else panel = opsActivity(state);
  return `<div class="lk-page lk-scroll" data-scroll-key="ops" data-tour="operations">
  <header class="lk-page__head"><div><h3 class="lk-h1">Operations <span class="lk-pill" data-tone="working">Scheduler active</span></h3><p>One execution record from queued intent to runtime evidence and deployed state.</p></div></header>
  <div class="lk-tiles">${[
    [running, "Running", "working"],
    [queued, "Queued", "muted"],
    [1, "Services", "recovering"],
    [0, "Failed", "failed"],
  ]
    .map(([n, l, t]) => `<div class="lk-tile" data-tone="${t}"><strong>${n}</strong><small>${l}</small></div>`)
    .join("")}<p class="lk-observed">Observed just now</p></div>
  <div class="lk-tabs" role="tablist" aria-label="Operations">${tabs.map(([id, label]) => `<button type="button" role="tab" class="lk-tabs__tab" data-do="ops:${id}" aria-selected="${state.opsTab === id}">${label}</button>`).join("")}</div>
  <div class="lk-ops" role="tabpanel">${panel}</div>
</div>`;
}

function runIcon(run: Run): string {
  return icon(run.kind === "build" ? "package" : run.kind === "service" ? "server" : "bot");
}

function opsRuns(state: State, all: Run[]): string {
  const selected = all.find((r) => r.id === state.run);
  const list = all
    .map(
      (r) =>
        `<button type="button" class="lk-run" data-key="${r.id}" data-do="run:${r.id}" aria-pressed="${r.id === state.run}"><span class="lk-run__icon">${runIcon(r)}</span><span class="lk-run__text"><strong>${esc(r.name)}</strong><small>${esc(r.where)}</small><span>${esc(r.action)}</span></span><span class="lk-run__state"><span class="lk-dot" data-tone="${RUN_TONE[r.status]}"></span>${r.status}<small>${r.duration}</small></span></button>`,
    )
    .join("");
  const agent = selected?.agent ? state.agents[selected.agent] : undefined;
  const inspector = selected
    ? `<div class="lk-inspect"><p class="lk-label">Run</p><h5>${esc(selected.name)}</h5><p class="lk-inspect__state"><span class="lk-dot" data-tone="${RUN_TONE[selected.status]}"></span>${selected.status} · ${selected.duration}</p>
      <ol class="lk-timeline"><li data-done="true">Queued</li><li data-done="true">Started${agent ? ` · ${esc(agent.name)} on ${esc(accountLabel(state, agent.account))}` : ""}</li><li data-done="${selected.status === "Succeeded"}">${esc(selected.action)}</li></ol>
      <dl class="lk-dl"><div><dt>Changed files</dt><dd>${agent ? agent.files : selected.kind === "build" ? "—" : "0"}</dd></div><div><dt>Tests</dt><dd>${selected.agent === "a2" && selected.status === "Succeeded" ? "14 passed" : "—"}</dd></div><div><dt>Branch</dt><dd class="lk-mono">${esc(agent?.branch ?? "main")}</dd></div></dl>
      ${agent ? `<button type="button" class="lk-btn lk-btn--primary" data-do="agent:${agent.id}">${icon("terminal")}Open its terminal</button>` : selected.kind === "service" ? `<button type="button" class="lk-btn lk-btn--primary" data-do="browser">${icon("globe")}Open in Browser</button>` : ""}</div>`
    : `<div class="lk-inspect lk-inspect--empty"><p>Select a run to inspect its timeline, changed files and tests.</p></div>`;
  return `<div class="lk-ops__split"><div class="lk-runs">${list}</div>${inspector}</div>`;
}

function opsQueue(state: State, all: Run[]): string {
  const now = all.filter((r) => r.status === "Running" || r.status === "Blocked");
  const col = (title: string, items: string[]) =>
    `<div class="lk-qcol"><p class="lk-label">${title} <span>${items.length}</span></p>${items.join("")}</div>`;
  const card = (name: string, meta: string) =>
    `<div class="lk-qcard"><strong>${esc(name)}</strong><small>${esc(meta)}</small></div>`;
  return `<div class="lk-queue">${col(
    "Now",
    now.map((r) => card(r.name, r.agent ? `${state.agents[r.agent]?.name ?? ""} · ${r.status}` : r.status)),
  )}${col("Next", [card("Update README screenshots", "Gemini CLI · Personal · Auto"), card("Dark mode tokens", "Claude Code · Personal · Sonnet")])}${col("Later", [card("Upgrade the router", "Unassigned")])}</div>`;
}

function opsServices(): string {
  return `<div class="lk-table-wrap"><table class="lk-table"><caption class="visually-hidden">Services</caption><thead><tr><th scope="col">Service</th><th scope="col">Status</th><th scope="col">Port / URL</th><th scope="col">Process</th><th scope="col">Uptime</th><th scope="col"><span class="visually-hidden">Actions</span></th></tr></thead>
  <tbody><tr data-tour="service"><th scope="row">${icon("server")} Frontend</th><td><span class="lk-dot" data-tone="working"></span>Running</td><td class="lk-mono">${DEV_URL}</td><td class="lk-mono">pnpm dev · PowerShell</td><td>42m</td><td><button type="button" class="lk-btn" data-do="browser">${icon("globe")}Open in Browser</button></td></tr></tbody></table>
  <p class="lk-note">${icon("sparkles")} KalCode found this dev server automatically when it started listening.</p></div>`;
}

function opsEnvironments(state: State): string {
  const rows: Record<string, [string, string, string, string]> = {
    Local: ["main ±3", "This computer", "Vite dev server", "now"],
    Preview: ["agent/dashboard-redesign", "preview-8f3a", "Cloudflare Pages", "12 min ago"],
    Staging: ["v1.4.0-rc.2", "staging", "Cloudflare Pages", "Yesterday"],
    Production: ["v1.3.2", "production", "Cloudflare Pages", "3 days ago"],
  };
  return `<div class="lk-envs">${ENVIRONMENTS.map((env) => {
    const [branch, deploy, platform, last] = rows[env] as [string, string, string, string];
    const active = state.environment === env;
    return `<div class="lk-env" data-active="${active}" data-env="${env}"><p class="lk-env__name"><span class="lk-env-dot" data-env="${env}"></span>${env}${active ? `<span class="lk-pill">Viewing</span>` : ""}</p><dl class="lk-dl"><div><dt>Branch / version</dt><dd class="lk-mono">${branch}</dd></div><div><dt>Deployment</dt><dd>${deploy}</dd></div><div><dt>Platform</dt><dd>${platform}</dd></div><div><dt>Last deploy</dt><dd>${last}</dd></div></dl>${active ? "" : `<button type="button" class="lk-btn" data-do="env:${env}">View ${env}</button>`}</div>`;
  }).join("")}</div>`;
}

function opsActivity(state: State): string {
  const cells = Array.from({ length: 7 * 24 }, (_, i) => {
    const v = (Math.sin(i * 12.9898 + 78.233) * 43758.5453) % 1;
    const level = Math.floor(Math.abs(v) * 5 * (i % 24 > 8 && i % 24 < 20 ? 1 : 0.35));
    return `<i data-l="${level}"></i>`;
  }).join("");
  const latest = agentsList(state)
    .slice(0, 5)
    .map((a) => `<li>${glyph(a.provider)}<strong>${esc(a.name)}</strong> ${esc(a.activity)}</li>`)
    .join("");
  return `<div class="lk-activity"><div class="lk-heat" aria-hidden="true">${cells}</div><p class="lk-label">Latest activity</p><ul role="list" class="lk-latest">${latest}</ul></div>`;
}

// ── KalVoice, Threads, Providers, Settings ──────────────────────────────────────────────────

function kalvoice(state: State): string {
  const free = getPlan("free");
  return `<div class="lk-page lk-scroll" data-scroll-key="kv">
  <header class="lk-page__head"><div><h3 class="lk-h1">KalVoice</h3><p>Dictate into any KalCode text box and run KalCode by voice or text.</p></div></header>
  <div class="lk-kvhero"><span class="lk-kvhero__orb" data-state="${state.voice.state}" aria-hidden="true"></span><div><span class="lk-kvword" aria-hidden="true"></span><p>Speak your prompts. Control your workspace. Coordinate your coding agents.</p></div></div>
  <p class="lk-h2">Type a request</p><p class="lk-sub">For when you'd rather not speak. The same commands and answers as push to talk.</p>
  <form class="lk-kvinput" data-form="voice"><input name="q" data-key="kv-in" autocomplete="off" placeholder="Type a request for KalVoice" aria-label="Type a request for KalVoice"/><button type="submit" class="lk-icon-btn" aria-label="Send">${icon("send")}</button></form>
  <div class="lk-suggest">${VOICE_PHRASES.map((p) => `<button type="button" class="lk-chip" data-do="say:${esc(p)}">${esc(p)}</button>`).join("")}</div>
  ${state.voice.reply ? `<p class="lk-kvreply" role="status">${icon("kalvoice")}<span><small>You said “${esc(state.voice.heard)}”</small>${esc(state.voice.reply)}</span></p>` : ""}
  <div class="lk-kvcards">
    <div class="lk-kvcard"><p class="lk-label">Push to talk</p><span class="lk-pill" data-tone="working">Ready</span><p>On-device speech model, on this computer.</p><small>Hold <kbd>F8</kbd> to talk to KalVoice</small></div>
    <div class="lk-kvcard"><p class="lk-label">Commands</p><span class="lk-pill" data-tone="working">Available</span><p>Say “Open Activity” or “Open four Codex terminals”: KalCode acts the moment you let go.</p><small>Dictation is never counted</small></div>
    <div class="lk-kvcard"><p class="lk-label">This month</p><p class="lk-kvcount"><strong>${formatKalVoiceAllowance(free.limits)}</strong> KalVoice Requests on ${free.name}</p><small>${PLANS.map((p) => `${p.name} ${formatKalVoiceAllowance(p.limits)}`).join(" · ")}</small></div>
  </div>
</div>`;
}

function threads(): string {
  return `<div class="lk-page lk-scroll" data-scroll-key="th">
  <header class="lk-page__head"><div><h3 class="lk-h1">Threads</h3><p>Persistent units of AI work with Claude Code, Codex or Gemini CLI, kept with your project.</p></div></header>
  <div class="lk-explain">${icon("alert")}<div><strong>Threads are conversations. Agents are terminals.</strong><p>A coding agent is the real provider CLI running in its own terminal in Code. Threads are a separate surface.</p><button type="button" class="lk-btn lk-btn--primary" data-do="go:code">${icon("code")}See the agents in Code</button></div></div>
  <ul role="list" class="lk-threads"><li>${glyph("claude")}<span><strong>Plan the onboarding flow</strong><small>Claude Code · Personal · 2 hours ago</small></span></li><li>${glyph("codex")}<span><strong>Explain the auth middleware</strong><small>Codex · Personal · Yesterday</small></span></li><li>${glyph("gemini")}<span><strong>Summarize the changelog</strong><small>Gemini CLI · Personal · Monday</small></span></li></ul>
</div>`;
}

export function accountCard(a: Account, compact = false): string {
  return `<div class="lk-acct" data-key="acct-${a.id}"><p class="lk-acct__head">${glyph(a.provider)}<strong>${esc(a.name)}</strong><small>${PROVIDER_NAME[a.provider]} · ${esc(a.plan)}</small>${a.isDefault ? `<span class="lk-pill">Default</span>` : ""}</p>${a.windows
    .slice(0, compact ? 1 : 2)
    .map(
      (w) =>
        `<div class="lk-win"><span>${w.label}</span><strong>${w.left}%</strong> left${meter(w.left)}<small>${w.resets}</small></div>`,
    )
    .join("")}</div>`;
}

function providers(state: State): string {
  return `<div class="lk-page lk-scroll" data-scroll-key="pv">
  <header class="lk-page__head"><div><h3 class="lk-h1">Providers ${soon("account-hub")}</h3><p>Claude Code, Codex, Gemini CLI and Cursor, signed in with your own accounts. Add as many as you use.</p></div></header>
  <div class="lk-tabs" role="tablist" aria-label="Providers"><button type="button" role="tab" class="lk-tabs__tab" aria-selected="false" disabled>Setup</button><button type="button" role="tab" class="lk-tabs__tab" aria-selected="true">Accounts</button><button type="button" role="tab" class="lk-tabs__tab" aria-selected="false" disabled>Health</button></div>
  ${PROVIDERS.map(
    (p) =>
      `<div class="lk-provgroup"><p class="lk-label">${glyph(p)}${PROVIDER_NAME[p]}</p><div class="lk-accts">${state.accounts
        .filter((a) => a.provider === p)
        .map((a) => accountCard(a))
        .join(
          "",
        )}<button type="button" class="lk-acct lk-acct--add" data-do="connect">${icon("plus")}<span>Connect another account<small>Sign in from KalCode</small></span></button></div></div>`,
  ).join("")}
  <p class="lk-note">${icon("shield")} Usage appears only when reported by your provider. KalCode never pays for, resells or meters your AI usage.</p>
</div>`;
}

function settings(state: State, cfg: RenderConfig): string {
  const seg = (options: readonly string[], current: string) =>
    `<span class="lk-seg-ctl">${options.map((o) => `<span${o === current ? ' aria-current="true"' : ""}>${o}</span>`).join("")}</span>`;
  return `<div class="lk-page lk-scroll" data-scroll-key="st">
  <header class="lk-page__head"><div><h3 class="lk-h1">Settings</h3><p>Appearance, permissions, KalVoice, updates and your account.</p></div></header>
  <p class="lk-label lk-settings__head">Appearance</p>
  <dl class="lk-settings">
    <div><dt>Theme</dt><dd>${seg(["System", "Light", "Dark"], "Dark")}</dd></div>
    <div><dt>Contrast</dt><dd>${seg(["System", "Standard", "High"], "System")}</dd></div>
    <div><dt>Text size</dt><dd>${seg(["Default", "Large", "Larger"], "Default")}</dd></div>
  </dl>
  <p class="lk-label lk-settings__head">Permissions</p>
  <dl class="lk-settings">
    <div><dt>New agents start in</dt><dd><span class="lk-seg-ctl">${(["bypass", "plan"] as const).map((m) => `<button type="button" data-do="mode:${m}" aria-pressed="${state.mode === m}">${MODE_LABEL[m]}</button>`).join("")}</span><small>${esc(MODE_DESCRIPTION[state.mode])}</small></dd></div>
  </dl>
  <p class="lk-label lk-settings__head">KalCode</p>
  <dl class="lk-settings">
    <div><dt>KalVoice push-to-talk key</dt><dd><kbd>F8</kbd> · or another function key, Pause, Scroll Lock or Insert</dd></div>
    <div><dt>Updates</dt><dd>KalCode downloads updates by itself and applies them the next time you close and reopen it.</dd></div>
    <div><dt>Account</dt><dd>You're exploring as a guest. <a class="lk-link" href="${esc(cfg.accountHref)}">Create an account</a></dd></div>
  </dl>
</div>`;
}

// ── Overlays ────────────────────────────────────────────────────────────────────────────────

function launcherDialog(state: State): string {
  const l = state.launcher;
  if (!l) return "";
  const groups = PROVIDERS.map(
    (p) =>
      `<p class="lk-label lk-lgroup">${glyph(p)}${PROVIDER_NAME[p]}</p>${state.accounts
        .filter((a) => a.provider === p)
        .map((a) => {
          const left = a.windows[0]?.left ?? 0;
          const on = l.account === a.id;
          return `<button type="button" role="radio" aria-checked="${on}" class="lk-lrow" data-key="lr-${a.id}" data-do="pick:${a.id}"><span class="lk-radio" aria-hidden="true"></span><span class="lk-lrow__name"><strong>${esc(a.name)}</strong><small>${esc(a.plan)}${a.isDefault ? " · Default" : ""}</small></span>${meter(left)}<span class="lk-lrow__left">${left}% left</span><span class="lk-lrow__state" data-tone="${left < 20 ? "waiting" : "working"}"><span class="lk-dot"></span>${left < 20 ? "Low" : "Ready"}</span></button>`;
        })
        .join("")}`,
  ).join("");
  const chips = (kind: "model" | "effort", values: readonly string[], value: string) =>
    values
      .map(
        (v) =>
          `<button type="button" role="radio" aria-checked="${v === value}" class="lk-chip" data-do="${kind}:${esc(v)}">${esc(v)}</button>`,
      )
      .join("");
  const n = l.count;
  const name = PROVIDER_NAME[l.provider];
  const selected = accountOf(state, l.account);
  const better = accountSuggestion(state, l.account);
  const suggestion =
    better && selected
      ? `<p class="lk-lowhint" role="status"><span>${esc(selected.name)} is running low. Use ${esc(better.name)} instead?</span><button type="button" class="lk-linkbtn" data-do="pick:${better.id}">Use ${esc(better.name)}</button></p>`
      : "";
  const efforts = EFFORTS[l.provider];
  return `<div class="lk-scrim" data-do="launcher-close"></div>
<div class="lk-dialog" role="dialog" aria-modal="true" aria-labelledby="lk-launch-title" data-tour="launcher" data-dialog>
  <header class="lk-dialog__head"><span class="lk-dialog__icon">${icon("bot")}</span><div><h4 id="lk-launch-title">New agent ${soon("provider-terminals")}</h4><p>A real coding agent in its own terminal in <strong>${WORKSPACE.name}</strong>.</p></div><kbd>Esc</kbd></header>
  <div class="lk-dialog__body">
    <div role="radiogroup" aria-label="Account" class="lk-lrows">${groups}</div>
    ${suggestion}
    <div class="lk-lset">
      <p class="lk-label">Model</p><div role="radiogroup" aria-label="Model" class="lk-chips">${chips("model", MODELS[l.provider], l.model)}</div>
      ${efforts.length ? `<p class="lk-label">Effort</p><div role="radiogroup" aria-label="Effort" class="lk-chips">${chips("effort", efforts, l.effort)}</div>` : ""}
      <p class="lk-label">Agents</p><div class="lk-stepper"><button type="button" class="lk-icon-btn" data-do="count:-1" aria-label="One fewer agent" ${n <= 1 ? "disabled" : ""}>−</button><output aria-live="polite">${n}</output><button type="button" class="lk-icon-btn" data-do="count:1" aria-label="One more agent" ${n >= MAX_AGENTS_PER_LAUNCH ? "disabled" : ""}>+</button><small>Up to ${MAX_AGENTS_PER_LAUNCH} at once. Each gets its own terminal.</small></div>
      <p class="lk-label">Other</p><div class="lk-chips"><button type="button" class="lk-chip" data-do="terminal">${icon("terminal")}Terminal</button><button type="button" class="lk-chip" data-do="browser">${icon("globe")}Live Browser</button></div>
    </div>
  </div>
  <footer class="lk-dialog__foot"><span class="lk-dialog__mode">${icon("approvals")}Starts in ${MODE_LABEL[state.mode]}</span><button type="button" class="lk-btn lk-btn--ghost" data-do="launcher-close">Cancel</button><button type="button" class="lk-btn lk-btn--primary lk-btn--launch" data-do="launch">${glyph(l.provider)}<span>Launch ${n === 1 ? `${name} agent` : `${n} ${name} agents`}</span></button></footer>
</div>`;
}

function smartClose(state: State): string {
  if (!state.closing) return "";
  return `<div class="lk-scrim" data-do="close-cancel"></div>
<div class="lk-dialog lk-dialog--alert" role="alertdialog" aria-modal="true" aria-labelledby="lk-close-title" aria-describedby="lk-close-body" data-dialog>
  <h4 id="lk-close-title">Close active work?</h4>
  <p id="lk-close-body">A terminal or agent may still be running. Keep it in the background, or stop it and close.</p>
  <div class="lk-dialog__actions"><button type="button" class="lk-btn lk-btn--ghost" data-do="close-cancel">Cancel</button><button type="button" class="lk-btn" data-do="close-keep">Keep Running</button><button type="button" class="lk-btn lk-btn--danger" data-do="close-stop">Stop and Close</button></div>
</div>`;
}

/** The terminal-header account picker (desktop PaneAccountPicker): a new session on another account. */
function accountPicker(state: State): string {
  const picker = state.picker;
  const agent = picker ? state.agents[picker.agent] : undefined;
  if (!picker || !agent) return "";
  const choice = picker.choice ? accountOf(state, picker.choice) : undefined;
  const rows = state.accounts
    .filter((a) => a.provider === agent.provider)
    .map((a) => {
      const current = a.id === agent.account;
      const w = a.windows[0];
      return `<button type="button" class="lk-prow" data-do="picker-pick:${a.id}" aria-pressed="${(picker.choice ?? agent.account) === a.id}">${glyph(a.provider)}<span class="lk-prow__id"><strong>${esc(a.name)}${current ? '<span class="lk-tagsm">Current</span>' : ""}${a.isDefault ? '<span class="lk-tagsm">Default</span>' : ""}</strong><small>${PROVIDER_NAME[a.provider]} · Ready</small></span><span class="lk-prow__quota">${w ? `${meter(w.left)}<small>${w.left}% · ${esc(w.resets)}</small>` : ""}</span></button>`;
    })
    .join("");
  const confirm =
    choice && choice.id !== agent.account
      ? `<div class="lk-picker__confirm"><p>Switching to <strong>${esc(choice.name)}</strong> starts a fresh coding session with the same workspace, working directory, model and permissions. The current session stays open.</p><div class="lk-dialog__actions"><button type="button" class="lk-btn lk-btn--ghost" data-do="picker-pick:${agent.account}">Cancel</button><button type="button" class="lk-btn lk-btn--primary" data-do="picker-start">Start with ${esc(choice.name)}</button></div></div>`
      : "";
  return `<div class="lk-pop lk-pop--picker" role="dialog" aria-labelledby="lk-picker-title" data-anchor='[data-picker-for="${agent.id}"]' data-keep="style data-placed" data-placed="false"><h4 id="lk-picker-title">Account &amp; usage</h4><p class="lk-pop__foot">Choose an account for your next coding session.</p><div class="lk-prows" role="group" aria-label="${PROVIDER_NAME[agent.provider]} accounts">${rows}</div>${confirm}</div>`;
}

function accountsPopover(state: State): string {
  const next = state.accounts.find((a) => a.provider === "claude" && a.isDefault);
  return `<div class="lk-pop lk-pop--accounts" role="dialog" aria-label="Accounts and usage"><p class="lk-pop__title"><strong>Accounts &amp; usage</strong><small>Your providers, at a glance</small></p><p class="lk-pop__new">New agents: Claude Code · ${esc(next?.name ?? "Personal")}</p><div class="lk-pop__list">${state.accounts.map((a) => accountCard(a, true)).join("")}</div><p class="lk-pop__foot">Usage appears only when reported by your provider.</p><button type="button" class="lk-btn" data-do="go:providers">${icon("providers")}Manage accounts</button></div>`;
}

function envMenu(state: State): string {
  return `<div class="lk-pop lk-pop--env" role="menu" aria-label="Environment">${ENVIRONMENTS.map((e) => `<button type="button" role="menuitemradio" aria-checked="${state.environment === e}" class="lk-menu__item" data-do="env:${e}"><span class="lk-env-dot" data-env="${e}"></span><span>${e}</span></button>`).join("")}<button type="button" class="lk-menu__item" data-do="ops:environments">${icon("operations")}<span>Open Environments</span></button></div>`;
}

function modeMenu(state: State): string {
  return `<div class="lk-pop lk-pop--mode" role="menu" aria-label="New agents start in"><p class="lk-label">New agents start in</p>${(
    ["bypass", "plan"] as const
  )
    .map(
      (m) =>
        `<button type="button" role="menuitemradio" aria-checked="${state.mode === m}" class="lk-menu__item" data-do="mode:${m}">${icon(m === "bypass" ? "shieldAlert" : "shield")}<span>${MODE_LABEL[m]}<small>${esc(MODE_DESCRIPTION[m])}</small></span></button>`,
    )
    .join(
      "",
    )}<div role="separator" class="lk-sep"></div><button type="button" role="menuitem" class="lk-menu__item" data-do="go:settings">${icon("settings")}<span>Permission settings…</span></button></div>`;
}

export interface Command {
  label: string;
  act: string;
  icon: LiveIcon;
  group: string;
  meta?: string;
}

/** The universal quick switcher: workspaces, agents, terminals, accounts, pages and commands. */
export function paletteCommands(state: State): Command[] {
  const q = state.palette.q.trim().toLowerCase();
  const entities: Command[] = [
    {
      label: WORKSPACE.name,
      act: "go:code",
      icon: "folder" as LiveIcon,
      group: "",
      meta: `Workspace · ${WORKSPACE.path}`,
    },
    ...agentsList(state).map((a) => ({
      label: a.name,
      act: `agent:${a.id}`,
      icon: "bot" as LiveIcon,
      group: "",
      meta: `Agent · ${PROVIDER_NAME[a.provider]} · ${AGENT_STATE_TEXT[agentState(a)]}`,
    })),
    ...Object.values(state.tabs)
      .filter((t) => t.kind === "terminal")
      .map((t) => ({ label: t.title, act: `tab:${t.id}`, icon: "terminal" as LiveIcon, group: "", meta: "Terminal" })),
    ...state.accounts.map((a) => ({
      label: `${a.name}`,
      act: "menu:accounts",
      icon: "accountCog" as LiveIcon,
      group: "",
      meta: `Account · ${PROVIDER_NAME[a.provider]} · ${a.plan}`,
    })),
  ].map((c) => ({ ...c, group: q ? "Best matches" : "Recent and suggested" }));
  const commands: Command[] = [
    { label: "New agent…", act: "launcher", icon: "bot", group: "Agents" },
    ...SURFACES.map((s) => ({
      label: `Go to ${s.label}`,
      act: `go:${s.id}`,
      icon: s.icon as LiveIcon,
      group: "Go to",
    })),
    { label: "Go to Settings", act: "go:settings", icon: "settings", group: "Go to" },
    { label: "Open Live Browser", act: "browser", icon: "globe", group: "Code" },
    { label: "New terminal", act: "terminal", icon: "terminal", group: "Code" },
    { label: "Show what needs me", act: "needs", icon: "alert", group: "Code" },
    { label: "KalTidy: stop idle terminals", act: "tidy", icon: "tidy", group: "Code" },
  ];
  if (!q) return [...entities.slice(0, 6), ...commands];
  const match = (c: Command) => `${c.label} ${c.meta ?? ""}`.toLowerCase().includes(q);
  // Commands named by the query lead, so "operations" + Enter goes to Operations.
  const named = commands.filter((c) => c.label.toLowerCase().includes(q));
  return [
    ...named.map((c) => ({ ...c, group: "Best matches" })),
    ...entities.filter(match),
    ...commands.filter((c) => !named.includes(c) && match(c)),
  ];
}

function palette(state: State): string {
  const list = paletteCommands(state);
  const sel = Math.min(state.palette.sel, Math.max(0, list.length - 1));
  let html = "";
  let open = "";
  list.forEach((c, i) => {
    if (c.group !== open) {
      if (open) html += "</div>";
      open = c.group;
      html += `<div role="group" class="lk-palette__group" aria-label="${esc(c.group)}"><p class="lk-palette__head" aria-hidden="true">${esc(c.group)}</p>`;
    }
    html += `<div id="lk-pal-${i}" role="option" aria-selected="${i === sel}" class="lk-palette__opt" data-key="p-${esc(c.act)}-${i}" data-do="${esc(c.act)}">${icon(c.icon)}<span>${esc(c.label)}</span>${c.meta ? `<small>${esc(c.meta)}</small>` : ""}</div>`;
  });
  if (open) html += "</div>";
  return `<div class="lk-scrim lk-scrim--light" data-do="menu-close"></div><div class="lk-palette" role="dialog" aria-modal="true" aria-label="Command palette" data-dialog><div class="lk-palette__input">${icon("search")}<input data-key="pal-in" data-palette autocomplete="off" role="combobox" aria-expanded="true" aria-controls="lk-pal-list" aria-activedescendant="lk-pal-${sel}" placeholder="Search anything: workspaces, agents, settings..." aria-label="Search or run a command" value="${esc(state.palette.q)}"/><kbd>Esc</kbd></div><div id="lk-pal-list" role="listbox" aria-label="Results" class="lk-palette__list">${
    html || `<p class="lk-empty">No matches. Try a name or a setting.</p>`
  }</div></div>`;
}

function voicePanel(state: State): string {
  const v = state.voice;
  return `<div class="lk-pop lk-pop--voice" role="dialog" aria-label="KalVoice"><div class="lk-voice"><span class="lk-orb lk-orb--lg" data-state="${v.state}" aria-hidden="true"></span><div><p class="lk-voice__state">${voiceWord(state)}</p><p class="lk-voice__text" aria-live="polite">${v.state === "listening" ? `<span class="lk-wave" aria-hidden="true">${"<i></i>".repeat(16)}</span>` : ""}${esc(v.reply || v.heard || "Hold F8 in KalCode and speak. Here, pick a phrase:")}</p></div></div><div class="lk-suggest">${VOICE_PHRASES.map((p) => `<button type="button" class="lk-chip" data-do="say:${esc(p)}">“${esc(p)}”</button>`).join("")}</div><p class="lk-pop__foot">On-device dictation is unlimited on every plan.</p></div>`;
}

function toastView(state: State): string {
  const t = state.toast;
  if (!t) return "";
  return `<div class="lk-toast" role="status" data-key="toast-${t.id}" data-tone="${t.tone}">${icon(t.tone === "done" ? "check" : t.tone === "waiting" ? "alert" : "sparkles")}<span>${esc(t.text)}</span><button type="button" class="lk-icon-btn lk-toast__x" data-do="toast-close" aria-label="Dismiss">${icon("close")}</button>${t.agent && state.agents[t.agent] ? `<button type="button" class="lk-toast__open" data-do="agent:${t.agent}">Open agent${icon("forward")}</button>` : ""}</div>`;
}

function nudgeView(state: State, cfg: RenderConfig): string {
  const n = state.nudge;
  if (!n) return "";
  const href = n.cta === "account" ? cfg.accountHref : cfg.downloadHref;
  const label = n.cta === "account" ? "Create account" : n.cta === "get" ? "Get KalCode" : cfg.downloadLabel;
  return `<aside class="lk-nudge" aria-label="Try KalCode for real" data-key="nudge-${n.id}"><p><strong>${esc(n.title)}</strong>${esc(n.body)}</p><div><a class="lk-btn lk-btn--primary" href="${esc(href)}" data-cta="${n.id}">${esc(label)}</a><button type="button" class="lk-btn lk-btn--ghost" data-do="nudge-close">Keep exploring</button></div></aside>`;
}

/** One floating message at a time: an offer outranks a status toast (which stays in Notifications). */
function floatView(state: State, cfg: RenderConfig): string {
  const body = state.nudge ? nudgeView(state, cfg) : toastView(state);
  return `<div class="lk-float" data-has="${Boolean(body)}">${body}</div>`;
}

function tourCard(state: State, cfg: RenderConfig): string {
  if (state.tour === null) return "";
  const step = TOUR[state.tour];
  if (!step) return "";
  const last = state.tour === TOUR.length - 1;
  const dots = TOUR.map((_, i) => `<i data-on="${i === state.tour}"></i>`).join("");
  const actions = last
    ? `<a class="lk-btn lk-btn--primary" href="${esc(cfg.downloadHref)}" data-cta="tour-download">${esc(cfg.downloadLabel)}</a><a class="lk-btn" href="${esc(cfg.accountHref)}" data-cta="tour-account">Create account</a><button type="button" class="lk-btn lk-btn--ghost" data-do="tour-end">Keep exploring</button>`
    : `${state.tour > 0 ? `<button type="button" class="lk-btn lk-btn--ghost" data-do="tour-prev">Back</button>` : `<button type="button" class="lk-btn lk-btn--ghost" data-do="tour-end">Skip</button>`}<button type="button" class="lk-btn lk-btn--primary" data-do="tour-next">${state.tour === 0 ? "Start" : "Next"}${icon("forward")}</button>`;
  return `<div class="lk-spot" data-spot data-keep="style data-on" aria-hidden="true"></div><div class="lk-tour" tabindex="-1" data-key="tour-${state.tour}" data-keep="style data-place" role="dialog" aria-labelledby="lk-tour-title" aria-describedby="lk-tour-body" data-tour-card data-step="${state.tour}"><p class="lk-tour__count">${step.kicker} <span>${state.tour + 1} / ${TOUR.length}</span></p><h4 id="lk-tour-title">${esc(step.title)}</h4><p id="lk-tour-body">${esc(step.body)}</p>${step.tip ? `<p class="lk-tour__tip">${icon("sparkles")}${esc(step.tip)}</p>` : ""}<div class="lk-tour__actions">${actions}</div><div class="lk-tour__dots" aria-hidden="true">${dots}</div></div>`;
}

// ── The app ─────────────────────────────────────────────────────────────────────────────────

function surface(state: State, cfg: RenderConfig): string {
  switch (state.surface) {
    case "dashboard":
      return dashboard(state);
    case "operations":
      return operations(state);
    case "kalvoice":
      return kalvoice(state);
    case "threads":
      return threads();
    case "providers":
      return providers(state);
    case "memory":
      return renderMemory(state.memory, esc, isAvailable("unified-memory"));
    case "settings":
      return settings(state, cfg);
    default:
      return codeSurface(state);
  }
}

export function renderApp(state: State, cfg: RenderConfig): string {
  const menu = state.menu;
  return `<div class="lk-app" data-surface="${state.surface}" data-mobile="${state.mobile}" data-rail="${state.railOpen}" data-touring="${state.tour !== null}">
${topBar(state)}
${navBar(state)}
${favoritesBar(state)}
<div class="lk-body">${state.mobile ? "" : sidebar(state)}<main class="lk-main" aria-label="${esc(SURFACES.find((s) => s.id === state.surface)?.label ?? "Settings")}">${surface(state, cfg)}</main>${state.mobile ? "" : rail(state)}</div>
${state.mobile ? `${floatView(state, cfg)}${tabBar(state)}` : ""}
${menu === "accounts" ? accountsPopover(state) : ""}${menu === "environment" ? envMenu(state) : ""}${menu === "mode" ? modeMenu(state) : ""}${state.voice.open ? voicePanel(state) : ""}${accountPicker(state)}
${menu === "palette" ? palette(state) : ""}${launcherDialog(state)}${smartClose(state)}
${state.mobile ? "" : floatView(state, cfg)}
${tourCard(state, cfg)}
</div>`;
}

export function iconSprite(paths: Record<string, string>): string {
  return `<svg class="lk-sprite" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"><defs>${Object.entries(
    paths,
  )
    .map(
      ([name, body]) =>
        `<symbol id="lk-${name}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</symbol>`,
    )
    .join("")}</defs></svg>`;
}
