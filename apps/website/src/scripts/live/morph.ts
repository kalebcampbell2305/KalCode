/**
 * A small keyed DOM morph: patches `from` to look like `to` while keeping existing nodes, so focus,
 * typed input, scroll positions and CSS entrance animations survive a re-render. New nodes animate
 * in (they are new); nodes that persist do not replay their animation.
 */
function syncAttributes(from: Element, to: Element) {
  // `data-keep="style data-place"`: attributes the client sets after rendering (positions) survive.
  const keep = new Set((to.getAttribute("data-keep") ?? "").split(" ").filter(Boolean));
  for (const { name } of [...from.attributes])
    if (!to.hasAttribute(name) && !keep.has(name)) from.removeAttribute(name);
  for (const { name, value } of [...to.attributes])
    if (from.getAttribute(name) !== value) from.setAttribute(name, value);
}

const keyOf = (node: Node) => (node instanceof Element ? node.getAttribute("data-key") : null);

function same(a: Node, b: Node): boolean {
  if (a.nodeType !== b.nodeType) return false;
  if (a instanceof Element && b instanceof Element) return a.tagName === b.tagName && keyOf(a) === keyOf(b);
  return true;
}

export function morph(from: Element, to: Element) {
  syncAttributes(from, to);
  if (from instanceof HTMLInputElement && to instanceof HTMLInputElement) {
    // Never overwrite what someone is typing.
    if (document.activeElement !== from && from.value !== to.value) from.value = to.value;
    return;
  }
  morphChildren(from, to);
}

function morphChildren(from: Element, to: Element) {
  const keyed = new Map<string, Node>();
  for (const child of from.childNodes) {
    const key = keyOf(child);
    if (key) keyed.set(key, child);
  }
  let cursor: Node | null = from.firstChild;
  for (const next of [...to.childNodes]) {
    const key = keyOf(next);
    let match: Node | null = null;
    if (key) {
      match = keyed.get(key) ?? null;
      if (match) keyed.delete(key);
    } else if (cursor && !keyOf(cursor) && same(cursor, next)) {
      match = cursor;
    }
    if (match) {
      if (match !== cursor) from.insertBefore(match, cursor);
      else cursor = cursor.nextSibling;
      if (match instanceof Element && next instanceof Element) morph(match, next);
      else if (match.nodeValue !== next.nodeValue) match.nodeValue = next.nodeValue;
    } else {
      from.insertBefore(next, cursor);
    }
  }
  while (cursor) {
    const after: Node | null = cursor.nextSibling;
    from.removeChild(cursor);
    cursor = after;
  }
  for (const stale of keyed.values()) if (stale.parentNode === from) from.removeChild(stale);
}
