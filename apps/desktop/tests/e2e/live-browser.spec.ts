import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect, type Page } from "@playwright/test";
import {
  closeGracefully,
  EXE,
  inServiceSession,
  launch,
  PORT,
  removeDir,
  SERVICE_SESSION_SKIP,
  test,
} from "./harness.ts";

test.skip(process.platform !== "win32", "Real-app E2E drives WebView2 and runs on Windows.");
test.skip(!existsSync(EXE), `Build the app first: ${EXE}`);

/**
 * Live Browser on the real WebView2 child: the page helper reports console and load errors, the
 * element picker returns the clicked element, screenshots are real PNGs, and a denied sign-in
 * pop-up is surfaced with its URL (pop-ups stay denied; the page never gains KalCode IPC).
 */

interface BrowserState {
  url: string;
  title: string | null;
  blockedPopup?: string | null;
  debugPort?: number;
}

function invoke<T>(page: Page, command: string, args: Record<string, unknown> = {}): Promise<T> {
  return page.evaluate(
    async ([cmd, value]) => {
      try {
        return await (
          window as unknown as { __TAURI_INTERNALS__: { invoke: (name: string, payload: unknown) => Promise<unknown> } }
        ).__TAURI_INTERNALS__.invoke(cmd, value);
      } catch (error) {
        throw new Error(typeof error === "string" ? error : JSON.stringify(error));
      }
    },
    [command, args] as const,
  ) as Promise<T>;
}

async function state(page: Page, browserId: string): Promise<BrowserState> {
  const pageLease = await invoke<number>(page, "browser_page_lease");
  return invoke<BrowserState>(page, "browser_info", { browserId, pageLease });
}

/** Native state once the child is ready (a starting child answers `browser_starting`). */
async function readyState(page: Page, browserId: string): Promise<BrowserState | null> {
  try {
    return await state(page, browserId);
  } catch {
    return null;
  }
}

async function fixture(): Promise<{ server: Server; origin: string }> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/missing.png") {
      response.writeHead(404).end();
      return;
    }
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    response.end(`<!doctype html><html><head><title>Live Fixture</title>
      <style>body{font:16px system-ui;margin:0;padding:40px}button{font-size:18px;padding:14px 22px;margin:8px}</style>
      </head><body>
      <h1>Checkout</h1>
      <img src="/missing.png" alt="">
      <button id="pay" class="pay primary" onclick="window.__payClicked = true">Pay now</button>
      <button id="google" onclick="window.open('https://accounts.google.com/o/oauth2/v2/auth?client_id=kalcode-e2e&response_type=code&scope=email&redirect_uri=http://127.0.0.1/cb', 'signin', 'width=480,height=640')">Sign in with Google</button>
      <script>console.error("Checkout failed: cart is undefined");</script>
      </body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind");
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

test("Live Browser reads page errors, picks elements, captures screenshots and surfaces pop-ups", async () => {
  test.skip(inServiceSession(), SERVICE_SESSION_SKIP);
  test.setTimeout(240_000);
  const web = await fixture();
  const dataDir = mkdtempSync(join(tmpdir(), "kalcode-e2e-live-browser-"));
  const root = mkdtempSync(join(tmpdir(), "kalcode-e2e-live-browser-project-"));
  const project = join(root, "live-site");
  mkdirSync(project);
  writeFileSync(join(project, "README.md"), "# live browser fixture\n");
  let app: Awaited<ReturnType<typeof launch>> | null = null;
  try {
    app = await launch(dataDir, { KALCODE_E2E_PICK_FOLDER: project, KALCODE_E2E_BROWSER_CDP_BASE: String(PORT + 140) });
    const page = app.page;
    await expect(page.getByRole("heading", { level: 1, name: "Activity" })).toBeVisible();
    await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Code", exact: true }).click();
    await page.getByRole("button", { name: /Open folder/ }).click();
    await expect(page.getByRole("heading", { level: 1, name: "live-site" })).toBeVisible();
    await page.getByRole("button", { name: "Open Browser" }).click();
    const pane = page.locator("[data-browser-id]").first();
    const id = (await pane.getAttribute("data-browser-id")) as string;
    await pane.getByLabel("Web address").fill(`${web.origin}/checkout`);
    await pane.getByLabel("Web address").press("Enter");
    await expect.poll(async () => (await readyState(page, id))?.title, { timeout: 30_000 }).toBe("Live Fixture");

    // The capability-free helper reports the console error and the failed image load.
    await expect(pane.getByRole("button", { name: /console error/ })).toBeVisible({ timeout: 15_000 });
    await expect(pane.getByRole("button", { name: /console error/ })).toHaveAttribute("aria-label", "2 console errors");
    await pane.getByRole("button", { name: "2 console errors" }).click();
    await expect(pane.getByRole("region", { name: "Console errors" })).toContainText(
      "Checkout failed: cart is undefined",
    );
    await expect(pane.getByRole("region", { name: "Console errors" })).toContainText("missing.png");

    // Picking: the person clicks a real element in the WebView2 page.
    const debugPort = (await state(page, id)).debugPort as number;
    const child = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
    const remote = child
      .contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => candidate.url().startsWith(web.origin));
    if (!remote) throw new Error("The Live Browser page was not exposed to the E2E CDP session.");
    await pane.getByRole("button", { name: "Pick an element" }).click();
    await expect(pane.getByText("Click any element on the page.")).toBeVisible();
    await expect
      .poll(() => remote.evaluate(() => document.querySelectorAll("[aria-hidden='true']").length))
      .toBeGreaterThan(0);
    await remote.click("#pay");
    const ask = pane.getByRole("region", { name: "Ask an agent about this page" });
    await expect(ask.getByText("#pay")).toBeVisible({ timeout: 10_000 });
    // The pick was swallowed: the page's own click handlers never saw it.
    expect(await remote.evaluate(() => (window as unknown as { __payClicked?: boolean }).__payClicked ?? false)).toBe(
      false,
    );

    // Screenshot: a real PNG in the run's own data root (E2E never writes to Pictures).
    await ask.getByRole("button", { name: "Add screenshot" }).click();
    await expect(ask.getByText("Screenshot", { exact: true })).toBeVisible({ timeout: 15_000 });
    const shots = join(dataDir, "browser-screenshots");
    const files = readdirSync(shots).filter((name) => name.endsWith(".png"));
    expect(files).toHaveLength(1);
    const bytes = readFileSync(join(shots, files[0] as string));
    expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(bytes.length).toBeGreaterThan(2_000);
    await ask.getByRole("button", { name: "Close Ask Agent" }).click();

    // A sign-in pop-up stays denied; Live Browser names it and offers the system browser.
    await remote.click("#google");
    await expect(pane.getByText("accounts.google.com wants to open a sign-in window.")).toBeVisible({
      timeout: 10_000,
    });
    expect((await state(page, id)).blockedPopup).toContain("https://accounts.google.com/o/oauth2/v2/auth");
    await expect(pane.getByRole("button", { name: "Continue in browser" })).toBeVisible();
    expect(
      child
        .contexts()
        .flatMap((context) => context.pages())
        .filter((candidate) => candidate.url().includes("accounts.google.com")),
    ).toHaveLength(0);
    await child.close();
  } finally {
    if (app) await closeGracefully(app).catch(() => undefined);
    web.server.closeAllConnections?.();
    await new Promise<void>((resolve) => web.server.close(() => resolve()));
    removeDir(dataDir);
    removeDir(root);
  }
});
