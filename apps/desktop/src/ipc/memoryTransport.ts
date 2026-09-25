/**
 * In-memory stand-in for the native runtime, used ONLY by unit tests and the `ui-test`
 * Playwright build. It is never bundled into development or production builds (see
 * `__KALCODE_MEMORY_TRANSPORT__` in vite.config.ts). It mirrors native validation and event
 * semantics so UI tests exercise real flows.
 *
 * `?scenario=` (ui-test builds only) selects a starting state:
 *   startup-error      — the core failed to start (newer database)
 *   keychain-failure   — the credential store check fails
 *   code               — workspaces with terminal tabs already open (Code, Dashboard)
 *   threads            — threads in every state (Threads surface fixtures)
 *   no-providers       — no provider is connected (New thread flow empty state)
 *   providers-error    — provider detection fails
 *   providers-none     — no provider CLI is installed
 *   providers-outdated — Claude Code is installed but too old, and signed out
 *   busy | empty | approvals-flood | errors | loading
 *                      — Dashboard data scenarios (see ./memory/dashboard.ts)
 *
 * Commands that no merged campaign registers natively yet are rejected exactly the way Tauri
 * rejects them (Dashboard scenarios implement those contract commands as fixtures).
 */
import type {
  AppInfo,
  BootState,
  Correlation,
  Diagnostics,
  EventEnvelope,
  EventPayload,
  EventSource,
  IpcError,
  ProviderStatus,
  SecureStoreCheck,
  Settings,
  SettingsPatch,
  SurfaceFlag,
  Workspace,
} from "@kalcode/protocol";
import {
  createDashboardFixtures,
  type DashboardControls,
  type DashboardHandlers,
  type DashboardScenario,
  type EmitOptions,
  isDashboardScenario,
} from "./memory/dashboard.ts";
import { detectFake, type ProviderScenario, providerCatalog } from "./memoryProviders.ts";
import { createThreadsMemory } from "./memory/threads.ts";
import { createMemoryWorkspaces, type MemoryWorkspaces } from "./memoryWorkspaces.ts";
import type { CommandName, Transport } from "./transport.ts";

export type MemoryScenario =
  | "default"
  | "startup-error"
  | "keychain-failure"
  | "code"
  | "threads"
  | "no-providers"
  | ProviderScenario
  | DashboardScenario;

const PROVIDER_SCENARIOS: readonly string[] = ["providers-error", "providers-none", "providers-outdated"];

/** Surfaces that work in this build (mirrors crates/native-core/src/flags.rs). */
const AVAILABLE_SURFACES: ReadonlySet<SurfaceFlag["id"]> = new Set([
  "dashboard",
  "code",
  "threads",
  "providers",
  "settings",
]);

/** Latest schema version (mirrors crates/native-core/src/db.rs). */
const SCHEMA_VERSION = 3;

export interface MemoryTransportOptions {
  /** How long fake provider detection takes (the UI shows its busy state meanwhile). */
  detectDelayMs?: number;
}

const SURFACES: SurfaceFlag["id"][] = [
  "dashboard",
  "kalvoice",
  "code",
  "threads",
  "agents",
  "missions",
  "automations",
  "skills",
  "plugins",
  "memory",
  "providers",
  "settings",
];

const SETTINGS_KEYS: Record<keyof Settings, string> = {
  theme: "appearance.theme",
  motion: "appearance.motion",
  density: "appearance.density",
  sidebarCollapsed: "layout.sidebarCollapsed",
};

const PATCH_VALUES: Record<keyof Settings, readonly unknown[]> = {
  theme: ["system", "light", "dark"],
  motion: ["system", "reduced", "full"],
  density: ["comfortable", "compact"],
  sidebarCollapsed: [true, false],
};

function fail(error: IpcError): never {
  throw error;
}

