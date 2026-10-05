/**
 * Dashboard fixtures for the in-memory transport (unit tests and the `ui-test` build ONLY — see
 * memoryTransport.ts; never bundled into development or production builds).
 *
 * Implements the contract commands the Dashboard consumes — `thread_list`, `thread_interrupt`,
 * `thread_resume`, `thread_stop`, `thread_archive` (Z3), `approval_list`, `approval_decide` (Z4)
 * and `terminals_running` (Z1) — with the same validation and event semantics the native
 * implementations are specified to have (docs/CONTRACTS.md), so UI tests exercise real flows.
 * Every fixture is typed with the generated contract types.
 *
 * Scenarios (`?scenario=`):
 *   busy             threads across every state and provider, approvals, terminals, history
 *   empty            the commands exist but nothing has run yet
 *   archived         every thread was archived: nothing is open, three are restorable
 *   approvals-flood  many approval requests across several threads
 *   errors           every Dashboard read fails until `recover()` (test hook) is called
 *   loading          every Dashboard read stays pending (skeleton review)
 *   dash-1 | dash-6 | dash-20 | dash-50
 *                    scale: exactly that many agents across providers, projects and states (Z7-W3)
 *   fleet            the Agent Fleet as the owner runs it: 27 live agents on named accounts
 *                    ("Claude A") with model and effort, plus 120 old failed runs to clean up
 */
import type {
  ActionKind,
  ApprovalDecision,
  ApprovalView,
  Correlation,
  EventEnvelope,
  EventPayload,
  EventSource,
  IpcError,
  PermissionMode,
  PermissionScope,
  TerminalInfo,
  ThreadStatus,
  ThreadSummary,
} from "@kalcode/protocol";
import { isRemoteConsequential } from "@kalcode/protocol";
import type { CommandName } from "../transport.ts";

export type DashboardScenario =
  | "busy"
  | "empty"
  | "archived"
  | "approvals-flood"
  | "errors"
  | "loading"
  | "dash-1"
  | "dash-6"
  | "dash-20"
  | "dash-50"
  | "fleet";

export const DASHBOARD_SCENARIOS: readonly DashboardScenario[] = [
  "busy",
  "empty",
  "archived",
  "approvals-flood",
  "errors",
  "loading",
  "dash-1",
  "dash-6",
  "dash-20",
  "dash-50",
  "fleet",
];

export function isDashboardScenario(value: string | null): value is DashboardScenario {
  return value !== null && (DASHBOARD_SCENARIOS as readonly string[]).includes(value);
}

export interface EmitOptions {
  correlation?: Partial<Correlation>;
  occurredAt?: string;
  source?: EventSource;
}

export type Emit = (event: EventPayload, options?: EmitOptions) => EventEnvelope;

export type DashboardHandlers = Partial<Record<CommandName, (args: Record<string, unknown>) => unknown>>;

/** Test hooks, exposed on `window.__kalcodeMemory.dashboard` in ui-test builds. */
export interface DashboardControls {
  /** A working thread asks for approval (simulates `approval.requested` arriving live). */
  requestApproval(): string | null;
  /** Moves a thread to `status` and records `thread.status_changed`. */
  setThreadStatus(threadId: string, status: ThreadStatus, activity?: string | null): void;
  /** Ends the `errors` scenario: later reads succeed. */
  recover(): void;
}

export interface DashboardFixtures {
  handlers: DashboardHandlers;
  controls: DashboardControls;
  /** How long ago the simulated session started (startup events are backdated by this). */
  sessionAgeMs: number;
  /** Records the scenario's history. Call after the startup events. */
  seedHistory(): void;
}

const MIN = 60_000;

/** Deterministic, canonical UUIDv7-shaped ids (lowercase, hyphenated) so `isValidId` accepts them. */
export function fixtureId(kind: number, n: number): string {
  const hex = (value: number, width: number) => value.toString(16).padStart(width, "0").slice(-width);
  return `01999a4e-${hex(kind, 4)}-7${hex(n, 3)}-8a2e-${hex(kind * 4096 + n, 12)}`;
}

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Mirrors `is_valid_id` (crates/contracts/src/ids.rs): canonical lowercase hyphenated UUID. */
export function isValidId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

function fail(error: IpcError): never {
  throw error;
}

const invalidId = (): never =>
  fail({ category: "validation", code: "invalid_id", message: "That id isn't valid.", retryable: false });

const DECISIONS: readonly ApprovalDecision[] = [
  "deny",
  "approve_once",
  "approve_for_thread",
  "approve_for_workspace",
  "allow_via_rule",
];

const WORKSPACES = {
  kalcode: { id: fixtureId(1, 1), name: "kalcode" },
  atlas: { id: fixtureId(1, 2), name: "atlas-api" },
  notes: { id: fixtureId(1, 3), name: "field-notes" },
  web: { id: fixtureId(1, 4), name: "storefront-web" },
  infra: { id: fixtureId(1, 5), name: "infra-terraform" },
} as const;

type Workspace = (typeof WORKSPACES)[keyof typeof WORKSPACES];

const PROVIDERS = {
  claude: { providerId: "claude-code", providerName: "Claude Code" },
  codex: { providerId: "codex", providerName: "Codex" },
  gemini: { providerId: "gemini-cli", providerName: "Gemini CLI" },
} as const;

