import { expect, type Page, test } from "@playwright/test";

/**
 * The Command Deck shell: top bar (workspace, branch, environment, mode, command, signals), the
 * projects rail and the agents rail — on the Stable channel, where the projects list stands in for
 * the gated workspace rail. There is no bottom status strip: the deck body runs to the window edge.
 */
const MOD = process.platform === "darwin" ? "Meta" : "Control";

async function open(page: Page, scenario: string) {
  await page.goto(`/?scenario=${scenario}&channel=stable`);
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" }).first()).toBeVisible();
}

/** Leaves the Dashboard (where the rail starts as its strip) for a surface that shows it. */
async function toOperations(page: Page) {
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Operations" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Operations" })).toBeVisible();
}

const bar = (page: Page) => page.getByRole("banner");
const agents = (page: Page) => page.getByRole("complementary", { name: "Agents" });

test("the deck answers what is working, what needs me and what is shipping", async ({ page }) => {
  await open(page, "busy");
  await toOperations(page);
  await expect(bar(page).getByRole("button", { name: "3 agents working. Show agents" })).toBeVisible();
  await expect(bar(page).getByRole("button", { name: /^\d+ things need you$/ })).toBeVisible();

  const rail = agents(page);
  await expect(rail.getByRole("heading", { name: /^Needs you/ })).toBeVisible();
  await expect(rail.getByRole("button", { name: /^Refactor auth middleware, Needs approval/ })).toBeVisible();
  await expect(rail.getByRole("heading", { name: /^Working/ })).toBeVisible();
});

test("no bottom status strip: the page and the agents rail reach the window's bottom edge", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, "busy");
  await toOperations(page);
  await expect(page.getByRole("contentinfo")).toHaveCount(0);
  await expect(page.getByRole("group", { name: "Provider accounts" })).toHaveCount(0);
  for (const region of [page.locator("main#main"), agents(page)]) {
    const box = await region.boundingBox();
    if (!box) throw new Error("deck region not laid out");
    expect(Math.abs(box.y + box.height - 900)).toBeLessThanOrEqual(1);
  }
});

test("an agent row opens its coding terminal in Code, and a chat thread is never an agent", async ({ page }) => {
  // The threads scenario has chat threads only: none of them is an agent.
  await open(page, "threads");
  await toOperations(page);
  await expect(agents(page).getByText("No agents running")).toBeVisible();
  await expect(agents(page).getByRole("button", { name: /^Fix OAuth Callback Race, / })).toHaveCount(0);

  // Launch a Claude Code agent from Code's + launcher.
  await page.evaluate(() =>
    (window as unknown as { __kalcodeMemory: { queueFolders: (...f: string[]) => void } }).__kalcodeMemory.queueFolders(
      "deck-agent",
    ),
  );
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Code", exact: true }).click();
  await page.getByRole("button", { name: "Open folder…" }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: "deck-agent" })).toBeVisible();
  await page.getByRole("button", { name: "New agent", exact: true }).click();
  await page
    .getByRole("dialog", { name: "New agent" })
    .getByRole("button", { name: "Launch Claude Code agent" })
    .click();
  await expect(page.locator("[data-provider-pane]")).toHaveCount(1);

  // It shows in the rail and opens its own terminal pane, not Threads.
  await toOperations(page);
  await agents(page).getByRole("button", { name: /^Idle/ }).click();
  await agents(page)
    .getByRole("button", { name: /^New agent, .*Claude Code in deck-agent\. Open agent$/ })
    .click();
  await expect(page.getByRole("heading", { level: 1, name: "deck-agent" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Threads" })).toHaveCount(0);
  await expect(page.locator("[data-provider-pane]")).toBeVisible();
});

test("the agents rail hides to a strip of live counts and is remembered", async ({ page }) => {
  await open(page, "busy");
  // On the Dashboard, whose board lists every agent, the rail is its strip until asked.
  const collapsed = page.getByRole("complementary", { name: "Agents (collapsed)" });
  await expect(collapsed.getByRole("button", { name: "3 working. Show agents" })).toBeVisible();
  await collapsed.getByRole("button", { name: "Show agents", exact: true }).click();
  await expect(agents(page)).toBeVisible();

  await toOperations(page);
  await agents(page).getByRole("button", { name: "Hide agents" }).click();
  await expect(collapsed).toBeVisible();
  await page.reload();
  await toOperations(page);
  await expect(collapsed).toBeVisible();
  // The top bar's working signal brings the rail back with focus in it.
  await bar(page)
    .getByRole("button", { name: /agents working\. Show agents$/ })
    .click();
  await expect(agents(page)).toBeFocused();
});

test("projects switch the workspace, and the top bar follows with its branch", async ({ page }) => {
  await open(page, "code");
  const projects = page.getByRole("region", { name: "Projects" });
  await expect(projects.getByRole("button", { name: "kalcode-site", exact: true })).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(bar(page).getByRole("button", { name: "Workspace kalcode-site" })).toBeVisible();
  await expect(bar(page).getByRole("button", { name: /^Branch feature\/oauth-race/ })).toBeVisible();

  await projects.getByRole("button", { name: "api-server", exact: true }).click();
  await expect(page.getByRole("main")).toHaveAttribute("data-surface", "code");
  await expect(bar(page).getByRole("button", { name: "Workspace api-server" })).toBeVisible();
  await expect(projects.getByRole("button", { name: "api-server", exact: true })).toHaveAttribute(
    "aria-current",
    "true",
  );
});

test("the mode chip sets the permission mode new threads start in", async ({ page }) => {
  await open(page, "busy");
  // New threads and agents start in Auto, the trusted coding default (#125).
  await bar(page)
    .getByRole("button", { name: /^Permission mode: Auto/ })
    .click();
  // Choose only once the menu is open: a click while it opens can be dropped on a loaded machine.
  const menu = page.getByRole("menu", { name: /^Permission mode/ });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitemradio", { name: /^Auto/ })).toHaveAttribute("aria-checked", "true");
  const plan = menu.getByRole("menuitemradio", { name: /^Plan/ });
  await expect(plan).toBeVisible();
  await plan.click();
  await expect(menu).toBeHidden();
  // The saved setting comes back from the runtime before the chip shows it.
  await expect(bar(page).getByRole("button", { name: /^Permission mode: Plan/ })).toBeVisible({ timeout: 10_000 });
});

test("the command field and its shortcut open the palette", async ({ page }) => {
  await open(page, "busy");
  await bar(page)
    .getByRole("button", { name: /Search or run a command/ })
    .click();
  await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press(`${MOD}+k`);
  await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
});
