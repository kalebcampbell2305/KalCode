import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Browser, chromium, expect, type Page, test } from "@playwright/test";

/**
 * KalVoice in the real app (native commands, the signal channel, SQLite ledger and
 * preferences). Build with `--features e2e,kalvoice-whisper` for the speech engine checks.
 * The microphone is never opened here: push-to-talk routing is driven through the native
 * `kalvoice_talk` command with a transcript, exactly what the app sends after the key is
 * released. Set KALVOICE_E2E_MODEL to an installed `ggml-tiny.en.bin` to exercise the "model
 * installed" path without downloading it again.
 *
 * Provider quota is never used unless KALVOICE_E2E_REASONING=1: otherwise the suite first sets
 * KalVoice's reasoning to "on-device" (not available yet), so a request that needs reasoning is
 * refused before any provider session could start, whatever providers this machine has.
 */
const EXE = process.env.KALCODE_E2E_EXE ?? resolve(import.meta.dirname, "../../../../target/e2e/release/kalcode.exe");
const PORT = Number(process.env.KALCODE_E2E_CDP_PORT ?? 9438);
const MODEL = process.env.KALVOICE_E2E_MODEL;

test.skip(process.platform !== "win32", "Real-app E2E drives WebView2 and runs on Windows.");
test.skip(!existsSync(EXE), `Build the app first: ${EXE}`);

interface Running {
  child: ChildProcess;
  browser: Browser;
  page: Page;
}

const REASONING = process.env.KALVOICE_E2E_REASONING === "1";

async function launch(dataDir: string): Promise<Running> {
  const child = spawn(EXE, [], {
    env: {
      ...process.env,
      KALCODE_DATA_DIR: dataDir,
      WEBVIEW2_USER_DATA_FOLDER: join(dataDir, "webview"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    },
    stdio: "ignore",
  });
  const deadline = Date.now() + 30_000;
  let browser: Browser | null = null;
  while (!browser) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  const deadlineDb = Date.now() + 10_000;
  while (!existsSync(join(dataDir, "kalcode.db"))) {
    if (Date.now() > deadlineDb) {
      await browser.close();
      execFileSync("taskkill", ["/F", "/PID", String(child.pid)]);
      throw new Error(`${EXE} did not use the isolated data folder; build it with --features e2e`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  const context = browser.contexts()[0];
  if (!context) throw new Error("No WebView2 browser context");
  let page = context.pages().find((p) => !p.url().startsWith("devtools"));
  while (!page) page = await context.waitForEvent("page");
  return { child, browser, page };
}

async function close(app: Running) {
  await app.browser.close().catch(() => undefined);
  execFileSync("taskkill", ["/PID", String(app.child.pid)]);
  if (app.child.exitCode === null) await new Promise<void>((r) => app.child.once("exit", () => r()));
}

const widget = (page: Page) => page.getByRole("region", { name: "KalVoice widget" });
const shown = (page: Page) => widget(page).locator(':scope > :not([role="status"])');

interface TalkResult {
  route: "command" | "dictation" | "request";
  response: { requestId: string; counted: boolean; outcome: { kind: string; approvalRequestId?: string } } | null;
}

function invoke<T>(page: Page, command: string, args: Record<string, unknown> = {}): Promise<T> {
  return page.evaluate(
    ([cmd, a]) =>
      (
        window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a: unknown) => Promise<unknown> } }
      ).__TAURI_INTERNALS__.invoke(cmd, a),
    [command, args] as const,
  ) as Promise<T>;
}

/** What the app sends when the push-to-talk key is released (native routing, no audio). */
function talk(page: Page, text: string, target: "field" | "terminal" | "none"): Promise<TalkResult> {
  return page.evaluate(
    ([text, target]) => {
      const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a: unknown) => unknown } })
        .__TAURI_INTERNALS__;
      return internals.invoke("kalvoice_talk", {
        request: {
          requestId: crypto.randomUUID(),
          sessionId: crypto.randomUUID(),
          text,
          target,
          durationMs: 900,
          workspaceId: null,
        },
      }) as Promise<TalkResult>;
    },
    [text, target] as const,
  );
}

