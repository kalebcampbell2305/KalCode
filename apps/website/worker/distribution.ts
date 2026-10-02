/**
 * Anonymous distribution counts for the private owner dashboard (docs/OWNER_ANALYTICS.md).
 *
 * Counted from requests the site already serves, after the response is chosen, never before:
 *   download         GET of an installer by a browser (`Mozilla/5.0 …`, known crawlers excluded)
 *   update_check     GET of the stable update feed by the desktop updater (`KalCode/<version>`)
 *   update_download  GET of an updater artifact by the desktop updater
 * Only full responses count (200, or a 206 that starts at byte 0), so resumed downloads, HEAD
 * probes, 304 revalidations and failures never inflate the numbers.
 *
 * Privacy: nothing that identifies a person or device is read or stored. No IP address, no
 * User-Agent string (only the KalCode version it names), no cookie, no installation id.
 * Recording runs after the response, through `waitUntil`, and a failure never affects a download.
 */
import { matchDownloadRoute } from "./downloads";
import { releaseCatalog } from "./release-catalog";

export type DistributionKind = "download" | "update_check" | "update_download";
export type DistributionPlatform = "windows" | "macos" | "unknown";
export type DistributionArch = "x64" | "arm64" | "unknown";

export interface DistributionEvent {
  kind: DistributionKind;
  platform: DistributionPlatform;
  arch: DistributionArch;
  /** The installer/update target version, or for update checks the client's own version. */
  version: string;
  /** For update downloads: the client's version before the update. Otherwise empty. */
  fromVersion: string;
}

/** `KalCode/0.1.9` (updater_commands.rs USER_AGENT). Exact match: nothing else counts. */
const UPDATER_AGENT =
  /^KalCode\/((?:0|[1-9]\d{0,4})\.(?:0|[1-9]\d{0,4})\.(?:0|[1-9]\d{0,4})(?:-[0-9A-Za-z.-]{1,20})?)$/;
