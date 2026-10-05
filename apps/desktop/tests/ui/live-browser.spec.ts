import { mkdirSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page, test } from "@playwright/test";

/**
 * Live Browser in Code (in-memory runtime): opened beside a coding agent, Local / Preview /
 * Production targets, console errors, element picking, screenshots, Ask Agent through the agent's
 * terminal, and the honest sign-in pop-up fallback. Review screenshots go to qa/screenshots.
 * The native page is stood in for by a static mock painted where WebView2/WKWebView would draw.
 */
const OUT = new URL("../../qa/screenshots/", import.meta.url);
mkdirSync(OUT, { recursive: true });

const panes = (page: Page) => page.locator("[data-pane-id]:not([hidden])");
const browserPane = (page: Page) => page.locator("[data-browser-id]").first();
const agentText = (page: Page) => page.locator("[data-provider-pane] [data-pane-terminal] .xterm-rows").first();

async function shot(page: Page, name: string) {
  // No stray hover tooltips in review shots.
  await page.mouse.move(2, 600);
  await page.waitForTimeout(250);
  await page.screenshot({ path: new URL(`${name}.png`, OUT).pathname.replace(/^\/([A-Za-z]:)/, "$1") });
}

/** Runs `fn` against the in-memory Browser hooks (`MemoryBrowserHooks` in browserBridge.ts). */
async function hooks<T>(page: Page, fn: string): Promise<T> {
  return page.evaluate(`(${fn})(window.__kalcodeMemory.browser)`) as Promise<T>;
}

/**
 * Paints a realistic page where the native webview would draw (the in-memory build has none).
 * The axe scan covers it, so its colours meet WCAG AA like any page we'd show off.
 */
async function paintMockPage(page: Page) {
  await browserPane(page)
    .locator('button[aria-label^="Browser"]')
    .evaluate((viewport) => {
      viewport.querySelector("[data-mock-page]")?.remove();
      const mock = document.createElement("div");
      mock.dataset.mockPage = "";
      mock.style.cssText =
        "position:absolute;inset:0;overflow:hidden;background:#f7f8fb;color:#0f172a;font:14px/1.5 Inter,Segoe UI,system-ui,sans-serif;text-align:left;pointer-events:none;";
      mock.innerHTML = `
        <div style="display:flex;align-items:center;gap:18px;padding:14px 28px;background:#fff;border-bottom:1px solid #e5e7eb">
          <div style="display:flex;align-items:center;gap:8px;font-weight:700"><span style="width:22px;height:22px;border-radius:7px;background:linear-gradient(135deg,#7c3aed,#2563eb)"></span>Acme Studio</div>
          <span style="color:#64748b">Projects</span><span style="color:#64748b">Billing</span><span style="color:#64748b">Team</span>
          <span style="margin-left:auto;width:30px;height:30px;border-radius:50%;background:#e2e8f0"></span>
        </div>
        <div style="padding:30px 28px 0">
          <div style="font-size:12px;font-weight:600;color:#7c3aed;letter-spacing:.06em;text-transform:uppercase">Checkout</div>
          <div style="margin-top:6px;font-size:26px;font-weight:700;letter-spacing:-.02em">Upgrade to Studio Pro</div>
          <div style="margin-top:6px;color:#475569;max-width:460px">Unlimited projects, preview deployments and priority builds for your whole team.</div>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:14px;margin-top:22px">
            <div style="padding:16px;border-radius:12px;background:#fff;border:1px solid #e5e7eb"><div style="color:#64748b;font-size:12px">Plan</div><div style="font-weight:700;font-size:18px">Pro · $24/mo</div></div>
            <div style="padding:16px;border-radius:12px;background:#fff;border:1px solid #e5e7eb"><div style="color:#64748b;font-size:12px">Seats</div><div style="font-weight:700;font-size:18px">5 members</div></div>
            <div style="padding:16px;border-radius:12px;background:#fff;border:1px solid #e5e7eb"><div style="color:#64748b;font-size:12px">Billing</div><div style="font-weight:700;font-size:18px">Monthly</div></div>
          </div>
          <div style="display:flex;gap:10px;margin-top:22px">
            <span style="padding:10px 18px;border-radius:10px;background:#e2e8f0;color:#475569;font-weight:600">Pay now</span>
            <span style="padding:10px 18px;border-radius:10px;border:1px solid #cbd5e1;font-weight:600;color:#334155">Compare plans</span>
          </div>
        </div>`;
      viewport.appendChild(mock);
    });
}

