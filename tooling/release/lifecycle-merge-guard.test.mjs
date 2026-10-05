// Tests for the merge-train guard (tooling/release/lifecycle/merge-guard.mjs) and its PreToolUse wiring in
// `ship.mjs lifecycle hook`. Pure string analysis plus one throwaway git repository; no network.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { evaluateHook, evaluatePreToolUse } from "./lifecycle/hook.mjs";
import { mainUpdateViolation, programName, splitCommands, TRAIN_SUBMIT } from "./lifecycle/merge-guard.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const SHIP = join(HERE, "ship.mjs");

const temps = [];
after(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

// A checkout on a feature branch whose push target is a feature branch, unless a test says otherwise.
const onFeature = { currentBranch: () => "feat/x", pushTarget: () => "origin/feat/x" };
const check = (command, deps = onFeature) => mainUpdateViolation(command, { cwd: ROOT, deps });

const preToolUse = (command, { tool = "Bash", cwd = ROOT } = {}) =>
  JSON.stringify({
    session_id: "s1",
    transcript_path: "/tmp/t.jsonl",
    cwd,
    hook_event_name: "PreToolUse",
    tool_name: tool,
    tool_input: { command, description: "x" },
  });

describe("merge guard: commands that update main", () => {
  const blocked = [
    // gh pr merge, every form
    "gh pr merge 221",
    "gh pr merge 221 --merge --match-head-commit abc123",
    "gh pr merge --admin --squash 7",
    "gh pr merge --auto --merge https://github.com/kalebcampbell2305/KalCode/pull/9",
    "gh -R kalebcampbell2305/KalCode pr merge 5",
    "gh pr --repo kalebcampbell2305/KalCode merge 5",
    "gh.exe pr merge 5",
    '& "C:\\Program Files\\GitHub CLI\\gh.exe" pr merge 5 --merge',
    "/usr/bin/gh pr merge 5",
    "GH_TOKEN=x gh pr merge 5",
    "env GH_PROMPT_DISABLED=1 gh pr merge 5",
    "echo 5 | xargs -I {} gh pr merge {} --merge",
    // compound commands, both shells
    "cd /c/kc-wt && gh pr checks 5 && gh pr merge 5 --merge",
    "gh pr view 5; gh pr merge 5",
    "gh pr view 5 || gh pr merge 5",
    "gh pr view 5\ngh pr merge 5",
    "gh pr checks 5; if ($?) { gh pr merge 5 --merge }",
    "(gh pr merge 5)",
    "echo $(gh pr merge 5)",
    "gh pr merge 5 2>&1 | tail -5",
    "node tooling/merge-train/train.mjs submit 5 && gh pr merge 5",
    // shell wrappers
    'bash -lc "gh pr merge 5"',
    "sh -c 'git push origin HEAD:main'",
    'pwsh -NoProfile -Command "gh pr merge 5 --merge"',
    "powershell -ExecutionPolicy Bypass gh pr merge 5",
    `powershell -EncodedCommand ${Buffer.from("gh pr merge 5", "utf16le").toString("base64")}`,
    'cmd /c "gh pr merge 5"',
    "wsl -e gh pr merge 5",
    'Invoke-Expression "gh pr merge 5"',
    // REST / GraphQL merges and ref moves
    "gh api -X PUT repos/kalebcampbell2305/KalCode/pulls/221/merge",
    "gh api --method PUT /repos/kalebcampbell2305/KalCode/pulls/221/merge -f merge_method=merge",
    "gh api repos/kalebcampbell2305/KalCode/pulls/221/merge -XPUT",
    "gh api repos/kalebcampbell2305/KalCode/merges -f base=main -f head=feat/x",
    "gh api -X PATCH repos/kalebcampbell2305/KalCode/git/refs/heads/main -f sha=abc -F force=true",
    "gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: \"X\"}) { clientMutationId } }'",
    "gh api graphql -f query='mutation { enablePullRequestAutoMerge(input: {pullRequestId: \"X\"}) { clientMutationId } }'",
    "curl -X PUT -H 'Authorization: token x' https://api.github.com/repos/kalebcampbell2305/KalCode/pulls/5/merge",
    "Invoke-RestMethod -Method Put -Uri https://api.github.com/repos/kalebcampbell2305/KalCode/pulls/5/merge",
    // git push to main
    "git push origin main",
    "git push origin HEAD:main",
    "git push origin HEAD:refs/heads/main",
    "git push origin 0123456789abcdef0123456789abcdef01234567:refs/heads/main --force-with-lease",
    "git push origin feat/x:main",
    "git push origin +main",
    "git push origin +HEAD:main",
    "git push --force origin main",
    "git push -f origin main",
    "git push --force-with-lease=main:abc origin HEAD:main",
    "git push -u origin main",
    "git push --no-verify origin main",
    "git push origin feat/x main",
    "git push origin :main",
    "git push origin --delete main",
    "git push --repo=origin main",
    "git push origin -- main",
    "git push --all origin",
    "git push --mirror",
    "git -C /c/kc-wt-merge-train push origin HEAD:main",
    "git -c push.default=current push origin main",
    "git.exe push origin main",
    "git push upstream main",
    "git push https://github.com/kalebcampbell2305/KalCode.git HEAD:main",
  ];
  for (const command of blocked)
    test(`blocks: ${command.replace(/\n/g, "\\n").slice(0, 110)}`, () => {
      assert.ok(check(command), `expected a violation for ${command}`);
    });

  test("a bare push or a HEAD push is judged by the branch it would update", () => {
    const onMain = { currentBranch: () => "main", pushTarget: () => "origin/main" };
    assert.match(check("git push", onMain), /while on main/);
    assert.match(check("git push origin HEAD", onMain), /HEAD while on main/);
    assert.match(check("git push -u origin @", onMain), /HEAD while on main/);
    const tracksMain = { currentBranch: () => "feat/x", pushTarget: () => "origin/main" };
    assert.match(check("git push", tracksMain), /push target origin\/main/);
    assert.equal(check("git push", onFeature), null);
    assert.equal(check("git push origin HEAD", onFeature), null);
    assert.equal(
      check("git push", { currentBranch: () => null, pushTarget: () => null }),
      null,
      "detached / no upstream",
    );
  });

  test("git is consulted only for the HEAD-dependent forms, in the directory the command runs in", () => {
    const seen = [];
    const deps = {
      currentBranch: (dir) => {
        seen.push(["branch", dir]);
        return "feat/x";
      },
      pushTarget: (dir) => {
        seen.push(["target", dir]);
        return "origin/feat/x";
      },
    };
    check("git push origin feat/x && gh pr create --fill", deps);
    assert.deepEqual(seen, [], "an explicit feature refspec needs no git call");
    mainUpdateViolation("cd sub && git push", { cwd: join(ROOT, "x"), deps });
    assert.deepEqual(
      seen.map(([k]) => k),
      ["branch", "target"],
    );
    assert.equal(seen[0][1], join(ROOT, "x", "sub"));
    seen.length = 0;
    mainUpdateViolation("git -C ../other push origin HEAD", { cwd: join(ROOT, "x"), deps });
    assert.equal(seen[0][1], join(ROOT, "other"));
  });

  test("the real git lookups see the branch of a throwaway checkout", () => {
    const repo = mkdtempSync(join(tmpdir(), "merge-guard-"));
    temps.push(repo);
    const git = (...a) => spawnSync("git", a, { cwd: repo, encoding: "utf8", windowsHide: true });
    git("init", "-q", "-b", "main");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x");
    assert.match(mainUpdateViolation("git push", { cwd: repo }), /while on main/);
    git("checkout", "-q", "-b", "feat/y");
    assert.equal(mainUpdateViolation("git push origin HEAD", { cwd: repo }), null);
  });
});

describe("merge guard: everyday commands stay allowed", () => {
  const allowed = [
    "git push origin feat/merge-train",
    "git push -u origin HEAD:feat/merge-train",
    "git push --force-with-lease origin fix/thing",
    "git push origin main-followup",
    "git push origin refs/heads/feat/main",
    "git push origin v1.2.3",
    "git push origin --tags",
    "git push --dry-run origin HEAD:main",
    "git push -n --all origin",
    "git push origin feat/x:feat/x",
    "git pull origin main",
    "git fetch origin main",
    "git merge origin/main",
    "git rebase origin/main",
    "git log origin/main..HEAD",
    "git checkout main",
    "git rev-parse @{push}",
    "gh pr create --base main --head feat/x --title t --body b",
    "gh pr view 5 --json state",
    "gh pr edit 5 --title 'merge train'",
    "gh pr checks 5",
    "gh pr list --state merged",
    "gh pr diff 5",
    "gh api repos/kalebcampbell2305/KalCode/pulls/5",
    "gh api repos/kalebcampbell2305/KalCode/pulls/5/merge",
    "gh api repos/kalebcampbell2305/KalCode/git/refs/heads/main",
    'gh api graphql -f query=\'{ repository(owner:"o", name:"r") { pullRequest(number: 5) { mergeable } } }\'',
    "curl -s https://api.github.com/repos/kalebcampbell2305/KalCode/pulls/5/merge",
    "node tooling/merge-train/train.mjs submit 221",
    "node tooling/merge-train/train.mjs land",
    "node tooling/merge-train/train.mjs run",
    "node C:\\kc-code-primary\\target\\code-primary-release\\run-publish-code-primary.mjs --phase website",
    "powershell -NoProfile -File C:\\kc-code-primary\\target\\code-primary-release\\finish-publication.ps1",
    // text that mentions the commands is data
    'git commit -m "docs: never run gh pr merge or git push origin main; use the train"',
    "git commit -F - <<'EOF'\nfix: stop agents running\ngh pr merge 5\ngit push origin main\nEOF",
    "git commit -F - <<-EOF\n\tgh pr merge 5\n\tEOF",
    "$msg = @'\ngh pr merge 5\ngit push origin HEAD:main\n'@\ngit commit -m $msg",
    "echo 'gh pr merge 5'",
    'rg "gh pr merge" tooling',
    "grep -n 'git push origin main' AGENTS.md",
    "gh pr comment 5 --body 'queued; the train will gh pr merge it'",
  ];
  for (const command of allowed)
    test(`allows: ${command.replace(/\n/g, "\\n").slice(0, 110)}`, () => {
      assert.equal(check(command), null);
    });
});

describe("merge guard: parsing", () => {
  test("splits compound commands without splitting quotes, redirections or ref syntax", () => {
    assert.deepEqual(splitCommands("a 'b; c' && d \"e | f\" 2>&1 | g >out.txt"), [
      ["a", "b; c"],
      ["d", "e | f"],
      ["g"],
    ]);
    assert.deepEqual(splitCommands("git rev-parse HEAD@{1} @{push}"), [["git", "rev-parse", "HEAD@{1}", "@{push}"]]);
    assert.deepEqual(splitCommands("a \\\n  b"), [["a", "b"]]);
    assert.deepEqual(splitCommands('x "a \\"q\\" b"'), [["x", 'a "q" b']]);
  });

  test("program names ignore directories, quotes, case and Windows extensions", () => {
    assert.equal(programName("C:\\Program Files\\GitHub CLI\\gh.exe"), "gh");
    assert.equal(programName("/mingw64/bin/GIT.EXE"), "git");
    assert.equal(programName("pwsh"), "pwsh");
  });
});

describe("PreToolUse hook", () => {
  test("denies a merge with the Claude Code PreToolUse schema and points at the train", () => {
    const r = evaluatePreToolUse(preToolUse("gh pr merge 221 --admin"), onFeature);
    assert.equal(r.code, 0);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(out), ["hookSpecificOutput"]);
    assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
    assert.ok(out.hookSpecificOutput.permissionDecisionReason.includes(TRAIN_SUBMIT));
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /`gh pr merge`/);
    const ps = JSON.parse(
      evaluatePreToolUse(preToolUse("git push origin HEAD:main", { tool: "PowerShell" }), onFeature).stdout,
    );
    assert.equal(ps.hookSpecificOutput.permissionDecision, "deny");
  });

  test("allows other tools, other events, allowed commands and bad input", () => {
    assert.equal(evaluatePreToolUse(preToolUse("git push origin feat/x"), onFeature).stdout, "");
    assert.equal(evaluatePreToolUse(preToolUse("gh pr merge 5", { tool: "Read" }), onFeature).stdout, "");
    assert.equal(evaluatePreToolUse(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash" })).stdout, "");
    assert.equal(evaluatePreToolUse("").stdout, "");
    assert.equal(evaluatePreToolUse("{nope").stdout, "");
    assert.equal(evaluateHook("{nope").stdout, "");
    assert.equal(evaluateHook(JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Bash" })).stdout, "");
  });

  test("the CLI hook denies a blocked command and allows a normal one, fast", () => {
    const run = (command) => {
      const t0 = Date.now();
      const r = spawnSync(process.execPath, [SHIP, "lifecycle", "hook"], {
        input: preToolUse(command),
        encoding: "utf8",
        env: { ...process.env, KALCODE_LIFECYCLE_HOOK_REFRESH: "0" },
        windowsHide: true,
      });
      return { ...r, ms: Date.now() - t0 };
    };
    const denied = run("gh pr merge 221 --merge");
    assert.equal(denied.status, 0, denied.stderr);
    assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, "deny");
    assert.ok(denied.ms < 2000, `hook took ${denied.ms} ms`);
    const allowed = run("git push -u origin feat/merge-train");
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.equal(allowed.stdout, "");
  });

  test("the committed project settings run the hook before every Bash and PowerShell call", () => {
    const settings = JSON.parse(readFileSync(join(ROOT, ".claude", "settings.json"), "utf8"));
    const entries = settings.hooks.PreToolUse;
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0].matcher.split("|").sort(), ["Bash", "PowerShell"]);
    assert.equal(entries[0].hooks.length, 1);
    assert.equal(entries[0].hooks[0].type, "command");
    assert.match(
      entries[0].hooks[0].command,
      /^node "\$\{CLAUDE_PROJECT_DIR\}\/tooling\/release\/ship\.mjs" lifecycle hook$/,
    );
    assert.ok(entries[0].hooks[0].timeout >= 5);
  });
});
