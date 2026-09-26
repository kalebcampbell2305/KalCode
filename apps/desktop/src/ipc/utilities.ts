export type UtilityCommandName =
  | "utility_status"
  | "utility_http_send"
  | "utility_http_history"
  | "utility_http_history_clear"
  | "utility_http_saved_list"
  | "utility_http_saved_save"
  | "utility_http_saved_delete"
  | "utility_processes"
  | "utility_process_signal"
  | "utility_process_restart"
  | "utility_ports"
  | "utility_port_lookup"
  | "utility_env_list"
  | "utility_env_reveal"
  | "utility_sqlite_candidates"
  | "utility_sqlite_open"
  | "utility_sqlite_pick"
  | "utility_sqlite_describe"
  | "utility_sqlite_query"
  | "utility_sqlite_write"
  | "utility_sqlite_close"
  | "utility_effect_continue"
  | "utility_regex"
  | "utility_file_find"
  | "utility_file_read"
  | "utility_scratchpad_list"
  | "utility_scratchpad_save"
  | "utility_scratchpad_delete";

export type UtilityInvoker = <T>(command: UtilityCommandName, args?: Record<string, unknown>) => Promise<T>;

export type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";
export type HttpDestination = "loopback" | "private" | "external" | "link_local";
export type HttpBodyKind = "empty" | "text" | "json" | "binary";

export interface HttpHeader {
  name: string;
  value: string;
  sensitive: boolean;
}

export interface HttpRequestSpec {
  method: HttpMethod;
  url: string;
  query: Array<{ name: string; value: string; enabled: boolean }>;
  headers: HttpHeader[];
  body: string | null;
  timeoutMs: number | null;
  followRedirects: boolean;
}

export interface HttpResponseView {
  status: number;
  reason: string;
  headers: HttpHeader[];
  body: string;
  bodyKind: HttpBodyKind;
  contentType: string | null;
  bytes: number;
  truncated: boolean;
  timing: { resolveMs: number; headersMs: number; totalMs: number };
  url: string;
  redirects: Array<{ status: number; host: string }>;
  destination: HttpDestination;
  remoteAddress: string;
  historyId: string;
}

export interface HttpHistoryEntry {
  id: string;
  at: string;
  method: HttpMethod;
  host: string;
  destination: HttpDestination | null;
  status: number | null;
  errorCode: string | null;
  elapsedMs: number;
  request: HttpRequestSpec;
  redactions: number;
}

export interface HttpSavedRequest {
  id: string;
  name: string;
  request: HttpRequestSpec;
  redactions: number;
  createdAt: string;
  updatedAt: string;
}

export type Killability = { kind: "confirm" } | { kind: "native_confirm" } | { kind: "refused"; reason: string };

export interface ProcessInfo {
  pid: number;
  parentPid: number | null;
  name: string;
  startTime: string;
  cpuPercent: number | null;
  memoryBytes: number;
  owner: "kal_code" | "kal_code_child" | "current_user" | "other_user" | "system" | "unknown";
  role: unknown | null;
  label: string;
  workspaceId: string | null;
  workspaceName: string | null;
  terminalId: string | null;
  terminalGeneration: number | null;
  ports: number[];
  killable: Killability;
  canRestart: boolean;
}

export interface ProcessList {
  processes: ProcessInfo[];
  total: number;
  hidden: number;
  cpuReady: boolean;
  sampledAt: string;
}

export interface ProcessSignalInput {
  pid: number;
  startTime: string;
  signal: "terminate" | "kill";
}

export interface ProcessSignalResult {
  pid: number;
  signal: "terminate" | "kill";
  outcome: "stopped" | "still_running" | "already_exited" | "restarted";
  message: string;
}

export interface ListeningPort {
  protocol: "tcp" | "udp";
  localAddress: string;
  port: number;
  exposure: "loopback" | "all_interfaces" | "interface";
  pid: number | null;
  processName: string | null;
  owner: ProcessInfo["owner"] | null;
  label: string | null;
  workspaceId: string | null;
  workspaceName: string | null;
}