export interface MemoryTransport extends Transport {
  /** Test hook: number of live subscribers. */
  subscriberCount(): number;
  /** Test hooks for Dashboard scenarios (null in scenarios without Dashboard data). */
  readonly dashboard: DashboardControls | null;
  /** Test hooks for workspaces and terminals (folder picker results, moved folders). */
  workspaces: Omit<MemoryWorkspaces, "handlers" | "attachTerminal">;
}

export function createMemoryTransport(
  scenario: MemoryScenario = readScenario(),
  { detectDelayMs = 400 }: MemoryTransportOptions = {},
): MemoryTransport {
  const startedAt = Date.now();
  const info: AppInfo = {
    name: "KalCode",
    version: "0.1.0",
    channel: "development",
    platform: "windows",
    arch: "x86_64",
    flags: {
      surfaces: SURFACES.map((id) => ({
        id,
        state: AVAILABLE_SURFACES.has(id) ? "available" : "gated",
        visible: true,
      })),
    },
  };
  let settings: Settings = { theme: "dark", motion: "system", density: "comfortable", sidebarCollapsed: false };
  const events: EventEnvelope[] = [];
  const subscribers = new Set<(event: EventEnvelope) => void>();
  let lastCheck: { at: string; ok: boolean; backend: string } | null = null;
  let providers: ProviderStatus[] = providerCatalog();
  let detecting: Promise<ProviderStatus[]> | null = null;

  const emit = (event: EventPayload, options: EmitOptions = {}) => {
    const envelope = {
      id: crypto.randomUUID(),
      seq: events.length + 1,
      version: 1,
      occurredAt: options.occurredAt ?? new Date().toISOString(),
      source: options.source ?? "core",
      correlation: {
        workspaceId: null,
        threadId: null,
        missionId: null,
        providerId: null,
        requestId: null,
        ...options.correlation,
      },
      ...event,
    } as EventEnvelope;
    events.push(envelope);
    // Like native: published to the subscribers present now, delivered asynchronously.
    const targets = [...subscribers];
    setTimeout(() => {
      for (const subscriber of targets) if (subscribers.has(subscriber)) subscriber(envelope);
    }, 0);
    return envelope;
  };

  const startupError: IpcError | null =
    scenario === "startup-error"
      ? {
          category: "database",
          code: "schema_too_new",
          message:
            "Your KalCode data was created by a newer version of KalCode. Update KalCode to open it — your data has not been changed.",
          retryable: false,
        }
      : null;

  const dashboard = isDashboardScenario(scenario) ? createDashboardFixtures(scenario, emit, startedAt) : null;
  // Dashboard scenarios simulate a session that has been running for a while.
  const sessionStartMs = startedAt - (dashboard?.sessionAgeMs ?? 0);
  const sessionStart = dashboard ? { occurredAt: new Date(sessionStartMs).toISOString() } : {};

  if (!startupError) {
    emit(
      { type: "database.migrated", payload: { fromVersion: 0, toVersion: SCHEMA_VERSION, backupCreated: false } },
      sessionStart,
    );
    emit(
      {
        type: "app.started",
        payload: { version: info.version, channel: info.channel, platform: info.platform, arch: info.arch },
      },
      sessionStart,
    );
    dashboard?.seedHistory();
  }

  const requireCore = () => {
    if (startupError) fail(startupError);
  };

  /** Mirrors the native registry: serialized, cached, events only for changes. */
  const detectProviders = async (): Promise<ProviderStatus[]> => {
    await new Promise((resolve) => setTimeout(resolve, detectDelayMs));
    if (scenario === "providers-error") {
      fail({
        category: "internal",
        code: "detection_interrupted",
        message: "Checking providers was interrupted.",
        retryable: true,
      });
    }
    const { next, changed } = detectFake(providers, scenario as ProviderScenario, new Date().toISOString());
    providers = next;
    for (const status of changed) {
      const detection = status.detection;
      if (!detection) continue;
      emit(
        {
          type: "provider.detected",
          payload: {
            providerId: status.id,
            installed: detection.state === "installed" || detection.state === "outdated",
            version: detection.version,
          },
        },
        { correlation: { providerId: status.id } },
      );
    }
    return providers;
  };

  const code = createMemoryWorkspaces({
    emit: (event, workspaceId) => emit(event, { correlation: { workspaceId } }),
    requireCore,
    preload: scenario === "code",
  });

  const ensureDetected = async () => {
    if (providers.some((p) => p.detection !== null)) return;
    detecting ??= detectProviders().finally(() => {
      detecting = null;
    });
    await detecting.catch(() => undefined);
  };

  const threads = createThreadsMemory(
    (event, correlation = {}, source = "core") => emit(event, { correlation, source }),
    requireCore,
    scenario === "threads" || scenario === "no-providers" ? scenario : "default",
    () =>
      ((code.handlers.workspace_list?.({}) ?? []) as Workspace[])
        .filter((w) => w.available)
        .map((w) => ({ id: w.id, name: w.name })),
    () => usableProviders(providers),
  );

  const handlers: DashboardHandlers = {
    ...code.handlers,
    ...threads.handlers,
    // Like native: the first thread operation detects providers once, so threads use exactly
    // the providers detection reports usable.
    thread_options: async (args) => {
      await ensureDetected();
      return threads.handlers.thread_options(args);
    },
    thread_create: async (args) => {
      await ensureDetected();
      return threads.handlers.thread_create(args);
    },
    thread_resume: async (args) => {
      await ensureDetected();
      return threads.handlers.thread_resume(args);
    },
    boot: (): BootState => ({ info, startupError }),
    window_ready: () => undefined,
    settings_get: () => {
      requireCore();
      return settings;
    },
    settings_update: (args) => {
      requireCore();
      const patch = (args.patch ?? {}) as Record<string, unknown>;
      // Mirrors native serde: unknown fields and invalid values are rejected before anything runs.
      for (const [key, value] of Object.entries(patch)) {
        const allowed = PATCH_VALUES[key as keyof Settings];
        if (!allowed || (value !== undefined && !allowed.includes(value as never))) {
          fail({
            category: "internal",
            code: "ipc_rejected",
            message: "KalCode couldn't complete that request.",
            retryable: false,
          });
        }
      }
      const entries = Object.entries(patch as SettingsPatch).filter(([, v]) => v !== undefined) as [
        keyof Settings,
        never,
      ][];
      if (entries.length === 0) {
        fail({
          category: "validation",
          code: "empty_settings_patch",
          message: "No settings were provided to update.",
          retryable: false,
        });
      }
      const changed = entries.filter(([key, value]) => settings[key] !== value);
      settings = { ...settings, ...Object.fromEntries(entries) };
      if (changed.length > 0) {
        emit({ type: "settings.changed", payload: { keys: changed.map(([key]) => SETTINGS_KEYS[key]) } });
      }
      return settings;
    },
    events_recent: (args) => {
      requireCore();
      const limit = Number(args.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
        fail({
          category: "validation",
          code: "invalid_page_size",
          message: "Page size must be between 1 and 500.",
          retryable: false,
        });
      }
      const before = typeof args.beforeSeq === "number" ? args.beforeSeq : Number.POSITIVE_INFINITY;
      return events
        .filter((e) => e.seq < before)
        .slice(-limit)
        .reverse();
    },
    events_subscribe: () =>
      fail({ category: "internal", code: "use_subscribe", message: "Use subscribe().", retryable: false }),
    events_unsubscribe: () => true,
    diagnostics_get: (): Diagnostics => {
      requireCore();
      return {
        generatedAt: new Date().toISOString(),
        app: info,
        os: { family: "windows", version: "10.0.26200", arch: "x86_64" },
        uptimeMs: Date.now() - sessionStartMs,
        startedAt: new Date(sessionStartMs).toISOString(),
        database: {
          schemaVersion: SCHEMA_VERSION,
          latestSchemaVersion: SCHEMA_VERSION,
          sizeBytes: 98_304,
          eventCount: events.length,
          journalMode: "wal",
        },
        secureStore: {
          lastCheckedAt: lastCheck?.at ?? null,
          lastCheckOk: lastCheck?.ok ?? null,
          backend: lastCheck?.backend ?? null,
        },
        paths: {
          dataDir: "~\\AppData\\Roaming\\com.kalcode.desktop",
          logDir: "~\\AppData\\Roaming\\com.kalcode.desktop\\logs",
          database: "~\\AppData\\Roaming\\com.kalcode.desktop\\kalcode.db",
        },
      };
    },
    diagnostics_open_log_dir: () => requireCore(),
    diagnostics_open_data_dir: () => undefined,
    secure_store_check: (): SecureStoreCheck => {
      requireCore();
      const ok = scenario !== "keychain-failure";
      const backend = "Windows Credential Manager";
      const at = new Date().toISOString();
      lastCheck = { at, ok, backend };
      emit({ type: "secure_store.checked", payload: { ok, backend } });
      return {
        ok,
        backend,
        checkedAt: at,
        message: ok
          ? null
          : "Your system credential store refused access. Check that it's unlocked, then run the check again.",
      };
    },
    providers_list: () => providers,
    providers_detect: () => {
      detecting ??= detectProviders().finally(() => {
        detecting = null;
      });
      return detecting;
    },
    ...dashboard?.handlers,
  };

  const transport: MemoryTransport = {
    kind: "memory",
    async invoke<T>(command: CommandName, args: Record<string, unknown> = {}): Promise<T> {
      await Promise.resolve();
      const handler = handlers[command];
      // Like Tauri with an app manifest: a command this build doesn't register never runs.
      if (!handler) throw `Command ${command} not allowed by ACL`;
      return (await handler(args)) as T;
    },
    async subscribe(onEvent) {
      requireCore();
      subscribers.add(onEvent);
      return async () => {
        subscribers.delete(onEvent);
      };
    },
    attachTerminal: (terminalId, onOutput) => code.attachTerminal(terminalId, onOutput),
    async streamThread(threadId, onEvent) {
      await Promise.resolve();
      const stop = threads.stream(threadId, onEvent);
      return async () => stop();
    },
    async setNativeTheme() {},
    subscriberCount: () => subscribers.size,
    dashboard: dashboard?.controls ?? null,
    workspaces: {
      queueFolders: code.queueFolders,
      makeUnavailable: code.makeUnavailable,
      runningProcessCount: code.runningProcessCount,
    },
  };
  // UI tests drive the fake folder picker and filesystem, and live Dashboard changes (e.g. an
  // approval arriving), through this hook (ui-test builds only).
  if (typeof window !== "undefined") {
    (window as unknown as { __kalcodeMemory?: unknown }).__kalcodeMemory = {
      ...transport.workspaces,
      dashboard: transport.dashboard,
    };
  }
  return transport;
}

let shared: MemoryTransport | null = null;

/** The page's single in-memory runtime (a real app has one native runtime, even when React
 *  StrictMode boots the UI twice in development). */
export function sharedMemoryTransport(): MemoryTransport {
  shared ??= createMemoryTransport();
  return shared;
}

function readScenario(): MemoryScenario {
  if (typeof location === "undefined") return "default";
  const value = new URLSearchParams(location.search).get("scenario");
  if (
    value === "startup-error" ||
    value === "keychain-failure" ||
    value === "code" ||
    value === "threads" ||
    value === "no-providers" ||
    isDashboardScenario(value)
  ) {
    return value;
  }
  if (value !== null && PROVIDER_SCENARIOS.includes(value)) return value as ProviderScenario;
  return "default";
}

/** Mirrors `ProviderRegistry::usable` (crates/providers/src/registry.rs). */
function usableProviders(statuses: readonly ProviderStatus[]): string[] {
  return statuses
    .filter(
      (s) =>
        s.adapter === "implemented" && s.detection?.state === "installed" && s.detection.auth !== "not_authenticated",
    )
    .map((s) => s.id);
}
