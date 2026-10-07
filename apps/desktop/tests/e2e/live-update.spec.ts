import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, type KeyObject, sign as signBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, type Page } from "@playwright/test";
// @ts-expect-error The release tooling is plain JavaScript without type declarations.
import { liveDescriptorBytes, liveEnvelope, packUiBundle } from "../../../../tooling/release/live-update.mjs";
import { EXE, launch, removeDir, test } from "./harness.ts";

/**
 * KalCode Live Update against the real binary. A newer UI is applied while six real terminals keep
 * running; a tampered bundle never activates; a UI that never reports ready rolls back on its own.
 * The update comes from a local folder through the test-build-only source in live_update.rs,
 * signed with a throwaway Minisign key, and goes through the same verification as production.
 * Build first: KALCODE_NATIVE_FINGERPRINT=<64 hex> pnpm --filter @kalcode/desktop build:e2e
 */
test.skip(process.platform !== "win32", "Real-app E2E drives WebView2 and runs on Windows.");
test.skip(!existsSync(EXE), `Build the app first: ${EXE}`);

const DIST = resolve(import.meta.dirname, "../../dist");
const TERMINALS = 6;

interface BuildInfo {
  version: string;
  nativeFingerprint: string | null;
}

function buildInfo(): BuildInfo {
  return JSON.parse(execFileSync(EXE, ["--build-info"], { encoding: "utf8", windowsHide: true }));
}

function testSigner() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" });
  const keyId = Buffer.from("0807060504030201", "hex");
  const record = Buffer.concat([Buffer.from("Ed"), keyId, der.subarray(der.length - 32)]);
  const text = `untrusted comment: minisign public key: live update e2e\n${record.toString("base64")}\n`;
  return { privateKey, keyId, publicKeyBase64: Buffer.from(text, "utf8").toString("base64") };
}

function minisign(bytes: Buffer, key: { privateKey: KeyObject; keyId: Buffer }, file: string, version: string) {
  const digest = createHash("blake2b512").update(bytes).digest();
  const signature = signBytes(null, digest, key.privateKey);
  const trusted = `timestamp:1791244071\tfile:${file}\tversion:${version}\ttarget:windows-x86_64\tchannel:stable`;
  const global = signBytes(null, Buffer.concat([signature, Buffer.from(trusted, "utf8")]), key.privateKey);
  const text = [
    "untrusted comment: signature from minisign secret key",
    Buffer.concat([Buffer.from("ED"), key.keyId, signature]).toString("base64"),
    `trusted comment: ${trusted}`,
    global.toString("base64"),
  ].join("\n");
  return Buffer.from(text, "utf8").toString("base64");
}

/** Publishes `version` into the local source: the shipped UI with a visible marker (or a broken page). */
function publish(
  source: string,
  key: ReturnType<typeof testSigner>,
  native: string,
  version: string,
  options: { marker: string; broken?: boolean; tamper?: boolean },
) {
  const ui = mkdtempSync(join(tmpdir(), "kalcode-live-ui-"));
  cpSync(DIST, ui, { recursive: true });
  const index = join(ui, "index.html");
  const html = options.broken
    ? `<!doctype html><html><head><meta name="kalcode-live-marker" content="${options.marker}"></head><body>broken</body></html>`
    : readFileSync(index, "utf8").replace(
        "<head>",
        `<head><meta name="kalcode-live-marker" content="${options.marker}">`,
      );
  writeFileSync(index, html);
  const bundle = packUiBundle(ui);
  removeDir(ui);
  const file = `KalCode_live_${options.marker}_ui.kui`;
  writeFileSync(join(source, file), bundle.bytes);
  const descriptor = liveDescriptorBytes({
    version,
    channel: "stable",
    target: "windows-x86_64",
    commit: "0123456789abcdef0123456789abcdef01234567",
    nativeFingerprint: native,
    ui: {
      file,
      size: bundle.size,
      sha256: options.tamper ? "f".repeat(64) : bundle.sha256,
      expandedSize: bundle.expandedSize,
      files: bundle.files,
    },
  });
  writeFileSync(
    join(source, "windows-x86_64.json"),
    liveEnvelope(descriptor, minisign(descriptor, key, "KalCode_live_x64-live.json", version)),
  );
  writeFileSync(join(source, "trigger"), version);
}

const marker = (page: Page) =>
  page.evaluate(() => document.querySelector("meta[name='kalcode-live-marker']")?.getAttribute("content") ?? null);

const invoke = <T>(page: Page, command: string, args: Record<string, unknown> = {}) =>
  page.evaluate(
    ([name, payload]) =>
      (
        window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a: unknown) => Promise<unknown> } }
      ).__TAURI_INTERNALS__.invoke(name as string, payload),
    [command, args] as const,
  ) as Promise<T>;

function counter(dir: string, index: number): number {
  try {
    return Number(readFileSync(join(dir, `t${index}.txt`), "utf8").trim()) || 0;
  } catch {
    return 0;
  }
}

