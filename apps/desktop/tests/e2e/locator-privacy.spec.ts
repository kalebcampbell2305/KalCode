import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  closeGracefully,
  EXE,
  launch,
  processesMatching,
  removeDir,
  writeManagedFakeProviderConfig,
} from "./harness.ts";

// Real IPC, temporary stores and fake providers: no inference or user data.
test.skip(process.platform !== "win32", "Real-app E2E drives WebView2 and runs on Windows.");
test.skip(!existsSync(EXE), `Build the app first: ${EXE}`);

const FAKE = join(dirname(EXE), "kalcode-fake-provider.exe");
test.skip(!existsSync(FAKE), "Run build:e2e: it builds the fake provider.");

interface StatusLite {
  id: string;
  adapter: string;
  detection: { state: string; auth: string; displayPath: string | null; version: string | null } | null;
}

function invoke<T>(page: Page, command: string, args: Record<string, unknown> = {}): Promise<T> {
  return page.evaluate(
    ([cmd, a]) =>
      (
        window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a: unknown) => Promise<unknown> } }
      ).__TAURI_INTERNALS__.invoke(cmd, a),
    [command, args] as const,
  ) as Promise<T>;
}

test("message search opt-out is immediate and survives restart", async () => {
  test.setTimeout(240_000);
  const dataDir = mkdtempSync(join(tmpdir(), "kalcode-e2e-locator-privacy-"));
  const root = mkdtempSync(join(tmpdir(), "kalcode-e2e-locator-privacy-project-"));
  const project = join(root, "providers2-site");
  mkdirSync(project);
  writeFileSync(join(project, "README.md"), "# providers2 site\n");
  const bin = join(root, "bin");
  mkdirSync(bin);
  copyFileSync(FAKE, join(bin, "codex.exe"));
  copyFileSync(FAKE, join(bin, "gemini.exe"));
  writeManagedFakeProviderConfig(bin);

  try {
    const app = await launch(dataDir, {
      KALCODE_E2E_PICK_FOLDER: project,
      PATH: `${bin};${process.env.PATH ?? ""}`,
    });
    const page = app.page;
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
    await invoke(page, "workspace_open_dialog");

    // Safety gate: native detection found the fakes, not a real install.
    const statuses = await invoke<StatusLite[]>(page, "providers_detect");
    for (const id of ["codex", "gemini-cli"]) {
      const status = statuses.find((s) => s.id === id);
      expect(status?.adapter, id).toBe("implemented");
      expect(status?.detection?.state, id).toBe("installed");
      expect(status?.detection?.displayPath ?? "", `${id} must be the fake`).toContain(basename(root));
    }
    const codexStatus = statuses.find((s) => s.id === "codex");
    // Installation discovery must not inspect the standalone provider's account.
    expect(codexStatus?.detection?.auth).toBe("unknown");
    expect(statuses.find((s) => s.id === "gemini-cli")?.detection?.auth).toBe("unknown");

    const workspaces = await invoke<{ id: string }[]>(page, "workspace_list");
    const workspace = workspaces[0];
    expect(workspace).toBeTruthy();
    await invoke(page, "thread_create", {
      providerId: "codex",
      workspaceId: workspace?.id,
      model: null,
      permissionMode: "plan",
      prompt: "hello privacy",
      name: "Privacy test",
      confirmBypass: null,
      profileId: null,
    });
    await expect
      .poll(async () => {
        const threads = await invoke<{ status: string }[]>(page, "thread_list", {
          workspaceId: null,
          includeArchived: false,
        });
        return threads[0]?.status;
      })
      .toBe("idle");
    // Exercise the actual IPC/index boundary: messages are absent by default, appear after
    // opt-in, and disappear immediately when the opt-out command returns (no worker flush).
    const indexedThreads = await invoke<{ id: string; workspaceId: string; providerId: string }[]>(
      page,
      "thread_list",
      { workspaceId: null, includeArchived: false },
    );
    const indexedThread = indexedThreads.find((thread) => thread.providerId === "codex");
    expect(indexedThread).toBeTruthy();
    const privateMatches = async (target: Page) => {
      const response = await invoke<{ results: { items: { entityId: string }[] } }>(target, "locator_search", {
        query: {
          text: "fake",
          kinds: ["thread"],
          statuses: [],
          providerId: "codex",
          workspaceId: indexedThread?.workspaceId,
          recency: null,
          since: null,
          activeOnly: false,
          sort: "relevance",
          page: null,
          tzOffsetMinutes: 0,
        },
      });
      return response.results.items.map((item) => item.entityId);
    };
    expect(await privateMatches(page)).toEqual([]);
    await invoke(page, "rail_update", {
      update: { workspaceId: indexedThread?.workspaceId, indexMessages: true },
    });
    await expect.poll(() => privateMatches(page)).toContain(indexedThread?.id);
    await invoke(page, "rail_update", {
      update: { workspaceId: indexedThread?.workspaceId, indexMessages: false },
    });
    expect(await privateMatches(page)).toEqual([]);

    await closeGracefully(app);
    expect(processesMatching(bin)).toEqual([]);
    const restarted = await launch(dataDir, { PATH: `${bin};${process.env.PATH ?? ""}` });
    await expect(restarted.page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
    expect(await privateMatches(restarted.page)).toEqual([]);
    await closeGracefully(restarted);
  } finally {
    removeDir(dataDir);
    removeDir(root);
  }
});
