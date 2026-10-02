/**
 * Anonymous distribution counts (worker/distribution.ts): what counts, what never counts, that no
 * identifying data is stored, and the owner summary over a real local D1.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getPlatformProxy, unstable_splitSqlQuery } from "wrangler";
import {
  classifyDistribution,
  countServedRequest,
  distributionStats,
  localDayStart,
  MAX_DAILY_ROWS_PER_EVENT,
  purgeDistributionEvents,
  recordDistribution,
} from "../../worker/distribution";

const CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";
const SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Safari/605.1";
const SHA = "a".repeat(64);
const SHA2 = "b".repeat(64);

function served(
  path: string,
  userAgent: string,
  init: { method?: string; status?: number; headers?: Record<string, string> } = {},
) {
  const request = new Request(`https://kalcoded.com${path}`, {
    method: init.method ?? "GET",
    headers: { "user-agent": userAgent, "cf-connecting-ip": "203.0.113.9" },
  });
  const response = new Response(null, { status: init.status ?? 200, headers: init.headers ?? {} });
  return classifyDistribution(request, response);
}

describe("classifyDistribution", () => {
  it("counts a browser installer download with its version and platform", () => {
    expect(served("/download/windows-x64", CHROME, { headers: { "x-kalcode-version": "0.1.9+1038" } })).toEqual({
      kind: "download",
      platform: "windows",
      arch: "x64",
      version: "0.1.9+1038",
      fromVersion: "",
    });
    expect(served("/download/macos-arm64", SAFARI, { headers: { "x-kalcode-version": "0.1.9" } })).toMatchObject({
      kind: "download",
      platform: "macos",
      arch: "arm64",
    });
    expect(served("/download/0.1.9/KalCode_0.1.9_aarch64.dmg", SAFARI)).toMatchObject({
      kind: "download",
      platform: "macos",
      arch: "arm64",
      version: "0.1.9",
    });
  });

  it("counts updater feed checks and update downloads only from the desktop updater", () => {
    expect(served("/releases/updater/stable.json", "KalCode/0.1.8")).toEqual({
      kind: "update_check",
      platform: "unknown",
      arch: "unknown",
      version: "0.1.8",
      fromVersion: "",
    });
    expect(served(`/releases/updater/stable/0.1.9+1038/${SHA}/KalCode_0.1.9_x64-setup.exe`, "KalCode/0.1.8")).toEqual({
      kind: "update_download",
      platform: "windows",
      arch: "x64",
      version: "0.1.9+1038",
      fromVersion: "0.1.8",
    });
    expect(served(`/releases/updater/stable/0.1.9/${SHA}/KalCode_0.1.9_aarch64.dmg`, "KalCode/0.1.7")).toMatchObject({
      kind: "update_download",
      platform: "macos",
    });
  });

  it.each([
    ["HEAD probe", "/download/windows-x64", CHROME, { method: "HEAD", headers: { "x-kalcode-version": "0.1.9" } }],
    ["304 revalidation", "/download/windows-x64", CHROME, { status: 304, headers: { "x-kalcode-version": "0.1.9" } }],
    [
      "resumed range",
      "/download/windows-x64",
      CHROME,
      { status: 206, headers: { "content-range": "bytes 500-999/1000", "x-kalcode-version": "0.1.9" } },
    ],
    ["failure", "/download/windows-x64", CHROME, { status: 503 }],
    ["missing release", "/download/windows-x64", CHROME, { status: 404 }],
    [
      "crawler",
      "/download/windows-x64",
      "Mozilla/5.0 (compatible; Googlebot/2.1)",
      { headers: { "x-kalcode-version": "0.1.9" } },
    ],
    [
      "headless browser",
      "/download/windows-x64",
      "Mozilla/5.0 (X11) HeadlessChrome/129.0",
      { headers: { "x-kalcode-version": "0.1.9" } },
    ],
    ["script", "/download/windows-x64", "node", { headers: { "x-kalcode-version": "0.1.9" } }],
    ["signature file", "/download/0.1.9/KalCode_0.1.9_x64-setup.exe.sig", CHROME, {}],
    ["manifest", "/releases/latest.json", CHROME, {}],
    ["browser on the update feed", "/releases/updater/stable.json", CHROME, {}],
    ["beta channel check", "/releases/updater/beta.json", "KalCode/0.1.9", {}],
    [
      "updater signature",
      `/releases/updater/stable/0.1.9/${SHA}/${SHA2}/KalCode_0.1.9_x64-setup.exe.sig`,
      "KalCode/0.1.8",
      {},
    ],
    ["forged agent", "/releases/updater/stable.json", "KalCode/0.1.9 extra", {}],
    ["prerelease agent", "/releases/updater/stable.json", "KalCode/0.1.9-rc.1", {}],
    ["oversized version", "/releases/updater/stable.json", "KalCode/0.1.99999", {}],
    ["site page", "/download", CHROME, {}],
  ] as const)("never counts a %s", (_name, path, agent, init) => {
    expect(served(path, agent, init)).toBeNull();
  });

  it("counts a 206 that starts at byte 0 (a first range request)", () => {
    expect(
      served("/download/windows-x64", CHROME, {
        status: 206,
        headers: { "content-range": "bytes 0-1023/2048", "x-kalcode-version": "0.1.9" },
      }),
    ).toMatchObject({ kind: "download" });
  });
});

describe("localDayStart", () => {
  it("is the owner's local midnight", () => {
    expect(localDayStart(new Date("2026-10-02T03:00:00.000Z"), 300).toISOString()).toBe("2026-10-01T05:00:00.000Z");
    expect(localDayStart(new Date("2026-10-02T03:00:00.000Z"), -120).toISOString()).toBe("2026-10-01T22:00:00.000Z");
  });
});

type Proxy = Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>>;
let proxy: Proxy;
let db: D1Database;

async function migrate(file: string): Promise<void> {
  const sql = readFileSync(fileURLToPath(new URL(`../../migrations/${file}`, import.meta.url)), "utf8");
  for (const statement of unstable_splitSqlQuery(sql)) await db.prepare(statement).run();
}

beforeAll(async () => {
  proxy = await getPlatformProxy<{ DB: D1Database }>({
    configPath: fileURLToPath(new URL("./fixtures/wrangler.d1.jsonc", import.meta.url)),
    persist: false,
  });
  db = proxy.env.DB;
  await migrate("0003_release_publication_pointers.sql");
  await migrate("0007_distribution_counts.sql");
}, 60_000);

afterAll(async () => {
  await proxy?.dispose();
});

beforeEach(async () => {
  await db.batch([db.prepare("DELETE FROM distribution_daily"), db.prepare("DELETE FROM distribution_events")]);
});

const NOW = new Date("2026-10-02T18:00:00.000Z");
const at = (iso: string) => new Date(iso);

describe("recording and the owner summary (local D1)", () => {
  it("stores only day/time, kind, platform and versions — no IP, agent or identifier", async () => {
    const request = new Request("https://kalcoded.com/download/windows-x64", {
      headers: { "user-agent": CHROME, "cf-connecting-ip": "203.0.113.9", cookie: "x=1" },
    });
    const response = new Response("installer", { headers: { "x-kalcode-version": "0.1.9" } });
    await countServedRequest(db, request, response, NOW, () => {});
    const daily = await db.prepare("SELECT * FROM distribution_daily").all();
    const events = await db.prepare("SELECT * FROM distribution_events").all();
    expect(daily.results).toEqual([
      {
        day: "2026-10-02",
        event: "download",
        platform: "windows",
        arch: "x64",
        version: "0.1.9",
        from_version: "",
        count: 1,
      },
    ]);
    expect(events.results).toEqual([
      {
        id: expect.any(Number),
        occurred_at: NOW.toISOString(),
        event: "download",
        platform: "windows",
        arch: "x64",
        version: "0.1.9",
        from_version: "",
      },
    ]);
    const stored = JSON.stringify([daily.results, events.results]);
    expect(stored).not.toContain("203.0.113.9");
    expect(stored).not.toContain("Mozilla");
  });

  it("never throws into the download path when the database fails", async () => {
    const logs: Record<string, string>[] = [];
    const broken = { prepare: () => ({ bind: () => ({}) }), batch: () => Promise.reject(new Error("D1 down")) };
    const request = new Request("https://kalcoded.com/releases/updater/stable.json", {
      headers: { "user-agent": "KalCode/0.1.9" },
    });
    await expect(
      countServedRequest(broken as unknown as D1Database, request, new Response("{}"), NOW, (e) => logs.push(e)),
    ).resolves.toBeUndefined();
    expect(logs).toEqual([{ level: "warn", event: "distribution.record_failed", error: "Error" }]);
  });

  it("summarizes downloads, updates, platform split, adoption and activity", async () => {
    const download = (iso: string, platform: "windows" | "macos", version = "0.1.9+1038") =>
      recordDistribution(
        db,
        { kind: "download", platform, arch: platform === "windows" ? "x64" : "arm64", version, fromVersion: "" },
        at(iso),
      );
    const update = (iso: string, from: string, to = "0.1.9+1038") =>
      recordDistribution(
        db,
        { kind: "update_download", platform: "windows", arch: "x64", version: to, fromVersion: from },
        at(iso),
      );
    const check = (iso: string, version: string) =>
      recordDistribution(
        db,
        { kind: "update_check", platform: "unknown", arch: "unknown", version, fromVersion: "" },
        at(iso),
      );

    await download("2026-09-01T12:00:00.000Z", "windows", "0.1.7");
    await download("2026-09-28T12:00:00.000Z", "macos", "0.1.8");
    await download("2026-10-02T06:00:00.000Z", "windows");
    await download("2026-10-02T17:30:00.000Z", "macos");
    await update("2026-10-02T17:45:00.000Z", "0.1.8");
    await update("2026-09-30T10:00:00.000Z", "0.1.7", "0.1.8");
    for (let i = 0; i < 6; i++) await check("2026-10-02T10:00:00.000Z", "0.1.9");
    for (let i = 0; i < 3; i++) await check("2026-10-01T10:00:00.000Z", "0.1.8");
    await check("2026-10-01T10:00:00.000Z", "0.1.7");
    await check("2026-09-20T10:00:00.000Z", "0.1.6");

    // UTC-5: the owner's "today" starts 2026-10-02T05:00Z.
    const s = await distributionStats(db, { range: "7d", tzOffsetMinutes: 300 }, NOW);
    expect(s.trackingSince).toBe("2026-09-01");
    expect(s.downloads).toEqual({ today: 2, last7d: 3, last30d: 3, allTime: 4, inRange: 3, lastHour: 1 });
    expect(s.downloadsByPlatform).toEqual({ windows: 1, macos: 2, unknown: 0 });
    expect(s.updates).toMatchObject({ today: 1, inRange: 2, allTime: 2, lastHour: 1 });
    expect(s.updatesByPlatform.windows).toBe(2);
    expect(s.adoption.checks).toBe(10);
    expect(s.adoption.versions).toEqual([
      { version: "0.1.9", checks: 6, share: 0.6 },
      { version: "0.1.8", checks: 3, share: 0.3 },
      { version: "0.1.7", checks: 1, share: 0.1 },
    ]);
    // No publication pointer in this database: no latest version, so no latest share is claimed.
    expect(s.latest).toBeNull();
    expect(s.adoption.latestShare).toBeNull();
    expect(s.series).toHaveLength(7);
    expect(s.series.at(-1)).toEqual({ start: "2026-10-02T05:00:00.000Z", downloads: 2, updates: 1 });
    expect(s.seriesUnit).toBe("day");
    expect(s.recent[0]).toEqual({
      at: "2026-10-02T17:45:00.000Z",
      kind: "update_download",
      platform: "windows",
      arch: "x64",
      version: "0.1.9+1038",
      fromVersion: "0.1.8",
    });
    expect(s.builds[0]).toEqual({ version: "0.1.9+1038", downloads: 2, updates: 1 });

    const hourly = await distributionStats(db, { range: "24h", tzOffsetMinutes: 0 }, NOW);
    expect(hourly.seriesUnit).toBe("hour");
    expect(hourly.series).toHaveLength(24);
    expect(hourly.series.reduce((n, b) => n + b.downloads, 0)).toBe(2);

    const all = await distributionStats(db, { range: "all", tzOffsetMinutes: 0 }, NOW);
    expect(all.downloads.inRange).toBe(4);
    expect(all.downloadsByPlatform).toEqual({ windows: 2, macos: 2, unknown: 0 });
    expect(all.series[0]?.start).toBe("2026-09-01T00:00:00.000Z");
    expect(all.series.reduce((n, b) => n + b.downloads, 0)).toBe(4);
  });

  it("reports the latest published version and the share of checks on it", async () => {
    await db
      .prepare(
        "INSERT INTO release_publication_versions (channel, version, precedence_key, updater_descriptor_key, download_descriptor_key, updater_descriptor_sha256, download_descriptor_sha256, published_at) VALUES ('stable', '0.1.9+1038', ?1, ?2, ?3, ?4, ?4, ?5)",
      )
      .bind(
        "0000000.0000001.0000009.0001038",
        `releases/updater/stable/0.1.9+1038/${SHA}.json`,
        `releases/0.1.9+1038/${SHA}.json`,
        SHA,
        "2026-10-02T12:00:00.000Z",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO release_publication_pointers (channel, version, precedence_key, updated_at) VALUES ('stable', '0.1.9+1038', ?1, 1)",
      )
      .bind("0000000.0000001.0000009.0001038")
      .run();
    for (let i = 0; i < 3; i++)
      await recordDistribution(
        db,
        { kind: "update_check", platform: "unknown", arch: "unknown", version: "0.1.9", fromVersion: "" },
        NOW,
      );
    await recordDistribution(
      db,
      { kind: "update_check", platform: "unknown", arch: "unknown", version: "0.1.8", fromVersion: "" },
      NOW,
    );
    const s = await distributionStats(db, { range: "7d", tzOffsetMinutes: 0 }, NOW);
    expect(s.latest).toEqual({ version: "0.1.9+1038", publicVersion: "0.1.9" });
    expect(s.adoption.latestShare).toBe(0.75);
  });

  it("bounds the distinct counter rows a day can gain, but keeps counting existing ones", async () => {
    const check = (version: string) =>
      recordDistribution(
        db,
        { kind: "update_check", platform: "unknown", arch: "unknown", version, fromVersion: "" },
        NOW,
      );
    for (let i = 0; i < MAX_DAILY_ROWS_PER_EVENT + 10; i++) await check(`0.${Math.floor(i / 10)}.${i % 10}`);
    await check("0.0.0");
    const rows = await db
      .prepare("SELECT version, count FROM distribution_daily WHERE event = 'update_check'")
      .all<{ version: string; count: number }>();
    expect(rows.results).toHaveLength(MAX_DAILY_ROWS_PER_EVENT);
    expect(rows.results.find((r) => r.version === "0.0.0")?.count).toBe(2);
    // Other kinds have their own budget.
    await recordDistribution(
      db,
      { kind: "download", platform: "windows", arch: "x64", version: "0.1.9", fromVersion: "" },
      NOW,
    );
    expect(
      (await db.prepare("SELECT count(*) AS n FROM distribution_daily WHERE event = 'download'").first<{ n: number }>())
        ?.n,
    ).toBe(1);
  });

  it("keeps 90 days of activity and every daily counter", async () => {
    await recordDistribution(
      db,
      { kind: "download", platform: "windows", arch: "x64", version: "0.1.5", fromVersion: "" },
      at("2026-06-01T00:00:00.000Z"),
    );
    await recordDistribution(
      db,
      { kind: "download", platform: "windows", arch: "x64", version: "0.1.9", fromVersion: "" },
      NOW,
    );
    await purgeDistributionEvents(db, NOW);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM distribution_events").first<{ n: number }>())?.n).toBe(1);
    expect((await db.prepare("SELECT SUM(count) AS n FROM distribution_daily").first<{ n: number }>())?.n).toBe(2);
  });
});
