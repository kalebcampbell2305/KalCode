#!/usr/bin/env node
import { execFileSync } from "node:child_process";
// Sends the ONE-TIME confirmation request to early-access addresses that joined before double
// opt-in existed (status 'legacy_unconfirmed' in the website's D1 database `kalcode-web`).
//
// Trusted operator tool. It is never run automatically and nothing in the Worker calls it. It
// talks to D1 through `wrangler d1 execute` with the operator's own Cloudflare login, and sends
// through Resend's REST API with a sending-only key the operator provides in RESEND_API_KEY
// (read from the environment only, never printed or stored).
//
// For each selected address it: reserves one email in today's site-wide budget, stores the
// SHA-256 of a fresh confirmation code and removal code (72 h), marks the row 'pending' with the
// throttle bookkeeping, and sends the legacy confirmation email. If the send fails, all of that
// is undone and the run stops. A pending row that is not confirmed within 72 h is deleted by the
// Worker's hourly cleanup, exactly as the privacy notice says.
//
// Usage (from the repository root):
//   node tooling/admin/request-legacy-confirmation.mjs (--local [--persist-to <dir>] | --remote)
//        [--limit <n>] [--transport resend|log] [--confirm]
//
// Without --confirm it only reports what it would do (exit code 2) and changes nothing.
// --transport log (local only) prints the emails, links included, instead of sending them.
// Requires Node 22.18+ (imports the site's TypeScript constants and email templates directly).
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { EARLY_ACCESS_EMAIL, EMAIL_FROM, EMAIL_REPLY_TO, SITE_ORIGIN } from "../../apps/website/src/lib/site.ts";
import { actionUrl, renderLegacyConfirmEmail } from "../../apps/website/worker/lib/emails.ts";

const WEBSITE_DIR = fileURLToPath(new URL("../../apps/website/", import.meta.url));
const DATABASE = "kalcode-web";
const RESEND_ENDPOINT = "https://api.resend.com/emails";
const EXIT_NEEDS_CONFIRM = 2;
const DEFAULT_LIMIT = 20;

class UsageError extends Error {}

const HELP = `Send the one-time confirmation request to legacy (pre-double-opt-in) early-access addresses.

  --local [--persist-to <dir>]   local development database
  --remote                       production database (uses your Cloudflare login)
  --limit <n>                    at most n addresses this run (default ${DEFAULT_LIMIT}; the site-wide
                                 daily budget of ${EARLY_ACCESS_EMAIL.dailyTotal} emails also applies)
  --transport resend|log         resend (default; needs RESEND_API_KEY in the environment) or
                                 log (local only: print instead of sending)
  --confirm                      actually write and send; without it nothing changes`;

function parse(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      local: { type: "boolean", default: false },
      remote: { type: "boolean", default: false },
      "persist-to": { type: "string" },
      limit: { type: "string" },
      transport: { type: "string", default: "resend" },
      confirm: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) return { help: true };
  if (values.local === values.remote) {
    throw new UsageError("Pass exactly one of --local (local development database) or --remote (production).");
  }
  if (values["persist-to"] !== undefined && !values.local)
    throw new UsageError("--persist-to is only valid with --local.");
  const limit = values.limit === undefined ? DEFAULT_LIMIT : Number(values.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
    throw new UsageError("--limit must be a whole number from 1 to 1000.");
  if (values.transport !== "resend" && values.transport !== "log")
    throw new UsageError("--transport must be resend or log.");
  if (values.transport === "log" && values.remote) {
    throw new UsageError(
      "--transport log is for the local database only: production addresses must really be emailed.",
    );
  }
  return {
    help: false,
    remote: values.remote,
    persistTo: values["persist-to"],
    limit,
    transport: values.transport,
    confirm: values.confirm,
  };
}

function wranglerBin() {
  const require = createRequire(join(WEBSITE_DIR, "package.json"));
  return join(dirname(require.resolve("wrangler/package.json")), "bin", "wrangler.js");
}

/** Runs SQL through `wrangler d1 execute --json` (no shell) and returns each statement's rows. */
function d1(options, sql) {
  const args = [wranglerBin(), "d1", "execute", DATABASE, options.remote ? "--remote" : "--local", "--json"];
  if (options.persistTo) args.push("--persist-to", options.persistTo);
  args.push("--command", sql);
  let stdout;
  try {
    stdout = execFileSync(process.execPath, args, {
      cwd: WEBSITE_DIR,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    });
  } catch (error) {
    const detail = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim();
    throw new Error(`wrangler d1 execute failed:\n${detail || error.message}`);
  }
  const start = stdout.indexOf("[");
  if (start === -1) throw new Error(`Unexpected wrangler output:\n${stdout}`);
  const sets = JSON.parse(stdout.slice(start));
  for (const set of sets) if (!set.success) throw new Error(`D1 statement failed: ${JSON.stringify(set)}`);
  return sets.map((set) => set.results ?? []);
}