interface ThreadSeed {
  n: number;
  name: string;
  provider: keyof typeof PROVIDERS;
  model: string | null;
  account: string | null;
  workspace: Workspace;
  mode: PermissionMode;
  status: ThreadStatus;
  activity: string | null;
  startedMinAgo: number;
  lastMinAgo: number;
  files: number | null;
  branch: string | null;
  /** Agent Fleet: the thread runs in its own worktree with these Git facts. */
  /** `paths`: the files the agent touched (repository-relative), for overlapping-edit detection. */
  worktree?: { ahead: number; changed: number; conflicts: boolean; paths?: string[] };
  unread?: number;
  error?: { code: string; message: string };
}

const BUSY_THREADS: readonly ThreadSeed[] = [
  {
    n: 1,
    name: "Refactor auth middleware",
    provider: "claude",
    model: "claude-sonnet-4-5",
    account: "Personal",
    workspace: WORKSPACES.kalcode,
    mode: "approve",
    status: "waiting_for_permission",
    activity: "Waiting to install zod",
    startedMinAgo: 42,
    lastMinAgo: 1,
    files: 7,
    branch: "feat/auth-middleware",
    worktree: { ahead: 2, changed: 3, conflicts: false },
  },
  {
    n: 2,
    name: "Fix flaky checkout test",
    provider: "codex",
    model: "gpt-5-codex",
    account: "Work",
    workspace: WORKSPACES.atlas,
    mode: "auto",
    status: "running_command",
    activity: "Running pnpm test checkout --repeat 20",
    startedMinAgo: 18,
    lastMinAgo: 0,
    files: 2,
    branch: "fix/checkout-flake",
    worktree: {
      ahead: 1,
      changed: 2,
      conflicts: false,
      paths: ["apps/web/checkout/cart.test.ts", "apps/web/checkout/cart.ts"],
    },
  },
  {
    n: 3,
    name: "Write invoices migration",
    provider: "gemini",
    model: "gemini-2.5-pro",
    account: "Personal",
    workspace: WORKSPACES.atlas,
    mode: "approve",
    status: "editing",
    activity: "Editing db/migrations/0007_invoices.sql",
    startedMinAgo: 26,
    lastMinAgo: 0,
    files: 3,
    branch: "feat/invoices",
    worktree: {
      ahead: 0,
      changed: 4,
      conflicts: false,
      paths: ["apps/web/checkout/cart.ts", "db/migrations/0007_invoices.sql", "db/schema.ts", "src/invoices.ts"],
    },
  },
  {
    n: 4,
    name: "Review billing pull request",
    provider: "claude",
    model: "claude-opus-4-1",
    account: "Work",
    workspace: WORKSPACES.atlas,
    mode: "plan",
    status: "thinking",
    activity: "Reading src/billing/proration.ts",
    startedMinAgo: 9,
    lastMinAgo: 0,
    files: 0,
    branch: "review/214-proration",
  },
  {
    n: 5,
    name: "Update onboarding copy",
    provider: "codex",
    model: "gpt-5-codex",
    account: "Personal",
    workspace: WORKSPACES.notes,
    mode: "approve",
    status: "waiting_for_user",
    activity: "Asked which tone to use for the welcome email",
    startedMinAgo: 55,
    lastMinAgo: 6,
    files: 4,
    branch: "copy/onboarding",
    unread: 1,
  },
  {
    n: 6,
    name: "Bump dependencies",
    provider: "claude",
    model: "claude-sonnet-4-5",
    account: "Personal",
    workspace: WORKSPACES.kalcode,
    mode: "auto",
    status: "waiting_for_permission",
    activity: "Waiting to push chore/deps to origin",
    startedMinAgo: 31,
    lastMinAgo: 3,
    files: 2,
    branch: "chore/deps",
  },
  {
    n: 7,
    name: "Index docs for search",
    provider: "gemini",
    model: "gemini-2.5-flash",
    account: "Personal",
    workspace: WORKSPACES.notes,
    mode: "auto",
    status: "waiting_for_dependency",
    activity: "Waiting for the docs build to finish",
    startedMinAgo: 14,
    lastMinAgo: 4,
    files: null,
    branch: "main",
  },
  {
    n: 8,
    name: "Profile cold start",
    provider: "codex",
    model: "gpt-5-codex",
    account: "Work",
    workspace: WORKSPACES.kalcode,
    mode: "approve",
    status: "paused",
    activity: "Paused after collecting the first trace",
    startedMinAgo: 95,
    lastMinAgo: 38,
    files: 1,
    branch: "perf/cold-start",
  },
  {
    n: 9,
    name: "Draft release notes",
    provider: "gemini",
    model: "gemini-2.5-pro",
    account: "Personal",
    workspace: WORKSPACES.notes,
    mode: "plan",
    status: "idle",
    activity: null,
    startedMinAgo: 130,
    lastMinAgo: 64,
    files: 1,
    branch: "main",
  },
  {
    n: 10,
    name: "Add light theme tokens",
    provider: "claude",
    model: "claude-sonnet-4-5",
    account: "Personal",
    workspace: WORKSPACES.kalcode,
    mode: "approve",
    status: "completed",
    activity: "Finished: 12 files changed, tests pass",
    startedMinAgo: 71,
    lastMinAgo: 24,
    files: 12,
    branch: "feat/light-tokens",
    worktree: { ahead: 3, changed: 0, conflicts: false },
  },
  {
    n: 11,
    name: "Deploy preview build",
    provider: "gemini",
    model: "gemini-2.5-pro",
    account: "Work",
    workspace: WORKSPACES.atlas,
    mode: "approve",
    status: "failed",
    activity: null,
    startedMinAgo: 40,
    lastMinAgo: 11,
    files: 0,
    branch: "release/preview",
    worktree: { ahead: 0, changed: 5, conflicts: false },
    error: {
      code: "provider_exited",
      message:
        "Gemini CLI exited unexpectedly (exit code 1) while building. Your files are unchanged since the last completed step. Retry to run the build again.",
    },
  },
  {
    n: 12,
    name: "Migrate logger to structured output",
    provider: "codex",
    model: "gpt-5-codex",
    account: "Work",
    workspace: WORKSPACES.kalcode,
    mode: "auto",
    status: "interrupted",
    activity: "Stopped by you",
    startedMinAgo: 180,
    lastMinAgo: 120,
    files: 5,
    branch: "refactor/logger",
  },
  {
    n: 13,
    name: "Generate API client",
    provider: "claude",
    model: "claude-sonnet-4-5",
    account: "Work",
    workspace: WORKSPACES.atlas,
    mode: "auto",
    status: "completed",
    activity: "Finished: client regenerated from openapi.yaml",
    startedMinAgo: 240,
    lastMinAgo: 196,
    files: 9,
    branch: "chore/api-client",
    worktree: { ahead: 1, changed: 0, conflicts: true },
  },
];

