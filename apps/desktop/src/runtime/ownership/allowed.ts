import { useSyncExternalStore } from "react";

import type { AllowedGrant, OwnershipRisk } from "./model.ts";

/**
 * Overlaps the person allowed ("Allow both": the parallel edits are intentional). Keyed by pair,
 * holding the files involved and the risk when they allowed it, so the warning returns if the
 * overlap grows to new files or gets riskier. Survives restarts on this device; bounded; works
 * without storage.
 */
const STORAGE_KEY = "kalcode.ownership.allowed.v2";
const RISKS: ReadonlySet<string> = new Set(["live", "conflict", "same-files", "area", "compatible"]);
const MAX_PAIRS = 200;
const MAX_FILES = 500;

type Allowed = ReadonlyMap<string, AllowedGrant>;

function load(): Allowed {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return new Map();
    const entries = parsed.flatMap((entry): [string, AllowedGrant][] => {
      if (!Array.isArray(entry) || typeof entry[0] !== "string") return [];
      const grant: unknown = entry[1];
      if (typeof grant !== "object" || grant === null) return [];
      const { files, risk } = grant as { files?: unknown; risk?: unknown };
      if (!Array.isArray(files) || typeof risk !== "string" || !RISKS.has(risk)) return [];
      const names = files.filter((file: unknown): file is string => typeof file === "string");
      return [[entry[0], { files: names, risk: risk as OwnershipRisk }]];
    });
    return new Map(entries);
  } catch {
    return new Map();
  }
}

let allowed: Allowed = load();
const listeners = new Set<() => void>();

function save(next: Allowed) {
  allowed = next;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify([...next]));
  } catch {
    // Still allowed for this session.
  }
  for (const listener of listeners) listener();
}

/** Allow an overlap as it stands now (its files, at its current risk). */
export function allowOverlap(key: string, files: readonly string[], risk: OwnershipRisk): void {
  const next = new Map(allowed);
  next.delete(key);
  next.set(key, { files: [...new Set([...(allowed.get(key)?.files ?? []), ...files])].slice(-MAX_FILES), risk });
  save(new Map([...next].slice(-MAX_PAIRS)));
}

/** Warn about the pair again. */
export function disallowOverlap(key: string): void {
  if (!allowed.has(key)) return;
  const next = new Map(allowed);
  next.delete(key);
  save(next);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAllowedOverlaps(): Allowed {
  return useSyncExternalStore(subscribe, () => allowed);
}

/** Tests only. */
export function resetAllowedOverlaps(): void {
  allowed = new Map();
}
