import { join } from "node:path";
import { writeJsonAtomic } from "./status.mjs";

/** Shared owner-readable status, never command text, output, environment or credentials. */
export function createGateReport({
  directory,
  head,
  base,
  worker = "local",
  plan,
  now = () => new Date().toISOString(),
}) {
  if (!directory || !/^[0-9a-f]{40}$/.test(head ?? "")) return null;
  const safeWorker = worker.replace(/[^a-zA-Z0-9_-]/g, "_");
  const path = join(directory, `${head}-${safeWorker}-${process.pid}.json`);
  const report = {
    schema: "kalcode-gate-progress/v1",
    head,
    base,
    worker: safeWorker,
    checks: plan.map(({ id }) => ({ id, state: "pending" })),
  };
  const write = () => writeJsonAtomic(path, { ...report, updatedAt: now() });
  write();
  return {
    path,
    start(id) {
      const entry = report.checks.find((check) => check.id === id);
      if (entry) Object.assign(entry, { state: "running", startedAt: now() });
      write();
    },
    finish(result) {
      const entry = report.checks.find((check) => check.id === result.id);
      if (entry)
        Object.assign(entry, {
          state: result.state,
          finishedAt: now(),
          exitCode: Number.isInteger(result.exitCode) ? result.exitCode : null,
          ...(result.fingerprint ? { fingerprint: result.fingerprint } : {}),
          // Failed once, passed on its automatic rerun (never the failure text: that is check output).
          ...(result.flaky ? { flaky: true } : {}),
          ...(result.reusedFrom ? { reusedFrom: result.reusedFrom, reboundTo: head } : {}),
        });
      write();
    },
  };
}
