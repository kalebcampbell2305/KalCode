import { createContext, useContext } from "react";

/**
 * KalTidy: one cleanup tool for terminals and coding agents. This is the contract every entry
 * point uses — the Code KalTidy menu, the Command Palette and KalVoice ("close all idle
 * terminals"). `KalTidyProvider` implements it; nothing else stops terminals on KalTidy's behalf.
 */

/** How KalTidy sees a terminal. Only `idle` is ever stopped by default. */
export type KalTidyClass = "active" | "waiting" | "idle" | "background" | "protected";

export interface KalTidyOutcome {
  /** Terminals KalTidy stopped. */
  stopped: number;
  /** Terminals left running because they were not idle. */
  kept: number;
  /** Idle terminals that failed to stop. */
  failed: number;
  /** One short sentence for a toast or for KalVoice to speak ("Stopped 3 idle terminals."). */
  summary: string;
}

/** The result of clearing failed or finished agents. */
export interface KalTidyClearOutcome {
  /** Agents removed (archived, their sessions ended and panes closed). */
  cleared: number;
  /** Agents that couldn't be removed. */
  failed: number;
  /** One short sentence for a toast ("Cleared 2 failed agents."). */
  summary: string;
}

export interface KalTidyApi {
  /**
   * Opens the review: every terminal with its class (idle ones preselected), the failed and
   * finished agents the clears would remove, and what each action would clean.
   */
  openReview: () => void;
  /** One click: rescans, then stops only terminals classified `idle`. Never throws. */
  stopIdle: () => Promise<KalTidyOutcome>;
  /**
   * Removes every failed coding agent (all workspaces): its dead session ends, its pane closes
   * and it leaves Agent Fleet and Needs You (kept in the archived view). No confirmation.
   */
  clearFailed: () => Promise<KalTidyClearOutcome>;
  /**
   * Removes every finished, stopped or offline coding agent (all workspaces), the same way.
   * Never touches an agent that is working, waiting, idle at its prompt or needs the person.
   */
  clearFinished: () => Promise<KalTidyClearOutcome>;
  /**
   * Removes one coding agent whose session is over (failed, finished, stopped or offline) — the
   * agent cards' X. The same canonical removal as the clears; an agent still in use is refused.
   * Resolves true when it was removed; a failure is reported in a toast. Never throws.
   */
  dismissAgent: (agentId: string) => Promise<boolean>;
  /**
   * Opens the single "Close all terminals and agents?" confirmation. On "Close all", every
   * terminal and coding agent in the current workspace ends, whatever it is doing, and its pane
   * closes.
   */
  closeAll: () => void;
}

export const KalTidyContext = createContext<KalTidyApi | null>(null);

/** The KalTidy actions, or null outside `<KalTidyProvider>` (callers hide their entry point). */
export function useKalTidy(): KalTidyApi | null {
  return useContext(KalTidyContext);
}
