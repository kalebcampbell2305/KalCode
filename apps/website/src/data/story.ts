/**
 * Sample data for the product stage (the KalCode window drawn on the website).
 *
 * Everything here is illustrative: one believable repository (`atlas-api`), four agent threads and
 * a terminal, the approval they raise, and the KalVoice script. It is rendered at build time into
 * static HTML; the stage scripts only switch state attributes. Every place that shows it carries
 * "Product preview · sample data". Nothing here names or implies a real customer.
 *
 * Status names, tones and labels mirror the desktop Dashboard (`STATUS_META` in
 * apps/desktop/src/surfaces/dashboard/data/status.ts). Model strings come from the Dashboard
 * fixtures. Provider interfaces are original drawings at about 80% fidelity: the right glyphs and
 * structure for each CLI, no logos, no copied wording.
 */

import { KALVOICE } from "../lib/site";

/* ------------------------------------------------------------------ providers */

export type ProviderId = "claude" | "codex" | "gemini" | "shell";

export interface Provider {
  id: ProviderId;
  name: string;
  /** Banner title line (neutral: product name and a version, never a vendor wordmark). */
  banner: string;
  model: string;
  account: string;
}

export const PROVIDERS: Record<ProviderId, Provider> = {
  claude: {
    id: "claude",
    name: "Claude Code",
    banner: "Claude Code 2.1",
    model: "claude-sonnet-4-5",
    account: "Personal account",
  },
  codex: { id: "codex", name: "Codex", banner: "Codex CLI 0.155", model: "gpt-5-codex", account: "Work account" },
  gemini: {
    id: "gemini",
    name: "Gemini CLI",
    banner: "Gemini CLI",
    model: "gemini-2.5-pro",
    account: "Personal account",
  },
  shell: { id: "shell", name: "PowerShell 7", banner: "PowerShell 7.5", model: "", account: "" },
};

export const AGENT_PROVIDERS = ["claude", "codex", "gemini"] as const satisfies readonly ProviderId[];

/* ------------------------------------------------------------------ status (1:1 with the app) */

/** "waiting" renders neutral grey (waiting for you); "paused" is the only amber tone. */
export type StatusTone = "live" | "waiting" | "paused" | "success" | "danger" | "idle";
export type ThreadStatus =
  | "starting"
  | "active"
  | "thinking"
  | "running_tool"
  | "running_command"
  | "editing"
  | "testing"
  | "reviewing"
  | "waiting_for_permission"
  | "waiting_for_user"
  | "waiting_for_dependency"
  | "idle"
  | "paused"
  | "completed"
  | "failed"
  | "interrupted";

export interface StatusMeta {
  label: string;
  tone: StatusTone;
  /** Icon id in stage/icons.css. */
  icon: string;
  group: "attention" | "working" | "waiting" | "idle" | "finished";
}

export const STATUS: Record<ThreadStatus, StatusMeta> = {
  starting: { label: "Starting", tone: "live", icon: "play", group: "working" },
  active: { label: "Working", tone: "live", icon: "working", group: "working" },
  thinking: { label: "Thinking", tone: "live", icon: "thinking", group: "working" },
  running_tool: { label: "Using a tool", tone: "live", icon: "tool", group: "working" },
  running_command: { label: "Running command", tone: "live", icon: "terminal", group: "working" },
  editing: { label: "Editing files", tone: "live", icon: "editing", group: "working" },
  testing: { label: "Testing", tone: "live", icon: "testing", group: "working" },
  reviewing: { label: "Reviewing", tone: "live", icon: "reviewing", group: "working" },
  waiting_for_permission: { label: "Needs approval", tone: "waiting", icon: "approval", group: "attention" },
  waiting_for_user: { label: "Needs your reply", tone: "waiting", icon: "reply", group: "attention" },
  waiting_for_dependency: { label: "Blocked", tone: "idle", icon: "hourglass", group: "waiting" },
  idle: { label: "Idle", tone: "idle", icon: "idle", group: "idle" },
  paused: { label: "Paused", tone: "paused", icon: "paused", group: "idle" },
  completed: { label: "Completed", tone: "success", icon: "done", group: "finished" },
  failed: { label: "Failed", tone: "danger", icon: "failed", group: "finished" },
  interrupted: { label: "Stopped", tone: "idle", icon: "stopped", group: "finished" },
};

/* ------------------------------------------------------------------ approval + permission modes */

/** `allowed` = Allow for thread, `workspace` = Allow for workspace. */
export type ApprovalState = "none" | "pending" | "approved" | "allowed" | "workspace" | "denied";
export type PermissionMode = "plan" | "approve" | "auto" | "bypass" | "custom";
export type Outcome = "allow" | "ask" | "deny";

export interface ModeInfo {
  id: PermissionMode;
  label: string;
  /** App hint (PERMISSION_MODE_HINTS). */
  hint: string;
  /** How much the agent may do on its own, 1–4 (Custom depends on the profile). */
  authority: number;
  planned?: boolean;
}

export const MODES: readonly ModeInfo[] = [
  { id: "plan", label: "Plan", hint: "Read and plan only; nothing changes without a new mode", authority: 1 },
  { id: "approve", label: "Approve", hint: "Asks before changing files or running commands", authority: 2 },
  { id: "auto", label: "Auto", hint: "Runs routine work; asks for anything consequential", authority: 3 },
  {
    id: "bypass",
    label: "Bypass",
    hint: "Runs without asking, except actions that leave this machine",
    authority: 4,
    planned: true,
  },
  {
    id: "custom",
    label: "Custom",
    hint: "Follows a custom permission profile, here “Code reviewer”",
    authority: 2,
    planned: true,
  },
];

export interface AuthorityRow {
  action: string;
  scope: string;
  /** Icon id (stage/icons.css). */
  icon: string;
  outcomes: Record<PermissionMode, Outcome>;
  /** Always asks, whatever the mode (it leaves this machine): "Ask" reads "Approval required". */
  always?: boolean;
  /** Shown in the compact permissions table. */
  compact?: boolean;
}

/** Default outcomes per mode, as described in /docs/permissions. */
export const AUTHORITY: readonly AuthorityRow[] = [
  {
    action: "Read files",
    scope: "filesystem.read",
    icon: "file",
    compact: true,
    outcomes: { plan: "allow", approve: "allow", auto: "allow", bypass: "allow", custom: "allow" },
  },
  {
    action: "Edit files",
    scope: "filesystem.write",
    icon: "editing",
    compact: true,
    outcomes: { plan: "deny", approve: "ask", auto: "allow", bypass: "allow", custom: "deny" },
  },
  {
    action: "Run commands",
    scope: "terminal.execute",
    icon: "terminal",
    compact: true,
    outcomes: { plan: "ask", approve: "ask", auto: "allow", bypass: "allow", custom: "ask" },
  },
  {
    action: "Install packages",
    scope: "package.install",
    icon: "plus",
    outcomes: { plan: "deny", approve: "ask", auto: "ask", bypass: "allow", custom: "deny" },
  },
  {
    action: "Network access",
    scope: "network.other",
    icon: "globe",
    compact: true,
    outcomes: { plan: "ask", approve: "ask", auto: "ask", bypass: "allow", custom: "ask" },
  },
  {
    action: "Push to a remote",
    scope: "git.push",
    icon: "branch",
    always: true,
    outcomes: { plan: "deny", approve: "ask", auto: "ask", bypass: "ask", custom: "deny" },
  },
  {
    action: "Deploy to production",
    scope: "deploy.production",
    icon: "play",
    always: true,
    compact: true,
    outcomes: { plan: "deny", approve: "ask", auto: "ask", bypass: "ask", custom: "deny" },
  },
];

export const OUTCOME_LABEL: Record<Outcome, string> = { allow: "Allow", ask: "Ask", deny: "Deny" };

