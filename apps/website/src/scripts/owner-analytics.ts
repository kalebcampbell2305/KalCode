/**
 * Owner command center (src/pages/owner/analytics.astro). The shell renders immediately; the two
 * data sources load independently so fast distribution counts never wait on Stripe. All data is
 * written with textContent / DOM nodes, never as HTML. Every number shown comes from
 * /v1/insights/*; motion only animates between real values.
 */
import { compactUsd, milestoneLadder, milestoneProgress } from "../lib/owner-milestones";

const API = "https://api.kalcoded.com";
const REFRESH_MS = 60_000;
const COLORS = ["#4c8dff", "#cf7a30", "#9085e9"] as const;
const PLAN_IDS = ["pro", "max", "max2x"] as const;
type PlanId = (typeof PLAN_IDS)[number];
const PLAN_NAMES: Record<PlanId, string> = { pro: "Pro", max: "MAX", max2x: "MAX 2X" };
type TimeRange = "24h" | "7d" | "30d" | "90d" | "all";
const RANGE_LABEL: Record<TimeRange, string> = {
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  all: "All time",
};
const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

interface Platforms {
  windows: number;
  macos: number;
  unknown: number;
}
interface ActivityEntry {
  at: string;
  kind: "download" | "update_download";
  platform: string;
  arch: string;
  version: string;
  fromVersion: string;
}
interface Distribution {
  generatedAt: string;
  trackingSince: string | null;
  latest: { version: string; publicVersion: string } | null;
  downloads: { today: number; last7d: number; last30d: number; allTime: number; inRange: number; lastHour: number };
  downloadsByPlatform: Platforms;
  updates: { today: number; inRange: number; allTime: number; toLatest: number; lastHour: number };
  updatesByPlatform: Platforms;
  adoption: {
    checks: number;
    versions: { version: string; checks: number; share: number }[];
    latestShare: number | null;
  };
  builds: { version: string; downloads: number; updates: number }[];
  series: { start: string; downloads: number; updates: number }[];
  seriesUnit: "hour" | "day";
  recent: ActivityEntry[];
}
interface Accounts {
  accounts: number;
  activated: number;
  newSince: number;
  everPaid: number;
  firstDesktopToday: number;
  firstDesktopSince: number;
}
interface PlanRevenue {
  subscribers: number;
  monthly: number;
  yearly: number;
  mrrCents: number;
  arrCents: number;
}
interface Cash {
  grossCents: number;
  refundedCents: number;
  netCents: number;
}
interface Revenue {
  activeSubscribers: number;
  mrrCents: number;
  arrCents: number;
  byPlan: Record<PlanId, PlanRevenue>;
  pastDue: number;
  trialing: number;
  scheduledToCancel: number;
  unrecognized: number;
  cash: { thisMonth: Cash; lastMonth: Cash };
  movement: { newSubscriptions: number; cancellations: number; upgrades: number; downgrades: number };
  churn30d: { rate: number | null; canceled: number; startingSubscribers: number };
  series: { day: string; subscribers: number; mrrCents: number; arrCents: number }[];
  trackingSince: string | null;
}

const $ = <T extends Element = HTMLElement>(selector: string, root: ParentNode = document) =>
  root.querySelector(selector) as T | null;
const $$ = <T extends Element = HTMLElement>(selector: string, root: ParentNode = document) =>
  Array.from(root.querySelectorAll(selector)) as T[];

const numberFormat = new Intl.NumberFormat("en-US");
const n = (value: number) => numberFormat.format(Math.round(value));
const usdFormat = (fraction: boolean) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: fraction ? 2 : 0,
    maximumFractionDigits: fraction ? 2 : 0,
  });
