import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect, type Page, test } from "@playwright/test";
import { closeGracefully, EXE, launch, PORT, removeDir } from "./harness.ts";

test.skip(process.platform !== "win32", "Real-app E2E drives WebView2 and runs on Windows.");
test.skip(!existsSync(EXE), `Build the app first: ${EXE}`);

interface BrowserState {
  browserId: string;
  workspaceId: string;
  url: string;
  title: string | null;
  loading: boolean;
  visible: boolean;
  bounds: { x: number; y: number; width: number; height: number };
  /** Present only in the E2E binary; production children never expose a debugging port. */
  debugPort?: number;
}

interface Fixture {
  server: Server;
  origin: string;
  requests: Map<string, number>;
  ipc: string[];
  cookies: Map<string, string>;
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

async function fixture(): Promise<Fixture> {
  const requests = new Map<string, number>();
  const ipc: string[] = [];
  const cookies = new Map<string, string>();
  const page = (title: string, marker: string) => `<!doctype html>
    <html><head><title>${title}</title></head><body>
      <main><h1>${marker}</h1><a href="/two">Next</a></main>
      <script>
        (async () => {
          let result = 'isolated';
          try {
            if (window.__TAURI_INTERNALS__) {
              await window.__TAURI_INTERNALS__.invoke('boot', {});
              result = 'granted';
            }
          } catch (_) { result = 'denied'; }
          fetch('/report?ipc=' + encodeURIComponent(result), { method: 'POST' }).catch(() => {});
        })();
      </script>
    </body></html>`;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    requests.set(url.pathname, (requests.get(url.pathname) ?? 0) + 1);
    if (url.pathname === "/report") {
      ipc.push(url.searchParams.get("ipc") ?? "missing");
      response.writeHead(204).end();
      return;
    }
    if (url.pathname === "/cookie-set") {
      response.setHeader("set-cookie", "isolated=A; Max-Age=86400; HttpOnly; SameSite=Lax; Path=/");
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end("<!doctype html><title>Cookie set</title><script>fetch('/cookie-echo?who=set')</script>");
      return;
    }
    if (url.pathname === "/cookie-echo") {
      cookies.set(url.searchParams.get("who") ?? "missing", request.headers.cookie ?? "");
      response.writeHead(204).end();
      return;
    }
    if (url.pathname === "/attachment") {
      response.setHeader("content-disposition", 'attachment; filename="kalcode-browser-unsafe.txt"');
      response.setHeader("content-type", "text/plain");
      response.end("download must be denied");
      return;
    }
    const redirects: Record<string, string> = {
      "/redirect-file": "file:///C:/Windows/win.ini",
      "/redirect-javascript": "javascript:document.body.textContent='unsafe'",
      "/redirect-data": "data:text/html,unsafe",
      "/redirect-custom": "kalcode-unsafe://open",
      "/redirect-credentials": `http://user:password@127.0.0.1:${(server.address() as { port: number }).port}/two`,
      "/redirect-http": "/two",
    };
    if (redirects[url.pathname]) {
      response.writeHead(302, { location: redirects[url.pathname] }).end();
      return;
    }
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    if (url.pathname === "/two") response.end(page("Fixture Two", "TWO"));
    else if (url.pathname === "/bidi") response.end(page("Trusted \u202e moc.live \u2066 x", "BIDI"));
    else if (url.pathname === "/security")
      response.end(`<!doctype html><html><head><title>Security Fixture</title></head><body>
      <a id="target-popup" target="_blank" href="/two">Target popup</a>
      <button id="script-popup" onclick="window.open('/two', '_blank')">Script popup</button>
      <a id="download-attribute" download="kalcode-browser-unsafe.txt" href="/attachment">Download attribute</a>
      <a id="download-header" href="/attachment">Download header</a>
      <button id="blob-download" onclick="const a=document.createElement('a');a.download='kalcode-browser-unsafe.txt';a.href=URL.createObjectURL(new Blob(['unsafe']));a.click()">Blob download</button>
    </body></html>`);
    else if (url.pathname === "/slow") {
      response.write("<!doctype html><html><head><title>Fixture Slow</title></head><body><h1>SLOW</h1>");
    } else response.end(page("Fixture One", "ONE"));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Browser fixture did not bind TCP.");
  return { server, origin: `http://127.0.0.1:${address.port}`, requests, ipc, cookies };
}

function filesNamed(root: string, name: string): string[] {
  const found: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.name === name) found.push(path);
    }
  };
  if (existsSync(root)) visit(root);
  return found;
}

