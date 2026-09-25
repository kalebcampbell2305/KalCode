/**
 * Push-to-talk on an on-screen key: press and hold (pointer, or Space/Enter on the key), release
 * to act. The real key (F8) works only while focus is inside `scope`; it is never captured
 * globally. A click with no press (assistive technology) plays the whole scripted sample.
 */
import { VOICE } from "../../data/story";
import type { StageApp } from "./app";

export function bindPushToTalk(
  key: HTMLElement,
  scope: HTMLElement,
  app: () => StageApp,
  say: () => "dictation" | "command" = () => "dictation",
): void {
  let holding = false;
  let pressedAt = 0;

  const start = () => {
    if (holding || app().voiceBusy) return;
    holding = true;
    pressedAt = performance.now();
    key.setAttribute("data-holding", "");
    app().holdStart(say());
  };
  const end = () => {
    if (!holding) return;
    holding = false;
    key.removeAttribute("data-holding");
    app().holdEnd();
  };

  key.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    key.setPointerCapture?.(e.pointerId);
    start();
  });
  key.addEventListener("pointerup", end);
  key.addEventListener("pointercancel", end);
  key.addEventListener("keydown", (e) => {
    if ((e.key === " " || e.key === "Enter") && !e.repeat) {
      e.preventDefault();
      start();
    }
  });
  key.addEventListener("keyup", (e) => {
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      end();
    }
  });
  key.addEventListener("click", (e) => {
    if (e.detail !== 0 || holding || performance.now() - pressedAt < 400 || app().voiceBusy) return;
    if (say() === "command") app().command();
    else app().dictate();
  });

  scope.addEventListener("keydown", (e) => {
    if (e.key === VOICE.key && !e.repeat) {
      e.preventDefault();
      start();
    }
  });
  scope.addEventListener("keyup", (e) => {
    if (e.key === VOICE.key) {
      e.preventDefault();
      end();
    }
  });
}
