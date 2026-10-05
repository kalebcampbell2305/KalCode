/**
 * KalCode interaction latency ("KalCode must feel instant"): drives real clicks and key presses
 * against the release e2e binary and records, per interaction:
 *
 * - `nextPaintMs`: input event → the first frame produced after every handler for that input ran
 *   (the user sees *some* acknowledgement: pressed state, highlight, menu, pane). Measured in the
 *   page from the input's own `timeStamp` to a callback queued after the next animation frame.
 * - `visibleMs`: input event → the first animation frame in which the interaction's target state is
 *   on screen (the menu is open, the page heading is there, the terminal shows its content).
 *
 * Every sample is a real OS-level input dispatched by Playwright over the DevTools protocol; the
 * harness never calls app code to fake an interaction. p50 and p95 are reported.
 *
 *   node apps/desktop/tests/perf/interactions.ts [--runs 15] [--exe path] [--port 9437] [--out dir]
 *
 * Like run.ts, every launch uses a fresh temp KALCODE_DATA_DIR (never the owner's data) and a
 * throwaway project folder opened through the e2e folder-picker hook.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Locator, Page } from "@playwright/test";
import { close, launch, PERF_DIR_PREFIX, removeDir, waitForShell } from "./lib/app.ts";
import { createProbe, machineInfo, platformKey } from "./lib/platform.ts";
import { round, summarize } from "./lib/stats.ts";

const REPO = resolve(import.meta.dirname, "../../../..");
const { values: args } = parseArgs({
  options: {
    exe: { type: "string" },
    port: { type: "string" },
    out: { type: "string" },
    runs: { type: "string" },
    label: { type: "string" },
  },
});
const config = {
  exe: resolve(args.exe ?? process.env.KALCODE_E2E_EXE ?? join(REPO, "target/e2e/release/kalcode.exe")),
  cdpPort: Number(args.port ?? process.env.KALCODE_E2E_CDP_PORT ?? 9437),
  runs: Number(args.runs ?? 15),
  label: args.label ?? "",
};
const log = (message: string) => console.log(`[interactions] ${message}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What must be on screen for an interaction to count as visibly done. */
type Target =
  | { kind: "selector"; selector: string; text?: string }
  | { kind: "count"; selector: string; count: number }
  | { kind: "attr"; selector: string; name: string; value: string };

interface Sample {
  nextPaintMs: number;
  visibleMs: number;
}

/** Installs the page-side recorder once per page. */
async function install(page: Page): Promise<void> {
  await page.evaluate(() => {
    type W = Window & { __kcPerf?: unknown };
    if ((window as W).__kcPerf) return;
    const state = {
      start: null as number | null,
      paint: null as number | null,
      arm() {
        state.start = null;
        state.paint = null;
        const onInput = (event: Event) => {
          if (state.start !== null) return;
          state.start = event.timeStamp;
          // Runs after every handler for this input (capture listener runs first; the frame callback
          // waits for them), then after that frame is produced.
          requestAnimationFrame(() => {
            const channel = new MessageChannel();
            channel.port1.onmessage = () => {
              state.paint = performance.now();
            };
            channel.port2.postMessage(null);
          });
        };
        for (const type of ["pointerdown", "keydown"]) {
          window.addEventListener(type, onInput, { capture: true, once: true });
        }
      },
    };
    (window as W).__kcPerf = state;
  });
}

