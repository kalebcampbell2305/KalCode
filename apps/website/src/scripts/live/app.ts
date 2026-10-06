/**
 * The live KalCode demo in the browser: state, actions, the living workspace and the tour.
 * Loaded on demand (components/live/LiveKalCode.astro imports it when the demo nears the viewport,
 * or at once when someone clicks Try KalCode). Nothing persists: Reset or a reload starts over.
 */

import { MEMORY_CATEGORIES, memoryAction, saveMemory } from "../../lib/live/memory";
import {
  afterLaunch,
  answerApproval,
  chooseAccount,
  closeOverlays,
  EFFORTS,
  focusAgent,
  focusTab,
  go,
  initialState,
  jumpToNeeds,
  launch,
  MAX_AGENTS_PER_LAUNCH,
  MODELS,
  type Mode,
  navStep,
  navTo,
  newLikeThis,
  nudge,
  openBrowser,
  openLauncher,
  openOperationsContext,
  openTerminal,
  openWidget,
  PROVIDER_NAME,
  type ProviderId,
  promptAgent,
  recordVisit,
  requestClose,
  resolveClose,
  runCommand,
  runShell,
  runVoice,
  type State,
  type Surface,
  tick,
  tidyFinished,
  tidyIdle,
  toast,
} from "../../lib/live/model";
import { paletteCommands, type RenderConfig, renderApp } from "../../lib/live/render";
import { TOUR } from "../../lib/live/tour";
import { mountAdaptiveCanvas } from "./canvas";
import { mountContextMenus } from "./contextMenus";
import { morph } from "./morph";

const TICK_MS = 1500;
const MOBILE_BELOW = 760;

export interface LiveDemo {
  run(action: string): void;
  startTour(): void;
  reset(): void;
}