export interface Approval {
  id: string;
  threadId: string;
  /** Card title, as the app writes it. */
  title: string;
  kind: string;
  command: string;
  context?: string;
  /** The one-line notice ("Codex wants to run: …"). */
  notice: string;
  scopes: readonly string[];
  reason: string;
  leavesMachine?: boolean;
  asked: string;
  /** What the request resolves to in each mode before anyone is asked. */
  byMode: Record<PermissionMode, Outcome>;
  /** What a standing answer covers ("Requests like this one"), as the app words it. */
  coverage: string;
  results: Record<Exclude<ApprovalState, "none" | "pending">, string>;
  modeResults: { allow: string; deny: string };
}

export const ZOD_APPROVAL: Approval = {
  id: "zod",
  threadId: "codex-signup",
  title: "Install zod",
  kind: "Install a package",
  command: "pnpm add zod",
  context: "in ~/code/atlas-api",
  notice: "Codex wants to run: pnpm add zod",
  scopes: ["Install packages", "Network access"],
  reason: "Approve mode asks before installing packages.",
  asked: "just now",
  byMode: { plan: "deny", approve: "ask", auto: "ask", bypass: "allow", custom: "deny" },
  coverage: "Requests like this one",
  results: {
    approved: "Approved once. Codex ran pnpm add zod and continued.",
    allowed:
      "Allowed for this thread. Installs like this one won’t ask again in “Validate signup input” until it stops.",
    workspace:
      "Allowed for this workspace. Installs like this one won’t ask again in any atlas-api thread for 30 days.",
    denied: "Denied. Codex was told not to install packages and asked how to proceed.",
  },
  modeResults: {
    allow: "Bypass allows local installs, so this runs without asking and is written to the audit log.",
    deny: "This mode denies package installs, so Codex receives a denial without asking you.",
  },
};

export const PUSH_APPROVAL = {
  id: "push",
  threadId: "claude-runner",
  title: "Push chore/test-runner to origin",
  kind: "Git push",
  command: "git push -u origin chore/test-runner",
  scopes: ["Git push"],
  reason: "Pushing leaves this machine, so it always asks, whatever the mode.",
  leavesMachine: true,
  asked: "3 minutes ago",
  /** Pushing is an always-ask scope: the app offers only Deny and Approve once. */
  results: {
    approved: "Approved once. Claude Code pushed chore/test-runner to origin.",
    denied: "Denied. Claude Code was told not to push, and the branch stays local.",
  },
} as const;

/* ------------------------------------------------------------------ transcripts */

export interface DiffLine {
  n: number | null;
  op: "+" | "-" | " " | "…";
  code: string;
}

/** One transcript block. Provider bodies render each kind in that CLI's own style. */
export type Block =
  | { t: "user"; text: string }
  /** Claude-style tool call: ● Name(arg) / ⎿ result. */
  | { t: "tool"; name: string; arg: string; state: "ok" | "run" | "wait" | "fail"; result: string }
  /** Assistant prose (● in Claude, • in Codex, ✦ in Gemini). */
  | { t: "say"; text: string }
  | { t: "diff"; lines: readonly DiffLine[] }
  /** Codex-style activity item: • Verb arg (+a -d) / └ output. */
  | { t: "item"; verb: string; arg: string; add?: number; del?: number; out?: readonly string[]; tone?: "ok" | "wait" }
  /** Gemini-style boxed tool call. */
  | { t: "box"; state: "ok" | "run" | "fail"; name: string; arg: string; desc?: string; out: readonly string[] }
  /** Codex turn rule: ─ Worked for 1m 08s ─ */
  | { t: "rule"; text: string }
  /** Shell prompt + command. */
  | { t: "prompt"; cwd: string; cmd: string }
  /** Raw output line; spans use terminal colours. */
  | {
      t: "out";
      spans: readonly { text: string; c?: "red" | "green" | "yellow" | "blue" | "cyan" | "magenta" | "dim" | "bold" }[];
    };

export interface Conditional {
  /** Show only in these approval states (default: always). */
  when?: readonly ApprovalState[];
}

export type Line = Block & Conditional;

export interface Working extends Conditional {
  /** Gerund shown on the status line ("Testing…"). */
  verb: string;
  /** Seconds already elapsed when the pane is first drawn. */
  sec: number;
}

export interface Thread {
  id: string;
  provider: ProviderId;
  name: string;
  status: ThreadStatus;
  /** Status per approval state, for the thread that raised the approval. */
  statusByApproval?: Partial<Record<ApprovalState, ThreadStatus>>;
  activity: string;
  activityByApproval?: Partial<Record<ApprovalState, string>>;
  workspace: string;
  branch: string;
  mode: PermissionMode;
  filesChanged: number | null;
  /** Run time label for rows ("18 min"). */
  duration: string;
  cwd: string;
  transcript: readonly Line[];
  working?: readonly Working[];
  /** Composer placeholder. */
  placeholder: string;
  /** Threads created later in a scene (KalVoice command); hidden until spawned. */
  spawned?: boolean;
}

const CWD = "~/code/atlas-api";
const WIN_CWD = "C:\\Users\\you\\code\\atlas-api";

export const WORKSPACE = {
  name: "atlas-api",
  path: CWD,
  winPath: WIN_CWD,
  branch: "main",
} as const;

