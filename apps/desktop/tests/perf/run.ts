/**
 * KalCode performance harness (directive §39: measure first).
 *
 * Drives the real release binary built with the `e2e` feature (`pnpm --filter @kalcode/desktop
 * build:e2e` → target/e2e/release/kalcode.exe) in isolated temp data folders and records:
 * cold/warm startup, graceful shutdown, IPC round trips, event append throughput, idle memory,
 * idle CPU and database size. Writes results.json and summary.md.
 *
 *   node apps/desktop/tests/perf/run.ts [--cold 5] [--warm 5] [--ipc 300] [--events 500]
 *        [--idle-seconds 30] [--settle-seconds 10] [--exe path] [--port 9437] [--out dir] [--quick]
 *
 * Never point this at the owner's data: every launch uses a fresh temp KALCODE_DATA_DIR and the
 * harness aborts if the binary does not honour it.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Page } from "@playwright/test";
import {
  close,
  detach,
  epochNow,
  launch,
  PERF_DIR_PREFIX,
  pageTimings,
  type Running,
  reattach,
  removeDir,
  waitForShell,
} from "./lib/app.ts";
import { createProbe, machineInfo, type ProcessProbe, type ProcessSample, platformKey } from "./lib/platform.ts";
import { round, type Stats, summarize } from "./lib/stats.ts";

const REPO = resolve(import.meta.dirname, "../../../..");

export interface Metric {
  unit: string;
  better: "lower" | "higher";
  /** The comparable value: the median for sampled metrics. */
  value: number;
  stats?: Stats;
  samples?: number[];
  note?: string;
}

export interface PerfResults {
  schema: 1;
  kind: "kalcode-perf";
  createdAt: string;
  platform: string;
  machine: ReturnType<typeof machineInfo> & { webview2: string };
  app: { exe: string; version: string | null; channel: string | null };
  config: Record<string, number | string | boolean>;
  /** Conditions during the run, for judging noise. Not budgeted. */
  context: {
    machineCpuBusyPercentDuringIdle: number;
    /** Idle-window CPU (% of one core) and idle working set (MB) per process role. */
    idleByRole: Record<string, { cpuPercentOfOneCore: number; workingSetMB: number; processes: number }>;
  };
  metrics: Record<string, Metric>;
}

/** Machine-wide CPU busy share between two `os.cpus()` snapshots (all processes, all cores). */
function machineBusyPercent(before: ReturnType<typeof cpus>, after: ReturnType<typeof cpus>): number {
  let busy = 0;
  let total = 0;
  after.forEach((cpu, index) => {
    const start = before[index]?.times;
    if (!start) return;
    const delta = (key: keyof typeof cpu.times) => cpu.times[key] - start[key];
    const all = delta("user") + delta("nice") + delta("sys") + delta("irq") + delta("idle");
    total += all;
    busy += all - delta("idle");
  });
  return total > 0 ? (busy / total) * 100 : 0;
}

const { values: args } = parseArgs({
  options: {
    exe: { type: "string" },
    port: { type: "string" },
    out: { type: "string" },
    cold: { type: "string" },
    warm: { type: "string" },
    ipc: { type: "string" },
    events: { type: "string" },
    "idle-seconds": { type: "string" },
    "settle-seconds": { type: "string" },
    quick: { type: "boolean", default: false },
  },
});

const quick = args.quick ?? false;
const num = (value: string | undefined, fallback: number, quickValue: number) =>
  value !== undefined ? Number(value) : quick ? quickValue : fallback;

