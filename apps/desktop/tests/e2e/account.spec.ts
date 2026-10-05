import { existsSync } from "node:fs";
import { expect } from "@playwright/test";
import {
  ACCOUNT_FIXTURE_OPT_IN,
  closeGracefully,
  createAccountFixtureDataDir,
  EXE,
  launch,
  type Running,
  removeDir,
  test,
} from "./harness.ts";

test.skip(process.platform !== "win32", "Real-app account E2E drives the compiled WebView2 app on Windows.");
test.skip(!existsSync(EXE), `Build the app first: ${EXE}`);

interface RuntimeStatus {
  phase: "signed_out" | "starting" | "ready" | "draining" | "blocked_unclean" | "app_exiting";
  ready: boolean;
}

function invoke<T>(page: Running["page"], command: string, args: Record<string, unknown> = {}): Promise<T> {
  return page.evaluate(
    ([name, payload]) =>
      (
        window as unknown as {
          __TAURI_INTERNALS__: { invoke: (command: string, args: unknown) => Promise<unknown> };
        }
      ).__TAURI_INTERNALS__.invoke(name, payload),
    [command, args] as const,
  ) as Promise<T>;
}

async function invokeErrorCode(
  page: Running["page"],
  command: string,
  args: Record<string, unknown> = {},
): Promise<string> {
  return page.evaluate(
    async ([name, payload]) => {
      try {
        await (
          window as unknown as {
            __TAURI_INTERNALS__: { invoke: (command: string, args: unknown) => Promise<unknown> };
          }
        ).__TAURI_INTERNALS__.invoke(name, payload);
        return "unexpected_success";
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error) {
          return String((error as { code: unknown }).code);
        }
        if (typeof error === "string") {
          try {
            const parsed = JSON.parse(error) as { code?: unknown };
            if (parsed.code !== undefined) return String(parsed.code);
          } catch {
            // Fall through to the opaque rejection for a useful assertion failure.
          }
        }
        return String(error);
      }
    },
    [command, args] as const,
  );
}

async function expectRuntimeSignedOut(page: Running["page"]) {
  await expect.poll(() => invoke<RuntimeStatus>(page, "runtime_status")).toEqual({ phase: "signed_out", ready: false });
}

async function expectShellDenied(page: Running["page"], code: "authentication_required" | "account_not_activated") {
  expect(await invokeErrorCode(page, "thread_list", { workspaceId: null, includeArchived: false })).toBe(code);
}

async function signIn(page: Running["page"]) {
  await page.getByRole("button", { name: "Continue with email" }).click();
  await page.getByRole("textbox", { name: "Email" }).fill("owner@example.com");
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  await page.getByRole("button", { name: "I've verified my email" }).click();
}

test("real native account commands gate onboarding, logout, cleanup, and relogin", async () => {
  const dataDir = createAccountFixtureDataDir();
  let app: Running | null = null;
  try {
    app = await launch(dataDir, { KALCODE_E2E_ACCOUNT_FIXTURE: ACCOUNT_FIXTURE_OPT_IN });
    const { page } = app;
    await expect(page.getByRole("heading", { name: "Welcome to KalCode" })).toBeVisible();
    await expectRuntimeSignedOut(page);
    await expectShellDenied(page, "authentication_required");

    await signIn(page);
    await expect(page.getByRole("heading", { name: "Choose your plan" })).toBeVisible();
    await expectRuntimeSignedOut(page);
    await expectShellDenied(page, "account_not_activated");
    await page.getByRole("button", { name: "Continue with Free" }).click();
    await expect
      .poll(() => invoke<RuntimeStatus>(page, "runtime_status"), { timeout: 20_000 })
      .toEqual({ phase: "ready", ready: true });
    await expect(page.getByRole("heading", { level: 1, name: "Activity" })).toBeVisible();

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const account = page.getByRole("region", { name: "KalCode account" });
    await expect(account).toContainText("owner@example.com");
    await expect(account).toContainText("Free");
    await expect(account).toContainText("0 remaining · 25 / 25 used");

    await account.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByRole("heading", { name: "Welcome to KalCode" })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toHaveCount(0);
    await expectRuntimeSignedOut(page);
    await expectShellDenied(page, "authentication_required");
    expect(await invokeErrorCode(page, "account_activate_free")).toBe("account_not_activated");
    expect(await invoke<{ phase: string }>(page, "account_status")).toMatchObject({ phase: "signed_out" });

    await signIn(page);
    await expect(page.getByRole("heading", { name: "Choose your plan" })).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 1, name: "Activity" })).toBeVisible({ timeout: 20_000 });
  } finally {
    if (app) await closeGracefully(app);
    removeDir(dataDir);
  }
});
