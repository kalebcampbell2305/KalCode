import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { HandoffPreview, HandoffRecord } from "@kalcode/protocol";
import { expect, type Locator, type Page } from "@playwright/test";
import {
  ACCOUNT_KALVOICE_FIXTURE_OPT_IN,
  createAccountFixtureDataDir,
  EXE,
  killForcibly,
  launch,
  processesMatching,
  RESOURCE_PROVIDER_FIXTURE_OPT_IN,
  removeDir,
  test,
  waitForProviderAdmission,
  writeManagedFakeProviderConfig,
} from "./harness.ts";

// Real native IPC, SQLite, provider-pane PTYs, hook readiness, and restart recovery. The
// provider and Pro entitlement are signed, deterministic E2E fixtures; no AI service is called.
test.skip(process.platform !== "win32", "Real-app E2E drives Windows WebView2.");
const FAKE = join(dirname(EXE), "kalcode-fake-provider.exe");
const HELPER = join(dirname(EXE), "kalcode-hook.exe");
test.skip(!existsSync(EXE) || !existsSync(FAKE) || !existsSync(HELPER), "Run build:e2e first.");

const FAKE_BANNER = "KalCode fake provider (interactive)";

function invoke<T>(page: Page, command: string, args: Record<string, unknown> = {}): Promise<T> {
  return page.evaluate(
    ([name, payload]) =>
      (
        window as unknown as {
          __TAURI_INTERNALS__: { invoke: (command: string, args: unknown) => Promise<unknown> };
        }
      ).__TAURI_INTERNALS__.invoke(name, payload),
    [command, args] as const,
  ) as Promise<T>;
}

const codeNav = (page: Page) =>
  page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Code", exact: true });

function paneTerminal(pane: Locator): Locator {
  return pane.locator("[data-pane-terminal] .xterm-screen");
}

function paneRows(pane: Locator): Locator {
  return pane.locator("[data-pane-terminal] .xterm-rows");
}

async function submitLine(page: Page, pane: Locator, line: string): Promise<void> {
  await paneTerminal(pane).click();
  await page.keyboard.type(line);
  await page.keyboard.press("Enter");
}

async function readyAgent(page: Page, pane: Locator): Promise<void> {
  await submitLine(page, pane, "say handoff-ready");
  await expect(paneRows(pane)).toContainText("handoff-ready", { timeout: 30_000 });
  await expect(pane.locator("[data-pane-status]")).toContainText(/READY|IDLE/, { timeout: 30_000 });
}

async function listHandoffs(page: Page): Promise<HandoffRecord[]> {
  return invoke<HandoffRecord[]>(page, "handoff_list", { threadId: null });
}

async function findHandoff(page: Page, id: string): Promise<HandoffRecord | undefined> {
  return (await listHandoffs(page)).find((record) => record.id === id);
}

function countOccurrences(text: string | null, needle: string): number {
  return text ? text.split(needle).length - 1 : 0;
}

function expectRenderedContext(preview: HandoffPreview, payload: string): void {
  const header = preview.text.match(
    new RegExp(`^\\[KalCode context package ${preview.id} · 1 item\\(s\\) · boundary ([0-9a-f]{16})\\]\\n`),
  );
  expect(header, "the native preview uses the reviewed context-package envelope").not.toBeNull();
  const nonce = header?.[1];
  expect(nonce).toBeTruthy();
  expect(preview.text).toBe(
    `[KalCode context package ${preview.id} · 1 item(s) · boundary ${nonce}]\n` +
      `[item 1 · text · Agent handoff capsule]\n${payload}\n` +
      `[end item 1 · ${nonce}]\n`,
  );
}

