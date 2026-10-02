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

test("the provider dock shows each account and takes a dragged thread after asking", async ({ page }) => {
  await open(page, "busy");
  await toOperations(page);
  const dock = strip(page).getByRole("group", { name: "Provider accounts" });
  await expect(dock.getByRole("button").first()).toBeVisible();
  const chips = dock.getByRole("button");
  expect(await chips.count()).toBeGreaterThanOrEqual(2);

  // A real pointer drag from an agent row onto an account of the same provider.
  const row = agents(page).getByRole("button", { name: /^Refactor auth middleware/ });
  const name = (await row.getAttribute("aria-label")) ?? "";
  const provider = /, (Claude Code|Codex|Gemini CLI) in /.exec(name)?.[1] ?? "Claude Code";
  const target = dock.getByRole("button", { name: new RegExp(`^${provider} · `) }).last();
  const from = await row.boundingBox();
  const to = await target.boundingBox();
  if (!from || !to) throw new Error("dock or agent row not laid out");
  await page.mouse.move(from.x + 20, from.y + 10);
  await page.mouse.down();
  await page.mouse.move(from.x + 60, from.y + 60, { steps: 4 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
  await expect(page.getByText(/^(Move to |Already uses|Answer its|Working.|Waiting to|Not a )/).first()).toBeVisible();
  await page.mouse.up();
  // Either the confirmation opens, or the dock says why that account can't take the thread.
  await expect(
    page
      .getByRole("alertdialog", { name: "Rebind thread?" })
      .or(page.getByText(/can't take “Refactor auth middleware”/)),
  ).toBeVisible();
  // The drop never opened the row's thread on its own.
  await expect(page.getByRole("heading", { level: 1, name: "Operations" })).toBeVisible();
});