export function mountLiveDemo(root: HTMLElement): LiveDemo {
  const found = root.querySelector<HTMLElement>("[data-live-app]");
  if (!found) throw new Error("live demo host missing");
  const host: HTMLElement = found;
  const cfg: RenderConfig = {
    downloadHref: root.dataset.downloadHref ?? "/download",
    downloadLabel: root.dataset.downloadLabel ?? "Download KalCode",
    accountHref: root.dataset.accountHref ?? "/account",
  };
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  let state: State = initialState();
  let visible = true;
  let timer = 0;
  let toastTimer = 0;
  let lastToast = 0;
  let nudgeTimer = 0;
  let lastNudge = "";
  let pendingFocus: string | null = null;
  const tip = root.querySelector<HTMLElement>("[data-live-tip]");
  const adaptiveCanvas = mountAdaptiveCanvas(host, { getState: () => state, render, focusSoon });

  try {
    const seen = JSON.parse(sessionStorage.getItem("kc-live-nudged") ?? "[]");
    if (Array.isArray(seen)) state.nudged = seen.filter((v): v is string => typeof v === "string");
  } catch {
    /* storage unavailable: nudges simply show again */
  }

  // ── Render ────────────────────────────────────────────────────────────────────────────────

  function render() {
    recordVisit(state);
    const scroll = new Map<string, number>();
    for (const el of host.querySelectorAll<HTMLElement>("[data-scroll-key]"))
      scroll.set(el.dataset.scrollKey ?? "", el.scrollTop);
    const template = document.createElement("template");
    template.innerHTML = renderApp(state, cfg).trim();
    const next = template.content.firstElementChild;
    const current = host.firstElementChild;
    if (next && current) morph(current, next);
    else if (next) host.replaceChildren(next);
    for (const el of host.querySelectorAll<HTMLElement>("[data-scroll-key]")) {
      const top = scroll.get(el.dataset.scrollKey ?? "");
      if (top !== undefined) el.scrollTop = top;
    }
    for (const term of host.querySelectorAll<HTMLElement>('[data-scroll="bottom"]')) term.scrollTop = term.scrollHeight;
    if (state.toast && state.toast.id !== lastToast) {
      lastToast = state.toast.id;
      window.clearTimeout(toastTimer);
      toastTimer = window.setTimeout(() => {
        state.toast = null;
        render();
      }, 6000);
    }
    // A nudge is an offer, not a wall: it steps aside on its own.
    if (state.nudge && state.nudge.id !== lastNudge) {
      lastNudge = state.nudge.id;
      window.clearTimeout(nudgeTimer);
      nudgeTimer = window.setTimeout(() => {
        state.nudge = null;
        lastNudge = "";
        render();
      }, 14000);
    }
    try {
      sessionStorage.setItem("kc-live-nudged", JSON.stringify(state.nudged));
    } catch {
      /* ignore */
    }
    if (pendingFocus) {
      host.querySelector<HTMLElement>(pendingFocus)?.focus({ preventScroll: true });
      pendingFocus = null;
    }
    adaptiveCanvas.afterRender();
    placeAnchored();
    if (state.tour !== null) placeTour();
    root.dataset.surface = state.surface;
  }

  function focusSoon(selector: string) {
    pendingFocus = selector;
  }

  /** Popovers that belong to an element inside a pane (the header account picker) sit under it. */
  function placeAnchored() {
    const app = host.firstElementChild as HTMLElement | null;
    for (const pop of host.querySelectorAll<HTMLElement>("[data-anchor]")) {
      const anchor = host.querySelector<HTMLElement>(pop.dataset.anchor ?? "");
      if (!app || !anchor || state.mobile) {
        pop.style.removeProperty("left");
        pop.style.removeProperty("top");
        pop.dataset.placed = String(state.mobile);
        continue;
      }
      const box = app.getBoundingClientRect();
      const rect = anchor.getBoundingClientRect();
      const width = pop.offsetWidth || 320;
      const height = pop.offsetHeight || 240;
      const left = Math.min(Math.max(8, rect.left - box.left), box.width - width - 8);
      let top = rect.bottom - box.top + 6;
      if (top + height > box.height - 8) top = Math.max(8, rect.top - box.top - height - 6);
      pop.style.left = `${left}px`;
      pop.style.top = `${top}px`;
      pop.dataset.placed = "true";
    }
  }

  // ── Actions ───────────────────────────────────────────────────────────────────────────────

  function closeMenus() {
    state.menu = null;
    state.voice.open = false;
    state.picker = null;
  }

  function act(action: string, el?: HTMLElement) {
    hideTip();
    if (adaptiveCanvas.act(action)) return;
    const [name, ...rest] = action.split(":");
    const arg = rest.join(":");
    if (name?.startsWith("memory-")) {
      memoryAction(state.memory, name.slice(7), arg);
      if (name === "memory-edit" || name === "memory-new") focusSoon('[data-key="memory-title"]');
      render();
      return;
    }
    switch (name) {
      case "go":
        go(state, arg as Surface);
        state.voice.open = false;
        break;
      case "menu": {
        const menu = arg as State["menu"];
        const wasOpen = state.menu === menu;
        state.voice.open = false;
        state.picker = null;
        state.menu = wasOpen ? null : menu;
        if (menu === "notifications" && !wasOpen) state.unread = 0;
        if (menu === "palette" && !wasOpen) {
          state.palette = { q: "", sel: 0 };
          focusSoon("[data-palette]");
        }
        if (menu === "accounts" && !wasOpen) nudge(state, "accounts");
        break;
      }
      case "menu-close":
      case "menus-close":
        closeMenus();
        break;
      case "needs":
        closeMenus();
        if (!jumpToNeeds(state)) toast(state, "Nothing needs you right now.");
        break;
      case "agent":
        closeMenus();
        state.launcher = null;
        focusAgent(state, arg);
        break;
      case "tab":
        focusTab(state, arg);
        break;
      case "close":
        requestClose(state, arg);
        if (state.closing) focusSoon('[data-do="close-keep"]');
        break;
      case "close-cancel":
      case "close-keep":
      case "close-stop": {
        const tab = state.closing;
        resolveClose(state, name === "close-keep" ? "keep" : name === "close-stop" ? "stop" : "cancel");
        if (name === "close-cancel" && tab) focusSoon(`[data-do="close:${tab}"]`);
        break;
      }
      case "picker": {
        const open = state.picker?.agent === arg;
        closeMenus();
        state.picker = open ? null : { agent: arg, choice: null };
        if (!open) focusSoon(".lk-pop--picker [aria-pressed='true']");
        break;
      }
      case "picker-pick":
        if (state.picker) state.picker.choice = arg;
        break;
      case "picker-start": {
        const picker = state.picker;
        state.picker = null;
        if (picker?.choice) {
          const created = newLikeThis(state, picker.agent, picker.choice);
          const agent = created ? state.agents[created] : undefined;
          if (agent) {
            const account = state.accounts.find((a) => a.id === agent.account)?.name ?? "that account";
            toast(state, `Started a fresh ${PROVIDER_NAME[agent.provider]} session on ${account}.`, "info", agent.id);
            focusSoon(`[data-key="in-${agent.id}"]`);
          }
        }
        break;
      }
      case "mode":
        if (arg === "bypass" || arg === "plan") {
          state.mode = arg as Mode;
          toast(state, `New agents start in ${arg === "bypass" ? "Bypass" : "Plan"}.`, "done");
        }
        state.menu = null;
        break;
      case "nav":
        closeMenus();
        if (!navStep(state, arg === "back" ? -1 : 1)) return;
        break;
      case "nav-to":
        closeMenus();
        navTo(state, Number(arg));
        break;
      case "rail-idle":
        state.idleOpen = !state.idleOpen;
        break;
      case "fav": {
        const saved = state.favorites.find((f) => f.key === arg);
        if (saved) act(saved.act);
        return;
      }
      case "fav-run":
        runCommand(state, arg);
        break;
      case "maximize":
        state.focus = arg;
        state.maximized = !state.maximized;
        break;
      case "launcher":
        openLauncher(state, (arg || "claude") as ProviderId);
        focusSoon('[data-dialog] [aria-checked="true"]');
        break;
      case "launcher-close":
        state.launcher = null;
        break;
      case "pick":
        chooseAccount(state, arg);
        break;
      case "model":
        if (state.launcher && MODELS[state.launcher.provider].includes(arg)) state.launcher.model = arg;
        break;
      case "effort":
        if (state.launcher && EFFORTS[state.launcher.provider].includes(arg)) state.launcher.effort = arg;
        break;
      case "count":
        if (state.launcher)
          state.launcher.count = Math.max(1, Math.min(MAX_AGENTS_PER_LAUNCH, state.launcher.count + Number(arg)));
        break;
      case "launch": {
        const created = launch(state);
        if (created.length) {
          const first = state.agents[created[0] as string];
          const provider = first ? PROVIDER_NAME[first.provider] : "coding";
          toast(
            state,
            created.length === 1
              ? `Launched a ${provider} agent in Code`
              : `Launched ${created.length} ${provider} agents in Code`,
            "info",
            created[0],
          );
          if (state.launches >= 1) nudge(state, "first-agent");
          afterLaunch(state);
          focusSoon(`[data-key="in-${created[0]}"]`);
        }
        break;
      }
      case "terminal":
        openTerminal(state);
        afterLaunch(state);
        break;
      case "browser":
        openBrowser(state);
        afterLaunch(state);
        break;
      case "context-operations":
        openOperationsContext(state);
        break;
      case "context-tab":
        if (arg === "runs" || arg === "services" || arg === "tests") state.contextTab = arg;
        break;
      case "widget":
        openWidget(state, arg as "approvals" | "agents");
        break;
      case "reload":
        toast(state, "Reloaded localhost:3000");
        break;
      case "tidy": {
        closeMenus();
        const r = tidyIdle(state);
        toast(
          state,
          r.stopped
            ? `Stopped ${r.stopped} idle ${r.stopped === 1 ? "terminal" : "terminals"}. Kept ${r.kept} in use.`
            : `No idle terminals. Kept ${r.kept} in use.`,
          "done",
        );
        break;
      }
      case "tidy-finished": {
        closeMenus();
        const n = tidyFinished(state);
        toast(
          state,
          n ? `Closed ${n} finished ${n === 1 ? "agent" : "agents"}.` : "No finished agents to clear.",
          "done",
        );
        break;
      }
      case "layout":
        state.layout = arg as State["layout"];
        state.menu = null;
        state.maximized = false;
        break;
      case "approve":
      case "deny":
        answerApproval(state, arg, name === "approve");
        break;
      case "fleet":
        state.fleet = arg as State["fleet"];
        break;
      case "ops":
        closeMenus();
        state.surface = "operations";
        state.opsTab = arg as State["opsTab"];
        break;
      case "run":
        state.run = state.run === arg ? null : arg;
        break;
      case "env":
        state.environment = arg as State["environment"];
        state.menu = null;
        break;
      case "rail":
        state.railOpen = !state.railOpen;
        break;
      case "prompt": {
        const [agentId, ...text] = arg.split(":");
        promptAgent(state, agentId ?? "", text.join(":"));
        break;
      }
      case "voice":
        state.menu = null;
        state.voice.open = arg === "open" ? true : arg === "close" ? false : !state.voice.open;
        if (state.voice.open) state.voice = { ...state.voice, state: "ready", heard: "", reply: "" };
        break;
      case "say":
        speak(arg);
        return;
      case "connect":
        nudge(state, "accounts");
        if (!state.nudge) toast(state, "In KalCode, this opens the provider's own sign-in.");
        break;
      case "toast-close":
        state.toast = null;
        break;
      case "nudge-close":
        state.nudge = null;
        break;
      case "tour-next":
        showStep((state.tour ?? 0) + 1);
        return;
      case "tour-prev":
        showStep((state.tour ?? 1) - 1);
        return;
      case "tour-end":
        endTour();
        return;
      case "reset":
        reset();
        return;
      default:
        return;
    }
    void el;
    render();
  }

  /** KalVoice, simulated: listening → processing → executing → done, then the real action runs. */
  function speak(phrase: string) {
    state.menu = null;
    state.voice = { open: true, state: "listening", heard: "", reply: "" };
    render();
    const words = phrase.split(" ");
    let i = 0;
    const step = reduced.matches ? 0 : 140;
    const typeWord = () => {
      i += 1;
      state.voice.heard = words.slice(0, i).join(" ");
      if (i < words.length) {
        render();
        window.setTimeout(typeWord, step);
        return;
      }
      state.voice.state = "processing";
      render();
      window.setTimeout(() => {
        state.voice.state = "executing";
        state.voice.reply = runVoice(state, phrase);
        state.voice.state = "done";
        nudge(state, "voice");
        render();
        window.setTimeout(() => {
          if (state.voice.state === "done" && state.tour === null) {
            state.voice.open = false;
            state.voice.state = "ready";
            render();
          }
        }, 2600);
      }, step * 3);
    };
    window.setTimeout(typeWord, step);
  }

  // ── Tour ──────────────────────────────────────────────────────────────────────────────────

  function showStep(index: number) {
    if (index < 0) return;
    if (index >= TOUR.length) {
      endTour();
      return;
    }
    state.tour = index;
    state.nudge = null;
    for (const action of TOUR[index]?.setup ?? []) act(action);
    render();
    host.querySelector<HTMLElement>("[data-tour-card]")?.focus({ preventScroll: true });
  }

  function endTour() {
    state.tour = null;
    state.launcher = null;
    closeMenus();
    render();
  }

  function placeTour() {
    const card = host.querySelector<HTMLElement>("[data-tour-card]");
    const spot = host.querySelector<HTMLElement>("[data-spot]");
    if (!card || !spot) return;
    card.tabIndex = -1;
    const step = TOUR[state.tour ?? 0];
    const app = host.firstElementChild as HTMLElement;
    const box = app.getBoundingClientRect();
    const target = step?.target ? host.querySelector<HTMLElement>(`[data-tour="${step.target}"]`) : null;
    const rect = target?.getBoundingClientRect();
    if (!rect || rect.width === 0) {
      spot.dataset.on = "false";
      card.dataset.place = "center";
      card.style.removeProperty("left");
      card.style.removeProperty("top");
      return;
    }
    spot.dataset.on = "true";
    const pad = 6;
    spot.style.left = `${rect.left - box.left - pad}px`;
    spot.style.top = `${rect.top - box.top - pad}px`;
    spot.style.width = `${rect.width + pad * 2}px`;
    spot.style.height = `${rect.height + pad * 2}px`;
    if (state.mobile) {
      card.dataset.place = "dock";
      card.style.removeProperty("left");
      card.style.removeProperty("top");
      return;
    }
    card.dataset.place = "float";
    const cw = card.offsetWidth || 340;
    const ch = card.offsetHeight || 200;
    const gap = 16;
    let left = rect.right - box.left + gap;
    let top = rect.top - box.top;
    if (left + cw > box.width - 12) left = rect.left - box.left - cw - gap;
    if (left < 12) {
      left = Math.min(Math.max(12, rect.left - box.left), box.width - cw - 12);
      top = rect.bottom - box.top + gap;
      if (top + ch > box.height - 12) top = rect.top - box.top - ch - gap;
    }
    top = Math.min(Math.max(12, top), box.height - ch - 12);
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
  }

  // ── Events ────────────────────────────────────────────────────────────────────────────────

  host.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const doer = target.closest<HTMLElement>("[data-do]");
    if (doer && host.contains(doer)) {
      if (doer instanceof HTMLButtonElement && doer.disabled) return;
      event.preventDefault();
      act(doer.dataset.do ?? "", doer);
      return;
    }
    // Clicking inside a pane focuses it (as in the app); clicking elsewhere closes menus.
    const frame = target.closest<HTMLElement>("[data-do-focus]");
    let changed = false;
    if (frame && state.focus !== frame.dataset.doFocus) {
      state.focus = frame.dataset.doFocus ?? state.focus;
      changed = true;
    }
    if ((state.menu || state.picker) && !target.closest(".lk-menu, .lk-pop, .lk-palette")) {
      closeMenus();
      changed = true;
    }
    if (changed) render();
  });

  host.addEventListener("submit", (event) => {
    const form = event.target as HTMLFormElement;
    event.preventDefault();
    if (form.dataset.form === "memory") {
      if (saveMemory(state.memory)) toast(state, "Saved in this temporary sample workspace.", "done");
      render();
      return;
    }
    const input = form.querySelector<HTMLInputElement>("input");
    const value = input?.value ?? "";
    const [kind, id] = (form.dataset.form ?? "").split(":");
    if (input) input.value = "";
    if (kind === "prompt" && id) promptAgent(state, id, value);
    else if (kind === "shell" && id) {
      runShell(state, id, value);
      focusSoon(`[data-key="in-${id}"]`);
    } else if (kind === "voice" && value.trim()) {
      speak(value.trim());
      return;
    }
    render();
  });

  host.addEventListener("input", (event) => {
    const input = event.target as HTMLInputElement;
    if (input.matches("[data-memory-query]")) {
      state.memory.query = input.value;
      state.memory.selected = null;
      state.memory.confirmRemove = false;
      render();
      return;
    }
    if (input.matches("[data-memory-category]")) {
      state.memory.category = input.value;
      state.memory.selected = null;
      state.memory.confirmRemove = false;
      render();
      return;
    }
    if (input.matches("[data-memory-field]") && state.memory.draft) {
      const field = input.dataset.memoryField;
      if (field === "title" || field === "content") state.memory.draft[field] = input.value;
      else if (field === "category" && Object.hasOwn(MEMORY_CATEGORIES, input.value)) {
        state.memory.draft.category = input.value as keyof typeof MEMORY_CATEGORIES;
      }
      return;
    }
    if (!input.matches("[data-palette]")) return;
    state.palette = { q: input.value, sel: 0 };
    render();
  });

  host.addEventListener("keydown", (event) => {
    const target = event.target as HTMLElement;
    if (state.menu === "palette") {
      const list = paletteCommands(state);
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const d = event.key === "ArrowDown" ? 1 : -1;
        state.palette.sel = (state.palette.sel + d + list.length) % Math.max(1, list.length);
        render();
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const command = list[Math.min(state.palette.sel, list.length - 1)];
        state.menu = null;
        if (command) act(command.act);
        else render();
        return;
      }
    }
    if (event.key === "Escape") {
      if (state.closing) {
        const tab = state.closing;
        resolveClose(state, "cancel");
        focusSoon(`[data-do="close:${tab}"]`);
      } else if (state.picker) {
        const agent = state.picker.agent;
        state.picker = null;
        focusSoon(`[data-picker-for="${agent}"]`);
      } else if (state.launcher) {
        state.launcher = null;
        focusSoon('[data-tour="new-agent"]');
      } else if (state.menu || state.voice.open) closeMenus();
      else if (state.tour !== null) {
        endTour();
        return;
      } else return;
      event.preventDefault();
      render();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      act("menu:palette");
      return;
    }
    if (event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight") && !target.matches("input")) {
      event.preventDefault();
      act(`nav:${event.key === "ArrowLeft" ? "back" : "forward"}`);
      return;
    }
    if (state.launcher && target.closest("[data-dialog]") && /^[0-9]$/.test(event.key) && !target.matches("input")) {
      state.launcher.count = event.key === "0" ? MAX_AGENTS_PER_LAUNCH : Number(event.key);
      render();
      return;
    }
    if (state.launcher && event.key === "Enter" && !(target instanceof HTMLButtonElement)) {
      act("launch");
      return;
    }
    if (event.key === "F8" && !event.repeat) {
      event.preventDefault();
      speak("Open Activity");
    }
  });

  // Keep keyboard focus inside the launcher and the palette while they are open.
  host.addEventListener("focusout", (event) => {
    const dialog = host.querySelector<HTMLElement>("[data-dialog]");
    const next = event.relatedTarget as Node | null;
    if (dialog && next && !dialog.contains(next) && host.contains(next)) {
      dialog.querySelector<HTMLElement>("button, input")?.focus();
    }
  });

  // Contextual hints: one floating tooltip for every [data-hint].
  let tipFor: HTMLElement | null = null;
  let clicked: HTMLElement | null = null;
  function showTip(el: HTMLElement) {
    // No hint over an open menu or dialog, and none for the control the visitor just used.
    if (!tip || state.tour !== null || el === clicked) return;
    if (state.menu || state.launcher || state.picker || state.closing || state.voice.open) return;
    tipFor = el;
    tip.textContent = el.dataset.hint ?? "";
    tip.dataset.on = "true";
    const r = el.getBoundingClientRect();
    const box = root.getBoundingClientRect();
    const tw = Math.min(280, tip.offsetWidth || 240);
    const left = Math.min(Math.max(8, r.left - box.left + r.width / 2 - tw / 2), box.width - tw - 8);
    const below = r.bottom - box.top + 10;
    tip.style.left = `${left}px`;
    tip.style.top = `${below + tip.offsetHeight > box.height ? r.top - box.top - tip.offsetHeight - 10 : below}px`;
  }
  function hideTip() {
    tipFor = null;
    if (tip) tip.dataset.on = "false";
  }
  let hoverTimer = 0;
  host.addEventListener("pointerover", (event) => {
    const el = (event.target as HTMLElement).closest<HTMLElement>("[data-hint]");
    if (el === tipFor) return;
    if (el !== clicked) clicked = null;
    window.clearTimeout(hoverTimer);
    if (!el || event.pointerType === "touch") return hideTip();
    hoverTimer = window.setTimeout(() => showTip(el), 380);
  });
  host.addEventListener("pointerleave", () => {
    window.clearTimeout(hoverTimer);
    hideTip();
  });
  host.addEventListener("focusin", (event) => {
    const el = (event.target as HTMLElement).closest<HTMLElement>("[data-hint]");
    if (el && (event.target as HTMLElement).matches(":focus-visible")) showTip(el);
    else hideTip();
  });
  host.addEventListener("pointerdown", (event) => {
    clicked = (event.target as HTMLElement).closest<HTMLElement>("[data-hint]");
    window.clearTimeout(hoverTimer);
    hideTip();
  });

  // Phones: swipe the pane left or right to move between panes.
  let swipeX = 0;
  let swipeY = 0;
  host.addEventListener(
    "touchstart",
    (event) => {
      const t = event.touches[0];
      if (!t || !(event.target as HTMLElement).closest("[data-swipe]")) return;
      swipeX = t.clientX;
      swipeY = t.clientY;
    },
    { passive: true },
  );
  host.addEventListener(
    "touchend",
    (event) => {
      const t = event.changedTouches[0];
      if (!t || !swipeX || !(event.target as HTMLElement).closest("[data-swipe]")) return;
      const dx = t.clientX - swipeX;
      const dy = t.clientY - swipeY;
      swipeX = 0;
      if (Math.abs(dx) < 60 || Math.abs(dy) > Math.abs(dx)) return;
      const all = state.frames.flatMap((f) => f.tabs);
      const current = state.frames.find((f) => f.id === state.focus)?.active ?? all[0];
      const index = all.indexOf(current ?? "");
      const next = all[index + (dx < 0 ? 1 : -1)];
      if (next) {
        focusTab(state, next);
        render();
      }
    },
    { passive: true },
  );

  // ── Life ──────────────────────────────────────────────────────────────────────────────────

  function loop() {
    window.clearInterval(timer);
    if (!visible || document.hidden) return;
    timer = window.setInterval(
      () => {
        // A held pane stays put: agent output would re-render and reflow the canvas under the pointer.
        if (adaptiveCanvas.dragging()) return;
        tick(state);
        render();
      },
      reduced.matches ? TICK_MS * 2 : TICK_MS,
    );
  }

  new IntersectionObserver(
    (entries) => {
      visible = entries.some((entry) => entry.isIntersecting);
      loop();
    },
    { rootMargin: "120px" },
  ).observe(root);
  document.addEventListener("visibilitychange", loop);

  const resize = new ResizeObserver(() => {
    const mobile = root.clientWidth < MOBILE_BELOW;
    if (mobile !== state.mobile) {
      state.mobile = mobile;
      render();
    } else if (state.tour !== null) placeTour();
  });
  resize.observe(root);

  function reset() {
    const nudged = state.nudged;
    state = initialState();
    state.nudged = nudged;
    state.mobile = root.clientWidth < MOBILE_BELOW;
    render();
  }

  state.mobile = root.clientWidth < MOBILE_BELOW;
  mountContextMenus(host, () => state, render);
  render();
  loop();
  root.dataset.live = "ready";

  return {
    run(action: string) {
      if (action === "tour") {
        showStep(0);
        return;
      }
      if (state.tour !== null) endTour();
      // A page control changes the demo: whatever floated over the old screen goes away first.
      closeOverlays(state);
      for (const a of action.split(",")) act(a.trim());
      if (action.startsWith("launcher"))
        host.querySelector<HTMLElement>('[data-dialog] [aria-checked="true"]')?.focus({ preventScroll: true });
    },
    startTour() {
      showStep(0);
    },
    reset,
  };
}
