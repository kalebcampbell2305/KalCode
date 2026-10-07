import type { ChildProcess } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import helperInventory from "../../scripts/e2e-helpers.json";
import {
  closeBrowserBounded,
  isolatedWebviewEnvironment,
  OwnedApplicationRegistry,
  ownedChildIsTerminal,
  settleOwnedApplications,
  settleOwnedWebview,
  startupScreenSettled,
  waitForExit,
} from "../../tests/e2e/harness.ts";

const buildScript = readFileSync(resolve(import.meta.dirname, "../../scripts/build-e2e.mjs"), "utf8");
const e2eDirectory = resolve(import.meta.dirname, "../../tests/e2e");
const harnessSource = readFileSync(resolve(e2eDirectory, "harness.ts"), "utf8");

describe("native E2E helper inventory", () => {
  it("builds every required sibling for a clean account-bound runtime", () => {
    expect(helperInventory).toEqual([
      {
        package: "kalcode-hook-bridge",
        bin: "kalcode-hook",
        filename: { windows: "kalcode-hook.exe", other: "kalcode-hook" },
      },
      {
        package: "kalcode-providers",
        bin: "kalcode-provider-guardian",
        filename: { windows: "kalcode-provider-guardian.exe", other: "kalcode-provider-guardian" },
      },
      {
        package: "kalcode-providers",
        bin: "kalcode-fake-provider",
        filename: { windows: "kalcode-fake-provider.exe", other: "kalcode-fake-provider" },
      },
    ]);
    expect(new Set(helperInventory.map((helper) => helper.filename.windows)).size).toBe(helperInventory.length);
    expect(new Set(helperInventory.map((helper) => helper.filename.other)).size).toBe(helperInventory.length);
  });

  it("builds the native application with production KalVoice speech support", () => {
    expect(buildScript).toContain('"e2e,kalvoice-whisper"');
  });

  it("binds every real-app launch spec to the per-test owned-process fixture", () => {
    const specs = readdirSync(e2eDirectory).filter((name) => name.endsWith(".spec.ts"));
    const launchSpecs = specs.filter((name) => readFileSync(resolve(e2eDirectory, name), "utf8").includes("launch"));
    expect(launchSpecs).toHaveLength(20);
    expect(launchSpecs).toContain("operations.spec.ts");
    expect(launchSpecs).toContain("live-browser.spec.ts");
    expect(launchSpecs).toContain("provider-session-restart.spec.ts");
    expect(launchSpecs).toContain("remote.spec.ts");
    expect(launchSpecs).toContain("squads.spec.ts");
    for (const name of launchSpecs) {
      const source = readFileSync(resolve(e2eDirectory, name), "utf8");
      expect(source, name).not.toMatch(/import\s*\{[^}]*\btest\b[^}]*\}\s*from\s*"@playwright\/test"/s);
      expect(source, name).toMatch(/import\s*\{[^}]*\btest\b[^}]*\}\s*from\s*"\.\/harness\.ts"/s);
    }
    expect(harnessSource.indexOf("ownedApplications.requireActive(owner)")).toBeGreaterThan(-1);
    expect(harnessSource.indexOf("ownedApplications.requireActive(owner)")).toBeLessThan(
      harnessSource.indexOf("const child = spawn(EXE"),
    );
  });

  it("keeps the Operations lifecycle in the real native run contract", () => {
    const operations = readFileSync(resolve(e2eDirectory, "operations.spec.ts"), "utf8");
    expect(operations).toContain("createAccountFixtureDataDir()");
    expect(operations).toContain('KALCODE_E2E_NATIVE_CONFIRM: "decline"');
    expect(operations).toContain('KALCODE_E2E_NATIVE_CONFIRM: "accept"');
    expect(operations).toContain('"operations_run_now"');
    expect(operations).toContain('"operations_service_action"');
    expect(operations).toContain('"operations_history"');
    expect(operations).toContain("await closeGracefully(app)");
  });

  it("allows the deterministic resource sample only in the ten explicit provider specs", () => {
    const optedIn = readdirSync(e2eDirectory)
      .filter((name) => name.endsWith(".spec.ts"))
      .filter((name) => readFileSync(resolve(e2eDirectory, name), "utf8").includes("KALCODE_E2E_RESOURCE_FIXTURE"))
      .sort();
    expect(optedIn).toEqual([
      "handoff.spec.ts",
      "kalvoice.spec.ts",
      "locator-privacy.spec.ts",
      "notifications.spec.ts",
      "panes.spec.ts",
      "provider-panes.spec.ts",
      "provider-session-restart.spec.ts",
      "providers2.spec.ts",
      "remote.spec.ts",
      "squads.spec.ts",
    ]);
    expect(harnessSource).toContain('upper === "KALCODE_E2E_RESOURCE_FIXTURE"');
    const environment = isolatedWebviewEnvironment(
      { KALCODE_E2E_RESOURCE_FIXTURE: "provider-capacity-v1" },
      { Path: "synthetic", kalcode_e2e_resource_fixture: "inherited-must-not-activate" },
    );
    expect(environment.kalcode_e2e_resource_fixture).toBeUndefined();
    expect(environment.KALCODE_E2E_RESOURCE_FIXTURE).toBe("provider-capacity-v1");
  });

  it("retries partial launches, settles every owned child, and retains only failed cleanup", async () => {
    const registry = new OwnedApplicationRegistry<{ id: string; browser: null | object }>();
    const partial = { id: "partial", browser: null };
    const connected = { id: "connected", browser: {} };
    const attempts: string[] = [];
    registry.begin("test");
    registry.track("test", partial);
    registry.track("test", connected);

    expect(
      await registry.cleanup("test", async (application) => {
        attempts.push(application.id);
        if (application === partial && attempts.filter((id) => id === "partial").length === 1) {
          throw new Error("synthetic cleanup failure");
        }
      }),
    ).toBe(1);
    expect(attempts).toEqual(["partial", "connected"]);
    expect(registry.count("test")).toBe(1);
    expect(
      await registry.cleanup("test", async (application) => {
        attempts.push(application.id);
      }),
    ).toBe(0);
    expect(attempts).toEqual(["partial", "connected", "partial"]);
    expect(registry.count("test")).toBe(0);
  });

  it("rejects an unowned launch context before any child can be tracked", () => {
    const registry = new OwnedApplicationRegistry<string>();
    expect(() => registry.requireActive("missing-test")).toThrow("requires the harness test fixture");
    expect(registry.count("missing-test")).toBe(0);
  });

  it("waits for the owned WebView2 tree before closing CDP, ending only those processes if they linger", async () => {
    // Gates 37529315873 / 37520284094: the CDP endpoint is the app's msedgewebview2.exe, which
    // outlives kalcode.exe under load; closing CDP while it shut down hung past 5 seconds.
    const fakeProbe = (exitAt: Map<number, number>, endsWhenTerminated = true) => {
      let clock = 0;
      const terminated: number[] = [];
      return {
        terminated,
        probe: {
          list: () => [...exitAt].filter(([pid, at]) => clock < at && !terminated.includes(pid)).map(([pid]) => pid),
          terminate: (pid: number) => {
            if (endsWhenTerminated) terminated.push(pid);
          },
          sleep: async (milliseconds: number) => {
            clock += milliseconds;
          },
          now: () => clock,
        },
      };
    };

    const exitsInGrace = fakeProbe(new Map([[11, 6_700]]));
    await expect(settleOwnedWebview(exitsInGrace.probe)).resolves.toBeUndefined();
    expect(exitsInGrace.terminated).toEqual([]);

    const lingers = fakeProbe(
      new Map([
        [21, Number.POSITIVE_INFINITY],
        [22, Number.POSITIVE_INFINITY],
      ]),
    );
    await expect(settleOwnedWebview(lingers.probe)).resolves.toBeUndefined();
    expect(lingers.terminated).toEqual([21, 22]);

    const survives = fakeProbe(new Map([[31, Number.POSITIVE_INFINITY]]), false);
    await expect(settleOwnedWebview(survives.probe)).rejects.toThrow(
      "Owned WebView2 processes outlived the E2E app: 31",
    );

    for (const exit of [
      "export async function closeGracefully",
      "export async function killForcibly",
      "async function cleanupOwnedApplication",
    ]) {
      const body = harnessSource.slice(harnessSource.indexOf(exit));
      expect(body.indexOf("settleOwnedWebview("), exit).toBeGreaterThan(-1);
      expect(body.indexOf("settleOwnedWebview("), exit).toBeLessThan(body.indexOf("closeBrowserBounded("));
    }
  });

  it("treats the CDP close as done once the dead endpoint's connection reports disconnected", async () => {
    // Gates 37529315873 / 37520284094: after the app and its WebView2 tree exited, close() was still
    // awaiting Playwright's own artifacts-folder removal while the browser was already disconnected.
    let connected = true;
    let onDisconnected: (() => void) | undefined;
    const slowCleanup = {
      close: () => {
        setTimeout(() => {
          connected = false;
          onDisconnected?.();
        }, 10);
        return new Promise<void>(() => {});
      },
      isConnected: () => connected,
      once: (_event: "disconnected", listener: () => void) => {
        onDisconnected = listener;
        return slowCleanup;
      },
    };
    await expect(closeBrowserBounded(slowCleanup as never)).resolves.toBeUndefined();

    const alreadyDisconnected = {
      close: () => new Promise<void>(() => {}),
      isConnected: () => false,
      once: () => alreadyDisconnected,
    };
    await expect(closeBrowserBounded(alreadyDisconnected as never)).resolves.toBeUndefined();

    const failing = {
      close: () => Promise.reject(new Error("synthetic close failure")),
      isConnected: () => true,
      once: () => failing,
    };
    await expect(closeBrowserBounded(failing as never)).rejects.toThrow("synthetic close failure");
  });

  it("treats an already signaled owned child as terminal", () => {
    expect(ownedChildIsTerminal({ exitCode: null, pid: 123, signalCode: "SIGKILL" })).toBe(true);
    expect(ownedChildIsTerminal({ exitCode: 0, pid: 123, signalCode: null })).toBe(true);
    expect(ownedChildIsTerminal({ exitCode: null, pid: undefined, signalCode: null })).toBe(true);
    expect(ownedChildIsTerminal({ exitCode: null, pid: 123, signalCode: null })).toBe(false);
  });

  it("launch waits out busy startup screens, never the shell, sign-in or an error", () => {
    // Native load runs: "Starting your workspace" stayed 4-10 s after the document initialized,
    // and specs gave the Activity heading only the default 5 s.
    const page = (html: string) => new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
    expect(!startupScreenSettled(page('<div class="boot-screen" role="status" aria-busy="true"></div>'))).toBe(true);
    expect(
      !startupScreenSettled(
        page(
          '<main><div role="status" aria-busy="true"><h1 id="account-runtime-title">Starting your workspace</h1></div></main>',
        ),
      ),
    ).toBe(true);
    expect(
      !startupScreenSettled(
        page(
          '<main><div role="status" aria-busy="true"><h1 id="account-title">Restoring your session</h1></div></main>',
        ),
      ),
    ).toBe(true);
    // A failed start is not busy: the spec sees its error instead of waiting.
    expect(
      !startupScreenSettled(
        page(
          '<main><div role="status"><h1 id="account-runtime-title">Starting your workspace</h1><p role="alert">x</p></div></main>',
        ),
      ),
    ).toBe(false);
    expect(!startupScreenSettled(page('<main><h1 id="account-title">Sign in to KalCode</h1></main>'))).toBe(false);
    expect(
      !startupScreenSettled(
        page('<div data-app-shell=""><div role="status" aria-busy="true">Loading</div><h1>Activity</h1></div>'),
      ),
    ).toBe(false);
    expect(harnessSource.indexOf("page.evaluate(startupScreenSettled")).toBeGreaterThan(
      harnessSource.indexOf("owned.page = page"),
    );
  });

  it("does not miss exit state reached while the listener is registered", async () => {
    let signaled = false;
    const child = {
      exitCode: null,
      pid: 123,
      get signalCode(): NodeJS.Signals | null {
        return signaled ? "SIGKILL" : null;
      },
      once(_event: string, _listener: () => void) {
        signaled = true;
        return this;
      },
      off() {
        return this;
      },
    } as unknown as ChildProcess;
    await expect(waitForExit(child)).resolves.toBeUndefined();
  });

  it("reports cleanup failure without replacing an existing test failure", async () => {
    const registry = new OwnedApplicationRegistry<string>();
    const reports: number[] = [];
    let attempts = 0;
    registry.begin("failed-body");
    registry.track("failed-body", "partial-launch");

    await expect(
      settleOwnedApplications(
        registry,
        "failed-body",
        async () => {
          attempts += 1;
          throw new Error("synthetic cleanup failure");
        },
        true,
        async (failures) => {
          reports.push(failures);
        },
      ),
    ).resolves.toBeUndefined();
    expect(attempts).toBe(2);
    expect(reports).toEqual([1]);
    expect(registry.count("failed-body")).toBe(1);
    expect(await registry.cleanupAll(async () => undefined)).toBe(0);
    expect(registry.count("failed-body")).toBe(0);
  });

  it("fails a passing test when owned cleanup cannot settle", async () => {
    const registry = new OwnedApplicationRegistry<string>();
    registry.begin("passing-body");
    registry.track("passing-body", "connected-launch");

    await expect(
      settleOwnedApplications(
        registry,
        "passing-body",
        async () => {
          throw new Error("synthetic cleanup failure");
        },
        false,
        async () => undefined,
      ),
    ).rejects.toThrow("Failed to settle 1 owned native application");
    expect(registry.count("passing-body")).toBe(1);
  });
});
