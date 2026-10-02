/**
 * Owner command center (src/pages/owner/analytics.astro). The shell renders immediately; the two
 * data sources load independently so fast distribution counts never wait on Stripe. All data is
 * written with textContent / DOM nodes, never as HTML.
 */

const API = "https://api.kalcoded.com";
const REFRESH_MS = 60_000;
const COLORS = ["#4c8dff", "#cf7a30", "#9085e9"] as const;
const PLAN_IDS = ["pro", "max", "max2x"] as const;
const PLAN_NAMES: Record<(typeof PLAN_IDS)[number], string> = { pro: "Pro", max: "MAX", max2x: "MAX 2X" };
type TimeRange = "24h" | "7d" | "30d" | "90d" | "all";
const RANGE_LABEL: Record<TimeRange, string> = {
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  all: "All time",
};

interface Platforms {
  windows: number;
  macos: number;
  unknown: number;
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
  recent: {
    at: string;
    kind: "download" | "update_download";
    platform: string;
    arch: string;
    version: string;
    fromVersion: string;
  }[];
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
  byPlan: Record<(typeof PLAN_IDS)[number], PlanRevenue>;
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
const n = (value: number) => numberFormat.format(value);
const usd = (cents: number, fraction = true) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: fraction ? 2 : 0,
    maximumFractionDigits: fraction ? 2 : 0,
  }).format(Math.round(cents) / 100);
const plural = (count: number, word: string) => `${n(count)} ${word}${count === 1 ? "" : "s"}`;
const pct = (value: number) => `${(value * 100).toFixed(value > 0 && value < 0.1 ? 1 : 0)}%`;
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const day = (iso: string) => new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
const platformName = (p: string) => (p === "windows" ? "Windows" : p === "macos" ? "macOS" : "Unknown");