/** Arms the recorder, performs `act`, and waits for `target` to be on screen. */
async function measure(page: Page, target: Target, act: () => Promise<void>, timeoutMs = 20_000): Promise<Sample> {
  await page.evaluate(() => (window as unknown as { __kcPerf: { arm(): void } }).__kcPerf.arm());
  const visible = page.evaluate(
    ({ target, timeoutMs }) =>
      new Promise<{ visibleMs: number; nextPaintMs: number }>((resolve, reject) => {
        const perf = (window as unknown as { __kcPerf: { start: number | null; paint: number | null } }).__kcPerf;
        const shown = (el: Element) => {
          const box = (el as HTMLElement).getBoundingClientRect();
          return box.width > 0 && box.height > 0 && !(el as HTMLElement).closest("[hidden]");
        };
        const met = () => {
          const all = [...document.querySelectorAll(target.selector)].filter(shown);
          if (target.kind === "count") return all.length === target.count;
          if (target.kind === "attr") return all.some((el) => el.getAttribute(target.name) === target.value);
          return all.some((el) => !target.text || (el.textContent ?? "").includes(target.text));
        };
        const deadline = performance.now() + timeoutMs;
        let visibleAt: number | null = null;
        const tick = (frame: number) => {
          if (perf.start !== null && visibleAt === null && met()) visibleAt = frame;
          if (visibleAt !== null && perf.paint !== null && perf.start !== null) {
            resolve({ visibleMs: Math.max(0, visibleAt - perf.start), nextPaintMs: perf.paint - perf.start });
            return;
          }
          if (performance.now() > deadline) {
            reject(new Error(`timed out waiting for ${JSON.stringify(target)}`));
            return;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    { target, timeoutMs },
  );
  await act();
  return visible;
}

const nav = (page: Page, name: string): Locator =>
  page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name, exact: true });
const heading = (name: string): Target => ({ kind: "selector", selector: "h1", text: name });
const visibleTerminalText = (text: string): Target => ({
  kind: "selector",
  selector: '[role="tabpanel"]:not([hidden]) .xterm-rows',
  text,
});

interface Scenario {
  key: string;
  /** Puts the app into the state the measured action starts from (not measured). */
  setup?: (page: Page) => Promise<void>;
  run: (page: Page, i: number) => Promise<Sample>;
  /** Restores state after a sample (not measured). */
  teardown?: (page: Page) => Promise<void>;
}

async function main(): Promise<void> {
  const probe = createProbe();
  const dataDir = mkdtempSync(join(tmpdir(), PERF_DIR_PREFIX));
  const projectRoot = mkdtempSync(join(tmpdir(), "kalcode-perf-project-"));
  const project = join(projectRoot, "perf-site");
  mkdirSync(project);
  // Terminal history worth replaying: each terminal prints this file once.
  const lines = Array.from({ length: 3000 }, (_, i) => `line ${i} ${"x".repeat(60)}`);
  writeFileSync(join(project, "big.txt"), `${lines.join("\r\n")}\r\nkalcode-big-end\r\n`);
  process.env.KALCODE_E2E_PICK_FOLDER = project;

  const results: Record<string, { nextPaintMs: number[]; visibleMs: number[]; error?: string }> = {};
  const app = await launch({ exe: config.exe, dataDir, cdpPort: config.cdpPort, probe });
  try {
    const page = app.page;
    await waitForShell(page);
    await install(page);

    // Setup: open the project and start three terminals with real history in each.
    await nav(page, "Code").click();
    await page.getByRole("button", { name: "Open folder…" }).click();
    await page.getByRole("heading", { level: 1, name: "perf-site" }).waitFor();
    for (let t = 0; t < 3; t += 1) {
      await page.getByRole("button", { name: "New terminal", exact: true }).click();
      await page.getByRole("tab").nth(t).waitFor();
      const screen = page.locator('[role="tabpanel"]:not([hidden]) .xterm-screen');
      await page.locator('[role="tabpanel"]:not([hidden]) .xterm-rows').getByText("perf-site").first().waitFor({
        timeout: 30_000,
      });
      await screen.click();
      await page.keyboard.type(process.platform === "win32" ? "type big.txt" : "cat big.txt");
      await page.keyboard.press("Enter");
      await page.locator('[role="tabpanel"]:not([hidden]) .xterm-rows').getByText("kalcode-big-end").first().waitFor({
        timeout: 30_000,
      });
    }
    await page.keyboard.press("Control+Shift+E"); // leave the terminal so shortcuts reach KalCode
    await sleep(500);

    const tabs = page.getByRole("tab");
    const scenarios: Scenario[] = [
      {
        key: "nav.dashboard",
        setup: async (p) => {
          await nav(p, "Code").click();
          await p.getByRole("heading", { level: 1, name: "perf-site" }).waitFor();
        },
        run: (p) => measure(p, heading("Activity"), () => nav(p, "Activity").click()),
      },
      {
        key: "nav.codeReturn",
        setup: async (p) => {
          await nav(p, "Activity").click();
          await p.getByRole("heading", { level: 1, name: "Activity" }).waitFor();
        },
        // Visible = the workspace heading and the active terminal's history are back on screen.
        run: (p) => measure(p, visibleTerminalText("kalcode-big-end"), () => nav(p, "Code").click()),
      },
      {
        key: "terminal.tabSwitch",
        setup: async (p) => {
          await nav(p, "Code").click();
          await p.getByRole("heading", { level: 1, name: "perf-site" }).waitFor();
        },
        run: async (p, i) => {
          const tab = tabs.nth(i % 3 === 0 ? 1 : i % 3 === 1 ? 2 : 0);
          return measure(p, visibleTerminalText("kalcode-big-end"), () => tab.click());
        },
      },
      {
        key: "terminal.create",
        setup: async (p) => {
          await nav(p, "Code").click();
          await p.getByRole("heading", { level: 1, name: "perf-site" }).waitFor();
        },
        // Visible = the new tab exists and is selected (the process may still be starting).
        run: (p) =>
          measure(p, { kind: "count", selector: '[role="tab"]', count: 4 }, () =>
            p.getByRole("button", { name: "New terminal", exact: true }).click(),
          ),
        teardown: async (p) => {
          await p.locator('[role="tabpanel"]:not([hidden]) .xterm-rows').getByText("perf-site").first().waitFor({
            timeout: 30_000,
          });
          await p.keyboard.press("Control+Shift+E");
          await p.keyboard.press("Control+Shift+W");
          await p.getByRole("tab").nth(3).waitFor({ state: "detached", timeout: 30_000 });
          await sleep(300);
        },
      },
      {
        key: "palette.open",
        run: (p) =>
          measure(p, { kind: "selector", selector: '[role="dialog"] [cmdk-input]' }, () =>
            p.keyboard.press("Control+K"),
          ),
        teardown: async (p) => {
          await p.keyboard.press("Escape");
          await p.locator("[cmdk-input]").waitFor({ state: "detached" });
        },
      },
      {
        key: "palette.type",
        setup: async (p) => {
          await p.keyboard.press("Control+K");
          await p.locator("[cmdk-input]").waitFor();
        },
        run: async (p, i) => {
          const letter = "settings"[i % 8] ?? "s";
          return measure(p, { kind: "selector", selector: "[cmdk-input]" }, () => p.keyboard.press(letter));
        },
        teardown: async (p) => {
          await p.keyboard.press("Escape");
          await p.locator("[cmdk-input]").waitFor({ state: "detached" });
        },
      },
      {
        key: "nav.settings",
        setup: async (p) => {
          await nav(p, "Activity").click();
          await p.getByRole("heading", { level: 1, name: "Activity" }).waitFor();
        },
        run: (p) => measure(p, heading("Settings"), () => nav(p, "Settings").click()),
      },
      {
        key: "nav.threads",
        // Threads lives in the sidebar's More menu (#257): open it unmeasured, then time the pick.
        setup: async (p) => {
          await nav(p, "Activity").click();
          await p.getByRole("heading", { level: 1, name: "Activity" }).waitFor();
          await p
            .getByRole("navigation", { name: "Primary" })
            .getByRole("button", { name: /^More places/ })
            .click();
        },
        run: (p) =>
          measure(p, heading("Threads"), () => p.getByRole("menuitem", { name: "Threads", exact: true }).click()),
      },
      {
        key: "accountHub.open",
        run: (p) =>
          measure(p, { kind: "selector", selector: '[role="menu"]' }, () =>
            p.getByRole("navigation", { name: "Primary" }).locator('button[aria-haspopup="menu"]').last().click(),
          ),
        teardown: async (p) => {
          await p.keyboard.press("Escape");
          await p.locator('[role="menu"]').waitFor({ state: "detached" });
        },
      },
      {
        key: "menu.shellChooser",
        setup: async (p) => {
          await nav(p, "Code").click();
          await p.getByRole("heading", { level: 1, name: "perf-site" }).waitFor();
        },
        run: (p) =>
          measure(p, { kind: "selector", selector: '[role="menuitem"]' }, () =>
            p.getByRole("button", { name: "Choose a shell" }).click(),
          ),
        teardown: async (p) => {
          await p.keyboard.press("Escape");
          await p.locator('[role="menu"]').waitFor({ state: "detached" });
        },
      },
    ];

    for (const scenario of scenarios) {
      const entry: (typeof results)[string] = { nextPaintMs: [], visibleMs: [] };
      results[scenario.key] = entry;
      try {
        for (let i = 0; i < config.runs; i += 1) {
          await scenario.setup?.(page);
          await sleep(250); // let the previous interaction's background work settle
          const s = await scenario.run(page, i);
          entry.nextPaintMs.push(s.nextPaintMs);
          entry.visibleMs.push(s.visibleMs);
          await scenario.teardown?.(page);
        }
        const v = summarize(entry.visibleMs);
        const n = summarize(entry.nextPaintMs);
        log(
          `${scenario.key}: visible p50 ${round(v.median)} p95 ${round(v.p95)} · next paint p50 ${round(n.median)} p95 ${round(n.p95)} ms`,
        );
      } catch (error) {
        entry.error = error instanceof Error ? error.message.split("\n")[0] : String(error);
        log(`${scenario.key}: FAILED ${entry.error}`);
        await page.keyboard.press("Escape").catch(() => undefined);
      }
    }
  } catch (error) {
    const shot = resolve(args.out ?? join(REPO, "target/perf"), "failure.png");
    mkdirSync(resolve(shot, ".."), { recursive: true });
    await app.page.screenshot({ path: shot }).catch(() => undefined);
    log(`failure screenshot: ${shot}`);
    throw error;
  } finally {
    await close(app, probe).catch(() => undefined);
    removeDir(dataDir);
    removeDir(projectRoot);
  }

  const summary = Object.fromEntries(
    Object.entries(results).map(([key, r]) => {
      if (r.visibleMs.length === 0) return [key, { error: r.error }];
      const v = summarize(r.visibleMs);
      const n = summarize(r.nextPaintMs);
      return [
        key,
        {
          n: v.n,
          visibleP50: round(v.median),
          visibleP95: round(v.p95),
          nextPaintP50: round(n.median),
          nextPaintP95: round(n.p95),
          ...(r.error ? { error: r.error } : {}),
        },
      ];
    }),
  );
  const out = {
    kind: "kalcode-interactions",
    createdAt: new Date().toISOString(),
    label: config.label,
    platform: platformKey(),
    machine: machineInfo(),
    exe: config.exe,
    runs: config.runs,
    summary,
    samples: results,
  };
  const stamp = out.createdAt.replace(/[:.]/g, "-");
  const outDir = resolve(args.out ?? join(REPO, "target/perf", `interactions-${out.platform}-${stamp}`));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "interactions.json"), `${JSON.stringify(out, null, 2)}\n`);
  console.table(summary);
  log(`wrote ${join(outDir, "interactions.json")}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});