const USD2 = usdFormat(true);
const USD0 = usdFormat(false);
const usd = (cents: number, fraction = true) => (fraction ? USD2 : USD0).format(Math.round(cents) / 100);
const plural = (count: number, word: string) => `${n(count)} ${word}${count === 1 ? "" : "s"}`;
const pct = (value: number) => `${(value * 100).toFixed(value > 0 && value < 0.1 ? 1 : 0)}%`;
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const day = (iso: string) => new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
const platformName = (p: string) => (p === "windows" ? "Windows" : p === "macos" ? "macOS" : "Unknown");
function ago(iso: string): string {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 60) return "moments ago";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86_400)} d ago`;
}

let range: TimeRange = "7d";
let timer: ReturnType<typeof setTimeout> | undefined;
let lastLoaded: Date | null = null;
let lastError = false;
let loading = false;
let lastData: { distribution: Distribution | null; accounts: Accounts | null; revenue: Revenue | null } = {
  distribution: null,
  accounts: null,
  revenue: null,
};
const seenActivity = new Set<string>();

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// ---------------------------------------------------------------- counting numbers

type Format = "int" | "usd" | "usd0" | "usdAuto";
const FORMATTERS: Record<Format, (value: number) => string> = {
  int: (v) => n(v),
  usd: (v) => usd(v, true),
  usd0: (v) => usd(v, false),
  // Cents while they matter; whole dollars from $10,000 so big figures stay readable.
  usdAuto: (v) => usd(v, Math.abs(v) < 1_000_000),
};
const shown = new WeakMap<Element, number>();
const running = new WeakMap<Element, number>();

/** Tweens a number from what is on screen to the real value. Never delays anything else. */
function count(key: string, value: number) {
  const node = $(`[data-count="${key}"]`);
  if (!node) return;
  const format = FORMATTERS[(node.dataset.format as Format) ?? "int"] ?? FORMATTERS.int;
  const from = shown.get(node) ?? 0;
  shown.set(node, value);
  // The placeholder shimmer is only ever replaced by a real value.
  node.removeAttribute("data-pending");
  const frame = running.get(node);
  if (frame) cancelAnimationFrame(frame);
  if (REDUCED || from === value) {
    node.textContent = format(value);
    return;
  }
  const start = performance.now();
  const duration = 1100;
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - (1 - t) ** 4;
    node.textContent = format(from + (value - from) * eased);
    if (t < 1) running.set(node, requestAnimationFrame(step));
  };
  running.set(node, requestAnimationFrame(step));
}

function note(key: string, text: string) {
  const node = $(`[data-note="${key}"]`);
  if (node) node.textContent = text;
}

function facts(target: HTMLElement | null, rows: [string, string, string?][]) {
  if (!target) return;
  target.replaceChildren(
    ...rows.map(([label, value, hint]) => {
      const wrap = el("div", "facts__row");
      const dd = el("dd", undefined, value);
      if (hint) dd.append(el("span", "facts__hint", hint));
      wrap.append(el("dt", undefined, label), dd);
      return wrap;
    }),
  );
}

function emptyRow(text: string, columns: number) {
  const row = el("tr");
  const cell = el("td", "table__empty", text);
  cell.colSpan = columns;
  row.append(cell);
  return row;
}

// ---------------------------------------------------------------- atmosphere

function starfield() {
  const canvas = $<HTMLCanvasElement>("[data-stars]");
  const context = canvas?.getContext("2d");
  if (!canvas || !context) return;
  let stars: { x: number; y: number; r: number; a: number; s: number; d: number }[] = [];
  let width = 0;
  let height = 0;
  let px = 0;
  let py = 0;
  const resize = () => {
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    const total = Math.round(Math.min(260, (width * height) / 7000));
    stars = Array.from({ length: total }, () => ({
      x: Math.random() * width,
      y: Math.random() * height,
      r: Math.random() ** 3 * 1.3 + 0.25,
      a: Math.random() * 0.6 + 0.15,
      s: Math.random() * 0.0012 + 0.0003,
      d: Math.random() * 0.6 + 0.2,
    }));
  };
  const draw = (now: number) => {
    context.clearRect(0, 0, width, height);
    for (const star of stars) {
      const twinkle = REDUCED ? 1 : 0.65 + 0.35 * Math.sin(now * star.s + star.x);
      context.globalAlpha = star.a * twinkle;
      context.fillStyle = star.r > 1 ? "#cfe0ff" : "#ffffff";
      context.beginPath();
      context.arc(star.x + px * star.d, star.y + py * star.d, star.r, 0, Math.PI * 2);
      context.fill();
    }
  };
  resize();
  window.addEventListener("resize", resize);
  if (REDUCED) {
    draw(0);
    return;
  }
  window.addEventListener("pointermove", (event) => {
    px = (event.clientX / width - 0.5) * -12;
    py = (event.clientY / height - 0.5) * -8;
  });
  let last = 0;
  const loop = (now: number) => {
    // ~30 fps is plenty for a twinkle; nothing runs while the tab is hidden.
    if (now - last > 33 && document.visibilityState === "visible") {
      draw(now);
      last = now;
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

function mascotTilt() {
  const stage = $("[data-tilt]");
  const hero = stage?.closest<HTMLElement>(".hero");
  if (!stage || !hero || REDUCED) return;
  hero.addEventListener("pointermove", (event) => {
    const box = hero.getBoundingClientRect();
    const x = (event.clientX - box.left) / box.width - 0.5;
    const y = (event.clientY - box.top) / box.height - 0.5;
    stage.style.setProperty("--tilt-y", `${(x * 14).toFixed(2)}deg`);
    stage.style.setProperty("--tilt-x", `${(-y * 10).toFixed(2)}deg`);
    stage.style.setProperty("--shift-x", `${(x * 10).toFixed(1)}px`);
    stage.style.setProperty("--shift-y", `${(y * 6).toFixed(1)}px`);
  });
  hero.addEventListener("pointerleave", () => {
    for (const name of ["--tilt-x", "--tilt-y", "--shift-x", "--shift-y"]) stage.style.removeProperty(name);
  });
}

// ---------------------------------------------------------------- charts (inline SVG, no library)

const SVG = "http://www.w3.org/2000/svg";
function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>) {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

const tooltip = $("[data-tooltip]") as HTMLElement;
function showTip(x: number, y: number, title: string, rows: [string, string, string][]) {
  tooltip.replaceChildren(el("strong", undefined, title));
  for (const [color, label, value] of rows) {
    const row = el("span", "tooltip__row");
    const dot = el("i", "tooltip__dot");
    dot.style.background = color;
    row.append(dot, el("span", undefined, label), el("b", undefined, value));
    tooltip.append(row);
  }
  tooltip.hidden = false;
  const width = tooltip.offsetWidth;
  tooltip.style.left = `${Math.min(window.innerWidth - width - 12, Math.max(12, x + 14))}px`;
  tooltip.style.top = `${Math.max(12, y - tooltip.offsetHeight - 14)}px`;
}
function hideTip() {
  tooltip.hidden = true;
}

interface Series {
  name: string;
  color: string;
  values: number[];
}

/** Round gridlines: a 1/2/5 × 10ⁿ step (never below `minStep`), at most five intervals. */
function niceScale(value: number, minStep: number): { max: number; step: number } {
  const raw = Math.max(minStep, value / 4);
  const exponent = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(minStep, ([1, 2, 5, 10].find((m) => m * exponent >= raw) ?? 10) * exponent);
  return { max: Math.max(step, Math.ceil(value / step) * step), step };
}

/**
 * Monotone cubic path (Fritsch–Carlson): smooth, but never overshoots a real value, so the curve
 * never shows a peak or a dip the data does not have.
 */
function smoothPath(points: [number, number][]): string {
  const count = points.length;
  if (count === 0) return "";
  const first = points[0] as [number, number];
  if (count < 3) return points.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join(" ");
  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < count - 1; i += 1) {
    const a = points[i] as [number, number];
    const b = points[i + 1] as [number, number];
    dx.push(b[0] - a[0]);
    slope.push((b[1] - a[1]) / (b[0] - a[0] || 1));
  }
  const tangent: number[] = [slope[0] as number];
  for (let i = 1; i < count - 1; i += 1) {
    const s0 = slope[i - 1] as number;
    const s1 = slope[i] as number;
    tangent.push(
      s0 * s1 <= 0
        ? 0
        : (3 * ((dx[i - 1] as number) + (dx[i] as number))) /
            ((2 * (dx[i] as number) + (dx[i - 1] as number)) / s0 +
              ((dx[i] as number) + 2 * (dx[i - 1] as number)) / s1),
    );
  }
  tangent.push(slope[count - 2] as number);
  let d = `M${first[0].toFixed(1)},${first[1].toFixed(1)}`;
  for (let i = 0; i < count - 1; i += 1) {
    const a = points[i] as [number, number];
    const b = points[i + 1] as [number, number];
    const h = (dx[i] as number) / 3;
    d += ` C${(a[0] + h).toFixed(1)},${(a[1] + h * (tangent[i] as number)).toFixed(1)} ${(b[0] - h).toFixed(1)},${(b[1] - h * (tangent[i + 1] as number)).toFixed(1)} ${b[0].toFixed(1)},${b[1].toFixed(1)}`;
  }
  return d;
}

const drawn = new Set<string>();

/** Line/area chart with draw-in, crosshair and tooltip. One y-axis. */
function lineChart(
  key: string,
  labels: string[],
  series: Series[],
  format: (value: number) => string,
  empty: string,
  minStep = 1,
) {
  const target = $(`[data-chart="${key}"]`);
  if (!target) return;
  target.replaceChildren();
  const total = series.reduce((sum, s) => sum + s.values.reduce((a, b) => a + b, 0), 0);
  const width = Math.max(300, target.clientWidth || 640);
  const height = target.classList.contains("chart--sm") ? 180 : 250;
  const pad = { top: 16, right: 14, bottom: 28, left: 46 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const scale = niceScale(Math.max(1, ...series.flatMap((s) => s.values)), minStep);
  const count = labels.length;
  const x = (i: number) => pad.left + (count <= 1 ? innerW / 2 : (i * innerW) / (count - 1));
  const y = (v: number) => pad.top + innerH - (v / scale.max) * innerH;
  const root = svg("svg", { viewBox: `0 0 ${width} ${height}`, width: "100%", height, class: "chart__svg" });
  const defs = svg("defs", {});
  root.append(defs);

  for (let value = 0; value <= scale.max + scale.step / 2; value += scale.step) {
    root.append(svg("line", { x1: pad.left, x2: width - pad.right, y1: y(value), y2: y(value), class: "chart__grid" }));
    const label = svg("text", { x: pad.left - 10, y: y(value) + 4, class: "chart__axis", "text-anchor": "end" });
    label.textContent = format(value);
    root.append(label);
  }
  const step = Math.max(1, Math.ceil(count / Math.max(2, Math.floor(innerW / 76))));
  labels.forEach((text, i) => {
    if (i % step !== 0 && i !== count - 1) return;
    const label = svg("text", { x: x(i), y: height - 6, class: "chart__axis", "text-anchor": "middle" });
    label.textContent = text;
    root.append(label);
  });

  const animate = !REDUCED && !drawn.has(`${key}:${range}`);
  drawn.add(`${key}:${range}`);
  const floor = pad.top + innerH;
  series.forEach((s, index) => {
    const points = s.values.map((v, i) => [x(i), y(v)] as [number, number]);
    const path = smoothPath(points);
    const id = `g-${key}-${index}`;
    const gradient = svg("linearGradient", { id, x1: 0, x2: 0, y1: 0, y2: 1 });
    gradient.append(
      svg("stop", { offset: "0%", "stop-color": s.color, "stop-opacity": index === 0 ? 0.34 : 0.14 }),
      svg("stop", { offset: "100%", "stop-color": s.color, "stop-opacity": 0 }),
    );
    defs.append(gradient);
    if (points.length > 1) {
      root.append(
        svg("path", {
          d: `${path} L${x(count - 1)},${floor} L${x(0)},${floor} Z`,
          fill: `url(#${id})`,
          class: animate ? "chart__area" : "",
        }),
      );
    }
    const line = svg("path", { d: path, stroke: s.color, class: `chart__line${animate ? " chart__line--draw" : ""}` });
    root.append(line);
    const last = points.at(-1);
    if (last) root.append(svg("circle", { cx: last[0], cy: last[1], r: 4, fill: s.color, class: "chart__end" }));
    if (animate) {
      requestAnimationFrame(() => {
        const length = Math.ceil(line.getTotalLength?.() ?? 2000);
        line.style.strokeDasharray = String(length);
        line.style.setProperty("--len", String(length));
      });
    }
  });

  const cross = svg("line", { y1: pad.top, y2: floor, class: "chart__cross", visibility: "hidden" });
  const dots = series.map((s) => svg("circle", { r: 5, fill: s.color, class: "chart__dot", visibility: "hidden" }));
  root.append(cross, ...dots);
  const hit = svg("rect", { x: pad.left - 8, y: 0, width: innerW + 16, height, fill: "transparent" });
  hit.addEventListener("pointermove", (event) => {
    const box = root.getBoundingClientRect();
    const px = (event.clientX - box.left) * (width / box.width);
    const i = count <= 1 ? 0 : Math.max(0, Math.min(count - 1, Math.round(((px - pad.left) / innerW) * (count - 1))));
    cross.setAttribute("x1", String(x(i)));
    cross.setAttribute("x2", String(x(i)));
    cross.setAttribute("visibility", "visible");
    dots.forEach((dot, k) => {
      dot.setAttribute("cx", String(x(i)));
      dot.setAttribute("cy", String(y(series[k]?.values[i] ?? 0)));
      dot.setAttribute("visibility", "visible");
    });
    showTip(
      event.clientX,
      event.clientY,
      labels[i] ?? "",
      series.map((s) => [s.color, s.name, format(s.values[i] ?? 0)]),
    );
  });
  hit.addEventListener("pointerleave", () => {
    cross.setAttribute("visibility", "hidden");
    for (const dot of dots) dot.setAttribute("visibility", "hidden");
    hideTip();
  });
  root.append(hit);
  target.append(root);
  if (total === 0) target.append(el("p", "chart__empty", empty));
}

