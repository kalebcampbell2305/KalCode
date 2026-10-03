// Live Browser page helper. Runs inside untrusted Browser pages at document creation.
// It has no KalCode capability: it only records console/load errors and the element the person
// picks, and KalCode reads that snapshot back with a native script evaluation. Everything it
// reports is page-controlled data and is bounded and sanitized again natively.
(() => {
  if (window.__kalcodeLive) return;
  const MAX_ERRORS = 8;
  const errors = [];
  let total = 0;
  let picking = false;
  let picked = null;
  let box = null;
  let tag = null;
  let hovered = null;

  const clip = (value, limit) => {
    let text;
    try {
      if (typeof value === "string") text = value;
      else if (value && typeof value.message === "string") text = value.message;
      else text = JSON.stringify(value);
    } catch (_) {
      text = String(value);
    }
    return String(text ?? "").slice(0, limit);
  };
  const record = (message) => {
    total += 1;
    errors.push(clip(message, 300));
    if (errors.length > MAX_ERRORS) errors.shift();
  };

  const originalError = console.error;
  console.error = function (...args) {
    try {
      record(args.map((arg) => clip(arg, 220)).join(" "));
    } catch (_) {}
    return originalError.apply(this, args);
  };
  addEventListener(
    "error",
    (event) => {
      const target = event?.target;
      if (target && target !== window && target.tagName) {
        record(`Failed to load ${target.tagName.toLowerCase()} ${clip(target.src || target.href || "", 200)}`);
        return;
      }
      const where = event?.filename ? ` (${String(event.filename).split("/").pop()}:${event.lineno})` : "";
      record(`${clip(event?.message, 240)}${where}`);
    },
    true,
  );
  addEventListener("unhandledrejection", (event) => record(`Unhandled rejection: ${clip(event?.reason, 240)}`));

  const cssEscape = (value) => (window.CSS?.escape ? CSS.escape(value) : String(value).replace(/[^\w-]/g, "\\$&"));
  const selectorFor = (element) => {
    const parts = [];
    let node = element;
    while (node?.nodeType === 1 && parts.length < 5) {
      if (node.id) {
        parts.unshift(`#${cssEscape(node.id)}`);
        break;
      }
      let part = node.localName;
      const testId = node.getAttribute("data-testid");
      if (testId) {
        parts.unshift(`${part}[data-testid="${clip(testId, 80).replace(/"/g, '\\"')}"]`);
        break;
      }
      const classes = Array.from(node.classList)
        .filter((name) => !/^(?:css|sc|jsx|svelte)-/.test(name))
        .slice(0, 2);
      if (classes.length > 0) part += `.${classes.map(cssEscape).join(".")}`;
      const parent = node.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((child) => child.localName === node.localName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(" > ");
  };
  const describe = (element) => ({
    selector: clip(selectorFor(element), 400),
    tag: element.localName,
    text: clip((element.innerText || element.textContent || "").replace(/\s+/g, " ").trim(), 160),
    html: clip(element.outerHTML || "", 1200),
  });

  const place = (element) => {
    if (!box || !element?.getBoundingClientRect) return;
    const rect = element.getBoundingClientRect();
    box.style.transform = `translate(${rect.left}px, ${rect.top}px)`;
    box.style.width = `${rect.width}px`;
    box.style.height = `${rect.height}px`;
    tag.textContent = selectorFor(element).split(" > ").pop() || element.localName;
  };
  const onMove = (event) => {
    if (!picking || event.target === hovered) return;
    hovered = event.target;
    place(hovered);
  };
  const swallow = (event) => {
    if (!picking) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  };
  const onClick = (event) => {
    if (!picking) return;
    swallow(event);
    picked = describe(event.target);
    stop();
  };
  const onKey = (event) => {
    if (picking && event.key === "Escape") {
      swallow(event);
      stop();
    }
  };
  const start = () => {
    if (picking) return;
    picking = true;
    picked = null;
    box = document.createElement("div");
    box.setAttribute("aria-hidden", "true");
    box.style.cssText =
      "position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;box-sizing:border-box;" +
      "border:2px solid #3d8bff;border-radius:4px;background:rgba(61,139,255,.12);" +
      "box-shadow:0 0 0 1px rgba(8,12,20,.6),0 0 18px rgba(61,139,255,.45);transition:all 90ms ease-out;";
    tag = document.createElement("div");
    tag.style.cssText =
      "position:absolute;left:-2px;top:-24px;padding:2px 7px;border-radius:5px;background:#3d8bff;color:#fff;" +
      "font:600 11px/16px ui-monospace,SFMono-Regular,Consolas,monospace;white-space:nowrap;max-width:360px;" +
      "overflow:hidden;text-overflow:ellipsis;";
    box.appendChild(tag);
    (document.body || document.documentElement).appendChild(box);
    addEventListener("mousemove", onMove, true);
    addEventListener("click", onClick, true);
    addEventListener("mousedown", swallow, true);
    addEventListener("mouseup", swallow, true);
    addEventListener("pointerdown", swallow, true);
    addEventListener("pointerup", swallow, true);
    addEventListener("keydown", onKey, true);
  };
  function stop() {
    picking = false;
    hovered = null;
    if (box) box.remove();
    box = null;
    tag = null;
    removeEventListener("mousemove", onMove, true);
    removeEventListener("click", onClick, true);
    removeEventListener("mousedown", swallow, true);
    removeEventListener("mouseup", swallow, true);
    removeEventListener("pointerdown", swallow, true);
    removeEventListener("pointerup", swallow, true);
    removeEventListener("keydown", onKey, true);
  }

  Object.defineProperty(window, "__kalcodeLive", {
    value: Object.freeze({
      snapshot: () => JSON.stringify({ total, errors: errors.slice(), picking, picked }),
      pick: (on) => {
        if (on) start();
        else stop();
        return picking;
      },
      clearPicked: () => {
        picked = null;
      },
    }),
  });
})();