/** Extra agents for the scale scenarios (Z7-W3): realistic names, every provider and project. */
const SCALE_TASKS = [
  "Split checkout service",
  "Tighten CSP headers",
  "Port settings page to tokens",
  "Add retry to webhook sender",
  "Audit npm dependencies",
  "Cache avatar thumbnails",
  "Fix timezone drift in reports",
  "Document the release process",
  "Add e2e test for sign-up",
  "Reduce bundle size",
  "Migrate cron jobs to queues",
  "Rename billing tables",
  "Harden file upload limits",
  "Add dark mode screenshots",
  "Speed up CI cache",
  "Clean up feature flags",
  "Add pagination to orders API",
  "Write runbook for outages",
  "Refactor search indexer",
  "Localize onboarding emails",
  "Profile memory in worker",
  "Add rate limits to login",
  "Upgrade TypeScript",
  "Fix flaky upload test",
  "Generate OpenAPI docs",
  "Add health checks to Terraform",
  "Tidy lint warnings",
  "Split monolith routes",
  "Add metrics dashboard",
  "Review accessibility of forms",
  "Improve error pages",
  "Backfill invoice totals",
  "Rotate staging secrets",
  "Add CSV export",
  "Trim log noise",
  "Draft architecture notes",
  "Add offline banner",
] as const;

const SCALE_STATES: readonly { status: ThreadStatus; activity: string | null }[] = [
  { status: "running_command", activity: "Running pnpm test --filter api" },
  { status: "idle", activity: null },
  { status: "editing", activity: "Editing src/routes/orders.ts" },
  { status: "completed", activity: "Finished: 4 files changed, tests pass" },
  { status: "thinking", activity: "Reading src/search/indexer.ts" },
  { status: "idle", activity: null },
  { status: "running_tool", activity: "Searching the codebase for feature flags" },
  { status: "waiting_for_user", activity: "Asked which retry limit to use" },
  { status: "testing", activity: "Running the e2e suite" },
  { status: "paused", activity: "Paused by you" },
  { status: "reviewing", activity: "Reviewing the diff before finishing" },
  { status: "interrupted", activity: "Stopped by you" },
];

const SCALE_WORKSPACES = [WORKSPACES.kalcode, WORKSPACES.atlas, WORKSPACES.notes, WORKSPACES.web, WORKSPACES.infra];
const SCALE_PROVIDERS = ["claude", "codex", "gemini"] as const;
const SCALE_MODELS = { claude: "claude-sonnet-4-5", codex: "gpt-5-codex", gemini: "gemini-2.5-pro" } as const;
const SCALE_MODES: readonly PermissionMode[] = ["approve", "auto", "plan"];

/** A scale scenario's agents: the busy set first (it covers every state), then generated ones. */
function scaleSeeds(count: number): ThreadSeed[] {
  if (count === 1) return BUSY_THREADS.filter((s) => s.n === 2);
  const seeds: ThreadSeed[] = BUSY_THREADS.slice(0, Math.min(count, BUSY_THREADS.length));
  for (let i = 0; seeds.length < count; i += 1) {
    const provider = SCALE_PROVIDERS[i % SCALE_PROVIDERS.length] ?? "claude";
    const state = SCALE_STATES[i % SCALE_STATES.length] ?? { status: "idle", activity: null };
    const workspace = SCALE_WORKSPACES[(i * 2) % SCALE_WORKSPACES.length] ?? WORKSPACES.kalcode;
    const task = SCALE_TASKS[i % SCALE_TASKS.length] ?? `Task ${i + 1}`;
    seeds.push({
      n: 100 + i,
      name: task,
      provider,
      model: SCALE_MODELS[provider],
      account: i % 2 === 0 ? "Personal" : "Work",
      workspace,
      mode: SCALE_MODES[i % SCALE_MODES.length] ?? "approve",
      status: state.status,
      activity: state.activity,
      startedMinAgo: 20 + ((i * 17) % 200),
      lastMinAgo: (i * 7) % 90,
      files: state.status === "completed" ? 3 + (i % 9) : i % 4 === 0 ? null : i % 6,
      branch: `task/${task.toLowerCase().replaceAll(" ", "-").slice(0, 28)}`,
    });
  }
  return seeds;
}

/** The `archived` scenario: finished threads the person archived (fixture numbers). */
const ARCHIVED_THREADS: readonly number[] = [10, 11, 13];

const SCALE_COUNTS: Partial<Record<DashboardScenario, number>> = {
  "dash-1": 1,
  "dash-6": 6,
  "dash-20": 20,
  "dash-50": 50,
  fleet: 27,
};

