import type { Destination } from "./navigation.tsx";

/**
 * How much space atmosphere a surface shows (AGENTS.md "Permanent futuristic space design system").
 * Content, then state, then interaction, then atmosphere: dense work surfaces stay quiet, the
 * bridge and voice get the most depth. Static CSS layers only; changing level is an opacity fade.
 */
export type SpaceLevel = "quiet" | "standard" | "cinematic";

const LEVELS: Partial<Record<Destination, SpaceLevel>> = {
  // Cinematic: Mission Control (Activity), KalVoice, Home and the not-yet-built surfaces' heroes.
  dashboard: "cinematic",
  kalvoice: "cinematic",
  home: "cinematic",
  agents: "cinematic",
  missions: "cinematic",
  automations: "cinematic",
  skills: "cinematic",
  plugins: "cinematic",
  command_center: "cinematic",
  // Quiet: settings and long-form text, where clarity is everything.
  settings: "quiet",
  memory: "quiet",
};

/** Standard (Code, Operations, Threads, Providers, the project page) unless listed above. */
export function spaceLevelOf(destination: Destination): SpaceLevel {
  return LEVELS[destination] ?? "standard";
}
