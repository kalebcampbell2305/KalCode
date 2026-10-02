#!/usr/bin/env node
// Per-release timing record (owner directive 2026-10-02: long releases are pipeline bugs; measure every stage).
// One JSON file per release version under <root>/timings/<version>.json, appended by every release step:
//
//   node tooling/release/release-timings.mjs mark   --root <dir> --release <X.Y.Z+N> --step <name> --phase start|end [--at <iso>] [--note <text>]
//   node tooling/release/release-timings.mjs report --root <dir> --release <X.Y.Z+N>
//
// Standard step names: merge, build-windows, build-mac, sign-windows, package-mac, notarize-mac, ci-clean-install,
// update-from-live-windows, update-from-live-mac, stage, publish, website-deploy, feed-live, user-receivable.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const RELEASE = /^\d+\.\d+\.\d+(?:\+\d+)?$/;
const STEP = /^[a-z][a-z0-9-]{0,63}$/;

export function timingsPath(root, release) {
  if (!RELEASE.test(release ?? "")) throw new Error(`bad release version ${release}`);
  return join(root, "timings", `${release}.json`);
}

export function readTimings(root, release) {
  const path = timingsPath(root, release);
  if (!existsSync(path)) return { schema: "kalcode-release-timings/v1", release, events: [] };
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Appends one start/end event (atomic replace) and returns the updated record. */
export function mark(root, { release, step, phase, at = new Date().toISOString(), note }) {
  if (!STEP.test(step ?? "")) throw new Error(`bad step ${step}`);
  if (phase !== "start" && phase !== "end") throw new Error(`phase must be start or end, got ${phase}`);
  if (Number.isNaN(Date.parse(at))) throw new Error(`bad timestamp ${at}`);
  const record = readTimings(root, release);
  record.events.push({
    step,
    phase,
    at: new Date(at).toISOString(),
    ...(note ? { note: String(note).slice(0, 300) } : {}),
  });
  const path = timingsPath(root, release);
  mkdirSync(join(root, "timings"), { recursive: true });
  writeFileSync(`${path}.tmp`, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
  return record;
}

/** Pairs each step's first start with its last end; minutes are null while a step is still open. */
export function summarize(record) {
  const steps = new Map();
  for (const event of record.events) {
    const entry = steps.get(event.step) ?? { step: event.step, start: null, end: null };
    if (event.phase === "start" && !entry.start) entry.start = event.at;
    if (event.phase === "end") entry.end = event.at;
    steps.set(event.step, entry);
  }
  const rows = [...steps.values()].map((row) => ({
    ...row,
    minutes: row.start && row.end ? Math.round((Date.parse(row.end) - Date.parse(row.start)) / 6000) / 10 : null,
  }));
  const starts = rows
    .map((r) => r.start)
    .filter(Boolean)
    .map(Date.parse);
  const ends = rows
    .map((r) => r.end)
    .filter(Boolean)
    .map(Date.parse);
  const total = starts.length && ends.length ? Math.round((Math.max(...ends) - Math.min(...starts)) / 6000) / 10 : null;
  return { release: record.release, totalMinutes: total, steps: rows };
}

function option(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [command, ...args] = process.argv.slice(2);
  const root = option(args, "--root");
  const release = option(args, "--release");
  try {
    if (!root) throw new Error("--root <dir> is required");
    if (command === "mark") {
      mark(root, {
        release,
        step: option(args, "--step"),
        phase: option(args, "--phase"),
        at: option(args, "--at") ?? undefined,
        note: option(args, "--note"),
      });
    } else if (command === "report") {
      process.stdout.write(`${JSON.stringify(summarize(readTimings(root, release)), null, 2)}\n`);
    } else {
      throw new Error("usage: release-timings.mjs mark|report --root <dir> --release <version> ...");
    }
  } catch (error) {
    process.stderr.write(`release-timings: ${error.message}\n`);
    process.exit(1);
  }
}
