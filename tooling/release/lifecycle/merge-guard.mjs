// Merge-train guard: recognises shell commands that would update KalCode's main outside the merge train.
//
// Only the shared `node tooling/merge-train/train.mjs land|run` may move main.
// It performs the final atomic update inside a child process, so a top-level command that
// does it itself is always an agent going around the train. Every agent on this PC shares one GitHub
// identity and the repository has no branch protection, so this client-side check is the enforcement.
//
// Recognised (in any segment of a compound command, behind env/sudo/xargs prefixes, and inside
// `bash -c`, `pwsh -Command`, `powershell -EncodedCommand`, `cmd /c`, `wsl`, `Invoke-Expression`):
//   - `gh pr merge ...` in every form (--admin, --auto, -R, flags before the subcommand);
//   - `gh api` calls that merge (`.../pulls/N/merge`, `.../merges`), move `git/refs/heads/main`, or run the
//     GraphQL merge/ref mutations; the same REST calls through curl/wget/Invoke-RestMethod/Invoke-WebRequest;
//   - `git push` whose destination is main: `main`, `HEAD:main`, `<sha>:refs/heads/main`, `+main`,
//     `--delete main`, `:main`, `--all`/`--mirror`, and a bare `git push` / `git push <remote> HEAD` while the
//     checkout is on main or its push target is main (resolved with git, only for those forms).
// Not recognised: heredoc and here-string bodies, quoted arguments of other programs (a commit message that
// mentions `gh pr merge` is data), and commands hidden in script files. This stops habit, not a determined
// bypass; see the guard's tests for the exact surface.
import { spawnSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";

export const TRAIN_SUBMIT = "node tooling/merge-train/train.mjs submit <pr>";
const MAX_DEPTH = 4;
const GIT_TIMEOUT_MS = 2000;

const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish"]);
const POWERSHELLS = new Set(["pwsh", "powershell", "powershell_ise"]);
const EVALUATORS = new Set(["invoke-expression", "iex"]);
const PREFIXES = new Set([
  "env",
  "command",
  "builtin",
  "exec",
  "nohup",
  "time",
  "sudo",
  "doas",
  "nice",
  "xargs",
  "call",
]);
const HTTP_CLIENTS = new Set(["curl", "wget", "invoke-restmethod", "irm", "invoke-webrequest", "iwr", "http", "https"]);
const CD = new Set(["cd", "set-location", "sl", "chdir", "pushd", "push-location"]);
const GIT_GLOBAL_VALUED = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--config-env",
  "--super-prefix",
  "--exec-path",
]);
const PUSH_VALUED = new Set(["--repo", "-o", "--push-option", "--receive-pack", "--exec"]);
const GH_VALUED = new Set(["-R", "--repo", "--hostname"]);
const GH_API_VALUED = new Set([
  "-X",
  "--method",
  "-f",
  "--raw-field",
  "-F",
  "--field",
  "-H",
  "--header",
  "--input",
  "-q",
  "--jq",
  "-t",
  "--template",
  "--cache",
  "--hostname",
  "-p",
  "--preview",
]);
const GRAPHQL_MUTATIONS =
  /\b(mergePullRequest|enablePullRequestAutoMerge|mergeBranch|updateRefs?|createCommitOnBranch)\b/;

const PWSH_VALUED =
  /^-(executionpolicy|ep|ex|windowstyle|w|workingdirectory|wd|outputformat|of|o|inputformat|if|configurationname|version|v|psconsolefile|settingsfile|custompipename)$/i;

/** Resolves a `cd`/`git -C` target; Git Bash drive paths (`/c/x`) become `C:/x` on Windows. */
function resolveDir(base, target) {
  let t = target;
  if (process.platform === "win32") t = t.replace(/^\/([A-Za-z])(\/|$)/, (_, d) => `${d.toUpperCase()}:/`);
  if (t === "~" || t.startsWith("~/")) t = (process.env.HOME ?? process.env.USERPROFILE ?? "") + t.slice(1);
  return isAbsolute(t) ? t : resolve(base ?? process.cwd(), t);
}

/** Lower-case program basename without directory, quotes or a Windows executable extension. */
export function programName(token) {
  const base =
    String(token ?? "")
      .split(/[\\/]/)
      .pop() ?? "";
  return base.toLowerCase().replace(/\.(exe|cmd|bat|com|ps1)$/, "");
}

