import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, type Page } from "@playwright/test";
import { ACCOUNT_KALVOICE_FIXTURE_OPT_IN, closeGracefully, EXE, launch, removeDir, test } from "./harness.ts";

/**
 * Data safety and permission enforcement against the real app:
 * - a database as the released app (schema v1) left it is upgraded to the latest schema with a
 *   backup, and its settings and events survive;
 * - a database as the installed 0.1.x app (schema v4) left it is upgraded to the latest schema
 *   (L-1 event correlation, KalVoice's ledger, git core, context, ...) with a backup of the
 *   untouched v4 file; every row survives and the new `events_query` IPC reads it;
 * - a database at schema v5 (the app after the update that ships L-1) is upgraded to the latest
 *   schema with a backup of the untouched v5 file; its v5 correlation ids and every row survive,
 *   and KalVoice's ledger works;
 * - a database at schema v6 (what the owner's installed app has) reaches the latest schema in
 *   one start with exactly one backup (the untouched v6 file); every row survives, including
 *   KalVoice's v6 rows, and the later tables exist;
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
  return execFileSync("python", ["-c", script, ...args], { encoding: "utf8", windowsHide: true }).trim();
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

/** The schema version this build migrates to (through v22 agent handoffs). */
const LATEST = 22;

test("a v1 database from the released app is upgraded to the latest schema with a backup and nothing lost", async () => {
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
    expect(diagnostics.database.schemaVersion).toBe(LATEST);
    expect(diagnostics.database.latestSchemaVersion).toBe(LATEST);

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
    expect(upgrade?.payload).toEqual({ fromVersion: 1, toVersion: LATEST, backupCreated: true });

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.getByText(`Version ${LATEST} of ${LATEST}, WAL journal`)).toBeVisible();
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
    // The upgraded database has every table of v2–v4 and v6.
    expect(
      python(
        `import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
print(",".join(r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('workspaces','terminals','threads','approvals','permission_audit','kalvoice_requests','kalvoice_preferences') ORDER BY name")))`,
        join(dataDir, "kalcode.db"),
      ),
    ).toBe("approvals,kalvoice_preferences,kalvoice_requests,permission_audit,terminals,threads,workspaces");
  } finally {
    removeDir(dataDir);
  }
});

const V4_WORKSPACE = "0199a000-0000-7000-8000-0000000000a1";
const V4_THREAD = "0199a000-0000-7000-8000-0000000000b1";
const V4_EVENTS = [
  "0199a000-0000-7000-8000-000000000011",
  "0199a000-0000-7000-8000-000000000012",
  "0199a000-0000-7000-8000-000000000013",
  "0199a000-0000-7000-8000-000000000014",
];

const V5_EVENT = "0199a000-0000-7000-8000-000000000015";
const V5_AGENT = "0199a000-0000-7000-8000-0000000000c1";
const V5_CAUSE = "0199a000-0000-7000-8000-0000000000c2";

/**
 * Writes `kalcode.db` exactly as an installed app at schema v4 (0.1.x) or v5 (the update with
 * L-1) leaves it: migrations 0001–0004 (and 0005) with their checksums, and user data in the
 * v1–v4 tables — settings, a workspace, a finished thread, a permission preference and
 * correlated events. At v5 one more event carries the v5 correlation ids.
 */
