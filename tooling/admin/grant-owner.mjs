#!/usr/bin/env node
// Grants the private, non-billable OWNER entitlement to one existing KalCode account.
//
// Trusted operator tool: it writes to the API's D1 database with the operator's own Cloudflare
// credentials (`wrangler d1 execute`). There is no HTTP endpoint that can do this. The database
// itself guarantees OWNER comes only from an operator grant, never expires, is unique per
// account, and that the grant and its audit_log row are written in one statement.
//
// Usage:
//   node tooling/admin/grant-owner.mjs (--account <id> | --email <verified email>)
//        --reason "<why>" (--local [--persist-to <dir>] | --remote) [--operator <name>] --confirm
//
// Without --confirm it only shows what it would do (exit code 2). See docs/BILLING.md §5.
import {
  activeGrants,
  d1,
  describeTarget,
  EXIT_NEEDS_CONFIRM,
  findAccount,
  parseOperatorArgs,
  recentAudit,
  run,
  sqlString,
} from "./lib.mjs";

const HELP = `Grant the OWNER entitlement to an existing account.

  --account <id> | --email <addr>   target account (the email must belong to a signed-up account)
  --reason <text>                   why (stored in the grant and the audit log)
  --local [--persist-to <dir>]      local development database
  --remote                          production database (uses your Cloudflare login)
  --operator <name>                 recorded as granted_by (default: operator:<os user>)
  --confirm                         actually write; without it nothing changes`;

run((argv) => {
  const options = parseOperatorArgs(argv, { action: "grant" });
  if (options.help) {
    console.log(HELP);
    return 0;
  }
  const account = findAccount(options);
  const grants = activeGrants(options, account.id);
  console.log(`Target:  ${describeTarget(options)}`);
  console.log(`Account: ${account.id} <${account.email}> (verified ${account.email_verified_at})`);
  console.log(
    `Active grants: ${grants.length ? grants.map((g) => `${g.tier}/${g.source}#${g.id}`).join(", ") : "none (Free)"}`,
  );

  if (grants.some((grant) => grant.tier === "owner")) {
    console.log("This account already holds an active OWNER grant. Nothing to do.");
    return 0;
  }
  if (!options.confirm) {
    console.log(`\nWould grant OWNER (source 'grant', no expiry) as ${options.operator}: "${options.reason}".`);
    console.log("Nothing was changed. Re-run with --confirm to write the grant.");
    return EXIT_NEEDS_CONFIRM;
  }

  const now = new Date().toISOString();
  // One statement: the insert and its audit row (written by trigger) commit together.
  d1(
    options,
    "INSERT INTO entitlement_grants (account_id, tier, source, granted_by, reason, granted_at) " +
      `SELECT id, 'owner', 'grant', ${sqlString(options.operator)}, ${sqlString(options.reason)}, ${sqlString(now)} ` +
      `FROM accounts WHERE id = ${sqlString(account.id)}`,
  );

  const owner = activeGrants(options, account.id).find((grant) => grant.tier === "owner");
  if (!owner) throw new Error("The OWNER grant was not found after writing it. Nothing is confirmed.");
  const audit = recentAudit(options, account.id, 1)[0];
  console.log(`\nGranted OWNER: grant #${owner.id} at ${owner.granted_at} by ${owner.granted_by}.`);
  console.log(`Audit: #${audit?.id} ${audit?.action} ${audit?.details}`);
  console.log("The account receives an OWNER entitlement document the next time it fetches one.");
  return 0;
});
