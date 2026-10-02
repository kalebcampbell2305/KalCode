/** Combines cancellation from either owner into one signal. */
export function combineAbortSignals(signals: readonly AbortSignal[]): AbortSignal {
  const nativeAny = (AbortSignal as { any?: (inputs: AbortSignal[]) => AbortSignal }).any;
  if (typeof nativeAny === "function") return nativeAny.call(AbortSignal, [...signals]);

  const controller = new AbortController();
  const listeners: { signal: AbortSignal; listener: () => void }[] = [];
  let settled = false;
  const cleanup = () => {
    for (const { signal, listener } of listeners) signal.removeEventListener("abort", listener);
    listeners.length = 0;
  };
  const abortFrom = (signal: AbortSignal) => {
    if (settled) return;
    settled = true;
    cleanup();
    controller.abort(signal.reason);
  };

  for (const signal of signals) {
    if (signal.aborted) {
      abortFrom(signal);
      break;
    }
    const listener = () => abortFrom(signal);
    listeners.push({ signal, listener });
    signal.addEventListener("abort", listener, { once: true });
    // Covers an exotic signal implementation that aborts while its listener is attached.
    if (signal.aborted) abortFrom(signal);
    if (settled) break;
  }
  return controller.signal;
}