function bars(
  target: HTMLElement | null,
  rows: { label: string; value: number; share: number; color: string; strong?: boolean }[],
  empty: string,
) {
  if (!target) return;
  if (rows.length === 0) {
    target.replaceChildren(el("p", "chart__empty chart__empty--inline", empty));
    return;
  }
  const fills: [HTMLElement, number][] = [];
  target.replaceChildren(
    ...rows.map((row) => {
      const item = el("div", `bar${row.strong ? " bar--strong" : ""}`);
      const head = el("div", "bar__head");
      head.append(el("span", "bar__label", row.label), el("span", "bar__value", `${pct(row.share)} · ${n(row.value)}`));
      const track = el("div", "bar__track");
      const fill = el("div", "bar__fill");
      fill.style.background = row.color;
      fills.push([fill, Math.max(row.share > 0 ? 1.5 : 0, row.share * 100)]);
      track.append(fill);
      item.append(head, track);
      item.addEventListener("pointermove", (e) =>
        showTip(e.clientX, e.clientY, row.label, [
          [row.color, "Share", pct(row.share)],
          [row.color, "Count", n(row.value)],
        ]),
      );
      item.addEventListener("pointerleave", hideTip);
      return item;
    }),
  );
  requestAnimationFrame(() => {
    for (const [fill, width] of fills) fill.style.width = `${width}%`;
  });
}