/** The `fleet` scenario's account names: what the owner calls their provider accounts. */
const FLEET_ACCOUNTS: Record<keyof typeof PROVIDERS, readonly string[]> = {
  claude: ["Claude A", "Claude B"],
  codex: ["Codex A", "Codex B"],
  gemini: ["Gemini A"],
};
const FLEET_EFFORT: Record<keyof typeof PROVIDERS, string | null> = { claude: "high", codex: "medium", gemini: null };
const FLEET_FAILURES = [
  "Claude Code exited unexpectedly (exit code 1). Your files are unchanged since the last completed step.",
  "The provider session expired. Sign in to the account again, then retry.",
  "Tests failed: 3 failing in checkout.spec.ts.",
  "Rate limit reached for this account. Retry when it resets or switch accounts.",
  "Codex exited (exit code 137): the process ran out of memory.",
] as const;

/** The `fleet` scenario's history: old failed runs that pile up until someone clears them. */
function fleetFailedSeeds(count: number): ThreadSeed[] {
  return Array.from({ length: count }, (_, i) => {
    const provider = SCALE_PROVIDERS[i % SCALE_PROVIDERS.length] ?? "claude";
    const task = SCALE_TASKS[(i * 5) % SCALE_TASKS.length] ?? `Task ${i + 1}`;
    return {
      n: 400 + i,
      name: `${task} (run ${Math.floor(i / SCALE_TASKS.length) + 2})`,
      provider,
      model: SCALE_MODELS[provider],
      account: null,
      workspace: SCALE_WORKSPACES[i % SCALE_WORKSPACES.length] ?? WORKSPACES.kalcode,
      mode: "auto",
      status: "failed",
      activity: null,
      startedMinAgo: 600 + i * 37,
      lastMinAgo: 560 + i * 37,
      files: i % 3,
      branch: `task/${task.toLowerCase().replaceAll(" ", "-").slice(0, 28)}`,
      error: { code: "provider_exited", message: FLEET_FAILURES[i % FLEET_FAILURES.length] ?? "The run failed." },
    };
  });
}

interface ApprovalSeed {
  n: number;
  /** Thread fixture number (see BUSY_THREADS). */
  thread: number;
  action: ActionKind;
  summary: string;
  scopes: PermissionScope[];
  reason: string;
  minAgo: number;
}

const BUSY_APPROVALS: readonly ApprovalSeed[] = [
  {
    n: 1,
    thread: 6,
    action: { kind: "git", operation: "push", remote: "origin chore/deps" },
    summary: "Push chore/deps to origin",
    scopes: ["git.push"],
    reason: "Pushing leaves this machine, so it always asks, whatever the mode.",
    minAgo: 3,
  },
  {
    n: 2,
    thread: 1,
    action: { kind: "package_install", manager: "pnpm add", packages: ["zod@4.1.0"] },
    summary: "Install zod",
    scopes: ["package.install", "network.other"],
    reason: "Approve mode asks before installing packages.",
    minAgo: 1,
  },
];

const FLOOD_EXTRA: readonly ApprovalSeed[] = [
  {
    n: 3,
    thread: 3,
    action: { kind: "file_write", path: "db/migrations/0007_invoices.sql" },
    summary: "Write db/migrations/0007_invoices.sql",
    scopes: ["filesystem.write"],
    reason: "Approve mode asks before changing files.",
    minAgo: 2,
  },
  {
    n: 4,
    thread: 3,
    action: {
      kind: "command",
      command: "pnpm db:migrate --dry-run",
      argv: ["pnpm", "db:migrate", "--dry-run"],
      cwd: "~/code/atlas-api",
    },
    summary: "Run pnpm db:migrate --dry-run",
    scopes: ["terminal.execute"],
    reason: "Approve mode asks before running commands.",
    minAgo: 2,
  },
  {
    n: 5,
    thread: 2,
    action: { kind: "network", host: "registry.npmjs.org", url: "https://registry.npmjs.org/playwright" },
    summary: "Reach registry.npmjs.org",
    scopes: ["network.other"],
    reason: "Auto mode asks before reaching hosts outside the documentation list.",
    minAgo: 1,
  },
  {
    n: 6,
    thread: 1,
    action: { kind: "file_delete", path: "src/auth/legacy-session.ts" },
    summary: "Delete src/auth/legacy-session.ts",
    scopes: ["filesystem.write", "destructive"],
    reason: "Deleting files always asks.",
    minAgo: 1,
  },
  {
    n: 7,
    thread: 4,
    action: { kind: "browser", action: "navigate", url: "https://github.com/atlas/api/pull/214" },
    summary: "Open pull request 214 in the browser",
    scopes: ["browser.navigate"],
    reason: "Plan mode asks before using the browser.",
    minAgo: 0,
  },
  {
    n: 8,
    thread: 6,
    action: { kind: "deploy", target: "Production (atlas-api)" },
    summary: "Deploy atlas-api to production",
    scopes: ["deploy.production"],
    reason: "Production deploys leave this machine, so they always ask.",
    minAgo: 0,
  },
  {
    n: 9,
    thread: 2,
    action: {
      kind: "tool",
      tool: "mcp.linear.create_issue",
      inputSummary: "Create issue: Checkout test flakes under load",
    },
    summary: "Create a Linear issue",
    scopes: ["messaging.send"],
    reason: "Tools KalCode can't classify precisely are checked conservatively.",
    minAgo: 0,
  },
];

