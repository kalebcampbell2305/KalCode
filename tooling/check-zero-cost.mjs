// Zero company AI cost guard. KalCode must never pay for users' AI usage: product code may not
// call hosted inference or speech APIs directly or read company AI credentials. Provider work
// runs through the user's own provider CLI/account; speech runs on the device.
// Docs, tests and this guard are exempt (they may describe what is forbidden).
// Usage: node tooling/check-zero-cost.mjs
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

const FORBIDDEN = [
  // Hosted model inference
  /api\.anthropic\.com/i,
  /api\.openai\.com/i,
  /generativelanguage\.googleapis\.com/i,
  /aiplatform\.googleapis\.com/i,
  /bedrock-runtime\./i,
  /openai\.azure\.com/i,
  /api\.groq\.com/i,
  /api\.mistral\.ai/i,
  /api\.together\.xyz/i,
  /api\.cohere\.(ai|com)/i,
  // Hosted speech
  /speech\.googleapis\.com/i,
  /texttospeech\.googleapis\.com/i,
  /api\.elevenlabs\.io/i,
  /api\.deepgram\.com/i,
  /api\.assemblyai\.com/i,
  /cognitiveservices\.azure\.com/i,
  /\.tts\.speech\.microsoft\.com/i,
  /polly\.[a-z0-9-]+\.amazonaws\.com/i,
  // Company-held AI credentials in product/backend code
  /\b(ANTHROPIC|OPENAI|GEMINI|GOOGLE_AI|ELEVENLABS|DEEPGRAM)_API_KEY\b/,
  // AI SDKs that call hosted inference directly
  /["']@anthropic-ai\/sdk["']/,
  /["']openai["']\s*[:)]/,
  /["']@google\/genai["']/,
  /["']@google\/generative-ai["']/,
];

const SCOPE = /^(apps\/(desktop|website|api)\/(src|worker|src-tauri\/src)|crates\/[^/]+\/src)\//;
const EXEMPT = /(\.test\.|\/tests?\/|\/test-support\/|__fixtures__)/;

// This is a boundary recognizer, not a Rust parser. Only complete, explicit inline test
// modules are exempt. Other cfg(test) items and ambiguous syntax stay scanned.
function withoutRustTestModules(source) {
  // A leading inner attribute applies to this entire Rust module, including all later items.
  // Unlike an outer attribute, it cannot hide subsequent production code in the same file.
  if (/^#!\[cfg\(test\)\](?:\r?\n|$)/.test(source)) return source.replace(/[^\r\n]/g, " ");
  const blank = (text) => text.replace(/[^\r\n]/g, " ");
  const syntax = source.split("");
  const mask = (start, end, literal = false) => {
    for (let i = start; i < end; i++) {
      if (syntax[i] !== "\r" && syntax[i] !== "\n") syntax[i] = " ";
    }
    // A literal cannot turn into whitespace between an attribute and a module.
    if (literal) syntax[start] = "~";
  };
  for (let i = 0; i < source.length; ) {
    const start = i;
    if (source.startsWith("//", i)) {
      const newline = source.indexOf("\n", i);
      i = newline === -1 ? source.length : newline;
      mask(start, i);
    } else if (source.startsWith("/*", i)) {
      let depth = 1;
      i += 2;
      while (i < source.length && depth) {
        if (source.startsWith("/*", i)) {
          depth++;
          i += 2;
        } else if (source.startsWith("*/", i)) {
          depth--;
          i += 2;
        } else i++;
      }
      mask(start, i);
    } else if (source[i] === "r" && /^r#*"/.test(source.slice(i))) {
      const opening = /^r(#*)"/.exec(source.slice(i))[0];
      const closing = `"${opening.slice(1, -1)}`;
      const end = source.indexOf(closing, i + opening.length);
      i = end === -1 ? source.length : end + closing.length;
      mask(start, i, true);
    } else if (source[i] === '"') {
      i++;
      while (i < source.length) {
        if (source[i] === "\\") i = Math.min(i + 2, source.length);
        else if (source[i++] === '"') break;
      }
      mask(start, i, true);
    } else if (source[i] === "'") {
      // Match exactly one Rust character (including escapes), never a lifetime like 'a.
      const character = /^'(?:\\(?:u\{[0-9a-fA-F_]+\}|x[0-9a-fA-F]{2}|[^\r\n])|[^'\\\r\n])'/u.exec(source.slice(i));
      if (character) {
        i += character[0].length;
        mask(start, i, true);
      } else i++;
    } else i++;
  }
  const structure = syntax.join("");
  const modules =
    /#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]\s*(?:pub\s*(?:\([^()]*\)\s*)?)?mod\s+(?:r#)?[A-Za-z_][A-Za-z0-9_]*\s*\{/g;
  const parts = [];
  let copied = 0;
  for (const match of structure.matchAll(modules)) {
    if (match.index < copied) continue;
    let end = match.index + match[0].length;
    let depth = 1;
    while (end < structure.length && depth) {
      if (structure[end] === "{") depth++;
      if (structure[end] === "}") depth--;
      end++;
    }
    if (depth) continue;
    parts.push(source.slice(copied, match.index), blank(source.slice(match.index, end)));
    copied = end;
  }
  parts.push(source.slice(copied));
  return parts.join("");
}

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
  cwd: root,
  encoding: "utf8",
  windowsHide: true,
})
  .split("\n")
  .filter((f) => SCOPE.test(f) && !EXEMPT.test(f) && /\.(ts|tsx|js|mjs|rs|astro|json|toml)$/.test(f));

const findings = [];
for (const file of files) {
  let text;
  try {
    text = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  } catch {
    continue;
  }
  const lines = (file.endsWith(".rs") ? withoutRustTestModules(text) : text).split(/\r?\n/);
  lines.forEach((line, index) => {
    // Audited selected-account authentication strips this key; it never reads or forwards it.
    // Bind the exception to this exact file and complete statement, not a general key allowlist.
    if (file === "crates/providers/src/account_auth.rs" && line.trim() === 'remove_env(&mut env, "OPENAI_API_KEY");')
      return;
    // Audited managed-account isolation (`env::auth_overrides`): these entries name the user's
    // own provider keys only so a managed session can drop them; nothing reads or forwards them.
    if (
      file === "crates/providers/src/env.rs" &&
      ['"ANTHROPIC_API_KEY",', '"OPENAI_API_KEY",', '"GEMINI_API_KEY",'].includes(line.trim())
    )
      return;
    // Live plan-usage read: Anthropic's free OAuth usage endpoint with the user's own Claude Code
    // sign-in (no inference, no company key). Bound to this exact file and declaration.
    if (
      file === "crates/providers/src/usage.rs" &&
      line.trim() === 'const CLAUDE_USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";'
    )
      return;
    // Owner-authorized external integrations: the only inference endpoint is an explicit
    // per-user OS-keychain key. No environment/company credentials or automatic fallback.
    if (
      file === "crates/integration-openai/src/lib.rs" &&
      line.trim() === 'const ENDPOINT: &str = "https://api.openai.com/v1/responses";'
    )
      return;
    for (const re of FORBIDDEN) if (re.test(line)) findings.push(`${file}:${index + 1}: ${re}`);
  });
}

// Package manifests: no hosted-AI SDK dependencies anywhere in product packages.
for (const manifest of ["apps/desktop/package.json", "apps/website/package.json", "apps/api/package.json"]) {
  try {
    const pkg = JSON.parse(readFileSync(new URL(`../${manifest}`, import.meta.url), "utf8"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const name of [
      "@anthropic-ai/sdk",
      "openai",
      "@google/genai",
      "@google/generative-ai",
      "@ai-sdk/openai",
      "@ai-sdk/anthropic",
    ]) {
      if (deps[name]) findings.push(`${manifest}: depends on ${name}`);
    }
  } catch {
    // manifest absent on this branch
  }
}

if (findings.length) {
  console.error(
    `Zero-cost check failed — product code must not use hosted AI/speech or company AI keys:\n${findings.join("\n")}`,
  );
  process.exit(1);
}
console.log(`Zero-cost check passed: ${files.length} product files scanned.`);
