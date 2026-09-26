import type {
  EnvListing,
  EnvSource,
  HttpHistoryEntry,
  HttpRequestSpec,
  PortList,
  ProcessList,
  ProcessSignalInput,
  RegexResult,
  Scratchpad,
  SqliteHandle,
  SqliteQueryResult,
  UtilityApi,
  UtilityEffectOutcome,
  UtilityStatus,
} from "../utilities.ts";

type Overrides = Partial<{
  [Name in keyof UtilityApi]: UtilityApi[Name];
}>;

const FIXTURE_TIME = "2026-09-25T00:00:00.000Z";

/** Effect-free Utility Dock test double with deterministic local state and explicit overrides. */
export class MemoryUtilityApi implements UtilityApi {
  readonly calls = {
    httpSend: [] as Array<Partial<HttpRequestSpec> & Pick<HttpRequestSpec, "method" | "url">>,
    processSignal: [] as ProcessSignalInput[],
    processRestart: [] as Array<Omit<ProcessSignalInput, "signal">>,
    sqliteWrite: [] as Array<{ dbId: string; sql: string }>,
    effectContinue: [] as string[],
  };
  private readonly pads = new Map<string, Scratchpad>();
  private nextPad = 1;

  constructor(private readonly overrides: Overrides = {}) {}

  status(): Promise<UtilityStatus> {
    return this.overrides.status?.() ?? Promise.resolve({ persistent: false, portSource: null });
  }

  httpSend(request: Partial<HttpRequestSpec> & Pick<HttpRequestSpec, "method" | "url">): Promise<UtilityEffectOutcome> {
    this.calls.httpSend.push({ ...request });
    return this.overrides.httpSend?.(request) ?? Promise.reject(new Error("No memory HTTP response was configured."));
  }

  httpHistory(): Promise<HttpHistoryEntry[]> {
    return this.overrides.httpHistory?.() ?? Promise.resolve([]);
  }

  processes(scope: "related" | "all"): Promise<ProcessList> {
    return (
      this.overrides.processes?.(scope) ??
      Promise.resolve({
        processes: [],
        total: 0,
        hidden: 0,
        cpuReady: false,
        sampledAt: FIXTURE_TIME,
      })
    );
  }

  processSignal(input: ProcessSignalInput): Promise<UtilityEffectOutcome> {
    this.calls.processSignal.push({ ...input });
    return (
      this.overrides.processSignal?.(input) ??
      Promise.resolve({ kind: "awaiting_approval", approvalId: `memory-process-${input.pid}` })
    );
  }

  processRestart(input: Omit<ProcessSignalInput, "signal">): Promise<UtilityEffectOutcome> {
    this.calls.processRestart.push({ ...input });
    return (
      this.overrides.processRestart?.(input) ??
      Promise.resolve({ kind: "awaiting_approval", approvalId: `memory-restart-${input.pid}` })
    );
  }

  ports(): Promise<PortList> {
    return (
      this.overrides.ports?.() ??
      Promise.resolve({
        ports: [],
        source: "unavailable",
        sampledAt: FIXTURE_TIME,
      })
    );
  }

  envList(source: EnvSource): Promise<EnvListing> {
    return (
      this.overrides.envList?.(source) ??
      Promise.resolve({
        source,
        entries: [],
        withheld: [],
        note: "Memory fixture; no environment was read.",
      })
    );
  }

  envReveal(source: EnvSource, name: string): Promise<{ name: string; value: string }> {
    return (
      this.overrides.envReveal?.(source, name) ??
      Promise.reject(new Error("No memory environment value was configured."))
    );
  }

  sqlitePick(): Promise<SqliteHandle | null> {
    return this.overrides.sqlitePick?.() ?? Promise.resolve(null);
  }

  sqliteQuery(dbId: string, sql: string, cursor: string | null, limit: number): Promise<SqliteQueryResult> {
    return (
      this.overrides.sqliteQuery?.(dbId, sql, cursor, limit) ??
      Promise.resolve({
        columns: [],
        rows: [],
        truncated: false,
        nextCursor: null,
        offset: 0,
        elapsedMs: 0,
      })
    );
  }

  sqliteWrite(dbId: string, sql: string): Promise<UtilityEffectOutcome> {
    this.calls.sqliteWrite.push({ dbId, sql });
    return (
      this.overrides.sqliteWrite?.(dbId, sql) ??
      Promise.resolve({ kind: "awaiting_approval", approvalId: `memory-sqlite-${dbId}` })
    );
  }

  effectContinue(approvalId: string): Promise<UtilityEffectOutcome> {
    this.calls.effectContinue.push(approvalId);
    return (
      this.overrides.effectContinue?.(approvalId) ??
      Promise.reject(new Error("No memory approval continuation was configured."))
    );
  }

  sqliteClose(dbId: string): Promise<void> {
    return this.overrides.sqliteClose?.(dbId) ?? Promise.resolve();
  }

  regex(pattern: string, text: string): Promise<RegexResult> {
    return (
      this.overrides.regex?.(pattern, text) ??
      Promise.resolve({
        matches: [],
        total: 0,
        truncated: false,
        groupCount: 0,
        groupNames: [],
        elapsedUs: 0,
        error: null,
      })
    );
  }

  scratchpads(workspaceId: string | null): Promise<{ items: Scratchpad[]; persistent: boolean }> {
    if (this.overrides.scratchpads) return this.overrides.scratchpads(workspaceId);
    return Promise.resolve({
      items: [...this.pads.values()].filter((pad) => pad.workspaceId === workspaceId),
      persistent: false,
    });
  }

  scratchpadSave(input: {
    id: string | null;
    workspaceId: string | null;
    title: string;
    content: string;
  }): Promise<Scratchpad> {
    if (this.overrides.scratchpadSave) return this.overrides.scratchpadSave(input);
    const prior = input.id ? this.pads.get(input.id) : undefined;
    const pad: Scratchpad = {
      id: input.id ?? `memory-scratchpad-${this.nextPad++}`,
      workspaceId: input.workspaceId,
      title: input.title,
      content: input.content,
      createdAt: prior?.createdAt ?? FIXTURE_TIME,
      updatedAt: FIXTURE_TIME,
    };
    this.pads.set(pad.id, pad);
    return Promise.resolve(pad);
  }

  scratchpadDelete(id: string): Promise<void> {
    if (this.overrides.scratchpadDelete) return this.overrides.scratchpadDelete(id);
    this.pads.delete(id);
    return Promise.resolve();
  }
}
