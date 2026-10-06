import { mkdirSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { expectNoSeriousA11yViolations } from "./a11y.ts";
import { goTo } from "./nav.ts";

/**
 * Z7-W0 design system: every restyled surface passes axe (WCAG 2.2 AA, incl. colour contrast) in
 * both themes, and the review screenshots at the Z7 window sizes. Screenshots only run with
 * `--grep @screenshots`; output: apps/desktop/qa/screenshots/w0/.
 */
const MOD = process.platform === "darwin" ? "Meta" : "Control";

async function open(page: Page, scenario: string, theme: "dark" | "light") {
  await page.goto(scenario ? `/?scenario=${scenario}` : "/");
  // A returning user with an active workspace is sent to Code once restore finishes; choose
  // Dashboard explicitly so the check never races that redirect.
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("button", { name: "Activity", exact: true })
    .click();
  await expect(page.getByRole("heading", { level: 1, name: "Activity" })).toBeVisible();
  await page.keyboard.press(`${MOD}+k`);
  await page.keyboard.type(`use ${theme} theme`);
  await page.keyboard.press("Enter");
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}

/** Opens a place from the sidebar (Code and Activity directly, other surfaces through More). */
const nav = (page: Page, name: string) => goTo(page, name);

type Scene = { name: string; run: (page: Page, theme: "dark" | "light") => Promise<void> };

const SCENES: Scene[] = [
  {
    name: "dashboard-busy",
    run: async (page, theme) => {
      await open(page, "busy", theme);
    },
  },
  {
    name: "dashboard-empty",
    run: async (page, theme) => {
      await open(page, "empty", theme);
    },
  },
  {
    name: "approvals",
    run: async (page, theme) => {
      await open(page, "approvals", theme);
      await page
        .getByRole("navigation", { name: "Primary" })
        .getByRole("button", { name: /^Needs you/ })
        .click();
      await page
        .getByRole("dialog", { name: "Needs you" })
        .getByRole("button", { name: /^Review: / })
        .first()
        .click();
      await expect(page.getByRole("dialog", { name: "Approvals" }).getByRole("region").first()).toBeVisible();
    },
  },
  {
    name: "code",
    run: async (page, theme) => {
      await open(page, "code", theme);
      await nav(page, "Code");
      await expect(page.getByRole("tab").first()).toBeVisible();
    },
  },
  {
    name: "threads-waiting",
    run: async (page, theme) => {
      await open(page, "threads", theme);
      await nav(page, "Threads");
      // The thread row itself, not its "Pin globally: …" favorite button (#235).
      await page
        .getByRole("list", { name: "Threads" })
        .locator("[data-thread-row]")
        .filter({ hasText: "Add Dark Mode Toggle" })
        .click();
      await expect(page.getByText("Waiting for 1 permission decision")).toBeVisible();
    },
  },
  {
    name: "threads-new",
    run: async (page, theme) => {
      await open(page, "threads", theme);
      await nav(page, "Threads");
      await page.getByRole("button", { name: "New thread" }).first().click();
      await expect(page.getByRole("region", { name: "New thread" })).toBeVisible();
    },
  },
  {
    name: "providers",
    run: async (page, theme) => {
      await open(page, "", theme);
      await nav(page, "Providers");
      await page.getByRole("tab", { name: "Setup" }).click();
      await expect(page.getByText("Installed, version 2.1.282")).toBeVisible();
    },
  },
  {
    name: "settings",
    run: async (page, theme) => {
      await open(page, "approvals", theme);
      await nav(page, "Settings");
    },
  },
  {
    name: "kalvoice",
    run: async (page, theme) => {
      await open(page, "", theme);
      await nav(page, "KalVoice");
    },
  },
  {
    name: "gated",
    run: async (page, theme) => {
      await open(page, "", theme);
      await nav(page, "Agents");
    },
  },
];

// One test per scene, never one test looping all ten: each scene is a fresh boot plus a full axe
// scan (contrast on every text node), so ten in one budget ran 1.3-2.2 min on a loaded gate and
// timed out in whichever scan crossed 120 s, on both gate machines.
test.describe("Z7-W0 design system accessibility", () => {
  for (const theme of ["dark", "light"] as const) {
    for (const scene of SCENES) {
      test(`${scene.name} passes axe in ${theme} theme`, async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await scene.run(page, theme);
        await expectNoSeriousA11yViolations(page, `${scene.name} (${theme})`);
      });
    }
  }
});

