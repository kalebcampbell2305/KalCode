/**
 * Small helpers shared by the stage scripts: reduced-motion detection, a pausable timer queue,
 * visibility and proximity observers, live-region announcements and roving-tabindex keyboard
 * handling. No framework; everything is event-driven and pauses offscreen.
 */

export function reducedMotion(): boolean {
  const root = document.documentElement;
  if (root.dataset.motion === "reduced") return true;
  if (root.dataset.motion === "full") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

interface Task {
  fn: () => void;
  due: number;
  remaining: number;
  handle: number | undefined;
}

/** setTimeout queue that can be paused (offscreen, hidden tab) and cancelled as a whole. */
export class Scheduler {
  private tasks = new Set<Task>();
  private paused = false;

  after(ms: number, fn: () => void): void {
    const task: Task = { fn, due: performance.now() + ms, remaining: ms, handle: undefined };
    this.tasks.add(task);
    if (!this.paused) this.arm(task);
  }

  private arm(task: Task): void {
    task.due = performance.now() + task.remaining;
    task.handle = window.setTimeout(() => {
      this.tasks.delete(task);
      task.fn();
    }, task.remaining);
  }

  cancel(): void {
    for (const task of this.tasks) window.clearTimeout(task.handle);
    this.tasks.clear();
  }

  pause(): void {
    if (this.paused) return;
    this.paused = true;
    const now = performance.now();
    for (const task of this.tasks) {
      window.clearTimeout(task.handle);
      task.remaining = Math.max(0, task.due - now);
    }
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    for (const task of this.tasks) this.arm(task);
  }

  get busy(): boolean {
    return this.tasks.size > 0;
  }
}

/** Calls `cb` once, when `el` comes within `margin` of the viewport. */
export function whenNear(el: Element, cb: () => void, margin = "400px"): void {
  if (!("IntersectionObserver" in window)) {
    cb();
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        io.disconnect();
        cb();
      }
    },
    { rootMargin: margin },
  );
  io.observe(el);
}

/** Reports whether `el` is on screen and the tab is visible. */
export function watchVisibility(el: Element, onChange: (visible: boolean) => void): void {
  let onScreen = false;
  const report = () => onChange(onScreen && document.visibilityState === "visible");
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) onScreen = e.isIntersecting;
    report();
  });
  io.observe(el);
  document.addEventListener("visibilitychange", report);
}

/** Polite live-region announcement (cleared first so repeats are read). */
export function announce(region: Element | null | undefined, text: string): void {
  if (!region) return;
  region.textContent = "";
  window.setTimeout(() => {
    region.textContent = text;
  }, 60);
}

/**
 * Roving tabindex for a group of controls (tabs, radios, toolbar buttons). Arrow keys move
 * focus (and, with `select`, activate), Home/End jump to the ends.
 */
export function roving(
  group: HTMLElement,
  selector: string,
  options: { orientation?: "horizontal" | "both"; select?: (el: HTMLElement) => void } = {},
): void {
  const items = () => Array.from(group.querySelectorAll<HTMLElement>(selector)).filter((el) => !el.hidden);
  group.addEventListener("keydown", (event) => {
    const current = (event.target as HTMLElement).closest<HTMLElement>(selector);
    if (!current || !group.contains(current)) return;
    const list = items();
    const index = list.indexOf(current);
    if (index < 0) return;
    const both = options.orientation === "both";
    let next: HTMLElement | undefined;
    if (event.key === "ArrowRight" || (both && event.key === "ArrowDown")) next = list[(index + 1) % list.length];
    else if (event.key === "ArrowLeft" || (both && event.key === "ArrowUp"))
      next = list[(index - 1 + list.length) % list.length];
    else if (event.key === "Home") next = list[0];
    else if (event.key === "End") next = list[list.length - 1];
    if (!next) return;
    event.preventDefault();
    for (const el of list) el.tabIndex = el === next ? 0 : -1;
    next.focus();
    options.select?.(next);
  });
}

/** Sets the roving tab stop to `active` among `items`. */
export function setTabStop(items: Iterable<HTMLElement>, active: HTMLElement | null): void {
  for (const el of items) el.tabIndex = el === active ? 0 : -1;
}

export function qsa<T extends Element = HTMLElement>(root: ParentNode, selector: string): T[] {
  return Array.from(root.querySelectorAll<T>(selector as never)) as T[];
}

export function formatElapsed(seconds: number): string {
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/**
 * Shows the tail of a transcript, like a terminal that has been running, and hides any block the
 * top edge would cut in half (a clipped banner box or half a line reads as a rendering bug).
 * Diffs are hidden row by row. One layout read after the scroll write; writes after the reads.
 */
export function fitLog(log: HTMLElement): void {
  for (const el of Array.from(log.querySelectorAll("[data-clipped]"))) el.removeAttribute("data-clipped");
  const term = log.parentElement;
  term?.removeAttribute("data-scrolled");
  log.scrollTop = log.scrollHeight;
  if (log.scrollTop <= 0) return;
  const edge = log.getBoundingClientRect().top + 0.5;
  const cut: Element[] = [];
  let firstShown = edge;
  for (const child of Array.from(log.children) as HTMLElement[]) {
    if (child.hidden || child.hasAttribute("data-pending")) continue;
    const r = child.getBoundingClientRect();
    if (r.bottom <= edge) continue;
    if (r.top >= edge) {
      firstShown = r.top;
      break;
    }
    if (child.classList.contains("kc-diff")) {
      for (const row of Array.from(child.children)) if (row.getBoundingClientRect().top < edge) cut.push(row);
    } else cut.push(child);
  }
  for (const el of cut) el.setAttribute("data-clipped", "");
  // Enough room above the first whole block: say that earlier output scrolled away.
  if (cut.length && firstShown - edge >= 20) term?.setAttribute("data-scrolled", "");
}

/** Fits every transcript inside `root` (see fitLog). */
export function pinLogs(root: ParentNode): void {
  for (const log of Array.from(root.querySelectorAll<HTMLElement>("[data-kc-log]"))) fitLog(log);
}

/** Refits a transcript whenever its box changes size (fonts, splits, docks, viewport). */
const logObserver =
  typeof ResizeObserver === "undefined"
    ? null
    : new ResizeObserver((entries) => {
        for (const entry of entries) fitLog(entry.target as HTMLElement);
      });

export function watchLogs(root: ParentNode): void {
  if (!logObserver) return;
  for (const log of Array.from(root.querySelectorAll<HTMLElement>("[data-kc-log]"))) logObserver.observe(log);
}
