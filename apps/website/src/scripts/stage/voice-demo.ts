/**
 * KalVoiceDemo: one on-screen push-to-talk key. Each hold plays the next take: first a prompt
 * that types into the focused pane, then "Open two more agents", which KalCode runs as a command.
 */
import { getApp, initAutoApps } from "./app";
import { bindPushToTalk } from "./ptt";
import { qsa, whenNear } from "./util";

type Say = "dictation" | "command";

function wire(block: HTMLElement): void {
  block.dataset.kcWired = "true";
  const root = block.querySelector<HTMLElement>("[data-kc-app]");
  const key = block.querySelector<HTMLElement>("[data-kc-vd='hold']");
  if (!root || !key) return;
  const next = (): Say => (block.dataset.say === "command" ? "command" : "dictation");

  const showNext = (value: Say) => {
    block.dataset.say = value;
    for (const el of qsa(block, "[data-kc-vd-next]")) el.hidden = el.dataset.kcVdNext !== value;
  };

  bindPushToTalk(
    key,
    block,
    () => getApp(root),
    () => {
      const say = next();
      // The following hold plays the other take.
      window.setTimeout(() => showNext(say === "dictation" ? "command" : "dictation"), 0);
      return say;
    },
  );

  block.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest("[data-kc-vd='reset']")) {
      getApp(root).reset();
      showNext("dictation");
    }
  });
}

initAutoApps();
for (const block of qsa(document, "[data-kc-vd]")) whenNear(block, () => wire(block));
