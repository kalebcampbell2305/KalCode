import { describe, expect, it } from "vitest";
import {
  type LaunchReadinessProbe,
  waitForLaunchConnection,
  waitForLaunchReadiness,
} from "../../tests/e2e/launchReadiness.ts";

interface Candidate {
  ready: boolean;
  valid?: boolean;
}

function stagedProbe(stages: readonly (readonly Candidate[])[]) {
  let now = 0;
  let stage = 0;
  const probe: LaunchReadinessProbe<Candidate> = {
    now: () => now,
    timer: (milliseconds) => {
      let handle: ReturnType<typeof setTimeout> | undefined;
      let canceled = false;
      const elapsed = new Promise<void>((resolveElapsed) => {
        handle = setTimeout(() => {
          if (!canceled) {
            now += milliseconds;
            stage = Math.min(stage + 1, stages.length - 1);
          }
          resolveElapsed();
        }, 0);
      });
      return {
        elapsed,
        cancel: () => {
          canceled = true;
          if (handle !== undefined) clearTimeout(handle);
        },
      };
    },
    startupError: () => null,
    exitCode: () => null,
    databaseReady: () => true,
    candidates: () => stages[stage] ?? [],
    initialized: async (candidate) => candidate.ready,
    candidateValid: (candidate) => candidate.valid !== false,
  };
  return probe;
}

describe("native E2E launch readiness", () => {
  it("waits for a context and an initialized Tauri document", async () => {
    const ready = { ready: true };
    const probe = stagedProbe([[], [{ ready: false }], [ready]]);

    await expect(
      waitForLaunchReadiness(probe, { deadline: 1_000, processName: "kalcode.exe", pollMilliseconds: 10 }),
    ).resolves.toBe(ready);
  });

  it("does not accept an initialized candidate that closed while it was evaluated", async () => {
    const closed = { ready: true, valid: true };
    const ready = { ready: true, valid: true };
    const probe = stagedProbe([[closed], [ready]]);
    probe.initialized = async (candidate) => {
      if (candidate === closed) closed.valid = false;
      return candidate.ready;
    };

    await expect(
      waitForLaunchReadiness(probe, { deadline: 1_000, processName: "kalcode.exe", pollMilliseconds: 10 }),
    ).resolves.toBe(ready);
  });

  it("does not probe an initialized document before the isolated database exists", async () => {
    let databaseReady = false;
    let initializedCalls = 0;
    const candidate = { ready: true };
    const probe = stagedProbe([[candidate]]);
    const originalTimer = probe.timer;
    probe.timer = (milliseconds) => {
      const timer = originalTimer(milliseconds);
      return {
        ...timer,
        elapsed: timer.elapsed.then(() => {
          databaseReady = true;
        }),
      };
    };
    probe.databaseReady = () => databaseReady;
    probe.initialized = async () => {
      initializedCalls += 1;
      return true;
    };

    await expect(
      waitForLaunchReadiness(probe, { deadline: 1_000, processName: "kalcode.exe", pollMilliseconds: 10 }),
    ).resolves.toBe(candidate);
    expect(initializedCalls).toBe(1);
  });

  it("fails within the shared deadline when the document remains blank", async () => {
    const probe = stagedProbe([[{ ready: false }]]);

    await expect(
      waitForLaunchReadiness(probe, { deadline: 20, processName: "kalcode.exe", pollMilliseconds: 10 }),
    ).rejects.toThrow("within 30 seconds");
  });

  it("fails immediately if the owned process exits while readiness is pending", async () => {
    let exited = false;
    const probe = stagedProbe([[], []]);
    const originalTimer = probe.timer;
    probe.timer = (milliseconds) => {
      const timer = originalTimer(milliseconds);
      return {
        ...timer,
        elapsed: timer.elapsed.then(() => {
          exited = true;
        }),
      };
    };
    probe.exitCode = () => (exited ? 23 : null);

    await expect(
      waitForLaunchReadiness(probe, { deadline: 1_000, processName: "kalcode.exe", pollMilliseconds: 10 }),
    ).rejects.toThrow("exited with code 23");
  });

  it("preserves the spawn error as the startup failure cause", async () => {
    const startupError = new Error("synthetic spawn failure");
    const probe = stagedProbe([[]]);
    probe.startupError = () => startupError;

    await expect(waitForLaunchReadiness(probe, { deadline: 1_000, processName: "kalcode.exe" })).rejects.toMatchObject({
      message: "kalcode.exe could not start",
      cause: startupError,
    });
  });

  it("does not accept readiness that resolves after the absolute deadline", async () => {
    let now = 0;
    const candidate = { ready: true };
    const probe = stagedProbe([[candidate]]);
    probe.now = () => now;
    probe.initialized = async () => {
      now = 21;
      return true;
    };

    await expect(
      waitForLaunchReadiness(probe, { deadline: 20, processName: "kalcode.exe", pollMilliseconds: 10 }),
    ).rejects.toThrow("within 30 seconds");
  });

  it("does not accept readiness after the owned process exits", async () => {
    let exited = false;
    const candidate = { ready: true };
    const probe = stagedProbe([[candidate]]);
    probe.exitCode = () => (exited ? 31 : null);
    probe.initialized = async () => {
      exited = true;
      return true;
    };

    await expect(
      waitForLaunchReadiness(probe, { deadline: 1_000, processName: "kalcode.exe", pollMilliseconds: 10 }),
    ).rejects.toThrow("exited with code 31");
  });

  it("bounds an initialized-document probe that never settles", async () => {
    const probe = stagedProbe([[{ ready: false }]]);
    probe.initialized = () => new Promise<boolean>(() => undefined);
    const result = await Promise.race([
      waitForLaunchReadiness(probe, { deadline: 20, processName: "kalcode.exe", pollMilliseconds: 10 }).then(
        () => "resolved",
        () => "rejected",
      ),
      new Promise<string>((resolveRace) => setTimeout(() => resolveRace("hung"), 50)),
    ]);

    expect(result).toBe("rejected");
  });

  it("does not start a CDP retry after a late failure reaches the deadline", async () => {
    let now = 0;
    let connectCalls = 0;
    const probe = stagedProbe([[]]);
    probe.now = () => now;
    const originalTimer = probe.timer;
    probe.timer = (milliseconds) => {
      const timer = originalTimer(milliseconds);
      return {
        ...timer,
        elapsed: timer.elapsed.then(() => {
          now += milliseconds;
        }),
      };
    };

    await expect(
      waitForLaunchConnection(probe, {
        deadline: 20,
        processName: "kalcode.exe",
        port: 9333,
        pollMilliseconds: 10,
        connect: async (timeout) => {
          connectCalls += 1;
          expect(timeout).toBe(20);
          now = 19;
          throw new Error("synthetic refusal");
        },
        disposeLate: async () => undefined,
      }),
    ).rejects.toThrow("did not open CDP port 9333 within 30 seconds");
    expect(connectCalls).toBe(1);
  });

  it("disposes a connection that resolves after the absolute deadline", async () => {
    let now = 0;
    let disposed = false;
    const connection = { id: 7 };
    const probe = stagedProbe([[]]);
    probe.now = () => now;

    await expect(
      waitForLaunchConnection(probe, {
        deadline: 20,
        processName: "kalcode.exe",
        port: 9333,
        connect: async () => {
          now = 21;
          return connection;
        },
        disposeLate: async (late) => {
          expect(late).toBe(connection);
          disposed = true;
        },
      }),
    ).rejects.toThrow("did not open CDP port 9333 within 30 seconds");
    expect(disposed).toBe(true);
  });
});