const config = {
  exe: resolve(args.exe ?? process.env.KALCODE_E2E_EXE ?? join(REPO, "target/e2e/release/kalcode.exe")),
  cdpPort: Number(args.port ?? process.env.KALCODE_E2E_CDP_PORT ?? 9437),
  coldRuns: num(args.cold, 5, 1),
  warmRuns: num(args.warm, 5, 1),
  ipcSamples: num(args.ipc, 300, 30),
  events: num(args.events, 500, 50),
  idleSeconds: num(args["idle-seconds"], 30, 5),
  settleSeconds: num(args["settle-seconds"], 10, 3),
  quick,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MB = 1024 * 1024;

/** Paths inside the repository are reported relative to it (results are committed as baselines). */
function displayPath(path: string): string {
  const rel = relative(REPO, path);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel.replaceAll("\\", "/") : path;
}

function sampled(unit: string, samples: number[], better: Metric["better"] = "lower", note?: string): Metric {
  const stats = summarize(samples);
  return {
    unit,
    better,
    value: round(stats.median),
    stats: mapStats(stats),
    samples: samples.map(round),
    ...(note ? { note } : {}),
  };
}

function single(unit: string, value: number, better: Metric["better"] = "lower", note?: string): Metric {
  return { unit, better, value: round(value), ...(note ? { note } : {}) };
}

function mapStats(stats: Stats): Stats {
  return {
    n: stats.n,
    min: round(stats.min),
    median: round(stats.median),
    mean: round(stats.mean),
    p95: round(stats.p95),
    max: round(stats.max),
  };
}

function newDataDir(): string {
  return mkdtempSync(join(tmpdir(), PERF_DIR_PREFIX));
}

/** Folders left by interrupted runs (only stale ones: another run may be using recent folders). */
function sweepStaleDirs(): void {
  const staleBefore = Date.now() - 30 * 60_000;
  for (const name of readdirSync(tmpdir())) {
    const dir = join(tmpdir(), name);
    if (name.startsWith(PERF_DIR_PREFIX) && statSync(dir).mtimeMs < staleBefore) removeDir(dir);
  }
}

function dbBytes(dataDir: string): number {
  return ["kalcode.db", "kalcode.db-wal", "kalcode.db-shm"]
    .map((file) => join(dataDir, file))
    .filter((file) => existsSync(file))
    .reduce((sum, file) => sum + statSync(file).size, 0);
}

interface StartupSample {
  windowVisibleMs: number;
  webviewNavigationStartMs: number;
  domContentLoadedMs: number | null;
  windowReadyIpcMs: number | null;
}

async function measureLaunch(dataDir: string, probe: ProcessProbe): Promise<{ app: Running; sample: StartupSample }> {
  const app = await launch({ exe: config.exe, dataDir, cdpPort: config.cdpPort, probe });
  await waitForShell(app.page);
  const t = await pageTimings(app.page);
  const since = (at: number | null) => (at === null ? null : at - app.spawnedAt);
  return {
    app,
    sample: {
      windowVisibleMs: app.windowVisibleAt - app.spawnedAt,
      webviewNavigationStartMs: t.navigationStartAt - app.spawnedAt,
      domContentLoadedMs: since(t.domContentLoadedAt),
      windowReadyIpcMs: since(t.windowReadyIpcAt),
    },
  };
}

function startupMetrics(prefix: string, samples: StartupSample[], metrics: Record<string, Metric>): void {
  const keys: (keyof StartupSample)[] = [
    "webviewNavigationStartMs",
    "domContentLoadedMs",
    "windowReadyIpcMs",
    "windowVisibleMs",
  ];
  for (const key of keys) {
    const values = samples.map((s) => s[key]).filter((v): v is number => typeof v === "number");
    if (values.length > 0) metrics[`${prefix}.${key}`] = sampled("ms", values);
  }
}

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

/** Sequential round trips of one command, timed in the page with `performance.now()`. */
async function ipcRoundTrips(page: Page, command: string, commandArgs: Record<string, unknown>, n: number) {
  return page.evaluate(
    async ({ command, commandArgs, n }) => {
      const invoke = (window as unknown as { __TAURI_INTERNALS__: { invoke: Invoke } }).__TAURI_INTERNALS__.invoke;
      for (let i = 0; i < 20; i += 1) await invoke(command, commandArgs); // warm-up
      const out: number[] = [];
      for (let i = 0; i < n; i += 1) {
        const start = performance.now();
        await invoke(command, commandArgs);
        out.push(performance.now() - start);
      }
      return out;
    },
    { command, commandArgs, n },
  );
}

/**
 * Appends `n` real events through existing IPC: each `settings_update` toggles
 * `sidebarCollapsed`, which commits the setting and a `settings.changed` event in one
 * transaction and broadcasts it to the UI. Verifies the persisted event count grew by `n`.
 */
async function eventAppends(page: Page, n: number) {
  return page.evaluate(
    async ({ n }) => {
      const invoke = (window as unknown as { __TAURI_INTERNALS__: { invoke: Invoke } }).__TAURI_INTERNALS__.invoke;
      type Diag = { database: { eventCount: number } };
      const before = ((await invoke("diagnostics_get")) as Diag).database.eventCount;
      const initial = ((await invoke("settings_get")) as { sidebarCollapsed: boolean }).sidebarCollapsed;
      let collapsed = initial;
      const perCall: number[] = [];
      const start = performance.now();
      for (let i = 0; i < n; i += 1) {
        collapsed = !collapsed;
        const t = performance.now();
        await invoke("settings_update", { patch: { sidebarCollapsed: collapsed } });
        perCall.push(performance.now() - t);
      }
      const totalMs = performance.now() - start;
      const after = ((await invoke("diagnostics_get")) as Diag).database.eventCount;
      if (collapsed !== initial) await invoke("settings_update", { patch: { sidebarCollapsed: initial } });
      return { perCall, totalMs, appended: after - before };
    },
    { n },
  );
}

function treeTotals(samples: ProcessSample[], mainPid: number) {
  const main = samples.find((s) => s.pid === mainPid);
  return {
    processCount: samples.length,
    workingSetMB: samples.reduce((sum, s) => sum + s.workingSet, 0) / MB,
    privateMB: samples.reduce((sum, s) => sum + s.privateBytes, 0) / MB,
    mainWorkingSetMB: (main?.workingSet ?? 0) / MB,
    mainPrivateMB: (main?.privateBytes ?? 0) / MB,
  };
}

function byRole(before: ProcessSample[], after: ProcessSample[], elapsedMs: number) {
  const start = new Map(before.map((s) => [s.pid, s.cpuMs]));
  const roles: PerfResults["context"]["idleByRole"] = {};
  for (const sample of after) {
    const entry = roles[sample.role] ?? { cpuPercentOfOneCore: 0, workingSetMB: 0, processes: 0 };
    entry.cpuPercentOfOneCore += ((sample.cpuMs - (start.get(sample.pid) ?? 0)) / elapsedMs) * 100;
    entry.workingSetMB += sample.workingSet / MB;
    entry.processes += 1;
    roles[sample.role] = entry;
  }
  for (const entry of Object.values(roles)) {
    entry.cpuPercentOfOneCore = round(entry.cpuPercentOfOneCore);
    entry.workingSetMB = round(entry.workingSetMB);
  }
  return roles;
}

function cpuDelta(before: ProcessSample[], after: ProcessSample[], pid?: number): number {
  const start = new Map(before.map((s) => [s.pid, s.cpuMs]));
  return after
    .filter((s) => pid === undefined || s.pid === pid)
    .reduce((sum, s) => sum + (s.cpuMs - (start.get(s.pid) ?? 0)), 0);
}

function markdown(results: PerfResults): string {
  const m = results.machine;
  const lines = [
    `# KalCode performance — ${results.platform}`,
    "",
    `Run ${results.createdAt} · ${m.cpuModel} (${m.logicalCores} logical cores) · ${m.totalMemoryGB} GB RAM · ` +
      `${m.osVersion} ${m.osRelease} · WebView2 ${m.webview2} · Node ${m.node}`,
    "",
    `App ${results.app.version ?? "?"} (${results.app.channel ?? "?"}) · \`${results.app.exe}\``,
    "",
    `Machine CPU busy during the idle window (all processes): ${results.context.machineCpuBusyPercentDuringIdle}%`,
    "",
    "| Process role (idle) | CPU % of one core | Working set MB | Processes |",
    "| --- | ---: | ---: | ---: |",
    ...Object.entries(results.context.idleByRole).map(
      ([role, r]) => `| ${role} | ${r.cpuPercentOfOneCore} | ${r.workingSetMB} | ${r.processes} |`,
    ),
    "",
    "| Metric | Value | p95 | min–max | n | Unit |",
    "| --- | ---: | ---: | ---: | ---: | --- |",
  ];
  for (const [key, metric] of Object.entries(results.metrics)) {
    const s = metric.stats;
    lines.push(
      `| \`${key}\` | ${metric.value} | ${s ? s.p95 : ""} | ${s ? `${s.min}–${s.max}` : ""} | ${s ? s.n : 1} | ${metric.unit} |`,
    );
  }
  lines.push("", "Values are medians where n > 1. Startup times are from process spawn.", "");
  return lines.join("\n");
}

async function main(): Promise<void> {
  if (!existsSync(config.exe)) {
    throw new Error(`Binary not found: ${config.exe}\nBuild it first: pnpm --filter @kalcode/desktop build:e2e`);
  }
  if (!/[\\/]e2e[\\/]/.test(config.exe)) {
    console.warn(`warning: ${config.exe} is not under a target/e2e folder; only e2e builds honour KALCODE_DATA_DIR.`);
  }
  const probe = createProbe();
  sweepStaleDirs();
  const metrics: Record<string, Metric> = {};
  const shutdowns: number[] = [];
  let webview2 = "unknown";
  const log = (message: string) => console.log(`[perf] ${message}`);

  // 1. Cold start: a fresh data folder each time (new database, migrations, new WebView2 profile).
  const cold: StartupSample[] = [];
  let freshDbBytes = 0;
  for (let i = 0; i < config.coldRuns; i += 1) {
    const dir = newDataDir();
    try {
      const { app, sample } = await measureLaunch(dir, probe);
      webview2 = app.browser.version();
      cold.push(sample);
      shutdowns.push(await close(app, probe));
      if (i === 0) freshDbBytes = dbBytes(dir);
      log(`cold ${i + 1}/${config.coldRuns}: window visible ${round(sample.windowVisibleMs)} ms`);
    } finally {
      removeDir(dir);
    }
  }
  startupMetrics("startup.cold", cold, metrics);

  // 2. Warm start: relaunch on an existing data folder (database and WebView2 profile exist).
  const warm: StartupSample[] = [];
  const warmDir = newDataDir();
  try {
    const setup = await measureLaunch(warmDir, probe);
    shutdowns.push(await close(setup.app, probe));
    for (let i = 0; i < config.warmRuns; i += 1) {
      const { app, sample } = await measureLaunch(warmDir, probe);
      warm.push(sample);
      shutdowns.push(await close(app, probe));
      log(`warm ${i + 1}/${config.warmRuns}: window visible ${round(sample.windowVisibleMs)} ms`);
    }
  } finally {
    removeDir(warmDir);
  }
  startupMetrics("startup.warm", warm, metrics);
  metrics["shutdown.gracefulMs"] = sampled("ms", shutdowns, "lower", "WM_CLOSE to process exit");

  // 3. Steady state: one session for memory, idle CPU, IPC latency and event throughput.
  const dir = newDataDir();
  let appInfo: PerfResults["app"] = { exe: displayPath(config.exe), version: null, channel: null };
  let machineBusy = 0;
  let idleByRole: PerfResults["context"]["idleByRole"] = {};
  try {
    const { app } = await measureLaunch(dir, probe);
    // Idle is measured with no DevTools client attached (no debugger overhead).
    await detach(app);
    log(`settling ${config.settleSeconds} s`);
    await sleep(config.settleSeconds * 1000);

    const idle = await probe.tree(app.pid);
    const idleTotals = treeTotals(idle, app.pid);
    metrics["memory.idle.workingSetMB"] = single("MB", idleTotals.workingSetMB, "lower", "app + WebView2 processes");
    metrics["memory.idle.privateMB"] = single("MB", idleTotals.privateMB, "lower", "app + WebView2 processes");
    metrics["memory.idle.mainWorkingSetMB"] = single("MB", idleTotals.mainWorkingSetMB, "lower", "kalcode.exe only");
    metrics["memory.idle.mainPrivateMB"] = single("MB", idleTotals.mainPrivateMB, "lower", "kalcode.exe only");
    metrics["memory.idle.processCount"] = single("count", idleTotals.processCount);

    log(`idle CPU over ${config.idleSeconds} s`);
    const cpuStart = epochNow();
    const machineBefore = cpus();
    await sleep(config.idleSeconds * 1000);
    const idleEnd = await probe.tree(app.pid);
    const elapsed = epochNow() - cpuStart;
    machineBusy = machineBusyPercent(machineBefore, cpus());
    idleByRole = byRole(idle, idleEnd, elapsed);
    const cores = machineInfo().logicalCores;
    const treeCpu = cpuDelta(idle, idleEnd);
    metrics["cpu.idle.percentOfOneCore"] = single("%", (treeCpu / elapsed) * 100, "lower", "app + WebView2 processes");
    metrics["cpu.idle.percentOfMachine"] = single("%", (treeCpu / elapsed / cores) * 100, "lower", `${cores} cores`);
    metrics["cpu.idle.mainPercentOfOneCore"] = single(
      "%",
      (cpuDelta(idle, idleEnd, app.pid) / elapsed) * 100,
      "lower",
      "kalcode.exe only",
    );

    await reattach(app, config.cdpPort);
    log(`IPC round trips ×${config.ipcSamples}`);
    const commands: [string, string, Record<string, unknown>][] = [
      ["ipc.boot.roundTripMs", "boot", {}],
      ["ipc.settingsGet.roundTripMs", "settings_get", {}],
      ["ipc.eventsRecent50.roundTripMs", "events_recent", { limit: 50, beforeSeq: null }],
      ["ipc.diagnosticsGet.roundTripMs", "diagnostics_get", {}],
    ];
    for (const [key, command, commandArgs] of commands) {
      metrics[key] = sampled("ms", await ipcRoundTrips(app.page, command, commandArgs, config.ipcSamples));
    }

    const beforeEventsDb = dbBytes(dir);
    log(`appending ${config.events} events`);
    const appended = await eventAppends(app.page, config.events);
    if (appended.appended !== config.events) {
      throw new Error(`Expected ${config.events} persisted events, the database gained ${appended.appended}`);
    }
    metrics["events.append.roundTripMs"] = sampled("ms", appended.perCall, "lower", "settings_update + event commit");
    metrics["events.append.perSecond"] = single(
      "events/s",
      (config.events / appended.totalMs) * 1000,
      "higher",
      "sequential, persisted and broadcast",
    );
    // Let the WebView settle after the burst, then measure memory again.
    await sleep(2_000);
    const loaded = treeTotals(await probe.tree(app.pid), app.pid);
    metrics["memory.afterEvents.workingSetMB"] = single("MB", loaded.workingSetMB, "lower", "app + WebView2 processes");

    const diagnostics = (await app.page.evaluate(() =>
      (window as unknown as { __TAURI_INTERNALS__: { invoke: Invoke } }).__TAURI_INTERNALS__.invoke("diagnostics_get"),
    )) as { app: { version: string; channel: string } };
    appInfo = { exe: displayPath(config.exe), version: diagnostics.app.version, channel: diagnostics.app.channel };

    shutdowns.push(await close(app, probe));
    metrics["db.fresh.bytes"] = single("bytes", freshDbBytes, "lower", "after first launch, incl. WAL");
    metrics["db.beforeEvents.bytes"] = single("bytes", beforeEventsDb, "lower", "steady-state session, incl. WAL");
    metrics["db.afterEvents.bytes"] = single(
      "bytes",
      dbBytes(dir),
      "lower",
      `after ${config.events} events and a clean shutdown`,
    );
  } finally {
    removeDir(dir);
  }
  metrics["binary.exeBytes"] = single("bytes", statSync(config.exe).size);

  const results: PerfResults = {
    schema: 1,
    kind: "kalcode-perf",
    createdAt: new Date().toISOString(),
    platform: platformKey(),
    machine: { ...machineInfo(), webview2 },
    app: appInfo,
    config: { ...config, exe: displayPath(config.exe) },
    context: { machineCpuBusyPercentDuringIdle: round(machineBusy), idleByRole },
    metrics,
  };
  const stamp = results.createdAt.replace(/[:.]/g, "-");
  const outDir = resolve(args.out ?? join(REPO, "target/perf", `${results.platform}-${stamp}`));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
  writeFileSync(join(outDir, "summary.md"), markdown(results));
  console.log(markdown(results));
  console.log(`[perf] wrote ${join(outDir, "results.json")}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});
