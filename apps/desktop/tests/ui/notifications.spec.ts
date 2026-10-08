import { expect, type Page, test } from "@playwright/test";
import { expectNoSeriousA11yViolations } from "./a11y.ts";

/**
 * Needs you: the notification history (Z7-W3) under the live attention items, against the
 * in-memory transport, whose notifications are derived from recorded events with the same wording
 * and policy as `crates/notifications`.
 */

async function open(page: Page, scenario = "busy") {
  await page.goto(`/?scenario=${scenario}`);
  await expect(page.getByRole("heading", { level: 1, name: "Activity" })).toBeVisible();
}

const bell = (page: Page) =>
  page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^Needs you/ });
const center = (page: Page) => page.getByRole("dialog", { name: "Needs you" });
const summary = (page: Page) => center(page).locator("#notifications-description");

/** The history's unread count, as the open sheet's summary states it (then closes the sheet). */
async function expectUnread(page: Page, count: number) {
  if (!(await center(page).isVisible())) await bell(page).click();
  if (count === 0) await expect(summary(page)).not.toContainText("unread");
  else await expect(summary(page)).toContainText(`${count} unread ${count === 1 ? "update" : "updates"}`);
  await page.keyboard.press("Escape");
  await expect(center(page)).toHaveCount(0);
}
const item = (page: Page, title: string) => center(page).getByRole("article", { name: new RegExp(title) });
/** The button that opens a notification (its title, read or unread). */
const opener = (page: Page, title: string) =>
  item(page, title).getByRole("button", { name: new RegExp(`^(Unread: )?${title}$`) });

/** Mirrors `fixtureId` in src/ipc/memory/dashboard.ts. */
function fixtureId(kind: number, n: number): string {
  const hex = (value: number, width: number) => value.toString(16).padStart(width, "0").slice(-width);
  return `01999a4e-${hex(kind, 4)}-7${hex(n, 3)}-8a2e-${hex(kind * 4096 + n, 12)}`;
}

type Memory = {
  dashboard: { setThreadStatus(id: string, status: string, activity?: string | null): void };
  simulate(event: unknown, options?: unknown): void;
};

async function memory(page: Page, fn: string, ...args: unknown[]) {
  await page.evaluate(
    ([name, params]) => {
      const m = (window as unknown as { __kalcodeMemory: Memory }).__kalcodeMemory;
      if (name === "setThreadStatus") m.dashboard.setThreadStatus(...(params as [string, string, string | null]));
      else m.simulate(...(params as [unknown, unknown]));
    },
    [fn, args] as const,
  );
}

test("lists what finished, failed and needs permission, with an unread count", async ({ page }) => {
  await open(page);
  // The sidebar counts the canonical live state: two approvals, a question, one ownership
  // collision, the failed agent and Operation, and two finished agents awaiting review.
  await expect(bell(page)).toHaveAccessibleName("Needs you, 8 waiting");
  await bell(page).click();
  const live = center(page).getByRole("region", { name: "Needs you now" });
  await expect(live.getByRole("listitem")).toHaveCount(8);
  await expect(
    live.getByRole("listitem", {
      name: /Blocked:\s*Fix flaky checkout test and Write invoices migration changed the same files/,
    }),
  ).toContainText("apps/web/checkout/cart.ts");
  await expect(live.getByRole("listitem", { name: /Failed:\s*Package desktop failed/ })).toContainText("Operations");
  await expect(summary(page)).toContainText("4 unread updates");
  await expect(center(page).getByRole("article")).toHaveCount(4);
  await expect(item(page, "Refactor auth middleware needs your permission")).toContainText("Install zod");
  await expect(item(page, "Deploy preview build failed")).toContainText("Gemini CLI exited unexpectedly");
  await expect(item(page, "Add light theme tokens completed")).toContainText("Claude Code · kalcode");
  await expect(center(page).getByRole("heading", { name: "Today" })).toBeVisible();
});

