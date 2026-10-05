// GitHub's .js hook executes this exact file with its bundled Node runtime.
// Dynamic imports work in both CommonJS and ESM; no user/machine policy is changed.
Promise.all([import("node:child_process"), import("node:path")])
  .then(([{ spawnSync }, { basename, dirname, join }]) => {
    const name = basename(process.argv[1], ".js");
    if (name !== "before" && name !== "after") throw new Error("Unknown gate hook phase");
    const result = spawnSync(
      join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(dirname(process.argv[1]), "gate-worker-hook.ps1"),
        "-Phase",
        name === "before" ? "Before" : "After",
      ],
      { windowsHide: true, stdio: "inherit" },
    );
    process.exitCode = result.status ?? 1;
  })
  .catch(() => {
    console.error("Gate hook launch failed.");
    process.exitCode = 1;
  });