export const THREADS: readonly Thread[] = [
  {
    id: "claude-checkout",
    provider: "claude",
    name: "Fix flaky checkout test",
    status: "running_command",
    activity: "Running pnpm test checkout --repeat 20",
    workspace: "atlas-api",
    branch: "fix/checkout-flake",
    mode: "auto",
    filesChanged: 2,
    duration: "18 min",
    cwd: CWD,
    placeholder: "Try “run the e2e suite”, or type / for commands",
    transcript: [
      { t: "user", text: "fix the flaky checkout test, it fails about 1 in 10 runs on CI" },
      { t: "tool", name: "Read", arg: "tests/checkout.spec.ts", state: "ok", result: "Read 84 lines" },
      { t: "tool", name: "Read", arg: "src/checkout/reserve.ts", state: "ok", result: "Read 112 lines" },
      {
        t: "say",
        text: "The test reads stock before reserve() has written it, so the assertion races the update. I’ll await the decrement inside a transaction.",
      },
      {
        t: "tool",
        name: "Update",
        arg: "src/checkout/reserve.ts",
        state: "ok",
        result: "Updated src/checkout/reserve.ts with 3 additions and 1 removal",
      },
      {
        t: "diff",
        lines: [
          { n: 40, op: " ", code: "  const item = await findItem(sku);" },
          { n: 41, op: "-", code: "  db.stock.decrement(item.sku, qty);" },
          { n: 41, op: "+", code: "  await db.transaction(async (tx) => {" },
          { n: 42, op: "+", code: "    await tx.stock.decrement(item.sku, qty);" },
          { n: 43, op: "+", code: "  });" },
        ],
      },
      { t: "say", text: "reserve() now resolves after the write. Running the checkout suite 20 times to be sure." },
      {
        t: "tool",
        name: "Bash",
        arg: "pnpm test checkout --repeat 20",
        state: "run",
        result: "Running… 13 of 20 passed",
      },
    ],
    working: [{ verb: "Testing…", sec: 48 }],
  },
  {
    id: "codex-signup",
    provider: "codex",
    name: "Validate signup input",
    status: "reviewing",
    statusByApproval: {
      none: "reviewing",
      pending: "waiting_for_permission",
      approved: "reviewing",
      allowed: "reviewing",
      workspace: "reviewing",
      denied: "waiting_for_user",
    },
    activity: "Reviewing src/routes/signup.ts",
    activityByApproval: {
      pending: "Waiting for approval: Install zod",
      approved: "Reviewing the passing signup suite",
      allowed: "Reviewing the passing signup suite",
      workspace: "Reviewing the passing signup suite",
      denied: "Asked how to validate without zod",
    },
    workspace: "atlas-api",
    branch: "feat/signup-validation",
    mode: "approve",
    filesChanged: 3,
    duration: "9 min",
    cwd: CWD,
    placeholder: "Ask Codex to change, explain or test something",
    transcript: [
      { t: "user", text: "validate the signup payload and return 422 on bad input" },
      { t: "item", verb: "Explored", arg: "", out: ["Read src/routes/signup.ts, src/lib/errors.ts"] },
      {
        t: "item",
        verb: "Edited",
        arg: "src/routes/signup.ts",
        add: 12,
        del: 3,
      },
      {
        t: "diff",
        lines: [
          { n: 3, op: "+", code: 'import { z } from "zod";' },
          { n: 4, op: "+", code: "const SignupBody = z.object({" },
          { n: 5, op: "+", code: "  email: z.string().email()," },
          { n: 6, op: "+", code: "  password: z.string().min(12)," },
          { n: 7, op: "+", code: "});" },
          { n: null, op: "…", code: "" },
          { n: 41, op: "-", code: "  const { email, password } = await c.req.json();" },
          { n: 41, op: "+", code: "  const parsed = SignupBody.safeParse(await c.req.json());" },
          { n: 42, op: "+", code: "  if (!parsed.success) return c.json(fieldErrors(parsed.error), 422);" },
        ],
      },
      { t: "say", text: "Checking the new branch against the error format the other routes use.", when: ["none"] },
      {
        t: "say",
        text: "zod isn’t a dependency yet, so the import fails. Asking to install it.",
        when: ["pending", "approved", "allowed", "workspace", "denied"],
      },
      {
        t: "item",
        verb: "Waiting for approval",
        arg: "pnpm add zod",
        tone: "wait",
        out: ["KalCode is asking you on the Dashboard"],
        when: ["pending"],
      },
      {
        t: "item",
        verb: "Ran",
        arg: "pnpm add zod",
        out: ["+ zod 4.1.0", "Done in 2.1s"],
        when: ["approved", "allowed", "workspace"],
      },
      {
        t: "item",
        verb: "Ran",
        arg: "pnpm test -- signup",
        out: ["PASS  tests/signup.spec.ts (6 tests)"],
        when: ["approved", "allowed", "workspace"],
      },
      { t: "rule", text: "Worked for 1m 08s", when: ["approved", "allowed", "workspace"] },
      {
        t: "say",
        text: "Bad input now gets a 422 with a list of fields. All 6 signup tests pass.",
        when: ["approved", "allowed", "workspace"],
      },
      {
        t: "say",
        text: "Understood, no new packages. Should I validate by hand, or use the schema helper in src/lib?",
        when: ["denied"],
      },
    ],
    working: [
      { verb: "Reviewing", sec: 12, when: ["none"] },
      { verb: "Reviewing", sec: 4, when: ["approved", "allowed", "workspace"] },
    ],
  },
  {
    id: "gemini-research",
    provider: "gemini",
    name: "Research rate-limit options",
    status: "thinking",
    activity: "Researching sliding-window limits",
    workspace: "atlas-api",
    branch: "feat/rate-limit",
    mode: "plan",
    filesChanged: 0,
    duration: "6 min",
    cwd: CWD,
    placeholder: "Type a message or @path/to/file",
    transcript: [
      { t: "user", text: "compare rate-limit approaches for POST /signup, no code changes yet" },
      { t: "box", state: "ok", name: "ReadFile", arg: "src/routes/signup.ts", out: ["Read 64 lines"] },
      { t: "box", state: "ok", name: "SearchText", arg: "'rateLimit' in src/**", out: ["Found 3 matches in 2 files"] },
      {
        t: "box",
        state: "ok",
        name: "Shell",
        arg: "redis-cli INFO keyspace",
        desc: "Check what the local Redis holds",
        out: ["db0:keys=1284,expires=12"],
      },
      {
        t: "say",
        text: "A sliding-window counter in Redis fits best: the API already keeps sessions there, and a fixed window would let a burst through at each minute boundary.",
      },
    ],
    working: [{ verb: "Weighing sliding windows against fixed windows", sec: 12 }],
  },
  {
    id: "claude-runner",
    provider: "claude",
    name: "Upgrade test runner",
    status: "waiting_for_permission",
    activity: "Waiting for approval: Push chore/test-runner to origin",
    workspace: "atlas-api",
    branch: "chore/test-runner",
    mode: "auto",
    filesChanged: 2,
    duration: "31 min",
    cwd: CWD,
    placeholder: "Try “explain the config change”, or type / for commands",
    transcript: [
      { t: "user", text: "upgrade vitest to 5, fix whatever breaks, then push the branch" },
      { t: "tool", name: "Bash", arg: "pnpm up vitest@5", state: "ok", result: "Updated 3 packages" },
      {
        t: "tool",
        name: "Update",
        arg: "vitest.config.ts",
        state: "ok",
        result: "Updated vitest.config.ts with 1 addition and 1 removal",
      },
      {
        t: "diff",
        lines: [
          { n: 7, op: "-", code: '    pool: "threads",' },
          { n: 7, op: "+", code: '    pool: "forks",' },
        ],
      },
      { t: "tool", name: "Bash", arg: "pnpm test", state: "ok", result: "214 passed (38 files)" },
      { t: "say", text: "All green. Pushing leaves this machine, so KalCode is asking you first." },
      {
        t: "tool",
        name: "Bash",
        arg: "git push -u origin chore/test-runner",
        state: "wait",
        result: "Waiting for your approval on the Dashboard",
      },
    ],
  },
  {
    id: "shell",
    provider: "shell",
    name: "PowerShell 7",
    status: "running_command",
    activity: "pnpm dev",
    workspace: "atlas-api",
    branch: "main",
    mode: "approve",
    filesChanged: null,
    duration: "47 min",
    cwd: WIN_CWD,
    placeholder: "",
    transcript: [
      { t: "prompt", cwd: WIN_CWD, cmd: "git log --oneline -4" },
      {
        t: "out",
        spans: [
          { text: "9c41e2a", c: "yellow" },
          { text: " (HEAD -> main, origin/main)", c: "cyan" },
          { text: " Add signup route" },
        ],
      },
      { t: "out", spans: [{ text: "5b0f7d3", c: "yellow" }, { text: " Reserve stock in checkout" }] },
      { t: "out", spans: [{ text: "e18a9c0", c: "yellow" }, { text: " Session store on Redis" }] },
      {
        t: "out",
        spans: [
          { text: "2d7c611", c: "yellow" },
          { text: " (tag: v0.9.0)", c: "cyan" },
          { text: " First API release" },
        ],
      },
      { t: "prompt", cwd: WIN_CWD, cmd: "git status --short" },
      { t: "out", spans: [{ text: " M ", c: "red" }, { text: "src/checkout/reserve.ts" }] },
      { t: "out", spans: [{ text: " M ", c: "red" }, { text: "src/routes/signup.ts" }] },
      { t: "out", spans: [{ text: "?? ", c: "red" }, { text: "tests/signup.spec.ts" }] },
      { t: "prompt", cwd: WIN_CWD, cmd: "pnpm dev" },
      { t: "out", spans: [{ text: "> atlas-api@0.9.0 dev", c: "dim" }] },
      { t: "out", spans: [{ text: "> tsx watch src/server.ts", c: "dim" }] },
      {
        t: "out",
        spans: [
          { text: "ready", c: "green" },
          { text: "  Listening on " },
          { text: "http://localhost:3000", c: "cyan" },
        ],
      },
      { t: "out", spans: [{ text: "watch", c: "blue" }, { text: " src/routes/signup.ts changed, restarting" }] },
      {
        t: "out",
        spans: [
          { text: "ready", c: "green" },
          { text: "  Listening on " },
          { text: "http://localhost:3000", c: "cyan" },
        ],
      },
    ],
  },
  {
    id: "claude-e2e",
    provider: "claude",
    name: "Cover 429 in the e2e suite",
    status: "editing",
    activity: "Editing tests/e2e/signup.e2e.ts",
    workspace: "atlas-api",
    branch: "feat/rate-limit",
    mode: "auto",
    filesChanged: 1,
    duration: "under 1 min",
    cwd: CWD,
    placeholder: "Try “run only the signup e2e”, or type / for commands",
    spawned: true,
    transcript: [
      { t: "user", text: "cover the 429 response for repeated signups in the e2e suite" },
      { t: "tool", name: "Read", arg: "tests/e2e/signup.e2e.ts", state: "ok", result: "Read 58 lines" },
      {
        t: "tool",
        name: "Update",
        arg: "tests/e2e/signup.e2e.ts",
        state: "ok",
        result: "Updated tests/e2e/signup.e2e.ts with 6 additions",
      },
      {
        t: "diff",
        lines: [
          { n: 59, op: "+", code: 'test("sixth signup in a minute gets 429", async () => {' },
          { n: 60, op: "+", code: "  for (const email of fiveEmails) await signup(page, email);" },
          { n: 61, op: "+", code: '  await expect(signup(page, "u5@example.com")).rejects.toHaveStatus(429);' },
        ],
      },
    ],
    working: [{ verb: "Writing tests…", sec: 3 }],
  },
  {
    id: "codex-review",
    provider: "codex",
    name: "Review the signup limit",
    status: "reviewing",
    activity: "Reviewing src/middleware/rate-limit.ts",
    workspace: "atlas-api",
    branch: "feat/rate-limit",
    mode: "plan",
    filesChanged: 0,
    duration: "under 1 min",
    cwd: CWD,
    placeholder: "Ask Codex to change, explain or test something",
    spawned: true,
    transcript: [
      { t: "user", text: "review the rate-limit middleware before it merges" },
      { t: "item", verb: "Explored", arg: "", out: ["Read src/middleware/rate-limit.ts, src/lib/redis.ts"] },
      { t: "say", text: "The window key includes the IP but not the route, so /login and /signup share one budget." },
    ],
    working: [{ verb: "Reviewing", sec: 2 }],
  },
];