function createDatabase(dataDir: string, projectDir: string, version: 4 | 5 | 6) {
  const names = [
    "0001_foundation",
    "0002_workspaces",
    "0003_threads",
    "0004_permissions",
    "0005_event_correlation",
    "0006_kalvoice",
  ].slice(0, version);
  const files = names.map((name, index) => {
    const sql = readFileSync(join(MIGRATIONS, `${name}.sql`), "utf8");
    const file = join(dataDir, `v${index + 1}.sql`);
    writeFileSync(file, sql);
    return { file, name: name.slice(5), checksum: createHash("sha256").update(sql, "utf8").digest("hex") };
  });
  python(
    `import json,sqlite3,sys
c=sqlite3.connect(sys.argv[1])
c.execute("PRAGMA foreign_keys=ON")
c.execute("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY NOT NULL, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT")
for i,m in enumerate(json.loads(sys.argv[2])):
    c.executescript(open(m["file"],encoding="utf-8").read())
    c.execute("INSERT INTO schema_migrations VALUES (?,?,?,'2026-09-20T10:00:00Z')",(i+1,m["name"],m["checksum"]))
ws,th,proj=sys.argv[3],sys.argv[4],sys.argv[5]
c.execute("INSERT INTO settings VALUES ('appearance.theme','\\"light\\"','2026-09-20T10:01:00Z')")
c.execute("INSERT INTO workspaces (id,name,root_path,created_at,last_opened_at) VALUES (?,?,?,?,?)",(ws,"legacy-project",proj,"2026-09-20T10:02:00Z","2026-09-20T10:02:00Z"))
c.execute("""INSERT INTO threads (id,name,provider_id,provider_name,workspace_id,workspace_name,cwd,permission_mode,status,created_at,last_activity_at)
  VALUES (?,'Keep this thread','claude-code','Claude Code',?,'legacy-project',?,'approve','completed','2026-09-20T10:03:00Z','2026-09-20T10:04:00Z')""",(th,ws,proj))
c.execute("INSERT INTO permission_settings VALUES ('defaults',?,'2026-09-20T10:05:00Z')",(json.dumps({"defaultMode":"plan","defaultProfileId":None}),))
ev=json.loads(sys.argv[6])
c.execute("INSERT INTO events (id,type,version,occurred_at,source,payload) VALUES (?,'settings.changed',1,'2026-09-20T10:01:00Z','ui','{\\"keys\\":[\\"appearance.theme\\"]}')",(ev[0],))
c.execute("INSERT INTO events (id,type,version,occurred_at,source,workspace_id,payload) VALUES (?,'workspace.created',1,'2026-09-20T10:02:00Z','core',?,json(?))",(ev[1],ws,json.dumps({"workspaceId":ws,"name":"legacy-project"})))
c.execute("INSERT INTO events (id,type,version,occurred_at,source,workspace_id,thread_id,provider_id,payload) VALUES (?,'thread.completed',1,'2026-09-20T10:04:00Z','core',?,?,'claude-code',json(?))",(ev[2],ws,th,json.dumps({"threadId":th})))
c.execute("INSERT INTO events (id,type,version,occurred_at,source,payload) VALUES (?,'app.stopped',1,'2026-09-20T10:06:00Z','core','{\\"uptimeMs\\":300000}')",(ev[3],))
if len(sys.argv) > 7:
    c.execute("INSERT INTO events (id,type,version,occurred_at,source,agent_id,causation_id,payload) VALUES (?,'settings.changed',1,'2026-09-21T09:00:00Z','ui',?,?,'{\\"keys\\":[\\"appearance.theme\\"]}')",(sys.argv[7],sys.argv[8],sys.argv[9]))
if len(sys.argv) > 10:
    c.execute("INSERT INTO kalvoice_preferences (key,value,updated_at) VALUES ('voice.speakReplies','true','2026-09-22T09:00:00Z')")
c.commit()`,
    join(dataDir, "kalcode.db"),
    JSON.stringify(files),
    V4_WORKSPACE,
    V4_THREAD,
    projectDir,
    JSON.stringify(V4_EVENTS),
    ...(version >= 5 ? [V5_EVENT, V5_AGENT, V5_CAUSE] : []),
    ...(version >= 6 ? ["kalvoice"] : []),
  );
}

interface EventPageLite {
  events: EventLite[];
  nextCursor: number | null;
}