export interface PortList {
  ports: ListeningPort[];
  source: string;
  sampledAt: string;
}

export type EnvSource = { kind: "kal_code" } | { kind: "terminal" } | { kind: "provider"; providerId: string };

export interface EnvListing {
  source: EnvSource;
  entries: Array<{
    name: string;
    redacted: true;
    kind: "empty" | "path_list" | "path" | "number" | "flag" | "url" | "text" | "secret";
    length: number;
    hint: string;
  }>;
  withheld: string[];
  note: string;
}

export interface SqliteObject {
  kind: "table" | "view" | "index" | "trigger";
  name: string;
  table: string | null;
  sql: string | null;
  columns: Array<{
    name: string;
    declType: string;
    notNull: boolean;
    primaryKey: number;
    defaultValue: string | null;
  }>;
}

export interface SqliteHandle {
  id: string;
  displayName: string;
  workspaceId: string | null;
  bytes: number;
  objects: SqliteObject[];
}

export type SqliteCell =
  | { kind: "null" }
  | { kind: "integer"; value: number }
  | { kind: "real"; value: number }
  | { kind: "text"; value: string; truncated: boolean }
  | { kind: "blob"; bytes: number; previewHex: string };

export interface SqliteQueryResult {
  columns: string[];
  rows: SqliteCell[][];
  truncated: boolean;
  nextCursor: string | null;
  offset: number;
  elapsedMs: number;
}

export interface RegexResult {
  matches: Array<{
    start: number;
    end: number;
    text: string;
    groups: Array<{
      index: number;
      name: string | null;
      start: number | null;
      end: number | null;
      text: string | null;
    }>;
  }>;
  total: number;
  truncated: boolean;
  groupCount: number;
  groupNames: Array<string | null>;
  elapsedUs: number;
  error: { message: string } | null;
}

export interface Scratchpad {
  id: string;
  workspaceId: string | null;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface UtilityStatus {
  persistent: boolean;
  portSource: string | null;
}

export interface SqliteWriteResult {
  changes: number;
  elapsedMs: number;
}

/**
 * A consequential Utility call either creates a one-time approval request or consumes a
 * separately approved request. Sensitive request bodies and SQL never cross the continue call.
 */
export type UtilityEffectOutcome =
  | { kind: "awaiting_approval"; approvalId: string }
  | { kind: "http_completed"; response: HttpResponseView }
  | { kind: "process_completed"; result: ProcessSignalResult }
  | { kind: "sqlite_completed"; result: SqliteWriteResult };

export interface UtilityApi {
  status(): Promise<UtilityStatus>;
  httpSend(request: Partial<HttpRequestSpec> & Pick<HttpRequestSpec, "method" | "url">): Promise<UtilityEffectOutcome>;
  httpHistory(): Promise<HttpHistoryEntry[]>;
  processes(scope: "related" | "all"): Promise<ProcessList>;
  processSignal(input: ProcessSignalInput): Promise<UtilityEffectOutcome>;
  processRestart(input: Omit<ProcessSignalInput, "signal">): Promise<UtilityEffectOutcome>;
  ports(): Promise<PortList>;
  envList(source: EnvSource): Promise<EnvListing>;
  envReveal(source: EnvSource, name: string): Promise<{ name: string; value: string }>;
  sqlitePick(): Promise<SqliteHandle | null>;
  sqliteQuery(dbId: string, sql: string, cursor: string | null, limit: number): Promise<SqliteQueryResult>;
  sqliteWrite(dbId: string, sql: string): Promise<UtilityEffectOutcome>;
  effectContinue(approvalId: string): Promise<UtilityEffectOutcome>;
  sqliteClose(dbId: string): Promise<void>;
  regex(pattern: string, text: string): Promise<RegexResult>;
  scratchpads(workspaceId: string | null): Promise<{ items: Scratchpad[]; persistent: boolean }>;
  scratchpadSave(input: {
    id: string | null;
    workspaceId: string | null;
    title: string;
    content: string;
  }): Promise<Scratchpad>;
  scratchpadDelete(id: string): Promise<void>;
}

export class UtilityIpcError extends Error {
  override readonly name = "UtilityIpcError";

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function normalizeUtilityError(error: unknown): UtilityIpcError {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    "message" in error &&
    typeof error.code === "string" &&
    /^[a-z][a-z0-9_]{0,63}$/.test(error.code) &&
    typeof error.message === "string" &&
    error.message.length > 0 &&
    error.message.length <= 512 &&
    !hasUnsafeControlCharacters(error.message)
  ) {
    return new UtilityIpcError(error.code, error.message);
  }
  return new UtilityIpcError("utility_unavailable", "The Utility Dock could not complete that action.");
}

function hasUnsafeControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127)) {
      return true;
    }
  }
  return false;
}

