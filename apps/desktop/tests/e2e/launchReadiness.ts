export interface LaunchReadinessTimer {
  elapsed: Promise<void>;
  cancel(): void;
}

export interface OwnedProcessProbe {
  now(): number;
  timer(milliseconds: number): LaunchReadinessTimer;
  startupError(): Error | null;
  exitCode(): number | null;
}

export interface LaunchReadinessProbe<T> extends OwnedProcessProbe {
  databaseReady(): boolean;
  candidates(): readonly T[];
  initialized(candidate: T): Promise<boolean>;
  candidateValid(candidate: T): boolean;
}

export interface LaunchReadinessOptions {
  deadline: number;
  processName: string;
  pollMilliseconds?: number;
}

export interface LaunchConnectionOptions<T> extends LaunchReadinessOptions {
  port: number;
  connect(timeoutMilliseconds: number): Promise<T>;
  disposeLate(connection: T): Promise<void>;
}

function pollMilliseconds(options: LaunchReadinessOptions): number {
  const milliseconds = options.pollMilliseconds ?? 100;
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    throw new Error("launch readiness poll interval must be positive");
  }
  return milliseconds;
}

function assertOwnedProcess(probe: OwnedProcessProbe, processName: string): void {
  const startupError = probe.startupError();
  if (startupError) throw new Error(`${processName} could not start`, { cause: startupError });
  const exitCode = probe.exitCode();
  if (exitCode !== null) {
    throw new Error(`${processName} exited with code ${String(exitCode)} before its native window was ready`);
  }
}

function deadlineError(processName: string, databaseReady: boolean): Error {
  return databaseReady
    ? new Error(`${processName} did not expose an initialized Tauri document within 30 seconds`)
    : new Error(`${processName} did not use the isolated data folder; build it with --features e2e`);
}

async function waitOnce(probe: OwnedProcessProbe, milliseconds: number): Promise<void> {
  const timer = probe.timer(milliseconds);
  try {
    await timer.elapsed;
  } finally {
    timer.cancel();
  }
}

/** Connects without starting any attempt, or sleeping between attempts, past the absolute deadline. */
export async function waitForLaunchConnection<T>(
  probe: OwnedProcessProbe,
  options: LaunchConnectionOptions<T>,
): Promise<T> {
  const interval = pollMilliseconds(options);
  let connectionError: unknown = null;
  while (true) {
    assertOwnedProcess(probe, options.processName);
    const remaining = options.deadline - probe.now();
    if (remaining <= 0) {
      throw new Error(`${options.processName} did not open CDP port ${options.port} within 30 seconds`, {
        cause: connectionError,
      });
    }

    try {
      const connection = await options.connect(remaining);
      try {
        assertOwnedProcess(probe, options.processName);
        if (probe.now() >= options.deadline) {
          throw new Error(`${options.processName} did not open CDP port ${options.port} within 30 seconds`, {
            cause: connectionError,
          });
        }
        return connection;
      } catch (error) {
        await options.disposeLate(connection);
        throw error;
      }
    } catch (error) {
      connectionError = error;
      assertOwnedProcess(probe, options.processName);
      const retryRemaining = options.deadline - probe.now();
      if (retryRemaining <= 0) {
        throw new Error(`${options.processName} did not open CDP port ${options.port} within 30 seconds`, {
          cause: connectionError,
        });
      }
      await waitOnce(probe, Math.min(interval, retryRemaining));
    }
  }
}

async function candidateInitializedBeforeDeadline<T>(
  probe: LaunchReadinessProbe<T>,
  candidate: T,
  options: LaunchReadinessOptions,
  interval: number,
): Promise<boolean> {
  const initialized = Promise.resolve()
    .then(() => probe.initialized(candidate))
    .then(
      (ready) => ({ settled: true as const, ready }),
      () => ({ settled: true as const, ready: false }),
    );

  while (true) {
    assertOwnedProcess(probe, options.processName);
    const remaining = options.deadline - probe.now();
    if (remaining <= 0) throw deadlineError(options.processName, true);
    const timer = probe.timer(Math.min(interval, remaining));
    let outcome: { settled: true; ready: boolean } | null;
    try {
      outcome = await Promise.race([initialized, timer.elapsed.then(() => null)]);
    } finally {
      timer.cancel();
    }
    assertOwnedProcess(probe, options.processName);
    if (probe.now() >= options.deadline) throw deadlineError(options.processName, true);
    if (outcome !== null) return outcome.ready;
  }
}

/** Returns only after the isolated store and one initialized native document are both visible. */
export async function waitForLaunchReadiness<T>(
  probe: LaunchReadinessProbe<T>,
  options: LaunchReadinessOptions,
): Promise<T> {
  const interval = pollMilliseconds(options);
  while (true) {
    assertOwnedProcess(probe, options.processName);
    const databaseReady = probe.databaseReady();
    if (probe.now() >= options.deadline) throw deadlineError(options.processName, databaseReady);

    if (databaseReady) {
      for (const candidate of probe.candidates()) {
        if (
          (await candidateInitializedBeforeDeadline(probe, candidate, options, interval)) &&
          probe.candidateValid(candidate)
        ) {
          return candidate;
        }
      }
    }

    assertOwnedProcess(probe, options.processName);
    const remaining = options.deadline - probe.now();
    if (remaining <= 0) throw deadlineError(options.processName, databaseReady);
    await waitOnce(probe, Math.min(interval, remaining));
  }
}
