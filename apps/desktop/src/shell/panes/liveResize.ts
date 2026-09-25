/**
 * While a divider is being dragged, terminal views skip their per-frame fit (measuring and
 * re-flowing xterm.js in every pane at 60 fps would drop frames with many panes). They fit once
 * when the drag ends. Also used by the output scheduler to know when a pane is being resized.
 */

let active = 0;
const waiting = new Set<() => void>();

/** Marks a live resize as started; call the returned function when it ends. */
export function beginLiveResize(): () => void {
  active++;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    active = Math.max(0, active - 1);
    if (active === 0) {
      const run = [...waiting];
      waiting.clear();
      for (const callback of run) callback();
    }
  };
}

export function isLiveResizing(): boolean {
  return active > 0;
}

/** Runs `callback` now, or once the live resize in progress ends. */
export function afterLiveResize(callback: () => void): () => void {
  if (active === 0) {
    callback();
    return () => undefined;
  }
  waiting.add(callback);
  return () => waiting.delete(callback);
}
