/** TryKalCode toolbar: roving focus, actions on the window, pressed states that follow it. */
import type { Scene } from "../../data/story";
import { getApp, initAutoApps } from "./app";
import { bindPushToTalk } from "./ptt";
import { qsa, roving, whenNear } from "./util";

function wire(block: HTMLElement): void {
  block.dataset.kcWired = "true";
  const toolbar = block.querySelector<HTMLElement>("[data-kc-toolbar]");
  const root = block.querySelector<HTMLElement>("[data-kc-app]");
  if (!toolbar || !root) return;
  roving(toolbar, ".kc-tbtn");
  const ptt = toolbar.querySelector<HTMLElement>("[data-kc-ptt]");
  if (ptt) bindPushToTalk(ptt, block, () => getApp(root));

  const sync = (scene: Scene) => {
    const app = getApp(root);
    const provider = app.pane(scene.focus)?.dataset.provider;
    for (const btn of qsa(toolbar, "[data-kc-do]")) {
      const action = btn.dataset.kcDo ?? "";
      let pressed: boolean | null = null;
      if (action.startsWith("provider:")) pressed = action === `provider:${provider}`;
      else if (action === "dock:browser") pressed = scene.dock === "browser";
      else if (action === "dock:dashboard") pressed = scene.dock === "dashboard" || scene.view === "dashboard";
      else if (action === "permissions") pressed = scene.dock === "permissions";
      if (pressed !== null) btn.setAttribute("aria-pressed", pressed ? "true" : "false");
    }
  };
  root.addEventListener("kc:state", (e) => sync((e as CustomEvent<Scene>).detail));

  toolbar.addEventListener("click", (event) => {
    const btn = (event.target as HTMLElement).closest<HTMLElement>("[data-kc-do]");
    if (!btn) return;
    const app = getApp(root);
    const action = btn.dataset.kcDo ?? "";
    if (action.startsWith("provider:")) app.openProvider(action.slice(9) as "claude" | "codex" | "gemini");
    else if (action === "new") app.newThread();
    else if (action === "split") app.split();
    else if (action === "dock:browser" || action === "dock:dashboard") {
      const tab = action.slice(5) as "browser" | "dashboard";
      if (app.state.view === "dashboard") app.setView("code");
      app.apply({ dock: app.state.dock === tab ? "none" : tab }, { animate: true });
      app.say(
        app.state.dock === "none"
          ? "Dock closed."
          : tab === "browser"
            ? "Browser docked: localhost:3000."
            : "Dashboard docked.",
      );
    } else if (action === "permissions") {
      const showing = app.state.dock === "permissions";
      app.apply(
        {
          dock: showing ? "none" : "permissions",
          approval: showing ? app.state.approval : app.state.approval === "none" ? "pending" : app.state.approval,
        },
        { animate: true },
      );
      if (!showing)
        app.say("Permissions. Codex wants to run: pnpm add zod. Choose Deny, Allow for thread or Approve once.");
    } else if (action === "reset") app.reset();
  });
}

initAutoApps();
for (const block of qsa(document, "[data-kc-try]")) whenNear(block, () => wire(block));
