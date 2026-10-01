// Keep the ordinary repository test/lint commands on the isolated Dev identity.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const GUARDIAN_BUILD = ["build", "-p", "kalcode-providers", "--bin", "kalcode-provider-guardian"];

function optionValues(args, short, long) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") break;
    if (argument === short || argument === long) {
      if (index + 1 < args.length) values.push(args[index + 1]);
      index += 1;
    } else if (argument.startsWith(`${long}=`)) {
      values.push(argument.slice(long.length + 1));
    }
  }
  return values;
}

export function guardianBuildArguments(args) {
  if (args[0] !== "test") return null;
  const packages = optionValues(args, "-p", "--package");
  const excluded = new Set(optionValues(args, "--exclude", "--exclude"));
  const includesDesktop = packages.length === 0 || packages.includes("kalcode-desktop");
  if (!includesDesktop || excluded.has("kalcode-desktop")) return null;

  const build = [...GUARDIAN_BUILD];
  const valueOptions = new Set(["--target", "--target-dir", "--profile", "--config"]);
  const flags = new Set(["--release", "--locked", "--frozen", "--offline"]);
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") break;
    if (flags.has(argument)) {
      build.push(argument);
      continue;
    }
    const equalsOption = [...valueOptions].find((option) => argument.startsWith(`${option}=`));
    if (equalsOption) {
      build.push(argument);
      continue;
    }
    if (valueOptions.has(argument) && index + 1 < args.length) {
      build.push(argument, args[index + 1]);
      index += 1;
    }
  }
  return build;
}

export function cargoEnvironment(args, environment) {
  if (
    args.includes("--release") ||
    args.includes("--profile=release") ||
    (args.includes("--profile") && args[args.indexOf("--profile") + 1] === "release")
  )
    return environment;
  const dev = JSON.parse(readFileSync(new URL("../src-tauri/tauri.dev.conf.json", import.meta.url), "utf8"));
  const overlay = JSON.parse(environment.TAURI_CONFIG || "{}");
  return {
    ...environment,
    TAURI_CONFIG: JSON.stringify({ ...overlay, ...dev, plugins: { ...overlay.plugins, ...dev.plugins } }),
  };
}

export function runCargo(args, environment = process.env, spawn = spawnSync) {
  const resolvedEnvironment = cargoEnvironment(args, environment);
  const options = {
    env: resolvedEnvironment,
    stdio: "inherit",
    windowsHide: true,
  };
  const guardian = guardianBuildArguments(args);
  if (guardian) {
    const prerequisite = spawn("cargo", guardian, options);
    if (prerequisite.status !== 0) return prerequisite.status ?? 1;
  }
  const result = spawn("cargo", args, options);
  return result.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  process.exit(runCargo(args));
}
