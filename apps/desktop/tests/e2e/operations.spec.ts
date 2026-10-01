import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  DevelopmentService,
  OperationDetail,
  OperationHistoryPage,
  OperationRecord,
  OperationSpec,
  OperationsSnapshot,
  Workspace,
} from "@kalcode/protocol";
import { expect } from "@playwright/test";
import {
  ACCOUNT_READY_FIXTURE_OPT_IN,
  closeGracefully,
  createAccountFixtureDataDir,
  EXE,
  launch,
  type Running,
  removeDir,
  test,
} from "./harness.ts";

test.skip(process.platform !== "win32", "Real Operations E2E drives WebView2 and native Windows processes.");
test.skip(!existsSync(EXE), `Build the app first: ${EXE}`);

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

function shellSpec(
  name: string,
  workspaceId: string,
  command: string,
  overrides: Partial<OperationSpec> = {},
): OperationSpec {
  return {
    name,
    workspaceId,
    kind: "script",
    command,
    prompt: null,
    providerId: null,
    providerAccountId: null,
    model: null,
    effort: null,
    dependencies: [],
    priority: 5,
    lane: "later",
    environment: "local",
    urls: [],
    envKeys: [],
    ...overrides,
  };
}

async function snapshotMatching(
  page: Running["page"],
  predicate: (snapshot: OperationsSnapshot) => boolean,
  timeout = 60_000,
): Promise<OperationsSnapshot> {
  let latest: OperationsSnapshot | null = null;
  await expect
    .poll(
      async () => {
        latest = await invoke<OperationsSnapshot>(page, "operations_snapshot");
        return predicate(latest);
      },
      { timeout, intervals: [100, 250, 500, 1_000] },
    )
    .toBe(true);
  if (!latest) throw new Error("Operations did not return a snapshot");
  return latest;
}

function run(snapshot: OperationsSnapshot, id: string): OperationRecord {
  const found = snapshot.items.find((item) => item.id === id);
  if (!found) throw new Error(`Operations snapshot did not contain run ${id}`);
  return found;
}

async function unusedLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to reserve a loopback port");
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

function initializeRepository(project: string): void {
  writeFileSync(join(project, "README.md"), "# Operations E2E\n", "utf8");
  for (const args of [
    ["init", "-b", "main"],
    ["config", "user.name", "KalCode E2E"],
    ["config", "user.email", "e2e@invalid.example"],
    ["add", "README.md"],
    ["commit", "-m", "Operations fixture"],
  ]) {
    execFileSync("git", args, { cwd: project, stdio: "ignore", windowsHide: true });
  }
}