// ---------------------------------------------------------------- hero and milestones

function renderHero(r: Revenue) {
  const arrUsd = r.arrCents / 100;
  count("arr", r.arrCents);
  const goal = milestoneProgress(arrUsd);
  $("[data-goal]")?.removeAttribute("data-pending");
  const set = (selector: string, text: string) => {
    const node = $(selector);
    if (node) node.textContent = text;
  };
  set("[data-goal-next]", compactUsd(goal.next));
  set("[data-goal-left]", usd(goal.remaining * 100, false));
  set("[data-goal-from]", goal.reached ? compactUsd(goal.reached) : "$0");
  set("[data-goal-to]", compactUsd(goal.next));
  set("[data-goal-pct]", pct(goal.progress));
  const fill = $("[data-goal-fill]");
  if (fill) requestAnimationFrame(() => (fill.style.width = `${(goal.progress * 100).toFixed(2)}%`));
  $("[data-goal-track]")?.setAttribute("aria-valuenow", (goal.progress * 100).toFixed(0));

  const ladder = milestoneLadder(arrUsd);
  const list = $("[data-ladder]");
  if (list) {
    list.style.setProperty("--count", String(ladder.length));
    list.replaceChildren(
      ...ladder.map((value, i) => {
        const reached = arrUsd >= value;
        const next = i === goal.nextIndex;
        const item = el("li", `rung${reached ? " rung--reached" : ""}${next ? " rung--next" : ""}`);
        item.append(
          el("span", "rung__dot"),
          el("span", "rung__value", compactUsd(value)),
          el("span", "rung__state", reached ? "Reached" : next ? `${pct(goal.progress)}` : ""),
        );
        return item;
      }),
    );
    // Fill between rung centres: reached rungs plus the share of the way to the next one.
    const position = goal.nextIndex === 0 ? 0 : goal.nextIndex - 1 + goal.progress;
    const fraction = ladder.length > 1 ? position / (ladder.length - 1) : 0;
    requestAnimationFrame(() =>
      list.style.setProperty(
        "--ladder-fill",
        `calc(${(fraction * 100).toFixed(3)}% - ${(fraction * 100) / ladder.length}%)`,
      ),
    );
  }
  const reachedCount = ladder.filter((value) => arrUsd >= value).length;
  set(
    "[data-ladder-summary]",
    reachedCount === 0
      ? `First milestone: ${compactUsd(goal.next)} ARR`
      : `${plural(reachedCount, "milestone")} reached · next ${compactUsd(goal.next)}`,
  );
}

