# Capture-only staging: points the ui-test fake shell at the kalcode repo and adds streamed
# test output. Applied to a local working copy for capture; never committed to product code.
import sys
p = sys.argv[1]
s = open(p, encoding="utf-8").read()
JOIN = '].join("\\r\\n");'
a = s.index("  const gitLog = () =>")
b = s.index(JOIN, a) + len(JOIN)
git_log = r'''  const gitLog = () =>
    [
      `* ${c("33", "643b1ef")} ${c("1;36", "(")}${c("1;36", "HEAD -> ")}${c("1;32", "main")}${c("1;36", ", ")}${c("1;31", "origin/main")}${c("1;36", ")")} fix(kalvoice): stop a quick orb tap`,
      `* ${c("33", "cb4408d")} feat(kalvoice): in-app Fn push-to-talk`,
      `* ${c("33", "42f699c")} fix(updater): reconcile the previous install`,
      `* ${c("33", "8788993")} feat(desktop): isolate Dev identity from Stable`,
      `* ${c("33", "40cab1d")} feat(website): publish a build stamp`,
      `* ${c("33", "03eeabf")} ${c("1;33", "(tag: v0.1.7)")} KalCode 0.1.7`,
    ].join("\r\n");
  // Film staging (capture-only): streamed test output.
  const stream = (session: NonNullable<Tab["session"]>, lines: string[], ms = 140) =>
    lines.forEach((line, i) => setTimeout(() => deliver(session, `${line}\r\n`), (i + 1) * ms));'''
s = s[:a] + git_log + s[b:]
cmds = r'''      case "pnpm":
        stream(session, [
          "",
          `${c("1;36", " RUN ")} ${c("90", "v3  ~/Projects/kalcode/apps/desktop")}`,
          "",
          ` ${c("32", "✓")} src/surfaces/browser/BrowserPane.test.tsx ${c("90", "(18 tests)")}`,
          ` ${c("32", "✓")} src/surfaces/browser/toolbar.test.tsx ${c("90", "(9 tests)")}`,
          ` ${c("32", "✓")} src/surfaces/browser/loading.test.tsx ${c("90", "(6 tests)")}`,
          ` ${c("32", "✓")} src/shell/navigation.test.tsx ${c("90", "(12 tests)")}`,
          "",
          ` ${c("90", "Test Files")}  ${c("1;32", "4 passed")} ${c("90", "(4)")}`,
          ` ${c("90", "     Tests")}  ${c("1;32", "45 passed")} ${c("90", "(45)")}`,
        ]);
        break;
      case "cargo":
        stream(session, [
          `${c("1;32", "   Compiling")} kalcode-updater v0.1.7`,
          `${c("1;32", "    Finished")} test profile [unoptimized + debuginfo]`,
          `${c("1;32", "     Running")} unittests src/lib.rs`,
          "",
          "running 24 tests",
          `test download::retries_once_before_reporting ... ${c("32", "ok")}`,
          `test download::backoff_waits_between_attempts ... ${c("32", "ok")}`,
          `test install::reconciles_previous_install ... ${c("32", "ok")}`,
          "",
          `test result: ${c("32", "ok")}. 24 passed; 0 failed`,
        ]);
        break;
      case "git":'''
s = s.replace('      case "git":', cmds, 1)
s = s.replace(
    '        if (rest[0] === "log") out(gitLog());',
    """        if (rest[0] === "log") out(gitLog());
        else if (rest[0] === "push")
          stream(session, [
            "Enumerating objects: 23, done.",
            "Writing objects: 100% (14/14), 3.91 KiB | 3.91 MiB/s, done.",
            "To github.com:you/kalcode.git",
            `   ${c("33", "643b1ef")}..${c("33", "9d2c4a7")}  ${c("32", "main -> main")}`,
          ], 180);""",
    1,
)
s = s.replace('const defaultPicks = ["kalcode-site", "api-server", "design-notes"];', 'const defaultPicks = ["kalcode", "api-server", "design-notes"];')
s = s.replace('const site = openFolder("kalcode-site", { emitEvent: true });', 'const site = openFolder("kalcode", { emitEvent: true });')
open(p, "w", encoding="utf-8").write(s)
print("staged")
