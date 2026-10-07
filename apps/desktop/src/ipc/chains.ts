import type {
  Chain,
  ChainStartRequest,
  ChainStepResult,
  ChainStepRoute,
  ChainsSnapshot,
} from "@kalcode/protocol";
import { toKalCodeError } from "./errors.ts";

export type ChainsCommandName =
  | "chains_snapshot"
  | "chains_start"
  | "chains_pause"
  | "chains_resume"
  | "chains_cancel"
  | "chains_retry_step"
  | "chains_skip_step"
  | "chains_reroute_step"
  | "chains_record_step";

export type ChainsInvoker = <T>(command: ChainsCommandName, args: Record<string, unknown>) => Promise<T>;

/**
 * Agent Handoff Chains. The native authority owns every step's Operation, delivery, outcome and
 * phase; the frontend only renders `ChainsSnapshot` and asks for explicit decisions.
 */
export class ChainsClient {
  constructor(private readonly invoke: ChainsInvoker) {}

  private async call<T>(command: ChainsCommandName, args: Record<string, unknown>): Promise<T> {
    try {
      return await this.invoke<T>(command, args);
    } catch (error) {
      throw toKalCodeError(error, command);
    }
  }

  /** Chains in one workspace, or every workspace when `workspaceId` is null. */
  snapshot(workspaceId: string | null = null): Promise<ChainsSnapshot> {
    return this.call("chains_snapshot", { workspaceId });
  }

  start(request: ChainStartRequest): Promise<Chain> {
    return this.call("chains_start", { request });
  }

  pause(id: string): Promise<Chain> {
    return this.call("chains_pause", { id });
  }

  resume(id: string): Promise<Chain> {
    return this.call("chains_resume", { id });
  }

  cancel(id: string): Promise<Chain> {
    return this.call("chains_cancel", { id });
  }

  /** Runs a failed, blocked, cancelled or interrupted step again, optionally on another route. */
  retryStep(id: string, stepKey: string, route: ChainStepRoute | null = null): Promise<Chain> {
    return this.call("chains_retry_step", { id, stepKey, route });
  }

  /** Lets dependents continue without this step. Never runs or stops anything already done. */
  skipStep(id: string, stepKey: string): Promise<Chain> {
    return this.call("chains_skip_step", { id, stepKey });
  }

  /** Changes provider/account/model/effort for a step that has not started yet. */
  rerouteStep(id: string, stepKey: string, route: ChainStepRoute): Promise<Chain> {
    return this.call("chains_reroute_step", { id, stepKey, route });
  }

  /** The person's explicit outcome for a step whose agent finished without a report. */
  recordStep(id: string, stepKey: string, result: ChainStepResult, summary: string): Promise<Chain> {
    return this.call("chains_record_step", { id, stepKey, result, summary });
  }
}