/**
 * Stable 0.1.5 ships with Gemini CLI unavailable (site.ts GEMINI_AVAILABILITY), so stages that name
 * the Stable release draw the research thread as a Codex thread instead. It keeps the same id so
 * the stage scripts still find it; the preview keeps the Gemini CLI thread above.
 */
export const STABLE_RESEARCH_THREAD: Thread = {
  ...(THREADS.find((t) => t.id === "gemini-research") as Thread),
  provider: "codex",
  placeholder: "Ask Codex to change, explain or test something",
  transcript: [
    { t: "user", text: "compare rate-limit approaches for POST /signup, no code changes yet" },
    { t: "item", verb: "Explored", arg: "", out: ["Read src/routes/signup.ts", "Searched 'rateLimit' in src/**"] },
    { t: "item", verb: "Ran", arg: "redis-cli INFO keyspace", out: ["db0:keys=1284,expires=12"] },
    {
      t: "say",
      text: "A sliding-window counter in Redis fits best: the API already keeps sessions there, and a fixed window would let a burst through at each minute boundary.",
    },
  ],
  working: [{ verb: "Weighing sliding windows against fixed windows", sec: 12 }],
};

/** The sample threads a stage draws: Stable-labelled stages swap Gemini CLI for the Codex stand-in. */
export function sampleThreads(stable: boolean): readonly Thread[] {
  return stable ? THREADS.map((t) => (t.id === STABLE_RESEARCH_THREAD.id ? STABLE_RESEARCH_THREAD : t)) : THREADS;
}

/** A Gemini-styled status tail ("✦ …", "⠋ …") restyled for the Codex stand-in ("• …"). */
export function sampleTail(tail: string | undefined, provider: ProviderId): string | undefined {
  return tail && provider !== "gemini" ? tail.replace(/^[✦⠋]\s*/, "• ") : tail;
}

/** Threads open in a fresh, new pane ("+ New thread"). */
export const FRESH_PLACEHOLDER: Record<ProviderId, string> = {
  claude: "Try “explain this repo”, or type / for commands",
  codex: "Ask Codex to change, explain or test something",
  gemini: "Type a message or @path/to/file",
  shell: "",
};

export const GEMINI_TIPS = [
  "Ask about code, edit files or run commands.",
  "Be specific to get the best results.",
  "Add a GEMINI.md file to give it project context.",
  "Type /help for more.",
] as const;

/* ------------------------------------------------------------------ browser preview */

export const BROWSER = {
  url: "localhost:3000/admin/signups",
  app: "atlas",
  title: "Signup limits",
  chip: "Rate limit on",
  subtitle: "Five signups per IP per minute, then 429 until the window slides.",
  metrics: [
    { label: "Signups · 24 h", value: "1,284", unit: "" },
    { label: "Limited (429)", value: "37", unit: "" },
    { label: "p95 latency", value: "84", unit: "ms" },
  ],
  /** Requests per hour for the last 24 hours, and how many of them hit the limit. */
  hours: [22, 18, 14, 11, 9, 8, 12, 25, 44, 61, 70, 66, 72, 69, 64, 71, 83, 90, 76, 58, 49, 41, 33, 27] as const,
  limited: [0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 2, 1, 3, 2, 2, 4, 6, 5, 3, 1, 1, 0, 1, 0] as const,
  attempts: [
    { who: "m***@example.com", ip: "203.0.113.24", code: 201, label: "Created" },
    { who: "m***@example.com", ip: "203.0.113.24", code: 429, label: "Limited" },
    { who: "k***@example.org", ip: "198.51.100.7", code: 422, label: "Invalid email" },
    { who: "j***@example.net", ip: "192.0.2.61", code: 201, label: "Created" },
  ],
  toast: "Reloaded: src/routes/signup.ts changed",
} as const;

/* ------------------------------------------------------------------ dashboard extras */

export const RUNTIME = [
  { label: "Core", value: "Running", sub: "For 4 h 20 min", tone: "live" },
  { label: "Local database", value: "Healthy", sub: "Schema 1, 13 events", tone: "success" },
  { label: "Credential store", value: "Not checked yet", sub: "", tone: "idle" },
  { label: "Build", value: "0.1.0, development", sub: "", tone: "" },
] as const;

export const TERMINALS = [
  { name: "PowerShell 7", workspace: "atlas-api", age: "47 min" },
  { name: "Git Bash", workspace: "atlas-api", age: "19 min" },
] as const;

/* ------------------------------------------------------------------ KalVoice */

/**
 * KalVoice's single push-to-talk key (site-wide constant). One gesture (hold, speak, release)
 * either types the words into the focused pane or, when KalVoice recognises a command, runs it.
 * No chords.
 */
export const PUSH_TO_TALK_KEY: string = KALVOICE.pushToTalkKey;

export const VOICE = {
  key: PUSH_TO_TALK_KEY,
  hint: `Hold ${PUSH_TO_TALK_KEY} to talk to KalVoice`,
  commandResult: "Command · Open two more agents",
  /** Short result shown when the command has run. */
  spawnedResult: "Opened 2 agents",
  dictation: "also cover the 429 response in the signup test",
  command: "Open two more agents",
  /** Threads the command creates, in order. */
  spawns: ["claude-e2e", "codex-review"],
  /** Baked microphone amplitudes (0–1), sampled every 40 ms. Deterministic: no microphone is used. */
  amplitudes: [
    0.08, 0.12, 0.3, 0.52, 0.61, 0.48, 0.66, 0.74, 0.58, 0.41, 0.55, 0.7, 0.82, 0.64, 0.45, 0.3, 0.22, 0.38, 0.57, 0.69,
    0.77, 0.6, 0.52, 0.66, 0.71, 0.49, 0.33, 0.18, 0.12, 0.26, 0.47, 0.63, 0.8, 0.72, 0.55, 0.61, 0.68, 0.5, 0.36, 0.28,
    0.44, 0.59, 0.73, 0.65, 0.47, 0.31, 0.2, 0.14, 0.1, 0.07,
  ] as const,
} as const;