// ---------------------------------------------------------------- pulse (live strip)

function renderPulse() {
  const list = $("[data-pulse]");
  const d = lastData.distribution;
  if (!list || !d) return;
  const items: [string, string][] = [
    [n(d.downloads.today), ` download${d.downloads.today === 1 ? "" : "s"} today`],
    [n(lastData.accounts?.firstDesktopToday ?? 0), " new desktop installs today"],
    [n(d.updates.today), ` update${d.updates.today === 1 ? "" : "s"} delivered today`],
  ];
  const r = lastData.revenue;
  if (r)
    items.push([n(r.movement.upgrades), ` upgrade${r.movement.upgrades === 1 ? "" : "s"} · ${range.toUpperCase()}`]);
  const latest = d.recent[0];
  if (latest) {
    const what = latest.kind === "download" ? `${platformName(latest.platform)} download` : "Update delivered";
    items.push([what, ` ${ago(latest.at)}`]);
  }
  list.replaceChildren(
    ...items.map(([strong, rest], i) => {
      const item = el("li");
      item.style.animationDelay = `${i * 60}ms`;
      item.append(el("strong", undefined, strong), document.createTextNode(rest));
      return item;
    }),
  );
}

// ---------------------------------------------------------------- distribution

function renderDistribution(d: Distribution, accounts: Accounts | null) {
  count("downloadsToday", d.downloads.today);
  count("downloadsAll", d.downloads.allTime);
  note("downloadsToday", `${plural(d.downloads.lastHour, "download")} in the last hour`);
  note(
    "downloadsAll",
    d.trackingSince
      ? `Counting since ${day(`${d.trackingSince}T12:00:00Z`)}`
      : "Counting starts with the next download",
  );

  const labels = d.series.map((b) => (d.seriesUnit === "hour" ? time(b.start) : day(b.start)));
  lineChart(
    "distribution",
    labels,
    [
      { name: "Downloads", color: COLORS[0], values: d.series.map((b) => b.downloads) },
      { name: "Updates", color: COLORS[1], values: d.series.map((b) => b.updates) },
    ],
    (v) => n(v),
    "No downloads or updates in this range yet.",
  );
  const table = $("[data-table=distribution]");
  if (table) {
    const head = el("tr");
    head.append(
      el("th", undefined, d.seriesUnit === "hour" ? "Hour" : "Day"),
      el("th", undefined, "Downloads"),
      el("th", undefined, "Updates"),
    );
    table.replaceChildren(
      head,
      ...d.series.map((b, i) => {
        const row = el("tr");
        row.append(
          el("td", undefined, labels[i] ?? ""),
          el("td", undefined, n(b.downloads)),
          el("td", undefined, n(b.updates)),
        );
        return row;
      }),
    );
  }

  const latest = d.latest?.publicVersion ?? null;
  const share = d.adoption.latestShare;
  const ringValue = $("[data-ring-value]");
  if (ringValue) ringValue.textContent = share === null ? "—" : pct(share);
  const ringCaption = $("[data-ring-caption]");
  if (ringCaption) ringCaption.textContent = latest ? `on ${latest}` : "on latest";
  const ring = $<SVGCircleElement>("[data-ring-fg]");
  if (ring) requestAnimationFrame(() => (ring.style.strokeDashoffset = String(314.16 * (1 - (share ?? 0)))));
  bars(
    $("[data-adoption]"),
    d.adoption.versions.slice(0, 5).map((v) => ({
      label: v.version === latest ? `${v.version} · latest` : v.version,
      value: v.checks,
      share: v.share,
      color: v.version === latest ? COLORS[0] : "#5b6880",
      strong: v.version === latest,
    })),
    "No update checks in the last two days yet.",
  );
  facts($("[data-adoption-facts]"), [
    ["Latest public version", latest ?? "—"],
    ["Latest internal build", d.latest?.version ?? "—"],
    ["Updates to latest", n(d.updates.toLatest), "update downloads, all time"],
    ["Update checks", n(d.adoption.checks), "last two days · launch + every 6 h"],
  ]);

  const split = $("[data-split]");
  if (split) {
    const group = (title: string, counts: Platforms) => {
      const total = counts.windows + counts.macos + counts.unknown;
      const wrap = el("div", "split__group");
      wrap.append(el("h4", undefined, `${title} · ${n(total)}`));
      const holder = el("div");
      bars(
        holder,
        total === 0
          ? []
          : (["windows", "macos"] as const).map((p, i) => ({
              label: platformName(p),
              value: counts[p],
              share: counts[p] / total,
              color: COLORS[i] as string,
            })),
        "None in this range.",
      );
      wrap.append(holder);
      return wrap;
    };
    split.replaceChildren(group("Downloads", d.downloadsByPlatform), group("Updates delivered", d.updatesByPlatform));
  }

  const builds = $("[data-builds] tbody");
  if (builds) {
    builds.replaceChildren(
      ...(d.builds.length
        ? d.builds.map((b) => {
            const row = el("tr");
            row.append(
              el("td", "mono", b.version),
              el("td", undefined, n(b.downloads)),
              el("td", undefined, n(b.updates)),
            );
            return row;
          })
        : [emptyRow("No builds counted yet.", 3)]),
    );
  }

  if (accounts) {
    facts($("[data-accounts]"), [
      ["New desktop installs", n(accounts.firstDesktopSince), "first desktop sign-in per account"],
      ["Installs today", n(accounts.firstDesktopToday)],
      ["Updates delivered", n(d.updates.inRange), `${n(d.updates.allTime)} all time`],
      ["Accounts", n(accounts.accounts), `${n(accounts.newSince)} new in range`],
      [
        "Free → paid",
        accounts.activated ? pct(accounts.everPaid / accounts.activated) : "—",
        `${n(accounts.everPaid)} of ${n(accounts.activated)} ever paid`,
      ],
    ]);
  }

  const feed = $("[data-feed]");
  if (feed) {
    const first = seenActivity.size === 0;
    feed.replaceChildren(
      ...(d.recent.length
        ? d.recent.map((e) => {
            const key = `${e.at}|${e.kind}|${e.version}|${e.platform}`;
            const fresh = !first && !seenActivity.has(key);
            seenActivity.add(key);
            const item = el(
              "li",
              `feed__item feed__item--${e.kind === "download" ? "download" : "update"}${fresh ? " feed__item--new" : ""}`,
            );
            const what =
              e.kind === "download"
                ? `${platformName(e.platform)} download started`
                : `Update delivered · ${e.fromVersion} → ${e.version}`;
            const stamp = el("time", "feed__time", time(e.at));
            stamp.setAttribute("datetime", e.at);
            item.append(
              stamp,
              el("span", "feed__what", what),
              el("span", "feed__meta", e.kind === "download" ? e.version : platformName(e.platform)),
            );
            return item;
          })
        : [el("li", "feed__empty", "No activity yet. Downloads and updates appear here as they happen.")]),
    );
  }
}

