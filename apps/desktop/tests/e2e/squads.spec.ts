import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  IpcError,
  OperationRecord,
  OperationSpec,
  OperationsSnapshot,
  PaneInfo,
  ProviderAccount,
  ProviderAccountModelCatalog,
  SquadDefinition,
  SquadLaunch,
  SquadMemberDefinition,
  SquadsSnapshot,
  ThreadSummary,
  ThreadWorktreeState,
  Workspace,
} from "@kalcode/protocol";
import { expect, type Page } from "@playwright/test";
import {
  ACCOUNT_MAX_FIXTURE_OPT_IN,
  closeGracefully,
  createAccountFixtureDataDir,
  EXE,
  killForcibly,
  launch,
  processesMatching,
  RESOURCE_PROVIDER_FIXTURE_OPT_IN,
  type Running,
  removeDir,
  test,
  waitForProviderAdmission,
  writeManagedFakeProviderConfig,
} from "./harness.ts";

// Real native IPC, SQLite, Operations scheduling, provider-pane PTYs, and restart recovery. The
// MAX entitlement and provider identities are signed deterministic fixtures; no AI service runs.
test.skip(process.platform !== "win32", "Real-app E2E drives Windows WebView2.");
const FAKE = join(dirname(EXE), "kalcode-fake-provider.exe");
const HELPER = join(dirname(EXE), "kalcode-hook.exe");
test.skip(!existsSync(EXE) || !existsSync(FAKE) || !existsSync(HELPER), "Run build:e2e first.");

const codeNav = (page: Page) =>
  page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Code", exact: true });

async function invoke<T>(page: Page, command: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await page.evaluate(
    async ([name, payload]) => {
      try {
        const value = await (
          window as unknown as {
            __TAURI_INTERNALS__: { invoke: (command: string, args: unknown) => Promise<unknown> };
          }
        ).__TAURI_INTERNALS__.invoke(name, payload);
        return { ok: true as const, value };
      } catch (error) {
        const candidate = typeof error === "object" && error !== null ? (error as Record<string, unknown>) : null;
        const typed =
          candidate &&
          typeof candidate.category === "string" &&
          typeof candidate.code === "string" &&
          typeof candidate.message === "string" &&
          typeof candidate.retryable === "boolean";
        const failure: IpcError = typed
          ? {
              category: candidate.category as IpcError["category"],
              code: candidate.code as string,
              message: (candidate.message as string).slice(0, 512),
              retryable: candidate.retryable as boolean,
            }
          : {
              category: "internal",
              code: "untyped_ipc_rejection",
              message:
                typeof error === "string"
                  ? error.slice(0, 512)
                  : "The native command rejected without a typed IPC error.",
              retryable: false,
            };
        return { ok: false as const, error: failure };
      }
    },
    [command, args] as const,
  );
  if (!result.ok) {
    throw new Error(
      `${command} failed [${result.error.category}/${result.error.code}; retryable=${result.error.retryable}]: ${result.error.message}`,
    );
  }
  return result.value as T;
}

interface FixtureSelection {
  accounts: Record<"claude-code" | "codex", ProviderAccount>;
  models: Record<"claude-code" | "codex", string>;
  workspace: Workspace;
}

interface FakeLaunch {
  exe: string;
  args: string[];
}

function fakeSessionLaunches(bin: string): FakeLaunch[] {
  const log = join(bin, "runs.log");
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FakeLaunch)
    .filter(({ exe, args }) => {
      const name = exe.toLowerCase();
      return (
        (name === "claude.exe" && args.includes("--settings")) ||
        (name === "codex.exe" && args.includes("-C") && !args.includes("app-server"))
      );
    });
}

function argumentAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function launchForMember(launches: readonly FakeLaunch[], member: SquadMemberDefinition, threadId: string): FakeLaunch {
  const expectedExe = member.providerId === "claude-code" ? "claude.exe" : "codex.exe";
  const matches = launches.filter(({ exe, args }) => {
    if (exe.toLowerCase() !== expectedExe) return false;
    return member.providerId === "claude-code"
      ? argumentAfter(args, "--session-id") === threadId
      : args.some((argument) => argument.includes(threadId));
  });
  expect(matches, `one native ${member.providerId} process owns canonical thread ${threadId}`).toHaveLength(1);
  const found = matches[0];
  if (!found) throw new Error(`The native launch for ${threadId} was missing`);
  return found;
}

function countOccurrences(text: string | null, marker: string): number {
  return text ? text.split(marker).length - 1 : 0;
}

function operation(snapshot: SquadsSnapshot, id: string): OperationRecord {
  const found = snapshot.operations.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Squad operation ${id} was not present in its canonical snapshot`);
  return found;
}

function queuedOperation(snapshot: OperationsSnapshot, id: string): OperationRecord {
  const found = snapshot.items.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Operations did not contain queued run ${id}`);
  return found;
}