/* ------------------------------------------------------------------ mission (planned) */

export const MISSION = {
  objective: "Build, review, test and verify the signup limit",
  nodes: [
    { id: "build", label: "Build", who: "Claude Code", detail: "Cover 429 in the e2e suite" },
    { id: "review", label: "Review", who: "Codex", detail: "Review the signup limit" },
    { id: "test", label: "Test", who: "PowerShell 7", detail: "pnpm test && pnpm test:e2e" },
    { id: "verify", label: "Verify", who: "KalCode", detail: "3 checks passed" },
  ],
  checks: ["Typecheck clean", "Unit 220 of 220", "E2E 18 of 18"],
} as const;

/* ------------------------------------------------------------------ scenes */

export type DockTab = "none" | "threads" | "browser" | "dashboard" | "permissions";
/**
 * The KalVoice widget's states, as in the app: compact "Ready"; Listening (orb and waveform react);
 * Processing; Executing; Needs Approval; Done (dictation typed, or a command's result); Error.
 * `spawned` is Done after the "Open two more agents" command.
 */
export type VoiceState = "off" | "listening" | "processing" | "executing" | "approval" | "done" | "spawned" | "error";

export interface Scene {
  view: "code" | "dashboard";
  /** Open panes, in grid order (at most 4). */
  panes: readonly string[];
  focus: string;
  layout: "rows" | "cols";
  dock: DockTab;
  approval: ApprovalState;
  voice: VoiceState;
  /** 0 hidden; 1–4 nodes lit; 5 verified. */
  mission: number;
  mode: PermissionMode;
}

export const BASE_SCENE: Scene = {
  view: "code",
  panes: ["claude-checkout", "codex-signup"],
  focus: "claude-checkout",
  layout: "rows",
  dock: "browser",
  approval: "none",
  voice: "off",
  mission: 0,
  mode: "approve",
};

/** The finished window: what no-JS and reduced-motion visitors see in the hero. */
export const FINAL_SCENE: Scene = {
  ...BASE_SCENE,
  dock: "dashboard",
  approval: "approved",
};

export interface StoryStep {
  id: string;
  title: string;
  line: string;
  tag: string;
  /** The tag once a Stable release is served ("{version}" is its version); see lib/stage-status.ts. */
  stableTag?: string;
  /** The description once a Stable release is served (no Gemini CLI thread is drawn then). */
  stableDescribe?: string;
  /** Screen-reader description of what the stage shows at this step. */
  describe: string;
  scene: Partial<Scene>;
  /** A scripted sequence played when the step is entered while scrolling down. */
  play?: "reveal" | "approve" | "dictate" | "command" | "mission";
  /** The part of the window shown as a still on phones and with reduced motion. */
  still: "shell" | "claude" | "codex" | "browser" | "dashboard" | "approval" | "voice" | "threads" | "mission";
}

export const STORY: readonly StoryStep[] = [
  {
    id: "shell",
    title: "One workspace for the whole project.",
    line: "Open a folder. Real terminals start inside it.",
    tag: "Development build",
    stableTag: "In Stable {version}",
    describe: "The KalCode window opens on the atlas-api workspace with a PowerShell terminal running the dev server.",
    scene: { panes: ["shell"], focus: "shell", dock: "none", approval: "none", voice: "off", mission: 0 },
    play: "reveal",
    still: "shell",
  },
  {
    id: "claude",
    title: "Claude Code, in a real workspace.",
    line: "Your own sign-in. Your own terminal.",
    tag: "Preview",
    stableTag: "In Stable {version} as threads and terminals · provider panes not yet",
    describe: "A Claude Code pane reads the flaky test, edits reserve.ts with a four-line diff and runs the suite.",
    scene: {
      panes: ["claude-checkout"],
      focus: "claude-checkout",
      dock: "none",
      approval: "none",
      voice: "off",
      mission: 0,
    },
    play: "reveal",
    still: "claude",
  },
  {
    id: "codex",
    title: "Add Codex without leaving the window.",
    line: "Split, stack, keep both in view.",
    tag: "Preview · provider panes not in Stable yet",
    describe: "The window splits. A Codex pane below edits the signup route to validate input.",
    scene: {
      panes: ["claude-checkout", "codex-signup"],
      focus: "codex-signup",
      layout: "rows",
      dock: "none",
      approval: "none",
      voice: "off",
      mission: 0,
    },
    play: "reveal",
    still: "codex",
  },
  {
    id: "browser",
    title: "Check the result where the code is.",
    line: "A localhost preview docks beside the agents.",
    tag: "Preview",
    stableTag: "Browser pane in Stable {version} · provider panes not yet",
    describe: "A browser docks on the right showing localhost:3000 with the signup limits page of the sample app.",
    scene: { panes: ["claude-checkout", "codex-signup"], dock: "browser", approval: "none", voice: "off", mission: 0 },
    still: "browser",
  },
  {
    id: "dashboard",
    title: "See every thread at once.",
    line: "Status comes from runtime events, not from what a model says.",
    tag: "Development build · sample data",
    stableTag: "In Stable {version} · sample data",
    describe:
      "The dock switches to the Dashboard: Claude Code working, Codex reviewing, Gemini CLI thinking, and a Claude Code thread that needs approval.",
    stableDescribe:
      "The dock switches to the Dashboard: Claude Code working, Codex reviewing and researching, and a Claude Code thread that needs approval.",
    scene: {
      panes: ["claude-checkout", "codex-signup"],
      dock: "dashboard",
      approval: "none",
      voice: "off",
      mission: 0,
    },
    still: "dashboard",
  },
  {
    id: "approval",
    title: "Approve every action that matters.",
    line: "Nothing leaves your rules without asking.",
    tag: "Development build · sample data",
    stableTag: "In Stable {version} · sample data",
    describe:
      "Codex asks to run pnpm add zod. The approval card offers Deny, Allow for thread and Approve once; Approve once is chosen and Codex continues.",
    scene: {
      panes: ["claude-checkout", "codex-signup"],
      dock: "dashboard",
      approval: "pending",
      voice: "off",
      mission: 0,
    },
    play: "approve",
    still: "approval",
  },
  {
    id: "voice",
    title: "Speak your prompts.",
    line: `Hold ${PUSH_TO_TALK_KEY}, talk, release. The words land in the focused agent.`,
    tag: "Preview · in development",
    stableTag: "In Stable {version}",
    describe:
      "The KalVoice panel listens, transcribes on the device, and types “also cover the 429 response in the signup test” into Claude Code.",
    scene: {
      panes: ["claude-checkout", "codex-signup"],
      focus: "claude-checkout",
      dock: "dashboard",
      approval: "approved",
      voice: "done",
      mission: 0,
    },
    play: "dictate",
    still: "voice",
  },
  {
    id: "command",
    title: "Say what you need. Agents appear.",
    line: `Same key. Hold ${PUSH_TO_TALK_KEY}, say “Open two more agents”, and KalCode runs the command.`,
    tag: "Preview · in development",
    stableTag: "Preview · creating agents by voice is not in Stable yet",
    describe:
      "A KalVoice command opens two more threads: Claude Code covering the 429 in the e2e suite, and Codex reviewing the change.",
    scene: {
      panes: ["claude-checkout", "codex-signup", "claude-e2e", "codex-review"],
      focus: "claude-e2e",
      dock: "dashboard",
      approval: "approved",
      voice: "spawned",
      mission: 0,
    },
    play: "command",
    still: "threads",
  },
  {
    id: "mission",
    title: "Hand over the whole objective.",
    line: "Build, review, test and verify, as steps you can check.",
    tag: "Planned",
    describe: "A mission runs Build, Review, Test and Verify across the panes. Verification passes: 3 checks passed.",
    scene: {
      panes: ["claude-checkout", "codex-signup", "claude-e2e", "codex-review"],
      focus: "claude-e2e",
      dock: "dashboard",
      approval: "approved",
      voice: "off",
      mission: 5,
    },
    play: "mission",
    still: "mission",
  },
];

