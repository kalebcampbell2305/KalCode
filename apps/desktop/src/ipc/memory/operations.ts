/**
 * Stateful Operations runtime for unit tests and the `ui-test` build only. Production and
 * development builds call the native commands directly; this module is excluded by Vite's
 * `__KALCODE_MEMORY_TRANSPORT__` boundary in memoryTransport.ts.
 */
import type {
  DevelopmentService,
  OperationActivity,
  OperationDetail,
  OperationEnvironment,
  OperationRecord,
  OperationSpec,
  OperationsSnapshot,
  Workspace,
} from "@kalcode/protocol";
import type { DashboardHandlers } from "./dashboard.ts";

interface OperationsMemoryOptions {
  empty: boolean;
  workspaces: readonly Workspace[];
  requireCore: () => void;
}

export interface OperationsControls {
  snapshot(): OperationsSnapshot;
  lastAction(): string | null;
  lastOpenedUrl(): string | null;
}

export interface OperationsMemory {
  handlers: DashboardHandlers;
  controls: OperationsControls;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function fail(code: string, message: string): never {
  throw { category: "validation", code, message, retryable: false };
}

function stringArg(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    fail("ipc_rejected", "KalCode couldn't complete that request.");
  }
  return value;
}

function numberArg(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail("ipc_rejected", "KalCode couldn't complete that request.");
  }
  return value;
}

function operationSpec(value: unknown): OperationSpec {
  if (typeof value !== "object" || value === null) {
    fail("ipc_rejected", "KalCode couldn't complete that request.");
  }
  const spec = value as OperationSpec;
  if (!spec.name?.trim() || !spec.workspaceId || (!spec.command?.trim() && !spec.prompt?.trim())) {
    fail("invalid_operation", "Name, workspace, and executable work are required.");
  }
  return clone(spec);
}

function at(offsetMinutes: number): string {
  return new Date(Date.now() + offsetMinutes * 60_000).toISOString();
}

function spec(
  name: string,
  workspaceId: string,
  kind: OperationSpec["kind"],
  command: string | null,
  overrides: Partial<OperationSpec> = {},
): OperationSpec {
  return {
    name,
    workspaceId,
    kind,
    command,
    prompt: null,
    providerId: null,
    providerAccountId: null,
    model: null,
    effort: null,
    dependencies: [],
    priority: 5,
    lane: "next",
    environment: "local",
    urls: [],
    envKeys: [],
    ...overrides,
  };
}

function seedRecord(
  id: string,
  itemSpec: OperationSpec,
  workspaceName: string,
  fields: Partial<OperationRecord>,
): OperationRecord {
  return {
    id,
    spec: itemSpec,
    source: "operations",
    status: "queued",
    workspaceName,
    branch: "feat/operations-services",
    version: null,
    accountLabel: null,
    terminalId: null,
    threadId: null,
    createdAt: at(-95),
    startedAt: null,
    endedAt: null,
    currentAction: null,
    outcome: null,
    position: 0,
    blockers: [],
    ...fields,
  };
}