/** SQL literals for values this script produced or read back from D1 (never raw user input). */
const sqlString = (value) => (value === null ? "NULL" : `'${String(value).replaceAll("'", "''")}'`);
const sqlInt = (value) => {
  if (!Number.isSafeInteger(value)) throw new Error("expected an integer");
  return String(value);
};

const redact = (email) => {
  const at = email.lastIndexOf("@");
  return at > 0 ? `${email[0]}•••${email.slice(at)}` : "•••";
};
const utcDay = (date) => date.toISOString().slice(0, 10);

function throttleAllows(row, now) {
  const day = utcDay(now);
  const countToday = row.email_day === day ? row.email_day_count : 0;
  const recent =
    row.last_email_at !== null &&
    now.getTime() - Date.parse(row.last_email_at) < EARLY_ACCESS_EMAIL.minIntervalMinutes * 60_000;
  return { allowed: !recent && countToday < EARLY_ACCESS_EMAIL.dailyPerAddress, nextCount: countToday + 1 };
}

async function sendEmail(options, to, message) {
  if (options.transport === "log") {
    console.log(`\n--- email to ${redact(to)}: ${message.subject}\n${message.text}\n---`);
    return true;
  }
  const response = await fetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "content-type": "application/json",
      "idempotency-key": message.idempotencyKey,
    },
    body: JSON.stringify({
      from: EMAIL_FROM,
      to: [to],
      reply_to: EMAIL_REPLY_TO,
      subject: message.subject,
      text: message.text,
      html: message.html,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  await response.body?.cancel();
  if (!response.ok) console.error(`Resend answered HTTP ${response.status} for ${redact(to)}.`);
  return response.ok;
}

async function main(argv) {
  const options = parse(argv);
  if (options.help) {
    console.log(HELP);
    return 0;
  }
  const target = options.remote
    ? "PRODUCTION (remote D1)"
    : `local D1${options.persistTo ? ` at ${options.persistTo}` : ""}`;
  const now = new Date();
  const day = utcDay(now);

  const [[{ total } = { total: 0 }]] = d1(
    options,
    "SELECT COUNT(*) AS total FROM early_access WHERE status = 'legacy_unconfirmed'",
  );
  const [rows] = d1(
    options,
    "SELECT id, email, last_email_at, email_day, email_day_count FROM early_access " +
      `WHERE status = 'legacy_unconfirmed' ORDER BY id LIMIT ${sqlInt(options.limit)}`,
  );
  const [[budgetRow]] = d1(options, `SELECT sent FROM email_send_budget WHERE day = ${sqlString(day)}`);
  const budgetLeft = Math.max(0, EARLY_ACCESS_EMAIL.dailyTotal - (budgetRow?.sent ?? 0));
  const eligible = rows.filter((row) => throttleAllows(row, now).allowed);
  const planned = eligible.slice(0, budgetLeft);

  console.log(`Target:     ${target}`);
  console.log(`Transport:  ${options.transport}`);
  console.log(`Legacy addresses (unconfirmed, joined before double opt-in): ${total}`);
  console.log(`Selected this run (--limit ${options.limit}): ${rows.length}; not throttled: ${eligible.length}`);
  console.log(`Site-wide email budget left today (${day} UTC): ${budgetLeft}`);
  console.log(
    `Would email now: ${planned.length}${planned.length ? ` (${planned.map((r) => redact(r.email)).join(", ")})` : ""}`,
  );

  if (planned.length === 0) {
    console.log("Nothing to send.");
    return 0;
  }
  if (!options.confirm) {
    console.log(
      `\nEach would get "${renderLegacyConfirmEmail({ confirmUrl: "x", removeUrl: "x", hours: 72 }).subject}" and become 'pending': ` +
        `confirmed if they press Confirm within ${EARLY_ACCESS_EMAIL.linkTtlHours} h, deleted otherwise.`,
    );
    console.log("Nothing was changed. Re-run with --confirm to write and send.");
    return EXIT_NEEDS_CONFIRM;
  }
  if (options.transport === "resend" && !process.env.RESEND_API_KEY) {
    throw new UsageError("Set RESEND_API_KEY in the environment (a sending-only key for kalcoded.com).");
  }

  const linkOrigin = options.transport === "log" ? "http://127.0.0.1:8787" : SITE_ORIGIN;
  const ttlMs = EARLY_ACCESS_EMAIL.linkTtlHours * 60 * 60 * 1000;
  let sent = 0;
  for (const row of planned) {
    const at = new Date();
    const { allowed, nextCount } = throttleAllows(row, at);
    if (!allowed) continue;
    const codes = { confirm: randomBytes(32).toString("base64url"), remove: randomBytes(32).toString("base64url") };
    const hashes = {
      confirm: createHash("sha256").update(codes.confirm).digest("hex"),
      remove: createHash("sha256").update(codes.remove).digest("hex"),
    };
    const createdAt = at.toISOString();
    const expiresAt = new Date(at.getTime() + ttlMs).toISOString();

    // Budget, links and status in one batch; the status change is conditional on the row still
    // being legacy (a concurrent sign-up or removal wins).
    d1(
      options,
      [
        `INSERT INTO email_send_budget (day, sent) VALUES (${sqlString(utcDay(at))}, 1) ON CONFLICT(day) DO UPDATE SET sent = sent + 1`,
        ...["confirm", "remove"].map(
          (purpose) =>
            "INSERT INTO early_access_tokens (token_hash, early_access_id, purpose, created_at, expires_at) VALUES " +
            `(${sqlString(hashes[purpose])}, ${sqlInt(row.id)}, '${purpose}', ${sqlString(createdAt)}, ${sqlString(expiresAt)})`,
        ),
        `UPDATE early_access SET status = 'pending', last_email_at = ${sqlString(createdAt)}, email_day = ${sqlString(utcDay(at))}, ` +
          `email_day_count = ${sqlInt(nextCount)} WHERE id = ${sqlInt(row.id)} AND status = 'legacy_unconfirmed'`,
      ].join("; "),
    );
    const [[check]] = d1(options, `SELECT status FROM early_access WHERE id = ${sqlInt(row.id)}`);

    const undo = () =>
      d1(
        options,
        [
          `DELETE FROM early_access_tokens WHERE token_hash IN (${sqlString(hashes.confirm)}, ${sqlString(hashes.remove)})`,
          `UPDATE early_access SET status = 'legacy_unconfirmed', last_email_at = ${sqlString(row.last_email_at)}, ` +
            `email_day = ${sqlString(row.email_day)}, email_day_count = ${sqlInt(row.email_day_count)} ` +
            `WHERE id = ${sqlInt(row.id)} AND last_email_at = ${sqlString(createdAt)}`,
          `UPDATE email_send_budget SET sent = sent - 1 WHERE day = ${sqlString(utcDay(at))} AND sent > 0`,
        ].join("; "),
      );

    if (check?.status !== "pending") {
      // Removed or confirmed meanwhile: give back what was written and move on.
      undo();
      continue;
    }
    const message = {
      ...renderLegacyConfirmEmail({
        confirmUrl: actionUrl(linkOrigin, EARLY_ACCESS_EMAIL.confirmPath, codes.confirm),
        removeUrl: actionUrl(linkOrigin, EARLY_ACCESS_EMAIL.removePath, codes.remove),
        hours: EARLY_ACCESS_EMAIL.linkTtlHours,
      }),
      idempotencyKey: `legacy-confirm-${hashes.confirm.slice(0, 32)}`,
    };
    let ok = false;
    try {
      ok = await sendEmail(options, row.email, message);
    } catch (error) {
      console.error(`Sending to ${redact(row.email)} failed: ${error instanceof Error ? error.name : "error"}.`);
    }
    if (!ok) {
      undo();
      console.error(`Stopped after ${sent} sent. ${redact(row.email)} was restored to legacy_unconfirmed.`);
      return 1;
    }
    sent += 1;
    console.log(`Sent to ${redact(row.email)}.`);
  }
  console.log(
    `\nDone: ${sent} confirmation request(s) sent. Unconfirmed addresses are deleted after ${EARLY_ACCESS_EMAIL.linkTtlHours} h.`,
  );
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(
      error instanceof UsageError ? `error: ${error.message}` : error instanceof Error ? error.message : String(error),
    );
    process.exitCode = error instanceof UsageError ? 64 : 1;
  },
);