/* ------------------------------------------------------------------ demo center */

export interface DemoTab {
  id: string;
  label: string;
  title: string;
  line: string;
  tag: string;
  /** The tag once a Stable release is served ("{version}" is its version); see lib/stage-status.ts. */
  stableTag?: string;
  /** The line once a Stable release is served (no Gemini CLI thread is drawn then). */
  stableLine?: string;
  scene: Partial<Scene>;
  play?: StoryStep["play"];
}

export const DEMO_TABS: readonly DemoTab[] = [
  {
    id: "multi-agent",
    label: "Multi-agent",
    title: "Four agents, one window.",
    line: "Claude Code, Codex and Gemini CLI work at the same time, and a mission ties them to one objective.",
    stableLine: "Claude Code and Codex work at the same time, and a mission ties them to one objective.",
    tag: "Preview · missions and provider panes are not in Stable yet",
    scene: {
      view: "code",
      panes: ["claude-checkout", "codex-signup", "gemini-research", "claude-e2e"],
      focus: "claude-checkout",
      dock: "none",
      approval: "approved",
      voice: "off",
      mission: 5,
    },
    play: "mission",
  },
  {
    id: "kalvoice",
    label: "KalVoice",
    title: "Speak into the focused agent.",
    line: `Hold ${PUSH_TO_TALK_KEY}, talk, release. Say a command and KalCode runs it instead.`,
    tag: "Preview · in development",
    stableTag: "In Stable {version}",
    scene: {
      view: "code",
      panes: ["claude-checkout", "codex-signup"],
      focus: "claude-checkout",
      dock: "browser",
      approval: "approved",
      voice: "done",
      mission: 0,
    },
    play: "dictate",
  },
  {
    id: "permissions",
    label: "Permissions",
    title: "Approve every action that matters.",
    line: "Pick a mode. Anything it doesn’t cover waits for Deny, Allow for thread or Approve once.",
    tag: "Development build · sample data",
    stableTag: "In Stable {version} · sample data",
    scene: {
      view: "code",
      panes: ["codex-signup"],
      focus: "codex-signup",
      dock: "permissions",
      approval: "pending",
      voice: "off",
      mission: 0,
    },
  },
  {
    id: "dashboard",
    label: "Dashboard",
    title: "See every thread. Approve every action.",
    line: "Working, waiting and failed threads, with approvals first.",
    tag: "Development build · sample data",
    stableTag: "In Stable {version} · sample data",
    scene: {
      view: "dashboard",
      panes: ["claude-checkout", "codex-signup"],
      dock: "none",
      approval: "pending",
      voice: "off",
      mission: 0,
    },
  },
  {
    id: "code",
    label: "Code Mode",
    title: "Real terminals in your workspace.",
    line: "A PowerShell tab runs the dev server while Claude Code fixes a test, with the preview beside them.",
    tag: "Development build · sample data",
    stableTag: "In Stable {version} · sample data",
    scene: {
      view: "code",
      panes: ["shell", "claude-checkout"],
      focus: "claude-checkout",
      layout: "cols",
      dock: "browser",
      approval: "none",
      voice: "off",
      mission: 0,
    },
    play: "reveal",
  },
];

/* ------------------------------------------------------------------ before / after */

export interface LooseTerminal {
  title: string;
  provider: ProviderId;
  lines: readonly { text: string; c?: "dim" | "red" | "green" | "yellow" | "accent" }[];
  /** What is going on in this window that nobody can see from the others. */
  hidden: string;
  status: ThreadStatus;
}

export const LOOSE_TERMINALS: readonly LooseTerminal[] = [
  {
    title: "claude · atlas-api",
    provider: "claude",
    status: "running_command",
    hidden: "Running tests",
    lines: [
      { text: "> fix the flaky checkout test", c: "dim" },
      { text: "● Read(tests/checkout.spec.ts)" },
      { text: "  ⎿ Read 84 lines", c: "dim" },
      { text: "● Update(src/checkout/reserve.ts)" },
      { text: "  ⎿ 3 additions, 1 removal", c: "dim" },
      { text: "● Bash(pnpm test checkout --repeat 20)" },
      { text: "  ⎿ Running… 13 of 20 passed", c: "dim" },
      { text: "✶ Testing… (48s)", c: "accent" },
    ],
  },
  {
    title: "codex · atlas-api",
    provider: "codex",
    status: "waiting_for_permission",
    hidden: "Waiting for a yes nobody sees",
    lines: [
      { text: "› validate the signup payload", c: "dim" },
      { text: "• Explored" },
      { text: "  └ Read src/routes/signup.ts", c: "dim" },
      { text: "• Edited src/routes/signup.ts (+12 -3)" },
      { text: "• zod isn’t installed yet." },
      { text: "Run pnpm add zod? [y/N]", c: "yellow" },
      { text: "  waiting for input…", c: "dim" },
    ],
  },
  {
    title: "gemini · atlas-api",
    provider: "gemini",
    status: "thinking",
    hidden: "Researching",
    lines: [
      { text: "> compare rate-limit approaches", c: "dim" },
      { text: "✓ ReadFile src/routes/signup.ts", c: "green" },
      { text: "✓ SearchText 'rateLimit' in src/**", c: "green" },
      { text: "✓ Shell redis-cli INFO keyspace", c: "green" },
      { text: "✦ A sliding window in Redis fits best." },
      { text: "⠋ Weighing a fixed window… (12s)", c: "accent" },
    ],
  },
  {
    title: "pwsh · atlas-api",
    provider: "shell",
    status: "running_command",
    hidden: "Dev server",
    lines: [
      { text: "PS> pnpm dev", c: "dim" },
      { text: "> tsx watch src/server.ts", c: "dim" },
      { text: "ready  Listening on :3000", c: "green" },
      { text: "watch  signup.ts changed, restarting", c: "dim" },
      { text: "ready  Listening on :3000", c: "green" },
    ],
  },
  {
    title: "claude · atlas-web",
    provider: "claude",
    status: "waiting_for_permission",
    hidden: "Also waiting",
    lines: [
      { text: "> upgrade vitest and push", c: "dim" },
      { text: "● Bash(pnpm up vitest@5)" },
      { text: "  ⎿ Updated 3 packages", c: "dim" },
      { text: "● Bash(pnpm test)" },
      { text: "  ⎿ 214 passed (38 files)", c: "dim" },
      { text: "Push to origin? [y/N]", c: "yellow" },
    ],
  },
  {
    title: "codex · billing",
    provider: "codex",
    status: "failed",
    hidden: "Failed 12 minutes ago",
    lines: [
      { text: "› fix the invoice total rounding", c: "dim" },
      { text: "• Edited src/invoice.ts (+4 -2)" },
      { text: "• Ran pnpm build", c: "dim" },
      { text: "  └ error TS2322 in invoice.ts:41", c: "red" },
      { text: "■ exited with code 1", c: "red" },
    ],
  },
];

/* ------------------------------------------------------------------ helpers */

export function threadById(id: string): Thread {
  const thread = THREADS.find((t) => t.id === id);
  if (!thread) throw new Error(`Unknown stage thread: ${id}`);
  return thread;
}

/** The status a thread shows in a given approval state. */
export function statusFor(thread: Thread, approval: ApprovalState): ThreadStatus {
  return thread.statusByApproval?.[approval] ?? thread.status;
}

