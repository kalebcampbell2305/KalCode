#!/usr/bin/env node
// Generates an Ed25519 entitlement signing key (docs/BILLING.md §6).
//
// Production (never written to disk; piped straight into the Worker secret):
//   node tooling/admin/gen-signing-key.mjs --kid k2026-10 --stdout \
//     | pnpm --filter @kalcode/api exec wrangler secret put ENTITLEMENT_SIGNING_KEY
//   The public key (for crates/entitlements/src/keys.rs) is printed to stderr.
//
// Local development (a throwaway key in the git-ignored apps/api/.dev.vars):
//   pnpm --filter @kalcode/api keys:dev
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const KEY_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const { values } = parseArgs({
  options: {
    kid: { type: "string" },
    stdout: { type: "boolean", default: false },
    "dev-vars": { type: "string" },
    force: { type: "boolean", default: false },
  },
  strict: true,
});

const kid = values.kid ?? (values["dev-vars"] ? `dev-${Date.now().toString(36)}` : undefined);
if (!kid || !KEY_ID.test(kid)) {
  console.error("error: --kid <id> is required (1–64 of a-z 0-9 . _ -, e.g. k2026-10).");
  process.exit(64);
}
if (values.stdout === Boolean(values["dev-vars"])) {
  console.error("error: pass exactly one of --stdout (pipe into `wrangler secret put`) or --dev-vars <file>.");
  process.exit(64);
}
if (values.stdout && process.stdout.isTTY) {
  console.error("error: refusing to print a private key to a terminal. Pipe it into `wrangler secret put`.");
  process.exit(64);
}

const { privateKey, publicKey } = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const priv = await crypto.subtle.exportKey("jwk", privateKey);
const pub = await crypto.subtle.exportKey("jwk", publicKey);
const secret = JSON.stringify({ kty: "OKP", crv: "Ed25519", kid, d: priv.d, x: priv.x });

if (values.stdout) {
  process.stdout.write(secret);
} else {
  const path = resolve(values["dev-vars"]);
  if (existsSync(path) && !values.force) {
    console.error(`error: ${path} exists. Pass --force to replace it (the old dev key stops verifying).`);
    process.exit(1);
  }
  writeFileSync(
    path,
    `# Local development only. Throwaway key; never use it anywhere else.\nENTITLEMENT_SIGNING_KEY='${secret}'\n`,
    {
      mode: 0o600,
    },
  );
  console.error(`Wrote a throwaway development signing key to ${path}.`);
}

console.error(`Public key — kid: ${kid}  x: ${pub.x}`);
console.error(`crates/entitlements/src/keys.rs entry: TrustedKey { kid: "${kid}", x: "${pub.x}" },`);