async function closeFixture(value: Fixture) {
  value.server.closeAllConnections?.();
  await new Promise<void>((resolve) => value.server.close(() => resolve()));
}

async function connectChild(debugPort: number) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

const codeNav = (page: Page) =>
  page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Code", exact: true });

async function state(page: Page, browserId: string): Promise<BrowserState> {
  const pageLease = await invoke<number>(page, "browser_page_lease");
  return invoke<BrowserState>(page, "browser_info", { browserId, pageLease });
}

async function navigate(page: Page, browserId: string | null, url: string): Promise<BrowserState> {
  if (!browserId) throw new Error("The Browser pane is missing its native identity.");
  const pageLease = await invoke<number>(page, "browser_page_lease");
  return invoke<BrowserState>(page, "browser_navigate", { browserId, url, pageLease });
}

async function focus(page: Page, browserId: string | null): Promise<boolean> {
  if (!browserId) throw new Error("The Browser pane is missing its native identity.");
  const pageLease = await invoke<number>(page, "browser_page_lease");
  return invoke<boolean>(page, "browser_focus", { browserId, pageLease });
}

test("native Browser is isolated, navigates in split panes and restores safe workspace state", async () => {
  test.setTimeout(300_000);
  const web = await fixture();
  const dataDir = mkdtempSync(join(tmpdir(), "kalcode-e2e-browser-"));
  const root = mkdtempSync(join(tmpdir(), "kalcode-e2e-browser-project-"));
  const project = join(root, "browser-site");
  mkdirSync(project);
  writeFileSync(join(project, "README.md"), "# browser fixture\n");
  const env = {
    KALCODE_E2E_PICK_FOLDER: project,
    KALCODE_E2E_BROWSER_CDP_BASE: String(PORT + 100),
  };
  let app: Awaited<ReturnType<typeof launch>> | null = null;

  try {
    app = await launch(dataDir, env);
    let page = app.page;
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
    await codeNav(page).click();
    await page.getByRole("button", { name: /Open folder/ }).click();
    await expect(page.getByRole("heading", { level: 1, name: "browser-site" })).toBeVisible();
    await page.getByRole("button", { name: "Open Browser" }).click();

    let panes = page.locator("[data-browser-id]");
    await expect(panes).toHaveCount(1);
    const first = panes.first();
    const firstId = await first.getAttribute("data-browser-id");
    expect(firstId).toBeTruthy();
    await first.getByLabel("Web address").fill(`${web.origin}/one?session=ephemeral#private`);
    expect(await first.getByLabel("Web address").inputValue()).toBe(`${web.origin}/one?session=ephemeral#private`);
    await first.getByLabel("Web address").press("Enter");
    await expect.poll(() => web.requests.get("/one") ?? 0).toBeGreaterThan(0);
    await expect.poll(async () => (await state(page, firstId as string)).title).toBe("Fixture One");
    console.log("browser-e2e:first-navigation");
    expect((await state(page, firstId as string)).url).toContain("session=ephemeral");

    // Remote content either has no Tauri bridge or receives a capability denial; it never calls boot.
    await expect.poll(() => web.ipc.length).toBeGreaterThan(0);
    expect(web.ipc).not.toContain("granted");
    expect(web.ipc.every((value) => value === "isolated" || value === "denied")).toBe(true);
    console.log("browser-e2e:ipc-isolated");

    await first.getByLabel("Web address").fill(`${web.origin}/two`);
    await first.getByLabel("Web address").press("Enter");
    await expect.poll(async () => (await state(page, firstId as string)).title).toBe("Fixture Two");
    console.log("browser-e2e:second-navigation");
    await first.getByRole("button", { name: "Back" }).click();
    console.log("browser-e2e:back-clicked");
    await expect.poll(async () => new URL((await state(page, firstId as string)).url).pathname).toBe("/one");
    console.log("browser-e2e:back-complete");
    await first.getByRole("button", { name: "Forward" }).click();
    console.log("browser-e2e:forward-clicked");
    await expect.poll(async () => new URL((await state(page, firstId as string)).url).pathname).toBe("/two");
    await expect.poll(async () => (await state(page, firstId as string)).loading).toBe(false);
    console.log("browser-e2e:forward-complete");

    const beforeReload = web.requests.get("/two") ?? 0;
    await expect(first.getByRole("button", { name: "Reload" })).toBeVisible();
    await first.getByRole("button", { name: "Reload" }).click();
    console.log("browser-e2e:reload-clicked");
    await expect.poll(() => web.requests.get("/two") ?? 0).toBeGreaterThan(beforeReload);
    console.log("browser-e2e:history-reload");

    await first.getByLabel("Responsive viewport").selectOption("mobile");
    await expect.poll(async () => (await state(page, firstId as string)).bounds.width).toBeLessThanOrEqual(390.5);

    // Trusted menus must hide native children; WebView2 otherwise paints above React portals.
    await page.getByRole("button", { name: "Actions for pane 1" }).click();
    await expect(page.getByRole("menuitem", { name: "Split right" })).toBeVisible();
    await expect.poll(async () => (await state(page, firstId as string)).visible).toBe(false);
    await page.keyboard.press("Escape");
    await expect.poll(async () => (await state(page, firstId as string)).visible).toBe(true);
    console.log("browser-e2e:modal-visibility");

    await page.getByRole("button", { name: "Split pane 1 right" }).click();
    await page.getByRole("button", { name: "Open Browser" }).click();
    panes = page.locator("[data-browser-id]");
    await expect(panes).toHaveCount(2);
    const second = panes.nth(1);
    const secondId = await second.getAttribute("data-browser-id");
    expect(secondId).toBeTruthy();
    expect(secondId).not.toBe(firstId);
    await second.getByLabel("Web address").fill(`${web.origin}/two`);
    await second.getByLabel("Web address").press("Enter");
    await expect.poll(async () => (await state(page, secondId as string)).title).toBe("Fixture Two");
    console.log("browser-e2e:two-panes");

    // A position-only pane swap (equal dimensions) must still move the native child WebView2.
    const firstById = page.locator(`[data-browser-id="${firstId}"]`);
    const firstViewport = firstById.getByRole("document");
    const firstFrame = firstById.locator("xpath=ancestor::*[@data-pane-id]").first();
    const oldBounds = await state(page, firstId as string);
    const oldRect = await firstViewport.boundingBox();
    expect(oldRect).not.toBeNull();
    await firstFrame.getByRole("button", { name: /Actions for pane/ }).click();
    await page.getByRole("menuitem", { name: "Move pane right" }).click();
    await expect.poll(async () => (await state(page, firstId as string)).bounds.x).not.toBe(oldBounds.bounds.x);
    const movedRect = await firstViewport.boundingBox();
    const movedBounds = await state(page, firstId as string);
    expect(movedRect).not.toBeNull();
    expect(Math.abs(movedBounds.bounds.x - (movedRect?.x ?? -10_000))).toBeLessThan(2);
    await firstFrame.getByRole("button", { name: /Actions for pane/ }).click();
    await page.getByRole("menuitem", { name: "Move pane left" }).click();
    await expect.poll(async () => (await state(page, firstId as string)).bounds.x).toBe(oldBounds.bounds.x);
    console.log("browser-e2e:position-only-swap");

    // Native WebView2 focus propagates back to the canonical pane/KalVoice destination.
    await focus(page, firstId);
    await expect(firstFrame).toHaveAttribute("data-focused", "true");
    await focus(page, secondId);
    const secondFrame = second.locator("xpath=ancestor::*[@data-pane-id]").first();
    await expect(secondFrame).toHaveAttribute("data-focused", "true");
    console.log("browser-e2e:native-focus");

    // Stop cancels an in-flight local response without leaving the pane in a loading state.
    await second.getByLabel("Web address").fill(`${web.origin}/slow`);
    await second.getByLabel("Web address").press("Enter");
    await expect(second.getByRole("button", { name: "Stop loading" })).toBeVisible();
    await second.getByRole("button", { name: "Stop loading" }).click();
    await expect.poll(async () => (await state(page, secondId as string)).loading).toBe(false);
    console.log("browser-e2e:stop");

    // Untrusted titles cannot inject terminal controls or Unicode bidi formatting into chrome.
    await navigate(page, secondId, `${web.origin}/bidi`);
    await expect.poll(async () => (await state(page, secondId as string)).title).toBe("Trusted  moc.live  x");

    // Popups and downloads stay denied inside the remote child, and unsafe redirects never become
    // the browser's runtime URL. One normal HTTP redirect is retained as a positive control.
    await navigate(page, secondId, `${web.origin}/security`);
    await expect.poll(async () => (await state(page, secondId as string)).title).toBe("Security Fixture");
    const debugPort = (await state(page, secondId as string)).debugPort;
    expect(debugPort).toBeGreaterThanOrEqual(1_024);
    const childBrowser = await connectChild(debugPort as number);
    const remotePages = () => childBrowser.contexts().flatMap((browserContext) => browserContext.pages());
    await expect.poll(() => remotePages().some((candidate) => candidate.url() === `${web.origin}/security`)).toBe(true);
    const remote = remotePages().find((candidate) => candidate.url() === `${web.origin}/security`);
    expect(remote).toBeTruthy();
    if (!remote) throw new Error("Remote Browser page was not exposed to the E2E CDP session.");
    await focus(page, firstId);
    await expect(firstFrame).toHaveAttribute("data-focused", "true");
    await remote.mouse.click(500, 300);
    await expect(secondFrame).toHaveAttribute("data-focused", "true");
    const beforePopupCount = remotePages().length;
    let downloadEvents = 0;
    remote.on("download", () => {
      downloadEvents += 1;
    });
    await remote.locator("#target-popup").click();
    await remote.locator("#script-popup").click();
    await remote.locator("#download-attribute").click();
    await remote.locator("#download-header").click();
    await remote.locator("#blob-download").click();
    await page.waitForTimeout(500);
    expect(remotePages()).toHaveLength(beforePopupCount);
    expect(web.requests.get("/attachment") ?? 0).toBeGreaterThan(0);
    expect(downloadEvents).toBe(0);
    expect(filesNamed(dataDir, "kalcode-browser-unsafe.txt")).toEqual([]);

    for (const route of ["file", "javascript", "data", "custom", "credentials"]) {
      await navigate(page, secondId, `${web.origin}/redirect-${route}`);
      await expect.poll(() => web.requests.get(`/redirect-${route}`) ?? 0).toBeGreaterThan(0);
      const after = await state(page, secondId as string);
      const safe = new URL(after.url);
      expect(["http:", "https:"]).toContain(safe.protocol);
      expect(safe.username).toBe("");
      expect(safe.password).toBe("");
    }
    await navigate(page, secondId, `${web.origin}/redirect-http`);
    await expect.poll(async () => new URL((await state(page, secondId as string)).url).pathname).toBe("/two");
    console.log("browser-e2e:navigation-security");

    // The full callback URL is usable for this run; only its query/fragment are omitted on disk.
    await first.getByLabel("Web address").fill(`${web.origin}/one?oauth_code=never-persist#access-token`);
    await first.getByLabel("Web address").press("Enter");
    await expect.poll(async () => (await state(page, firstId as string)).title).toBe("Fixture One");
    await page.waitForTimeout(1_000);
    console.log("browser-e2e:before-close");
    await closeGracefully(app);
    console.log("browser-e2e:closed");
    app = null;

    app = await launch(dataDir, env);
    page = app.page;
    await codeNav(page).click();
    await expect(page.getByRole("heading", { level: 1, name: "browser-site" })).toBeVisible();
    panes = page.locator("[data-browser-id]");
    await expect(panes).toHaveCount(2);
    await expect(page.locator(`[data-browser-id="${firstId}"]`)).toHaveCount(1);
    const restored = await state(page, firstId as string);
    expect(restored.url).toBe(`${web.origin}/one`);
    expect(restored.url).not.toContain("oauth_code");
    expect(restored.url).not.toContain("access-token");
    // Main-view reload closes every old native child before React recreates the persisted panes.
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
    await codeNav(page).click();
    await expect(page.locator(`[data-browser-id="${firstId}"]`)).toHaveCount(1);
    await expect.poll(async () => (await state(page, firstId as string)).url).toBe(`${web.origin}/one`);
    console.log("browser-e2e:restored");
  } finally {
    if (app) await closeGracefully(app).catch(() => undefined);
    await closeFixture(web);
    removeDir(dataDir);
    removeDir(root);
  }
});

