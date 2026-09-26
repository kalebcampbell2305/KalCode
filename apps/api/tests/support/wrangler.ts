/** Runs the pinned wrangler CLI without a shell, against the api package. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const API_DIR = fileURLToPath(new URL("../../", import.meta.url).href);
export const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url).href);

export const WRANGLER_BIN = join(
  dirname(createRequire(join(API_DIR, "package.json")).resolve("wrangler/package.json")),
  "bin",
  "wrangler.js",
);

export function wrangler(args: readonly string[]): string {
  return execFileSync(process.execPath, [WRANGLER_BIN, ...args], {
    cwd: API_DIR,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
}

/** A fresh, migrated local D1 persisted in its own temp directory (never the dev state). */
export function createMigratedDatabase(): string {
  const persistTo = mkdtempSync(join(tmpdir(), "kalcode-api-test-"));
  wrangler(["d1", "migrations", "apply", "kalcode-api", "--local", "--persist-to", persistTo]);
  return persistTo;
}

/** Runs SQL against a local test database; returns the result sets. */
export function execSql(persistTo: string, sql: string): Record<string, unknown>[][] {
  const out = wrangler([
    "d1",
    "execute",
    "kalcode-api",
    "--local",
    "--persist-to",
    persistTo,
    "--json",
    "--command",
    sql,
  ]);
  const sets = JSON.parse(out.slice(out.indexOf("["))) as { results?: Record<string, unknown>[] }[];
  return sets.map((set) => set.results ?? []);
}

/**
 * Deletes a test database directory. On Windows, workerd can hold its SQLite files for a few
 * seconds after wrangler exits, so this retries and only warns if the directory stays locked.
 */
export async function removeDatabase(persistTo: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      rmSync(persistTo, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  console.warn(`Could not remove test database ${persistTo}; it is in the OS temp directory.`);
}