/** Removes heredoc bodies (`<<EOF ... EOF`, `<<-'X' ... X`) and PowerShell here-strings (`@' ... '@`): data, not commands. */
export function stripHeredocs(text) {
  let out = String(text).replace(/@(['"])\r?\n[\s\S]*?\r?\n\1@/g, "HERESTRING");
  const lines = out.split(/\r?\n/);
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    kept.push(lines[i]);
    const open = [...lines[i].matchAll(/<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/g)];
    for (const m of open) {
      const dash = m[1] === "-";
      while (i + 1 < lines.length) {
        i++;
        const l = dash ? lines[i].replace(/^\t+/, "") : lines[i];
        if (l === m[3]) break;
      }
    }
  }
  out = kept.join("\n");
  return out;
}

/**
 * Splits a bash/PowerShell command line into simple commands (arrays of unquoted words), on unquoted
 * `; & | && || newline ( ) $(` and block braces. Quotes: '...' literal; "..." with \" and `" escapes.
 */
export function splitCommands(text) {
  const src = stripHeredocs(text);
  const segments = [];
  let words = [];
  let word = "";
  let inWord = false;
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length) segments.push(words);
    words = [];
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "'") {
      const close = src.indexOf("'", i + 1);
      const end = close === -1 ? src.length : close;
      word += src.slice(i + 1, end);
      inWord = true;
      i = end;
      continue;
    }
    if (c === '"') {
      inWord = true;
      let j = i + 1;
      for (; j < src.length && src[j] !== '"'; j++) {
        if ((src[j] === "\\" || src[j] === "`") && (src[j + 1] === '"' || src[j + 1] === src[j])) {
          word += src[j + 1];
          j++;
        } else word += src[j];
      }
      i = j;
      continue;
    }
    if ((c === "\\" || c === "`") && (next === "\n" || (next === "\r" && src[i + 2] === "\n"))) {
      i += next === "\r" ? 2 : 1; // line continuation
      continue;
    }
    if (c === " " || c === "\t") {
      endWord();
      continue;
    }
    if (c === "&" && (word.endsWith(">") || word.endsWith("<"))) {
      word += c; // 2>&1
      continue;
    }
    if (c === "\n" || c === "\r" || c === ";" || c === "&" || c === "|" || c === ")") {
      endSegment();
      continue;
    }
    if (c === "(" && (!inWord || word === "$" || word === "@")) {
      word = "";
      inWord = false;
      endSegment();
      continue;
    }
    if ((c === "{" || c === "}") && !inWord) {
      endSegment();
      continue;
    }
    word += c;
    inWord = true;
  }
  endSegment();
  return segments.map(dropRedirections).filter((s) => s.length);
}

function dropRedirections(words) {
  const out = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (/^(\d+|&)?(>>?|<)(&\d+|&-)?$/.test(w)) {
      if (!/&/.test(w.replace(/^&/, ""))) i++; // `> file`: the next word is the target
      continue;
    }
    if (/^(\d+|&)?(>>?|<).+/.test(w)) continue;
    out.push(w);
  }
  return out;
}

/** Strips leading `VAR=value`, `env -u X`, `sudo`, `xargs -n1` ... to the real program. */
function stripPrefixes(words) {
  const w = [...words];
  for (;;) {
    while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) w.shift();
    if (!w.length || !PREFIXES.has(programName(w[0]))) return w;
    w.shift();
    while (w.length && w[0].startsWith("-")) {
      const flag = w.shift();
      if (["-u", "-n", "-I", "-P", "-L", "-d", "-s", "-E", "-a", "-C"].includes(flag) && w.length > 1) w.shift();
    }
  }
}

function decodeEncodedCommand(value) {
  try {
    return Buffer.from(value, "base64").toString("utf16le");
  } catch {
    return "";
  }
}

