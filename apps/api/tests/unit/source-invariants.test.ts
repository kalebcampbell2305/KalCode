/**
 * Static guarantees about the shipped Worker source and the operator tooling:
 *   - SQL writes stay inside their canonical account, billing and usage stores;
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
  it("confines account, billing, entitlement and usage writes to their canonical stores", () => {
    expect(workerFiles.length).toBeGreaterThan(5);
    const writes = workerFiles.flatMap((file) =>
      [
        ...read(file).matchAll(
          /\b(?:INSERT\s+INTO|UPDATE\s+[A-Za-z_]|DELETE\s+FROM|REPLACE\s+INTO|DROP\s+(?:TABLE|TRIGGER|INDEX)|ALTER\s+TABLE|CREATE\s+(?:TABLE|TRIGGER|INDEX))\b[^;`"]*/g,
        ),
      ].map((m) => ({
        file: relative(API_DIR, file),
        sql: m[0].replace(/\s+/g, " ").trim(),
      })),
    );
    expect(writes.length).toBeGreaterThan(10);
    for (const write of writes) {
      const file = write.file.replaceAll("\\", "/");
      expect(["worker/lib/account-store.ts", "worker/lib/billing-store.ts", "worker/lib/store.ts"]).toContain(file);
      if (file === "worker/lib/store.ts") expect(write.sql).toMatch(/\bkalvoice_requests\b/);
      if (file === "worker/lib/account-store.ts") {
        expect(write.sql).toMatch(
          /\b(?:oauth_attempts|email_signin_attempts|account_identities|account_sessions|auth_rate_limits|accounts|audit_log)\b/,
        );
      }
      if (file === "worker/lib/billing-store.ts") {
        expect(write.sql).toMatch(
          /\b(?:accounts|billing_customers|billing_subscriptions|billing_webhook_events|billing_sync_leases|billing_action_limits|billing_checkout_intents|entitlement_grants)\b/,
        );
      }
    }
    const billing = read(join(API_DIR, "worker", "lib", "billing-store.ts"));
    expect(billing).toContain("lease_token = ?2 AND l.version = ?3 AND l.expires_at > ?4");
    expect(billing).not.toMatch(/tier\s*=\s*["']owner["']/i);
  });

  it("never imports test support code", () => {
    for (const file of workerFiles) {
      expect(read(file), relative(API_DIR, file)).not.toMatch(/from\s+["'][^"']*tests?\//);
    }
  });

  it("uses hashed sessions only with complete OAuth configuration and otherwise fails closed", () => {
    const env = read(join(API_DIR, "worker", "lib", "env.ts"));
    expect(env).toMatch(
      /auth: accountAuth \|\| openIdAuth \|\| emailAuth \? sessionAuthenticator\(accountStore, now\) : SIGN_IN_UNAVAILABLE,/,
    );
    expect(env).toContain('callbackUrl: "https://api.kalcoded.com/v1/auth/github/callback"');
    expect(env).toContain('callbackUrl: "https://api.kalcoded.com/v1/auth/google/callback"');
    expect(env).toContain('callbackUrl: "https://api.kalcoded.com/v1/auth/microsoft/callback"');
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
      const found = (read(file).match(email) ?? []).filter(
        (m) => !m.endsWith("@example.com") && m !== "hello@kalcoded.com",
      );
      expect(found, relative(REPO_ROOT, file)).toEqual([]);
    }
  });
});

describe("zero company AI cost", () => {
  const AI_HOSTS =
    /api\.anthropic\.com|api\.openai\.com|generativelanguage\.googleapis\.com|aiplatform\.googleapis\.com|bedrock-runtime|openai\.azure\.com|api\.groq\.com|api\.mistral\.ai|api\.together\.xyz|api\.cohere\.|speech\.googleapis\.com|texttospeech\.googleapis\.com|api\.elevenlabs\.io|api\.deepgram\.com|api\.assemblyai\.com|cognitiveservices\.azure\.com|tts\.speech\.microsoft\.com|polly\.[a-z0-9-]+\.amazonaws\.com|gateway\.ai\.cloudflare\.com/i;

  it("allows only the audited identity and Stripe clients and never an AI provider", () => {
    for (const file of workerFiles) {
      const source = read(file);
      expect(source, relative(API_DIR, file)).not.toMatch(AI_HOSTS);
      if (/\bfetcher\s*\(/.test(source)) {
        expect(["worker/lib/github-oauth.ts", "worker/lib/openid-connect.ts", "worker/lib/stripe.ts"]).toContain(
          relative(API_DIR, file).replaceAll("\\", "/"),
        );
      }
      expect(source).not.toMatch(/\bconnect\s*\(|WebSocket|EventSource/);
    }
    const oauth = read(join(API_DIR, "worker", "lib", "github-oauth.ts"));
    expect(oauth).toContain('"https://github.com/login/oauth/authorize"');
    expect(oauth).toContain('"https://github.com/login/oauth/access_token"');
    expect(oauth).toContain('"https://api.github.com/user"');
    expect(oauth.match(/redirect: "manual"/g)).toHaveLength(4);
    const stripe = read(join(API_DIR, "worker", "lib", "stripe.ts"));
    expect(stripe).toContain('"https://api.stripe.com/v1"');
    expect(stripe).toContain('redirect: "manual"');
    expect(oauth).toContain("AbortSignal.timeout");
    const openid = read(join(API_DIR, "worker", "lib", "openid-connect.ts"));
    expect(openid).toContain('"https://accounts.google.com/.well-known/openid-configuration"');
    expect(openid).toContain('"https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration"');
    expect(openid).toContain('redirect: "error"');
    expect(openid).toContain("AbortSignal.timeout");
    expect(stripe).toContain("AbortSignal.timeout");
    const mailer = read(join(API_DIR, "worker", "lib", "account-mailer.ts"));
    expect(mailer).not.toMatch(/https?:|\bfetch\s*\(/);
    expect(mailer).toContain("service.sendAccountEmail");
  });

  it("holds no AI keys and binds no AI services", () => {
    const config = read(join(API_DIR, "wrangler.jsonc"));
    expect(config).not.toMatch(/"ai"\s*:|"browser"\s*:|_API_KEY/i);
    expect(config).toContain('"binding": "ACCOUNT_MAILER"');
    expect(config).toContain('"service": "kalcode-website"');
    expect(config).toContain('"entrypoint": "AccountMailEntrypoint"');
    expect(config.match(/"services"\s*:/g)).toHaveLength(1);
    expect(config.match(/"service"\s*:/g)).toHaveLength(1);
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