test("native Operations executes dependencies, controls a local service, and recovers history without replay", async () => {
  test.setTimeout(300_000);
  const dataDir = createAccountFixtureDataDir();
  const projectRoot = mkdtempSync(join(tmpdir(), "kalcode-e2e-operations-project-"));
  const project = join(projectRoot, "operations-fixture");
  mkdirSync(project);
  initializeRepository(project);
  const canonicalProject = realpathSync.native(project);
  const commonEnvironment = {
    KALCODE_E2E_ACCOUNT_FIXTURE: ACCOUNT_READY_FIXTURE_OPT_IN,
    KALCODE_E2E_PICK_FOLDER: canonicalProject,
  };
  let app: Running | null = null;

  try {
    app = await launch(dataDir, { ...commonEnvironment, KALCODE_E2E_NATIVE_CONFIRM: "decline" });
    await expect(app.page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
    const workspace = await invoke<Workspace | null>(app.page, "workspace_open_dialog");
    expect(workspace?.rootPath).toBe(canonicalProject);
    if (!workspace) throw new Error("The native folder picker did not open the Operations fixture");

    const denied = shellSpec("Denied Operations command", workspace.id, "Write-Output 'must-not-run'");
    expect(await invokeErrorCode(app.page, "operations_enqueue", { spec: denied })).toBe("confirmation_declined");
    const deniedSnapshot = await invoke<OperationsSnapshot>(app.page, "operations_snapshot");
    expect(deniedSnapshot.items.some((item) => item.spec.name === denied.name)).toBe(false);

    await closeGracefully(app);
    app = null;

    app = await launch(dataDir, { ...commonEnvironment, KALCODE_E2E_NATIVE_CONFIRM: "accept" });
    await expect(app.page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
    const activeWorkspace = await invoke<Workspace | null>(app.page, "workspace_active");
    expect(activeWorkspace?.id).toBe(workspace.id);

    const initial = await invoke<OperationsSnapshot>(app.page, "operations_snapshot");
    expect(initial.paused).toBe(true);

    const first = await invoke<OperationRecord>(app.page, "operations_enqueue", {
      spec: shellSpec("First native command", workspace.id, "Write-Output 'kalcode-ops-first'; exit 0"),
    });
    const dependent = await invoke<OperationRecord>(app.page, "operations_enqueue", {
      spec: shellSpec("Dependent native command", workspace.id, "Write-Output 'kalcode-ops-dependent'; exit 0", {
        dependencies: [first.id],
        lane: "next",
        priority: 10,
      }),
    });
    const queued = await invoke<OperationsSnapshot>(app.page, "operations_snapshot");
    expect(run(queued, first.id).startedAt).toBeNull();
    expect(run(queued, dependent.id).startedAt).toBeNull();
    expect(run(queued, dependent.id).blockers).toContain(first.id);
    expect(await invokeErrorCode(app.page, "operations_run_now", { id: first.id })).toBe("operations_paused");

    await invoke<void>(app.page, "operations_pause", { paused: false });
    await invoke<void>(app.page, "operations_run_now", { id: first.id });
    const completed = await snapshotMatching(
      app.page,
      (snapshot) =>
        run(snapshot, first.id).status === "succeeded" && run(snapshot, dependent.id).status === "succeeded",
      90_000,
    );
    expect(run(completed, dependent.id).startedAt).not.toBeNull();
    expect(run(completed, dependent.id).blockers).toEqual([]);
    expect(run(completed, first.id).outcome).toContain("code 0");

    const firstDetail = await invoke<OperationDetail>(app.page, "operations_detail", { id: first.id });
    const dependentDetail = await invoke<OperationDetail>(app.page, "operations_detail", { id: dependent.id });
    expect(firstDetail.logs).toContain("kalcode-ops-first");
    expect(dependentDetail.logs).toContain("kalcode-ops-dependent");
    expect(firstDetail.timeline.length).toBeGreaterThan(1);
    expect(dependentDetail.timeline.length).toBeGreaterThan(1);
    expect(completed.activity.some((event) => event.runId === first.id)).toBe(true);
    expect(completed.activity.some((event) => event.runId === dependent.id)).toBe(true);
    expect(
      completed.environments.filter((environment) => environment.workspaceId === workspace.id).map((row) => row.kind),
    ).toEqual(expect.arrayContaining(["local", "preview", "staging", "production"]));

    const port = await unusedLoopbackPort();
    const serviceCommand = [
      `$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, ${port})`,
      "$listener.Start()",
      "Write-Output 'kalcode-ops-service-ready'",
      "try { while ($true) { Start-Sleep -Milliseconds 200 } } finally { $listener.Stop() }",
    ].join("; ");
    const serviceRun = await invoke<OperationRecord>(app.page, "operations_enqueue", {
      spec: shellSpec("Native local service", workspace.id, serviceCommand, {
        kind: "service",
        urls: [`http://127.0.0.1:${port}`],
      }),
    });
    await invoke<void>(app.page, "operations_run_now", { id: serviceRun.id });

    const serving = await snapshotMatching(
      app.page,
      (snapshot) =>
        run(snapshot, serviceRun.id).status === "running" &&
        snapshot.services.some(
          (service) =>
            service.runId === serviceRun.id &&
            service.status === "running" &&
            service.ports.includes(port) &&
            service.canStop &&
            service.canRestart,
        ),
      90_000,
    );
    const observedService = serving.services.find((service) => service.runId === serviceRun.id) as DevelopmentService;
    expect(observedService.urls).toContain(`http://127.0.0.1:${port}`);
    expect((await invoke<OperationDetail>(app.page, "operations_detail", { id: serviceRun.id })).logs).toContain(
      "kalcode-ops-service-ready",
    );
    expect(
      serving.environments.some(
        (environment) =>
          environment.workspaceId === workspace.id &&
          environment.kind === "local" &&
          environment.deploymentStatus === "running" &&
          environment.health === "process_observed",
      ),
    ).toBe(true);
    expect(serving.activity.some((event) => event.runId === serviceRun.id)).toBe(true);

    await invoke<void>(app.page, "operations_service_action", { id: observedService.id, action: "stop" });
    const stopped = await snapshotMatching(
      app.page,
      (snapshot) =>
        run(snapshot, serviceRun.id).status === "cancelled" &&
        snapshot.services.some(
          (service) => service.runId === serviceRun.id && service.status === "stopped" && service.canRestart,
        ),
    );
    const stoppedService = stopped.services.find((service) => service.runId === serviceRun.id) as DevelopmentService;

    await invoke<void>(app.page, "operations_service_action", { id: stoppedService.id, action: "restart" });
    let restartedRunId: string | null = null;
    const restarted = await snapshotMatching(
      app.page,
      (snapshot) => {
        const service = snapshot.services.find(
          (candidate) =>
            candidate.name === serviceRun.spec.name &&
            candidate.runId !== serviceRun.id &&
            candidate.status === "running" &&
            candidate.ports.includes(port),
        );
        restartedRunId = service?.runId ?? null;
        return Boolean(restartedRunId && service?.canStop && service.canRestart);
      },
      90_000,
    );
    if (!restartedRunId) throw new Error("Service restart did not produce a successor run");
    const successorRunId = restartedRunId;
    const restartedService = restarted.services.find((service) => service.runId === successorRunId);
    if (!restartedService) throw new Error("The restarted service disappeared from its snapshot");
    expect(run(restarted, successorRunId).spec.command).toBe(serviceRun.spec.command);
    await invoke<void>(app.page, "operations_service_action", { id: restartedService.id, action: "stop" });
    await snapshotMatching(app.page, (snapshot) => run(snapshot, successorRunId).status === "cancelled", 60_000);

    await closeGracefully(app);
    app = null;

    app = await launch(dataDir, { ...commonEnvironment, KALCODE_E2E_NATIVE_CONFIRM: "accept" });
    await expect(app.page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
    const recovered = await invoke<OperationsSnapshot>(app.page, "operations_snapshot");
    expect(recovered.paused).toBe(true);
    for (const id of [first.id, dependent.id, serviceRun.id, successorRunId]) {
      expect(["starting", "running"]).not.toContain(run(recovered, id).status);
    }
    const history = await invoke<OperationHistoryPage>(app.page, "operations_history", { before: null });
    expect(history.items.map((item) => item.id)).toEqual(
      expect.arrayContaining([first.id, dependent.id, serviceRun.id, successorRunId]),
    );
    expect((await invoke<OperationDetail>(app.page, "operations_detail", { id: first.id })).logs).toContain(
      "kalcode-ops-first",
    );

    const beforeNoReplay = recovered.items.filter((item) => item.spec.name === serviceRun.spec.name).length;
    await app.page.waitForTimeout(2_500);
    const afterNoReplay = await invoke<OperationsSnapshot>(app.page, "operations_snapshot");
    expect(afterNoReplay.items.filter((item) => item.spec.name === serviceRun.spec.name)).toHaveLength(beforeNoReplay);
    expect(
      afterNoReplay.items.some(
        (item) => item.spec.name === serviceRun.spec.name && ["starting", "running"].includes(item.status),
      ),
    ).toBe(false);
  } finally {
    if (app) await closeGracefully(app);
    removeDir(dataDir);
    removeDir(projectRoot);
  }
});