// ---------------------------------------------------------------- revenue

function renderRevenue(r: Revenue) {
  renderHero(r);
  count("mrr", r.mrrCents);
  count("cash", r.cash.thisMonth.netCents);
  count("subscribers", r.activeSubscribers);
  note(
    "cash",
    r.cash.thisMonth.refundedCents
      ? `${usd(r.cash.thisMonth.grossCents)} charged · ${usd(r.cash.thisMonth.refundedCents)} refunded`
      : "Cash collected, net of refunds",
  );
  note("subscribers", r.pastDue ? `${n(r.pastDue)} past due (not counted)` : "Active · paid · live mode");

  const totalMrr = PLAN_IDS.reduce((sum, id) => sum + (r.byPlan[id]?.mrrCents ?? 0), 0);
  for (const id of PLAN_IDS) {
    const card = $(`[data-plan="${id}"]`);
    const plan = r.byPlan[id];
    if (!card || !plan) continue;
    const set = (field: string, value: string) => {
      const cell = $(`[data-f="${field}"]`, card);
      if (cell) cell.textContent = value;
    };
    set("subscribers", n(plan.subscribers));
    set("monthly", n(plan.monthly));
    set("yearly", n(plan.yearly));
    set("mrr", usd(plan.mrrCents));
    set("arr", usd(plan.arrCents, false));
    const share = $<HTMLElement>('[data-f="share"]', card);
    if (share) requestAnimationFrame(() => (share.style.width = `${totalMrr ? (plan.mrrCents / totalMrr) * 100 : 0}%`));
  }
  const bar = $("[data-plan-bar]");
  if (bar) {
    bar.replaceChildren(
      ...(totalMrr === 0
        ? [el("div", "stackbar__empty", "NO RECURRING REVENUE YET")]
        : PLAN_IDS.filter((id) => (r.byPlan[id]?.mrrCents ?? 0) > 0).map((id) => {
            const seg = el("div", "stackbar__seg");
            const value = r.byPlan[id]?.mrrCents ?? 0;
            const color = COLORS[PLAN_IDS.indexOf(id)] as string;
            seg.style.flexGrow = String(value);
            seg.style.background = color;
            seg.addEventListener("pointermove", (e) =>
              showTip(e.clientX, e.clientY, PLAN_NAMES[id], [
                [color, "MRR", `${usd(value)} · ${pct(value / totalMrr)}`],
              ]),
            );
            seg.addEventListener("pointerleave", hideTip);
            return seg;
          })),
    );
  }

  const cash = $("[data-cash]");
  if (cash) {
    const period = (label: string, c: Cash, now: boolean) => {
      const box = el("div", `cash__period${now ? " cash__period--now" : ""}`);
      box.append(
        el("span", "cash__label", label),
        el("strong", "cash__value", usd(c.netCents)),
        el("span", "cash__detail", `${usd(c.grossCents)} charged · ${usd(c.refundedCents)} refunded`),
      );
      return box;
    };
    cash.replaceChildren(period("This month", r.cash.thisMonth, true), period("Last month", r.cash.lastMonth, false));
  }

  facts($("[data-movement]"), [
    ["New paid subscriptions", n(r.movement.newSubscriptions)],
    ["Upgrades", n(r.movement.upgrades)],
    ["Downgrades", n(r.movement.downgrades)],
    ["Cancellations", n(r.movement.cancellations)],
    [
      "Churn · 30 days",
      r.churn30d.rate === null ? "—" : pct(r.churn30d.rate),
      r.churn30d.rate === null
        ? "not enough subscribers yet"
        : `${n(r.churn30d.canceled)} of ${n(r.churn30d.startingSubscribers)}`,
    ],
    ["Scheduled to cancel", n(r.scheduledToCancel), "still paid until period end"],
    ...(r.pastDue || r.trialing
      ? ([["Past due · trialing", `${n(r.pastDue)} · ${n(r.trialing)}`, "not counted in MRR"]] as [
          string,
          string,
          string,
        ][])
      : []),
  ]);

  const since = r.trackingSince ? `Daily since ${day(`${r.trackingSince}T12:00:00Z`)}` : "";
  for (const node of $$("[data-since]")) node.textContent = since;
  const labels = r.series.map((p) => day(`${p.day}T12:00:00Z`));
  lineChart(
    "mrr",
    labels,
    [{ name: "MRR", color: COLORS[0], values: r.series.map((p) => p.mrrCents) }],
    (v) => usd(v, false),
    "No recurring revenue yet.",
    100,
  );
  lineChart(
    "subscribers",
    labels,
    [{ name: "Paid subscribers", color: COLORS[2], values: r.series.map((p) => p.subscribers) }],
    (v) => n(v),
    "No paid subscribers yet.",
  );
}