const BROWSER_AGENT = /^Mozilla\/5\.0 \(/;
const NOT_A_PERSON =
  /bot|crawl|spider|slurp|headless|lighthouse|preview|monitor|uptime|pingdom|scanner|python|curl|wget|electron/i;
const INSTALLER = /\.(exe|msi|dmg)$/i;
const MAX_VERSION = 40;

function isBrowser(userAgent: string): boolean {
  return BROWSER_AGENT.test(userAgent) && !NOT_A_PERSON.test(userAgent);
}

function platformOf(file: string): DistributionPlatform {
  if (/\.(exe|msi)$/i.test(file)) return "windows";
  if (/\.dmg$/i.test(file)) return "macos";
  return "unknown";
}

function archOf(file: string, platform: DistributionPlatform): DistributionArch {
  if (/aarch64|arm64/i.test(file)) return "arm64";
  if (/x64|x86_64|amd64/i.test(file)) return "x64";
  // Published Windows builds are x64 only and Mac builds arm64 only (downloads.ts routes).
  return platform === "windows" ? "x64" : platform === "macos" ? "arm64" : "unknown";
}

function isFullResponse(response: Response): boolean {
  if (response.status === 200) return true;
  return response.status === 206 && /^bytes 0-/.test(response.headers.get("content-range") ?? "");
}

function boundedVersion(value: string | null | undefined): string | null {
  return value && value.length <= MAX_VERSION && /^[0-9A-Za-z.+-]+$/.test(value) ? value : null;
}

/** What, if anything, this served request counts as. Pure: no I/O. */
export function classifyDistribution(request: Request, response: Response): DistributionEvent | null {
  if (request.method !== "GET" || !isFullResponse(response)) return null;
  const url = new URL(request.url);
  const match = matchDownloadRoute(url.pathname);
  if (!match) return null;
  const userAgent = request.headers.get("user-agent") ?? "";

  if (match.kind === "latest-installer") {
    const version = boundedVersion(response.headers.get("x-kalcode-version"));
    if (!version || !isBrowser(userAgent)) return null;
    return { kind: "download", platform: match.os, arch: match.arch, version, fromVersion: "" };
  }
  if (match.kind === "pinned") {
    const version = boundedVersion(match.version);
    if (!version || !INSTALLER.test(match.file) || !isBrowser(userAgent)) return null;
    const platform = platformOf(match.file);
    return { kind: "download", platform, arch: archOf(match.file, platform), version, fromVersion: "" };
  }
  if (match.kind === "updater") {
    const client = UPDATER_AGENT.exec(userAgent)?.[1];
    if (!client) return null;
    if (match.mutable) {
      // Only the stable feed: beta/dev checks are internal channels, not customer adoption.
      if (match.file !== "stable.json") return null;
      return { kind: "update_check", platform: "unknown", arch: "unknown", version: client, fromVersion: "" };
    }
    if (!/\.(exe|dmg)$/i.test(match.file)) return null;
    const parts = url.pathname.slice("/releases/updater/".length).split("/");
    const version = boundedVersion(parts[1]);
    if (!version || parts[0] !== "stable") return null;
    const platform = platformOf(match.file);
    return { kind: "update_download", platform, arch: archOf(match.file, platform), version, fromVersion: client };
  }
  return null;
}

/** One counter upsert, plus an activity row for downloads and update downloads. */
export async function recordDistribution(db: D1Database, event: DistributionEvent, now: Date): Promise<void> {
  const statements = [
    db
      .prepare(
        `INSERT INTO distribution_daily (day, event, platform, arch, version, from_version, count)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1)
         ON CONFLICT (day, event, platform, arch, version, from_version) DO UPDATE SET count = count + 1`,
      )
      .bind(now.toISOString().slice(0, 10), event.kind, event.platform, event.arch, event.version, event.fromVersion),
  ];
  if (event.kind !== "update_check") {
    statements.push(
      db
        .prepare(
          `INSERT INTO distribution_events (occurred_at, event, platform, arch, version, from_version)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
        )
        .bind(now.toISOString(), event.kind, event.platform, event.arch, event.version, event.fromVersion),
    );
  }
  await db.batch(statements);
}

export const EVENT_RETENTION_DAYS = 90;

/** Hourly cron: the activity feed keeps 90 days. Daily counters are kept (they identify nobody). */
export async function purgeDistributionEvents(db: D1Database, now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - EVENT_RETENTION_DAYS * 86_400_000).toISOString();
  await db.prepare("DELETE FROM distribution_events WHERE occurred_at < ?1").bind(cutoff).run();
}

/** Records `response` if it counts. Never throws; never delays the response (call via waitUntil). */
export async function countServedRequest(
  db: D1Database | undefined,
  request: Request,
  response: Response,
  now: Date,
  log: (entry: Record<string, string>) => void,
): Promise<void> {
  const event = db ? classifyDistribution(request, response) : null;
  if (!db || !event) return;
  try {
    await recordDistribution(db, event, now);
  } catch (error) {
    log({ level: "warn", event: "distribution.record_failed", error: error instanceof Error ? error.name : "unknown" });
  }
}

// ---------------------------------------------------------------------------------------------
// Owner summary (served only through the internal DistributionStatsEntrypoint RPC).

export type AnalyticsRange = "24h" | "7d" | "30d" | "90d" | "all";
export const ANALYTICS_RANGES: readonly AnalyticsRange[] = ["24h", "7d", "30d", "90d", "all"];

export interface DistributionStatsInput {
  range: AnalyticsRange;
  /** `Date#getTimezoneOffset()` of the owner's browser, so "today" is the owner's today. */
  tzOffsetMinutes: number;
}

export interface PlatformCounts {
  windows: number;
  macos: number;
  unknown: number;
}

export interface ActivityEntry {
  at: string;
  kind: "download" | "update_download";
  platform: DistributionPlatform;
  arch: DistributionArch;
  version: string;
  fromVersion: string;
}

export interface DistributionSummary {
  generatedAt: string;
  /** First UTC day with any count; null before the first counted request. */
  trackingSince: string | null;
  latest: { version: string; publicVersion: string } | null;
  downloads: { today: number; last7d: number; last30d: number; allTime: number; inRange: number; lastHour: number };
  downloadsByPlatform: PlatformCounts;
  updates: { today: number; inRange: number; allTime: number; toLatest: number; lastHour: number };
  updatesByPlatform: PlatformCounts;
  /** Share of stable update checks by client version, over the last two UTC days. */
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

interface EventRow {
  occurred_at: string;
  event: "download" | "update_download";
  platform: DistributionPlatform;
  arch: DistributionArch;
  version: string;
  from_version: string;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const RANGE_DAYS: Record<Exclude<AnalyticsRange, "all">, number> = { "24h": 1, "7d": 7, "30d": 30, "90d": 90 };

export function isAnalyticsRange(value: unknown): value is AnalyticsRange {
  return typeof value === "string" && (ANALYTICS_RANGES as readonly string[]).includes(value);
}

export function validTzOffset(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= -840 && value <= 840;
}

/** Start of the owner's local day containing `now`, as a UTC instant. */
export function localDayStart(now: Date, tzOffsetMinutes: number): Date {
  const local = new Date(now.getTime() - tzOffsetMinutes * 60_000);
  local.setUTCHours(0, 0, 0, 0);
  return new Date(local.getTime() + tzOffsetMinutes * 60_000);
}

export function publicVersion(version: string): string {
  return version.replace(/\+.*$/, "");
}

function emptyPlatforms(): PlatformCounts {
  return { windows: 0, macos: 0, unknown: 0 };
}

function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = "", build = "0"] = v.split("+");
    return [...core.replace(/-.*$/, "").split(".").map(Number), Number(build)];
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return a.localeCompare(b);
}

interface SummaryInputs {
  now: Date;
  input: DistributionStatsInput;
  latestVersion: string | null;
  trackingSince: string | null;
  /** All-time counts by event and platform. */
  totals: { event: DistributionKind; platform: DistributionPlatform; count: number }[];
  /** update_check counts by client version over the last two UTC days. */
  checks: { version: string; count: number }[];
  /** All-time download and update-download counts by version. */
  versions: { event: DistributionKind; version: string; count: number }[];
  /** Per-UTC-day download/update counts (used for the "all" series). */
  days: { day: string; event: DistributionKind; count: number }[];
  /** Activity rows of the last 90 days, newest first. */
  events: EventRow[];
}

/** Pure aggregation of the queried rows into the dashboard summary. */
export function summarizeDistribution(inputs: SummaryInputs): DistributionSummary {
  const { now, input, events } = inputs;
  const nowMs = now.getTime();
  const today = localDayStart(now, input.tzOffsetMinutes).getTime();
  const rangeStart = input.range === "all" ? Number.NEGATIVE_INFINITY : nowMs - RANGE_DAYS[input.range] * DAY;
  const since = (start: number, kind: EventRow["event"]) =>
    events.filter((e) => e.event === kind && Date.parse(e.occurred_at) >= start).length;

  const allTime = (event: DistributionKind) =>
    inputs.totals.filter((t) => t.event === event).reduce((sum, t) => sum + t.count, 0);
  const byPlatform = (kind: EventRow["event"]): PlatformCounts => {
    const counts = emptyPlatforms();
    if (input.range === "all") {
      for (const t of inputs.totals) if (t.event === kind) counts[t.platform] += t.count;
    } else {
      for (const e of events) if (e.event === kind && Date.parse(e.occurred_at) >= rangeStart) counts[e.platform] += 1;
    }
    return counts;
  };
  const inRange = (kind: EventRow["event"]) => (input.range === "all" ? allTime(kind) : since(rangeStart, kind));

  const checks = inputs.checks.reduce((sum, c) => sum + c.count, 0);
  const latestPublic = inputs.latestVersion ? publicVersion(inputs.latestVersion) : null;
  const versions = inputs.checks
    .map((c) => ({ version: c.version, checks: c.count, share: checks ? c.count / checks : 0 }))
    .sort((a, b) => compareVersions(b.version, a.version));

  const buildMap = new Map<string, { version: string; downloads: number; updates: number }>();
  for (const row of inputs.versions) {
    const entry = buildMap.get(row.version) ?? { version: row.version, downloads: 0, updates: 0 };
    if (row.event === "download") entry.downloads += row.count;
    if (row.event === "update_download") entry.updates += row.count;
    buildMap.set(row.version, entry);
  }

  return {
    generatedAt: now.toISOString(),
    trackingSince: inputs.trackingSince,
    latest: inputs.latestVersion ? { version: inputs.latestVersion, publicVersion: latestPublic as string } : null,
    downloads: {
      today: since(today, "download"),
      last7d: since(nowMs - 7 * DAY, "download"),
      last30d: since(nowMs - 30 * DAY, "download"),
      allTime: allTime("download"),
      inRange: inRange("download"),
      lastHour: since(nowMs - HOUR, "download"),
    },
    downloadsByPlatform: byPlatform("download"),
    updates: {
      today: since(today, "update_download"),
      inRange: inRange("update_download"),
      allTime: allTime("update_download"),
      toLatest: inputs.latestVersion
        ? inputs.versions
            .filter((v) => v.event === "update_download" && publicVersion(v.version) === latestPublic)
            .reduce((sum, v) => sum + v.count, 0)
        : 0,
      lastHour: since(nowMs - HOUR, "update_download"),
    },
    updatesByPlatform: byPlatform("update_download"),
    adoption: {
      checks,
      versions,
      latestShare:
        checks && latestPublic
          ? versions.filter((v) => publicVersion(v.version) === latestPublic).reduce((s, v) => s + v.checks, 0) / checks
          : null,
    },
    builds: [...buildMap.values()].sort((a, b) => compareVersions(b.version, a.version)).slice(0, 12),
    ...seriesFor(inputs, rangeStart),
    recent: events.slice(0, 30).map((e) => ({
      at: e.occurred_at,
      kind: e.event,
      platform: e.platform,
      arch: e.arch,
      version: e.version,
      fromVersion: e.from_version,
    })),
  };
}

function seriesFor(inputs: SummaryInputs, rangeStart: number): Pick<DistributionSummary, "series" | "seriesUnit"> {
  const { now, input } = inputs;
  if (input.range === "all") {
    const byDay = new Map<string, { start: string; downloads: number; updates: number }>();
    const first = inputs.trackingSince ?? now.toISOString().slice(0, 10);
    for (let t = Date.parse(`${first}T00:00:00.000Z`); t <= now.getTime(); t += DAY) {
      const day = new Date(t).toISOString().slice(0, 10);
      byDay.set(day, { start: `${day}T00:00:00.000Z`, downloads: 0, updates: 0 });
    }
    for (const row of inputs.days) {
      const bucket = byDay.get(row.day);
      if (!bucket) continue;
      if (row.event === "download") bucket.downloads += row.count;
      if (row.event === "update_download") bucket.updates += row.count;
    }
    return { series: [...byDay.values()], seriesUnit: "day" };
  }
  const hourly = input.range === "24h";
  const step = hourly ? HOUR : DAY;
  // Buckets align to the owner's local midnight (days) or the top of the hour (hours).
  const anchor = hourly ? Math.floor(now.getTime() / HOUR) * HOUR : localDayStart(now, input.tzOffsetMinutes).getTime();
  const count = hourly ? 24 : RANGE_DAYS[input.range];
  const series = Array.from({ length: count }, (_, i) => ({
    start: new Date(anchor - (count - 1 - i) * step).toISOString(),
    downloads: 0,
    updates: 0,
  }));
  const firstStart = anchor - (count - 1) * step;
  for (const e of inputs.events) {
    const t = Date.parse(e.occurred_at);
    if (t < rangeStart || t < firstStart) continue;
    const bucket = series[Math.min(count - 1, Math.floor((t - firstStart) / step))];
    if (!bucket) continue;
    if (e.event === "download") bucket.downloads += 1;
    else bucket.updates += 1;
  }
  return { series, seriesUnit: hourly ? "hour" : "day" };
}

/** Runs the summary queries against the site database. */
export async function distributionStats(
  db: D1Database,
  input: DistributionStatsInput,
  now: Date,
): Promise<DistributionSummary> {
  const yesterday = new Date(now.getTime() - DAY).toISOString().slice(0, 10);
  const eventsSince = new Date(now.getTime() - EVENT_RETENTION_DAYS * DAY).toISOString();
  const [first, totals, checks, versions, days, events] = await db.batch([
    db.prepare("SELECT MIN(day) AS day FROM distribution_daily"),
    db.prepare("SELECT event, platform, SUM(count) AS count FROM distribution_daily GROUP BY event, platform"),
    db
      .prepare(
        "SELECT version, SUM(count) AS count FROM distribution_daily WHERE event = 'update_check' AND day >= ?1 GROUP BY version",
      )
      .bind(yesterday),
    db.prepare(
      "SELECT event, version, SUM(count) AS count FROM distribution_daily WHERE event IN ('download', 'update_download') GROUP BY event, version",
    ),
    db.prepare(
      "SELECT day, event, SUM(count) AS count FROM distribution_daily WHERE event IN ('download', 'update_download') GROUP BY day, event",
    ),
    db
      .prepare(
        "SELECT occurred_at, event, platform, arch, version, from_version FROM distribution_events WHERE occurred_at >= ?1 ORDER BY occurred_at DESC, id DESC LIMIT 50000",
      )
      .bind(eventsSince),
  ]);
  let latestVersion: string | null = null;
  try {
    latestVersion = (await releaseCatalog(db).get("stable"))?.version ?? null;
  } catch {
    latestVersion = null;
  }
  return summarizeDistribution({
    now,
    input,
    latestVersion,
    trackingSince: (first?.results[0] as { day: string | null } | undefined)?.day ?? null,
    totals: (totals?.results ?? []) as SummaryInputs["totals"],
    checks: (checks?.results ?? []) as SummaryInputs["checks"],
    versions: (versions?.results ?? []) as SummaryInputs["versions"],
    days: (days?.results ?? []) as SummaryInputs["days"],
    events: (events?.results ?? []) as EventRow[],
  });
}
