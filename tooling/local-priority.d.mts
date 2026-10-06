/** The priority local heavy work should take, or null to leave it unchanged. */
export function localPriority(env?: NodeJS.ProcessEnv | Record<string, string | undefined>): number | null;

/** Lowers this process (and what it starts afterwards) for local heavy work; never raises or throws. */
export function lowerLocalPriority(options?: {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  set?: (pid: number, priority: number) => void;
}): number | null;
