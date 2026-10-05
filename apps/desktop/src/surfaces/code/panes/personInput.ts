/**
 * When the person last pressed a key or pointed anywhere in the window (performance.now() time).
 * Deferred focus (a terminal whose instance arrives after its focus request) yields to anything
 * the person did since: a terminal becoming ready must never take focus from what they are using.
 * Only trusted events count, so the app's own synthetic events never cancel a request.
 */
let lastInput = 0;
let listening = false;

function record(event: Event) {
  if (event.isTrusted) lastInput = performance.now();
}

export function lastPersonInputAt(): number {
  if (!listening && typeof window !== "undefined") {
    listening = true;
    window.addEventListener("pointerdown", record, { capture: true, passive: true });
    window.addEventListener("keydown", record, { capture: true, passive: true });
  }
  return lastInput;
}