const BUSY_TERMINALS = [
  { n: 1, workspace: WORKSPACES.kalcode, shellId: "pwsh", title: "PowerShell 7", minAgo: 47 },
  { n: 2, workspace: WORKSPACES.atlas, shellId: "git-bash", title: "Git Bash", minAgo: 19 },
  { n: 3, workspace: WORKSPACES.atlas, shellId: "pwsh", title: "PowerShell 7", minAgo: 6 },
] as const;

/** Activity text a thread shows once an approval for `action` is granted. */
function activityAfterApproval(action: ActionKind): { status: ThreadStatus; activity: string } {
  switch (action.kind) {
    case "command":
      return { status: "running_command", activity: `Running ${action.command}` };
    case "package_install":
      return { status: "running_command", activity: `Installing ${action.packages.join(", ")}` };
    case "file_write":
    case "file_delete":
      return { status: "editing", activity: `Editing ${action.path}` };
    case "git":
      return { status: "running_tool", activity: `Running git ${action.operation}` };
    default:
      return { status: "running_tool", activity: "Continuing with the approved action" };
  }
}

export function createDashboardFixtures(scenario: DashboardScenario, emit: Emit, now = Date.now()): DashboardFixtures {
  const ago = (minutes: number) => new Date(now - minutes * MIN).toISOString();
  const withThreads = scenario !== "empty";

  const threads = new Map<string, ThreadSummary & { archived: boolean }>();
  const approvals = new Map<string, ApprovalView>();
  const terminals: TerminalInfo[] = [];
  const worktreeFacts = new Map<string, NonNullable<ThreadSeed["worktree"]>>();
  let failing = scenario === "errors";
  let extraApproval = 100;

  const scale = SCALE_COUNTS[scenario];
  const allArchived = scenario === "archived";
  if (withThreads) {
    const seeds = allArchived
      ? BUSY_THREADS.filter((seed) => ARCHIVED_THREADS.includes(seed.n))
      : scale
        ? scaleSeeds(scale)
        : BUSY_THREADS;
    const fleet = scenario === "fleet";
    const perProvider = new Map<string, number>();
    for (const seed of fleet ? [...seeds, ...fleetFailedSeeds(120)] : seeds) {
      const provider = PROVIDERS[seed.provider];
      const fleetAccounts = FLEET_ACCOUNTS[seed.provider];
      const index = perProvider.get(seed.provider) ?? 0;
      perProvider.set(seed.provider, index + 1);
      const id = fixtureId(2, seed.n);
      if (seed.worktree) worktreeFacts.set(id, seed.worktree);
      threads.set(id, {
        id,
        name: seed.name,
        providerId: provider.providerId,
        providerName: provider.providerName,
        model: seed.model,
        effort: fleet ? FLEET_EFFORT[seed.provider] : null,
        providerAccountId: null,
        accountLabel: fleet ? (fleetAccounts[index % fleetAccounts.length] ?? seed.account) : seed.account,
        workspaceId: seed.workspace.id,
        workspaceName: seed.workspace.name,
        permissionMode: seed.mode,
        status: seed.status,
        currentActivity: seed.activity,
        createdAt: ago(seed.startedMinAgo),
        lastActivityAt: ago(seed.lastMinAgo),
        pendingApprovals: 0,
        unreadMessages: seed.unread ?? 0,
        filesChanged: seed.files,
        branch: seed.branch,
        worktreeId: seed.worktree ? fixtureId(4, seed.n) : null,
        error: seed.error ?? null,
        archivedAt: allArchived ? ago(Math.max(0, seed.lastMinAgo - 1)) : null,
        resumable: false,
        permissionProfileId: null,
        // Every fixture is a coding agent (a provider pane), as on the real Dashboard.
        runtimeKind: "interactive_pty",
        terminalId: null,
        archived: allArchived,
      });
    }
    const approvalSeeds = scenario === "approvals-flood" ? [...BUSY_APPROVALS, ...FLOOD_EXTRA] : BUSY_APPROVALS;
    for (const seed of allArchived ? [] : approvalSeeds)
      addApproval(seed, fixtureId(2, seed.thread), ago(seed.minAgo), false);
    for (const t of allArchived ? [] : BUSY_TERMINALS) {
      terminals.push({
        id: fixtureId(3, t.n),
        workspaceId: t.workspace.id,
        shellId: t.shellId,
        title: t.title,
        position: t.n - 1,
        status: "running",
        startedAt: ago(t.minAgo),
        endedAt: null,
        exitCode: null,
      });
    }
  }

  function addApproval(
    seed: Omit<ApprovalSeed, "thread">,
    threadId: string,
    requestedAt: string,
    live: boolean,
  ): ApprovalView | null {
    const thread = threads.get(threadId);
    if (!thread) return null;
    // Remote-consequential actions can only be approved once (docs/PERMISSIONS.md).
    const standing = !seed.scopes.some(isRemoteConsequential) && !seed.scopes.includes("destructive");
    const request: ApprovalView = {
      id: fixtureId(4, seed.n),
      action: {
        id: fixtureId(5, seed.n),
        threadId: thread.id,
        workspaceId: thread.workspaceId,
        providerId: thread.providerId,
        action: seed.action,
        summary: seed.summary,
        requestedAt,
        origin: null,
      },
      decision: { effect: "ask", scopes: seed.scopes, reason: seed.reason, approvable: true },
      permissionMode: thread.permissionMode,
      status: "pending",
      resolvedDecision: null,
      resolvedAt: null,
      allowedDecisions: standing
        ? ["deny", "approve_once", "approve_for_thread", "approve_for_workspace"]
        : ["deny", "approve_once"],
      grantCoverage: standing ? "requests like this one" : "only this exact request",
      context: { threadName: thread.name, workspaceName: thread.workspaceName, providerName: thread.providerName },
      createdAt: requestedAt,
      expireReason: null,
    };
    approvals.set(request.id, request);
    const from = thread.status;
    thread.pendingApprovals += 1;
    thread.status = "waiting_for_permission";
    thread.currentActivity = `Waiting for approval: ${seed.summary}`;
    thread.lastActivityAt = requestedAt;
    if (live) {
      emit(
        {
          type: "approval.requested",
          payload: { requestId: request.id, threadId: thread.id, scopes: seed.scopes, summary: seed.summary },
        },
        { correlation: correlationFor(thread, request.id) },
      );
      if (from !== "waiting_for_permission") statusChanged(thread, from, null);
    }
    return request;
  }

  function correlationFor(thread: ThreadSummary, requestId: string | null = null): Partial<Correlation> {
    return { threadId: thread.id, workspaceId: thread.workspaceId, providerId: thread.providerId, requestId };
  }

  function statusChanged(thread: ThreadSummary, from: ThreadStatus, detail: string | null) {
    emit(
      { type: "thread.status_changed", payload: { threadId: thread.id, from, to: thread.status, detail } },
      { correlation: correlationFor(thread) },
    );
  }

  function transition(thread: ThreadSummary, to: ThreadStatus, activity: string | null) {
    const from = thread.status;
    thread.status = to;
    thread.currentActivity = activity;
    thread.lastActivityAt = new Date().toISOString();
    if (from === to) return;
    statusChanged(thread, from, activity);
    // Like the native runtime: an ending records its own event with the status change.
    if (to === "completed") {
      emit({ type: "thread.completed", payload: { threadId: thread.id } }, { correlation: correlationFor(thread) });
    } else if (to === "failed") {
      thread.error ??= {
        code: "provider_exited",
        message: `${thread.providerName} exited unexpectedly. Your files are unchanged since the last completed step.`,
      };
      emit(
        {
          type: "thread.failed",
          payload: { threadId: thread.id, code: thread.error.code, message: thread.error.message },
        },
        { correlation: correlationFor(thread) },
      );
    }
  }

  function expireApprovals(thread: ThreadSummary) {
    for (const request of approvals.values()) {
      if (request.action.threadId !== thread.id || request.status !== "pending") continue;
      request.status = "expired";
      request.resolvedAt = new Date().toISOString();
      emit(
        { type: "approval.expired", payload: { requestId: request.id, threadId: thread.id } },
        { correlation: correlationFor(thread, request.id) },
      );
    }
    thread.pendingApprovals = 0;
  }

  const read =
    <T>(value: (args: Record<string, unknown>) => T) =>
    (args: Record<string, unknown> = {}): T | Promise<T> => {
      if (scenario === "loading") return new Promise<T>(() => {});
      return value(args);
    };

  const requireThread = (args: Record<string, unknown>, archivedToo = false) => {
    if (!isValidId(args.threadId)) invalidId();
    const thread = threads.get(args.threadId as string);
    if (!thread || (thread.archived && !archivedToo)) {
      fail({
        category: "validation",
        code: "thread_not_found",
        message: "That thread no longer exists.",
        retryable: false,
      });
    }
    return thread;
  };

  const invalidTransition = (thread: ThreadSummary, verb: string): never =>
    fail({
      category: "validation",
      code: "invalid_transition",
      message: `${thread.name} can't be ${verb} while it's ${thread.status.replaceAll("_", " ")}.`,
      retryable: false,
    });

  const snapshot = (thread: ThreadSummary & { archived: boolean }): ThreadSummary => {
    const { archived: _archived, ...summary } = thread;
    return { ...summary };
  };

  const handlers: DashboardHandlers = {
    thread_worktree_commit: (args) => {
      const thread = requireThread(args);
      const facts = worktreeFacts.get(thread.id);
      if (!facts || !thread.worktreeId || !thread.branch)
        fail({
          category: "git",
          code: "worktree_unavailable",
          message: "This agent doesn't run in its own worktree.",
          retryable: false,
        });
      if (facts.changed === 0)
        fail({
          category: "validation",
          code: "nothing_to_commit",
          message: "There are no changes to commit.",
          retryable: false,
        });
      worktreeFacts.set(thread.id, { ...facts, ahead: facts.ahead + 1, changed: 0 });
      const next = worktreeFacts.get(thread.id) as NonNullable<ThreadSeed["worktree"]>;
      return {
        threadId: thread.id,
        worktreeId: thread.worktreeId,
        branch: thread.branch,
        baseBranch: "main",
        ahead: next.ahead,
        behind: 0,
        changed: 0,
        untracked: 0,
        conflicts: next.conflicts,
        changedPaths: next.paths ?? [],
        changedPathsTruncated: false,
        observedAt: new Date().toISOString(),
      };
    },
    thread_worktree_states: read((args) => {
      const ids = Array.isArray(args.threadIds) ? (args.threadIds as string[]) : [];
      return ids.flatMap((id) => {
        const thread = threads.get(id);
        const facts = worktreeFacts.get(id);
        if (!thread?.worktreeId || !thread.branch || !facts) return [];
        return [
          {
            threadId: id,
            worktreeId: thread.worktreeId,
            branch: thread.branch,
            baseBranch: "main",
            ahead: facts.ahead,
            behind: 0,
            changed: facts.changed,
            untracked: 0,
            conflicts: facts.conflicts,
            changedPaths: facts.paths ?? [],
            changedPathsTruncated: false,
            observedAt: new Date().toISOString(),
          },
        ];
      });
    }),
    thread_list: read((args) => {
      if (failing) {
        fail({
          category: "database",
          code: "database_busy",
          message: "KalCode's local database is busy, so threads couldn't be read. Nothing was changed.",
          retryable: true,
        });
      }
      return [...threads.values()].filter((t) => args.includeArchived === true || !t.archived).map(snapshot);
    }),
    approval_list: read(() => {
      if (failing) {
        fail({
          category: "permission",
          code: "approvals_unreadable",
          message: "Approval requests couldn't be read. Pending requests stay paused until they can be answered.",
          retryable: true,
        });
      }
      return [...approvals.values()]
        .filter((a) => a.status === "pending")
        .sort((a, b) => a.action.requestedAt.localeCompare(b.action.requestedAt))
        .map((a) => structuredClone(a));
    }),
    terminals_running: read(() => {
      if (failing) {
        fail({
          category: "terminal",
          code: "terminal_registry_unavailable",
          message: "Running terminals couldn't be listed. Your terminals keep running.",
          retryable: true,
        });
      }
      return terminals.filter((t) => t.status === "running").map((t) => ({ ...t }));
    }),
    approval_decide: (args) => {
      if (!isValidId(args.requestId)) invalidId();
      const decision = args.decision as ApprovalDecision;
      if (!DECISIONS.includes(decision)) {
        fail({
          category: "internal",
          code: "ipc_rejected",
          message: "KalCode couldn't complete that request.",
          retryable: false,
        });
      }
      const request = approvals.get(args.requestId as string);
      if (!request) {
        fail({
          category: "validation",
          code: "approval_not_found",
          message: "That approval request no longer exists.",
          retryable: false,
        });
      }
      if (request.status !== "pending") {
        fail({
          category: "validation",
          code: "approval_not_pending",
          message: "That request was already answered or has expired.",
          retryable: false,
        });
      }
      if (!request.decision.approvable && decision !== "deny") {
        fail({
          category: "permission",
          code: "not_approvable",
          message: "A rule forbids this action.",
          retryable: false,
        });
      }
      const thread = threads.get(request.action.threadId);
      request.status = decision === "deny" ? "denied" : "approved";
      request.resolvedDecision = decision;
      request.resolvedAt = new Date().toISOString();
      if (thread) {
        const correlation = correlationFor(thread, request.id);
        emit(
          decision === "deny"
            ? { type: "approval.denied", payload: { requestId: request.id, threadId: thread.id } }
            : { type: "approval.approved", payload: { requestId: request.id, threadId: thread.id, decision } },
          { correlation },
        );
        thread.pendingApprovals = Math.max(0, thread.pendingApprovals - 1);
        if (thread.pendingApprovals === 0 && thread.status === "waiting_for_permission") {
          if (decision === "deny") transition(thread, "thinking", "Choosing another approach");
          else {
            const next = activityAfterApproval(request.action.action);
            transition(thread, next.status, next.activity);
          }
        } else if (thread.pendingApprovals > 0) {
          const nextRequest = [...approvals.values()].find(
            (a) => a.action.threadId === thread.id && a.status === "pending",
          );
          if (nextRequest) thread.currentActivity = `Waiting for approval: ${nextRequest.action.summary}`;
        }
      }
      return structuredClone(request);
    },
    // Opening an agent from a card reads it first (uiIntents decides Code pane vs Threads).
    thread_get: read((args) => snapshot(requireThread(args))),
    thread_interrupt: (args) => {
      const thread = requireThread(args);
      const s = thread.status;
      // Like native: only a running turn (or one waiting for approval) can be paused; a start,
      // a recovery or a wait has no turn to halt.
      const turn = ["active", "thinking", "running_tool", "running_command", "editing", "testing", "reviewing"];
      if (!turn.includes(s) && s !== "waiting_for_permission") invalidTransition(thread, "paused");
      expireApprovals(thread);
      transition(thread, "paused", "Paused by you");
      return snapshot(thread);
    },
    thread_stop: (args) => {
      const thread = requireThread(args);
      // Stop ends something in progress (a turn, a start or a wait); a quiet thread is archived instead.
      if (["completed", "failed", "interrupted", "offline", "idle", "waiting_for_user"].includes(thread.status))
        invalidTransition(thread, "stopped");
      expireApprovals(thread);
      transition(thread, "interrupted", "Stopped by you");
      return snapshot(thread);
    },
    thread_resume: (args) => {
      const thread = requireThread(args);
      if (!["paused", "interrupted", "offline", "failed"].includes(thread.status)) invalidTransition(thread, "resumed");
      const retry = thread.status === "failed";
      thread.error = null;
      transition(thread, "starting", retry ? "Retrying the failed step" : "Resuming");
      return snapshot(thread);
    },
    thread_archive: (args) => {
      const thread = requireThread(args);
      // Like native: finished threads and quiet open ones (whose idle session the archive ends).
      // Offline: no session is running (native archives it like any quiet thread).
      if (!["completed", "failed", "interrupted", "idle", "waiting_for_user", "offline"].includes(thread.status))
        invalidTransition(thread, "archived");
      thread.archived = true;
      thread.archivedAt = new Date().toISOString();
      emit({ type: "thread.archived", payload: { threadId: thread.id } }, { correlation: correlationFor(thread) });
      return snapshot(thread);
    },
    // Like native `thread_unarchive`: idempotent; only a restore records the event.
    thread_unarchive: (args) => {
      const thread = requireThread(args, true);
      if (!thread.archived) return snapshot(thread);
      thread.archived = false;
      thread.archivedAt = null;
      emit({ type: "thread.unarchived", payload: { threadId: thread.id } }, { correlation: correlationFor(thread) });
      return snapshot(thread);
    },
  };

  const controls: DashboardControls = {
    requestApproval() {
      const thread = threads.get(fixtureId(2, 3)) ?? [...threads.values()].find((t) => !t.archived);
      if (!thread) return null;
      extraApproval += 1;
      const request = addApproval(
        {
          n: extraApproval,
          action: {
            kind: "command",
            command: "pnpm prisma migrate dev",
            argv: ["pnpm", "prisma", "migrate", "dev"],
            cwd: "~/code/atlas-api",
          },
          summary: "Run pnpm prisma migrate dev",
          scopes: ["terminal.execute"],
          reason: "Approve mode asks before running commands.",
          minAgo: 0,
        },
        thread.id,
        new Date().toISOString(),
        true,
      );
      return request?.id ?? null;
    },
    setThreadStatus(threadId, status, activity = null) {
      const thread = threads.get(threadId);
      if (thread) transition(thread, status, activity);
    },
    recover() {
      failing = false;
    },
  };

  function seedHistory() {
    if (!withThreads) return;
    if (allArchived) {
      // Each thread was created, ran, and was archived by the person.
      const created = [...threads.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      for (const thread of created) {
        const options = { correlation: correlationFor(thread) };
        emit(
          {
            type: "thread.created",
            payload: {
              threadId: thread.id,
              name: thread.name,
              providerId: thread.providerId,
              workspaceId: thread.workspaceId,
            },
          },
          { ...options, occurredAt: thread.createdAt },
        );
        emit(
          { type: "thread.archived", payload: { threadId: thread.id } },
          { ...options, occurredAt: thread.archivedAt ?? thread.lastActivityAt, source: "ui" },
        );
      }
      return;
    }
    if (!BUSY_THREADS.every((seed) => threads.has(fixtureId(2, seed.n)))) {
      // Scale scenarios: each agent's creation, oldest first, then the pending approvals.
      const created = [...threads.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      for (const thread of created) {
        emit(
          {
            type: "thread.created",
            payload: {
              threadId: thread.id,
              name: thread.name,
              providerId: thread.providerId,
              workspaceId: thread.workspaceId,
            },
          },
          { occurredAt: thread.createdAt, correlation: correlationFor(thread) },
        );
      }
      for (const request of approvals.values()) {
        const thread = threads.get(request.action.threadId);
        if (!thread) continue;
        emit(
          {
            type: "approval.requested",
            payload: {
              requestId: request.id,
              threadId: thread.id,
              scopes: request.decision.scopes,
              summary: request.action.summary,
            },
          },
          { occurredAt: request.action.requestedAt, correlation: correlationFor(thread, request.id) },
        );
      }
      return;
    }
    const t = (n: number) => threads.get(fixtureId(2, n)) as ThreadSummary;
    const at = (minutes: number) => ({ occurredAt: ago(minutes) });
    const history: [number, EventPayload, ThreadSummary | null, string | null][] = [
      [24, { type: "thread.completed", payload: { threadId: t(10).id } }, t(10), null],
      [
        18,
        {
          type: "thread.created",
          payload: { threadId: t(2).id, name: t(2).name, providerId: t(2).providerId, workspaceId: t(2).workspaceId },
        },
        t(2),
        null,
      ],
      [
        17,
        { type: "shell.started", payload: { terminalId: fixtureId(3, 2), shellId: "git-bash", shellName: "Git Bash" } },
        null,
        null,
      ],
      [
        11,
        {
          type: "thread.failed",
          payload: {
            threadId: t(11).id,
            code: "provider_exited",
            message: "Gemini CLI exited unexpectedly (exit code 1)",
          },
        },
        t(11),
        null,
      ],
      [
        9,
        {
          type: "thread.created",
          payload: { threadId: t(4).id, name: t(4).name, providerId: t(4).providerId, workspaceId: t(4).workspaceId },
        },
        t(4),
        null,
      ],
      [
        6,
        { type: "agent.message", payload: { threadId: t(5).id, messageId: fixtureId(6, 1), role: "assistant" } },
        t(5),
        null,
      ],
      [
        6,
        { type: "shell.started", payload: { terminalId: fixtureId(3, 3), shellId: "pwsh", shellName: "PowerShell 7" } },
        null,
        null,
      ],
      [
        4,
        { type: "file.modified", payload: { threadId: t(3).id, path: "db/migrations/0007_invoices.sql" } },
        t(3),
        null,
      ],
    ];
    for (const [minutes, event, thread, requestId] of history) {
      emit(event, { ...at(minutes), correlation: thread ? correlationFor(thread, requestId) : {} });
    }
    const requests = [...approvals.values()].sort((a, b) => a.action.requestedAt.localeCompare(b.action.requestedAt));
    for (const request of requests) {
      const thread = threads.get(request.action.threadId);
      if (!thread) continue;
      emit(
        {
          type: "approval.requested",
          payload: {
            requestId: request.id,
            threadId: thread.id,
            scopes: request.decision.scopes,
            summary: request.action.summary,
          },
        },
        { occurredAt: request.action.requestedAt, correlation: correlationFor(thread, request.id) },
      );
    }
    emit(
      {
        type: "tool.requested",
        payload: {
          threadId: t(2).id,
          toolCallId: fixtureId(7, 1),
          tool: "shell",
          summary: "pnpm test checkout --repeat 20",
        },
      },
      { ...at(0), correlation: correlationFor(t(2)) },
    );
  }

  return { handlers, controls, sessionAgeMs: withThreads ? 260 * MIN : 2 * MIN, seedHistory };
}