test("a UI update applies live while six terminals keep running; bad updates never stick", async () => {
  test.setTimeout(300_000);
  const info = buildInfo();
  test.skip(!info.nativeFingerprint, "This E2E binary was built without KALCODE_NATIVE_FINGERPRINT.");
  const native = info.nativeFingerprint as string;
  const publicVersion = info.version.split("+")[0];
  const dataDir = mkdtempSync(join(tmpdir(), "kalcode-e2e-live-"));
  const project = mkdtempSync(join(tmpdir(), "kalcode-e2e-live-project-"));
  const counters = mkdtempSync(join(tmpdir(), "kalcode-e2e-live-counters-"));
  const source = mkdtempSync(join(tmpdir(), "kalcode-e2e-live-source-"));
  mkdirSync(join(project, "app"), { recursive: true });
  const key = testSigner();

  try {
    const app = await launch(dataDir, {
      KALCODE_E2E_PICK_FOLDER: project,
      KALCODE_TEST_LIVE_SOURCE: source,
      KALCODE_TEST_UPDATER_PUBLIC_KEY: key.publicKeyBase64,
    });
    const page = app.page;
    expect(await marker(page)).toBeNull();

    // Six real terminals, each a long-running process counting into its own file.
    await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Code", exact: true }).click();
    await page.getByRole("button", { name: "Open folder…" }).click();
    for (let index = 0; index < TERMINALS; index++) {
      await page.getByRole("button", { name: /^New .+ terminal$/ }).click();
      await expect(page.getByRole("tab")).toHaveCount(index + 1, { timeout: 30_000 });
      await page.locator('[role="tabpanel"]:not([hidden]) .xterm-screen').click();
      await page.waitForTimeout(1500);
      await page.keyboard.type(
        `echo live-marker-${index}; $i=0; while ($true) { $i++; Set-Content -LiteralPath '${join(counters, `t${index}.txt`)}' -Value $i; Start-Sleep -Milliseconds 250 }`,
      );
      await page.keyboard.press("Enter");
    }
    await expect.poll(() => counter(counters, TERMINALS - 1), { timeout: 30_000 }).toBeGreaterThan(2);
    const running = await invoke<unknown[]>(page, "terminals_running");
    expect(running).toHaveLength(TERMINALS);

    // 1. A newer UI, verified and applied live.
    const before = Array.from({ length: TERMINALS }, (_, index) => counter(counters, index));
    publish(source, key, native, `${publicVersion}+900001`, { marker: "v2" });
    await expect.poll(() => marker(page).catch(() => null), { timeout: 60_000 }).toBe("v2");
    await expect
      .poll(async () => (await invoke<{ phase: string }>(page, "live_update_status")).phase, { timeout: 30_000 })
      .toBe("UPDATED");
    await expect(page.getByText("KalCode updated")).toBeVisible({ timeout: 15_000 });
    // The same processes kept counting through the reload, and their views re-attached.
    await page.waitForTimeout(1500);
    for (let index = 0; index < TERMINALS; index++) {
      expect(counter(counters, index)).toBeGreaterThan(before[index] ?? 0);
    }
    expect(await invoke<unknown[]>(page, "terminals_running")).toHaveLength(TERMINALS);
    await expect(page.locator('[role="tabpanel"]:not([hidden]) .xterm-rows')).toContainText("live-marker-5", {
      timeout: 15_000,
    });
    const status = await invoke<{ uiVersion: string; timings: Record<string, number | null> }>(
      page,
      "live_update_status",
    );
    expect(status.uiVersion).toBe(`${publicVersion}+900001`);
    expect(status.timings.rendererRefreshMs).not.toBeNull();

    // 2. A bundle whose bytes don't match the signed descriptor never activates.
    publish(source, key, native, `${publicVersion}+900002`, { marker: "v3", tamper: true });
    await expect
      .poll(async () => (await invoke<{ phase: string }>(page, "live_update_status")).phase, { timeout: 30_000 })
      .toBe("FAILED");
    expect(await marker(page)).toBe("v2");

    // 3. A UI that never reports ready is rolled back to the last good one, automatically.
    publish(source, key, native, `${publicVersion}+900003`, { marker: "v4", broken: true });
    await expect.poll(() => marker(page).catch(() => null), { timeout: 60_000 }).toBe("v4");
    await expect.poll(() => marker(page).catch(() => null), { timeout: 90_000 }).toBe("v2");
    await expect
      .poll(async () => (await invoke<{ phase: string }>(page, "live_update_status")).phase, { timeout: 30_000 })
      .toBe("ROLLED_BACK");
    expect(await invoke<unknown[]>(page, "terminals_running")).toHaveLength(TERMINALS);
    const afterRollback = counter(counters, 0);
    await page.waitForTimeout(1000);
    expect(counter(counters, 0)).toBeGreaterThan(afterRollback);
  } finally {
    removeDir(source);
    removeDir(counters);
    removeDir(project);
    removeDir(dataDir);
  }
});
