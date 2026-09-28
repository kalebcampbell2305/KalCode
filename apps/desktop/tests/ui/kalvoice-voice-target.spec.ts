import { mkdirSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page, test } from "@playwright/test";

/**
 * 0.1.5 TK-2 against the in-memory transport (`?scenario=threads`): a focused thread composer is
 * KalVoice's fixed target, every voice send goes through that composer's own Send, "Which one?"
 * is a non-modal choice. (The palette's threads-by-name group is a Stable-only fallback for the
 * Session Locator; see CommandPalette.threads.stable.test.tsx.) The fake recognizer "hears"
 * what `__kalcodeMemory.kalvoice.setTranscript` sets before each push to talk.
 * Screenshots go to KV_B3_SHOTS when set (reviews), else to the test's output folder.
 */
const PARSER = "Write Unit Tests for Parser Module";
const OAUTH = "Fix OAuth Callback Race";
const DARK_MODE = "Add Dark Mode Toggle";

const widget = (page: Page): Locator => page.getByRole("region", { name: "KalVoice widget" });
const list = (page: Page) => page.getByRole("list", { name: "Threads" });
const detail = (page: Page) => page.getByRole("region", { name: "Thread", exact: true });
const composer = (page: Page) => detail(page).getByRole("textbox", { name: "Message" });
const conversation = (page: Page) => page.getByRole("list", { name: "Conversation" });
const choices = (page: Page) => page.locator("[data-kalvoice-choice]");

function shot(name: string): string {
  const dir = process.env.KV_B3_SHOTS ?? test.info().outputPath();
  mkdirSync(dir, { recursive: true });
  return join(dir, name);
}

async function hears(page: Page, text: string) {
  await page.evaluate((next) => {
    (
      window as unknown as { __kalcodeMemory: { kalvoice: { setTranscript: (t: string) => void } } }
    ).__kalcodeMemory.kalvoice.setTranscript(next);
  }, text);
}

/** Push to talk: hold F8 (optionally check what shows while listening), then release. */
async function talk(page: Page, text: string, whileListening?: () => Promise<void>) {
  await hears(page, text);
  await page.keyboard.down("F8");
  await expect(widget(page).getByText("Listening", { exact: true })).toBeVisible();
  await whileListening?.();
  await page.waitForTimeout(250);
  await page.keyboard.up("F8");
  await expect(widget(page).getByText(/^(Done|Error)$/)).toBeVisible();
}

async function openThreads(page: Page) {
  await page.goto("/?scenario=threads");
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Threads" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Threads" })).toBeVisible();
}

async function openThread(page: Page, name: string) {
  const primary = page.getByRole("navigation", { name: "Primary" });
  if (!(await page.getByRole("heading", { level: 1, name: "Threads" }).isVisible())) {
    await primary.getByRole("button", { name: "Threads" }).click();
  }
  await list(page)
    .getByRole("button", { name: new RegExp(name) })
    .click();
  await expect(detail(page).getByRole("heading", { name })).toBeVisible();
}

/** Nothing focused: native routes a push to talk as a command, never dictation. */
async function blur(page: Page) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

test.describe("KalVoice thread composer target", () => {
  test("dictates into the focused thread only and names the target while listening", async ({ page }) => {
    await openThreads(page);
    await openThread(page, PARSER);
    await composer(page).click();

    await talk(page, "cover the empty input case", async () => {
      const hint = detail(page).getByText(`KALVOICE TARGET · Claude Code · ${PARSER} · Personal`);
      await expect(hint).toBeVisible();
      await expect(hint).toHaveAttribute("aria-live", "polite");
      const serious = (
        await new AxeBuilder({ page }).include("[data-kalvoice-target]").withTags(["wcag2a", "wcag2aa"]).analyze()
      ).violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      expect(serious).toEqual([]);
      await page.screenshot({ path: shot("kalvoice-target-hint.png") });
    });

    await expect(composer(page)).toHaveValue("cover the empty input case");
    await expect(detail(page).getByText(/KALVOICE TARGET/)).toHaveCount(0);
    await expect(conversation(page)).not.toContainText("cover the empty input case");

    await openThread(page, OAUTH);
    await expect(composer(page)).toHaveValue("");
  });

  test("“send that” uses the composer's own Send; “clear that” empties it without sending", async ({ page }) => {
    await openThreads(page);
    await openThread(page, PARSER);
    await composer(page).click();
    await talk(page, "add a fuzz test for nested lists");
    await expect(composer(page)).toHaveValue("add a fuzz test for nested lists");

    await talk(page, "send that");
    await expect(conversation(page)).toContainText("add a fuzz test for nested lists");
    await expect(composer(page)).toHaveValue("");

    await composer(page).click();
    await talk(page, "and one for escapes");
    await expect(composer(page)).toHaveValue("and one for escapes");
    await talk(page, "clear that");
    await expect(composer(page)).toHaveValue("");
    await expect(conversation(page)).not.toContainText("and one for escapes");
  });

  test("“tell <name> to …” sends to that thread; a waiting thread is refused", async ({ page }) => {
    await openThreads(page);
    await openThread(page, OAUTH);
    await blur(page);

    await talk(page, "tell parser module to Add a test for tabs.");
    await expect(detail(page).getByRole("heading", { name: PARSER })).toBeVisible();
    await expect(conversation(page)).toContainText("Add a test for tabs.");

    await blur(page);
    await talk(page, "tell dark mode toggle to go ahead");
    await expect(detail(page).getByRole("heading", { name: DARK_MODE })).toBeVisible();
    await expect(
      widget(page).getByText("Messages can be sent once the permission decision is made.").first(),
    ).toBeVisible();
    await expect(conversation(page)).not.toContainText("go ahead");
  });

  test("an ambiguous name asks which one; the choice (clicked or spoken) follows up", async ({ page }) => {
    await openThreads(page);
    await openThread(page, OAUTH);
    await blur(page);

    await talk(page, "tell claude to run the linter");
    await expect(choices(page)).toBeVisible();
    await expect(choices(page).getByRole("button", { name: `${PARSER} · Claude Code · Personal` })).toBeVisible();
    await expect(choices(page).getByRole("button", { name: `${OAUTH} · Claude Code · Personal` })).toBeVisible();
    await page.screenshot({ path: shot("kalvoice-session-clarification.png") });
    // Non-modal: the page stays usable while the question is up.
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await talk(page, "the parser one");
    await expect(choices(page)).toHaveCount(0);
    await expect(detail(page).getByRole("heading", { name: PARSER })).toBeVisible();
    await expect(conversation(page)).toContainText("run the linter");

    await blur(page);
    await talk(page, "tell claude to update the changelog");
    await choices(page)
      .getByRole("button", { name: `${OAUTH} · Claude Code · Personal` })
      .click();
    await expect(detail(page).getByRole("heading", { name: OAUTH })).toBeVisible();
    await expect(conversation(page)).toContainText("update the changelog");
  });

  test("“Type it instead” lands in the thread that was focused, not the one on screen", async ({ page }) => {
    await openThreads(page);
    await openThread(page, PARSER);
    await composer(page).click();
    await talk(page, "open dashboard");
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();

    // The person opens another thread before undoing; every composer shares one DOM id.
    await openThread(page, OAUTH);
    await widget(page).getByRole("button", { name: "Type it instead" }).click();

    await expect(detail(page).getByRole("heading", { name: PARSER })).toBeVisible();
    await expect(composer(page)).toHaveValue("open dashboard");
    await openThread(page, OAUTH);
    await expect(composer(page)).toHaveValue("");
  });
});
