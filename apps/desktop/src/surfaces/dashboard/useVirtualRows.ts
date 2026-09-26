import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

/**
 * A small row virtualizer for the Dashboard board and the notification list (Z7-W3). Rows have
 * estimated heights that are replaced by measured ones (ResizeObserver), and the visible window is
 * computed against the nearest scrolling ancestor, so the same list works in a full-page surface
 * (the page scrolls) and in a pane (the pane scrolls). Short lists render every row: nothing is
 * virtualized until there are more than `threshold` rows.
 */

export interface VirtualRow {
  index: number;
  key: string;
  start: number;
  size: number;
}

export interface VirtualRowsOptions {
  count: number;
  getKey: (index: number) => string;
  estimate: (index: number) => number;
  /** Extra pixels rendered above and below the viewport. */
  overscan?: number;
  /** Lists with this many rows or fewer render every row. */
  threshold?: number;
}

export interface VirtualRowsResult {
  /** Attach to the positioned container (its height is `total`). */
  containerRef: (el: HTMLElement | null) => void;
  total: number;
  rows: VirtualRow[];
  /** Ref callback per rendered row: measures it. */
  measureRef: (key: string) => (el: HTMLElement | null) => void;
  virtualized: boolean;
}

function scrollParent(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement ?? null;
  while (node) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === "auto" || overflow === "scroll") return node;
    node = node.parentElement;
  }
  return null;
}

export function useVirtualRows({
  count,
  getKey,
  estimate,
  overscan = 800,
  threshold = 12,
}: VirtualRowsOptions): VirtualRowsResult {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const sizes = useRef(new Map<string, number>());
  const [version, setVersion] = useState(0);
  const [range, setRange] = useState<{ top: number; bottom: number }>({ top: 0, bottom: 1600 });
  const virtualized = count > threshold;

  const layout = useMemo(() => {
    void version;
    const rows: VirtualRow[] = [];
    let start = 0;
    for (let index = 0; index < count; index += 1) {
      const key = getKey(index);
      const size = sizes.current.get(key) ?? estimate(index);
      rows.push({ index, key, start, size });
      start += size;
    }
    return { rows, total: start };
  }, [count, getKey, estimate, version]);

  // The visible window, in the container's coordinates.
  const update = useCallback(() => {
    if (!container) return;
    const scroller = scrollParent(container);
    const rect = container.getBoundingClientRect();
    const viewTop = scroller ? scroller.getBoundingClientRect().top : 0;
    const viewHeight = scroller ? scroller.clientHeight : window.innerHeight;
    const top = viewTop - rect.top - overscan;
    const bottom = viewTop - rect.top + viewHeight + overscan;
    setRange((current) =>
      Math.abs(current.top - top) < 24 && Math.abs(current.bottom - bottom) < 24 ? current : { top, bottom },
    );
  }, [container, overscan]);

  useLayoutEffect(() => {
    if (!container || !virtualized) return;
    update();
    const scroller = scrollParent(container);
    const target: HTMLElement | Window = scroller ?? window;
    target.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    if (scroller) observer?.observe(scroller);
    return () => {
      target.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      observer?.disconnect();
    };
  }, [container, virtualized, update]);

  // Row measurement.
  const observed = useRef(new Map<Element, string>());
  const resizeObserver = useMemo(() => {
    if (typeof ResizeObserver === "undefined") return null;
    return new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const key = observed.current.get(entry.target);
        if (!key) continue;
        const height = Math.round((entry.target as HTMLElement).offsetHeight);
        if (height > 0 && sizes.current.get(key) !== height) {
          sizes.current.set(key, height);
          changed = true;
        }
      }
      if (changed) setVersion((v) => v + 1);
    });
  }, []);
  useEffect(() => () => resizeObserver?.disconnect(), [resizeObserver]);

  const refs = useRef(new Map<string, (el: HTMLElement | null) => void>());
  const elements = useRef(new Map<string, HTMLElement>());
  useEffect(() => {
    // Keep measurements for virtualized rows, but forget rows removed from the list. A collapsed
    // group can return with different content; its previous height must not outlive its membership.
    const keys = new Set(layout.rows.map((row) => row.key));
    for (const key of sizes.current.keys()) {
      if (!keys.has(key)) sizes.current.delete(key);
    }
    for (const key of refs.current.keys()) {
      if (!keys.has(key)) refs.current.delete(key);
    }
  }, [layout.rows]);
  const measureRef = useCallback(
    (key: string) => {
      let ref = refs.current.get(key);
      if (!ref) {
        ref = (el: HTMLElement | null) => {
          const previous = elements.current.get(key);
          if (previous && previous !== el) {
            resizeObserver?.unobserve(previous);
            observed.current.delete(previous);
            elements.current.delete(key);
          }
          if (el) {
            elements.current.set(key, el);
            observed.current.set(el, key);
            resizeObserver?.observe(el);
            const height = Math.round(el.offsetHeight);
            if (height > 0 && sizes.current.get(key) !== height) {
              sizes.current.set(key, height);
              setVersion((v) => v + 1);
            }
          }
        };
        refs.current.set(key, ref);
      }
      return ref;
    },
    [resizeObserver],
  );

  const rows = virtualized
    ? layout.rows.filter((row) => row.start + row.size >= range.top && row.start <= range.bottom)
    : layout.rows;

  return { containerRef: setContainer, total: layout.total, rows, measureRef, virtualized };
}
