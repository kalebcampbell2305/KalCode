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
  let lines = text.split(/\r?\n/);
  // Rust keeps unit tests in an inline `#[cfg(test)]` module at the end of the file; like other
  // tests, it may name the variables the product code must never read.
  if (file.endsWith(".rs")) {
    const testModule = lines.findIndex((line) => line.trim() === "#[cfg(test)]");
    if (testModule !== -1) lines = lines.slice(0, testModule);
  }
  lines.forEach((line, index) => {
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
