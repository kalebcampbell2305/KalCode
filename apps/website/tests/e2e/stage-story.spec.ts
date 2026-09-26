import { expect, type Locator, type Page, test } from "@playwright/test";

/** ScrollStory: pinned stage on desktop; stills on phones and with reduced motion. */
const STAGE_URL = process.env.STAGE_URL ?? "/product";

async function open(page: Page): Promise<Locator> {
  await page.goto(STAGE_URL);
  const story = page.getByTestId("scroll-story");
  await expect(story).toBeAttached();
  return story;
}

async function toStep(story: Locator, id: string): Promise<void> {
  await story.getByTestId(`story-step-${id}`).evaluate((el) => el.scrollIntoView({ block: "center" }));
}

test.describe("ScrollStory on desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("the pinned window builds up step by step", async ({ page }) => {
    const story = await open(page);
    const app = story.locator(".kc-story__stage [data-kc-app]");
    await story.scrollIntoViewIfNeeded();
    await expect(app).toBeVisible();
    await expect(story.getByTestId("still-shell")).toBeHidden();

    await toStep(story, "claude");
    await expect(app).toHaveAttribute("data-panes", "claude-checkout");
    await toStep(story, "codex");
    await expect(app).toHaveAttribute("data-count", "2");
    await toStep(story, "browser");
    await expect(app).toHaveAttribute("data-dock", "browser");
    await toStep(story, "dashboard");
    await expect(app).toHaveAttribute("data-dock", "dashboard");
    await toStep(story, "approval");
    await expect(app).toHaveAttribute("data-approval", "approved", { timeout: 5000 });
    await toStep(story, "voice");
    await expect(app.getByTestId("kalvoice-state")).toHaveText("Done", { timeout: 8000 });
    await toStep(story, "command");
    await expect(app).toHaveAttribute("data-count", "4", { timeout: 8000 });
    await toStep(story, "mission");
    await expect(app.getByTestId("mission")).toHaveAttribute("data-stage", "5", { timeout: 8000 });
    await expect(app.getByTestId("mission")).toContainText("3 checks passed");
    await expect(story.getByTestId("story-step-mission")).toHaveAttribute("data-active", "true");
  });

  test("scrolling back settles the earlier scene", async ({ page }) => {
    const story = await open(page);
    const app = story.locator(".kc-story__stage [data-kc-app]");
    await toStep(story, "dashboard");
    await expect(app).toHaveAttribute("data-dock", "dashboard");
    await toStep(story, "claude");
    await expect(app).toHaveAttribute("data-dock", "none");
    await expect(app).toHaveAttribute("data-count", "1");
  });

  test("every step caption is a heading with a truth tag", async ({ page }) => {
    const story = await open(page);
    await expect(story.locator(".kc-step__title")).toHaveCount(9);
    await expect(story.locator(".kc-step__tag")).toHaveCount(9);
    await expect(story.getByTestId("story-step-mission").locator(".kc-step__tag")).toHaveText("Planned");
  });
});

test.describe("ScrollStory on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("no pinning: each step shows a still", async ({ page }) => {
    const story = await open(page);
    await expect(story.locator(".kc-story__stage")).toBeHidden();
    for (const id of ["shell", "claude", "codex", "browser", "dashboard", "approval", "voice", "command", "mission"]) {
      await expect(story.getByTestId(`still-${id}`)).toBeVisible();
    }
  });

  test("Play replays a still's micro-animation", async ({ page }) => {
    const story = await open(page);
    const step = story.getByTestId("story-step-mission");
    await step.scrollIntoViewIfNeeded();
    await step.getByRole("button", { name: /Play step/ }).click();
    await expect(story.getByTestId("still-mission").getByTestId("mission")).toHaveAttribute("data-stage", "5", {
      timeout: 6000,
    });
  });
});

test.describe("ScrollStory with reduced motion", () => {
  test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });

  test("static stills with all content visible, no pinned stage, no Play buttons", async ({ page }) => {
    const story = await open(page);
    await expect(story.locator(".kc-story__stage")).toBeHidden();
    await expect(story.getByTestId("still-approval")).toBeVisible();
    await expect(story.getByTestId("still-mission")).toContainText("3 checks passed");
    await expect(story.locator(".kc-still__replay").first()).toBeHidden();
  });
});
