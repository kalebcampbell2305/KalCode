import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { closeGracefully, EXE, launch, removeDir } from "./harness.ts";

/**
 * Wave 2 data safety and permission enforcement against the real app:
 * - a database as the released app (schema v1) left it is upgraded to v4 with a backup, and its
 *   settings and events survive;
 * - the real permission engine, over a real workspace root, allows a harmless read inside the
 *   workspace and asks before a write outside it (test hook `test_permission_probe`; no
 *   provider, no thread, no prompt, nothing is written).
 */
test.skip(process.platform !== "win32", "Real-app E2E drives WebView2 and runs on Windows.");
test.skip(!existsSync(EXE), `Build the app first: ${EXE}`);

const MIGRATIONS = resolve(import.meta.dirname, "../../../../crates/native-core/migrations");

function invoke<T>(page: Page, command: string, args: Record<string, unknown> = {}): Promise<T> {
  return page.evaluate(
    ([cmd, a]) =>
      (
        window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a: unknown) => Promise<unknown> } }
      ).__TAURI_INTERNALS__.invoke(cmd, a),
    [command, args] as const,
  ) as Promise<T>;
}

function python(script: string, ...args: string[]): string {
  return execFileSync("python", ["-c", script, ...args], { encoding: "utf8" }).trim();
}

/** Writes `kalcode.db` exactly as schema v1 (the released app) creates it, with user data. */
function createV1Database(dataDir: string) {
  const sql = readFileSync(join(MIGRATIONS, "0001_foundation.sql"), "utf8");
  const checksum = createHash("sha256").update(sql, "utf8").digest("hex");
  const sqlFile = join(dataDir, "v1.sql");
  writeFileSync(sqlFile, sql);
  python(
    `import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
c.executescript(open(sys.argv[2],encoding='utf-8').read())
c.execute("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY NOT NULL, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT")
c.execute("INSERT INTO schema_migrations VALUES (1,'foundation',?,'2026-09-01T10:00:00Z')",(sys.argv[3],))
c.execute("INSERT INTO settings VALUES ('appearance.theme','\\"light\\"','2026-09-01T10:01:00Z')")
c.execute("INSERT INTO settings VALUES ('appearance.density','\\"compact\\"','2026-09-01T10:01:00Z')")
c.execute("""INSERT INTO events (id,type,version,occurred_at,source,payload) VALUES
  ('0199a000-0000-7000-8000-000000000001','database.migrated',1,'2026-09-01T10:00:00Z','core','{"fromVersion":0,"toVersion":1,"backupCreated":false}'),
  ('0199a000-0000-7000-8000-000000000002','settings.changed',1,'2026-09-01T10:01:00Z','ui','{"keys":["appearance.theme","appearance.density"]}'),
  ('0199a000-0000-7000-8000-000000000003','app.stopped',1,'2026-09-01T10:02:00Z','core','{"uptimeMs":120000}')""")
c.commit()`,
    join(dataDir, "kalcode.db"),
    sqlFile,
    checksum,
  );
}

interface EventLite {
  id: string;
  type: string;
  payload: Record<string, unknown>;
}

test("a v1 database from the released app is upgraded to v4 with a backup and nothing lost", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "kalcode-e2e-"));
  try {
    createV1Database(dataDir);
    const app = await launch(dataDir);
    const page = app.page;
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
    // The stored settings apply.
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(page.locator("html")).toHaveAttribute("data-density", "compact");

    const diagnostics = await invoke<{ database: { schemaVersion: number; latestSchemaVersion: number } }>(
      page,
      "diagnostics_get",
    );
    expect(diagnostics.database.schemaVersion).toBe(4);
    expect(diagnostics.database.latestSchemaVersion).toBe(4);

    const events = await invoke<EventLite[]>(page, "events_recent", { limit: 100, beforeSeq: null });
    const ids = events.map((e) => e.id);
    for (const id of [
      "0199a000-0000-7000-8000-000000000001",
      "0199a000-0000-7000-8000-000000000002",
      "0199a000-0000-7000-8000-000000000003",
    ]) {
      expect(ids, "v1 events are kept").toContain(id);
    }
    const upgrade = events.find((e) => e.type === "database.migrated" && e.payload.fromVersion === 1);
    expect(upgrade?.payload).toEqual({ fromVersion: 1, toVersion: 4, backupCreated: true });

    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByText("Version 4 of 4, WAL journal")).toBeVisible();
    await closeGracefully(app);

    // The backup is the untouched v1 database, with the user's data.
    const backups = readdirSync(join(dataDir, "backups"));
    expect(backups).toHaveLength(1);
    const backup = join(dataDir, "backups", backups[0] as string);
    expect(
      python(
        `import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
print(c.execute("SELECT MAX(version) FROM schema_migrations").fetchone()[0], c.execute("SELECT value FROM settings WHERE key='appearance.theme'").fetchone()[0], c.execute("SELECT COUNT(*) FROM events").fetchone()[0])`,
        backup,
      ),
    ).toBe('1 "light" 3');
    // The upgraded database has every table of v2–v4.
    expect(
      python(
        `import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
print(",".join(r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('workspaces','terminals','threads','approvals','permission_audit') ORDER BY name")))`,
        join(dataDir, "kalcode.db"),
      ),
    ).toBe("approvals,permission_audit,terminals,threads,workspaces");
  } finally {
    removeDir(dataDir);
  }
});

interface Probe {
  probe: string;
  effect: "allow" | "ask" | "deny";
  scopes: string[];
  reason: string;
}

test("the permission engine allows a read inside the workspace and asks before a write outside it", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "kalcode-e2e-"));
  const projectRoot = mkdtempSync(join(tmpdir(), "kalcode-e2e-project-"));
  const project = join(projectRoot, "trust-project");
  mkdirSync(project);
  writeFileSync(join(project, "README.md"), "# Trust project\n");
  try {
    const app = await launch(dataDir, { KALCODE_E2E_PICK_FOLDER: project });
    const page = app.page;
    await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Code", exact: true }).click();
    await page.getByRole("button", { name: "Open folder…" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "trust-project" })).toBeVisible();

    const workspace = await invoke<{ id: string }>(page, "workspace_active");
    const results = await invoke<Probe[]>(page, "test_permission_probe", { workspaceId: workspace.id });
    const read = results.find((r) => r.probe === "read_inside");
    const write = results.find((r) => r.probe === "write_outside");
    expect(read?.effect, read?.reason).toBe("allow");
    expect(read?.scopes).toEqual(["filesystem.read"]);
    expect(write?.effect, write?.reason).toBe("ask");
    expect(write?.scopes).toContain("filesystem.outside_workspace");

    // Evaluating opened no request and wrote nothing outside the workspace.
    expect(await invoke<unknown[]>(page, "approval_list", { status: "pending" })).toEqual([]);
    expect(existsSync(join(projectRoot, "outside.txt"))).toBe(false);
    await closeGracefully(app);
  } finally {
    removeDir(dataDir);
    removeDir(projectRoot);
  }
});
