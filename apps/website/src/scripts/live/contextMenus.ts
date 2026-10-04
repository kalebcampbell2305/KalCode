/** Object actions for the temporary sample, using the same Code/agent distinction as the app. */
import {
  closeTab,
  focusTab,
  frameOfTab,
  isAvailable,
  isWorking,
  launch,
  openBrowser,
  openLauncher,
  openTerminal,
  type State,
  tabOfAgent,
  toast,
} from "../../lib/live/model";

export type DemoContextTarget = { kind: "workspace" } | { kind: "tab" | "output"; id: string };
type Action = "launcher" | "browser" | "duplicate" | "focus" | "stop" | "close" | "copy";
interface Item {
  action: Action;
  label: string;
  danger?: boolean;
}

/** A menu contains only actions that can operate on this sample object now. */
export function demoContextItems(state: State, target: DemoContextTarget): Item[] {
  if (target.kind === "workspace")
    return [
      { action: "launcher", label: "New coding agent…" },
      { action: "browser", label: "Open Browser" },
    ];
  const tab = state.tabs[target.id];
  if (!tab || (tab.kind !== "agent" && tab.kind !== "terminal")) return [];
  const agent = tab.agent ? state.agents[tab.agent] : undefined;
  if (target.kind === "output")
    return (agent?.lines ?? tab.lines ?? []).length ? [{ action: "copy", label: "Copy relevant context" }] : [];
  const items: Item[] = [
    { action: "browser", label: "Open Browser beside" },
    { action: "duplicate", label: "Duplicate" },
    { action: "focus", label: "Focus" },
  ];
  if (agent ? isWorking(agent) || agent.approval !== null : !tab.idle)
    items.push({ action: "stop", label: "Stop", danger: true });
  items.push({ action: "close", label: "Close", danger: true });
  return items;
}

/** Returns clipboard text only for an explicit Copy action. No demo action invokes a real provider. */
export function applyDemoContextAction(state: State, target: DemoContextTarget, action: Action): string | null {
  if (!demoContextItems(state, target).some((item) => item.action === action)) return null;
  if (action === "launcher") {
    openLauncher(state);
    return null;
  }
  const tab = target.kind !== "workspace" ? state.tabs[target.id] : undefined;
  const agent = tab?.agent ? state.agents[tab.agent] : undefined;
  if (action === "browser") {
    const beside = tab ? frameOfTab(state, tab.id) : undefined;
    if (tab) focusTab(state, tab.id);
    openBrowser(state);
    const browser = Object.values(state.tabs).find((item) => item.kind === "browser");
    const frame = browser && frameOfTab(state, browser.id);
    if (beside && frame && frame !== beside) {
      state.frames = state.frames.filter((item) => item !== frame);
      state.frames.splice(state.frames.indexOf(beside) + 1, 0, frame);
    }
  } else if (tab && action === "focus") focusTab(state, tab.id);
  else if (tab && action === "duplicate") {
    if (agent) {
      openLauncher(state, agent.provider);
      state.launcher = {
        provider: agent.provider,
        account: agent.account,
        model: agent.model,
        effort: agent.effort,
        count: 1,
      };
      launch(state);
    } else openTerminal(state);
    toast(state, "Opened a fresh coding session. Existing work stays in its original pane.");
  } else if (tab && action === "stop") {
    if (agent) {
      agent.status = "idle";
      agent.activity = "Stopped";
      agent.script = [];
      agent.approval = null;
      agent.prompt = true;
    } else {
      tab.idle = true;
      tab.lines = [...(tab.lines ?? []), { k: "dim", t: "Stopped the sample command. Shell ready." }];
    }
    toast(state, `Stopped ${tab.title}.`);
  } else if (tab && action === "close") closeTab(state, tab.id);
  else if (tab && action === "copy")
    return (agent?.lines ?? tab.lines ?? [])
      .slice(-40)
      .map((line) => line.t)
      .join("\n");
  return null;
}