/** Command strings run by a shell wrapper (`bash -c X`, `pwsh -Command X`, `cmd /c X`, `wsl X`, `iex X`). */
function innerScripts(prog, args) {
  if (SHELLS.has(prog)) {
    const i = args.findIndex((a) => /^-[A-Za-z]*c[A-Za-z]*$/.test(a) && !a.startsWith("--"));
    return i >= 0 && args[i + 1] !== undefined ? [args[i + 1]] : [];
  }
  if (POWERSHELLS.has(prog)) {
    const enc = args.findIndex((a) => /^-(e|ec|enc|encodedcommand)$/i.test(a));
    if (enc >= 0 && args[enc + 1]) return [decodeEncodedCommand(args[enc + 1])];
    const i = args.findIndex((a) => /^-(c|command)$/i.test(a));
    if (i >= 0) return [args.slice(i + 1).join(" ")];
    if (args.some((a) => /^-(f|file)$/i.test(a))) return [];
    const positional = [];
    for (let j = 0; j < args.length; j++) {
      if (PWSH_VALUED.test(args[j])) j++;
      else if (!args[j].startsWith("-")) positional.push(...args.slice(j));
      if (positional.length) break;
    }
    return positional.length ? [positional.join(" ")] : [];
  }
  if (prog === "cmd") {
    const i = args.findIndex((a) => /^\/[ck]$/i.test(a));
    return i >= 0 ? [args.slice(i + 1).join(" ")] : [];
  }
  if (prog === "wsl") {
    const rest = [...args];
    while (rest.length && rest[0].startsWith("-") && !["-e", "--exec", "--"].includes(rest[0])) {
      const f = rest.shift();
      if (["-d", "--distribution", "-u", "--user", "--cd"].includes(f)) rest.shift();
    }
    if (["-e", "--exec", "--"].includes(rest[0])) rest.shift();
    return rest.length ? [rest.join(" ")] : [];
  }
  if (EVALUATORS.has(prog)) {
    const rest = args.filter((a) => !/^-command$/i.test(a));
    return rest.length ? [rest.join(" ")] : [];
  }
  return [];
}

function ghViolation(args) {
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("-")) {
      if (GH_VALUED.has(a)) i++;
      continue;
    }
    positional.push(a);
    if (positional.length === 2) break;
  }
  if (positional[0] === "pr" && positional[1] === "merge") return "gh pr merge";
  if (positional[0] !== "api") return null;
  return apiViolation(args.slice(args.indexOf("api") + 1), "gh api");
}

/** REST/GraphQL arguments of `gh api` (or an HTTP client's words) that would merge or move main. */
function apiViolation(args, label) {
  let method = null;
  let hasBody = false;
  const values = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const eq = a.indexOf("=");
    const flag = a.startsWith("-") && eq > 0 ? a.slice(0, eq) : a;
    const inline = a.startsWith("-") && eq > 0 ? a.slice(eq + 1) : undefined;
    const take = () => (inline !== undefined ? inline : args[++i]);
    if (/^-X(.+)$/.test(a)) method = a.slice(2);
    else if (["-X", "--method", "--request", "-Method"].includes(flag) || /^-method$/i.test(flag))
      method = String(take() ?? "");
    else if (
      ["-f", "--raw-field", "-F", "--field", "--input", "-d", "--data", "--data-raw", "--json", "-Body"].includes(
        flag,
      ) ||
      /^-body$/i.test(flag)
    ) {
      hasBody = true;
      values.push(String(take() ?? ""));
    } else if (GH_API_VALUED.has(flag)) take();
    else values.push(a);
  }
  const m = (method ?? (hasBody ? "POST" : "GET")).toUpperCase();
  const mutating = m !== "GET" && m !== "HEAD";
  const text = values.join(" ");
  if (mutating && /(^|[\s/])repos\/[^/\s]+\/[^/\s]+\/pulls\/[^/\s?]+\/merge\b/.test(text))
    return `${label} PUT pulls/<n>/merge`;
  if (mutating && /(^|[\s/])repos\/[^/\s]+\/[^/\s]+\/merges\b/.test(text)) return `${label} POST merges`;
  if (mutating && /(^|[\s/])repos\/[^/\s]+\/[^/\s]+\/git\/refs\/heads\/main\b/.test(text))
    return `${label} ${m} git/refs/heads/main`;
  if (/(^|\s|\/)graphql\b/.test(text) && GRAPHQL_MUTATIONS.test(text)) return `${label} graphql merge/ref mutation`;
  return null;
}