/** Applies a resolved appearance mode the way appearance.ts does, after a scene has opened. */
async function mode(page: Page, attrs: { contrast?: "more"; textSize?: "large" | "larger" }) {
  await page.evaluate((next) => {
    if (next.contrast) document.documentElement.dataset.contrast = next.contrast;
    if (next.textSize) document.documentElement.dataset.textSize = next.textSize;
  }, attrs);
}

test.describe("appearance modes", () => {
  test("Settings switches contrast and text size, and the whole UI follows", async ({ page }) => {
    await page.goto("/");
    await nav(page, "Settings");
    const html = page.locator("html");
    await expect(html).toHaveAttribute("data-contrast", "standard");
    await page.getByRole("radiogroup", { name: "Contrast" }).getByRole("radio", { name: "High" }).click();
    await expect(html).toHaveAttribute("data-contrast", "more");
    // High contrast removes the atmosphere and thickens the focus ring.
    const tokens = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      return {
        stars: style.getPropertyValue("--atmosphere-stars").trim(),
        ring: style.getPropertyValue("--focus-ring-width").trim(),
      };
    });
    expect(tokens).toEqual({ stars: "none", ring: "3px" });

    await page.getByRole("radiogroup", { name: "Text size" }).getByRole("radio", { name: "Larger" }).click();
    await expect(html).toHaveAttribute("data-text-size", "larger");
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe("20px");

    await page.getByRole("radiogroup", { name: "Text size" }).getByRole("radio", { name: "Default" }).click();
    await expect(html).not.toHaveAttribute("data-text-size", /./);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe("16px");
  });

  test("the command palette toggles high contrast", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
    await page.keyboard.press(`${MOD}+k`);
    await page.keyboard.type("use high contrast");
    await page.keyboard.press("Enter");
    await expect(page.locator("html")).toHaveAttribute("data-contrast", "more");
  });

  // Per scene, like the theme checks above.
  for (const theme of ["dark", "light"] as const) {
    for (const scene of SCENES) {
      test(`${scene.name} passes axe in ${theme} high contrast`, async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await scene.run(page, theme);
        await mode(page, { contrast: "more" });
        await expectNoSeriousA11yViolations(page, `${scene.name} (${theme}, high contrast)`);
      });
    }
  }

  for (const scene of SCENES) {
    test(`${scene.name} passes axe at the larger text size`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await scene.run(page, "dark");
      await mode(page, { textSize: "larger" });
      await expectNoSeriousA11yViolations(page, `${scene.name} (larger text)`);
    });
  }
});

const SIZES = [
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
  { width: 3440, height: 1440 },
] as const;

const OUT = new URL("../../qa/screenshots/w0/", import.meta.url);

for (const theme of ["dark", "light"] as const) {
  test(`@screenshots Z7-W0 surfaces in ${theme} theme at the Z7 window sizes`, async ({ page }) => {
    test.setTimeout(600_000);
    mkdirSync(OUT, { recursive: true });
    for (const size of SIZES) {
      await page.setViewportSize(size);
      for (const scene of SCENES) {
        await scene.run(page, theme);
        await page.waitForTimeout(200);
        await page.screenshot({
          path: new URL(`${scene.name}-${theme}-${size.width}.png`, OUT).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
        });
      }
    }
  });
}

test("@screenshots appearance modes: high contrast and larger text", async ({ page }) => {
  test.setTimeout(300_000);
  mkdirSync(OUT, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  const variants = [
    { suffix: "dark-hc", theme: "dark", attrs: { contrast: "more" } },
    { suffix: "light-hc", theme: "light", attrs: { contrast: "more" } },
    { suffix: "dark-larger", theme: "dark", attrs: { textSize: "larger" } },
  ] as const;
  for (const variant of variants) {
    for (const scene of SCENES) {
      await scene.run(page, variant.theme);
      await mode(page, variant.attrs);
      await page.waitForTimeout(200);
      await page.screenshot({
        path: new URL(`${scene.name}-${variant.suffix}-1440.png`, OUT).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
      });
    }
  }
});