test("a v4 database from the installed app is upgraded to the latest schema with a backup; every row survives and events_query reads it", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "kalcode-e2e-"));
  const projectDir = mkdtempSync(join(tmpdir(), "kalcode-e2e-legacy-"));
  try {
    createDatabase(dataDir, projectDir, 4);
    const app = await launch(dataDir);
    const page = app.page;
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

    const diagnostics = await invoke<{ database: { schemaVersion: number; latestSchemaVersion: number } }>(
      page,
      "diagnostics_get",
    );
    expect(diagnostics.database.schemaVersion).toBe(LATEST);
    expect(diagnostics.database.latestSchemaVersion).toBe(LATEST);

    // Every v4 event is kept; the upgrade is recorded with its backup.
    const recent = await invoke<EventLite[]>(page, "events_recent", { limit: 100, beforeSeq: null });
    for (const id of V4_EVENTS)
      expect(
        recent.map((e) => e.id),
        "v4 events are kept",
      ).toContain(id);
    const upgrade = recent.find((e) => e.type === "database.migrated" && e.payload.fromVersion === 4);
    expect(upgrade?.payload).toEqual({ fromVersion: 4, toVersion: LATEST, backupCreated: true });

    // The new query IPC reads the upgraded log: by thread correlation (a v4 row), by prefix, paged.
    const emptyCorrelation = {
      workspaceId: null,
      threadId: null,
      missionId: null,
      providerId: null,
      requestId: null,
      agentId: null,
      taskId: null,
      automationId: null,
      causationId: null,
    };
    const query = (q: Record<string, unknown>) =>
      invoke<EventPageLite>(page, "events_query", {
        query: {
          types: [],
          correlation: emptyCorrelation,
          afterSeq: null,
          beforeSeq: null,
          from: null,
          to: null,
          order: "desc",
          limit: 100,
          ...q,
        },
      });
    const byThread = await query({ correlation: { ...emptyCorrelation, threadId: V4_THREAD } });
    expect(byThread.events.map((e) => e.id)).toEqual([V4_EVENTS[2]]);
    expect((byThread.events[0] as unknown as { correlation: Record<string, unknown> }).correlation).toMatchObject({
      threadId: V4_THREAD,
      workspaceId: V4_WORKSPACE,
      agentId: null,
      causationId: null,
    });
    const workspaceEvents = await query({ types: ["workspace.*"], order: "asc" });
    expect(workspaceEvents.events.map((e) => e.id)).toContain(V4_EVENTS[1]);
    const firstTwo = await query({ order: "asc", limit: 2 });
    expect(firstTwo.events.map((e) => e.id)).toEqual([V4_EVENTS[0], V4_EVENTS[1]]);
    expect(firstTwo.nextCursor).not.toBeNull();
    // A malformed filter is refused natively with a validation error.
    const refused = await page.evaluate(
      (q) =>
        (
          window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a: unknown) => Promise<unknown> } }
        ).__TAURI_INTERNALS__
          .invoke("events_query", { query: q })
          .then(
            () => "accepted",
            (error: { code?: string }) => error?.code ?? "unknown",
          ),
      {
        types: ["thread.%"],
        correlation: emptyCorrelation,
        afterSeq: null,
        beforeSeq: null,
        from: null,
        to: null,
        order: "desc",
        limit: 10,
      },
    );
    expect(refused).toBe("invalid_event_query");

    // The v3 thread row reads back through the CA-1 ThreadSummary shape.
    const thread = await invoke<Record<string, unknown>>(page, "thread_get", { threadId: V4_THREAD });
    expect(thread).toMatchObject({
      id: V4_THREAD,
      name: "Keep this thread",
      archivedAt: null,
      resumable: false,
      permissionProfileId: null,
      runtimeKind: null,
      terminalId: null,
    });
    // The v4 permission preference survives.
    expect(await invoke<{ defaultMode: string }>(page, "permission_settings_get")).toMatchObject({
      defaultMode: "plan",
    });

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.getByText(`Version ${LATEST} of ${LATEST}, WAL journal`)).toBeVisible();
    await closeGracefully(app);

    // The backup is the untouched v4 database; the live one has the v5 columns and indexes.
    const backups = readdirSync(join(dataDir, "backups"));
    expect(backups).toHaveLength(1);
    const backup = join(dataDir, "backups", backups[0] as string);
    expect(
      python(
        `import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
cols=[r[1] for r in c.execute("PRAGMA table_info(events)")]
print(c.execute("SELECT MAX(version) FROM schema_migrations").fetchone()[0], c.execute("SELECT COUNT(*) FROM events").fetchone()[0], "causation_id" in cols)`,
        backup,
      ),
    ).toBe("4 4 False");
    expect(
      python(
        `import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
cols=",".join(r[1] for r in c.execute("PRAGMA table_info(events)") if r[1] in ("agent_id","task_id","automation_id","causation_id"))
idx=",".join(r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='index' AND name IN ('events_agent_id_idx','events_task_id_idx','events_automation_id_idx','events_causation_id_idx','events_request_id_idx') ORDER BY name"))
kept=c.execute("SELECT COUNT(*) FROM threads WHERE id=?",(sys.argv[2],)).fetchone()[0]
print(cols, idx, kept)`,
        join(dataDir, "kalcode.db"),
        V4_THREAD,
      ),
    ).toBe(
      "agent_id,task_id,automation_id,causation_id events_agent_id_idx,events_automation_id_idx,events_causation_id_idx,events_request_id_idx,events_task_id_idx 1",
    );
  } finally {
    removeDir(dataDir);
    removeDir(projectDir);
  }
});

