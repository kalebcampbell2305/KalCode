/**
 * Work that must finish in this page before a live UI update reloads it: a message send or a
 * thread create whose request is in flight. Reloading mid-request would drop the callback that
 * clears the composer, and the saved draft would bring already-sent text back.
 */
let holds = 0;

/** Holds the live reload until the returned function is called (idempotent). */
export function holdLiveReload(): () => void {
  holds += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds -= 1;
  };
}

export function liveReloadHeld(): boolean {
  return holds > 0;
}

/** Runs `work` with the live reload held until it settles. */
export async function whileHoldingLiveReload<T>(work: () => Promise<T>): Promise<T> {
  const release = holdLiveReload();
  try {
    return await work();
  } finally {
    release();
  }
}

/** Test helper. */
export function resetLiveReloadHolds(): void {
  holds = 0;
}
