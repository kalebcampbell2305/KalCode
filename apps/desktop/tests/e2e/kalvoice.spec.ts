import { copyFileSync, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { ACCOUNT_KALVOICE_FIXTURE_OPT_IN, closeGracefully, EXE, launch, removeDir } from "./harness.ts";

/**
 * KalVoice in the real app (native commands, the signal channel, SQLite ledger and
 * preferences). Build with `--features e2e,kalvoice-whisper` for the speech engine checks.
 * The microphone is never opened here: push-to-talk routing is driven through the native
 * `kalvoice_talk` command with a transcript, exactly what the app sends after the key is
 * released. Set KALVOICE_E2E_MODEL to an installed `ggml-tiny.en.bin` to exercise the "model
 * installed" path without downloading it again.
 *
 * This isolated profile has no local reasoning runtime. Requests needing it fail closed,
 * remain uncounted, and never start a connected provider session.
 */
const MODEL = process.env.KALVOICE_E2E_MODEL;

test.skip(process.platform !== "win32", "Real-app E2E drives WebView2 and runs on Windows.");
test.skip(!existsSync(EXE), `Build the app first: ${EXE}`);

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
    let app = await launch(dataDir, { KALCODE_E2E_ACCOUNT_FIXTURE: ACCOUNT_KALVOICE_FIXTURE_OPT_IN });
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

    await invoke(page, "kalvoice_preferences_update", { patch: { intelligence: { kind: "local" } } });

    // Push-to-talk routing in the native core: a confident command runs and counts; words
    // spoken into a text box are dictation and never count; anything else is a request.
    const command = await talk(page, "Open the dashboard", "field");
    expect(command.route).toBe("command");
    expect(command.response?.counted).toBe(true);
    const dictation = await talk(page, "add a unit test for the parser", "field");
    expect(dictation).toMatchObject({ route: "dictation", response: null });
    const request = await talk(page, "plan the migration to postgres", "none");
    expect(request.route).toBe("request");

    expect(request.response?.outcome).toMatchObject({ kind: "failed", code: "local_reasoning_unavailable" });
    expect(request.response?.counted).toBe(false);

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
    await closeGracefully(app);

    app = await launch(dataDir, { KALCODE_E2E_ACCOUNT_FIXTURE: ACCOUNT_KALVOICE_FIXTURE_OPT_IN });
    page = app.page;
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible({ timeout: 20_000 });
    await expect(widget(page)).toHaveAttribute("data-anchor", "top_left");
    await page.getByRole("button", { name: "KalVoice", exact: true }).click();
    // The typed command, the spoken one and the approval request counted; dictation and the
    // request without a local runtime did not.
    await expect(
      page.locator("#kalvoice-status").getByText(/^415 \/ 1,500 used · 1,085 remaining · renews/),
    ).toBeVisible();
    await page.getByRole("button", { name: "Dashboard" }).click();
    const activity = page.getByRole("region", { name: "Activity" });
    await expect(activity.getByText("KalVoice ran a command").first()).toBeVisible();
    await expect(activity.getByText("KalVoice heard a command").first()).toBeVisible();
    // Activity never shows what was said.
    await expect(activity.getByText(/unit test for the parser/i)).toHaveCount(0);
    await closeGracefully(app);
  } finally {
    try {
      removeDir(dataDir);
    } catch {
      // WebView2 can hold its folder briefly after exit; the OS temp cleanup removes it.
    }
  }
});