/** Normalised destination branch of one push refspec, or null when it depends on HEAD. */
function refspecDestination(spec) {
  const s = spec.replace(/^\+/, "");
  const colon = s.indexOf(":");
  const dst = colon >= 0 ? s.slice(colon + 1) : s;
  if (colon < 0 && (dst === "HEAD" || dst === "@")) return null;
  return dst.replace(/^refs\/heads\//, "");
}

function gitViolation(args, cwd, deps) {
  let dir = cwd;
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("-")) break;
    if (a === "-C" && args[i + 1] !== undefined) {
      dir = resolveDir(dir, args[++i]);
    } else if (GIT_GLOBAL_VALUED.has(a)) i++;
  }
  if (args[i] !== "push") return null;
  const rest = args.slice(i + 1);
  const options = rest.includes("--") ? rest.slice(0, rest.indexOf("--")) : rest;
  if (options.includes("--dry-run") || options.includes("-n")) return null; // reports, never updates
  let remoteGiven = false;
  const refspecs = [];
  for (let j = 0; j < rest.length; j++) {
    const a = rest[j];
    if (a === "--") {
      refspecs.push(...rest.slice(j + 1));
      break;
    }
    if (a.startsWith("-")) {
      const flag = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
      if (["--all", "--mirror", "--branches"].includes(flag)) return `git push ${flag} (includes main)`;
      if (flag === "--repo") remoteGiven = true;
      if (PUSH_VALUED.has(a)) j++;
      continue;
    }
    if (!remoteGiven) {
      remoteGiven = true;
      continue;
    }
    refspecs.push(a);
  }
  for (const spec of refspecs) {
    const dst = refspecDestination(spec);
    if (dst === "main") return `git push ${spec}`;
  }
  const headForms = refspecs.length === 0 || refspecs.some((s) => refspecDestination(s) === null);
  if (!headForms) return null;
  const branch = (deps.currentBranch ?? currentBranch)(dir);
  if (branch === "main") return refspecs.length ? "git push HEAD while on main" : "git push while on main";
  if (refspecs.length === 0) {
    const target = (deps.pushTarget ?? pushTarget)(dir);
    if (target && /\/main$/.test(target)) return `git push (push target ${target})`;
  }
  return null;
}

function httpViolation(args) {
  if (!args.some((a) => /api\.github\.com|\/api\/v3\//i.test(a))) return null;
  const urls = args.map((a) => a.replace(/^https?:\/\/[^/]+(\/api\/v3)?\//i, ""));
  return apiViolation(urls, "HTTP");
}

function gitRun(dir, args) {
  try {
    const r = spawnSync("git", args, {
      cwd: dir ?? process.cwd(),
      encoding: "utf8",
      windowsHide: true,
      timeout: GIT_TIMEOUT_MS,
    });
    return r.status === 0 ? r.stdout.trim() : null;
  } catch {
    return null;
  }
}

/** Branch the checkout at `dir` is on, or null (detached, not a checkout, git unavailable). */
export function currentBranch(dir) {
  return gitRun(dir, ["symbolic-ref", "--short", "-q", "HEAD"]);
}

/** Where a bare `git push` would push (`origin/main`), or null when nothing is configured. */
export function pushTarget(dir) {
  return gitRun(dir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{push}"]);
}

/**
 * Returns the first way `command` would update main outside the merge train, as a short label, or null.
 * `cwd` is the shell's working directory; `deps` injects { currentBranch, pushTarget } for tests.
 */
export function mainUpdateViolation(command, { cwd, deps = {} } = {}) {
  return scan(String(command ?? ""), cwd, deps, 0);
}

function scan(text, cwd, deps, depth) {
  if (depth > MAX_DEPTH) return null;
  let dir = cwd;
  for (const segment of splitCommands(text)) {
    const words = stripPrefixes(segment);
    if (!words.length) continue;
    const prog = programName(words[0]);
    const args = words.slice(1);
    if (CD.has(prog)) {
      const target = args.find((a) => !a.startsWith("-"));
      if (target && !target.includes("$")) dir = resolveDir(dir, target);
      continue;
    }
    let hit = null;
    if (prog === "gh") hit = ghViolation(args);
    else if (prog === "git") hit = gitViolation(args, dir, deps);
    else if (HTTP_CLIENTS.has(prog)) hit = httpViolation(args);
    else
      for (const inner of innerScripts(prog, args)) {
        hit = scan(inner, dir, deps, depth + 1);
        if (hit) break;
      }
    if (hit) return hit;
  }
  return null;
}

/** The denial text an agent sees. */
export function denialReason(label) {
  return [
    `Blocked: \`${label}\` would update KalCode's main outside the merge train.`,
    `main is updated only by the shared merge train. Queue your PR instead: ${TRAIN_SUBMIT}`,
    "(the train lands queued PRs on main with `node tooling/merge-train/train.mjs land|run`).",
    "Pushing feature branches and gh pr create/view/edit/checks are unaffected. Website releases start from the validated commit landed by the shared train.",
  ].join(" ");
}