test("KalVoice runs natively; routing, usage and the widget's placement survive a restart", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "kalcode-e2e-kalvoice-"));
  if (MODEL) {
    mkdirSync(join(dataDir, "models", "whisper"), { recursive: true });
    copyFileSync(MODEL, join(dataDir, "models", "whisper", "ggml-tiny.en.bin"));
  }
  try {
    let app = await launch(dataDir);
    let page = app.page;
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible({ timeout: 20_000 });
    await expect(widget(page)).toBeVisible();
    await expect(shown(page).getByText("Ready", { exact: true })).toBeVisible();
    await expect(widget(page).getByRole("textbox")).toHaveCount(0);

    // A typed request on the KalVoice page.
    await page.getByRole("button", { name: "KalVoice", exact: true }).click();
    const input = page.getByRole("main").getByRole("textbox", { name: "Type a request for KalVoice" });
    await input.fill("Go to settings");
    await input.press("Enter");
    await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
    await expect(shown(page).getByText("Opened Settings.")).toBeVisible();

    if (!REASONING) {
      await invoke(page, "kalvoice_preferences_update", { patch: { intelligence: { kind: "local" } } });
    }

    // Push-to-talk routing in the native core: a confident command runs and counts; words
    // spoken into a text box are dictation and never count; anything else is a request.
    const command = await talk(page, "Open the dashboard", "field");
    expect(command.route).toBe("command");
    expect(command.response?.counted).toBe(true);
    const dictation = await talk(page, "add a unit test for the parser", "field");
    expect(dictation).toMatchObject({ route: "dictation", response: null });
    const request = await talk(page, "plan the migration to postgres", "none");
    expect(request.route).toBe("request");

    // Needs reasoning: runs on the user's own signed-in provider (their quota), so only when
    // explicitly allowed; otherwise reasoning is set to on-device, which isn't available yet.
    if (REASONING) {
      await page.getByRole("button", { name: "KalVoice", exact: true }).click();
      await input.fill("Summarize what KalVoice can do in one sentence");
      await input.press("Enter");
      await expect(shown(page).getByText(/^(Done|Error)$/)).toBeVisible({ timeout: 150_000 });
    } else {
      expect(request.response?.outcome.kind).toBe("needs_provider");
      expect(request.response?.counted).toBe(false);
    }

    // Each utterance's route is recorded (ids and the route only, never the words).
    const routed = await invoke<{ events: { payload: { requestId: string; outcome: string } }[] }>(
      page,
      "events_query",
      {
        query: {
          types: ["kalvoice.talk_routed"],
          correlation: {
            workspaceId: null,
            threadId: null,
            missionId: null,
            providerId: null,
            requestId: null,
            agentId: null,
            taskId: null,
            automationId: null,
            causationId: null,
          },
          afterSeq: null,
          beforeSeq: null,
          from: null,
          to: null,
          order: "asc",
          limit: 10,
        },
      },
    );
    expect(routed.events.map((e) => e.payload.outcome)).toEqual(["command", "dictation", "request"]);
    expect(JSON.stringify(routed.events)).not.toContain("parser");

    // A command that adds work is filed with the real permission engine as a KalVoice approval
    // (origin kalvoice, no thread, Approve once or Deny) and waits; the person's Deny, given
    // through the same approval_decide as the Approvals panel, reaches the widget.
    const create = await talk(page, "open two codex threads", "none");
    expect(create.route).toBe("command");
    expect(create.response?.outcome.kind).toBe("permission_required");
    expect(create.response?.counted).toBe(true);
    const approvalId = create.response?.outcome.approvalRequestId as string;
    const pending = await invoke<
      {
        id: string;
        permissionMode: string;
        allowedDecisions: string[];
        action: { threadId: string; origin: { kind: string; requestId: string } | null; summary: string };
      }[]
    >(page, "approval_list", { status: "pending" });
    const filed = pending.find((a) => a.id === approvalId);
    expect(filed).toMatchObject({
      permissionMode: "approve",
      allowedDecisions: ["deny", "approve_once"],
      action: {
        threadId: "",
        origin: { kind: "kalvoice", requestId: create.response?.requestId },
        summary: "Open 2 Codex threads",
      },
    });
    await invoke(page, "approval_decide", { requestId: approvalId, decision: "deny" });
    // KalVoice drops the command when the engine reports the denial (ids and codes only).
    const byRequest = () =>
      invoke<{ events: { type: string; payload: { code?: string } }[] }>(page, "events_query", {
        query: {
          types: ["kalvoice.*"],
          correlation: {
            workspaceId: null,
            threadId: null,
            missionId: null,
            providerId: null,
            requestId: create.response?.requestId,
            agentId: null,
            taskId: null,
            automationId: null,
            causationId: null,
          },
          afterSeq: null,
          beforeSeq: null,
          from: null,
          to: null,
          order: "asc",
          limit: 20,
        },
      }).then((p) => p.events.map((e) => `${e.type}${e.payload.code ? `:${e.payload.code}` : ""}`));
    await expect.poll(byRequest).toContain("kalvoice.request_failed:permission_denied");
    expect(await byRequest()).not.toContain("kalvoice.command_executed");
    expect(await invoke<unknown[]>(page, "thread_list", {})).toEqual([]);

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const section = page.getByRole("region", { name: "KalVoice", exact: true });
    await expect(section.getByRole("button", { name: "Change the push-to-talk key" })).toBeVisible();
    await expect(section.locator("kbd", { hasText: "F8" })).toBeVisible();
    const fastest = section.getByRole("listitem").filter({ hasText: "English (fastest)" });
    if (MODEL) {
      await expect(fastest.getByText("In use")).toBeVisible();
    } else {
      await expect(fastest.getByRole("button", { name: "Download" })).toBeVisible();
    }

    await widget(page).getByRole("button", { name: "Dock the widget" }).click();
    await page.getByRole("menuitemradio", { name: "Top left" }).click();
    await expect(widget(page)).toHaveAttribute("data-anchor", "top_left");
    await page.waitForTimeout(600);
    await close(app);

    app = await launch(dataDir);
    page = app.page;
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible({ timeout: 20_000 });
    await expect(widget(page)).toHaveAttribute("data-anchor", "top_left");
    await page.getByRole("button", { name: "KalVoice", exact: true }).click();
    // The typed command, the spoken one and the approval request counted; dictation and the
    // request without a provider didn't.
    await expect(
      page.locator("#kalvoice-status").getByText(REASONING ? /^Used [34] of 250 · resets/ : /^Used 3 of 250 · resets/),
    ).toBeVisible();
    await page.getByRole("button", { name: "Dashboard" }).click();
    const activity = page.getByRole("region", { name: "Activity" });
    await expect(activity.getByText("KalVoice ran a command").first()).toBeVisible();
    await expect(activity.getByText("KalVoice heard a command").first()).toBeVisible();
    // Activity never shows what was said.
    await expect(activity.getByText(/unit test for the parser/i)).toHaveCount(0);
    await close(app);
  } finally {
    try {
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
    } catch {
      // WebView2 can hold its folder briefly after exit; the OS temp cleanup removes it.
    }
  }
});
