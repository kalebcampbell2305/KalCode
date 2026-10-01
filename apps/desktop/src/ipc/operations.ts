import type {
  OperationDetail,
  OperationHistoryPage,
  OperationRecord,
  OperationSpec,
  OperationsSnapshot,
} from "@kalcode/protocol";

export type OperationsCommandName =
  | "operations_snapshot"
  | "operations_detail"
  | "operations_history"
  | "operations_enqueue"
  | "operations_update"
  | "operations_reorder"
  | "operations_pause"
  | "operations_hold"
  | "operations_cancel"
  | "operations_run_now"
  | "operations_service_action"
  | "operations_open_url";

export type OperationsInvoker = <T>(command: OperationsCommandName, args?: Record<string, unknown>) => Promise<T>;

export interface OperationsApi {
  snapshot(): Promise<OperationsSnapshot>;
  detail(id: string): Promise<OperationDetail>;
  history(before?: string | null): Promise<OperationHistoryPage>;
  enqueue(spec: OperationSpec): Promise<OperationRecord>;
  update(id: string, spec: OperationSpec, revision: number): Promise<OperationRecord>;
  reorder(ids: string[], revision: number): Promise<void>;
  pause(paused: boolean): Promise<void>;
  hold(id: string, paused: boolean): Promise<void>;
  cancel(id: string): Promise<void>;
  runNow(id: string): Promise<void>;
  serviceAction(id: string, action: "stop" | "restart"): Promise<void>;
  openUrl(url: string): Promise<void>;
}

export class OperationsIpcError extends Error {
  override readonly name = "OperationsIpcError";

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
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

function normalizeOperationsError(error: unknown): OperationsIpcError {
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
    return new OperationsIpcError(error.code, error.message);
  }
  return new OperationsIpcError("operations_unavailable", "Operations could not complete that action.");
}

/** Thin, typed boundary over the native Operations authority. It never invents local success. */
export class OperationsClient implements OperationsApi {
  constructor(private readonly invoke: OperationsInvoker) {}

  private async call<T>(command: OperationsCommandName, args?: Record<string, unknown>): Promise<T> {
    try {
      return await this.invoke<T>(command, args);
    } catch (error) {
      throw normalizeOperationsError(error);
    }
  }

  snapshot(): Promise<OperationsSnapshot> {
    return this.call("operations_snapshot", {});
  }

  detail(id: string): Promise<OperationDetail> {
    return this.call("operations_detail", { id });
  }

  history(before: string | null = null): Promise<OperationHistoryPage> {
    return this.call("operations_history", { before });
  }

  enqueue(spec: OperationSpec): Promise<OperationRecord> {
    return this.call("operations_enqueue", { spec });
  }

  update(id: string, spec: OperationSpec, revision: number): Promise<OperationRecord> {
    return this.call("operations_update", { id, spec, revision });
  }

  reorder(ids: string[], revision: number): Promise<void> {
    return this.call("operations_reorder", { ids, revision });
  }

  pause(paused: boolean): Promise<void> {
    return this.call("operations_pause", { paused });
  }

  hold(id: string, paused: boolean): Promise<void> {
    return this.call("operations_hold", { id, paused });
  }

  cancel(id: string): Promise<void> {
    return this.call("operations_cancel", { id });
  }

  runNow(id: string): Promise<void> {
    return this.call("operations_run_now", { id });
  }

  serviceAction(id: string, action: "stop" | "restart"): Promise<void> {
    return this.call("operations_service_action", { id, action });
  }

  openUrl(url: string): Promise<void> {
    return this.call("operations_open_url", { url });
  }
}