test("native Browser cookies persist within one workspace and never cross workspace profiles", async () => {
  test.setTimeout(240_000);
  const web = await fixture();
  const dataDir = mkdtempSync(join(tmpdir(), "kalcode-e2e-browser-cookie-"));
  const root = mkdtempSync(join(tmpdir(), "kalcode-e2e-browser-cookie-project-"));
  const project = join(root, "cookie-a");
  mkdirSync(project);
  const env = { KALCODE_E2E_PICK_FOLDER: project };
  let app: Awaited<ReturnType<typeof launch>> | null = null;
  const browserA = "550e8400-e29b-41d4-a716-446655440010";
  const browserB = "550e8400-e29b-41d4-a716-446655440011";

  const attach = async (page: Page, browserId: string, workspaceId: string, url: string) => {
    const pageLease = await invoke<number>(page, "browser_page_lease");
    return invoke<BrowserState>(page, "browser_attach", {
      request: {
        browserId,
        workspaceId,
        url,
        bounds: { x: 10, y: 10, width: 640, height: 480 },
        visible: false,
        pageLease,
        visibilityVersion: 0,
      },
    });
  };

  try {
    app = await launch(dataDir, env);
    let page = app.page;
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
    const workspaceA = await invoke<{ id: string } | null>(page, "workspace_open_dialog");
    expect(workspaceA?.id).toBeTruthy();
    const workspaceB = await invoke<{ id: string } | null>(page, "workspace_create", { name: "cookie-b" });
    expect(workspaceB?.id).toBeTruthy();

    await attach(page, browserA, workspaceA?.id as string, `${web.origin}/cookie-set`);
    await expect.poll(() => web.cookies.get("set") ?? "").toContain("isolated=A");
    await navigate(page, browserA, `${web.origin}/cookie-echo?who=a-before-restart`);
    await expect.poll(() => web.cookies.get("a-before-restart") ?? "").toContain("isolated=A");

    await attach(page, browserB, workspaceB?.id as string, `${web.origin}/cookie-echo?who=b-before-restart`);
    await expect.poll(() => web.cookies.has("b-before-restart")).toBe(true);
    expect(web.cookies.get("b-before-restart")).toBe("");

    await closeGracefully(app);
    app = null;
    app = await launch(dataDir, env);
    page = app.page;
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
    await attach(page, browserA, workspaceA?.id as string, `${web.origin}/cookie-echo?who=a-after-restart`);
    await attach(page, browserB, workspaceB?.id as string, `${web.origin}/cookie-echo?who=b-after-restart`);
    await expect.poll(() => web.cookies.get("a-after-restart") ?? "").toContain("isolated=A");
    await expect.poll(() => web.cookies.has("b-after-restart")).toBe(true);
    expect(web.cookies.get("b-after-restart")).toBe("");
  } finally {
    if (app) await closeGracefully(app).catch(() => undefined);
    await closeFixture(web);
    removeDir(dataDir);
    removeDir(root);
  }
});
