/**
 * In-memory stand-in for the native runtime, used ONLY by unit tests and the `ui-test`
 * Playwright build. It is never bundled into development or production builds (see
 * `__KALCODE_MEMORY_TRANSPORT__` in vite.config.ts). It mirrors native validation and event
 * semantics so UI tests exercise real flows.
 *
 * `?scenario=` (ui-test builds only) selects a starting state:
 *   startup-error      — the core failed to start (newer database)
 *   keychain-failure   — the credential store check fails
 */
import type {
  AppInfo,
  BootState,
  Diagnostics,
  EventEnvelope,
  EventPayload,
  IpcError,
  SecureStoreCheck,
  Settings,
  SettingsPatch,
  SurfaceFlag,
} from "@kalcode/protocol";
import type { CommandName, Transport } from "./transport.ts";

export type MemoryScenario = "default" | "startup-error" | "keychain-failure";

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
}

export function createMemoryTransport(scenario: MemoryScenario = readScenario()): MemoryTransport {
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
        state: id === "dashboard" || id === "settings" ? "available" : "gated",
        visible: true,
      })),
    },
  };
  let settings: Settings = { theme: "dark", motion: "system", density: "comfortable", sidebarCollapsed: false };
  const events: EventEnvelope[] = [];
  const subscribers = new Set<(event: EventEnvelope) => void>();
  let lastCheck: { at: string; ok: boolean; backend: string } | null = null;

  const emit = (event: EventPayload) => {
    const envelope = {
      id: crypto.randomUUID(),
      seq: events.length + 1,
      version: 1,
      occurredAt: new Date().toISOString(),
      source: "core",
      correlation: { workspaceId: null, threadId: null, missionId: null, providerId: null, requestId: null },
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

  if (!startupError) {
    emit({ type: "database.migrated", payload: { fromVersion: 0, toVersion: 1, backupCreated: false } });
    emit({
      type: "app.started",
      payload: { version: info.version, channel: info.channel, platform: info.platform, arch: info.arch },
    });
  }

  const requireCore = () => {
    if (startupError) fail(startupError);
  };

  const handlers: Record<CommandName, (args: Record<string, unknown>) => unknown> = {
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
        uptimeMs: Date.now() - startedAt,
        startedAt: new Date(startedAt).toISOString(),
        database: {
          schemaVersion: 1,
          latestSchemaVersion: 1,
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
  };

  return {
    kind: "memory",
    async invoke<T>(command: CommandName, args: Record<string, unknown> = {}): Promise<T> {
      await Promise.resolve();
      return handlers[command](args) as T;
    },
    async subscribe(onEvent) {
      requireCore();
      subscribers.add(onEvent);
      return async () => {
        subscribers.delete(onEvent);
      };
    },
    async setNativeTheme() {},
    subscriberCount: () => subscribers.size,
  };
}

function readScenario(): MemoryScenario {
  if (typeof location === "undefined") return "default";
  const value = new URLSearchParams(location.search).get("scenario");
  return value === "startup-error" || value === "keychain-failure" ? value : "default";
}
