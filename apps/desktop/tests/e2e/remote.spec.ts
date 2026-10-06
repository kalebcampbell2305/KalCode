import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page } from "@playwright/test";
import {
  ACCOUNT_OWNER_FIXTURE_OPT_IN,
  closeGracefully,
  EXE,
  launch,
  RESOURCE_PROVIDER_FIXTURE_OPT_IN,
  removeDir,
  test,
  waitForProviderAdmission,
  writeManagedFakeProviderConfig,
} from "./harness.ts";

/**
 * KalCode Remote end to end against the real app (OWNER fixture): Settings › Remote turns the
 * host on and shows a pairing QR code; a device (`crates/remote`'s `devclient`, a real Noise IK
 * initiator) pairs with that code, receives a snapshot holding the app's real coding agent and its
 * pending approval, a patch after a real change, `launch.options` and the agent's diff, and
 * answers the approval (Approve once) so the agent continues. Removing the device in Settings
 * closes its live connection with `bye revoked`, and the key is refused afterwards.
 *
 * The agent is the FAKE provider (no AI service). Build first: the app (`pnpm tauri build --debug
 * --no-bundle --features e2e`, then KALCODE_E2E_EXE=target/debug/kalcode-dev.exe) and
 * `cargo build -p kalcode-remote --example devclient`.
 */
test.skip(process.platform !== "win32", "Real-app E2E drives WebView2 and runs on Windows.");
test.skip(!existsSync(EXE), `Build the app first: ${EXE}`);

const DEVCLIENT =
  process.env.KALCODE_REMOTE_DEVCLIENT ??
  resolve(import.meta.dirname, "../../../../target/debug/examples/devclient.exe");
test.skip(!existsSync(DEVCLIENT), "Build the device: cargo build -p kalcode-remote --example devclient");
const FAKE = join(dirname(EXE), "kalcode-fake-provider.exe");
const HELPER = join(dirname(EXE), "kalcode-hook.exe");
test.skip(!existsSync(FAKE) || !existsSync(HELPER), "The fake provider and kalcode-hook must sit next to the app.");

const FAKE_BANNER = "KalCode fake provider (interactive)";
const pane = (page: Page) => page.locator("[data-provider-pane]").first();

function invoke<T>(page: Page, command: string, args: Record<string, unknown> = {}): Promise<T> {
  return page.evaluate(
    ([command, args]) =>
      (
        window as unknown as {
          __TAURI_INTERNALS__: { invoke: (c: string, a: Record<string, unknown>) => Promise<unknown> };
        }
      ).__TAURI_INTERNALS__.invoke(command as string, args as Record<string, unknown>),
    [command, args] as const,
  ) as Promise<T>;
}

async function shot(page: Page, name: string) {
  const dir = fileURLToPath(new URL("../../qa/screenshots/remote/", import.meta.url));
  mkdirSync(dir, { recursive: true });
  await page.waitForTimeout(400);
  await page.getByRole("region", { name: "Remote" }).screenshot({ path: join(dir, `${name}.png`) });
}