test("a v5 database (the app after the L-1 update) is upgraded to the latest schema with a backup; its rows and correlation ids survive and KalVoice's ledger works", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "kalcode-e2e-"));
  const projectDir = mkdtempSync(join(tmpdir(), "kalcode-e2e-legacy-"));
  try {
    createDatabase(dataDir, projectDir, 5);
    const app = await launch(dataDir, { KALCODE_E2E_ACCOUNT_FIXTURE: ACCOUNT_KALVOICE_FIXTURE_OPT_IN });
    const page = app.page;
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

    const diagnostics = await invoke<{ database: { schemaVersion: number; latestSchemaVersion: number } }>(
      page,
      "diagnostics_get",
    );
    expect(diagnostics.database.schemaVersion).toBe(LATEST);
    expect(diagnostics.database.latestSchemaVersion).toBe(LATEST);

    const recent = await invoke<(EventLite & { correlation: Record<string, unknown> })[]>(page, "events_recent", {
      limit: 100,
      beforeSeq: null,
    });
    for (const id of [...V4_EVENTS, V5_EVENT])
      expect(
        recent.map((e) => e.id),
        "v5 events are kept",
      ).toContain(id);
    // The v5 correlation ids read back unchanged.
    expect(recent.find((e) => e.id === V5_EVENT)?.correlation).toMatchObject({
      agentId: V5_AGENT,
      causationId: V5_CAUSE,
    });
    const upgrade = recent.find((e) => e.type === "database.migrated" && e.payload.fromVersion === 5);
    expect(upgrade?.payload).toEqual({ fromVersion: 5, toVersion: LATEST, backupCreated: true });
    // No earlier step ran again.
    expect(recent.filter((e) => e.type === "database.migrated")).toHaveLength(1);

    // The v3/v4 rows survive.
    expect(await invoke<Record<string, unknown>>(page, "thread_get", { threadId: V4_THREAD })).toMatchObject({
      id: V4_THREAD,
      name: "Keep this thread",
    });
    expect(await invoke<{ defaultMode: string }>(page, "permission_settings_get")).toMatchObject({
      defaultMode: "plan",
    });

    // KalVoice's v6 ledger and preferences work on the upgraded database. The signed Pro fixture
    // provides under-limit account authority; its existing 41 requests are separate from this
    // freshly migrated local request ledger.
    const status = await invoke<{ usage: { used: number; allowance: number | null } }>(page, "kalvoice_status");
    expect(status.usage).toMatchObject({ used: 41, allowance: 150 });
    const typed = await invoke<{ counted: boolean; outcome: { kind: string } }>(page, "kalvoice_request", {
      request: { requestId: crypto.randomUUID(), text: "Go to settings", input: "text", workspaceId: null },
    });
    expect(typed).toMatchObject({ counted: true, outcome: { kind: "completed" } });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.getByText(`Version ${LATEST} of ${LATEST}, WAL journal`)).toBeVisible();
    await closeGracefully(app);

    // The backup is the untouched v5 database (v5 columns, no KalVoice tables); the live one
    // has KalVoice's tables and the counted request.
    const backups = readdirSync(join(dataDir, "backups"));
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/^kalcode-pre-v6-/);
    const backup = join(dataDir, "backups", backups[0] as string);
    expect(
      python(
        `import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
cols=[r[1] for r in c.execute("PRAGMA table_info(events)")]
kv=c.execute("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name LIKE 'kalvoice_%'").fetchone()[0]
print(c.execute("SELECT MAX(version) FROM schema_migrations").fetchone()[0], c.execute("SELECT COUNT(*) FROM events").fetchone()[0], "causation_id" in cols, kv)`,
        backup,
      ),
    ).toBe("5 5 True 0");
    expect(
      python(
        `import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
m=c.execute("SELECT version, name FROM schema_migrations WHERE version=6").fetchone()
n=c.execute("SELECT COUNT(*) FROM kalvoice_requests").fetchone()[0]
e=c.execute("SELECT agent_id, causation_id FROM events WHERE id=?",(sys.argv[2],)).fetchone()
print(m[0], m[1], n, e[0], e[1])`,
        join(dataDir, "kalcode.db"),
        V5_EVENT,
      ),
    ).toBe(`6 kalvoice 1 ${V5_AGENT} ${V5_CAUSE}`);
  } finally {
    removeDir(dataDir);
    removeDir(projectDir);
  }
});