export function activityFor(thread: Thread, approval: ApprovalState): string {
  return thread.activityByApproval?.[approval] ?? thread.activity;
}

export function visibleIn(line: Conditional, approval: ApprovalState): boolean {
  return !line.when || line.when.includes(approval);
}

export interface Summary {
  working: number;
  approvals: number;
  reply: number;
  failed: number;
  terminals: number;
  idle: number;
}

/** Dashboard counts for the threads present in a scene (mirrors countThreads in the app). */
export function summarize(
  statuses: readonly ThreadStatus[],
  pendingApprovals: number,
  terminals: number = TERMINALS.length,
): Summary {
  const s: Summary = { working: 0, approvals: pendingApprovals, reply: 0, failed: 0, terminals, idle: 0 };
  for (const status of statuses) {
    const meta = STATUS[status];
    if (meta.group === "working") s.working += 1;
    else if (status === "waiting_for_user") s.reply += 1;
    else if (status === "failed") s.failed += 1;
    else if (meta.group === "idle") s.idle += 1;
  }
  return s;
}

/** The Dashboard's one-line lead ("1 approval needs you. 3 threads are working in atlas-api."). */
export function summaryLead(s: Summary): string {
  const parts: string[] = [];
  if (s.approvals) parts.push(`${s.approvals} ${s.approvals === 1 ? "approval needs" : "approvals need"} you`);
  if (s.reply) parts.push(`${s.reply} ${s.reply === 1 ? "thread is" : "threads are"} waiting for your reply`);
  const first = parts.length ? `${parts.join(" and ")}. ` : "Nothing needs you right now. ";
  const second = s.working
    ? `${s.working} ${s.working === 1 ? "thread is" : "threads are"} working in ${WORKSPACE.name}.`
    : "Nothing is working right now.";
  return first + second;
}

/* ------------------------------------------------------------------ round 2: large moments */

/** Panes on the multi-agent wall, in grid order (3 × 2). */
export const WALL_PANES = [
  "claude-checkout",
  "codex-signup",
  "gemini-research",
  "claude-e2e",
  "codex-review",
  "claude-runner",
] as const;

/** Command Center: six agents whose status moves on a deterministic loop. */
export interface AgentBeat {
  /** Milliseconds from the start of the loop. */
  at: number;
  agent: string;
  status: ThreadStatus;
  activity: string;
  /** New last line for the agent's live terminal thumbnail. */
  tail?: string;
  /** "ask" raises the Codex approval; "resolve" clears it. */
  approval?: "ask" | "resolve";
}

export const COMMAND_CENTER = {
  agents: ["claude-checkout", "codex-signup", "gemini-research", "claude-e2e", "codex-review", "claude-runner"],
  loopMs: 20000,
  /** Start of the loop (and the reduced-motion snapshot, together with `snapshot`). */
  start: {
    "claude-checkout": {
      status: "running_command",
      activity: "Running pnpm test checkout --repeat 20",
      tail: "● Bash(pnpm test checkout --repeat 20)",
    },
    "codex-signup": {
      status: "editing",
      activity: "Editing src/routes/signup.ts",
      tail: "• Edited src/routes/signup.ts (+12 -3)",
    },
    "gemini-research": {
      status: "thinking",
      activity: "Researching sliding-window limits",
      tail: "⠋ Weighing sliding windows…",
    },
    "claude-e2e": {
      status: "editing",
      activity: "Editing tests/e2e/signup.e2e.ts",
      tail: "● Update(tests/e2e/signup.e2e.ts)",
    },
    "codex-review": {
      status: "reviewing",
      activity: "Reviewing src/middleware/rate-limit.ts",
      tail: "• Explored src/middleware",
    },
    "claude-runner": { status: "paused", activity: "Paused after upgrading vitest", tail: "⏸ Paused by you" },
  } as Record<string, { status: ThreadStatus; activity: string; tail: string }>,
  beats: [
    {
      at: 1800,
      agent: "claude-checkout",
      status: "testing",
      activity: "13 of 20 runs passed",
      tail: "  ⎿ Running… 13 of 20 passed",
    },
    {
      at: 3200,
      agent: "codex-signup",
      status: "waiting_for_permission",
      activity: "Waiting for approval: Install zod",
      tail: "• Waiting for approval: pnpm add zod",
      approval: "ask",
    },
    {
      at: 4200,
      agent: "gemini-research",
      status: "completed",
      activity: "Recommended a sliding-window counter",
      tail: "✦ A sliding window in Redis fits best.",
    },
    {
      at: 5400,
      agent: "claude-e2e",
      status: "testing",
      activity: "Running the signup e2e suite",
      tail: "● Bash(pnpm test:e2e -- signup)",
    },
    {
      at: 6600,
      agent: "codex-review",
      status: "waiting_for_user",
      activity: "Asked whether /login shares the budget",
      tail: "• Should /login share the signup budget?",
    },
    {
      at: 8200,
      agent: "claude-checkout",
      status: "completed",
      activity: "20 of 20 runs passed",
      tail: "  ⎿ 20 of 20 passed",
    },
    {
      at: 9800,
      agent: "claude-runner",
      status: "running_command",
      activity: "Resumed: running pnpm test",
      tail: "● Bash(pnpm test)",
    },
    {
      at: 11400,
      agent: "codex-review",
      status: "reviewing",
      activity: "Separate budgets per route",
      tail: "• Keying the window by route and IP",
    },
    {
      at: 13000,
      agent: "claude-e2e",
      status: "completed",
      activity: "6th signup in a minute gets 429",
      tail: "  ⎿ 18 passed",
    },
    {
      at: 14600,
      agent: "claude-runner",
      status: "completed",
      activity: "214 passed (38 files)",
      tail: "  ⎿ 214 passed (38 files)",
    },
    {
      at: 16200,
      agent: "codex-review",
      status: "completed",
      activity: "Review posted: 2 suggestions",
      tail: "─ Worked for 2m 14s ─",
    },
  ] as readonly AgentBeat[],
  /** After an approval: what Codex does next, relative to the decision. */
  afterApproval: [
    {
      at: 400,
      agent: "codex-signup",
      status: "running_command",
      activity: "Running pnpm add zod",
      tail: "• Ran pnpm add zod",
    },
    {
      at: 2200,
      agent: "codex-signup",
      status: "testing",
      activity: "Running pnpm test -- signup",
      tail: "  └ PASS tests/signup.spec.ts",
    },
    {
      at: 4400,
      agent: "codex-signup",
      status: "completed",
      activity: "Bad input now gets a 422",
      tail: "─ Worked for 1m 08s ─",
    },
  ] as readonly Omit<AgentBeat, "approval">[],
  /** Seconds to wait for a visitor's decision before the preview answers Approve once itself. */
  autoApproveMs: 6000,
  /** Sample KPI baselines (labelled sample data on the page). */
  completedToday: 11,
  /** Agent actions per hour over the last 24 hours (tool calls and commands). */
  activity: [14, 9, 6, 4, 3, 5, 12, 26, 41, 58, 63, 55, 61, 70, 66, 74, 88, 92, 79, 64, 52, 47, 58, 71] as const,
  /** Recent activity at the start of the loop, newest first. */
  feed: [
    { agent: "gemini-research", text: "compared three limiter designs", ago: "1 min" },
    { agent: "claude-checkout", text: "awaited the stock write in reserve.ts", ago: "3 min" },
    { agent: "codex-signup", text: "edited src/routes/signup.ts (+12 -3)", ago: "4 min" },
    { agent: "claude-runner", text: "was paused by you", ago: "9 min" },
    { agent: "codex-review", text: "started reviewing the rate-limit middleware", ago: "12 min" },
  ],
} as const;