/** One devclient run; resolves with its output when it exits. `onOutput` sees the text so far. */
function device(dataDir: string, address: string, onOutput: (text: string) => void = () => undefined) {
  const child: ChildProcess = spawn(DEVCLIENT, ["--data", dataDir, "--addr", address], { stdio: "pipe" });
  let output = "";
  const append = (chunk: Buffer) => {
    output += chunk.toString();
    onOutput(output);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  const done = new Promise<{ code: number | null; output: string }>((resolveDone) =>
    child.once("exit", (code) => resolveDone({ code, output })),
  );
  return { child, done, output: () => output };
}

interface Status {
  enabled: boolean;
  listening: boolean;
  port: number | null;
  pairing: { link: string } | null;
  devices: { id: string; name: string; online: boolean }[];
}

test("a paired device mirrors the real app, answers an approval, and is cut off when removed", async () => {
  test.setTimeout(300_000);
  const dataDir = mkdtempSync(join(tmpdir(), "kalcode-e2e-remote-"));
  const root = mkdtempSync(join(tmpdir(), "kalcode-e2e-remote-project-"));
  const deviceDir = mkdtempSync(join(tmpdir(), "kalcode-e2e-remote-device-"));
  const project = join(root, "remote-site");
  mkdirSync(project);
  writeFileSync(join(project, "README.md"), "# remote site\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: project, stdio: "ignore" });
  git("init", "-q");
  git("-c", "user.email=e2e@kalcode.test", "-c", "user.name=E2E", "add", ".");
  git("-c", "user.email=e2e@kalcode.test", "-c", "user.name=E2E", "commit", "-qm", "init");
  writeFileSync(join(project, "README.md"), "# remote site\n\nChanged on the desktop.\n");
  const bin = join(root, "bin");
  mkdirSync(bin);
  copyFileSync(FAKE, join(bin, "claude.exe"));
  writeManagedFakeProviderConfig(bin);

  const app = await launch(dataDir, {
    KALCODE_E2E_ACCOUNT_FIXTURE: ACCOUNT_OWNER_FIXTURE_OPT_IN,
    KALCODE_E2E_PICK_FOLDER: project,
    KALCODE_E2E_HOOK_DECISIONS: "engine",
    KALCODE_E2E_RESOURCE_FIXTURE: RESOURCE_PROVIDER_FIXTURE_OPT_IN,
    PATH: `${bin};${process.env.PATH ?? ""}`,
  });
  const page = app.page;
  try {
    // A real coding agent (the fake CLI in a real PTY), waiting on an approval.
    await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Code", exact: true }).click();
    await page.getByRole("button", { name: "Open folder…" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "remote-site" })).toBeVisible();
    await waitForProviderAdmission(page);
    await page.getByRole("button", { name: "Agent launch options", exact: true }).click();
    await page
      .getByRole("dialog", { name: "New agent" })
      .getByRole("button", { name: "Launch Claude Code agent" })
      .click();
    await expect(pane(page).locator("[data-pane-terminal] .xterm-rows")).toContainText(FAKE_BANNER, {
      timeout: 30_000,
    });
    await expect(pane(page).locator("[data-pane-status]")).toContainText(/READY|IDLE/, { timeout: 30_000 });
    await pane(page).locator("[data-pane-terminal] .xterm-screen").click();
    await page.keyboard.type("run printenv");
    await page.keyboard.press("Enter");
    await expect(pane(page).locator("[data-pane-status]")).toContainText("NEEDS YOU", { timeout: 30_000 });

    // Settings › Remote: on, then a pairing code.
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const remote = page.getByRole("region", { name: "Remote" });
    await remote.scrollIntoViewIfNeeded();
    await shot(page, "settings-remote-off");
    await remote.getByRole("switch", { name: "KalCode Remote" }).click();
    await expect(remote.getByText(/Listening on \d+ address/)).toBeVisible({ timeout: 15_000 });
    await remote.getByRole("button", { name: "Pair a device" }).click();
    await expect(remote.getByRole("img", { name: /Pairing code/ })).toBeVisible();
    await expect(remote.getByText(/Code expires in [45]:\d\d/)).toBeVisible();
    await shot(page, "settings-remote-pairing");
    const status = await invoke<Status>(page, "remote_status");
    expect(status.listening).toBe(true);
    writeFileSync(join(deviceDir, "pairing-link.txt"), status.pairing?.link ?? "");
    const address = `127.0.0.1:${status.port}`;

    // The device pairs, mirrors the agent and its approval, sees a patch, and approves once.
    const [thread] = await invoke<{ id: string }[]>(page, "thread_list");
    let renamed = false;
    const first = device(deviceDir, address, (text) => {
      if (!renamed && text.includes("snapshot rev")) {
        renamed = true;
        void invoke(page, "thread_rename", { threadId: thread?.id, name: "Remote probe agent" });
      }
    });
    const run = await first.done;
    console.log(run.output);
    expect(run.code, run.output).toBe(0);
    expect(run.output).toMatch(/snapshot rev 1: 1 agents, [1-9]\d* need you/);
    expect(run.output).toMatch(/patch rev 2:/);
    expect(run.output).toMatch(/launch\.options: providers \[.*"Claude Code".*\]/);
    expect(run.output).toMatch(/agent\.diff .*: 1 files/);
    expect(run.output).toMatch(/needs\.decide .*: ok=true .*approved/);
    expect(run.output).toContain("end-to-end session verified");
    // The approval from the phone reached the provider: the agent ran the command.
    await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Code", exact: true }).click();
    await expect(pane(page).locator("[data-pane-terminal] .xterm-rows")).toContainText("RAN Bash", { timeout: 30_000 });

    // Removing the device closes its live connection, and its key is refused from then on.
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(remote.getByText("devclient", { exact: true })).toBeVisible();
    let connected = false;
    const second = device(deviceDir, address, (text) => {
      connected ||= text.includes("snapshot rev");
    });
    await expect.poll(() => connected, { timeout: 15_000 }).toBe(true);
    await expect(remote.getByText("Online now")).toBeVisible({ timeout: 10_000 });
    await shot(page, "settings-remote-device-online");
    await remote.getByRole("button", { name: "Remove" }).click();
    await remote.getByRole("group").getByRole("button", { name: "Remove" }).click();
    const cut = await second.done;
    console.log(cut.output);
    expect(cut.output).toMatch(/Bye \{ reason: Revoked \}|bye Revoked/);
    await expect(remote.getByText("No devices yet.", { exact: false })).toBeVisible();
    const refused = await device(deviceDir, address).done;
    console.log(refused.output);
    expect(refused.code).not.toBe(0);
    expect(refused.output.toLowerCase()).toContain("revoked");
    await shot(page, "settings-remote-after-remove");

    await closeGracefully(app);
  } finally {
    removeDir(dataDir);
    removeDir(root);
    removeDir(deviceDir);
  }
});
