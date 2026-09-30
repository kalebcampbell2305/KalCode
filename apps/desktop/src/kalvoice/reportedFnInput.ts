/** Windows has no universal Fn key. Forward only an explicit Fn event from this WebView. */
export function attachReportedFnInput(
  target: Window,
  send: (input: "down" | "up" | "other") => Promise<boolean>,
  unavailable: () => void,
): () => void {
  let held = false;
  let chord = false;
  let pending = Promise.resolve();
  const forward = (input: "down" | "up" | "other") => {
    // Preserve press/release order even when native admission is asynchronous. Other keys' names
    // never leave the WebView, and repeated key events cannot build an IPC queue.
    pending = pending.then(async () => {
      try {
        if (!(await send(input)) && input === "down") unavailable();
      } catch {
        if (input === "down") unavailable();
      }
    });
  };
  const isFn = (event: KeyboardEvent) => event.key === "Fn" || event.code === "Fn";
  const onDown = (event: KeyboardEvent) => {
    if (!event.isTrusted) return;
    if (isFn(event)) {
      if (held || event.repeat) return;
      held = true;
      chord = event.ctrlKey || event.altKey || event.metaKey || event.shiftKey;
      // Never arm a hold for an existing chord, even if IPC is delayed beyond the hold threshold.
      forward(chord ? "other" : "down");
    } else if (held && !chord) {
      chord = true;
      forward("other");
    }
  };
  const release = () => {
    if (!held) return;
    held = false;
    chord = false;
    forward("up");
  };
  const onUp = (event: KeyboardEvent) => {
    if (event.isTrusted && isFn(event)) release();
  };
  target.addEventListener("keydown", onDown, true);
  target.addEventListener("keyup", onUp, true);
  target.addEventListener("blur", release);
  return () => {
    release();
    target.removeEventListener("keydown", onDown, true);
    target.removeEventListener("keyup", onUp, true);
    target.removeEventListener("blur", release);
  };
}