/** Tables the migrations after v6 add (v7 git core, v8 context, v9 workspace layouts), sorted by name. */
const POST_V6_TABLES = [
  "checkpoints",
  "context_firewall_log",
  "context_items",
  "context_never_share",
  "context_packages",
  "git_worktrees",
  "layout_presets",
  "workspace_layouts",
];

test("a v6 database (the owner's installed app) reaches the latest schema in one start with one backup; every row survives", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "kalcode-e2e-"));
  const projectDir = mkdtempSync(join(tmpdir(), "kalcode-e2e-legacy-"));
  try {
    createDatabase(dataDir, projectDir, 6);
    const app = await launch(dataDir);
    const page = app.page;
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

    const diagnostics = await invoke<{ database: { schemaVersion: number; latestSchemaVersion: number } }>(
      page,
      "diagnostics_get",
    );
    expect(diagnostics.database.schemaVersion).toBe(LATEST);
    expect(diagnostics.database.latestSchemaVersion).toBe(LATEST);

    const recent = await invoke<(EventLite & { correlation: Record<string, unknown> })[]>(page, "events_recent", {
      limit: 100,
      beforeSeq: null,
    });
    for (const id of [...V4_EVENTS, V5_EVENT])
      expect(
        recent.map((e) => e.id),
        "v6 events are kept",
      ).toContain(id);
    expect(recent.find((e) => e.id === V5_EVENT)?.correlation).toMatchObject({
      agentId: V5_AGENT,
      causationId: V5_CAUSE,
    });
    // One upgrade, straight from v6 to the latest schema.
    const upgrades = recent.filter((e) => e.type === "database.migrated");
    expect(upgrades.map((e) => e.payload)).toEqual([{ fromVersion: 6, toVersion: LATEST, backupCreated: true }]);

    expect(await invoke<Record<string, unknown>>(page, "thread_get", { threadId: V4_THREAD })).toMatchObject({
      id: V4_THREAD,
      name: "Keep this thread",
    });
    expect(await invoke<{ defaultMode: string }>(page, "permission_settings_get")).toMatchObject({
      defaultMode: "plan",
    });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.getByText(`Version ${LATEST} of ${LATEST}, WAL journal`)).toBeVisible();
    await closeGracefully(app);

    // Exactly one backup: the untouched v6 database (KalVoice rows, none of the later tables).
    const backups = readdirSync(join(dataDir, "backups"));
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/^kalcode-pre-v7-/);
    const script = `import json,sqlite3,sys
c=sqlite3.connect(sys.argv[1])
names=json.loads(sys.argv[2])
found=[r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name") if r[0] in names]
print(c.execute("SELECT MAX(version) FROM schema_migrations").fetchone()[0], c.execute("SELECT value FROM kalvoice_preferences WHERE key='voice.speakReplies'").fetchone()[0], c.execute("SELECT COUNT(*) FROM threads WHERE id=?",(sys.argv[3],)).fetchone()[0], ",".join(found) or "-")`;
    const tables = JSON.stringify(POST_V6_TABLES);
    expect(python(script, join(dataDir, "backups", backups[0] as string), tables, V4_THREAD)).toBe("6 true 1 -");
    // The live database kept every row and gained the later tables.
    expect(python(script, join(dataDir, "kalcode.db"), tables, V4_THREAD)).toBe(
      `${LATEST} true 1 ${POST_V6_TABLES.join(",")}`,
    );
  } finally {
    removeDir(dataDir);
    removeDir(projectDir);
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
