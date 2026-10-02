/**
 * The Fleet's card → thread morph: the clicked card grows into that thread's view (View
 * Transitions API: WebView2 on Windows; WKWebView on macOS 15+). Where the API is missing, or
 * motion is reduced, the thread simply opens.
 */

type StartViewTransition = (update: () => Promise<void> | void) => {
  finished: Promise<void>;
  updateCallbackDone: Promise<void>;
};

const NAME = "fleet-agent";
/**
 * Rendering is paused while the new state is prepared, so wait only briefly for the thread view
 * to mount; if it isn't there yet, the page cross-fades instead of morphing.
 */
const MOUNT_WAIT_MS = 250;

function motionReduced(): boolean {
  const root = document.documentElement;
  if (root.dataset.motion === "reduced") return true;
  if (root.dataset.motion === "full") return false;
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/** The view of exactly this thread, once mounted (other open thread views are left alone). */
async function threadView(threadId: string): Promise<HTMLElement | null> {
  const selector = `[data-thread-detail="${CSS.escape(threadId)}"]`;
  const deadline = performance.now() + MOUNT_WAIT_MS;
  for (;;) {
    const found = document.querySelector<HTMLElement>(selector);
    if (found || performance.now() >= deadline) return found;
    await nextFrame();
  }
}

/** Opens a thread from its fleet card, morphing the card into the thread view when possible. */
export function morphIntoThread(card: HTMLElement | null, threadId: string, open: () => unknown): void {
  const start = (document as Document & { startViewTransition?: StartViewTransition }).startViewTransition;
  if (!start || !card || motionReduced()) {
    void Promise.resolve(open()).catch(() => undefined);
    return;
  }
  card.style.setProperty("view-transition-name", NAME);
  let target: HTMLElement | null = null;
  const transition = start.call(document, async () => {
    // Exactly one element carries the name in each state: the card before, the thread view after.
    card.style.removeProperty("view-transition-name");
    await open();
    target = await threadView(threadId);
    target?.style.setProperty("view-transition-name", NAME);
  });
  // Navigation errors surface where `open` reports them; the transition only cleans up.
  transition.finished
    .catch(() => undefined)
    .finally(() => {
      card.style.removeProperty("view-transition-name");
      target?.style.removeProperty("view-transition-name");
    });
}