function scriptOperation(name: string, workspaceId: string): OperationSpec {
  return {
    name,
    workspaceId,
    kind: "script",
    command: "Write-Output 'UNRELATED_QUEUE_ITEM_MUST_STAY_PAUSED'",
    prompt: null,
    providerId: null,
    providerAccountId: null,
    model: null,
    effort: null,
    dependencies: [],
    priority: 100,
    lane: "next",
    environment: "local",
    urls: [],
    envKeys: [],
  };
}

function launchMember(launch: SquadLaunch, key: string) {
  const member = launch.members.find((candidate) => candidate.key === key);
  if (!member) throw new Error(`Squad launch did not contain ${key}`);
  return member;
}

function member(
  key: string,
  providerId: "claude-code" | "codex",
  accountId: string,
  model: string,
  overrides: Partial<SquadMemberDefinition> = {},
): SquadMemberDefinition {
  return {
    key,
    name: `${key.replaceAll("-", " ")} agent`,
    providerId,
    providerAccountId: accountId,
    model,
    effort: "high",
    role: "implementation",
    task: `Complete the deterministic ${key} fixture task.`,
    worktree: false,
    dependsOn: [],
    managerKey: null,
    ownedPaths: [`fixture/${key}`],
    ...overrides,
  };
}

async function openProject(page: Page, projectName: string): Promise<Workspace> {
  await expect(page.getByRole("heading", { level: 1, name: "Activity" })).toBeVisible();
  await codeNav(page).click();
  await page.getByRole("button", { name: "Open folder…", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: projectName })).toBeVisible();
  const workspace = await invoke<Workspace | null>(page, "workspace_active");
  if (!workspace) throw new Error("The Squad fixture workspace did not become active");
  return workspace;
}

async function fixtureSelection(page: Page, workspace: Workspace): Promise<FixtureSelection> {
  await waitForProviderAdmission(page);
  const listedAccounts = await invoke<ProviderAccount[]>(page, "provider_accounts_list");
  const selection = {} as FixtureSelection["accounts"];
  const models = {} as FixtureSelection["models"];
  for (const providerId of ["claude-code", "codex"] as const) {
    const account = listedAccounts.find(
      (candidate) =>
        candidate.providerId === providerId &&
        candidate.archivedAt === null &&
        candidate.authenticationState === "authenticated",
    );
    expect(account, `the signed fixture exposes one authenticated ${providerId} account`).toBeTruthy();
    if (!account) throw new Error(`The ${providerId} fixture account was unavailable`);
    const catalog = await invoke<ProviderAccountModelCatalog>(page, "provider_account_models", {
      accountId: account.id,
    });
    expect(catalog).toMatchObject({ accountId: account.id, providerId });
    const model = catalog.models.find((candidate) => candidate.isDefault) ?? catalog.models[0];
    expect(model, `the selected ${providerId} account exposes an exact model`).toBeTruthy();
    if (!model) throw new Error(`The ${providerId} account model catalog was empty`);
    expect(model.supportedEfforts).toContain("high");
    if (providerId === "codex") {
      expect(catalog.models.map(({ id }) => id)).toEqual(["codex-test-exact-a", "codex-test-exact-b"]);
      expect(catalog.models[1]?.supportedEfforts).toEqual(["medium", "xhigh"]);
    }
    selection[providerId] = account;
    models[providerId] = model.id;
  }
  expect(models.codex).toBe("codex-test-exact-a");
  return { accounts: selection, models, workspace };
}

async function threadMap(page: Page, workspaceId: string, ids: readonly string[]): Promise<Map<string, ThreadSummary>> {
  const expected = new Set(ids);
  const threads = await invoke<ThreadSummary[]>(page, "thread_list", {
    workspaceId,
    includeArchived: false,
  });
  return new Map(threads.filter(({ id }) => expected.has(id)).map((thread) => [thread.id, thread]));
}

async function waitForSquadThreads(
  page: Page,
  workspaceId: string,
  ids: readonly string[],
  timeout = 90_000,
): Promise<Map<string, ThreadSummary>> {
  const sortedIds = [...ids].sort();
  await expect
    .poll(async () => [...(await threadMap(page, workspaceId, ids)).keys()].sort(), { timeout })
    .toEqual(sortedIds);
  return threadMap(page, workspaceId, ids);
}

async function expectCodePanes(page: Page, ids: readonly string[]): Promise<void> {
  const expected = [...ids].sort();
  await expect
    .poll(
      () =>
        page.locator("[data-provider-pane]").evaluateAll((elements) =>
          elements
            .map((element) => element.getAttribute("data-provider-pane"))
            .filter((id): id is string => id !== null)
            .sort(),
        ),
      { timeout: 90_000 },
    )
    .toEqual(expected);
}

