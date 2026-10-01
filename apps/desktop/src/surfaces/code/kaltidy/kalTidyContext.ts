import { createContext, useContext } from "react";

/**
 * KalTidy: one-click cleanup of idle terminals. This is the contract every entry point uses —
 * the Code quick action, the Command Palette and KalVoice ("close all idle terminals").
 * `KalTidyProvider` implements it; nothing else stops terminals on KalTidy's behalf.
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

export interface KalTidyApi {
  /** Opens the review-before-stop dialog: every terminal with its class, idle ones preselected. */
  openReview: () => void;
  /** One click: rescans, then stops only terminals classified `idle`. Never throws. */
  stopIdle: () => Promise<KalTidyOutcome>;
}

export const KalTidyContext = createContext<KalTidyApi | null>(null);

/** The KalTidy actions, or null outside `<KalTidyProvider>` (callers hide their entry point). */
export function useKalTidy(): KalTidyApi | null {
  return useContext(KalTidyContext);
}
