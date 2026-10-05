import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
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
import { clickOwnedClientPoint } from "./windowsPointer.ts";

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
  /** Present only in the E2E binary; counts construction-time native denial decisions. */
  debugDownloadDenials?: number;
}

interface Fixture {
  server: Server;
  origin: string;
  requests: Map<string, number>;
  ipc: string[];
  cookies: Map<string, string>;
}

interface DevToolsTarget {
  type?: string;
  url?: string;
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
    </body></html>`);
    else if (url.pathname === "/security-auto")
      response.end(`<!doctype html><html><head><title>Native Download Auto</title></head><body>
      <a id="download" download="kalcode-browser-unsafe.txt" href="/attachment">Download</a>
      <script>
        fetch('/attempt/auto', { method: 'POST', keepalive: true })
          .finally(() => document.querySelector('#download').click());
      </script>
    </body></html>`);
    else if (url.pathname === "/security-attribute")
      response.end(`<!doctype html><html><head><title>Native Download Attribute</title>
      <style>html,body,a{box-sizing:border-box;height:100%;margin:0;width:100%}a{align-items:center;display:flex;justify-content:center}</style>
      </head><body><a download="kalcode-browser-unsafe.txt" href="/attachment"
        onclick="navigator.sendBeacon('/attempt/attribute')">Download attribute</a></body></html>`);
    else if (url.pathname === "/security-header")
      response.end(`<!doctype html><html><head><title>Native Download Header</title>
      <style>html,body,a{box-sizing:border-box;height:100%;margin:0;width:100%}a{align-items:center;display:flex;justify-content:center}</style>
      </head><body><a href="/attachment"
        onclick="navigator.sendBeacon('/attempt/header')">Download header</a></body></html>`);
    else if (url.pathname === "/security-blob")
      response.end(`<!doctype html><html><head><title>Native Download Blob</title>
      <style>html,body,button{box-sizing:border-box;height:100%;margin:0;width:100%}</style>
      </head><body><button onclick="navigator.sendBeacon('/attempt/blob');const a=document.createElement('a');a.download='kalcode-browser-unsafe.txt';a.href=URL.createObjectURL(new Blob(['unsafe']));a.click()">Download blob</button></body></html>`);
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

function deniedDownloadSinkState(root: string): { directories: string[]; regularFiles: string[] } {
  const directories: string[] = [];
  const regularFiles: string[] = [];
  const visit = (directory: string, inDeniedSink: boolean) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        const deniedSink = inDeniedSink || entry.name === "denied-downloads";
        if (entry.name === "denied-downloads") directories.push(path);
        visit(path, deniedSink);
      } else if (inDeniedSink && entry.isFile()) {
        regularFiles.push(path);
      }
    }
  };
  if (existsSync(root)) visit(root, false);
  return { directories, regularFiles };
}

function isWebViewCancellationTemp(path: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/i.test(basename(path));
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

async function pageTargetUrls(debugPort: number): Promise<string[]> {
  const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
  if (!response.ok) throw new Error(`The child DevTools target list returned HTTP ${response.status}.`);
  const targets = (await response.json()) as DevToolsTarget[];
  return targets
    .filter((target) => target.type === "page" && typeof target.url === "string")
    .map((target) => target.url as string)
    .sort();
}

const codeNav = (page: Page) =>
  page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Code", exact: true });

async function state(page: Page, browserId: string): Promise<BrowserState> {
  const pageLease = await invoke<number>(page, "browser_page_lease");
  return invoke<BrowserState>(page, "browser_info", { browserId, pageLease });
}

async function stateWhileAttaching(page: Page, browserId: string): Promise<BrowserState | null> {
  return page.evaluate(async (id) => {
    const nativeInvoke = (
      window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string, args: unknown) => Promise<unknown> } }
    ).__TAURI_INTERNALS__.invoke;
    const pageLease = (await nativeInvoke("browser_page_lease", {})) as number;
    try {
      return (await nativeInvoke("browser_info", { browserId: id, pageLease })) as BrowserState;
    } catch (error) {
      if (typeof error === "object" && error !== null) {
        const payload = error as {
          category?: unknown;
          code?: unknown;
          message?: unknown;
          retryable?: unknown;
        };
        const notFound =
          payload.category === "internal" &&
          payload.code === "browser_not_found" &&
          payload.message === "That browser pane is not open." &&
          payload.retryable === false;
        const starting =
          payload.category === "internal" &&
          payload.code === "browser_starting" &&
          payload.message === "That browser pane is still starting." &&
          payload.retryable === true;
        if (notFound || starting) {
          return null;
        }
      }
      throw error;
    }
  }, browserId);
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
  // Needs a real foreground window and pointer (SetForegroundWindow), which session 0 lacks.
  test.skip(inServiceSession(), SERVICE_SESSION_SKIP);
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
    const appPid = app.child.pid;
    let page = app.page;
    await expect(page.getByRole("heading", { level: 1, name: "Activity" })).toBeVisible();
    // The attach-readiness helper recognizes only exact native not-found or in-progress responses.
    expect(await stateWhileAttaching(page, "550e8400-e29b-41d4-a716-446655449999")).toBeNull();
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
    const expectNativeBrowsersHidden = async () => {
      await expect
        .poll(async () => [
          (await state(page, firstId as string)).visible,
          (await state(page, secondId as string)).visible,
        ])
        .toEqual([false, false]);
    };
    await second.getByLabel("Web address").fill(`${web.origin}/two`);
    await second.getByLabel("Web address").press("Enter");
    await expect
      .poll(async () => (await stateWhileAttaching(page, secondId as string))?.title ?? null)
      .toBe("Fixture Two");
    console.log("browser-e2e:two-panes");

    // A position-only pane swap (equal dimensions) must still move the native child WebView2.
    const firstById = page.locator(`[data-browser-id="${firstId}"]`);
    const firstViewport = firstById.getByRole("button", { name: /^Browser:/ });
    const firstFrame = firstById.locator("xpath=ancestor::*[@data-pane-id]").first();
    const oldBounds = await state(page, firstId as string);
    const oldRect = await firstViewport.boundingBox();
    expect(oldRect).not.toBeNull();
    await firstFrame.getByRole("button", { name: /Actions for pane/ }).click();
    await expectNativeBrowsersHidden();
    await page.getByRole("menuitem", { name: "Move pane right" }).click();
    await expect.poll(async () => (await state(page, firstId as string)).bounds.x).not.toBe(oldBounds.bounds.x);
    // A first position update can arrive before the adaptive layout has settled.
    // Keep the exact alignment requirement while awaiting the native geometry update.
    await expect
      .poll(async () => {
        const movedRect = await firstViewport.boundingBox();
        const movedBounds = await state(page, firstId as string);
        return Math.abs(movedBounds.bounds.x - (movedRect?.x ?? -10_000));
      })
      .toBeLessThan(2);
    await firstFrame.getByRole("button", { name: /Actions for pane/ }).click();
    await expectNativeBrowsersHidden();
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

    // Exercise downloads through the real native controller before attaching CDP. A child CDP
    // session handles its own downloads and bypasses WebView2's host DownloadStarting callback,
    // so it cannot prove the production denial path. Each fixture records the native pointer or
    // automatic attempt before the app must deny it without a file or persistent download UI.
    const debugPort = (await state(page, secondId as string)).debugPort;
    expect(debugPort).toBeGreaterThanOrEqual(1_024);
    const initialBrowserState = await state(page, secondId as string);
    expect(initialBrowserState.debugDownloadDenials).toEqual(expect.any(Number));
    const denialBefore = initialBrowserState.debugDownloadDenials as number;
    const attachmentBefore = web.requests.get("/attachment") ?? 0;
    const attemptBefore = new Map(
      (["auto", "attribute", "header", "blob"] as const).map((kind) => [
        kind,
        web.requests.get(`/attempt/${kind}`) ?? 0,
      ]),
    );
    const expectedNativePages = (current: string) => [`${web.origin}${current}`, `${web.origin}/two`].sort();
    const expectNativeContainment = async (current: string, denied: number) => {
      await expect
        .poll(async () => (await state(page, secondId as string)).debugDownloadDenials)
        .toBe(denialBefore + denied);
      await expect
        .poll(() => pageTargetUrls(debugPort as number), { timeout: 1_000 })
        .toEqual(expectedNativePages(current));
      expect(filesNamed(dataDir, "kalcode-browser-unsafe.txt")).toEqual([]);
      const sink = deniedDownloadSinkState(dataDir);
      expect(sink.directories.length).toBeGreaterThan(0);
      expect(sink.regularFiles.filter((path) => !isWebViewCancellationTemp(path))).toEqual([]);
      const cleanupStarted = Date.now();
      await expect.poll(() => deniedDownloadSinkState(dataDir).regularFiles, { timeout: 5_000 }).toEqual([]);
      console.log(`browser-e2e:download-cleanup-ms:${Date.now() - cleanupStarted}`);
      await page.waitForTimeout(500);
      expect(await pageTargetUrls(debugPort as number)).toEqual(expectedNativePages(current));
      expect(filesNamed(dataDir, "kalcode-browser-unsafe.txt")).toEqual([]);
      expect(deniedDownloadSinkState(dataDir).regularFiles).toEqual([]);
      expect((await state(page, secondId as string)).debugDownloadDenials).toBe(denialBefore + denied);
    };
    await navigate(page, secondId, `${web.origin}/security-auto`);
    await expect.poll(async () => (await state(page, secondId as string)).title).toBe("Native Download Auto");
    await expect.poll(async () => new URL((await state(page, secondId as string)).url).pathname).toBe("/security-auto");
    await expect.poll(() => web.requests.get("/attempt/auto") ?? 0).toBe((attemptBefore.get("auto") ?? 0) + 1);
    await expect.poll(() => web.requests.get("/attachment") ?? 0).toBe(attachmentBefore + 1);
    await expectNativeContainment("/security-auto", 1);

    const clickNativeDownload = async (
      kind: "attribute" | "header" | "blob",
      title: string,
      denied: number,
      attachmentCount: number,
    ) => {
      const route = `/security-${kind}`;
      await navigate(page, secondId, `${web.origin}${route}`);
      await expect.poll(async () => (await state(page, secondId as string)).title).toBe(title);
      await expect.poll(async () => new URL((await state(page, secondId as string)).url).pathname).toBe(route);
      await expect.poll(() => pageTargetUrls(debugPort as number)).toEqual(expectedNativePages(route));
      const clickBounds = await second.getByRole("button", { name: `Browser: ${title}` }).boundingBox();
      if (!clickBounds) throw new Error(`The native ${kind} fixture has no client bounds.`);
      const scale = await page.evaluate(() => window.devicePixelRatio);
      clickOwnedClientPoint(
        appPid,
        Math.round((clickBounds.x + clickBounds.width / 2) * scale),
        Math.round((clickBounds.y + clickBounds.height / 2) * scale),
      );
      await expect.poll(() => web.requests.get(`/attempt/${kind}`) ?? 0).toBe((attemptBefore.get(kind) ?? 0) + 1);
      await expect.poll(() => web.requests.get("/attachment") ?? 0).toBe(attachmentCount);
      await expectNativeContainment(route, denied);
    };
    await clickNativeDownload("attribute", "Native Download Attribute", 2, attachmentBefore + 2);
    await clickNativeDownload("header", "Native Download Header", 3, attachmentBefore + 3);
    // `blob:` is denied by the canonical HTTP(S)-only navigation policy before WebView2 emits
    // DownloadStarting. The real pointer marker must advance, while the download counter remains
    // stable and the same containment/file checks prove this upstream denial path.
    await clickNativeDownload("blob", "Native Download Blob", 3, attachmentBefore + 3);

    // Once the native download proof is complete, attach CDP only for popup containment and for
    // the independent oracle that an ownership-checked OS pointer reaches the remote document.
    await navigate(page, secondId, `${web.origin}/security`);
    await expect.poll(async () => (await state(page, secondId as string)).title).toBe("Security Fixture");
    const childBrowser = await connectChild(debugPort as number);
    const remotePages = () => childBrowser.contexts().flatMap((browserContext) => browserContext.pages());
    await expect.poll(() => remotePages().some((candidate) => candidate.url() === `${web.origin}/security`)).toBe(true);
    const remote = remotePages().find((candidate) => candidate.url() === `${web.origin}/security`);
    expect(remote).toBeTruthy();
    if (!remote) throw new Error("Remote Browser page was not exposed to the E2E CDP session.");
    const expectedRemotePages = [`${web.origin}/security`, `${web.origin}/two`].sort();
    const expectContainedPages = () =>
      expect
        .poll(
          () =>
            remotePages()
              .map((candidate) => candidate.url())
              .sort(),
          { timeout: 1_000 },
        )
        .toEqual(expectedRemotePages);
    await focus(page, firstId);
    await expect(firstFrame).toHaveAttribute("data-focused", "true");
    await remote.evaluate(() => {
      Object.defineProperty(window, "__kalcodePointerDownCount", {
        configurable: true,
        value: 0,
        writable: true,
      });
      window.addEventListener(
        "pointerdown",
        () => {
          const instrumented = window as typeof window & { __kalcodePointerDownCount: number };
          instrumented.__kalcodePointerDownCount += 1;
        },
        { once: true },
      );
    });
    const clickBounds = await second.getByRole("button", { name: "Browser: Security Fixture" }).boundingBox();
    if (!clickBounds) throw new Error("The native Browser viewport has no client bounds.");
    const scale = await page.evaluate(() => window.devicePixelRatio);
    clickOwnedClientPoint(
      appPid,
      Math.round((clickBounds.x + clickBounds.width / 2) * scale),
      Math.round((clickBounds.y + clickBounds.height / 2) * scale),
    );
    await expect
      .poll(() =>
        remote.evaluate(
          () => (window as typeof window & { __kalcodePointerDownCount: number }).__kalcodePointerDownCount,
        ),
      )
      .toBe(1);
    await expect(secondFrame).toHaveAttribute("data-focused", "true");
    await remote.locator("#target-popup").click();
    await expectContainedPages();
    await remote.locator("#script-popup").click();
    await expectContainedPages();
    await page.waitForTimeout(500);
    expect(
      remotePages()
        .map((candidate) => candidate.url())
        .sort(),
    ).toEqual(expectedRemotePages);
    expect(filesNamed(dataDir, "kalcode-browser-unsafe.txt")).toEqual([]);

    // Unsafe redirects never become the browser's runtime URL; one normal HTTP redirect remains
    // as a positive control for the navigation policy.
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
    await expect(page.getByRole("heading", { level: 1, name: "browser-site" })).toBeVisible();
    panes = page.locator("[data-browser-id]");
    await expect(panes).toHaveCount(2);
    await expect(page.locator(`[data-browser-id="${firstId}"]`)).toHaveCount(1);
    await expect
      .poll(async () => (await stateWhileAttaching(page, firstId as string))?.url ?? null)
      .toBe(`${web.origin}/one`);
    const restored = await state(page, firstId as string);
    expect(restored.url).toBe(`${web.origin}/one`);
    expect(restored.url).not.toContain("oauth_code");
    expect(restored.url).not.toContain("access-token");
    // Main-view reload closes every old native child before React recreates the persisted panes.
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: "browser-site" })).toBeVisible();
    await expect(page.locator(`[data-browser-id="${firstId}"]`)).toHaveCount(1);
    await expect
      .poll(async () => (await stateWhileAttaching(page, firstId as string))?.url ?? null)
      .toBe(`${web.origin}/one`);
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
    await expect(page.getByRole("heading", { level: 1, name: "Activity" })).toBeVisible();
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
    await expect(page.getByRole("heading", { level: 1, name: "cookie-b" })).toBeVisible();
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
