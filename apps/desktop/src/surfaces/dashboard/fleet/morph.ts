/**
 * The Fleet's card → agent morph: the clicked card grows into that thread's view (View
 * Transitions API: WebView2 on Windows; WKWebView on macOS 15+). Where the API is missing, or
 * motion is reduced, the terminal simply opens.
 */

type StartViewTransition = (update: () => Promise<void> | void) => {
  finished: Promise<void>;
  updateCallbackDone: Promise<void>;
};

const NAME = "fleet-agent";
/**
 * Rendering is paused while the new state is prepared, so wait only briefly for the agent terminal
 * to mount; if it isn't there yet, the page cross-fades instead of morphing.
 */
const MOUNT_WAIT_MS = 100;
/**
 * How long the paused page waits for `open()` (IPC) before giving up on the morph. A slower open
 * keeps running and lands after a plain cross-fade, so the click never freezes the screen.
 */
const OPEN_WAIT_MS = 100;

function motionReduced(): boolean {
  const root = document.documentElement;
  if (root.dataset.motion === "reduced") return true;
  if (root.dataset.motion === "full") return false;
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/** The view of exactly this agent, once mounted (other open agent terminals are left alone). */
async function agentView(agentId: string): Promise<HTMLElement | null> {
  const selector = `[data-provider-pane="${CSS.escape(agentId)}"]`;
  const deadline = performance.now() + MOUNT_WAIT_MS;
  for (;;) {
    const found = document.querySelector<HTMLElement>(selector);
    if (found || performance.now() >= deadline) return found;
    await nextFrame();
  }
}

/** Opens an agent from its fleet card, morphing the card into the agent terminal when possible. */
export function morphIntoAgent(card: HTMLElement | null, agentId: string, open: () => unknown): void {
  const start = (document as Document & { startViewTransition?: StartViewTransition }).startViewTransition;
  if (!start || !card || motionReduced()) {
    void Promise.resolve(open()).catch(() => undefined);
    return;
  }
  card.style.setProperty("view-transition-name", NAME);
  let target: HTMLElement | null = null;
  const transition = start.call(document, async () => {
    // Exactly one element carries the name in each state: the card before, the agent terminal after.
    card.style.removeProperty("view-transition-name");
    const opening = new Promise((resolve) => resolve(open()));
    // The open keeps going past the race; its errors surface where `open` reports them.
    opening.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const opened = await Promise.race([
      opening.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), OPEN_WAIT_MS);
      }),
    ]).finally(() => clearTimeout(timer));
    if (!opened) return;
    target = await agentView(agentId);
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
