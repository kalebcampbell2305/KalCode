// Keep the ordinary repository test/lint commands on the isolated Dev identity.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const result = spawnSync("cargo", args, {
    env: cargoEnvironment(args, process.env),
    stdio: "inherit",
    windowsHide: true,
  });
  process.exit(result.status ?? 1);
}