// ---------------------------------------------------------------- loading and live state

type Gate = "loading" | "signed-out" | "forbidden" | "error" | "open";
let gateState: Gate = "loading";
function gate(state: Gate, message?: string) {
  gateState = state;
  const section = $("[data-gate]");
  const content = $("[data-content]");
  const controls = $("[data-controls]");
  if (!section || !content || !controls) return;
  section.dataset.gate = state;
  section.hidden = state === "open";
  content.hidden = state !== "open";
  controls.hidden = state !== "open";
  const title = $("[data-gate-title]", section);
  const text = $("[data-gate-text]", section);
  const link = $("[data-gate-link]", section);
  const spinner = $("[data-gate-spinner]", section);
  if (spinner) spinner.hidden = state !== "loading";
  if (link) link.hidden = state !== "signed-out";
  const copy: Record<Exclude<Gate, "open">, [string, string]> = {
    loading: ["Checking owner access…", "One moment."],
    "signed-out": [
      "Owner sign-in required",
      "Sign in to your KalCode account on this browser, then come back to this page.",
    ],
    forbidden: ["Not available", "This page is not available for this account."],
    error: ["Could not load", message ?? "The analytics service did not answer. Try again in a moment."],
  };
  if (state !== "open" && title && text) {
    title.textContent = copy[state][0];
    text.textContent = copy[state][1];
  }
}