async function openLiveBrowserBesideAgent(page: Page, options: { roomy?: boolean } = {}) {
  await page.goto("/?scenario=code");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("radiogroup", { name: "Theme" }).getByRole("radio", { name: "Dark" }).click();
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Code", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "kalcode-site" })).toBeVisible();
  // Give Code the room a focused session has: the workspace and agent rails folded away.
  if (options.roomy) {
    await page.getByRole("button", { name: "Hide the workspace rail" }).click();
    // The agents rail follows the agents: a strip while none runs, opening on its own once one
    // works. Pin it folded the way a person does (open it, then Hide agents) so the agent this
    // spec launches doesn't reopen it mid-run.
    const strip = page.getByRole("complementary", { name: "Agents (collapsed)" });
    await expect(strip).toBeVisible();
    await strip.getByRole("button", { name: "Show agents", exact: true }).click();
    await page.getByRole("button", { name: "Hide agents", exact: true }).click();
    await expect(strip).toBeVisible();
  }

  // A real coding agent first (AGENTS.md: an agent is a provider terminal pane).
  await page.getByRole("button", { name: "Agent launch options", exact: true }).click();
  await page
    .getByRole("dialog", { name: "New agent" })
    .getByRole("button", { name: "Launch Claude Code agent" })
    .click();
  await expect(agentText(page)).toContainText("KalCode fake provider");
  await expect(panes(page)).toHaveCount(2);

  // Live Browser beside it: split the agent's pane and open the Browser there.
  await panes(page).nth(1).getByRole("button", { name: "Actions for pane 2" }).click();
  await page.getByRole("menuitem", { name: "Split right" }).click();
  await expect(panes(page)).toHaveCount(3);
  await panes(page).nth(2).getByRole("button", { name: "Open Browser" }).click();
  await expect(browserPane(page).getByRole("toolbar", { name: "Browser controls" })).toBeVisible();
  // The shell renders at once; the page state follows.
  await expect(browserPane(page).getByLabel("Web address")).toHaveValue("http://localhost:3000/");
  await expect(browserPane(page).getByRole("button", { name: "Ask Agent" })).toBeEnabled();
  // Give the terminals pane less room so the agent and its page lead.
  await panes(page).nth(0).getByRole("button", { name: "Actions for pane 1" }).click();
  await page.getByRole("menuitem", { name: "Collapse" }).click();
  // Menus hand focus back to their trigger; drop it so its tooltip doesn't linger.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Escape");
  const id = await browserPane(page).getAttribute("data-browser-id");
  if (!id) throw new Error("no browser id");
  return id;
}

/**
 * The beside-an-agent flow: targets, console errors, picking, Ask Agent through the agent's own
 * terminal. `capture` takes the review screenshots; the functional run passes none.
 */