export class UtilityClient implements UtilityApi {
  constructor(private readonly invoke: UtilityInvoker) {}

  private async call<T>(command: UtilityCommandName, args?: Record<string, unknown>): Promise<T> {
    try {
      return await this.invoke<T>(command, args);
    } catch (error) {
      throw normalizeUtilityError(error);
    }
  }

  status(): Promise<UtilityStatus> {
    return this.call("utility_status");
  }

  httpSend(request: Partial<HttpRequestSpec> & Pick<HttpRequestSpec, "method" | "url">): Promise<UtilityEffectOutcome> {
    return this.call("utility_http_send", {
      request: {
        method: request.method,
        url: request.url,
        query: request.query ?? [],
        headers: request.headers ?? [],
        body: request.body ?? null,
        timeoutMs: request.timeoutMs ?? null,
        followRedirects: request.followRedirects ?? false,
      },
    });
  }

  httpHistory(): Promise<HttpHistoryEntry[]> {
    return this.call("utility_http_history");
  }

  processes(scope: "related" | "all"): Promise<ProcessList> {
    return this.call("utility_processes", { scope });
  }

  processSignal(input: ProcessSignalInput): Promise<UtilityEffectOutcome> {
    return this.call("utility_process_signal", { ...input });
  }

  processRestart(input: Omit<ProcessSignalInput, "signal">): Promise<UtilityEffectOutcome> {
    return this.call("utility_process_restart", { ...input });
  }

  ports(): Promise<PortList> {
    return this.call("utility_ports");
  }

  envList(source: EnvSource): Promise<EnvListing> {
    return this.call("utility_env_list", { source });
  }

  envReveal(source: EnvSource, name: string): Promise<{ name: string; value: string }> {
    return this.call("utility_env_reveal", { source, name });
  }

  sqlitePick(): Promise<SqliteHandle | null> {
    return this.call("utility_sqlite_pick");
  }

  sqliteQuery(dbId: string, sql: string, cursor: string | null, limit: number): Promise<SqliteQueryResult> {
    return this.call("utility_sqlite_query", { dbId, sql, cursor, limit });
  }

  sqliteWrite(dbId: string, sql: string): Promise<UtilityEffectOutcome> {
    return this.call("utility_sqlite_write", { dbId, sql });
  }

  effectContinue(approvalId: string): Promise<UtilityEffectOutcome> {
    return this.call("utility_effect_continue", { approvalId });
  }

  sqliteClose(dbId: string): Promise<void> {
    return this.call("utility_sqlite_close", { dbId });
  }

  regex(pattern: string, text: string): Promise<RegexResult> {
    return this.call("utility_regex", {
      pattern,
      text,
      flags: {
        caseInsensitive: false,
        multiLine: false,
        dotMatchesNewLine: false,
        unicode: true,
      },
    });
  }

  scratchpads(workspaceId: string | null): Promise<{ items: Scratchpad[]; persistent: boolean }> {
    return this.call("utility_scratchpad_list", { workspaceId });
  }

  scratchpadSave(input: {
    id: string | null;
    workspaceId: string | null;
    title: string;
    content: string;
  }): Promise<Scratchpad> {
    return this.call("utility_scratchpad_save", { ...input });
  }

  scratchpadDelete(id: string): Promise<void> {
    return this.call("utility_scratchpad_delete", { id });
  }
}