let range: TimeRange = "7d";
let timer: ReturnType<typeof setTimeout> | undefined;
let lastLoaded: Date | null = null;
let loading = false;
let lastData: { distribution: Distribution | null; accounts: Accounts | null; revenue: Revenue | null } = {
  distribution: null,
  accounts: null,
  revenue: null,
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function emptyRow(text: string, columns: number) {
  const row = el("tr");
  const cell = el("td", "table__empty", text);
  cell.colSpan = columns;
  row.append(cell);
  return row;
}

function setKpi(key: string, value: string, note?: string) {
  const card = $(`[data-kpi="${key}"]`);
  if (!card) return;
  const valueNode = $(".kpi__value", card);
  if (valueNode && valueNode.textContent !== value) {
    valueNode.textContent = value;
    card.classList.remove("kpi--fresh");
    void card.offsetWidth;
    card.classList.add("kpi--fresh");
  }
  const noteNode = $("[data-note]", card);
  if (noteNode && note !== undefined) noteNode.textContent = note;
  card.classList.remove("kpi--loading");
}

function facts(target: HTMLElement | null, rows: [string, string, string?][]) {
  if (!target) return;
  target.replaceChildren(
    ...rows.flatMap(([label, value, hint]) => {
      const wrap = el("div", "facts__row");
      const dt = el("dt", undefined, label);
      const dd = el("dd", undefined, value);
      if (hint) dd.append(el("span", "facts__hint", hint));
      wrap.append(dt, dd);
      return [wrap];
    }),
  );
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
  const { innerWidth } = window;
  const width = tooltip.offsetWidth;
  tooltip.style.left = `${Math.min(innerWidth - width - 12, Math.max(12, x + 14))}px`;
  tooltip.style.top = `${Math.max(12, y - tooltip.offsetHeight - 12)}px`;
}
function hideTip() {
  tooltip.hidden = true;
}

interface Series {
  name: string;
  color: string;
  values: number[];
}

/** Line chart with a soft area under the first series, crosshair and tooltip. One y-axis. */
function lineChart(
  target: HTMLElement | null,
  labels: string[],
  series: Series[],
  format: (value: number) => string,
  empty: string,
  minStep = 1,
) {
  if (!target) return;
  target.replaceChildren();
  const total = series.reduce((sum, s) => sum + s.values.reduce((a, b) => a + b, 0), 0);
  const width = Math.max(320, target.clientWidth || 640);
  const height = target.classList.contains("chart--sm") ? 170 : 230;
  const pad = { top: 14, right: 12, bottom: 26, left: 44 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const scale = niceScale(max, minStep);
  const nice = scale.max;
  const count = labels.length;
  const x = (i: number) => pad.left + (count <= 1 ? innerW / 2 : (i * innerW) / (count - 1));
  const y = (v: number) => pad.top + innerH - (v / nice) * innerH;
  const root = svg("svg", { viewBox: `0 0 ${width} ${height}`, width: "100%", height, class: "chart__svg" });

  const gradientId = `g${Math.random().toString(36).slice(2, 8)}`;
  const defs = svg("defs", {});
  const gradient = svg("linearGradient", { id: gradientId, x1: 0, x2: 0, y1: 0, y2: 1 });
  gradient.append(
    svg("stop", { offset: "0%", "stop-color": series[0]?.color ?? COLORS[0], "stop-opacity": 0.28 }),
    svg("stop", { offset: "100%", "stop-color": series[0]?.color ?? COLORS[0], "stop-opacity": 0 }),
  );
  defs.append(gradient);
  root.append(defs);

  for (let value = 0; value <= nice + scale.step / 2; value += scale.step) {
    root.append(svg("line", { x1: pad.left, x2: width - pad.right, y1: y(value), y2: y(value), class: "chart__grid" }));
    const label = svg("text", { x: pad.left - 8, y: y(value) + 4, class: "chart__axis", "text-anchor": "end" });
    label.textContent = format(value);
    root.append(label);
  }
  const step = Math.max(1, Math.ceil(count / Math.max(2, Math.floor(innerW / 72))));
  labels.forEach((text, i) => {
    if (i % step !== 0 && i !== count - 1) return;
    const label = svg("text", { x: x(i), y: height - 6, class: "chart__axis", "text-anchor": "middle" });
    label.textContent = text;
    root.append(label);
  });

  series.forEach((s, index) => {
    const points = s.values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
    if (index === 0 && points.length > 1) {
      root.append(
        svg("path", {
          d: `M${x(0)},${y(0)} L${points.join(" L")} L${x(count - 1)},${y(0)} Z`,
          fill: `url(#${gradientId})`,
          class: "chart__area",
        }),
      );
    }
    root.append(svg("polyline", { points: points.join(" "), stroke: s.color, class: "chart__line" }));
    if (count === 1) root.append(svg("circle", { cx: x(0), cy: y(s.values[0] ?? 0), r: 4, fill: s.color }));
  });

  const cross = svg("line", { y1: pad.top, y2: pad.top + innerH, class: "chart__cross", visibility: "hidden" });
  const dots = series.map((s) => svg("circle", { r: 4.5, fill: s.color, class: "chart__dot", visibility: "hidden" }));
  root.append(cross, ...dots);
  const hit = svg("rect", { x: pad.left, y: pad.top, width: innerW, height: innerH, fill: "transparent" });
  const move = (event: PointerEvent) => {
    const box = root.getBoundingClientRect();
    const scale = width / box.width;
    const px = (event.clientX - box.left) * scale;
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
  };
  hit.addEventListener("pointermove", move);
  hit.addEventListener("pointerleave", () => {
    cross.setAttribute("visibility", "hidden");
    for (const dot of dots) dot.setAttribute("visibility", "hidden");
    hideTip();
  });
  root.append(hit);
  target.append(root);
  if (total === 0) target.append(el("p", "chart__empty", empty));
}

/** Round gridlines: a 1/2/5 × 10ⁿ step (never below `minStep`), at most five intervals. */
function niceScale(value: number, minStep: number): { max: number; step: number } {
  const raw = Math.max(minStep, value / 4);
  const exponent = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(minStep, ([1, 2, 5, 10].find((m) => m * exponent >= raw) ?? 10) * exponent);
  return { max: Math.max(step, Math.ceil(value / step) * step), step };
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
  target.replaceChildren(
    ...rows.map((row) => {
      const item = el("div", `bar${row.strong ? " bar--strong" : ""}`);
      const head = el("div", "bar__head");
      head.append(el("span", "bar__label", row.label), el("span", "bar__value", `${pct(row.share)} · ${n(row.value)}`));
      const track = el("div", "bar__track");
      const fill = el("div", "bar__fill");
      fill.style.background = row.color;
      fill.style.width = `${Math.max(row.share > 0 ? 1.5 : 0, row.share * 100)}%`;
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
}

// ---------------------------------------------------------------- rendering

function renderDistribution(d: Distribution, accounts: Accounts | null) {
  const since = d.trackingSince
    ? `Counting since ${day(`${d.trackingSince}T12:00:00Z`)}`
    : "Counting starts with the next download";
  setKpi("downloads.today", n(d.downloads.today), `${n(d.downloads.lastHour)} in the last hour`);
  setKpi("downloads.last7d", n(d.downloads.last7d));
  setKpi("downloads.last30d", n(d.downloads.last30d));
  setKpi("downloads.allTime", n(d.downloads.allTime), since);
  setKpi(
    "activity.lastHour",
    n(d.downloads.lastHour + d.updates.lastHour),
    `${plural(d.downloads.lastHour, "download")} · ${plural(d.updates.lastHour, "update")}`,
  );
  setKpi("updates.inRange", n(d.updates.inRange), `${RANGE_LABEL[range]} · ${n(d.updates.allTime)} all time`);
  if (accounts) setKpi("installs.today", n(accounts.firstDesktopToday));

  const labels = d.series.map((b) => (d.seriesUnit === "hour" ? time(b.start) : day(b.start)));
  lineChart(
    $("[data-chart=distribution]"),
    labels,
    [
      { name: "Downloads", color: COLORS[0], values: d.series.map((b) => b.downloads) },
      { name: "Updates", color: COLORS[1], values: d.series.map((b) => b.updates) },
    ],
    (v) => n(Math.round(v)),
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
  bars(
    $("[data-adoption]"),
    d.adoption.versions.slice(0, 6).map((v) => ({
      label: v.version === latest ? `${v.version} · latest` : v.version,
      value: v.checks,
      share: v.share,
      color: v.version === latest ? COLORS[0] : "#5b6880",
      strong: v.version === latest,
    })),
    "No update checks in the last two days yet.",
  );
  const hint = $("[data-adoption-hint]");
  if (hint) hint.textContent = d.adoption.latestShare === null ? "" : `${pct(d.adoption.latestShare)} on latest`;
  facts($("[data-adoption-facts]"), [
    ["Latest public version", latest ?? "—"],
    ["Latest internal build", d.latest?.version ?? "—"],
    ["Updates to latest", n(d.updates.toLatest), "update downloads, all time"],
    ["Update checks", n(d.adoption.checks), "last two days"],
  ]);

  const split = $("[data-split]");
  if (split) {
    const group = (title: string, counts: Platforms) => {
      const total = counts.windows + counts.macos + counts.unknown;
      const wrap = el("div", "split__group");
      wrap.append(el("h3", undefined, `${title} · ${n(total)}`));
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
    split.replaceChildren(group("Downloads", d.downloadsByPlatform), group("Updates", d.updatesByPlatform));
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
      ["Accounts", n(accounts.accounts)],
      ["New accounts", n(accounts.newSince), RANGE_LABEL[range].toLowerCase()],
      ["First desktop sign-ins", n(accounts.firstDesktopSince), RANGE_LABEL[range].toLowerCase()],
      [
        "Free → paid",
        accounts.activated ? pct(accounts.everPaid / accounts.activated) : "—",
        `${n(accounts.everPaid)} of ${n(accounts.activated)} ever paid`,
      ],
    ]);
  }

  const feed = $("[data-feed]");
  if (feed) {
    feed.replaceChildren(
      ...(d.recent.length
        ? d.recent.map((e) => {
            const item = el("li", `feed__item feed__item--${e.kind === "download" ? "download" : "update"}`);
            const what =
              e.kind === "download"
                ? `${platformName(e.platform)} download started`
                : `Update downloaded · ${e.fromVersion} → ${e.version}`;
            item.append(
              el("time", "feed__time", time(e.at)),
              el("span", "feed__what", what),
              el("span", "feed__meta", e.kind === "download" ? e.version : platformName(e.platform)),
            );
            item.querySelector("time")?.setAttribute("datetime", e.at);
            return item;
          })
        : [el("li", "feed__empty", "No activity yet. Downloads and updates appear here as they happen.")]),
    );
  }
}

function renderRevenue(r: Revenue) {
  setKpi(
    "revenue.subscribers",
    n(r.activeSubscribers),
    r.pastDue ? `${n(r.pastDue)} past due (not counted)` : "Active, paid, live mode",
  );
  setKpi("revenue.mrr", usd(r.mrrCents));
  setKpi("revenue.arr", usd(r.arrCents));
  setKpi(
    "revenue.cash",
    usd(r.cash.thisMonth.netCents),
    r.cash.thisMonth.refundedCents
      ? `${usd(r.cash.thisMonth.grossCents)} charged · ${usd(r.cash.thisMonth.refundedCents)} refunded`
      : "Succeeded charges, net of refunds",
  );

  for (const id of PLAN_IDS) {
    const row = $(`[data-plan="${id}"]`);
    const plan = r.byPlan[id];
    if (!row || !plan) continue;
    const set = (field: string, value: string) => {
      const cell = $(`[data-f="${field}"]`, row);
      if (cell) cell.textContent = value;
    };
    set("subscribers", n(plan.subscribers));
    set("monthly", n(plan.monthly));
    set("yearly", n(plan.yearly));
    set("mrr", usd(plan.mrrCents));
    set("arr", usd(plan.arrCents));
  }
  const bar = $("[data-plan-bar]");
  if (bar) {
    const total = PLAN_IDS.reduce((sum, id) => sum + (r.byPlan[id]?.mrrCents ?? 0), 0);
    bar.replaceChildren(
      ...(total === 0
        ? [el("div", "stackbar__empty", "No recurring revenue yet")]
        : PLAN_IDS.filter((id) => (r.byPlan[id]?.mrrCents ?? 0) > 0).map((id) => {
            const seg = el("div", "stackbar__seg");
            const value = r.byPlan[id]?.mrrCents ?? 0;
            seg.style.flexGrow = String(value);
            seg.style.background = COLORS[PLAN_IDS.indexOf(id)] as string;
            seg.addEventListener("pointermove", (e) =>
              showTip(e.clientX, e.clientY, PLAN_NAMES[id], [
                [COLORS[PLAN_IDS.indexOf(id)] as string, "MRR", `${usd(value)} · ${pct(value / total)}`],
              ]),
            );
            seg.addEventListener("pointerleave", hideTip);
            return seg;
          })),
    );
  }

  facts($("[data-cash]"), [
    [
      "This month",
      usd(r.cash.thisMonth.netCents),
      `${usd(r.cash.thisMonth.grossCents)} charged · ${usd(r.cash.thisMonth.refundedCents)} refunded`,
    ],
    [
      "Last month",
      usd(r.cash.lastMonth.netCents),
      `${usd(r.cash.lastMonth.grossCents)} charged · ${usd(r.cash.lastMonth.refundedCents)} refunded`,
    ],
  ]);

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
    $("[data-chart=mrr]"),
    labels,
    [{ name: "MRR", color: COLORS[0], values: r.series.map((p) => p.mrrCents) }],
    (v) => usd(v, false),
    "No recurring revenue yet.",
    100,
  );
  lineChart(
    $("[data-chart=subscribers]"),
    labels,
    [{ name: "Paid subscribers", color: COLORS[2], values: r.series.map((p) => p.subscribers) }],
    (v) => n(Math.round(v)),
    "No paid subscribers yet.",
  );
}

// ---------------------------------------------------------------- loading

type Gate = "loading" | "signed-out" | "forbidden" | "error" | "open";
function gate(state: Gate, message?: string) {
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

async function call(path: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${API}${path}`, { credentials: "include", headers: { accept: "application/json" } });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

function updatedLabel() {
  const node = $("[data-updated]");
  if (!node) return;
  node.textContent = lastLoaded
    ? `Updated ${lastLoaded.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}`
    : "Loading…";
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
    if (d.status !== 200) return gate("error");
    const body = d.body as { distribution: Distribution | null; accounts: Accounts | null };
    gate("open");
    lastData = { ...lastData, distribution: body.distribution, accounts: body.accounts };
    if (body.distribution) renderDistribution(body.distribution, body.accounts);
    lastLoaded = new Date();
    updatedLabel();

    const r = await revenue;
    const error = $("[data-revenue-error]");
    const section = $$("[data-revenue]");
    if (r.status === 200) {
      if (error) error.hidden = true;
      lastData.revenue = (r.body as { revenue: Revenue }).revenue;
      for (const node of section) node.classList.remove("is-stale");
      renderRevenue(lastData.revenue);
    } else if (error) {
      error.hidden = false;
      error.textContent =
        (r.body as { message?: string } | null)?.message ??
        "Revenue is unavailable right now. Nothing is shown rather than guessed.";
      for (const node of section) node.classList.add("is-stale");
    }
  } catch {
    if (!lastLoaded) gate("error");
  } finally {
    loading = false;
    document.body.classList.remove("is-loading");
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
  if (document.visibilityState === "visible" && lastLoaded && Date.now() - lastLoaded.getTime() > REFRESH_MS)
    void load();
});
let resizeTimer: ReturnType<typeof setTimeout> | undefined;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  // Charts are sized to their panels: redraw from the data already loaded, no refetch.
  resizeTimer = setTimeout(() => {
    if (lastData.distribution) renderDistribution(lastData.distribution, lastData.accounts);
    if (lastData.revenue) renderRevenue(lastData.revenue);
  }, 200);
});

for (const card of $$(".kpi")) card.classList.add("kpi--loading");
void load();