async function askAgentBesideIt(page: Page, id: string, capture: (name: string) => Promise<void> = async () => {}) {
  const pane: Locator = browserPane(page);

  // Targets: Local is the dev server; Preview and Production come from Operations.
  await expect(pane.getByRole("button", { name: "Local" })).toHaveAttribute("aria-pressed", "true");
  await pane.getByRole("button", { name: "Production" }).click();
  await expect(pane.getByLabel("Web address")).toHaveValue("https://app.example.test/");
  await expect(pane.getByRole("button", { name: "Production" })).toHaveAttribute("aria-pressed", "true");
  await pane.getByRole("button", { name: "Local" }).click();
  await expect(pane.getByLabel("Web address")).toHaveValue("http://localhost:3000/");

  // Console errors appear as a badge the moment the page reports them.
  await hooks(
    page,
    `(b) => b.setErrors(${JSON.stringify(id)}, ["TypeError: Cannot read properties of undefined (reading 'total') at Checkout.tsx:42", "Failed to load img http://localhost:3000/plan-badge.svg"])`,
  );
  await expect(pane.getByRole("button", { name: "2 console errors" })).toBeVisible();
  await capture("live-browser-beside-agent-dark-1440");

  await pane.getByRole("button", { name: "2 console errors" }).click();
  await expect(pane.getByRole("region", { name: "Console errors" })).toContainText("Checkout.tsx:42");
  await capture("live-browser-console-errors-dark-1440");

  // Pick an element on the page, then ask the agent about it with a screenshot attached.
  await pane.getByRole("button", { name: "Pick an element" }).click();
  await expect(pane.getByText("Click any element on the page.")).toBeVisible();
  await capture("live-browser-picking-dark-1440");
  await hooks(
    page,
    `(b) => b.pickElement(${JSON.stringify(id)}, { selector: "main > div.actions > button.pay", tag: "button", text: "Pay now", html: '<button class="pay" disabled>Pay now</button>' })`,
  );
  const ask = pane.getByRole("region", { name: "Ask an agent about this page" });
  await expect(ask.getByText("button.pay")).toBeVisible();
  await ask.getByRole("button", { name: "Add screenshot" }).click();
  await expect(ask.getByText("Screenshot", { exact: true })).toBeVisible();
  await expect(ask.getByLabel("Agent", { exact: true })).toHaveValue(/.+/);
  await ask.getByLabel("Question", { exact: true }).fill("Why is Pay now disabled when the plan is selected?");
  await capture("live-browser-ask-agent-dark-1440");

  await ask.getByLabel("Question", { exact: true }).press("Enter");
  await expect(pane.getByText(/^Sent to /u)).toBeVisible();
  // The prompt went through the agent's own terminal input path.
  await expect(agentText(page)).toContainText("Why is Pay now disabled");
}

test.describe("Live Browser", () => {
  test("works beside an agent: targets, errors, pick, Ask Agent, and passes axe", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const id = await openLiveBrowserBesideAgent(page, { roomy: true });
    await askAgentBesideIt(page, id);

    // The pane as a person sees it: chrome, panels and the page standing in for the webview.
    await paintMockPage(page);
    const results = await new AxeBuilder({ page })
      .include("[data-browser-id]")
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(serious.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target.join(" ")) }))).toEqual([]);
  });

  test("@screenshots works beside an agent: targets, errors, pick, screenshot, Ask Agent", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const id = await openLiveBrowserBesideAgent(page, { roomy: true });
    await askAgentBesideIt(page, id, async (name) => {
      await paintMockPage(page);
      await shot(page, name);
    });
  });

  test("@screenshots a sign-in pop-up is explained and continues in the system browser", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const id = await openLiveBrowserBesideAgent(page, { roomy: true });
    const pane = browserPane(page);
    await hooks(
      page,
      `(b) => b.blockPopup(${JSON.stringify(id)}, "https://accounts.google.com/o/oauth2/v2/auth?client_id=demo")`,
    );
    await expect(pane.getByText("accounts.google.com wants to open a sign-in window.")).toBeVisible();
    await paintMockPage(page);
    await shot(page, "live-browser-google-signin-dark-1440");
    await pane.getByRole("button", { name: "Continue in browser" }).click();
    await expect.poll(() => hooks<string[]>(page, "(b) => b.opened()")).toEqual(["http://localhost:3000/"]);
  });

  test("@screenshots stays usable in a narrow window", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 700 });
    await openLiveBrowserBesideAgent(page);
    const pane = browserPane(page);
    await expect(pane.getByRole("button", { name: "Ask Agent" })).toBeVisible();
    await expect(pane.getByRole("button", { name: "Take screenshot" })).toBeVisible();
    await paintMockPage(page);
    await shot(page, "live-browser-beside-agent-dark-1024");
  });
});
