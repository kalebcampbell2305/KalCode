/**
 * Static guarantees about the shipped Worker source and the operator tooling:
 *   - the Worker's only SQL write is recording KalVoice Requests (no request can change an
 *     entitlement, an account or the audit log);
 *   - the production entry point never imports test code;
 *   - no email address is hardcoded anywhere in the entitlement code paths (no email bypass);
 *   - zero company AI cost: the API never calls an AI or speech provider, holds no AI keys, and
 *     depends on no AI SDK.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { API_DIR, REPO_ROOT } from "../support/wrangler";

function files(dir: string, extensions: readonly string[]): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext)))
    .map((entry) => join(entry.parentPath, entry.name));
}

const workerFiles = files(join(API_DIR, "worker"), [".ts"]);
const read = (file: string) => readFileSync(file, "utf8");

describe("Worker source", () => {
  it("writes only the KalVoice Request ledger", () => {
    expect(workerFiles.length).toBeGreaterThan(5);
    const writes = workerFiles.flatMap((file) =>
      [...read(file).matchAll(/\b(INSERT|UPDATE|DELETE|REPLACE|UPSERT|DROP|ALTER|CREATE)\b[^;`"]*/g)].map((m) => ({
        file: relative(API_DIR, file),
        sql: m[0].replace(/\s+/g, " ").trim(),
      })),
    );
    expect(writes.map((w) => w.sql)).toEqual([expect.stringMatching(/^INSERT INTO kalvoice_requests \(/)]);
    for (const file of workerFiles) {
      expect(read(file), relative(API_DIR, file)).not.toMatch(
        /(INTO|UPDATE|FROM)\s+(entitlement_grants|accounts|audit_log)\b[^;]*\b(SET|VALUES)\b/i,
      );
    }
  });

  it("never imports test support code", () => {
    for (const file of workerFiles) {
      expect(read(file), relative(API_DIR, file)).not.toMatch(/from\s+["'][^"']*tests?\//);
    }
  });

  it("uses the no-sign-in authenticator in the production wiring", () => {
    const env = read(join(API_DIR, "worker", "lib", "env.ts"));
    expect(env).toMatch(/auth: SIGN_IN_UNAVAILABLE,/);
    expect(env).not.toMatch(/TEST_ONLY_AUTHENTICATOR/);
  });
});

describe("no hardcoded identities", () => {
  it("names no email address in the Worker, migrations, admin tooling or entitlement crate", () => {
    const scanned = [
      ...workerFiles,
      ...files(join(API_DIR, "migrations"), [".sql"]),
      ...files(join(REPO_ROOT, "tooling", "admin"), [".mjs"]),
      ...files(join(REPO_ROOT, "crates", "entitlements", "src"), [".rs"]),
    ];
    const email = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
    for (const file of scanned) {
      const found = (read(file).match(email) ?? []).filter((m) => !m.endsWith("@example.com"));
      expect(found, relative(REPO_ROOT, file)).toEqual([]);
    }
  });
});

describe("zero company AI cost", () => {
  const AI_HOSTS =
    /api\.anthropic\.com|api\.openai\.com|generativelanguage\.googleapis\.com|aiplatform\.googleapis\.com|bedrock-runtime|openai\.azure\.com|api\.groq\.com|api\.mistral\.ai|api\.together\.xyz|api\.cohere\.|speech\.googleapis\.com|texttospeech\.googleapis\.com|api\.elevenlabs\.io|api\.deepgram\.com|api\.assemblyai\.com|cognitiveservices\.azure\.com|tts\.speech\.microsoft\.com|polly\.[a-z0-9-]+\.amazonaws\.com|gateway\.ai\.cloudflare\.com/i;

  it("makes no outbound requests at all", () => {
    for (const file of workerFiles) {
      const source = read(file);
      expect(source, relative(API_DIR, file)).not.toMatch(AI_HOSTS);
      // The only `fetch` is the Worker's own request handler.
      const calls = [...source.matchAll(/\bfetch\s*\(/g)].length;
      const handler = relative(API_DIR, file).replaceAll("\\", "/") === "worker/index.ts" ? 1 : 0;
      expect(calls, relative(API_DIR, file)).toBe(handler);
      expect(source).not.toMatch(/\bconnect\s*\(|WebSocket|EventSource/);
    }
  });

  it("holds no AI keys and binds no AI services", () => {
    const config = read(join(API_DIR, "wrangler.jsonc"));
    expect(config).not.toMatch(/"ai"\s*:|"services"\s*:|"browser"\s*:|_API_KEY/i);
    for (const file of workerFiles) {
      expect(read(file), relative(API_DIR, file)).not.toMatch(
        /(ANTHROPIC|OPENAI|GEMINI|GOOGLE_AI|ELEVENLABS|DEEPGRAM)\w*KEY|env\.AI\b/,
      );
    }
  });

  it("depends on no AI SDK", () => {
    const pkg = JSON.parse(read(join(API_DIR, "package.json"))) as Record<string, Record<string, string> | undefined>;
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(
      deps.filter((name) =>
        /anthropic|openai|genai|generative-ai|@ai-sdk|elevenlabs|deepgram|assemblyai|cohere|mistral|groq|workers-ai/i.test(
          name,
        ),
      ),
    ).toEqual([]);
  });
});
