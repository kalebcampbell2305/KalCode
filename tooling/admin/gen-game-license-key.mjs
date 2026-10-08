#!/usr/bin/env node
// Generates the Ed25519 signing key for KalCode game licenses (docs/BILLING.md §13). It is a
// separate key from ENTITLEMENT_SIGNING_KEY: different purpose, different rotation, different pins.
//
// Production (the private key is never written to disk or shown; it goes straight into the secret):
//   node tooling/admin/gen-game-license-key.mjs --kid g2026-10 \
//     | pnpm --filter @kalcode/api exec wrangler secret put GAME_LICENSE_SIGNING_KEY
//   stderr prints only the PUBLIC key and the exact line to pin in the game
//   (KalGame CampusFounder/Assets/_Game/Scripts/Runtime/Licensing/LicenseKeys.cs).
//
// Local development: --dev-vars apps/api/.dev.vars appends a throwaway key (git-ignored file).
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const KEY_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const { values } = parseArgs({
  options: { kid: { type: "string" }, "dev-vars": { type: "string" } },
  strict: true,
});

const kid = values.kid ?? (values["dev-vars"] ? `gdev-${Date.now().toString(36)}` : undefined);
if (!kid || !KEY_ID.test(kid)) {
  console.error("error: --kid <id> is required (1–64 of a-z 0-9 . _ -, e.g. g2026-10).");
  process.exit(64);
}
if (!values["dev-vars"] && process.stdout.isTTY) {
  console.error("error: refusing to print a private key to a terminal. Pipe it into `wrangler secret put GAME_LICENSE_SIGNING_KEY`.");
  process.exit(64);
}

const { privateKey } = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const jwk = await crypto.subtle.exportKey("jwk", privateKey);
const secret = JSON.stringify({ kty: "OKP", crv: "Ed25519", kid, d: jwk.d, x: jwk.x });

if (values["dev-vars"]) {
  const path = resolve(values["dev-vars"]);
  let existing = "";
  try {
    existing = readFileSync(path, "utf8");
  } catch {
    // A new file.
  }
  if (/^GAME_LICENSE_SIGNING_KEY=/m.test(existing)) {
    console.error(`error: ${path} already has GAME_LICENSE_SIGNING_KEY. Remove that line to replace it.`);
    process.exit(1);
  }
  appendFileSync(path, `# Local development only. Throwaway game license key.\nGAME_LICENSE_SIGNING_KEY='${secret}'\n`, {
    mode: 0o600,
  });
  console.error(`wrote a throwaway GAME_LICENSE_SIGNING_KEY (${kid}) to ${path}`);
} else {
  process.stdout.write(secret);
}
console.error(`public key (kid ${kid}): ${jwk.x}`);
console.error(`pin in the game (LicenseKeys.cs): new LicensePublicKey("${kid}", "${jwk.x}"),`);
