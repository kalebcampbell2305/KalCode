import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, type Page } from "@playwright/test";
import {
  ACCOUNT_KALVOICE_FIXTURE_OPT_IN,
  closeGracefully,
  EXE,
  launch,
  processesMatching,
  RESOURCE_PROVIDER_FIXTURE_OPT_IN,
  removeDir,
  test,
  waitForProviderAdmission,
  writeManagedFakeProviderConfig,
} from "./harness.ts";

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
const FAKE = join(dirname(EXE), "kalcode-fake-provider.exe");

test.skip(process.platform !== "win32", "Real-app E2E drives WebView2 and runs on Windows.");
test.skip(!existsSync(EXE), `Build the app first: ${EXE}`);
test.skip(!existsSync(FAKE), "Run build:e2e: it builds the fake provider.");

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

function displayedPath(path: string, home = process.env.USERPROFILE ?? process.env.HOME ?? homedir()): string {
  const plain = (value: string) => (value.startsWith("\\\\?\\") ? value.slice(4) : value);
  const comparablePath = plain(path);
  const trimmedHome = plain(home).replace(/[\\/]+$/, "");
  if (trimmedHome.length === 0 || comparablePath.length < trimmedHome.length) return path;
  const head = comparablePath.slice(0, trimmedHome.length);
  const rest = comparablePath.slice(trimmedHome.length);
  const same = head.replaceAll("\\", "/").toLowerCase() === trimmedHome.replaceAll("\\", "/").toLowerCase();
  const atBoundary = rest.length === 0 || rest.startsWith("\\") || rest.startsWith("/");
  return same && atBoundary ? `~${rest}` : path;
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
  const root = mkdtempSync(join(tmpdir(), "kalcode-e2e-kalvoice-project-"));
  const project = join(root, "voice-site");
  mkdirSync(project);
  writeFileSync(join(project, "README.md"), "# KalVoice fixture\n");
  const bin = join(root, "bin");
  mkdirSync(bin);
  copyFileSync(FAKE, join(bin, "codex.exe"));
  writeManagedFakeProviderConfig(bin);
  const env = {
    KALCODE_E2E_ACCOUNT_FIXTURE: ACCOUNT_KALVOICE_FIXTURE_OPT_IN,
    KALCODE_E2E_PICK_FOLDER: project,
    KALCODE_E2E_RESOURCE_FIXTURE: RESOURCE_PROVIDER_FIXTURE_OPT_IN,
    PATH: `${bin};${process.env.PATH ?? ""}`,
  };
  if (MODEL) {
    mkdirSync(join(dataDir, "models", "whisper"), { recursive: true });
    copyFileSync(MODEL, join(dataDir, "models", "whisper", "ggml-tiny.en.bin"));
  }
  let app: Awaited<ReturnType<typeof launch>> | null = null;
  try {
    app = await launch(dataDir, env);
    let page = app.page;
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "Code", exact: true }).click();
    await page.getByRole("button", { name: /Open folder/ }).click();
    await expect(page.getByRole("heading", { level: 1, name: "voice-site" })).toBeVisible();
    const workspaces = await invoke<{ id: string; name: string }[]>(page, "workspace_list");
    expect(workspaces).toHaveLength(1);
    const workspaceId = workspaces[0]?.id as string;
    await expect(widget(page)).toBeVisible();
    if (MODEL) {
      await expect(shown(page).getByText("Ready", { exact: true })).toBeVisible();
    } else {
      // Without an installed model, zero-setup provisioning asks the signed catalog for this
      // build's channel. E2E builds compile as Development, which has no published catalog, so
      // the widget honestly reports speech as unavailable instead of Ready (never Ready early).
      await expect(shown(page).getByText("Speech unavailable", { exact: true })).toBeVisible();
    }
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

    // Deterministic app control has no second KalVoice approval layer. The two idle threads retain
    // Approve mode, so provider-native tool permissions remain authoritative when a CLI starts.
    await waitForProviderAdmission(page);
    const providers = await invoke<
      { id: string; detection: { state: string; displayPath: string | null; version: string | null } | null }[]
    >(page, "providers_detect");
    const codex = providers.find((provider) => provider.id === "codex");
    expect(codex?.detection?.state).toBe("installed");
    const fakePath = join(bin, "codex.exe");
    const expectedDisplayPath = displayedPath(realpathSync.native(fakePath));
    expect(expectedDisplayPath.startsWith("~")).toBe(true);
    expect(codex?.detection?.displayPath?.toLowerCase()).toBe(expectedDisplayPath.toLowerCase());
    expect(codex?.detection?.version).toBe("0.160.0");
    expect(await invoke<unknown[]>(page, "approval_list")).toEqual([]);
    const create = await talk(page, "open two codex threads", "none");
    expect(create.route).toBe("command");
    expect(create.response?.outcome.kind).toBe("completed");
    expect(create.response?.counted).toBe(true);
    expect(await invoke<unknown[]>(page, "approval_list")).toEqual([]);
    const createdThreads = () =>
      invoke<{ providerId: string; workspaceId: string; status: string; permissionMode: string }[]>(
        page,
        "thread_list",
        {
          workspaceId: null,
          includeArchived: false,
        },
      );
    await expect
      .poll(async () =>
        (await createdThreads()).map(({ providerId, workspaceId: threadWorkspace, status, permissionMode }) => ({
          providerId,
          workspaceId: threadWorkspace,
          status,
          permissionMode,
        })),
      )
      .toEqual([
        { providerId: "codex", workspaceId, status: "idle", permissionMode: "approve" },
        { providerId: "codex", workspaceId, status: "idle", permissionMode: "approve" },
      ]);
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
    await expect.poll(byRequest).toContain("kalvoice.command_executed");
    expect((await byRequest()).some((event) => event.startsWith("kalvoice.request_failed"))).toBe(false);

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const section = page.getByRole("region", { name: "KalVoice", exact: true });
    await expect(section.getByRole("button", { name: "Change the push-to-talk key" })).toBeVisible();
    await expect(section.locator("kbd", { hasText: "F8" })).toBeVisible();
    const fastest = section.getByRole("listitem").filter({ hasText: "English (fastest)" });
    if (MODEL) {
      await expect(fastest.getByText("In use")).toBeVisible();
    } else {
      // Zero-setup provisioning fetches the default model on its own (no Download button while it
      // runs or waits to retry). E2E builds compile as Development, which has no published
      // catalog, so the row honestly reports the automatic attempt and its retry.
      await expect(fastest.getByRole("status")).toHaveText(
        /^(Preparing: getting it from KalCode's signed component catalog\.|Couldn't download English \(fastest\): .+ KalCode retries .+\.)$/,
      );
      await expect(fastest.getByRole("button", { name: "Download" })).toHaveCount(0);
    }

    await widget(page).getByRole("button", { name: "Dock the widget" }).click();
    await page.getByRole("menuitemradio", { name: "Top left" }).click();
    await expect(widget(page)).toHaveAttribute("data-anchor", "top_left");
    await page.waitForTimeout(600);
    const firstRunFakePids = processesMatching(bin);
    await closeGracefully(app);
    app = null;
    await expect.poll(() => processesMatching(bin).filter((pid) => firstRunFakePids.includes(pid))).toEqual([]);

    app = await launch(dataDir, env);
    page = app.page;
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible({ timeout: 20_000 });
    await expect(widget(page)).toHaveAttribute("data-anchor", "top_left");
    await page.getByRole("button", { name: "KalVoice", exact: true }).click();
    // The signed baseline plus the typed local command, spoken local command and direct native
    // app-control command counted; dictation and focused-provider handoff did not.
    await expect(page.locator("#kalvoice-status").getByText(/^44 \/ 150 used · resets/)).toBeVisible();
    await page.getByRole("button", { name: "Dashboard" }).click();
    const activity = page.getByRole("region", { name: "Activity" });
    await expect(activity.getByText("KalVoice ran a command").first()).toBeVisible();
    await expect(activity.getByText("KalVoice heard a command").first()).toBeVisible();
    // Activity never shows what was said.
    await expect(activity.getByText(/unit test for the parser/i)).toHaveCount(0);
    await closeGracefully(app);
    app = null;
    expect(processesMatching(bin), "no provider process outlives KalCode").toEqual([]);
  } finally {
    if (app) await closeGracefully(app).catch(() => undefined);
    try {
      removeDir(dataDir);
    } catch {
      // WebView2 can hold its folder briefly after exit; the OS temp cleanup removes it.
    }
    removeDir(root);
  }
});