/** Delegates to the existing rendered objects, so the demo's shell has a single renderer. */
export function mountContextMenus(host: HTMLElement, getState: () => State, render: () => void) {
  let menu: HTMLDivElement | null = null;
  let invoker: HTMLElement | null = null;
  const root = host.parentElement ?? host;

  function close(restore = false) {
    menu?.remove();
    menu = null;
    if (restore && invoker?.isConnected) invoker.focus({ preventScroll: true });
  }
  function targetOf(element: HTMLElement): { target: DemoContextTarget; element: HTMLElement } | null {
    const state = getState();
    const object = element.closest<HTMLElement>(".lk-tab, .lk-rail__row, .lk-card, .lk-term, .lk-ctx__chip, .lk-mtab");
    if (!object || !host.contains(object)) return null;
    if (object.matches('.lk-ctx__chip[data-do="go:code"]')) return { target: { kind: "workspace" }, element: object };
    let id = object.querySelector<HTMLElement>('[data-do^="tab:"]')?.dataset.do?.slice(4);
    if (!id && object.dataset.do?.startsWith("tab:")) id = object.dataset.do.slice(4);
    const agentId = object.matches(".lk-card")
      ? object.dataset.key?.slice(2)
      : object.dataset.do?.startsWith("agent:")
        ? object.dataset.do.slice(6)
        : undefined;
    if (agentId) id = tabOfAgent(state, agentId);
    if (!id && object.matches(".lk-term")) {
      const frame = object.closest<HTMLElement>("[data-do-focus]")?.dataset.doFocus ?? state.focus;
      id = state.frames.find((item) => item.id === frame)?.active;
    }
    return id ? { target: { kind: object.matches(".lk-term") ? "output" : "tab", id }, element: object } : null;
  }

  function open(element: HTMLElement, x: number, y: number): boolean {
    const found = targetOf(element);
    if (!found) return false;
    const items = demoContextItems(getState(), found.target).filter(
      (item) => item.action !== "copy" || navigator.clipboard?.writeText,
    );
    if (!items.length) return false;
    close();
    invoker = found.element.matches("button, [tabindex]")
      ? found.element
      : found.element.querySelector<HTMLElement>("button");
    menu = document.createElement("div");
    menu.className = "lk-object-menu";
    menu.setAttribute("role", "menu");
    const title =
      found.target.kind === "workspace"
        ? "Workspace actions"
        : `${getState().tabs[found.target.id]?.title ?? "Terminal"}${found.target.kind === "output" ? " output" : ""} actions`;
    menu.setAttribute("aria-label", title);
    const heading = document.createElement("p");
    heading.className = "lk-object-menu__title";
    heading.textContent = `${title}${isAvailable("context-menus") ? "" : " · Coming soon"}`;
    menu.append(heading);
    let danger = false;
    for (const item of items) {
      if (item.danger && !danger) {
        const separator = document.createElement("div");
        separator.setAttribute("role", "separator");
        menu.append(separator);
        danger = true;
      }
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("role", "menuitem");
      button.dataset.action = item.action;
      if (item.danger) button.dataset.danger = "true";
      button.textContent = item.label;
      button.addEventListener("click", () => {
        const state = getState();
        const text = applyDemoContextAction(state, found.target, item.action);
        close(item.action === "copy");
        render();
        if (text !== null)
          void navigator.clipboard.writeText(text).then(
            () => {
              toast(getState(), "Copied sample terminal context.");
              render();
            },
            () => {
              toast(getState(), "Clipboard access is unavailable in this browser.", "waiting");
              render();
            },
          );
        if (item.action === "launcher") host.querySelector<HTMLElement>("[data-dialog] button")?.focus();
        else if (item.action !== "copy") host.querySelector<HTMLElement>('[data-focused="true"] .lk-term')?.focus();
      });
      menu.append(button);
    }
    root.append(menu);
    const bounds = root.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(x - bounds.left, root.clientWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y - bounds.top, host.clientHeight - menu.offsetHeight - 8))}px`;
    menu.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
    menu.addEventListener("keydown", (event) => {
      const buttons = [...(menu?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? buttons.length - 1
              : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      } else if (event.key === "Escape" || event.key === "Tab") {
        event.preventDefault();
        close(true);
      }
    });
    return true;
  }
  host.addEventListener("contextmenu", (event) => {
    if (event.target instanceof HTMLElement && open(event.target, event.clientX, event.clientY)) event.preventDefault();
  });
  host.addEventListener("keydown", (event) => {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    if (!(event.target instanceof HTMLElement)) return;
    const rect = event.target.getBoundingClientRect();
    if (open(event.target, rect.left, rect.bottom)) {
      event.preventDefault();
      event.stopPropagation();
    }
  });
  document.addEventListener("pointerdown", (event) => {
    if (menu && event.target instanceof Node && !menu.contains(event.target)) close();
  });
  window.addEventListener("resize", () => close());
}