async function waitForOperation(
  page: Page,
  id: string,
  predicate: (record: OperationRecord) => boolean,
  timeout = 60_000,
): Promise<OperationRecord> {
  await expect
    .poll(
      async () => {
        const current = operation(await invoke<SquadsSnapshot>(page, "squads_snapshot"), id);
        return predicate(current);
      },
      { timeout },
    )
    .toBe(true);
  return operation(await invoke<SquadsSnapshot>(page, "squads_snapshot"), id);
}

async function submitLine(page: Page, threadId: string, line: string): Promise<void> {
  const terminal = page.locator(`[data-provider-pane="${threadId}"] [data-pane-terminal] .xterm-screen`);
  await terminal.click();
  await page.keyboard.type(line);
  await page.keyboard.press("Enter");
}

function writeProviderFixture(root: string): { bin: string; project: string } {
  const project = join(root, "squad-project");
  const bin = join(root, "bin");
  mkdirSync(project);
  mkdirSync(bin);
  writeFileSync(join(project, "README.md"), "# Native Squads E2E\n");
  execFileSync("git", ["init", "--initial-branch=main", project], { windowsHide: true, stdio: "pipe" });
  execFileSync("git", ["-C", project, "config", "user.name", "KalCode E2E"], {
    windowsHide: true,
    stdio: "pipe",
  });
  execFileSync("git", ["-C", project, "config", "user.email", "e2e@kalcode.local"], {
    windowsHide: true,
    stdio: "pipe",
  });
  execFileSync("git", ["-C", project, "add", "README.md"], { windowsHide: true, stdio: "pipe" });
  execFileSync("git", ["-C", project, "commit", "-m", "fixture"], { windowsHide: true, stdio: "pipe" });
  copyFileSync(FAKE, join(bin, "claude.exe"));
  copyFileSync(FAKE, join(bin, "codex.exe"));
  writeManagedFakeProviderConfig(bin);
  const configPath = join(bin, "fake-provider.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  writeFileSync(configPath, `${JSON.stringify({ ...config, exitCode: 7 })}\n`);
  return { bin, project };
}

function fixtureEnvironment(project: string, bin: string) {
  return {
    KALCODE_E2E_ACCOUNT_FIXTURE: ACCOUNT_MAX_FIXTURE_OPT_IN,
    KALCODE_E2E_HOOK_DECISIONS: "engine",
    KALCODE_E2E_NATIVE_CONFIRM: "accept",
    KALCODE_E2E_PICK_FOLDER: project,
    KALCODE_E2E_RESOURCE_FIXTURE: RESOURCE_PROVIDER_FIXTURE_OPT_IN,
    PATH: `${bin};${process.env.PATH ?? ""}`,
  };
}

test("a saved mixed-provider Squad gives every available member a real pane while dependency failure stays isolated", async () => {
  test.setTimeout(360_000);
  const dataDir = createAccountFixtureDataDir();
  const root = mkdtempSync(join(tmpdir(), "kalcode-e2e-squad-scale-"));
  const { bin, project } = writeProviderFixture(root);
  let app: Running | null = null;

  try {
    app = await launch(dataDir, fixtureEnvironment(project, bin));
    const page = app.page;
    const workspace = await openProject(page, "squad-project");
    const selected = await fixtureSelection(page, workspace);
    const missingAccount = "00000000-0000-4000-8000-000000000042";
    const definition: SquadDefinition = {
      id: randomUUID(),
      name: "Parallel delivery",
      goal: "Prove one shared Squad truth over real coding terminals.",
      members: [
        member("lead", "claude-code", selected.accounts["claude-code"].id, selected.models["claude-code"], {
          role: "lead",
        }),
        member("manager", "codex", selected.accounts.codex.id, selected.models.codex, { role: "manager" }),
        member("worker-a", "claude-code", selected.accounts["claude-code"].id, selected.models["claude-code"], {
          managerKey: "lead",
        }),
        member("worker-b", "codex", selected.accounts.codex.id, selected.models.codex, {
          managerKey: "manager",
          task: null,
        }),
        member("tests", "claude-code", selected.accounts["claude-code"].id, selected.models["claude-code"], {
          role: "test",
          task: null,
        }),
        member("release", "codex", selected.accounts.codex.id, selected.models.codex, { role: "release" }),
        member("review", "claude-code", selected.accounts["claude-code"].id, selected.models["claude-code"], {
          role: "review",
          dependsOn: ["tests"],
          task: "say REVIEW_MUST_WAIT_FOR_TESTS",
        }),
        member("failure", "claude-code", selected.accounts["claude-code"].id, selected.models["claude-code"], {
          role: "test",
          task: "exit",
        }),
        member("failure-dependent", "codex", selected.accounts.codex.id, selected.models.codex, {
          role: "review",
          dependsOn: ["failure"],
          task: "say FAILED_DEPENDENCY_MUST_NOT_RUN",
        }),
        member("unavailable", "codex", missingAccount, selected.models.codex, { role: "review" }),
      ],
    };
    const saved = await invoke<SquadDefinition>(page, "squads_save", { definition });
    expect(saved).toEqual(definition);

    const requestId = randomUUID();
    const [first, duplicate] = await Promise.all([
      invoke<SquadLaunch>(page, "squads_launch", {
        requestId,
        squadId: saved.id,
        workspaceId: workspace.id,
        goalOverride: null,
      }),
      invoke<SquadLaunch>(page, "squads_launch", {
        requestId,
        squadId: saved.id,
        workspaceId: workspace.id,
        goalOverride: null,
      }),
    ]);
    expect(duplicate).toEqual(first);
    expect(new Set(first.members.map(({ operationId }) => operationId)).size).toBe(definition.members.length);

    const unavailable = launchMember(first, "unavailable");
    const sessionMembers = first.members.filter(({ key }) => key !== "unavailable");
    const sessionIds = sessionMembers.map(({ operationId }) => operationId);
    const liveMembers = sessionMembers.filter(({ key }) => key !== "failure");
    const liveIds = liveMembers.map(({ operationId }) => operationId);
    const initialSnapshot = await invoke<SquadsSnapshot>(page, "squads_snapshot");
    expect(initialSnapshot.launches.filter(({ id }) => id === first.id)).toHaveLength(1);
    expect(
      initialSnapshot.operations.filter(({ id }) => first.members.some((member) => member.operationId === id)),
    ).toHaveLength(definition.members.length);
    for (const launched of first.members) {
      const declared = definition.members.find(({ key }) => key === launched.key);
      if (!declared) throw new Error(`Missing saved definition for ${launched.key}`);
      expect(operation(initialSnapshot, launched.operationId).spec).toMatchObject({
        providerId: declared.providerId,
        providerAccountId: declared.providerAccountId,
        model: declared.model,
        effort: declared.effort,
      });
    }
    expect(operation(initialSnapshot, unavailable.operationId)).toMatchObject({
      status: "blocked",
      threadId: null,
    });
    expect(operation(initialSnapshot, unavailable.operationId).attentionReason).toMatch(/account is unavailable/i);
    const testsOperationId = launchMember(first, "tests").operationId;
    // squads_launch returns once the members are queued; the Squad dispatcher prepares each
    // dependent member's waiting pane outside the Operations lock, so wait for that pane.
    const reviewId = launchMember(first, "review").operationId;
    const reviewOperation = await waitForOperation(
      page,
      reviewId,
      ({ threadId, currentAction }) => threadId === reviewId && currentAction === "Waiting for dependencies",
    );
    expect(reviewOperation).toMatchObject({
      status: "queued",
      threadId: launchMember(first, "review").operationId,
      blockers: [testsOperationId],
      currentAction: "Waiting for dependencies",
    });
    expect(reviewOperation.spec.dependencies).toEqual([testsOperationId]);

    const failureId = launchMember(first, "failure").operationId;
    const failureDependentId = launchMember(first, "failure-dependent").operationId;
    await waitForOperation(page, launchMember(first, "lead").operationId, ({ status }) => status === "succeeded");
    await waitForOperation(page, failureId, ({ status }) => status === "failed");
    const failedDependent = await waitForOperation(
      page,
      failureDependentId,
      ({ status, blockers }) => status === "blocked" && blockers.includes(failureId),
    );
    expect(failedDependent.threadId).toBe(failureDependentId);

    const threads = await waitForSquadThreads(page, workspace.id, sessionIds);
    await expectCodePanes(page, sessionIds);
    const liveInstanceIds: string[] = [];
    for (const launched of sessionMembers) {
      const declared = definition.members.find(({ key }) => key === launched.key);
      const thread = threads.get(launched.operationId);
      if (!declared || !thread) throw new Error(`Missing canonical state for ${launched.key}`);
      expect(thread).toMatchObject({
        id: launched.operationId,
        workspaceId: workspace.id,
        providerId: declared.providerId,
        providerAccountId: declared.providerAccountId,
        model: declared.model,
        effort: declared.effort,
        runtimeKind: "interactive_pty",
      });
      if (launched.key === "review" || launched.key === "failure-dependent") {
        expect(thread.status).toBe("waiting_for_dependency");
      }
      const pane = page.locator(`[data-provider-pane="${launched.operationId}"]`);
      await expect(pane.locator("[data-pane-terminal] .xterm-rows")).toContainText(
        "KalCode fake provider (interactive",
        {
          timeout: 30_000,
        },
      );
      const info = await invoke<PaneInfo>(page, "provider_pane_info", { threadId: launched.operationId });
      if (launched.key === "failure") {
        expect(info.running).toBe(false);
      } else {
        expect(info.running).toBe(true);
        expect(info.instanceId).not.toBeNull();
        if (info.instanceId) liveInstanceIds.push(info.instanceId);
      }
    }
    expect(new Set(liveInstanceIds).size).toBe(liveIds.length);
    await expect(
      page.locator(
        `[data-provider-pane="${launchMember(first, "review").operationId}"] [data-pane-terminal] .xterm-rows`,
      ),
    ).not.toContainText("REVIEW_MUST_WAIT_FOR_TESTS");
    await expect(
      page.locator(`[data-provider-pane="${failureDependentId}"] [data-pane-terminal] .xterm-rows`),
    ).not.toContainText("FAILED_DEPENDENCY_MUST_NOT_RUN");

    const readyId = launchMember(first, "worker-b").operationId;
    await expect
      .poll(async () => (await invoke<ThreadSummary>(page, "thread_get", { threadId: readyId })).status, {
        timeout: 30_000,
      })
      .toBe("idle");
    await expect(page.locator(`[data-provider-pane="${readyId}"] [data-pane-status]`)).toContainText(/READY|IDLE/);
    await expect.poll(() => processesMatching(bin).length, { timeout: 30_000 }).toBe(liveIds.length);
    await expect.poll(() => fakeSessionLaunches(bin).length, { timeout: 30_000 }).toBe(sessionIds.length);
    const nativeLaunches = fakeSessionLaunches(bin);
    expect(nativeLaunches.every(({ args }) => !args.includes("--resume") && args[0] !== "resume")).toBe(true);
    for (const launched of sessionMembers) {
      const declared = definition.members.find(({ key }) => key === launched.key);
      if (!declared) throw new Error(`Missing native launch definition for ${launched.key}`);
      const nativeLaunch = launchForMember(nativeLaunches, declared, launched.operationId);
      if (declared.providerId === "claude-code") {
        expect(argumentAfter(nativeLaunch.args, "--model")).toBe(declared.model);
        expect(argumentAfter(nativeLaunch.args, "--effort")).toBe(declared.effort);
      } else {
        expect(argumentAfter(nativeLaunch.args, "-m")).toBe(declared.model);
        expect(nativeLaunch.args).toContain(`model_reasoning_effort='${declared.effort}'`);
      }
    }

    await page.screenshot({ path: test.info().outputPath("squad-live-and-waiting-panes.png") });
    await page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("button", { name: "Activity", exact: true })
      .click();
    const fleet = page.getByRole("region", { name: "Agents", exact: true });
    const fleetSearch = page.getByRole("searchbox", { name: "Search agents" });
    for (const launched of sessionMembers) {
      const declared = definition.members.find(({ key }) => key === launched.key);
      if (!declared) throw new Error(`Missing Fleet definition for ${launched.key}`);
      await fleetSearch.fill(declared.name);
      await expect(fleet.locator(`[data-thread-id="${launched.operationId}"]`)).toBeVisible({ timeout: 30_000 });
    }
    const review = launchMember(first, "review");
    await fleetSearch.fill("review agent");
    await expect(fleet.locator(`[data-thread-id="${review.operationId}"]`)).toContainText(/Waiting/i);
    await fleetSearch.fill("");
    await page.screenshot({ path: test.info().outputPath("squad-agent-fleet.png") });

    await codeNav(page).click();
    await submitLine(page, testsOperationId, "say TESTS_PREDECESSOR_DONE");
    await waitForOperation(page, testsOperationId, ({ status }) => status === "succeeded");
    await waitForOperation(page, review.operationId, ({ status }) => status === "succeeded");
    const admittedReview = await invoke<ThreadSummary>(page, "thread_get", { threadId: review.operationId });
    expect(admittedReview).toMatchObject({ id: review.operationId, runtimeKind: "interactive_pty" });
    const reviewRows = page.locator(`[data-provider-pane="${review.operationId}"] [data-pane-terminal] .xterm-rows`);
    await expect
      .poll(() => reviewRows.textContent().then((text) => countOccurrences(text, "REVIEW_MUST_WAIT_FOR_TESTS")))
      .toBe(1);
    expect(operation(await invoke<SquadsSnapshot>(page, "squads_snapshot"), failureDependentId).status).toBe("blocked");
    await expect(
      page.locator(`[data-provider-pane="${failureDependentId}"] [data-pane-terminal] .xterm-rows`),
    ).not.toContainText("FAILED_DEPENDENCY_MUST_NOT_RUN");
    await page.screenshot({ path: test.info().outputPath("squad-dependency-admitted-once.png") });
    await closeGracefully(app);
    app = null;
    await expect.poll(() => processesMatching(bin), { timeout: 30_000 }).toEqual([]);
  } finally {
    if (app) await closeGracefully(app);
    removeDir(dataDir);
    removeDir(root);
  }
});

test("manager takeover, isolated worktrees, and explicit restart recovery retain canonical Squad work", async () => {
  test.setTimeout(420_000);
  const dataDir = createAccountFixtureDataDir();
  const root = mkdtempSync(join(tmpdir(), "kalcode-e2e-squad-recovery-"));
  const { bin, project } = writeProviderFixture(root);
  const env = fixtureEnvironment(project, bin);
  let app: Running | null = null;

  try {
    app = await launch(dataDir, env);
    let page = app.page;
    const workspace = await openProject(page, "squad-project");
    const selected = await fixtureSelection(page, workspace);
    const unauthenticated = await invoke<ProviderAccount>(page, "provider_account_create", {
      providerId: "codex",
      displayName: "Disconnected E2E",
    });
    // A new profile starts "unknown" until it is checked; it has no credentials, so it is never usable.
    expect(unauthenticated.authenticationState).not.toBe("authenticated");
    const definition: SquadDefinition = {
      id: randomUUID(),
      name: "Takeover crew",
      goal: "Keep workers intact if their first manager stops.",
      members: [
        member("lead", "claude-code", selected.accounts["claude-code"].id, selected.models["claude-code"], {
          role: "lead",
          task: null,
        }),
        member("manager", "codex", selected.accounts.codex.id, selected.models.codex, {
          role: "manager",
          task: null,
        }),
        member("worker", "claude-code", selected.accounts["claude-code"].id, selected.models["claude-code"], {
          managerKey: "lead",
          task: null,
          worktree: true,
        }),
        member("gate", "codex", selected.accounts.codex.id, selected.models.codex, { task: null }),
        member("root", "claude-code", selected.accounts["claude-code"].id, selected.models["claude-code"], {
          dependsOn: ["gate"],
          task: "say ROOT_AFTER_GATE",
        }),
        member("dependent", "codex", selected.accounts.codex.id, selected.models.codex, {
          dependsOn: ["root"],
          task: "say DEPENDENT_AFTER_ROOT",
        }),
        member("unavailable", "codex", unauthenticated.id, selected.models.codex),
      ],
    };
    await invoke<SquadDefinition>(page, "squads_save", { definition });
    const launchRecord = await invoke<SquadLaunch>(page, "squads_launch", {
      requestId: randomUUID(),
      squadId: definition.id,
      workspaceId: workspace.id,
      goalOverride: null,
    });
    const operationIds = launchRecord.members.map(({ operationId }) => operationId);
    const before = new Map(launchRecord.members.map(({ key, operationId }) => [key, operationId]));
    const leadId = launchMember(launchRecord, "lead").operationId;
    const workerId = launchMember(launchRecord, "worker").operationId;
    const gateId = launchMember(launchRecord, "gate").operationId;
    const rootId = launchMember(launchRecord, "root").operationId;
    const dependentId = launchMember(launchRecord, "dependent").operationId;
    const unavailableId = launchMember(launchRecord, "unavailable").operationId;
    const initialThreadIds = launchRecord.members
      .filter(({ key }) => key !== "unavailable")
      .map(({ operationId }) => operationId);
    const initialThreads = await waitForSquadThreads(page, workspace.id, initialThreadIds);
    await expectCodePanes(page, initialThreadIds);
    expect(initialThreads.get(rootId)).toMatchObject({ id: rootId, status: "waiting_for_dependency" });
    expect(initialThreads.get(dependentId)).toMatchObject({ id: dependentId, status: "waiting_for_dependency" });
    await expect(page.locator(`[data-provider-pane="${rootId}"] [data-pane-terminal] .xterm-rows`)).not.toContainText(
      "ROOT_AFTER_GATE",
    );
    await expect(
      page.locator(`[data-provider-pane="${dependentId}"] [data-pane-terminal] .xterm-rows`),
    ).not.toContainText("DEPENDENT_AFTER_ROOT");

    // Hold the task-bearing root while its gate runs. The dependent remains independently queued;
    // restart recovery can then prove that explicit Resume reauthorizes both exact objects.
    await invoke<void>(page, "operations_hold", { id: rootId, paused: true });
    await invoke<ThreadSummary>(page, "thread_stop", { threadId: leadId });
    await expect
      .poll(async () => (await invoke<PaneInfo>(page, "provider_pane_info", { threadId: leadId })).running)
      .toBe(false);

    const reassigned = await invoke<SquadLaunch>(page, "squads_reassign_manager", {
      launchId: launchRecord.id,
      memberKey: "worker",
      managerKey: "manager",
    });
    expect(reassigned.members.map(({ key, operationId }) => [key, operationId])).toEqual(
      launchRecord.members.map(({ key, operationId }) => [key, operationId]),
    );
    expect(launchMember(reassigned, "worker").managerKey).toBe("manager");
    expect((await invoke<PaneInfo>(page, "provider_pane_info", { threadId: workerId })).running).toBe(true);
    expect((await invoke<ThreadSummary>(page, "thread_get", { threadId: workerId })).runtimeKind).toBe(
      "interactive_pty",
    );

    const isolatedBefore = await invoke<ThreadSummary>(page, "thread_get", { threadId: workerId });
    expect(isolatedBefore.branch).toMatch(/^kal\//);
    expect(isolatedBefore.worktreeId).not.toBeNull();
    const states = await invoke<ThreadWorktreeState[]>(page, "thread_worktree_states", { threadIds: [workerId] });
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({
      threadId: workerId,
      worktreeId: isolatedBefore.worktreeId,
      branch: isolatedBefore.branch,
    });

    // Relaunch only this ended pane so the fake provider's recorded process cwd belongs
    // deterministically to the isolated member, then verify the actual Git branch in that folder.
    await invoke<ThreadSummary>(page, "thread_stop", { threadId: workerId });
    const resumedWorker = await invoke<ThreadSummary>(page, "thread_resume", {
      threadId: workerId,
      text: null,
      promptReviewId: null,
    });
    expect(resumedWorker).toMatchObject({
      id: workerId,
      branch: isolatedBefore.branch,
      worktreeId: isolatedBefore.worktreeId,
      runtimeKind: "interactive_pty",
    });
    await expect
      .poll(async () => (await invoke<PaneInfo>(page, "provider_pane_info", { threadId: workerId })).running)
      .toBe(true);
    await expect.poll(() => fakeSessionLaunches(bin).length, { timeout: 30_000 }).toBe(initialThreadIds.length + 1);
    const recordedCwd = readFileSync(join(bin, "last-cwd.txt"), "utf8").trim();
    expect(realpathSync.native(recordedCwd)).not.toBe(realpathSync.native(project));
    expect(
      execFileSync("git", ["-C", recordedCwd, "branch", "--show-current"], {
        encoding: "utf8",
        windowsHide: true,
      }).trim(),
    ).toBe(isolatedBefore.branch);

    await submitLine(page, gateId, "say gate-finished");
    await waitForOperation(page, gateId, ({ status }) => status === "succeeded");
    const beforeRestart = await invoke<SquadsSnapshot>(page, "squads_snapshot");
    expect(operation(beforeRestart, rootId).status).toBe("paused");
    expect(operation(beforeRestart, rootId).threadId).toBe(rootId);
    expect(operation(beforeRestart, dependentId)).toMatchObject({
      status: "queued",
      threadId: dependentId,
      blockers: [rootId],
    });
    expect(operation(beforeRestart, unavailableId)).toMatchObject({ status: "blocked", threadId: null });
    await expect(page.locator(`[data-provider-pane="${rootId}"] [data-pane-terminal] .xterm-rows`)).not.toContainText(
      "ROOT_AFTER_GATE",
    );
    await expect(
      page.locator(`[data-provider-pane="${dependentId}"] [data-pane-terminal] .xterm-rows`),
    ).not.toContainText("DEPENDENT_AFTER_ROOT");
    const launchesBeforeRestart = fakeSessionLaunches(bin).length;
    expect(launchesBeforeRestart).toBe(initialThreadIds.length + 1);

    await killForcibly(app);
    app = null;
    await expect.poll(() => processesMatching(bin), { timeout: 30_000 }).toEqual([]);

    app = await launch(dataDir, env);
    page = app.page;
    await expect(page.getByRole("heading", { level: 1, name: "squad-project" })).toBeVisible();
    const recoveredSnapshot = await invoke<SquadsSnapshot>(page, "squads_snapshot");
    const recoveredLaunch = recoveredSnapshot.launches.find(({ id }) => id === launchRecord.id);
    expect(recoveredLaunch).toEqual(reassigned);
    expect(recoveredLaunch?.members.map(({ operationId }) => operationId)).toEqual(operationIds);
    expect(operation(recoveredSnapshot, gateId).status).toBe("succeeded");
    expect(operation(recoveredSnapshot, rootId).status).toBe("paused");
    expect(operation(recoveredSnapshot, dependentId)).toMatchObject({
      status: "paused",
      threadId: dependentId,
    });
    expect(operation(recoveredSnapshot, dependentId).attentionReason).toMatch(/restarted before this member started/i);
    expect(operation(recoveredSnapshot, unavailableId)).toMatchObject({ status: "blocked", threadId: null });
    expect((await invoke<OperationsSnapshot>(page, "operations_snapshot")).paused).toBe(true);
    const unrelated = await invoke<OperationRecord>(page, "operations_enqueue", {
      spec: scriptOperation("Unrelated paused command", workspace.id),
    });
    expect(unrelated).toMatchObject({ status: "queued", startedAt: null });

    const recoveredThreads = await waitForSquadThreads(page, workspace.id, initialThreadIds, 30_000);
    await expectCodePanes(page, initialThreadIds);
    for (const memberRecord of definition.members.filter(({ key }) => key !== "unavailable")) {
      const id = before.get(memberRecord.key);
      const thread = id ? recoveredThreads.get(id) : undefined;
      if (!id || !thread) throw new Error(`Recovered Squad member ${memberRecord.key} was missing`);
      expect(thread).toMatchObject({
        id,
        providerId: memberRecord.providerId,
        providerAccountId: memberRecord.providerAccountId,
        model: memberRecord.model,
        effort: memberRecord.effort,
        runtimeKind: "interactive_pty",
      });
      if (memberRecord.key === "worker") {
        expect(thread).toMatchObject({
          branch: isolatedBefore.branch,
          worktreeId: isolatedBefore.worktreeId,
        });
      }
      expect((await invoke<PaneInfo>(page, "provider_pane_info", { threadId: id })).running).toBe(false);
    }

    // The Operations worker ticks once per second. Observing multiple ticks proves restart did not
    // consume a stale authorization or duplicate a provider process for an uncertain prior run.
    await page.waitForTimeout(2_500);
    expect(fakeSessionLaunches(bin)).toHaveLength(launchesBeforeRestart);
    expect(processesMatching(bin)).toEqual([]);

    await invoke<void>(page, "operations_run_now", { id: rootId });
    await waitForSquadThreads(page, workspace.id, initialThreadIds, 30_000);
    await expectCodePanes(page, initialThreadIds);
    await waitForOperation(page, rootId, ({ status }) => status === "succeeded");
    const rootRows = page.locator(`[data-provider-pane="${rootId}"] [data-pane-terminal] .xterm-rows`);
    await expect.poll(() => rootRows.textContent().then((text) => countOccurrences(text, "ROOT_AFTER_GATE"))).toBe(1);
    await expect.poll(() => fakeSessionLaunches(bin).length, { timeout: 30_000 }).toBe(launchesBeforeRestart + 1);
    const afterRootRunNow = await invoke<OperationsSnapshot>(page, "operations_snapshot");
    expect(afterRootRunNow.paused).toBe(true);
    expect(queuedOperation(afterRootRunNow, unrelated.id)).toMatchObject({ status: "queued", startedAt: null });

    await invoke<void>(page, "operations_run_now", { id: dependentId });
    const finalThreads = await waitForSquadThreads(page, workspace.id, initialThreadIds, 30_000);
    await expectCodePanes(page, initialThreadIds);
    await waitForOperation(page, dependentId, ({ status }) => status === "succeeded");
    const dependentRows = page.locator(`[data-provider-pane="${dependentId}"] [data-pane-terminal] .xterm-rows`);
    await expect
      .poll(() => dependentRows.textContent().then((text) => countOccurrences(text, "DEPENDENT_AFTER_ROOT")))
      .toBe(1);
    await expect.poll(() => fakeSessionLaunches(bin).length, { timeout: 30_000 }).toBe(launchesBeforeRestart + 2);
    const afterDependentRunNow = await invoke<OperationsSnapshot>(page, "operations_snapshot");
    expect(afterDependentRunNow.paused).toBe(true);
    expect(queuedOperation(afterDependentRunNow, unrelated.id)).toMatchObject({ status: "queued", startedAt: null });
    for (const memberKey of ["root", "dependent"] as const) {
      const declared = definition.members.find(({ key }) => key === memberKey);
      const id = launchMember(launchRecord, memberKey).operationId;
      if (!declared) throw new Error(`Missing ${memberKey} definition`);
      expect(finalThreads.get(id)).toMatchObject({
        id,
        providerId: declared.providerId,
        providerAccountId: declared.providerAccountId,
        model: declared.model,
        effort: declared.effort,
        runtimeKind: "interactive_pty",
      });
    }

    let unavailableRetryError: unknown;
    try {
      await invoke<void>(page, "operations_run_now", { id: unavailableId });
    } catch (error) {
      unavailableRetryError = error;
    }
    expect(unavailableRetryError).toBeTruthy();
    const afterUnavailableRetry = operation(await invoke<SquadsSnapshot>(page, "squads_snapshot"), unavailableId);
    expect(afterUnavailableRetry.status).toBe("blocked");
    expect(afterUnavailableRetry.attentionReason).toMatch(/account/i);
    await page.waitForTimeout(2_500);
    expect(fakeSessionLaunches(bin)).toHaveLength(launchesBeforeRestart + 2);
    expect(queuedOperation(await invoke<OperationsSnapshot>(page, "operations_snapshot"), unrelated.id)).toMatchObject({
      status: "queued",
      startedAt: null,
    });
    await page.screenshot({ path: test.info().outputPath("squad-recovered-without-replay.png") });

    await closeGracefully(app);
    app = null;
  } finally {
    if (app) await closeGracefully(app);
    removeDir(dataDir);
    removeDir(root);
  }
});
