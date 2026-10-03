/**
 * The live KalCode demo, drawn. Pure state -> HTML-string functions: Astro renders the first paint
 * at build time, the client re-renders after every action and morphs the DOM (scripts/live/app.ts).
 *
 * Layout and words follow the shipped desktop app: the Command Deck top bar, the stable sidebar
 * (Dashboard, Operations, KalVoice, Code, Threads, Providers), tabbed Code panes, the New agent
 * launcher, the Agents rail. Every interactive element carries `data-do="<action>[:arg]"`.
 * No inline styles (the site's CSP forbids them): dynamic sizes are classes or data attributes.
 */
import { formatKalVoiceAllowance, getPlan, PLANS } from "@kalcode/protocol/plans";
import type { LiveIcon } from "./icons";
import {
  type Account,
  type Agent,
  accountLabel,
  accountOf,
  agentsList,
  counts,
  DEV_URL,
  EFFORTS,
  ENVIRONMENTS,
  type Frame,
  fleetStage,
  isAvailable,
  isWorking,
  type Line,
  MAX_AGENTS_PER_LAUNCH,
  MODELS,
  needsYou,
  PROVIDER_NAME,
  type ProviderId,
  paneCount,
  type Run,
  runs,
  type State,
  SURFACES,
  statusLabel,
  statusTone,
  type Tab,
  VOICE_PHRASES,
  WORKSPACE,
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

export function glyph(provider: ProviderId | "terminal" | "browser" | "widget"): string {
  if (provider === "terminal") return icon("terminal", "lk-glyph-i");
  if (provider === "browser") return icon("globe", "lk-glyph-i");
  if (provider === "widget") return icon("dashboard", "lk-glyph-i");
  return `<span class="lk-glyph lk-glyph--${provider}" aria-hidden="true"></span>`;
}

export function statusChip(agent: Pick<Agent, "status">): string {
  return `<span class="lk-status" data-tone="${statusTone(agent.status)}"><span class="lk-status__dot" aria-hidden="true"></span>${statusLabel(agent.status)}</span>`;
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

// ── Top bar ─────────────────────────────────────────────────────────────────────────────────

function topBar(state: State): string {
  const c = counts(state);
  const ready = state.accounts.length;
  return `<header class="lk-top">
  <div class="lk-brand"><span class="lk-brand__mark" aria-hidden="true"></span><span class="lk-wordmark" aria-hidden="true"></span><span class="visually-hidden">KalCode</span><span class="lk-demo"${hint("This is a temporary demo workspace. Reset or reload to start over.")}>Demo</span></div>
  <div class="lk-ctx">
    <button type="button" class="lk-ctx__chip" data-do="go:code"${hint("The project folder your agents work in.")}>${icon("folder")}<span><small>Workspace</small>${WORKSPACE.name}</span></button>
    <span class="lk-ctx__chip lk-ctx__chip--static">${icon("branch")}<span><small>Branch</small><span class="lk-mono">${WORKSPACE.branch} ±${WORKSPACE.changed} ↑${WORKSPACE.ahead}</span></span></span>
    <button type="button" class="lk-ctx__chip" data-do="menu:environment" aria-expanded="${state.menu === "environment"}"${hint("Local, Preview, Staging or Production: where you're looking.")}>${icon("globe")}<span><small>Environment</small><span class="lk-env-dot" data-env="${state.environment}"></span>${state.environment}</span></button>
    <button type="button" class="lk-ctx__chip" data-do="menu:mode" aria-expanded="${state.menu === "mode"}"${hint("The permission mode new agents start in.")}>${icon("shield")}<span><small>Mode</small>Approve</span>${icon("chevron", "lk-caret")}</button>
  </div>
  <button type="button" class="lk-search" data-do="menu:palette" data-tour="palette" aria-label="Search or run a command"${hint("Every KalCode action, one search away.")}>${icon("search")}<span>Search or run a command</span><kbd>Ctrl K</kbd></button>
  <div class="lk-signals">
    <button type="button" class="lk-signal" data-tone="working" data-do="go:dashboard"${hint("Coding agents working right now.")}><span class="lk-signal__dot"></span><strong>${c.working}</strong> working</button>
    <button type="button" class="lk-signal" data-tone="waiting" data-do="needs" data-tour="needs" data-active="${c.needs > 0}"${hint("Agents waiting on you. Click to jump to the first one.")}><span class="lk-signal__dot"></span><strong>${c.needs}</strong> ${c.needs === 1 ? "needs" : "need"} you</button>
  </div>
  <button type="button" class="lk-accounts" data-do="menu:accounts" data-tour="accounts" aria-label="Accounts and usage: ${ready} ready" aria-expanded="${state.menu === "accounts"}"${hint("Connect multiple Claude Code and Codex accounts and see their usage.")}>${icon("users")}<strong>Accounts</strong><small>${ready} ready</small>${icon("chevron", "lk-caret")}</button>
  <button type="button" class="lk-voice-pill" data-do="voice:toggle" data-tour="voice" aria-label="KalVoice: ${voiceWord(state)}" aria-expanded="${state.voice.open}"${hint("KalVoice: hold F8 and speak. Here, pick a phrase.")}><span class="lk-orb" data-state="${state.voice.state}" aria-hidden="true"></span><span class="lk-voice-pill__word">KalVoice</span><span class="lk-voice-pill__state">${voiceWord(state)}</span></button>
</header>`;
}

function voiceWord(state: State): string {
  return { ready: "Ready", listening: "Listening…", processing: "Processing", executing: "Executing", done: "Done" }[
    state.voice.state
  ];
}

// ── Sidebar and mobile tab bar ──────────────────────────────────────────────────────────────

function sidebar(state: State): string {
  const c = counts(state);
  const approvals = agentsList(state).filter((a) => a.approval).length;
  const items = SURFACES.map((s) => {
    const badge = s.id === "dashboard" && c.needs > 0 ? `<span class="lk-badge">${c.needs}</span>` : "";
    return `<li><button type="button" class="lk-nav" data-do="go:${s.id}" data-tour="nav-${s.id}" aria-current="${state.surface === s.id ? "page" : "false"}"${hint(s.hint)}>${icon(s.icon as LiveIcon)}<span class="lk-nav__label">${s.label}</span>${badge}</button></li>`;
  }).join("");
  return `<nav class="lk-side" aria-label="KalCode">
  <ul role="list">${items}</ul>
  <ul role="list" class="lk-side__foot">
    <li><button type="button" class="lk-nav" data-do="needs"${hint("Approvals your agents are waiting for.")}>${icon("approvals")}<span class="lk-nav__label">Approvals</span>${approvals ? `<span class="lk-badge">${approvals}</span>` : ""}</button></li>
    <li><button type="button" class="lk-nav" data-do="go:settings" aria-current="${state.surface === "settings" ? "page" : "false"}">${icon("settings")}<span class="lk-nav__label">Settings</span></button></li>
    <li class="lk-me"><span class="lk-me__avatar" aria-hidden="true">G</span><span class="lk-nav__label"><strong>Guest</strong><small>Demo workspace</small></span></li>
  </ul>
</nav>`;
}

function tabBar(state: State): string {
  const c = counts(state);
  return `<nav class="lk-tabbar" aria-label="KalCode">${SURFACES.map(
    (s) =>
      `<button type="button" class="lk-tabbar__item" data-do="go:${s.id}" data-tour="nav-${s.id}" aria-current="${state.surface === s.id ? "page" : "false"}">${icon(s.icon as LiveIcon)}<span>${s.id === "operations" ? "Ops" : s.label}</span>${s.id === "dashboard" && c.needs ? `<span class="lk-badge">${c.needs}</span>` : ""}</button>`,
  ).join("")}</nav>`;
}

// ── Agents rail ─────────────────────────────────────────────────────────────────────────────

function rail(state: State): string {
  const list = agentsList(state);
  if (!state.railOpen) {
    const c = counts(state);
    return `<aside class="lk-rail lk-rail--closed" aria-label="Agents"><button type="button" class="lk-icon-btn" data-do="rail" aria-label="Show the Agents rail">${icon("railOpen")}</button>
      <span class="lk-rail__count" data-tone="waiting">${c.needs}</span><span class="lk-rail__count" data-tone="working">${c.working}</span><span class="lk-rail__count" data-tone="done">${c.done}</span></aside>`;
  }
  const groups: [string, string, Agent[]][] = [
    ["Needs you", "waiting", list.filter(needsYou)],
    ["Working", "working", list.filter(isWorking)],
    ["Just finished", "done", list.filter((a) => a.status === "done")],
    ["Idle", "muted", list.filter((a) => a.status === "idle")],
  ];
  const body = groups
    .filter(([, , agents]) => agents.length)
    .map(
      ([label, tone, agents]) =>
        `<div class="lk-rail__group"><p class="lk-label" data-tone="${tone}"><span class="lk-dot"></span>${label} <span>${agents.length}</span></p>${agents
          .map(
            (a) =>
              `<button type="button" class="lk-rail__row" data-key="r-${a.id}" data-do="agent:${a.id}" data-tone="${statusTone(a.status)}" data-needs="${needsYou(a)}"><span class="lk-rail__glyph">${glyph(a.provider)}<span class="lk-pulse"></span></span><span class="lk-rail__text"><strong>${esc(a.task)}</strong><span>${esc(needsYou(a) ? fleetStage(a.status) : a.activity)}</span><small>${a.sign} · ${WORKSPACE.name}</small></span><time>${a.minutes ? `${a.minutes}m` : "now"}</time></button>`,
          )
          .join("")}</div>`,
    )
    .join("");
  return `<aside class="lk-rail" aria-label="Agents" data-tour="rail"><div class="lk-rail__head"><h4>Agents <span class="lk-count">${list.length}</span></h4><button type="button" class="lk-icon-btn" data-do="rail" aria-label="Hide the Agents rail">${icon("railClose")}</button></div>${
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
    return agent ? `${agent.sign} · ${accountLabel(state, agent.account)}` : tab.title;
  }
  return tab.title;
}

function tabTone(state: State, tab: Tab): string {
  if (tab.kind === "agent" && tab.agent) {
    const agent = state.agents[tab.agent];
    return agent ? statusTone(agent.status) : "muted";
  }
  if (tab.kind === "terminal") return tab.idle ? "muted" : "working";
  return "none";
}

function tabGlyph(state: State, tab: Tab): string {
  if (tab.kind === "agent" && tab.agent) return glyph(state.agents[tab.agent]?.provider ?? "claude");
  return glyph(tab.kind === "agent" ? "claude" : tab.kind);
}

export function agentPane(state: State, agent: Agent): string {
  const account = accountOf(state, agent.account);
  const usage = account?.windows[0];
  const approval = agent.approval
    ? `<div class="lk-approval" role="group" aria-label="${esc(agent.sign)} needs approval"><p class="lk-approval__title">${icon("shield")} ${esc(agent.approval.title)}</p><code>${esc(agent.approval.command)}</code><p class="lk-approval__why">${esc(agent.approval.reason)}</p><div class="lk-approval__actions"><button type="button" class="lk-btn lk-btn--danger" data-do="deny:${agent.id}">Deny</button><button type="button" class="lk-btn lk-btn--primary" data-do="approve:${agent.id}">Approve once</button></div></div>`
    : "";
  const prompt =
    agent.prompt && agent.status === "idle"
      ? `<form class="lk-prompt" data-form="prompt:${agent.id}"><span aria-hidden="true">${agent.provider === "claude" ? ">" : "›"}</span><input name="q" data-key="in-${agent.id}" autocomplete="off" placeholder="Ask ${esc(agent.sign)} to build something…" aria-label="Prompt for ${esc(agent.sign)}"/><button type="submit" class="lk-icon-btn" aria-label="Send">${icon("send")}</button></form><div class="lk-suggest">${[
          "Add a dark mode toggle",
          "Write tests for Login",
          "Fix the failing build",
        ]
          .map((s) => `<button type="button" class="lk-chip" data-do="prompt:${agent.id}:${esc(s)}">${esc(s)}</button>`)
          .join("")}</div>`
      : "";
  return `<div class="lk-agent">
  <div class="lk-agent__head">
    <strong class="lk-agent__title">${esc(agent.sign)}</strong>
    ${statusChip(agent)}
    <span class="lk-tag"${hint("The provider account this agent runs on.")}>${glyph(agent.provider)}${esc(account?.name ?? "")}</span>
    <span class="lk-tag lk-mono"${hint("The exact model and effort, fixed when you launched it.")}>${esc(agent.model === "Default" ? "Default model" : agent.model)} · ${esc(agent.effort)}</span>
    ${usage ? `<span class="lk-tag lk-usage" data-low="${usage.left < 20}">${meter(usage.left)}${usage.left}% left</span>` : ""}
    <span class="lk-agent__spacer"></span>
    <span class="lk-agent__mode">Approve</span>
  </div>
  <div class="lk-term" tabindex="0" role="log" aria-label="${esc(agent.sign)} terminal" data-scroll="bottom">${lines(agent.lines)}${isWorking(agent) ? `<div class="lk-ln lk-ln--cursor" data-k="dim">${agent.provider === "claude" ? "✻" : "•"} ${esc(agent.activity)}…</div>` : ""}</div>
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
  <div class="lk-browser__foot"><span>${state.preview ? "Sample App · updated by Claude A" : "Sample App"}</span><span>http://${esc(tab.url ?? DEV_URL)}/</span></div>
</div>`;
}

function widgetPane(state: State, tab: Tab): string {
  const list = tab.widget === "approvals" ? agentsList(state).filter(needsYou) : agentsList(state).filter(isWorking);
  return `<div class="lk-widget"><p class="lk-label">${esc(tab.title)} · ${list.length}</p>${
    list.length
      ? list
          .map(
            (a) =>
              `<button type="button" class="lk-widget__row" data-key="w-${a.id}" data-do="agent:${a.id}">${glyph(a.provider)}<span><strong>${esc(a.sign)}</strong> ${esc(a.task)}</span>${statusChip(a)}</button>`,
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
  ${item("launcher:claude", glyph("claude"), "Claude Code agent", "A coding agent: the real Claude Code, checked by KalCode")}
  ${item("launcher:codex", glyph("codex"), "Codex agent", "A coding agent: the real Codex; approvals in its own prompt")}
  <p class="lk-label">Widgets</p>
  ${item("widget:approvals", icon("dashboard"), "Needs your approval")}
  ${item("widget:agents", icon("dashboard"), "Active agents")}
</div>`;
}

function codeSurface(state: State): string {
  const frames = state.maximized ? state.frames.filter((f) => f.id === state.focus) : state.frames;
  const n = frames.length;
  const cols = state.layout === "auto" ? n : Number(state.layout);
  const focusedFrame = state.frames.find((f) => f.id === state.focus);
  const focusedTab = focusedFrame ? state.tabs[focusedFrame.active] : undefined;
  const running = Object.values(state.tabs).filter(
    (t) => (t.agent && isWorking(state.agents[t.agent] as Agent)) || (t.kind === "terminal" && !t.idle),
  ).length;
  const canvas = state.mobile
    ? mobileCode(state)
    : `<div class="lk-canvas" data-n="${n}" data-cols="${Math.min(cols, n)}">${frames.map((f, i) => frame(state, f, i)).join("")}${n === 0 ? emptyCode() : ""}</div>`;
  return `<div class="lk-code">
  <div class="lk-code__head">
    <span class="lk-code__ws"><strong>${WORKSPACE.name}</strong>${icon("chevron", "lk-caret")}<span class="lk-mono">${WORKSPACE.path}</span></span>
    <span class="lk-code__tools">
      <button type="button" class="lk-btn" data-do="terminal" aria-label="New terminal"${hint("A real shell in your project folder.")}>${icon("terminal")}<span>Terminal</span></button>
      <span class="lk-split"><button type="button" class="lk-btn" data-do="tidy" data-tour="tidy" aria-label="KalTidy: stop idle terminals"${hint("KalTidy: stop idle terminals in one click.")}>${icon("tidy")}<span>KalTidy</span></button><button type="button" class="lk-btn lk-btn--caret" data-do="menu:tidy" aria-expanded="${state.menu === "tidy"}" aria-label="More KalTidy actions">${icon("chevron")}</button>${state.menu === "tidy" ? tidyMenu() : ""}</span>
      <span class="lk-split"><button type="button" class="lk-btn" data-do="menu:layout" aria-label="Layout" aria-expanded="${state.menu === "layout"}">${icon("layout")}<span>Layout</span>${icon("chevron", "lk-caret")}</button>${state.menu === "layout" ? layoutMenu() : ""}</span>
      <button type="button" class="lk-btn lk-btn--primary" data-do="launcher" data-tour="new-agent"${hint("Choose a provider, account, model and effort: a real coding agent in its own terminal.")}>${icon("bot")}<span>New agent</span></button>
    </span>
  </div>
  ${canvas}
  <div class="lk-statusbar"><span>${focusedTab ? `${tabGlyph(state, focusedTab)} ${esc(tabTitle(state, focusedTab))}` : "No pane"}</span><span>${paneCount(state)} ${paneCount(state) === 1 ? "pane" : "panes"}</span><span><span class="lk-dot" data-tone="working"></span>${running} running</span><span class="lk-statusbar__keys"><kbd>Ctrl Alt ←↑→↓</kbd> move <kbd>Ctrl Alt D</kbd> split</span></div>
</div>`;
}

function emptyCode(): string {
  return `<div class="lk-empty lk-empty--big"><p>Every pane is closed.</p><button type="button" class="lk-btn lk-btn--primary" data-do="launcher">${icon("bot")}New agent</button><button type="button" class="lk-btn" data-do="reset">Reset the demo</button></div>`;
}

/** Phones: one pane at a time, a strip of every pane above it, swipe to move between them. */
function mobileCode(state: State): string {
  const all = state.frames.flatMap((f) => f.tabs);
  const focusedFrame = state.frames.find((f) => f.id === state.focus);
  const current = focusedFrame?.active ?? all[0];
  const tab = current ? state.tabs[current] : undefined;
  const strip = all
    .map((tid) => state.tabs[tid])
    .filter((t): t is Tab => Boolean(t))
    .map(
      (t) =>
        `<button type="button" class="lk-mtab" data-key="m-${t.id}" data-do="tab:${t.id}" aria-pressed="${t.id === current}">${tabGlyph(state, t)}<span>${esc(t.kind === "agent" ? (state.agents[t.agent ?? ""]?.sign ?? t.title) : t.title)}</span><span class="lk-dot" data-tone="${tabTone(state, t)}"></span></button>`,
    )
    .join("");
  let body = emptyCode();
  if (tab?.kind === "agent" && tab.agent && state.agents[tab.agent])
    body = agentPane(state, state.agents[tab.agent] as Agent);
  else if (tab?.kind === "terminal") body = terminalPane(tab);
  else if (tab?.kind === "browser") body = browserPane(state, tab);
  else if (tab?.kind === "widget") body = widgetPane(state, tab);
  return `<div class="lk-mcode"><div class="lk-mstrip" role="group" aria-label="Panes">${strip}<button type="button" class="lk-mtab lk-mtab--add" data-do="launcher" aria-label="New agent">${icon("plus")}</button></div><section class="lk-frame lk-frame--mobile" data-swipe data-kind="${tab?.kind ?? "empty"}" data-focused="true" aria-label="${esc(tab ? tabTitle(state, tab) : "No pane")}"${tab?.kind === "browser" ? ` data-tour="browser"` : ""}>${body}</section><p class="lk-mhint">Swipe to switch panes</p></div>`;
}

function tidyMenu(): string {
  return `<div class="lk-menu" role="menu" aria-label="KalTidy"><button type="button" role="menuitem" class="lk-menu__item" data-do="tidy">${icon("tidy")}<span>Stop idle terminals</span></button><button type="button" role="menuitem" class="lk-menu__item" data-do="tidy-finished">${icon("check")}<span>Clear finished agents</span></button></div>`;
}

function layoutMenu(): string {
  return `<div class="lk-menu" role="menu" aria-label="Layout">${[
    ["2", "2 panes"],
    ["3", "3 panes"],
    ["4", "4 panes (2 × 2)"],
    ["auto", "Even out sizes"],
  ]
    .map(
      ([v, l]) =>
        `<button type="button" role="menuitem" class="lk-menu__item" data-do="layout:${v}">${icon("layout")}<span>${l}</span></button>`,
    )
    .join("")}</div>`;
}

// ── Dashboard: the Agent Fleet ──────────────────────────────────────────────────────────────

function fleetCard(state: State, a: Agent): string {
  const approval = a.approval
    ? `<div class="lk-approval lk-approval--card"><p class="lk-approval__title">${icon("shield")} ${esc(a.approval.title)}</p><code>${esc(a.approval.command)}</code><div class="lk-approval__actions"><button type="button" class="lk-btn lk-btn--danger" data-do="deny:${a.id}">Deny</button><button type="button" class="lk-btn lk-btn--primary" data-do="approve:${a.id}">Approve once</button></div></div>`
    : "";
  return `<article class="lk-card" data-key="c-${a.id}" data-tone="${statusTone(a.status)}" data-needs="${needsYou(a)}" aria-label="${esc(a.sign)}: ${esc(a.task)}">
  <p class="lk-card__top"><span class="lk-dot" data-tone="${statusTone(a.status)}"></span><strong>${esc(a.sign)}</strong><span class="lk-stage" data-tone="${statusTone(a.status)}">${fleetStage(a.status)}</span><time>${icon("clock")}${a.minutes ? `${a.minutes} min` : "<1 min"}</time></p>
  <h5 class="lk-card__name">${esc(a.task)}</h5>
  <p class="lk-card__meta">${glyph(a.provider)}${PROVIDER_NAME[a.provider]} · ${accountLabel(state, a.account)} · ${WORKSPACE.name}</p>
  <p class="lk-card__mono lk-mono"><span>${esc(a.model === "Default" ? "default" : a.model.toLowerCase())}</span><span class="lk-kbd">${esc(a.effort.toLowerCase())}</span>${icon("branch")}${esc(a.branch)}</p>
  ${approval || `<p class="lk-card__activity">${esc(a.activity)}</p>`}
  <p class="lk-card__foot"><span>${a.files} ${a.files === 1 ? "file" : "files"}</span><button type="button" class="lk-btn${needsYou(a) && !a.approval ? " lk-btn--primary" : ""}" data-do="agent:${a.id}">${needsYou(a) && !a.approval ? "Reply" : "Open"}${icon("forward")}</button></p>
</article>`;
}

function dashboard(state: State): string {
  const c = counts(state);
  const list = agentsList(state);
  const filters: [State["fleet"], string, number][] = [
    ["all", "All", c.agents],
    ["needs", "Needs you", c.needs],
    ["working", "Working", c.working],
    ["done", "Done", c.done],
    ["idle", "Idle", c.idle],
  ];
  const pick = (f: State["fleet"]) =>
    f === "needs"
      ? list.filter(needsYou)
      : f === "working"
        ? list.filter(isWorking)
        : f === "done"
          ? list.filter((a) => a.status === "done")
          : f === "idle"
            ? list.filter((a) => a.status === "idle")
            : list;
  const groups: [string, string, Agent[]][] =
    state.fleet === "all"
      ? [
          ["Needs you", "waiting", pick("needs")],
          ["Working", "working", pick("working")],
          ["Done", "done", pick("done")],
          ["Idle", "muted", pick("idle")],
        ]
      : [[filters.find((f) => f[0] === state.fleet)?.[1] ?? "", "muted", pick(state.fleet)]];
  const seg = (n: number, tone: string) =>
    n ? `<span class="lk-seg" data-tone="${tone}" data-n="${Math.min(n, 10)}"></span>` : "";
  return `<div class="lk-page lk-scroll" data-scroll-key="dash">
  <header class="lk-page__head"><div><h3 class="lk-h1">Dashboard</h3><p>${c.agents} agents · ${c.working} working · ${c.needs} ${c.needs === 1 ? "needs" : "need"} you · ${c.done} done${c.idle ? ` · ${c.idle} idle` : ""}</p></div>
    <div class="lk-trend" aria-hidden="true"><small>Last hour</small><span class="lk-trend__bars">${[1, 1, 2, 1, 3, 2, 4, 3, 5, 6].map((h) => `<i data-h="${h}"></i>`).join("")}</span><strong>${12 + state.tick} events</strong></div></header>
  <section class="lk-board" aria-label="Agent Fleet" data-tour="fleet">
    <div class="lk-board__top"><p class="lk-board__count"><span class="lk-eyebrow">Agent Fleet ${soon("agent-fleet")}</span><strong>${c.agents}</strong> agents</p><span class="lk-segbar" aria-hidden="true">${seg(c.needs, "waiting")}${seg(c.working, "working")}${seg(c.done, "done")}${seg(c.idle, "muted")}</span>
      <div class="lk-filters" role="group" aria-label="Filter agents">${filters.map(([id, label, n]) => `<button type="button" class="lk-filter" data-do="fleet:${id}" aria-pressed="${state.fleet === id}">${label} <strong>${n}</strong></button>`).join("")}</div>
      <button type="button" class="lk-btn" data-do="tidy-finished">${icon("tidy")}Clean up</button>
    </div>
    ${
      groups
        .filter(([, , agents]) => agents.length)
        .map(
          ([label, tone, agents]) =>
            `<div class="lk-group"><p class="lk-label" data-tone="${tone}"><span class="lk-dot"></span>${label} <span>${agents.length}</span></p><div class="lk-cards">${agents.map((a) => fleetCard(state, a)).join("")}</div></div>`,
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

function operations(state: State): string {
  const all = runs(state);
  const running = all.filter((r) => r.status === "Running").length;
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
    [2, "Queued", "muted"],
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
      <ol class="lk-timeline"><li data-done="true">Queued</li><li data-done="true">Started${agent ? ` · ${esc(agent.sign)} on ${esc(accountLabel(state, agent.account))}` : ""}</li><li data-done="${selected.status === "Succeeded"}">${esc(selected.action)}</li></ol>
      <dl class="lk-dl"><div><dt>Changed files</dt><dd>${agent ? agent.files : selected.kind === "build" ? "—" : "0"}</dd></div><div><dt>Tests</dt><dd>${selected.name === "Tests" || agent?.status === "done" ? "14 passed" : "—"}</dd></div><div><dt>Branch</dt><dd class="lk-mono">${esc(agent?.branch ?? "main")}</dd></div></dl>
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
    now.map((r) => card(r.name, r.agent ? `${state.agents[r.agent]?.sign ?? ""} · ${r.status}` : r.status)),
  )}${col("Next", [card("Update README screenshots", "Codex · Personal · Default"), card("Dark mode tokens", "Claude Code · Personal · Sonnet")])}${col("Later", [card("Upgrade the router", "Unassigned")])}</div>`;
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
    .map((a) => `<li>${glyph(a.provider)}<strong>${esc(a.sign)}</strong> ${esc(a.activity)}</li>`)
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
    <div class="lk-kvcard"><p class="lk-label">Commands</p><span class="lk-pill" data-tone="working">Available</span><p>Say “Open Dashboard” or “Open four Codex terminals”: KalCode acts the moment you let go.</p><small>Dictation is never counted</small></div>
    <div class="lk-kvcard"><p class="lk-label">This month</p><p class="lk-kvcount"><strong>${formatKalVoiceAllowance(free.limits)}</strong> KalVoice Requests on ${free.name}</p><small>${PLANS.map((p) => `${p.name} ${formatKalVoiceAllowance(p.limits)}`).join(" · ")}</small></div>
  </div>
</div>`;
}

function threads(): string {
  return `<div class="lk-page lk-scroll" data-scroll-key="th">
  <header class="lk-page__head"><div><h3 class="lk-h1">Threads</h3><p>Chat-style conversations with your providers, kept with your project.</p></div></header>
  <div class="lk-explain">${icon("alert")}<div><strong>Threads are conversations. Agents are terminals.</strong><p>A coding agent is the real Claude Code or Codex running in its own terminal in Code. Threads are a separate, chat-style surface.</p><button type="button" class="lk-btn lk-btn--primary" data-do="go:code">${icon("code")}See the agents in Code</button></div></div>
  <ul role="list" class="lk-threads"><li>${glyph("claude")}<span><strong>Plan the onboarding flow</strong><small>Claude Code · Personal · 2 hours ago</small></span></li><li>${glyph("codex")}<span><strong>Explain the auth middleware</strong><small>Codex · Personal · Yesterday</small></span></li></ul>
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
  <header class="lk-page__head"><div><h3 class="lk-h1">Providers ${soon("account-hub")}</h3><p>Claude Code and Codex, signed in with your own accounts. Add as many as you use.</p></div></header>
  <div class="lk-tabs" role="tablist" aria-label="Providers"><button type="button" role="tab" class="lk-tabs__tab" aria-selected="false" disabled>Setup</button><button type="button" role="tab" class="lk-tabs__tab" aria-selected="true">Accounts</button><button type="button" role="tab" class="lk-tabs__tab" aria-selected="false" disabled>Health</button></div>
  ${(["claude", "codex"] as const)
    .map(
      (p) =>
        `<div class="lk-provgroup"><p class="lk-label">${glyph(p)}${PROVIDER_NAME[p]}</p><div class="lk-accts">${state.accounts
          .filter((a) => a.provider === p)
          .map((a) => accountCard(a))
          .join(
            "",
          )}<button type="button" class="lk-acct lk-acct--add" data-do="connect">${icon("plus")}<span>Connect another account<small>Sign in from KalCode</small></span></button></div></div>`,
    )
    .join("")}
  <p class="lk-note">${icon("shield")} Usage appears only when reported by your provider. KalCode never pays for, resells or meters your AI usage.</p>
</div>`;
}

function settings(cfg: RenderConfig): string {
  return `<div class="lk-page lk-scroll" data-scroll-key="st">
  <header class="lk-page__head"><div><h3 class="lk-h1">Settings</h3><p>Appearance, KalVoice, updates and your account.</p></div></header>
  <dl class="lk-settings">
    <div><dt>Theme</dt><dd><span class="lk-seg-ctl"><span>System</span><span>Light</span><span aria-current="true">Dark</span></span></dd></div>
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
  const groups = (["claude", "codex"] as const)
    .map(
      (p) =>
        `<p class="lk-label">${glyph(p)}${PROVIDER_NAME[p]}</p>${state.accounts
          .filter((a) => a.provider === p)
          .map((a) => {
            const left = a.windows[0]?.left ?? 0;
            const on = l.account === a.id;
            return `<button type="button" role="radio" aria-checked="${on}" class="lk-lrow" data-key="lr-${a.id}" data-do="pick:${a.id}"><span class="lk-radio" aria-hidden="true"></span><span class="lk-lrow__name"><strong>${esc(a.name)}</strong><small>${esc(a.plan)}${a.isDefault ? " · Default" : ""}</small></span>${meter(left)}<span class="lk-lrow__left">${left}% left</span><span class="lk-lrow__state" data-tone="${left < 20 ? "waiting" : "working"}"><span class="lk-dot"></span>${left < 20 ? "Low" : "Ready"}</span></button>`;
          })
          .join("")}`,
    )
    .join("");
  const chips = (kind: "model" | "effort", values: readonly string[], value: string) =>
    values
      .map(
        (v) =>
          `<button type="button" role="radio" aria-checked="${v === value}" class="lk-chip" data-do="${kind}:${esc(v)}">${esc(v)}</button>`,
      )
      .join("");
  const n = l.count;
  return `<div class="lk-scrim" data-do="launcher-close"></div>
<div class="lk-dialog" role="dialog" aria-modal="true" aria-labelledby="lk-launch-title" data-tour="launcher" data-dialog>
  <header class="lk-dialog__head"><span class="lk-dialog__icon">${icon("bot")}</span><div><h4 id="lk-launch-title">New agent ${soon("provider-terminals")}</h4><p>A real coding agent in its own terminal in <strong>${WORKSPACE.name}</strong>.</p></div><kbd>Esc</kbd></header>
  <div class="lk-dialog__body">
    <div role="radiogroup" aria-label="Account">${groups}</div>
    <div class="lk-lset">
      <p class="lk-label">Model</p><div role="radiogroup" aria-label="Model" class="lk-chips">${chips("model", MODELS[l.provider], l.model)}</div>
      <p class="lk-label">Effort</p><div role="radiogroup" aria-label="Effort" class="lk-chips">${chips("effort", EFFORTS[l.provider], l.effort)}</div>
      <p class="lk-label">Agents</p><div class="lk-stepper"><button type="button" class="lk-icon-btn" data-do="count:-1" aria-label="One fewer agent" ${n <= 1 ? "disabled" : ""}>−</button><output aria-live="polite">${n}</output><button type="button" class="lk-icon-btn" data-do="count:1" aria-label="One more agent" ${n >= MAX_AGENTS_PER_LAUNCH ? "disabled" : ""}>+</button><small>Each agent gets its own terminal.</small></div>
    </div>
  </div>
  <footer class="lk-dialog__foot"><p class="lk-label">Other</p><button type="button" class="lk-chip" data-do="terminal">${icon("terminal")}Terminal</button><button type="button" class="lk-chip" data-do="browser">${icon("globe")}Live Browser</button><span class="lk-agent__spacer"></span><button type="button" class="lk-btn lk-btn--ghost" data-do="launcher-close">Cancel</button><button type="button" class="lk-btn lk-btn--primary lk-btn--launch" data-do="launch">${glyph(l.provider)}Launch ${n === 1 ? `${PROVIDER_NAME[l.provider]} agent` : `${n} ${PROVIDER_NAME[l.provider]} agents`}</button></footer>
</div>`;
}

function accountsPopover(state: State): string {
  return `<div class="lk-pop lk-pop--accounts" role="dialog" aria-label="Accounts and usage"><p class="lk-pop__title"><strong>Accounts &amp; usage</strong><small>Your providers, at a glance</small></p><p class="lk-pop__new">New agents: Claude Code · Personal</p>${state.accounts.map((a) => accountCard(a, true)).join("")}<p class="lk-pop__foot">Usage appears only when reported by your provider.</p><button type="button" class="lk-btn" data-do="go:providers">${icon("providers")}Manage accounts</button></div>`;
}

function envMenu(state: State): string {
  return `<div class="lk-pop lk-pop--env" role="menu" aria-label="Environment">${ENVIRONMENTS.map((e) => `<button type="button" role="menuitemradio" aria-checked="${state.environment === e}" class="lk-menu__item" data-do="env:${e}"><span class="lk-env-dot" data-env="${e}"></span><span>${e}</span></button>`).join("")}<button type="button" class="lk-menu__item" data-do="ops:environments">${icon("operations")}<span>Open Environments</span></button></div>`;
}

function modeMenu(): string {
  return `<div class="lk-pop lk-pop--mode" role="menu" aria-label="New agents start in"><p class="lk-label">New agents start in</p>${[
    ["Plan", "Plan first, change nothing yet"],
    ["Approve", "Ask before edits and commands"],
    ["Auto", "Act within your rules"],
  ]
    .map(
      ([m, d]) =>
        `<button type="button" role="menuitemradio" aria-checked="${m === "Approve"}" class="lk-menu__item" data-do="menu-close">${icon("shield")}<span>${m}<small>${d}</small></span></button>`,
    )
    .join("")}<p class="lk-pop__foot">Bypass and Custom are planned.</p></div>`;
}

interface Command {
  label: string;
  act: string;
  icon: LiveIcon;
}

export function paletteCommands(state: State): Command[] {
  const base: Command[] = [
    { label: "New agent", act: "launcher", icon: "bot" },
    { label: "Open Live Browser", act: "browser", icon: "globe" },
    { label: "New terminal", act: "terminal", icon: "terminal" },
    { label: "Show what needs me", act: "needs", icon: "alert" },
    { label: "KalTidy: stop idle terminals", act: "tidy", icon: "tidy" },
    ...SURFACES.map((s) => ({ label: `Go to ${s.label}`, act: `go:${s.id}`, icon: s.icon as LiveIcon })),
    { label: "Go to Settings", act: "go:settings", icon: "settings" },
    ...agentsList(state).map((a) => ({
      label: `Open ${a.sign} · ${a.task}`,
      act: `agent:${a.id}`,
      icon: "terminal" as LiveIcon,
    })),
  ];
  const q = state.palette.q.trim().toLowerCase();
  return q ? base.filter((c) => c.label.toLowerCase().includes(q)) : base;
}

function palette(state: State): string {
  const list = paletteCommands(state);
  const sel = Math.min(state.palette.sel, Math.max(0, list.length - 1));
  return `<div class="lk-scrim lk-scrim--light" data-do="menu-close"></div><div class="lk-palette" role="dialog" aria-modal="true" aria-label="Command palette" data-dialog><div class="lk-palette__input">${icon("search")}<input data-key="pal-in" data-palette autocomplete="off" role="combobox" aria-expanded="true" aria-controls="lk-pal-list" aria-activedescendant="lk-pal-${sel}" placeholder="Search or run a command" aria-label="Search or run a command" value="${esc(state.palette.q)}"/><kbd>Esc</kbd></div><ul id="lk-pal-list" role="listbox" class="lk-palette__list">${
    list
      .map(
        (c, i) =>
          `<li id="lk-pal-${i}" role="option" aria-selected="${i === sel}" data-key="p-${c.act}" data-do="${c.act}">${icon(c.icon)}<span>${esc(c.label)}</span></li>`,
      )
      .join("") || `<li class="lk-empty">No matching command</li>`
  }</ul></div>`;
}

function voicePanel(state: State): string {
  const v = state.voice;
  return `<div class="lk-pop lk-pop--voice" role="dialog" aria-label="KalVoice"><div class="lk-voice"><span class="lk-orb lk-orb--lg" data-state="${v.state}" aria-hidden="true"></span><div><p class="lk-voice__state">${voiceWord(state)}</p><p class="lk-voice__text" aria-live="polite">${v.state === "listening" ? `<span class="lk-wave" aria-hidden="true">${"<i></i>".repeat(16)}</span>` : ""}${esc(v.reply || v.heard || "Hold F8 in KalCode and speak. Here, pick a phrase:")}</p></div></div><div class="lk-suggest">${VOICE_PHRASES.map((p) => `<button type="button" class="lk-chip" data-do="say:${esc(p)}">“${esc(p)}”</button>`).join("")}</div><p class="lk-pop__foot">On-device dictation is unlimited on every plan.</p></div>`;
}

function toastView(state: State): string {
  const t = state.toast;
  if (!t) return "";
  return `<div class="lk-toast" role="status" data-key="toast-${t.id}" data-tone="${t.tone}">${icon(t.tone === "done" ? "check" : "kalvoice")}<span>${esc(t.text)}</span>${t.agent ? `<button type="button" class="lk-btn" data-do="agent:${t.agent}">Open</button>` : ""}<button type="button" class="lk-icon-btn" data-do="toast-close" aria-label="Dismiss">${icon("close")}</button></div>`;
}

function nudgeView(state: State, cfg: RenderConfig): string {
  const n = state.nudge;
  if (!n) return "";
  const href = n.cta === "account" ? cfg.accountHref : cfg.downloadHref;
  const label = n.cta === "account" ? "Create account" : n.cta === "get" ? "Get KalCode" : cfg.downloadLabel;
  return `<aside class="lk-nudge" aria-label="Try KalCode for real" data-key="nudge-${n.id}"><p><strong>${esc(n.title)}</strong>${esc(n.body)}</p><div><a class="lk-btn lk-btn--primary" href="${esc(href)}" data-cta="${n.id}">${esc(label)}</a><button type="button" class="lk-btn lk-btn--ghost" data-do="nudge-close">Keep exploring</button></div></aside>`;
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
    case "settings":
      return settings(cfg);
    default:
      return codeSurface(state);
  }
}

export function renderApp(state: State, cfg: RenderConfig): string {
  const menu = state.menu;
  return `<div class="lk-app" data-surface="${state.surface}" data-mobile="${state.mobile}" data-rail="${state.railOpen}" data-touring="${state.tour !== null}">
${topBar(state)}
<div class="lk-body">${state.mobile ? "" : sidebar(state)}<main class="lk-main" aria-label="${esc(SURFACES.find((s) => s.id === state.surface)?.label ?? "Settings")}">${surface(state, cfg)}</main>${state.mobile ? "" : rail(state)}</div>
${state.mobile ? tabBar(state) : ""}
${menu === "accounts" ? accountsPopover(state) : ""}${menu === "environment" ? envMenu(state) : ""}${menu === "mode" ? modeMenu() : ""}${state.voice.open ? voicePanel(state) : ""}
${menu === "palette" ? palette(state) : ""}${launcherDialog(state)}
<div class="lk-float">${toastView(state)}${nudgeView(state, cfg)}</div>
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
