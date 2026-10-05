import { cpus, freemem } from "node:os";

// Optional CI gates yield to owner work. Never suspend or kill running checks or agents.
export function createGateCapacity(
  jobs,
  { cpu = cpus, free = freemem, now = Date.now, reserveBytes = 16 * 1024 ** 3 } = {},
) {
  let previous = null;
  let previousAt = 0;
  let budget = 1;
  let recovered = 0;
  return () => {
    const time = now();
    if (previous && time - previousAt < 900) return budget;
    const samples = cpu();
    const memory = free();
    if (!samples.length || !Number.isFinite(memory) || memory <= 0) return 0;
    const next = samples.reduce(
      (total, core) => ({
        idle: total.idle + core.times.idle,
        all: total.all + Object.values(core.times).reduce((a, b) => a + b, 0),
      }),
      { idle: 0, all: 0 },
    );
    const elapsed = previous ? next.all - previous.all : 0;
    const utilization = elapsed > 0 ? 100 * (1 - (next.idle - previous.idle) / elapsed) : null;
    previous = next;
    previousAt = time;
    if (memory < reserveBytes || (utilization !== null && utilization >= 85)) {
      recovered = 0;
      budget = 0;
    } else if (++recovered >= 2) {
      budget = memory < reserveBytes + 4 * 1024 ** 3 || utilization === null || utilization >= 70 ? 1 : jobs;
    }
    return budget;
  };
}
