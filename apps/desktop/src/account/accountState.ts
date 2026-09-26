import type { AccountSnapshot, RuntimeStatus } from "../ipc/account.ts";

export interface AccountUiError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface AccountUiState {
  generation: number;
  snapshot: AccountSnapshot;
  runtime: RuntimeStatus;
  busy: boolean;
  error: AccountUiError | null;
}

export type AccountUiEvent =
  | { type: "begin"; generation: number }
  | { type: "resolved"; generation: number; snapshot: AccountSnapshot; runtime: RuntimeStatus }
  | { type: "snapshot"; generation: number; snapshot: AccountSnapshot }
  | { type: "runtime"; generation: number; runtime: RuntimeStatus }
  | { type: "error"; generation: number; error: AccountUiError };

export const initialAccountUiState: AccountUiState = {
  generation: 0,
  snapshot: {
    phase: "bootstrapping",
    account: null,
    tier: null,
    sessionExpiresAt: null,
    entitlementExpiresAt: null,
    offlineGraceUntil: null,
    pendingEmail: null,
    pendingExpiresAt: null,
    degradedReason: null,
  },
  runtime: { phase: "starting", ready: false },
  busy: true,
  error: null,
};

export function reduceAccountUi(state: AccountUiState, event: AccountUiEvent): AccountUiState {
  if (event.generation < state.generation) return state;
  switch (event.type) {
    case "begin":
      return { ...state, generation: event.generation, busy: true, error: null };
    case "resolved":
      return {
        generation: event.generation,
        snapshot: event.snapshot,
        runtime: event.runtime,
        busy: false,
        error: null,
      };
    case "snapshot":
      return { ...state, generation: event.generation, snapshot: event.snapshot, busy: false };
    case "runtime":
      return { ...state, generation: event.generation, runtime: event.runtime, busy: false };
    case "error":
      return { ...state, generation: event.generation, busy: false, error: event.error };
  }
}
