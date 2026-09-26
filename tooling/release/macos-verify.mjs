#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { MacReleaseError } from "./macos-contract.mjs";
import { verifyMacRelease } from "./macos-verify-lib.mjs";

function fail(error) {
  const code = error instanceof MacReleaseError ? error.code : "verification_failed";
  const message = error instanceof Error ? error.message : "macOS release verification failed.";
  console.error(`macos-verify [${code}]: ${message}`);
  process.exitCode = 1;
}

function parseArgs(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!["--artifact", "--record", "--output"].includes(name) || !value || value.startsWith("--")) {
      throw new MacReleaseError(
        "invalid_arguments",
        "Usage: node tooling/release/macos-verify.mjs --artifact <dmg> --record <json> [--output <json>]",
      );
    }
    result[name.slice(2)] = value;
  }
  if (!result.artifact || !result.record) {
    throw new MacReleaseError("invalid_arguments", "Both --artifact and --record are required.");
  }
  return result;
}

export async function main(args = process.argv.slice(2), env = process.env) {
  if (process.platform !== "darwin") {
    throw new MacReleaseError("wrong_platform", "Production macOS verification must run on macOS.");
  }
  const options = parseArgs(args);
  const recordPath = resolve(options.record);
  if (!existsSync(recordPath)) throw new MacReleaseError("missing_record", "The macOS build record does not exist.");
  let record;
  try {
    record = JSON.parse(readFileSync(recordPath, "utf8"));
  } catch {
    throw new MacReleaseError("invalid_build_record", "The macOS build record is not valid JSON.");
  }
  const report = await verifyMacRelease({
    artifactPath: resolve(options.artifact),
    record,
    expectedTeamId: env.KALCODE_APPLE_TEAM_ID,
    notaryProfile: env.KALCODE_NOTARY_KEYCHAIN_PROFILE,
  });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) writeFileSync(resolve(options.output), json, { encoding: "utf8", flag: "wx", mode: 0o600 });
  else process.stdout.write(json);
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(fail);
}