/** Rich evidence exists only in this test double and is never a fallback for native failures. */
export function createOperationsMemory({ empty, workspaces, requireCore }: OperationsMemoryOptions): OperationsMemory {
  const workspace = workspaces.find((candidate) => candidate.available) ?? workspaces[0];
  const workspaceId = workspace?.id ?? "00000000-0000-4000-8000-000000000001";
  const workspaceName = workspace?.name ?? "kalcode-site";
  let revision = 12;
  let paused = true;
  let nextId = 1;
  let lastAction: string | null = null;
  let lastOpenedUrl: string | null = null;

  let items: OperationRecord[] = empty
    ? []
    : [
        seedRecord("op-service", spec("Frontend dev server", workspaceId, "service", "pnpm dev"), workspaceName, {
          status: "running",
          createdAt: at(-82),
          startedAt: at(-80),
          currentAction: "Serving the local workspace",
          terminalId: "op-service",
        }),
        seedRecord(
          "op-release",
          spec("Publish preview build", workspaceId, "deploy", "pnpm deploy:preview", {
            environment: "preview",
            urls: ["https://preview.example.test"],
            envKeys: ["PREVIEW_TOKEN"],
          }),
          workspaceName,
          {
            status: "succeeded",
            createdAt: at(-68),
            startedAt: at(-65),
            terminalId: "op-release",
            endedAt: at(-58),
            currentAction: null,
            outcome: "Preview build command completed; endpoint health was not probed.",
            version: "0.1.7-build.219",
          },
        ),
        seedRecord("op-failed", spec("Package desktop", workspaceId, "build", "pnpm build"), workspaceName, {
          status: "failed",
          createdAt: at(-46),
          startedAt: at(-44),
          endedAt: at(-40),
          outcome: "Type check failed in the desktop package.",
        }),
        seedRecord("op-typecheck", spec("Typecheck desktop", workspaceId, "test", "pnpm typecheck"), workspaceName, {
          createdAt: at(-18),
          position: 0,
          currentAction: "Waiting for an execution slot",
        }),
        seedRecord(
          "op-docs",
          spec("Build docs", workspaceId, "build", "pnpm docs:build", { lane: "later", priority: 2 }),
          workspaceName,
          {
            status: "paused",
            createdAt: at(-14),
            position: 1,
            currentAction: "Held by user",
          },
        ),
        seedRecord(
          "op-production",
          spec("Deploy production", workspaceId, "deploy", "pnpm deploy", {
            dependencies: ["op-failed"],
            environment: "production",
            urls: ["https://app.example.test"],
            envKeys: ["DEPLOY_TOKEN", "SENTRY_DSN"],
            priority: 9,
          }),
          workspaceName,
          {
            status: "blocked",
            createdAt: at(-10),
            position: 2,
            currentAction: "Waiting for Package desktop",
            blockers: ["op-failed"],
          },
        ),
      ];

  // Older runs exercise the native history cursor without bloating the bounded live snapshot.
  const historyOnly: OperationRecord[] = empty
    ? []
    : [
        seedRecord("op-history-test", spec("Regression suite", workspaceId, "test", "pnpm test"), workspaceName, {
          status: "succeeded",
          createdAt: at(-1_800),
          startedAt: at(-1_798),
          endedAt: at(-1_785),
          outcome: "All registered tests passed.",
        }),
        seedRecord(
          "op-history-script",
          spec("Generate protocol", workspaceId, "script", "pnpm generate"),
          workspaceName,
          {
            status: "succeeded",
            createdAt: at(-2_900),
            startedAt: at(-2_899),
            endedAt: at(-2_897),
            outcome: "Protocol bindings generated.",
          },
        ),
      ];

  let services: DevelopmentService[] = empty
    ? []
    : [
        {
          id: "service-web",
          runId: "op-service",
          name: "Frontend",
          status: "running",
          pid: 14221,
          processName: "node",
          uptimeSeconds: 4_800,
          ports: [3000],
          urls: ["http://localhost:3000"],
          workspaceId,
          workspaceName,
          terminalId: "op-service",
          canStop: true,
          canRestart: true,
          actionReason: null,
        },
        {
          id: "service-database",
          runId: null,
          name: "PostgreSQL",
          status: "stopped",
          pid: null,
          processName: "postgres",
          uptimeSeconds: null,
          ports: [5432],
          urls: [],
          workspaceId,
          workspaceName,
          terminalId: null,
          canStop: false,
          canRestart: false,
          actionReason: "This observed process was not started by KalCode.",
        },
      ];
  const restartEvidence = new Map(
    services.map((service) => [
      service.id,
      {
        pid: service.pid,
        processName: service.processName,
        ports: [...service.ports],
        urls: [...service.urls],
      },
    ]),
  );

  let environments: OperationEnvironment[] = empty
    ? []
    : [
        {
          workspaceId,
          kind: "local",
          branch: "feat/operations-services",
          version: null,
          urls: ["http://localhost:3000"],
          deploymentStatus: "running",
          health: "process_observed",
          platform: "Local process",
          lastDeploy: null,
          runId: "op-service",
          variables: [
            { name: "DATABASE_URL", present: true },
            { name: "ANALYTICS_ENABLED", present: false },
          ],
          observedAt: at(-1),
          notes: ["A listening process was observed; endpoint health has not been probed."],
        },
        {
          workspaceId,
          kind: "preview",
          branch: "feat/operations-services",
          version: "0.1.7-build.219",
          urls: ["https://preview.example.test"],
          deploymentStatus: "deployed_unverified",
          health: "not_probed",
          platform: "Cloudflare Pages",
          lastDeploy: at(-58),
          runId: "op-release",
          variables: [{ name: "PREVIEW_ORIGIN", present: null }],
          observedAt: at(-2),
          notes: [],
        },
        {
          workspaceId,
          kind: "production",
          branch: "main",
          version: "0.1.7-build.218",
          urls: ["https://app.example.test"],
          deploymentStatus: "deployed_unverified",
          health: "not_probed",
          platform: "Update service",
          lastDeploy: at(-1_460),
          runId: null,
          variables: [
            { name: "DEPLOY_REGION", present: null },
            { name: "SENTRY_DSN", present: null },
          ],
          observedAt: at(-20),
          notes: ["Deployment metadata was observed; no current health probe is available."],
        },
      ];

  let activity: OperationActivity[] = empty
    ? []
    : [
        {
          id: "activity-1",
          at: at(-78),
          kind: "service",
          name: "Frontend started",
          area: "Web",
          workspaceId,
          runId: "op-service",
        },
        {
          id: "activity-2",
          at: at(-64),
          kind: "build",
          name: "Preview build created",
          area: "Release",
          workspaceId,
          runId: "op-release",
        },
        {
          id: "activity-3",
          at: at(-59),
          kind: "deploy",
          name: "Preview deployed",
          area: "Release",
          workspaceId,
          runId: "op-release",
        },
        {
          id: "activity-4",
          at: at(-43),
          kind: "file",
          name: "Desktop files changed",
          area: "Desktop",
          workspaceId,
          runId: "op-failed",
        },
        {
          id: "activity-5",
          at: at(-41),
          kind: "failed",
          name: "Desktop build failed",
          area: "Desktop",
          workspaceId,
          runId: "op-failed",
        },
        {
          id: "activity-6",
          at: at(-17),
          kind: "agent",
          name: "Queue inspected",
          area: "Operations",
          workspaceId,
          runId: null,
        },
      ];

  const details = new Map<string, Omit<OperationDetail, "run" | "relatedServices" | "relatedDeployments">>();
  if (!empty) {
    details.set("op-service", {
      timeline: [
        { id: "moment-service-1", at: at(-82), kind: "queued", message: "Added to the Operations queue." },
        { id: "moment-service-2", at: at(-80), kind: "running", message: "Frontend service started." },
      ],
      logs: "vite ready in 412 ms\nLocal: http://localhost:3000/\n",
      files: [],
      artifacts: [],
      tests: [],
      notes: ["Logs are the latest bounded terminal snapshot."],
    });
    details.set("op-release", {
      timeline: [
        { id: "moment-release-1", at: at(-65), kind: "running", message: "Preview build started." },
        { id: "moment-release-2", at: at(-58), kind: "succeeded", message: "Preview deployment completed." },
      ],
      logs: "Building desktop assets\nUploading preview artifact\nEndpoint health was not probed\n",
      files: ["apps/desktop/src/surfaces/operations/OperationsPage.tsx"],
      artifacts: [{ name: "Desktop preview", location: "artifacts/desktop-preview.zip", kind: "archive" }],
      tests: [{ name: "Operations UI", status: "passed", detail: "14 tests passed" }],
      notes: [],
    });
    details.set("op-failed", {
      timeline: [
        { id: "moment-failed-1", at: at(-44), kind: "running", message: "Desktop build started." },
        { id: "moment-failed-2", at: at(-40), kind: "failed", message: "TypeScript compilation failed." },
      ],
      logs: "src/runtime/describeEvent.ts: Function lacks ending return statement\n",
      files: ["apps/desktop/src/runtime/describeEvent.ts"],
      artifacts: [],
      tests: [{ name: "TypeScript", status: "failed", detail: "1 compile error" }],
      notes: ["No artifact was produced."],
    });
  }

  const pending = (item: OperationRecord) =>
    item.startedAt === null && (item.status === "queued" || item.status === "paused" || item.status === "blocked");
  const record = (id: string) =>
    [...items, ...historyOnly].find((candidate) => candidate.id === id) ??
    fail("operation_not_found", "That Operation no longer exists.");
  const detailRelationships = (
    run: OperationRecord,
  ): Pick<OperationDetail, "relatedServices" | "relatedDeployments"> => {
    const currentServices = services
      .filter((service) => service.runId === run.id && service.workspaceId === run.spec.workspaceId)
      .map((service) => ({ service, isCurrent: true }));
    const relatedServices =
      currentServices.length > 0
        ? currentServices
        : run.spec.kind === "service" && run.source === "operations" && run.terminalId !== null
          ? [
              {
                service: {
                  id: run.id,
                  runId: run.id,
                  name: run.spec.name,
                  status:
                    run.status === "succeeded" || run.status === "cancelled"
                      ? "stopped"
                      : run.status === "failed" || run.status === "interrupted"
                        ? "failed"
                        : "unknown",
                  pid: null,
                  processName: "Operation service",
                  uptimeSeconds: null,
                  ports: [],
                  urls: [...run.spec.urls],
                  workspaceId: run.spec.workspaceId,
                  workspaceName: run.workspaceName,
                  terminalId: run.terminalId,
                  canStop: false,
                  canRestart: false,
                  actionReason:
                    "Historical service ownership from this run. No current process is linked; declared URLs are not liveness evidence.",
                },
                isCurrent: false,
              },
            ]
          : [];

    const deploymentRun =
      (run.spec.kind === "deploy" || run.spec.kind === "release") && (run.terminalId !== null || run.threadId !== null);
    const currentDeployments = deploymentRun
      ? environments
          .filter(
            (environment) =>
              environment.runId === run.id &&
              environment.workspaceId === run.spec.workspaceId &&
              environment.kind === run.spec.environment,
          )
          .map((environment) => ({ environment, isCurrent: true }))
      : [];
    const succeeded = run.status === "succeeded";
    const relatedDeployments =
      currentDeployments.length > 0
        ? currentDeployments
        : deploymentRun
          ? [
              {
                environment: {
                  workspaceId: run.spec.workspaceId,
                  kind: run.spec.environment,
                  branch: run.branch,
                  version: run.version,
                  urls: [...run.spec.urls],
                  deploymentStatus:
                    run.status === "starting" || run.status === "running"
                      ? "deploying"
                      : succeeded
                        ? "deployed_unverified"
                        : run.status,
                  health: succeeded ? "not_probed" : "unknown",
                  platform: run.spec.providerId,
                  lastDeploy: succeeded ? run.endedAt : null,
                  runId: run.id,
                  variables: run.spec.envKeys.map((name) => ({ name, present: null })),
                  observedAt: run.endedAt ?? run.startedAt ?? run.createdAt,
                  notes: [
                    succeeded
                      ? "This run's deployment command completed, but it no longer defines the current environment and endpoint health was not probed."
                      : "This run records a deployment attempt that no longer defines the current environment; endpoint health is unknown.",
                    ...(run.spec.urls.length > 0
                      ? ["URLs are declared targets; they are not current liveness evidence."]
                      : []),
                  ],
                },
                isCurrent: false,
              },
            ]
          : [];
    return { relatedServices, relatedDeployments };
  };
  const touch = (action: string) => {
    revision += 1;
    lastAction = action;
  };
  const snapshot = (): OperationsSnapshot => ({
    revision,
    paused,
    items: clone(items),
    services: clone(services),
    environments: clone(environments),
    activity: clone(activity),
    observedAt: new Date().toISOString(),
    warnings: [],
  });
  const requireRevision = (value: unknown) => {
    if (numberArg(value) !== revision) {
      fail("stale_operations_revision", "Operations changed. Refresh before editing the queue.");
    }
  };
  const syncLocalEnvironments = (workspaceIds: ReadonlySet<string>) => {
    environments = environments.map((environment) => {
      if (environment.kind !== "local" || !workspaceIds.has(environment.workspaceId)) return environment;
      const localServices = services.filter((service) => service.workspaceId === environment.workspaceId);
      const running = localServices.some((service) => service.status === "running");
      const failed = localServices.some((service) => service.status === "failed");
      const stopped = localServices.some((service) => service.status === "stopped");
      const deploymentStatus = running ? "running" : failed ? "failed" : stopped ? "stopped" : "not_detected";
      const health = running ? "process_observed" : failed ? "failed" : stopped ? "stopped" : "unknown";
      const notes = environment.notes.filter((note) => !/process (?:and listening port )?was observed/i.test(note));
      if (running) {
        notes.unshift(
          localServices.some((service) => service.status === "running" && service.ports.length > 0)
            ? "A workspace process and listening port were observed; HTTP health was not probed."
            : "A workspace process was observed; no listening port or HTTP health was proven.",
        );
      }
      return {
        ...environment,
        urls: [...new Set(localServices.flatMap((service) => service.urls))],
        deploymentStatus,
        health,
        runId:
          localServices.find((service) => service.status === "running" && service.runId !== null)?.runId ??
          localServices.find((service) => service.runId !== null)?.runId ??
          environment.runId,
        observedAt: new Date().toISOString(),
        notes,
      };
    });
  };
  const stopServices = (matches: (service: DevelopmentService) => boolean) => {
    const workspaceIds = new Set<string>();
    services = services.map((service) => {
      if (!matches(service)) return service;
      workspaceIds.add(service.workspaceId);
      const declaredUrls = service.runId === null ? [] : record(service.runId).spec.urls;
      return {
        ...service,
        status: "stopped",
        pid: null,
        processName: "Operation service",
        uptimeSeconds: null,
        ports: [],
        urls: [...declaredUrls],
        canStop: false,
        actionReason: service.canRestart
          ? "The service is not running, but its Operations command can start it again."
          : service.actionReason,
      };
    });
    syncLocalEnvironments(workspaceIds);
  };
  const cancelOwnedRun = (current: OperationRecord, pendingCancellation = false) => {
    const endedAt = new Date().toISOString();
    const outcome = pendingCancellation ? "Cancelled before starting." : "Cancelled by you.";
    items = items.map((item) =>
      item.id === current.id ? { ...item, status: "cancelled", endedAt, currentAction: null, outcome } : item,
    );
    const evidence = details.get(current.id);
    details.set(current.id, {
      timeline: [
        ...(evidence?.timeline ?? []),
        {
          id: `moment-${current.id}-cancelled`,
          at: endedAt,
          kind: "cancelled",
          message: outcome,
        },
      ],
      logs: evidence?.logs ?? null,
      files: evidence?.files ?? [],
      artifacts: evidence?.artifacts ?? [],
      tests: evidence?.tests ?? [],
      notes: evidence?.notes ?? [],
    });
    activity = [
      ...activity,
      {
        id: `activity-${current.id}-cancelled`,
        at: endedAt,
        kind: current.spec.kind,
        name: `${current.spec.name} cancelled`,
        area: "Operations",
        workspaceId: current.spec.workspaceId,
        runId: current.id,
      },
    ];
    stopServices((service) => service.runId === current.id);
  };

  const handlers: DashboardHandlers = {
    operations_snapshot: () => {
      requireCore();
      return snapshot();
    },
    operations_detail: (args) => {
      requireCore();
      const run = record(stringArg(args.id));
      const evidence = details.get(run.id) ?? {
        timeline: [{ id: `moment-${run.id}`, at: run.createdAt, kind: run.status, message: "Operation recorded." }],
        logs: null,
        files: [],
        artifacts: [],
        tests: [],
        notes: [],
      };
      return clone({ run, ...evidence, ...detailRelationships(run) } satisfies OperationDetail);
    },
    operations_history: (args) => {
      requireCore();
      const before = args.before === null || args.before === undefined ? null : stringArg(args.before);
      const history = [...items, ...historyOnly]
        .filter((item) => item.startedAt !== null)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
      const start = before === null ? 0 : history.findIndex((item) => item.id === before) + 1;
      if (before !== null && start === 0) {
        fail("invalid_operations_history_cursor", "That Operations history cursor is invalid.");
      }
      const page = history.slice(start, start + 2);
      return {
        items: clone(page),
        nextCursor: start + page.length < history.length ? (page.at(-1)?.id ?? null) : null,
      };
    },
    operations_enqueue: (args) => {
      requireCore();
      const nextSpec = operationSpec(args.spec);
      const created: OperationRecord = seedRecord(`op-created-${nextId++}`, nextSpec, workspaceName, {
        createdAt: new Date().toISOString(),
        position: items.filter(pending).length,
      });
      items = [...items, created];
      touch("enqueue");
      return clone(created);
    },
    operations_update: (args) => {
      requireCore();
      requireRevision(args.revision);
      const id = stringArg(args.id);
      const current = record(id);
      if (!pending(current)) fail("operation_not_pending", "Only pending Operations tasks can be edited.");
      const nextSpec = operationSpec(args.spec);
      const updated: OperationRecord = { ...current, spec: nextSpec, workspaceName };
      items = items.map((candidate) => (candidate.id === id ? updated : candidate));
      touch("update");
      return clone(updated);
    },
    operations_reorder: (args) => {
      requireCore();
      requireRevision(args.revision);
      if (!Array.isArray(args.ids) || args.ids.some((id) => typeof id !== "string")) {
        fail("ipc_rejected", "KalCode couldn't complete that request.");
      }
      const ids = args.ids as string[];
      const queued = items.filter(pending);
      if (new Set(ids).size !== queued.length || !queued.every((item) => ids.includes(item.id))) {
        fail("invalid_queue_order", "Refresh Operations before reordering; the complete pending queue is required.");
      }
      const position = new Map(ids.map((id, index) => [id, index]));
      items = items.map((item) =>
        pending(item) ? { ...item, position: position.get(item.id) ?? item.position } : item,
      );
      touch("reorder");
    },
    operations_pause: (args) => {
      requireCore();
      if (typeof args.paused !== "boolean") fail("ipc_rejected", "KalCode couldn't complete that request.");
      if (paused !== args.paused) {
        paused = args.paused;
        touch(paused ? "pause" : "resume");
      }
    },
    operations_hold: (args) => {
      requireCore();
      const id = stringArg(args.id);
      if (typeof args.paused !== "boolean") fail("ipc_rejected", "KalCode couldn't complete that request.");
      const current = record(id);
      if (!pending(current)) fail("operation_not_pending", "Only pending Operations tasks can be paused or resumed.");
      const status = args.paused ? "paused" : current.blockers.length > 0 ? "blocked" : "queued";
      items = items.map((item) =>
        item.id === id ? { ...item, status, currentAction: args.paused ? "Held by user" : null } : item,
      );
      touch(args.paused ? "hold" : "resume_task");
    },
    operations_cancel: (args) => {
      requireCore();
      const id = stringArg(args.id);
      const current = record(id);
      const active =
        current.endedAt === null &&
        (current.status === "starting" ||
          current.status === "running" ||
          (current.startedAt !== null && ["paused", "blocked"].includes(current.status)));
      if (current.source !== "operations" || (!pending(current) && !active))
        fail("operation_not_pending", "Only pending or active Operations tasks can be cancelled.");
      cancelOwnedRun(current, !active);
      touch("cancel");
    },
    operations_run_now: (args) => {
      requireCore();
      if (paused) fail("operations_paused", "Resume Operations before starting queued work.");
      const id = stringArg(args.id);
      const current = record(id);
      if (!pending(current)) fail("operation_not_pending", "This Operations task is no longer pending.");
      if (current.status === "paused") fail("operation_paused", "Resume this task before running it.");
      if (current.blockers.length > 0) fail("operation_blocked", "This task is blocked by a dependency.");
      const startedAt = new Date().toISOString();
      items = items.map((item) =>
        item.id === id ? { ...item, status: "starting", startedAt, currentAction: "Starting" } : item,
      );
      details.set(id, {
        timeline: [
          {
            id: `moment-${id}-queued`,
            at: current.createdAt,
            kind: "queued",
            message: "Added to the Operations queue.",
          },
          {
            id: `moment-${id}-starting`,
            at: startedAt,
            kind: "starting",
            message: "Execution reserved by the scheduler.",
          },
        ],
        logs: null,
        files: [],
        artifacts: [],
        tests: [],
        notes: [],
      });
      activity = [
        ...activity,
        {
          id: `activity-${id}-starting`,
          at: startedAt,
          kind: current.spec.kind,
          name: `${current.spec.name} started`,
          area: "Operations",
          workspaceId,
          runId: id,
        },
      ];
      touch("run_now");
    },
    operations_service_action: (args) => {
      requireCore();
      const id = stringArg(args.id);
      const action = args.action;
      if (action !== "stop" && action !== "restart") fail("ipc_rejected", "KalCode couldn't complete that request.");
      const service =
        services.find((candidate) => candidate.id === id) ??
        fail("service_not_found", "That service is no longer available.");
      if (action === "stop" && !service.canStop)
        fail("service_action_unavailable", service.actionReason ?? "Stop is unavailable.");
      if (action === "restart" && !service.canRestart)
        fail("service_action_unavailable", service.actionReason ?? "Restart is unavailable.");
      if (action === "restart" && paused) fail("operations_paused", "Resume Operations before restarting a service.");
      const owner = service.runId === null ? null : record(service.runId);
      if (owner === null || owner.source !== "operations")
        fail("service_action_unavailable", "This service is not owned by Operations.");
      if (action === "stop") {
        cancelOwnedRun(owner);
      } else {
        if (owner.endedAt === null) cancelOwnedRun(owner);
        const startedAt = new Date().toISOString();
        const successorId = `op-restart-${nextId++}`;
        const successor = seedRecord(successorId, clone(owner.spec), owner.workspaceName, {
          status: "running",
          branch: owner.branch,
          version: owner.version,
          accountLabel: owner.accountLabel,
          terminalId: successorId,
          createdAt: startedAt,
          startedAt,
          currentAction: "Serving the local workspace",
        });
        items = [...items, successor];
        details.set(successorId, {
          timeline: [
            {
              id: `moment-${successorId}-running`,
              at: startedAt,
              kind: "running",
              message: `${successor.spec.name} restarted.`,
            },
          ],
          logs: null,
          files: [],
          artifacts: [],
          tests: [],
          notes: ["Logs are the latest bounded terminal snapshot."],
        });
        const process = restartEvidence.get(id);
        const successorServiceId = `service-${successorId}`;
        services = services.map((candidate) =>
          candidate.id === id
            ? {
                ...candidate,
                id: successorServiceId,
                runId: successorId,
                status: "running",
                pid: (process?.pid ?? 14_000) + nextId,
                processName: process?.processName ?? "Operation service",
                uptimeSeconds: 0,
                ports: [...(process?.ports ?? [])],
                urls: [...(process?.urls ?? [])],
                terminalId: successorId,
                canStop: true,
                canRestart: true,
                actionReason: null,
              }
            : candidate,
        );
        if (process) restartEvidence.set(successorServiceId, process);
        syncLocalEnvironments(new Set([service.workspaceId]));
        activity = [
          ...activity,
          {
            id: `activity-${successorId}-running`,
            at: startedAt,
            kind: successor.spec.kind,
            name: `${successor.spec.name} restarted`,
            area: "Operations",
            workspaceId: successor.spec.workspaceId,
            runId: successorId,
          },
        ];
      }
      touch(`service_${action}`);
    },
    operations_open_url: (args) => {
      requireCore();
      const url = stringArg(args.url);
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        fail("invalid_operations_url", "Only valid HTTP and HTTPS URLs can be opened.");
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        fail("invalid_operations_url", "Only valid HTTP and HTTPS URLs can be opened.");
      }
      lastOpenedUrl = parsed.toString();
      lastAction = "open_url";
    },
  };

  return {
    handlers,
    controls: {
      snapshot: () => snapshot(),
      lastAction: () => lastAction,
      lastOpenedUrl: () => lastOpenedUrl,
    },
  };
}