test("handoffs deliver once, queue until ready, return explicit results, and interrupt on restart", async () => {
  test.setTimeout(300_000);
  const dataDir = createAccountFixtureDataDir();
  const root = mkdtempSync(join(tmpdir(), "kalcode-e2e-handoff-project-"));
  const project = join(root, "handoff-project");
  const bin = join(root, "bin");
  mkdirSync(project);
  mkdirSync(bin);
  writeFileSync(join(project, "README.md"), "# Native handoff E2E\n");
  copyFileSync(FAKE, join(bin, "claude.exe"));
  writeManagedFakeProviderConfig(bin);

  const env = {
    KALCODE_E2E_ACCOUNT_FIXTURE: ACCOUNT_KALVOICE_FIXTURE_OPT_IN,
    KALCODE_E2E_HOOK_DECISIONS: "engine",
    KALCODE_E2E_PICK_FOLDER: project,
    KALCODE_E2E_RESOURCE_FIXTURE: RESOURCE_PROVIDER_FIXTURE_OPT_IN,
    PATH: `${bin};${process.env.PATH ?? ""}`,
  };

  try {
    const app = await launch(dataDir, env);
    const page = app.page;
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
    await codeNav(page).click();
    await page.getByRole("button", { name: "Open folder…" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "handoff-project" })).toBeVisible();

    await waitForProviderAdmission(page);
    await page.getByRole("button", { name: "New agent", exact: true }).click();
    const launcher = page.getByRole("dialog", { name: "New agent" });
    await launcher.getByLabel("Agents", { exact: true }).fill("2");
    await launcher.getByRole("button", { name: "Launch 2 Claude Code agents", exact: true }).click();

    const panes = page.locator("[data-provider-pane]");
    await expect(panes).toHaveCount(2, { timeout: 30_000 });
    const source = panes.nth(0);
    const target = panes.nth(1);
    await expect(paneRows(source)).toContainText(FAKE_BANNER, { timeout: 30_000 });
    await expect(paneRows(target)).toContainText(FAKE_BANNER, { timeout: 30_000 });
    await readyAgent(page, source);
    await readyAgent(page, target);

    const sourceThreadId = await source.getAttribute("data-provider-pane");
    const targetThreadId = await target.getAttribute("data-provider-pane");
    expect(sourceThreadId).toBeTruthy();
    expect(targetThreadId).toBeTruthy();

    const deliveredMarker = "HANDOFF_E2E_DELIVER_EXACTLY_ONCE";
    const deliveredPayload = `${deliveredMarker}\nHANDOFF_E2E_MULTILINE_CONTEXT`;
    const initialPreview = await invoke<HandoffPreview>(page, "handoff_preview", {
      sourceThreadId,
      targetThreadId,
      task: "review",
      instructions: "This instruction is replaced by the reviewed context.",
      editedText: deliveredPayload,
      priorPreviewId: null,
    });
    expectRenderedContext(initialPreview, deliveredPayload);

    // Two foreground callers can contend with the background dispatcher. Both
    // must return the same authoritative record, without a second terminal write.
    const [delivered, concurrent] = await Promise.all([
      invoke<HandoffRecord>(page, "handoff_send", {
        id: initialPreview.id,
        previewHash: initialPreview.previewHash,
      }),
      invoke<HandoffRecord>(page, "handoff_send", {
        id: initialPreview.id,
        previewHash: initialPreview.previewHash,
      }),
    ]);
    expect(delivered.status).toBe("delivered");
    expect(concurrent.id).toBe(delivered.id);
    expect(concurrent.createdAt).toBe(delivered.createdAt);

    // A repeated send of the same durable preview returns the existing record and never writes
    // another prompt to the provider PTY.
    const repeated = await invoke<HandoffRecord>(page, "handoff_send", {
      id: initialPreview.id,
      previewHash: initialPreview.previewHash,
    });
    expect(repeated.id).toBe(delivered.id);
    expect(repeated.createdAt).toBe(delivered.createdAt);
    await expect(paneRows(target)).toContainText(deliveredMarker, { timeout: 30_000 });
    await expect
      .poll(() =>
        paneRows(target)
          .textContent()
          .then((text) => countOccurrences(text, deliveredMarker)),
      )
      .toBe(1);

    await expect(target.locator("[data-pane-status]")).toContainText(/READY|IDLE/, { timeout: 30_000 });
    const completed = await invoke<HandoffRecord>(page, "handoff_complete", {
      id: delivered.id,
      outcome: "completed",
      result: "The receiving agent recorded a focused review.\r\nNo findings.",
    });
    expect(completed.status).toBe("completed");
    expect(completed.result).toContain("focused review");
    expect(completed.result).toBe("The receiving agent recorded a focused review.\nNo findings.");

    const returned = await invoke<HandoffPreview>(page, "handoff_return", { id: completed.id });
    expect(returned.sourceThreadId).toBe(targetThreadId);
    expect(returned.targetThreadId).toBe(sourceThreadId);
    expect(returned.text).toContain("focused review");

    const returnMarker = "HANDOFF_E2E_RETURNED_FINDINGS";
    const reviewedReturn = await invoke<HandoffPreview>(page, "handoff_preview", {
      sourceThreadId: returned.sourceThreadId,
      targetThreadId: returned.targetThreadId,
      task: returned.task,
      instructions: "",
      editedText: returnMarker,
      priorPreviewId: returned.id,
    });
    expectRenderedContext(reviewedReturn, returnMarker);
    const returnedRecord = await invoke<HandoffRecord>(page, "handoff_send", {
      id: reviewedReturn.id,
      previewHash: reviewedReturn.previewHash,
    });
    expect(returnedRecord.status).toBe("delivered");
    expect(returnedRecord.returnOfId).toBe(completed.id);
    await expect(paneRows(source)).toContainText(returnMarker, { timeout: 30_000 });
    await expect(source.locator("[data-pane-status]")).toContainText(/READY|IDLE/, { timeout: 30_000 });

    // Pending local input is never overwritten. The durable row stays queued until the owner
    // submits that input and the next authenticated provider-ready boundary is observed.
    const queuedMarker = "HANDOFF_E2E_QUEUED_THEN_DELIVERED";
    await paneTerminal(target).click();
    await page.keyboard.type("say owner-input-finishes-first");
    const queuedPreview = await invoke<HandoffPreview>(page, "handoff_preview", {
      sourceThreadId,
      targetThreadId,
      task: "review",
      instructions: "",
      editedText: queuedMarker,
      priorPreviewId: null,
    });
    const queued = await invoke<HandoffRecord>(page, "handoff_send", {
      id: queuedPreview.id,
      previewHash: queuedPreview.previewHash,
    });
    expect(queued.status).toBe("queued");
    expect(queued.blocker).toMatch(/unsubmitted or unverified human input/i);
    await page.keyboard.press("Enter");
    await expect(paneRows(target)).toContainText(queuedMarker, { timeout: 30_000 });
    await expect
      .poll(async () => (await findHandoff(page, queued.id))?.status, { timeout: 30_000 })
      .toMatch(/^(delivered|working|needs_you)$/);

    // Crash with one more locally-blocked queued handoff. A fresh process keeps the audit row
    // but truthfully interrupts it because process-local capsule text is intentionally not replayed.
    await expect(target.locator("[data-pane-status]")).toContainText(/READY|IDLE/, { timeout: 30_000 });
    await paneTerminal(target).click();
    await page.keyboard.type("unfinished owner input");
    const restartPreview = await invoke<HandoffPreview>(page, "handoff_preview", {
      sourceThreadId,
      targetThreadId,
      task: "review",
      instructions: "",
      editedText: "HANDOFF_E2E_RESTART_MUST_NOT_REPLAY",
      priorPreviewId: null,
    });
    const pendingRestart = await invoke<HandoffRecord>(page, "handoff_send", {
      id: restartPreview.id,
      previewHash: restartPreview.previewHash,
    });
    expect(pendingRestart.status).toBe("queued");

    await killForcibly(app);
    const restarted = await launch(dataDir, env);
    await expect(restarted.page.getByRole("heading", { level: 1, name: "handoff-project" })).toBeVisible();
    const recovered = await findHandoff(restarted.page, pendingRestart.id);
    expect(recovered?.status).toBe("interrupted");
    expect(recovered?.blocker).toBe("KalCode restarted before this handoff was explicitly finished.");

    await killForcibly(restarted);
    expect(processesMatching(bin), "no fake provider process outlives the isolated app").toEqual([]);
  } finally {
    removeDir(dataDir);
    removeDir(root);
  }
});
