import { expect, type Page, test } from "@playwright/test";

/**
 * The Command Deck shell: top bar (workspace, branch, environment, mode, command, signals), the
 * projects rail, the agents rail and the status strip — on the Stable channel, where the projects
 * list stands in for the gated workspace rail.
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
const strip = (page: Page) => page.getByRole("contentinfo");

test("the deck answers what is working, what needs me and what is shipping", async ({ page }) => {
  await open(page, "busy");
  await toOperations(page);
  await expect(bar(page).getByRole("button", { name: "3 agents working. Show agents" })).toBeVisible();
  await expect(bar(page).getByRole("button", { name: /^\d+ things need you$/ })).toBeVisible();

  const rail = agents(page);
  await expect(rail.getByRole("heading", { name: /^Needs you/ })).toBeVisible();
  await expect(rail.getByRole("button", { name: /^Refactor auth middleware, Needs approval/ })).toBeVisible();
  await expect(rail.getByRole("heading", { name: /^Working/ })).toBeVisible();

  await expect(strip(page).getByRole("button", { name: /^Build status: Failed/ })).toBeVisible();
  await expect(strip(page).getByRole("button", { name: /^Test status: / })).toBeVisible();
  await expect(strip(page).getByRole("button", { name: /^Provider status: / })).toBeVisible();
  await expect(strip(page).getByRole("button", { name: /^Shipping status: Production/ })).toBeVisible();

  // A status segment opens where that work lives.
  await strip(page)
    .getByRole("button", { name: /^Provider status: / })
    .click();
  await expect(page.getByRole("heading", { level: 1, name: "Providers" })).toBeVisible();
});

test("an agent row opens its thread", async ({ page }) => {
  await open(page, "threads");
  await toOperations(page);
  await agents(page)
    .getByRole("button", { name: /^Fix OAuth Callback Race, / })
    .click();
  await expect(page.getByRole("heading", { level: 1, name: "Threads" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Thread", exact: true })).toContainText("Fix OAuth Callback Race");
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
  await expect(projects.getByRole("button", { name: "kalcode-site" })).toHaveAttribute("aria-current", "true");
  await expect(bar(page).getByRole("button", { name: "Workspace kalcode-site" })).toBeVisible();
  await expect(bar(page).getByRole("button", { name: /^Branch feature\/oauth-race/ })).toBeVisible();

  await projects.getByRole("button", { name: "api-server" }).click();
  await expect(page.getByRole("main")).toHaveAttribute("data-surface", "code");
  await expect(bar(page).getByRole("button", { name: "Workspace api-server" })).toBeVisible();
  await expect(projects.getByRole("button", { name: "api-server" })).toHaveAttribute("aria-current", "true");
});

test("the mode chip sets the permission mode new threads start in", async ({ page }) => {
  await open(page, "busy");
  await bar(page)
    .getByRole("button", { name: /^Permission mode: Approve/ })
    .click();
  // Choose only once the menu is open: a click while it opens can be dropped on a loaded machine.
  const menu = page.getByRole("menu", { name: /^Permission mode/ });
  await expect(menu).toBeVisible();
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