test("opening a notification marks it read and focuses its agent in Code", async ({ page }) => {
  await open(page);
  await bell(page).click();
  await opener(page, "Deploy preview build failed").click();
  await expect(center(page)).toHaveCount(0);
  // The fixture's threads are coding agents: they open in Code, never Threads.
  await expect(
    page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Code", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { level: 1, name: "Threads" })).toHaveCount(0);
  await expectUnread(page, 3);
  // Unread state is kept by the native store: reopening shows it read.
  await bell(page).click();
  await expect(
    item(page, "Deploy preview build failed").getByRole("button", { name: "Deploy preview build failed", exact: true }),
  ).toBeVisible();
  await expect(item(page, "Add light theme tokens completed").getByRole("button", { name: /^Unread: / })).toBeVisible();
});

test("a thread that completes live raises a notification and announces it", async ({ page }) => {
  await open(page);
  await memory(page, "setThreadStatus", fixtureId(2, 2), "completed", "Finished: tests pass");
  await expectUnread(page, 5);
  await expect(page.getByTestId("announce-notification")).toHaveText("Completed: Fix flaky checkout test completed");
  const done = page.getByRole("region", { name: "Agents" }).getByRole("article", { name: "Fix flaky checkout test" });
  await expect(done.getByText("Done", { exact: true })).toBeVisible();
  await bell(page).click();
  await expect(item(page, "Fix flaky checkout test completed")).toBeVisible();
});

test("answering the approval elsewhere settles its permission notice", async ({ page }) => {
  await open(page);
  const refactor = page
    .getByRole("region", { name: "Agents" })
    .getByRole("article", { name: "Refactor auth middleware" });
  await refactor.getByRole("button", { name: "Approve once" }).click();
  await expectUnread(page, 3);
});

test("a provider signing out and a crash recovery link to where they can be handled", async ({ page }) => {
  await open(page);
  await memory(
    page,
    "simulate",
    { type: "provider.disconnected", payload: { providerId: "claude-code", accountLabel: null } },
    {},
  );
  // The recovery leaves the thread Interrupted, as the native runtime does (12 already is); the
  // simulated core events below raise the notification.
  await memory(page, "setThreadStatus", fixtureId(2, 9), "interrupted", null);
  for (const n of [9, 12]) {
    await memory(
      page,
      "simulate",
      {
        type: "thread.status_changed",
        payload: {
          threadId: fixtureId(2, n),
          from: "active",
          to: "interrupted",
          detail: "KalCode closed while this thread was running",
        },
      },
      { source: "core" },
    );
  }
  await bell(page).click();
  await expect(item(page, "2 threads can be resumed")).toBeVisible();
  await opener(page, "2 threads can be resumed").click();
  // Recovered threads are Interrupted: STOPPED in the shared agent state (`agentStateOf`), which the
  // Fleet files under Done, so the notification opens Done and both recovered agents are in it.
  await expect(
    page.getByRole("group", { name: "Filter agents" }).getByRole("button", { name: /^Done/ }),
  ).toHaveAttribute("aria-pressed", "true");
  const fleet = page.getByRole("region", { name: "Agents" });
  for (const name of ["Draft release notes", "Migrate logger to structured output"]) {
    await expect(fleet.getByRole("article", { name })).toBeVisible();
  }
  await bell(page).click();
  await opener(page, "Claude Code is signed out").click();
  await expect(page.getByRole("heading", { level: 1, name: "Providers" })).toBeVisible();
});

test("mark all read, unread filter, mark unread and dismiss", async ({ page }) => {
  await open(page);
  await bell(page).click();
  await center(page)
    .getByRole("radio", { name: /Unread/ })
    .click();
  await expect(center(page).getByRole("article")).toHaveCount(4);
  await center(page).getByRole("button", { name: "Mark all read" }).click();
  await expect(center(page).getByRole("heading", { name: "Nothing unread" })).toBeVisible();
  await expect(summary(page)).not.toContainText("unread");
  await center(page).getByRole("radio", { name: "All" }).click();
  await center(page).getByRole("button", { name: "Mark “Add light theme tokens completed” unread" }).click();
  await expect(center(page).getByText("1 unread")).toBeVisible();
  await center(page).getByRole("button", { name: "Dismiss “Add light theme tokens completed”" }).click();
  await expect(item(page, "Add light theme tokens completed")).toHaveCount(0);
  await expectUnread(page, 0);
});

test("keyboard: the center opens from the sidebar, traps focus and returns it on close", async ({ page }) => {
  await open(page);
  await bell(page).focus();
  await page.keyboard.press("Enter");
  await expect(center(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(center(page)).toHaveCount(0);
  await expect(bell(page)).toBeFocused();
});

for (const theme of ["dark", "light"] as const) {
  test(`the notification center passes axe in ${theme} theme`, async ({ page }) => {
    await open(page);
    if (theme === "light") {
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByRole("radiogroup", { name: "Theme" }).getByRole("radio", { name: "Light" }).click();
    }
    await bell(page).click();
    await expect(center(page).getByRole("article").first()).toBeVisible();
    await expectNoSeriousA11yViolations(page);
  });
}