/** Mission graph (planned surface): a planner fans work out to agents, the results converge through review and tests, and the deploy waits for you. */
export interface MissionNode {
  id: string;
  kind: "objective" | "agent" | "verify";
  role: string;
  who: string;
  provider?: ProviderId;
  detail: string;
  /** Position in the 1200 × 560 graph box. */
  x: number;
  y: number;
  /** Status while working (the app's labels). */
  working: ThreadStatus;
  /** How the node ends: completed, or held for your approval (production deploys always ask). */
  end?: "approval";
}

export const MISSION_GRAPH = {
  objective: "Build a user authentication system with tests",
  nodes: [
    {
      id: "planner",
      kind: "objective",
      role: "Planner",
      who: "KalCode",
      detail: "Breaks the goal into steps",
      x: 112,
      y: 280,
      working: "thinking",
    },
    {
      id: "research",
      kind: "agent",
      role: "Research",
      who: "Gemini CLI",
      provider: "gemini",
      detail: "Session vs stateless auth",
      x: 382,
      y: 100,
      working: "thinking",
    },
    {
      id: "coder",
      kind: "agent",
      role: "Coder",
      who: "Claude Code",
      provider: "claude",
      detail: "Sign-up, sign-in, sessions",
      x: 382,
      y: 280,
      working: "editing",
    },
    {
      id: "frontend",
      kind: "agent",
      role: "Frontend",
      who: "Codex",
      provider: "codex",
      detail: "Login and reset forms",
      x: 382,
      y: 460,
      working: "editing",
    },
    {
      id: "reviewer",
      kind: "agent",
      role: "Reviewer",
      who: "Codex",
      provider: "codex",
      detail: "Security and edge cases",
      x: 646,
      y: 280,
      working: "reviewing",
    },
    {
      id: "tester",
      kind: "agent",
      role: "Tester",
      who: "PowerShell 7",
      provider: "shell",
      detail: "pnpm test && pnpm test:e2e",
      x: 866,
      y: 280,
      working: "testing",
    },
    {
      id: "deployer",
      kind: "verify",
      role: "Deployer",
      who: "KalCode",
      detail: "Deploy to production",
      x: 1086,
      y: 280,
      working: "running_command",
      end: "approval",
    },
  ] as readonly MissionNode[],
  edges: [
    ["planner", "research"],
    ["planner", "coder"],
    ["planner", "frontend"],
    ["research", "coder"],
    ["coder", "reviewer"],
    ["frontend", "reviewer"],
    ["reviewer", "tester"],
    ["tester", "deployer"],
  ] as readonly (readonly [string, string])[],
  /** When each node starts and completes (ms from the start of the run). */
  schedule: {
    planner: [0, 600],
    research: [700, 1900],
    coder: [700, 3100],
    frontend: [700, 2700],
    reviewer: [3200, 4400],
    tester: [4500, 5600],
    deployer: [5700, 6300],
  } as Record<string, readonly [number, number]>,
  checks: ["Typecheck clean", "Unit 64 of 64", "E2E 12 of 12"],
} as const;

/** Time machine (planned): a thread's run as a scrollable timeline of checkpoints. */
export const TIMELINE = {
  thread: "Validate signup input",
  provider: "codex" as ProviderId,
  events: [
    { t: "0:00", kind: "prompt", label: "Prompt", detail: "validate the signup payload and return 422 on bad input" },
    { t: "0:06", kind: "read", label: "Explored", detail: "src/routes/signup.ts, src/lib/errors.ts" },
    { t: "0:21", kind: "edit", label: "Edited", detail: "src/routes/signup.ts (+12 -3)" },
    { t: "0:34", kind: "approval", label: "Approval", detail: "pnpm add zod · Approve once" },
    { t: "0:41", kind: "run", label: "Ran", detail: "pnpm add zod · + zod 4.1.0" },
    { t: "0:58", kind: "run", label: "Ran", detail: "pnpm test -- signup · 6 passed" },
    { t: "1:08", kind: "done", label: "Completed", detail: "Bad input now gets a 422 with a list of fields" },
  ],
} as const;

/* ------------------------------------------------------------------ round 3: workspace composition */

export interface TreeNode {
  name: string;
  depth: number;
  kind: "dir" | "file";
  /** Git status letter shown beside the file. */
  git?: "M" | "A";
  /** The file a pane is working in. */
  active?: boolean;
}

/** Explorer for the workspace composition (the file tree is a planned surface). */
export const FILE_TREE: readonly TreeNode[] = [
  { name: "atlas-api", depth: 0, kind: "dir" },
  { name: "src", depth: 1, kind: "dir" },
  { name: "checkout", depth: 2, kind: "dir" },
  { name: "reserve.ts", depth: 3, kind: "file", git: "M", active: true },
  { name: "middleware", depth: 2, kind: "dir" },
  { name: "rate-limit.ts", depth: 3, kind: "file", git: "A" },
  { name: "routes", depth: 2, kind: "dir" },
  { name: "signup.ts", depth: 3, kind: "file", git: "M" },
  { name: "lib", depth: 2, kind: "dir" },
  { name: "errors.ts", depth: 3, kind: "file" },
  { name: "redis.ts", depth: 3, kind: "file" },
  { name: "tests", depth: 1, kind: "dir" },
  { name: "checkout.spec.ts", depth: 2, kind: "file" },
  { name: "signup.spec.ts", depth: 2, kind: "file", git: "A" },
  { name: "e2e", depth: 2, kind: "dir" },
  { name: "package.json", depth: 1, kind: "file", git: "M" },
  { name: "vitest.config.ts", depth: 1, kind: "file" },
  { name: "README.md", depth: 1, kind: "file" },
];

export interface ThreadStep {
  label: string;
  state: "done" | "active" | "queued";
}

/** The Threads panel in the workspace composition: what each agent has done and is doing. */
export const WORKSPACE_THREADS: readonly { id: string; steps: readonly ThreadStep[] }[] = [
  {
    id: "claude-checkout",
    steps: [
      { label: "Read the flaky test", state: "done" },
      { label: "Awaited the stock write", state: "done" },
      { label: "Running the suite 20 times", state: "active" },
    ],
  },
  {
    id: "codex-signup",
    steps: [
      { label: "Validated the signup payload", state: "done" },
      { label: "Installed zod (approved once)", state: "done" },
      { label: "Reviewing the passing suite", state: "active" },
    ],
  },
  {
    id: "gemini-research",
    steps: [
      { label: "Read the signup route", state: "done" },
      { label: "Compared limiter designs", state: "active" },
      { label: "Write up a recommendation", state: "queued" },
    ],
  },
];

/* ------------------------------------------------------------------ round 3: KalVoice flow */

export interface VoiceFlowStep {
  id: string;
  label: string;
  detail: string;
  provider?: ProviderId;
  /** The app status shown while the step runs; completed steps show Completed. */
  status: ThreadStatus;
  /** How long the step runs (ms) before the next begins. */
  ms: number;
}

/** One spoken command becoming coordinated work: the KalVoice stage's script. */
export const VOICE_FLOW = {
  phrase: "Build a user authentication system with tests.",
  steps: [
    { id: "planning", label: "Planning", detail: "Three steps across two agents", status: "thinking", ms: 1100 },
    {
      id: "implementing",
      label: "Claude Code implementing",
      detail: "src/auth/session.ts, src/auth/routes.ts",
      provider: "claude",
      status: "editing",
      ms: 1700,
    },
    {
      id: "reviewing",
      label: "Codex reviewing",
      detail: "Password hashing, session expiry, rate limits",
      provider: "codex",
      status: "reviewing",
      ms: 1400,
    },
    {
      id: "testing",
      label: "Tests passing",
      detail: "Unit 64 of 64 · E2E 12 of 12",
      provider: "shell",
      status: "testing",
      ms: 1400,
    },
  ] as readonly VoiceFlowStep[],
  done: "Done · ready for your review",
  /** Minimum listening time for a scripted take (ms). */
  listenMs: 2200,
} as const;
