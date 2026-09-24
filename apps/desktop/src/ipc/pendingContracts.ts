/**
 * Wire shapes owned by campaigns that have not merged yet. Each mirrors the owning campaign's
 * ts-rs output exactly and is deleted at integration in favour of the generated type from
 * `@kalcode/protocol`. Nothing here is a KalCode contract of its own.
 */

/** Z1 `TerminalStatus` (crates/native-core/src/workspaces.rs on z1/workspace-terminal). */
export type TerminalStatus = "running" | "exited" | "ended_by_app";

/** Z1 `TerminalInfo`, returned by `terminals_running`. Replace with the generated type at integration. */
export interface TerminalInfo {
  id: string;
  workspaceId: string;
  /** Detected shell id this tab runs. */
  shellId: string;
  /** The shell's display name. */
  title: string;
  position: number;
  status: TerminalStatus;
  startedAt: string | null;
  endedAt: string | null;
  exitCode: number | null;
}
