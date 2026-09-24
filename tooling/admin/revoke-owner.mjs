#!/usr/bin/env node
// Revokes an account's active OWNER entitlement. The grant row is kept (revocation is final and
// audited by a database trigger); the account falls back to its billing plan or Free. Desktop
// copies of the old signed document stop working when that document expires (offline grace).
//
// Usage:
//   node tooling/admin/revoke-owner.mjs (--account <id> | --email <verified email>)
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

const HELP = `Revoke the OWNER entitlement of an account.

  --account <id> | --email <addr>   target account
  --reason <text>                   why (stored with the revocation and in the audit log)
  --local [--persist-to <dir>]      local development database
  --remote                          production database (uses your Cloudflare login)
  --operator <name>                 recorded as revoked_by (default: operator:<os user>)
  --confirm                         actually write; without it nothing changes`;

run((argv) => {
  const options = parseOperatorArgs(argv, { action: "revocation" });
  if (options.help) {
    console.log(HELP);
    return 0;
  }
  const account = findAccount(options);
  const owner = activeGrants(options, account.id).find((grant) => grant.tier === "owner");
  console.log(`Target:  ${describeTarget(options)}`);
  console.log(`Account: ${account.id} <${account.email}>`);

  if (!owner) {
    console.log("This account has no active OWNER grant. Nothing to do.");
    return 0;
  }
  console.log(`Active OWNER grant: #${owner.id}, granted ${owner.granted_at} by ${owner.granted_by}.`);
  if (!options.confirm) {
    console.log(`\nWould revoke grant #${owner.id} as ${options.operator}: "${options.reason}".`);
    console.log("Nothing was changed. Re-run with --confirm to revoke.");
    return EXIT_NEEDS_CONFIRM;
  }

  const now = new Date().toISOString();
  d1(
    options,
    `UPDATE entitlement_grants SET revoked_at = ${sqlString(now)}, revoked_by = ${sqlString(options.operator)}, ` +
      `revoke_reason = ${sqlString(options.reason)} ` +
      `WHERE id = ${Number(owner.id)} AND tier = 'owner' AND revoked_at IS NULL`,
  );

  if (activeGrants(options, account.id).some((grant) => grant.tier === "owner")) {
    throw new Error("The OWNER grant is still active after revoking it.");
  }
  const audit = recentAudit(options, account.id, 1)[0];
  console.log(`\nRevoked OWNER grant #${owner.id} at ${now}.`);
  console.log(`Audit: #${audit?.id} ${audit?.action} ${audit?.details}`);
  return 0;
});
