// Minimal, time-boxed git access for the lifecycle commands. Every call is read-only.
import { spawnSync } from "node:child_process";

export class GitError extends Error {
  constructor(message) {
    super(message);
    this.name = "GitError";
  }
}

export function makeGit(repo, { timeoutMs = 30_000, deadline = null } = {}) {
  const run = (args, { allowFail = false, input } = {}) => {
    const budget = deadline ? Math.max(1, Math.min(timeoutMs, deadline - Date.now())) : timeoutMs;
    if (deadline && Date.now() >= deadline) throw new GitError("time budget exhausted");
    const r = spawnSync("git", ["-C", repo, "-c", "core.quotepath=off", ...args], {
      encoding: "utf8",
      windowsHide: true,
      timeout: budget,
      maxBuffer: 256 * 1024 * 1024,
      input,
    });
    if (r.error) throw new GitError(`git ${args[0]}: ${r.error.message}`);
    if (r.status !== 0) {
      if (allowFail) return null;
      throw new GitError(`git ${args.join(" ")}: ${(r.stderr || "").trim().split("\n")[0]}`);
    }
    return r.stdout;
  };
  const git = {
    repo,
    run,
    rev(ref) {
      const out = run(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { allowFail: true });
      return out ? out.trim() : null;
    },
    toplevel: () => run(["rev-parse", "--show-toplevel"]).trim(),
    commonDir: () => run(["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim(),
    mergeBase(a, b) {
      const out = run(["merge-base", a, b], { allowFail: true });
      return out ? out.trim() : null;
    },
    isAncestor(a, b) {
      return run(["merge-base", "--is-ancestor", a, b], { allowFail: true }) !== null;
    },
    /** File text at a ref, or null when the path does not exist there. */
    show(ref, path) {
      return run(["show", `${ref}:${path}`], { allowFail: true });
    },
    lsTree(ref, paths) {
      const out = run(["ls-tree", "-r", "--name-only", "-z", ref, "--", ...paths], { allowFail: true });
      return out ? out.split("\0").filter(Boolean) : [];
    },
    /** Changed paths from `from` to `to` (a ref, or null for the working tree), renames detected. */
    diff(from, to) {
      const args = ["diff", "--name-status", "-z", "-M", "--no-ext-diff", from];
      if (to) args.push(to);
      return parseNameStatus(run(args));
    },
    untracked() {
      return run(["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
    },
    /** Commits in (from, to], oldest first, each with its changed paths. */
    commits(from, to, { max = 400 } = {}) {
      const range = from ? `${from}..${to}` : to;
      const out = run([
        "log",
        "--reverse",
        "--no-merges",
        `--max-count=${max}`,
        "--format=%x01%H%x09%s",
        "--name-status",
        "-z",
        "-M",
        range,
      ]);
      return parseLog(out);
    },
    count(from, to) {
      return Number(run(["rev-list", "--count", `${from}..${to}`]).trim());
    },
  };
  return git;
}

/** Parses `git diff --name-status -z -M`. Renames and copies keep both paths. */
export function parseNameStatus(text) {
  const parts = text.split("\0");
  const changes = [];
  for (let i = 0; i < parts.length; ) {
    const status = parts[i++];
    if (!status) continue;
    const kind = status[0];
    if (kind === "R" || kind === "C") {
      const oldPath = parts[i++];
      const path = parts[i++];
      changes.push({ status: kind, oldPath, path });
    } else changes.push({ status: kind, path: parts[i++] });
  }
  return changes;
}

function parseLog(text) {
  const commits = [];
  for (const chunk of text.split("\x01")) {
    if (!chunk.trim()) continue;
    const nl = chunk.indexOf("\n");
    const header = nl < 0 ? chunk : chunk.slice(0, nl);
    const tab = header.indexOf("\t");
    const sha = header.slice(0, tab);
    const subject = header.slice(tab + 1).replace(/\0+$/, "");
    const body = nl < 0 ? "" : chunk.slice(nl + 1).replace(/^\n+/, "");
    commits.push({ sha, subject, changes: parseNameStatus(body) });
  }
  return commits;
}

/** Every path a change touches: both sides of a rename, the old path of a deletion. */
export function touchedPaths(changes) {
  const paths = [];
  for (const c of changes) {
    if (c.oldPath) paths.push(c.oldPath);
    paths.push(c.path);
  }
  return [...new Set(paths)].sort();
}
