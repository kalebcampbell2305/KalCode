// Shared helpers for the trusted operator tools in tooling/admin/.
//
// These tools are the ONLY way to create or revoke an OWNER entitlement. They talk to the API's
// D1 database through `wrangler d1 execute`, which authenticates with the operator's own
// Cloudflare credentials — trusted backend access that no KalCode client or HTTP request has.
// Nothing here is reachable from the Worker. See docs/BILLING.md §5.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const API_DIR = fileURLToPath(new URL("../../apps/api/", import.meta.url));
export const DATABASE_NAME = "kalcode-api";

const ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
// Deliberately strict: no quotes, spaces or control characters can reach the SQL text.
const EMAIL =
  /^[A-Za-z0-9.!#$%&*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const OPERATOR = /^[A-Za-z0-9][A-Za-z0-9 ._@:+-]{0,199}$/;
// Printable text only (any script), no control characters.
const REASON = /^[^\p{Cc}\p{Cf}]{1,500}$/u;

export class UsageError extends Error {}

/** A SQL string literal. Callers only pass values that already passed the patterns above. */
export function sqlString(value) {
  if (typeof value !== "string" || value.includes("\u0000")) throw new UsageError("invalid SQL value");
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Parses the common arguments. Exactly one of --account / --email, exactly one of --local /
 * --remote, and a --reason are required. Returns a validated options object.
 */
export function parseOperatorArgs(argv, { action }) {
  const { values } = parseArgs({
    args: argv,
    options: {
      account: { type: "string" },
      email: { type: "string" },
      reason: { type: "string" },
      operator: { type: "string" },
      local: { type: "boolean", default: false },
      remote: { type: "boolean", default: false },
      "persist-to": { type: "string" },
      confirm: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) return { help: true };

  if (Boolean(values.account) === Boolean(values.email)) {
    throw new UsageError("Pass exactly one of --account <id> or --email <verified email>.");
  }
  if (values.account !== undefined && !ACCOUNT_ID.test(values.account)) {
    throw new UsageError("--account must be an account id (letters, digits, hyphens; at most 64).");
  }
  if (values.email !== undefined && (values.email.length > 254 || !EMAIL.test(values.email))) {
    throw new UsageError("--email is not a valid email address.");
  }
  if (values.local === values.remote) {
    throw new UsageError("Pass exactly one of --local (local development database) or --remote (production).");
  }
  if (values["persist-to"] !== undefined && !values.local) {
    throw new UsageError("--persist-to is only valid with --local.");
  }
  const reason = values.reason?.trim();
  if (!reason || !REASON.test(reason)) {
    throw new UsageError(`--reason is required: why this ${action} is being made (1–500 printable characters).`);
  }
  const operator = values.operator?.trim() || `operator:${userInfo().username}`;
  if (!OPERATOR.test(operator)) {
    throw new UsageError("--operator must be 1–200 characters of letters, digits, space and . _ @ : + -");
  }
  return {
    help: false,
    account: values.account,
    email: values.email,
    reason,
    operator,
    remote: values.remote,
    persistTo: values["persist-to"],
    confirm: values.confirm,
  };
}

function wranglerBin() {
  const require = createRequire(join(API_DIR, "package.json"));
  return join(dirname(require.resolve("wrangler/package.json")), "bin", "wrangler.js");
}

/**
 * Runs SQL through `wrangler d1 execute --json` and returns the result sets. No shell is
 * involved: arguments go straight to the Node process running wrangler.
 */
export function d1(options, sql) {
  const args = [wranglerBin(), "d1", "execute", DATABASE_NAME, options.remote ? "--remote" : "--local", "--json"];
  if (options.persistTo) args.push("--persist-to", options.persistTo);
  args.push("--command", sql);
  let stdout;
  try {
    stdout = execFileSync(process.execPath, args, {
      cwd: API_DIR,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    });
  } catch (error) {
    const detail = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim();
    throw new Error(`wrangler d1 execute failed:\n${detail || error.message}`);
  }
  const start = stdout.indexOf("[");
  if (start === -1) throw new Error(`Unexpected wrangler output:\n${stdout}`);
  const sets = JSON.parse(stdout.slice(start));
  for (const set of sets) {
    if (!set.success) throw new Error(`D1 statement failed: ${JSON.stringify(set)}`);
  }
  return sets.map((set) => set.results ?? []);
}

/** Resolves the target account. Accounts are created only by sign-in with a verified email. */
export function findAccount(options) {
  const where = options.account ? `id = ${sqlString(options.account)}` : `email = ${sqlString(options.email)}`;
  const [rows] = d1(options, `SELECT id, email, email_verified_at, created_at FROM accounts WHERE ${where}`);
  const account = rows?.[0];
  if (!account) {
    const who = options.account ? `id ${options.account}` : `email ${options.email}`;
    throw new UsageError(
      `No KalCode account with ${who}. Accounts are created when someone signs in with a verified email ` +
        "(campaign Z13); sign in once, then run this again.",
    );
  }
  return account;
}

export function activeGrants(options, accountId) {
  const [rows] = d1(
    options,
    "SELECT id, tier, source, granted_by, reason, granted_at, expires_at FROM entitlement_grants " +
      `WHERE account_id = ${sqlString(accountId)} AND revoked_at IS NULL ORDER BY id`,
  );
  return rows ?? [];
}

export function recentAudit(options, accountId, limit = 5) {
  const [rows] = d1(
    options,
    "SELECT id, occurred_at, actor, action, details FROM audit_log " +
      `WHERE account_id = ${sqlString(accountId)} ORDER BY id DESC LIMIT ${Number(limit)}`,
  );
  return rows ?? [];
}

export function describeTarget(options) {
  return options.remote ? "PRODUCTION (remote D1)" : `local D1${options.persistTo ? ` at ${options.persistTo}` : ""}`;
}

/** Runs a tool's main function with uniform error handling and exit codes. */
export function run(main) {
  try {
    process.exitCode = main(process.argv.slice(2)) ?? 0;
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`error: ${error.message}`);
      process.exitCode = 64;
    } else {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}

/** Exit code when the operator did not pass --confirm (nothing was changed). */
export const EXIT_NEEDS_CONFIRM = 2;
