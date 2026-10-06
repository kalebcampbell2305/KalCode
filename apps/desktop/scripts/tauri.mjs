// Apply the Dev identity to both `tauri dev` and `tauri build --debug`.

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { lowerLocalPriority } from "../../../tooling/local-priority.mjs";

export function laneArguments(args) {
  const debug = args[0] === "dev" || (args[0] === "build" && args.includes("--debug"));
  if (!debug) return args;
  const boundary = args.includes("--") ? args.indexOf("--") : args.length;
  return [...args.slice(0, boundary), "--config", "src-tauri/tauri.dev.conf.json", ...args.slice(boundary)];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // A build yields to the gate; `tauri dev` is the owner's interactive app.
  if (process.argv[2] === "build") lowerLocalPriority();
  const require = createRequire(import.meta.url);
  const result = spawnSync(
    process.execPath,
    [require.resolve("@tauri-apps/cli/tauri.js"), ...laneArguments(process.argv.slice(2))],
    {
      stdio: "inherit",
      windowsHide: true,
    },
  );
  process.exit(result.status ?? 1);
}