/** LIVE only while the data really is fresh: a successful load within two refresh periods. */
function liveState() {
  const badge = $("[data-live]");
  const label = $("[data-live-label]");
  if (!badge || !label) return;
  const fresh = lastLoaded !== null && Date.now() - lastLoaded.getTime() < REFRESH_MS * 2 && !lastError;
  // Never "Connecting" once the gate has answered (signed out, forbidden or unreachable).
  const idle = lastLoaded === null ? (gateState === "loading" ? "connecting" : "offline") : null;
  const state = document.visibilityState !== "visible" ? "paused" : (idle ?? (fresh ? "live" : "stale"));
  badge.dataset.state = state;
  label.textContent = {
    live: "Live",
    stale: "Reconnecting",
    paused: "Paused",
    connecting: "Connecting",
    offline: "Not connected",
  }[state];
  const updated = $("[data-updated]");
  if (updated && lastLoaded) {
    updated.textContent = `Updated ${lastLoaded.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}`;
  }
}

/** Resolves with status 0 when the request never reached the API, so no call can reject unawaited. */
async function call(path: string): Promise<{ status: number; body: unknown }> {
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, { credentials: "include", headers: { accept: "application/json" } });
  } catch {
    return { status: 0, body: null };
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

async function load(fresh = false) {
  if (loading) return;
  loading = true;
  document.body.classList.add("is-loading");
  const query = `?range=${range}&tz=${new Date().getTimezoneOffset()}${fresh ? "&fresh=1" : ""}`;
  for (const node of $$("[data-range-label]")) node.textContent = RANGE_LABEL[range];
  const distribution = call(`/v1/insights/distribution${query}`);
  const revenue = call(`/v1/insights/revenue${query}`);
  try {
    const d = await distribution;
    if (d.status === 401) return gate("signed-out");
    if (d.status === 403) return gate("forbidden");
    if (d.status !== 200) {
      lastError = true;
      if (!lastLoaded) gate("error");
      return;
    }
    const body = d.body as { distribution: Distribution | null; accounts: Accounts | null };
    gate("open");
    lastData = { ...lastData, distribution: body.distribution, accounts: body.accounts };
    if (body.distribution) renderDistribution(body.distribution, body.accounts);
    lastLoaded = new Date();
    lastError = !body.distribution;
    renderPulse();
    liveState();

    const r = await revenue;
    const error = $("[data-revenue-error]");
    const sections = $$("[data-revenue]");
    if (r.status === 200) {
      if (error) error.hidden = true;
      lastData.revenue = (r.body as { revenue: Revenue }).revenue;
      for (const node of sections) node.classList.remove("is-stale");
      renderRevenue(lastData.revenue);
      renderPulse();
    } else if (error) {
      error.hidden = false;
      error.textContent =
        (r.body as { message?: string } | null)?.message ??
        "Revenue is unavailable right now. Nothing is shown rather than guessed.";
      for (const node of sections) node.classList.add("is-stale");
    }
  } catch {
    lastError = true;
    if (!lastLoaded) gate("error");
  } finally {
    loading = false;
    document.body.classList.remove("is-loading");
    liveState();
    schedule();
  }
}

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (document.visibilityState === "visible") void load();
    else schedule();
  }, REFRESH_MS);
}

for (const button of $$<HTMLButtonElement>("[data-range]")) {
  button.addEventListener("click", () => {
    range = button.dataset.range as TimeRange;
    for (const other of $$<HTMLButtonElement>("[data-range]"))
      other.setAttribute("aria-checked", String(other === button));
    void load();
  });
}
$("[data-refresh]")?.addEventListener("click", () => void load(true));
document.addEventListener("visibilitychange", () => {
  liveState();
  if (document.visibilityState === "visible" && lastLoaded && Date.now() - lastLoaded.getTime() > REFRESH_MS)
    void load();
});
// Relative times ("moments ago") and the LIVE badge stay truthful between loads.
setInterval(() => {
  liveState();
  renderPulse();
}, 15_000);
let resizeTimer: ReturnType<typeof setTimeout> | undefined;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  // Charts are sized to their panels: redraw from the data already loaded, no refetch.
  resizeTimer = setTimeout(() => {
    if (lastData.distribution) renderDistribution(lastData.distribution, lastData.accounts);
    if (lastData.revenue) renderRevenue(lastData.revenue);
  }, 200);
});

starfield();
mascotTilt();
void load();
